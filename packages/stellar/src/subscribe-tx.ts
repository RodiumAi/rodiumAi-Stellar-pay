import {
  Address,
  Contract,
  nativeToScVal,
  TransactionBuilder,
  xdr,
  type Account,
  type rpc,
  type Transaction,
} from '@stellar/stellar-sdk';

/** Average ledger close time; used only to size the allowance, never for charging. */
const LEDGER_SECONDS = 5;
/** Safety margin so the allowance outlives the last charge by about a day. */
const BUFFER_LEDGERS = 17_280;

export interface SubscribeClient {
  getLatestLedger(): Promise<{ readonly sequence: number }>;
  getLedgerEntries(...keys: xdr.LedgerKey[]): Promise<rpc.Api.GetLedgerEntriesResponse>;
  getAccount(address: string): Promise<Account>;
  prepareTransaction(tx: Transaction): Promise<Transaction>;
}

/** The network's current maximum entry TTL, read live (context §14.4: never hardcoded). */
export async function maxEntryTtl(client: SubscribeClient): Promise<number> {
  const key = xdr.LedgerKey.configSetting(
    new xdr.LedgerKeyConfigSetting({
      configSettingId: xdr.ConfigSettingId.configSettingStateArchival,
    }),
  );
  const { entries } = await client.getLedgerEntries(key);
  const data = entries[0]?.val;
  if (data?.type !== 'configSetting' || data.configSetting.type !== 'configSettingStateArchival') {
    throw new Error('State archival config setting not found');
  }
  return data.configSetting.stateArchivalSettings.maxEntryTtl;
}

/**
 * `live_until_ledger` for the SAC allowance: long enough for `periods` charges plus a
 * buffer, capped by what the network allows. Returns the cap reason for logging.
 */
export function computeLiveUntilLedger(params: {
  readonly latestLedger: number;
  readonly maxEntryTtl: number;
  readonly periods: number;
  readonly intervalSeconds: number;
}): { readonly liveUntilLedger: number; readonly cappedByNetwork: boolean } {
  const wanted =
    Math.ceil((params.periods * params.intervalSeconds) / LEDGER_SECONDS) + BUFFER_LEDGERS;
  const cap = params.maxEntryTtl - 1;
  return {
    liveUntilLedger: params.latestLedger + Math.min(wanted, cap),
    cappedByNetwork: wanted > cap,
  };
}

export interface SubscribeTxParams {
  readonly contractId: string;
  readonly subscriber: string;
  readonly planId: number;
  readonly periods: number;
  readonly intervalSeconds: number;
  readonly networkPassphrase: string;
  readonly baseFee: string;
  readonly timeoutSeconds: number;
}

/**
 * Builds and simulates `subscribe` (context §11, §14.2) so the user signs one
 * transaction whose auth tree covers the first transfer and the `approve`.
 */
export async function buildSubscribeTransaction(
  client: SubscribeClient,
  p: SubscribeTxParams,
): Promise<{
  readonly xdr: string;
  readonly liveUntilLedger: number;
  readonly cappedByNetwork: boolean;
}> {
  const [latest, ttl, account] = await Promise.all([
    client.getLatestLedger(),
    maxEntryTtl(client),
    client.getAccount(p.subscriber),
  ]);
  const { liveUntilLedger, cappedByNetwork } = computeLiveUntilLedger({
    latestLedger: latest.sequence,
    maxEntryTtl: ttl,
    periods: p.periods,
    intervalSeconds: p.intervalSeconds,
  });
  const op = new Contract(p.contractId).call(
    'subscribe',
    new Address(p.subscriber).toScVal(),
    nativeToScVal(p.planId, { type: 'u32' }),
    nativeToScVal(p.periods, { type: 'u32' }),
    nativeToScVal(liveUntilLedger, { type: 'u32' }),
  );
  const tx = new TransactionBuilder(account, {
    fee: p.baseFee,
    networkPassphrase: p.networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(p.timeoutSeconds)
    .build();
  const prepared = await client.prepareTransaction(tx);
  return { xdr: prepared.toXdr(), liveUntilLedger, cappedByNetwork };
}
