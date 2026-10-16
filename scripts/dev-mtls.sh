#!/usr/bin/env bash
# Development mTLS material for worker → signer (context §12.1): a private CA, a signer
# server certificate (localhost) and a worker client certificate (CN=rp-worker).
# Output: .mtls/ (git-ignored).
# Deployments: SIGNER_DNS adds the signer's private DNS name (e.g. signer.rodium-pay.local on
# ECS); CA_DAYS keeps the CA longer than the 30-day leaf certificates; REUSE_CA=1 issues new
# leaf certificates from an existing ca.key/ca.crt in the output directory (monthly rotation).
set -euo pipefail
OUT="${1:-$(git rev-parse --show-toplevel)/.mtls}"
mkdir -p "$OUT" && cd "$OUT"
DAYS=30
CA_DAYS="${CA_DAYS:-$DAYS}"
SAN="DNS:localhost,IP:127.0.0.1${SIGNER_DNS:+,DNS:$SIGNER_DNS}"

if [[ "${REUSE_CA:-0}" != "1" ]]; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days "$CA_DAYS" \
    -subj "/CN=rp-${SIGNER_DNS:+prod-}ca" -keyout ca.key -out ca.crt 2>/dev/null
fi

issue() { # name cn ext
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=$2" \
    -keyout "$1.key" -out "$1.csr" 2>/dev/null
  printf '%s\n' "$3" > "$1.ext"
  openssl x509 -req -in "$1.csr" -CA ca.crt -CAkey ca.key -CAcreateserial -days "$DAYS" \
    -extfile "$1.ext" -out "$1.crt" 2>/dev/null
  rm -f "$1.csr" "$1.ext"
}
issue signer "${SIGNER_DNS:-localhost}" "subjectAltName=$SAN
extendedKeyUsage=serverAuth"
issue worker rp-worker "extendedKeyUsage=clientAuth"
chmod 600 ./*.key
echo "mTLS material written to $OUT (valid $DAYS days)"
