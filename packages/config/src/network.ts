import type { StellarAddress } from '@rp/core/stellar-address';

export type NetworkName = 'testnet' | 'mainnet';

/** Facts fixed per network. Deployment-specific values (merchant, URLs) come from AppConfig. */
export interface NetworkConstants {
  readonly name: NetworkName;
  readonly passphrase: string;
  readonly usdc: {
    readonly code: 'USDC';
    readonly issuer: StellarAddress;
    readonly contractId: string;
  };
  readonly defaultRpcUrl: string | null;
  readonly defaultHorizonUrl: string;
}

export interface NetworkConfig {
  readonly name: NetworkName;
  readonly passphrase: string;
  readonly rpcUrl: string;
  readonly horizonUrl: string;
  readonly usdc: NetworkConstants['usdc'];
  readonly merchant: StellarAddress;
  /** `null` when subscriptions are not deployed (one-time payments only). */
  readonly subscriptionContractId: string | null;
  /** Cap for classic transactions (one-time payments). */
  readonly maxFeeStroops: bigint;
  /** Cap for Soroban transactions: inclusion + resource fee (subscribe, charge, TTL). */
  readonly maxSorobanFeeStroops: bigint;
}

// Issuers: developers.circle.com/stablecoins/usdc-contract-addresses (verified 2026-10-15).
// Contract IDs: `stellar contract id asset --asset USDC:<issuer> --network <name>` (stellar-cli 28.1.0).
export const TESTNET: NetworkConstants = {
  name: 'testnet',
  passphrase: 'Test SDF Network ; September 2015',
  usdc: {
    code: 'USDC',
    issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' as StellarAddress,
    contractId: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
  },
  defaultRpcUrl: 'https://soroban-testnet.stellar.org',
  defaultHorizonUrl: 'https://horizon-testnet.stellar.org',
};

export const MAINNET: NetworkConstants = {
  name: 'mainnet',
  passphrase: 'Public Global Stellar Network ; September 2015',
  usdc: {
    code: 'USDC',
    issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' as StellarAddress,
    contractId: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
  },
  // SDF runs no public mainnet RPC; a provider URL must be configured.
  defaultRpcUrl: null,
  defaultHorizonUrl: 'https://horizon.stellar.org',
};

export function networkConstants(name: NetworkName): NetworkConstants {
  return name === 'testnet' ? TESTNET : MAINNET;
}
