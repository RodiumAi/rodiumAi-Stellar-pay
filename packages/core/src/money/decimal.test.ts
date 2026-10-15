import { describe, expect, it } from 'vitest';
import { splitDecimal } from './decimal.js';

describe('splitDecimal', () => {
  it('pads the fraction', () => {
    expect(splitDecimal('1.5', 3)).toEqual({ whole: '1', fraction: '500' });
    expect(splitDecimal('7', 2)).toEqual({ whole: '7', fraction: '00' });
  });

  it.each(['', '.', '1.', '.1', '00', '1.2345', '1..2', 'a', '-1'])('rejects %j', (input) => {
    expect(splitDecimal(input, 3)).toBeNull();
  });
});
