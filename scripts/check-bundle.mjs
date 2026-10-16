// Context §11.4: the checkout's initial JS (entry chunk) must stay ≤ 30 KB gzipped.
// Lazy chunks (the wallet) are reported but not budgeted. Run after `pnpm --filter @rp/checkout build`.
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const BUDGET = 30 * 1024;
const dir = new URL('../apps/checkout/dist/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('.vite/manifest.json', dir), 'utf8'));
let failed = false;
for (const chunk of Object.values(manifest)) {
  const size = gzipSync(readFileSync(new URL(chunk.file, dir))).length;
  const initial = chunk.isEntry === true;
  console.log(
    `${initial ? 'initial' : 'lazy   '} ${chunk.file}: ${(size / 1024).toFixed(2)} KB gzipped`,
  );
  if (initial && size > BUDGET) failed = true;
}
if (failed) {
  console.error(`initial JS exceeds ${BUDGET / 1024} KB gzipped`);
  process.exit(1);
}
