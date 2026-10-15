import { describe, expect, it } from 'vitest';
import { packageName } from './index.js';

describe('@rp/api', () => {
  it('is wired into the workspace', () => {
    expect(packageName).toBe('@rp/api');
  });
});
