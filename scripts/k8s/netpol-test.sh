#!/usr/bin/env bash
# Network-policy test (plan S10): applies infra/k8s/base namespace + network policies to the
# current cluster (CI: kind, whose kindnet CNI enforces NetworkPolicy) and checks reachability
# with stand-in pods carrying the real app labels:
#   worker → signer allowed; api → signer, api → worker, monitoring → signer:9443 denied;
#   signer → internet and DNS denied; api → internet allowed (proves the test is not vacuous).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
AGNHOST=registry.k8s.io/e2e-test-images/agnhost:2.53@sha256:99c6b4bb4a1e1df3f0b3752168c89358794d02258ebebc26bf21c29399011a85
NS=rodium-pay

kubectl apply -f infra/k8s/base/namespace.yaml
kubectl -n "$NS" apply -f infra/k8s/base/network-policies.yaml
kubectl create namespace monitoring --dry-run=client -o yaml | kubectl apply -f -
kubectl label namespace monitoring rodium.ai/role=monitoring --overwrite

pod() { # name namespace label port
  kubectl apply -f - <<YAML
apiVersion: v1
kind: Pod
metadata:
  name: $1
  namespace: $2
  labels: { app.kubernetes.io/name: $3 }
spec:
  automountServiceAccountToken: false
  securityContext:
    runAsNonRoot: true
    runAsUser: 65532
    seccompProfile: { type: RuntimeDefault }
  containers:
    - name: c
      image: $AGNHOST
      args: [netexec, --http-port=$4, --udp-port=-1]
      securityContext:
        allowPrivilegeEscalation: false
        capabilities: { drop: [ALL] }
YAML
}
pod api "$NS" rp-api 8080
pod worker "$NS" rp-worker 9090
pod signer "$NS" rp-signer 9443
pod scraper monitoring prometheus 8080
kubectl -n "$NS" wait --for=condition=Ready pod/api pod/worker pod/signer --timeout=180s
kubectl -n monitoring wait --for=condition=Ready pod/scraper --timeout=180s
ip() { kubectl -n "$1" get pod "$2" -o jsonpath='{.status.podIP}'; }
SIGNER=$(ip "$NS" signer); WORKER=$(ip "$NS" worker)

fail=0
check() { # expect(allow|deny) namespace pod target description
  if kubectl -n "$2" exec "$3" -- /agnhost connect --timeout=4s "$4" >/dev/null 2>&1; then got=allow; else got=deny; fi
  if [[ "$got" == "$1" ]]; then echo "ok:   $5 ($got)"; else echo "FAIL: $5 (expected $1, got $got)"; fail=1; fi
}
check allow "$NS" worker "$SIGNER:9443" "worker → signer:9443"
check deny "$NS" api "$SIGNER:9443" "api → signer:9443"
check deny "$NS" api "$WORKER:9090" "api → worker:9090"
check deny monitoring scraper "$SIGNER:9443" "monitoring → signer:9443 (signing port)"
check allow monitoring scraper "$WORKER:9090" "monitoring → worker:9090 (metrics)"
check deny "$NS" signer "1.1.1.1:443" "signer → internet:443"
check deny "$NS" signer "$(kubectl -n kube-system get svc kube-dns -o jsonpath='{.spec.clusterIP}'):53" "signer → DNS"
check deny "$NS" signer "$WORKER:9090" "signer → worker"
check allow "$NS" api "1.1.1.1:443" "api → internet:443"
check deny "$NS" api "169.254.169.254:80" "api → cloud metadata endpoint"
exit "$fail"
