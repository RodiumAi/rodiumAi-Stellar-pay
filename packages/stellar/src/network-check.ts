import { err, ok, type Result } from '@rp/core/result';

export interface NetworkInfoClient {
  getNetwork(): Promise<{ readonly passphrase: string }>;
}

/**
 * Startup check (context §13.5): refuse to run when the RPC endpoint serves a different
 * network than configured, e.g. a mainnet URL in a testnet deployment.
 */
export async function verifyNetwork(
  client: NetworkInfoClient,
  expectedPassphrase: string,
): Promise<Result<void, { readonly code: 'network_mismatch'; readonly reported: string }>> {
  const { passphrase } = await client.getNetwork();
  return passphrase === expectedPassphrase
    ? ok(undefined)
    : err({ code: 'network_mismatch', reported: passphrase });
}
