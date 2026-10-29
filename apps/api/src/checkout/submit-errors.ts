/** Shown when the network gives no reason we can explain to the customer. */
export const SUBMIT_FAILED = 'The network rejected the transaction';

// Horizon `extras.result_codes` the customer can act on. Codes outside these lists (or a missing
// body) fall back to SUBMIT_FAILED; the raw codes are logged either way.
const TRANSACTION: ReadonlyMap<string, string> = new Map([
  [
    'tx_insufficient_balance',
    "Your wallet doesn't have enough XLM to pay the network fee. Add a little XLM and try again.",
  ],
  ['tx_too_late', 'This payment took too long to sign. Try again.'],
  ['tx_bad_seq', 'Your wallet sent an out-of-date transaction. Try again.'],
  ['tx_insufficient_fee', 'The network is busy right now. Try again in a moment.'],
]);
const OPERATION: ReadonlyMap<string, string> = new Map([
  [
    'op_underfunded',
    "Your wallet doesn't have enough USDC for this payment. Add USDC and try again.",
  ],
  ['op_src_no_trust', "Your wallet can't hold USDC yet. Add USDC to your wallet, then try again."],
  ['op_src_not_authorized', "Your wallet isn't allowed to send this USDC. Try another wallet."],
]);

/** A customer-facing reason for a rejected payment submission, from Horizon's result codes. */
export function submitFailureMessage(resultCodes: unknown): string {
  if (typeof resultCodes !== 'object' || resultCodes === null) return SUBMIT_FAILED;
  const { transaction, operations } = resultCodes as {
    transaction?: unknown;
    operations?: unknown;
  };
  if (Array.isArray(operations)) {
    for (const op of operations) {
      const message = typeof op === 'string' ? OPERATION.get(op) : undefined;
      if (message !== undefined) return message;
    }
  }
  return (
    (typeof transaction === 'string' ? TRANSACTION.get(transaction) : undefined) ?? SUBMIT_FAILED
  );
}
