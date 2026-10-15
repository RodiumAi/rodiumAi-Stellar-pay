# Secrets inventory

Mirrors context §12.4. Every secret: holder, rotation, where it is defined in code.

| Secret                               | Holder                      | Rotation                          | Code                                         |
| ------------------------------------ | --------------------------- | --------------------------------- | -------------------------------------------- |
| API HMAC keys (32 bytes, two active) | API, main app               | 90 days, overlapping              | `packages/security/src/hmac-auth.ts`         |
| Webhook Ed25519 private key          | worker                      | 90 days, overlapping              | `packages/security/src/webhook-signature.ts` |
| Field-encryption KEK                 | KMS only (AWS KMS from S10) | yearly, automatic                 | `packages/security/src/kms.ts`               |
| Data keys (wrapped by KEK)           | API, worker (in memory)     | with KEK rotation; re-encrypt job | `packages/security/src/envelope.ts`          |
| Blind-index key (≥ 32 bytes)         | API, worker                 | only with full re-index           | `packages/security/src/blind-index.ts`       |
| Local dev KMS master key             | developer machine only      | n/a — never in staging/production | `createLocalDevKms`                          |
| Keeper signing key                   | signer only                 | 180 days or on suspicion          | S9                                           |
| ExchangeRate-API key                 | API                         | yearly or on suspicion            | S6                                           |
