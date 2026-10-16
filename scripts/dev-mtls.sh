#!/usr/bin/env bash
# Development mTLS material for worker → signer (context §12.1): a private CA, a signer
# server certificate (localhost) and a worker client certificate (CN=rp-worker).
# Output: .mtls/ (git-ignored). Production certificates come from the platform CA (S10).
set -euo pipefail
OUT="${1:-$(git rev-parse --show-toplevel)/.mtls}"
mkdir -p "$OUT" && cd "$OUT"
DAYS=30

openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days "$DAYS" \
  -subj "/CN=rp-dev-ca" -keyout ca.key -out ca.crt 2>/dev/null

issue() { # name cn ext
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=$2" \
    -keyout "$1.key" -out "$1.csr" 2>/dev/null
  printf '%s\n' "$3" > "$1.ext"
  openssl x509 -req -in "$1.csr" -CA ca.crt -CAkey ca.key -CAcreateserial -days "$DAYS" \
    -extfile "$1.ext" -out "$1.crt" 2>/dev/null
  rm -f "$1.csr" "$1.ext"
}
issue signer localhost "subjectAltName=DNS:localhost,IP:127.0.0.1
extendedKeyUsage=serverAuth"
issue worker rp-worker "extendedKeyUsage=clientAuth"
chmod 600 ./*.key
echo "mTLS material written to $OUT (valid $DAYS days)"
