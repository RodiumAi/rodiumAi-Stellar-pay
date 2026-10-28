import { describe, expect, it } from 'vitest';
import { loadConfig } from './app-config.js';
import { MAINNET, TESTNET } from './network.js';

const valid = {
  NODE_ENV: 'test',
  RP_STELLAR_NETWORK: 'testnet',
  MERCHANT_ADDRESS: `G${'A'.repeat(55)}`,
  SUBSCRIPTION_CONTRACT_ID: `C${'B'.repeat(55)}`,
  MAX_FEE_STROOPS: '100000',
  MAX_PAYMENT_USDC: '500',
  MAX_SUBSCRIPTION_PRICE_USDC: '50.5',
};

describe('loadConfig', () => {
  it('loads a valid testnet config with defaults', () => {
    const result = loadConfig(valid);
    if (!result.ok) throw new Error(result.error.issues.join('; '));
    expect(result.value).toMatchObject({
      env: 'test',
      logLevel: 'info',
      network: {
        name: 'testnet',
        passphrase: TESTNET.passphrase,
        rpcUrl: 'https://soroban-testnet.stellar.org',
        usdc: TESTNET.usdc,
        maxFeeStroops: 100_000n,
        maxSorobanFeeStroops: 20_000_000n,
      },
      limits: {
        maxPayment: 5_000_000_000n,
        maxSubscriptionPrice: 505_000_000n,
        subscriptionApprovePeriods: 3,
      },
      fx: { supportedFiat: ['USD'], maxRateAgeSeconds: 93_600 },
    });
  });

  it('loads mainnet when an RPC URL is given', () => {
    const result = loadConfig({
      ...valid,
      RP_STELLAR_NETWORK: 'mainnet',
      RP_STELLAR_RPC_URL: 'https://rpc.example.com',
    });
    expect(result.ok && result.value.network.usdc).toEqual(MAINNET.usdc);
    expect(result.ok && result.value.network.horizonUrl).toBe('https://horizon.stellar.org');
  });

  it('allows a deployment without a subscription contract (one-time payments only)', () => {
    const result = loadConfig({ ...valid, SUBSCRIPTION_CONTRACT_ID: undefined });
    expect(result.ok && result.value.network.subscriptionContractId).toBeNull();
    const withContract = loadConfig(valid);
    expect(withContract.ok && withContract.value.network.subscriptionContractId).toBe(
      valid.SUBSCRIPTION_CONTRACT_ID,
    );
  });

  it('treats empty values as unset (defaults apply)', () => {
    const result = loadConfig({
      ...valid,
      RP_STELLAR_RPC_URL: '',
      RP_STELLAR_HORIZON_URL: '  ',
      LOG_LEVEL: '',
    });
    expect(result.ok && result.value.network.rpcUrl).toBe('https://soroban-testnet.stellar.org');
    expect(result.ok && result.value.logLevel).toBe('info');
    expect(loadConfig({ ...valid, RP_STELLAR_NETWORK: '' }).ok).toBe(false);
  });

  it('parses the fiat list', () => {
    const result = loadConfig({ ...valid, FX_SUPPORTED_FIAT: 'USD, GHS' });
    expect(result.ok && result.value.fx.supportedFiat).toEqual(['USD', 'GHS']);
  });

  it.each<[string, Record<string, string | undefined>, string]>([
    ['missing network', { RP_STELLAR_NETWORK: undefined }, 'RP_STELLAR_NETWORK'],
    ['unknown network', { RP_STELLAR_NETWORK: 'futurenet' }, 'RP_STELLAR_NETWORK'],
    ['mainnet without RPC', { RP_STELLAR_NETWORK: 'mainnet' }, 'RP_STELLAR_RPC_URL'],
    ['http RPC', { RP_STELLAR_RPC_URL: 'http://rpc.example.com' }, 'RP_STELLAR_RPC_URL'],
    ['contract as merchant', { MERCHANT_ADDRESS: `C${'A'.repeat(55)}` }, 'MERCHANT_ADDRESS'],
    ['bad contract id', { SUBSCRIPTION_CONTRACT_ID: 'C123' }, 'SUBSCRIPTION_CONTRACT_ID'],
    ['float fee', { MAX_FEE_STROOPS: '1.5' }, 'MAX_FEE_STROOPS'],
    ['zero cap', { MAX_PAYMENT_USDC: '0' }, 'MAX_PAYMENT_USDC'],
    ['8-decimal cap', { MAX_SUBSCRIPTION_PRICE_USDC: '1.00000001' }, 'MAX_SUBSCRIPTION_PRICE_USDC'],
    ['approve periods 0', { SUBSCRIPTION_APPROVE_PERIODS: '0' }, 'SUBSCRIPTION_APPROVE_PERIODS'],
    ['unsupported fiat', { FX_SUPPORTED_FIAT: 'USD,XXX' }, 'FX_SUPPORTED_FIAT'],
    ['bad env', { NODE_ENV: 'prod' }, 'NODE_ENV'],
  ])('rejects %s with a clear message', (_name, override, variable) => {
    const result = loadConfig({ ...valid, ...override });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.issues.some((i) => i.startsWith(variable))).toBe(true);
  });

  it('never echoes values in error messages', () => {
    const secretish = 'http://user:hunter2@rpc.example.com';
    const result = loadConfig({ ...valid, RP_STELLAR_RPC_URL: secretish });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.issues.join(' ')).not.toContain('hunter2');
  });
});
