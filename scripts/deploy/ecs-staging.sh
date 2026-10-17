#!/usr/bin/env bash
# Deploys a built commit to the StelPay testnet staging service on ECS (docs/deploy/staging.md).
#   scripts/deploy/ecs-staging.sh [commit] [apps]
#     commit  git commit whose signed images the images workflow pushed to ECR (default: origin/main)
#     apps    which containers to update, default "api worker signer"
#   DRY_RUN=1 shows what would change and stops before touching AWS.
# Changes only the image digests of the chosen containers (a new task revision copied from the
# current one), redeploys only rodium-pay-staging, waits for it, and checks the public health
# endpoint. Needs `aws login` with access to account 330990434320.
set -euo pipefail
export AWS_PAGER="" AWS_REGION=eu-west-1
CLUSTER=rodiumai-cluster
SERVICE=rodium-pay-staging
URL=https://stelpay.forge.rodiumai.io
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
git fetch -q origin main
commit=$(git rev-parse --short=12 "${1:-origin/main}")
apps=${2:-api worker signer}
aws sts get-caller-identity --query Account --output text | grep -qx 330990434320 \
  || { echo "not signed in to account 330990434320 (run: aws login --region eu-west-1)"; exit 1; }

args=() # app=digest pairs (plain array: macOS ships bash 3.2, no associative arrays)
for app in $apps; do
  d=$(aws ecr describe-images --repository-name "rodiumai/stellar-pay-$app" \
    --query "sort_by(imageDetails[?imageTags && starts_with(imageTags[0], '$commit-')], &imagePushedAt)[-1].imageDigest" \
    --output text)
  [[ "$d" == sha256:* ]] || { echo "no ECR image for $app at $commit — has the images workflow finished?"; exit 1; }
  args+=("$app=$d")
  echo "$app → $commit (${d:7:12}…)"
done

current=$(aws ecs describe-services --cluster $CLUSTER --services $SERVICE --query 'services[0].taskDefinition' --output text)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
aws ecs describe-task-definition --task-definition "$current" --include TAGS --output json > "$work/current.json"
python3 - "$work" "${args[@]}" <<'PY'
import json, sys
work, pairs = sys.argv[1], dict(a.split('=', 1) for a in sys.argv[2:])
src = json.load(open(f'{work}/current.json')); t = src['taskDefinition']
keep = ['family', 'taskRoleArn', 'executionRoleArn', 'networkMode', 'containerDefinitions',
        'requiresCompatibilities', 'cpu', 'memory', 'runtimePlatform']
td = {k: t[k] for k in keep if k in t}; td['tags'] = src.get('tags', [])
for c in td['containerDefinitions']:
    if c['name'] in pairs:
        c['image'] = c['image'].split('@')[0] + '@' + pairs[c['name']]
json.dump(td, open(f'{work}/next.json', 'w'))
old = {c['name']: c['image'].split('@')[1][:19] for c in t['containerDefinitions']}
for c in td['containerDefinitions']:
    new = c['image'].split('@')[1][:19]
    print(f"  {c['name']:7} {old[c['name']]}… → {new}…" + ('' if new != old[c['name']] else '  (unchanged)'))
PY
if [[ "${DRY_RUN:-0}" == "1" ]]; then echo "dry run: nothing changed in AWS"; exit 0; fi
next=$(aws ecs register-task-definition --cli-input-json "file://$work/next.json" \
  --query 'taskDefinition.taskDefinitionArn' --output text)
echo "registered ${next##*/} (was ${current##*/})"
aws ecs update-service --cluster $CLUSTER --service $SERVICE --task-definition "$next" >/dev/null
echo "deploying… (Spot capacity can take a few minutes)"
for _ in $(seq 1 60); do
  state=$(aws ecs describe-services --cluster $CLUSTER --services $SERVICE \
    --query 'services[0].[length(deployments),deployments[0].rolloutState]' --output text)
  [[ "$state" == $'1\tCOMPLETED' ]] && break
  [[ "$state" == *FAILED* ]] && { echo "deployment FAILED — ECS keeps the previous revision"; exit 1; }
  sleep 15
done
ready=$(curl -s --max-time 15 "$URL/v1/health/ready")
echo "health: $ready"
[[ "$ready" == *'"status":"ready"'* ]] || { echo "service not ready — roll back with: $0 <previous commit>"; exit 1; }
echo "deployed $commit to $URL ✓"
