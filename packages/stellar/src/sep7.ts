import { formatAmount, type Stroops } from '@rp/core/money/stroops';

export interface PayUriParams {
  readonly destination: string;
  readonly amount: Stroops;
  readonly assetCode: string;
  readonly assetIssuer: string;
  readonly memo: string;
  readonly networkPassphrase: string;
  /** Shown by the wallet; keep it short and free of personal data. */
  readonly message?: string;
}

const PUBLIC_PASSPHRASE = 'Public Global Stellar Network ; September 2015';

/**
 * SEP-7 `web+stellar:pay` URI for the checkout QR code. `network_passphrase` is
 * omitted on mainnet (the SEP-7 default) and always set elsewhere, so a testnet QR
 * can never be paid on mainnet by mistake.
 */
export function buildPayUri(p: PayUriParams): string {
  const params = new URLSearchParams({
    destination: p.destination,
    amount: formatAmount(p.amount),
    asset_code: p.assetCode,
    asset_issuer: p.assetIssuer,
    memo: p.memo,
    memo_type: 'MEMO_TEXT',
  });
  if (p.networkPassphrase !== PUBLIC_PASSPHRASE) {
    params.set('network_passphrase', p.networkPassphrase);
  }
  if (p.message !== undefined) {
    params.set('msg', p.message.slice(0, 300));
  }
  // SEP-7 wants %20 rather than "+" for spaces.
  return `web+stellar:pay?${params.toString().replaceAll('+', '%20')}`;
}
