import { describe, expect, it } from 'vitest';
import { packageName } from './index.js';

describe('@rp/config', () => {
  it('is wired into the workspace', () => {
    expect(packageName).toBe('@rp/config');
  });
});
