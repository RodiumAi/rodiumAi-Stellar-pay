import { describe, expect, it, vi } from 'vitest';
import { createSanctionsScreen, parseOfacStellarAddresses } from './sanctions.js';

const LISTED = `G${'A'.repeat(55)}`;
const OTHER = `G${'B'.repeat(55)}`;
const CSV = [
  '36,"SOME COMPANY",-0- ,"CUBA",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ',
  `9001,"SOMEONE",-0- ,"CYBER2",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,"Digital Currency Address - XBT 1BoatSLRHtKNngkdXEeobR76b53LETtpyT; Digital Currency Address - XLM ${LISTED}; Digital Currency Address - USDC 0xb6f5ec1a0a9cd1526536d3f0426c429529471f40."`,
].join('\n');

const silent = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const response = (body: string, status = 200): typeof fetch =>
  vi.fn(() => Promise.resolve(new Response(body, { status })));

describe('parseOfacStellarAddresses', () => {
  it('keeps only Stellar-format addresses, whatever type OFAC files them under', () => {
    expect([...parseOfacStellarAddresses(CSV)]).toEqual([LISTED]);
  });

  it('finds nothing in a list without Stellar addresses', () => {
    expect(parseOfacStellarAddresses('1,"X","Digital Currency Address - ETH 0xabc"').size).toBe(0);
  });
});

describe('createSanctionsScreen', () => {
  it('blocks listed and configured addresses after a refresh', async () => {
    const screen = createSanctionsScreen({
      source: 'ofac',
      blocked: [OTHER],
      logger: silent,
      fetch: response(CSV),
    });
    expect(screen.isBlocked(LISTED)).toBe(false);
    expect(screen.isBlocked(OTHER)).toBe(true);
    await screen.refresh();
    expect(screen.isBlocked(LISTED)).toBe(true);
    expect(screen.isBlocked(`G${'C'.repeat(55)}`)).toBe(false);
  });

  it('fails open when the list never loads and logs one error', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const screen = createSanctionsScreen({
      source: 'ofac',
      blocked: [],
      logger,
      fetch: response('Service Unavailable', 503),
    });
    await screen.refresh();
    await screen.refresh();
    expect(screen.isBlocked(LISTED)).toBe(false);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0]?.[0]).toMatchObject({ alert: 'sanctions_list_unavailable' });
  });

  it('keeps the last good list when a refresh fails, and warns', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    let calls = 0;
    const flaky: typeof fetch = () =>
      Promise.resolve(calls++ === 0 ? new Response(CSV) : new Response('<html>oops</html>'));
    const screen = createSanctionsScreen({ source: 'ofac', blocked: [], logger, fetch: flaky });
    await screen.refresh();
    await screen.refresh();
    expect(screen.isBlocked(LISTED)).toBe(true);
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({ alert: 'sanctions_list_stale' });
  });

  it('never downloads when off, but still applies the block list', async () => {
    const f = response(CSV);
    const screen = createSanctionsScreen({
      source: 'off',
      blocked: [OTHER],
      logger: silent,
      fetch: f,
    });
    const stop = screen.start();
    await screen.refresh();
    stop();
    expect(f).not.toHaveBeenCalled();
    expect(screen.isBlocked(OTHER)).toBe(true);
    expect(screen.isBlocked(LISTED)).toBe(false);
  });

  it('start loads immediately and the stop function cancels the timer', async () => {
    const f = vi.fn(() => Promise.resolve(new Response(CSV)));
    const screen = createSanctionsScreen({
      source: 'ofac',
      blocked: [],
      logger: silent,
      fetch: f,
      refreshMs: 60_000,
    });
    const stop = screen.start();
    await vi.waitFor(() => {
      expect(screen.isBlocked(LISTED)).toBe(true);
    });
    stop();
    expect(f).toHaveBeenCalledTimes(1);
  });
});
