import { describe, expect, it } from 'vitest';
import { assertNever, err, ok } from './result.js';
import { addDuration, DAY, duration, instant } from './time.js';

describe('time', () => {
  it('builds and adds instants', () => {
    expect(addDuration(instant(1000), duration(500))).toBe(1500);
    expect(DAY).toBe(86_400_000);
  });

  it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])('rejects %d', (value) => {
    expect(() => instant(value)).toThrow(RangeError);
    expect(() => duration(value)).toThrow(RangeError);
  });
});

describe('result', () => {
  it('wraps values and errors', () => {
    expect(ok(1)).toEqual({ ok: true, value: 1 });
    expect(err('x')).toEqual({ ok: false, error: 'x' });
  });

  it('assertNever throws on unhandled variants', () => {
    expect(() => assertNever('surprise' as never)).toThrow('Unhandled variant');
  });
});
