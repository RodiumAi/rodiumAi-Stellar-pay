import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { err, ok, type Result } from '@rp/core/result';

/**
 * Verifies the `x-amzn-oidc-data` token an AWS Application Load Balancer adds after it has
 * signed the user in (its `authenticate-cognito` / `authenticate-oidc` action). The token is
 * ES256-signed by the load balancer; the public key is published per key id at
 * `https://public-keys.auth.elb.<region>.amazonaws.com/<kid>`. We check the signature, that
 * *our* load balancer signed it (`signer`), and expiry. AWS pads the base64url parts with `=`,
 * so generic JWT libraries reject these tokens; this is a small dedicated verifier.
 */
export type AlbAuthError =
  | 'missing'
  | 'malformed'
  | 'bad_algorithm'
  | 'wrong_signer'
  | 'expired'
  | 'key_unavailable'
  | 'bad_signature'
  | 'no_email';

export interface AlbIdentity {
  readonly email: string;
}

export interface AlbVerifier {
  verify(token: string | undefined): Promise<Result<AlbIdentity, AlbAuthError>>;
}

const KID = /^[A-Za-z0-9-]{1,128}$/;
const KEY_CACHE_MAX = 16;

function decodeJson(part: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(
      Buffer.from(part.replace(/=+$/, ''), 'base64url').toString('utf8'),
    );
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function createAlbVerifier(o: {
  readonly albArn: string;
  readonly region: string;
  readonly nowSeconds: () => number;
  /** Returns the PEM public key for `kid`; defaults to the regional ELB key endpoint. */
  readonly fetchKey?: (kid: string) => Promise<string>;
}): AlbVerifier {
  const keys = new Map<string, KeyObject>();
  const fetchKey =
    o.fetchKey ??
    (async (kid: string) => {
      const res = await fetch(`https://public-keys.auth.elb.${o.region}.amazonaws.com/${kid}`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
      return res.text();
    });

  const keyFor = async (kid: string): Promise<KeyObject | null> => {
    const cached = keys.get(kid);
    if (cached !== undefined) return cached;
    try {
      const key = createPublicKey(await fetchKey(kid));
      if (key.asymmetricKeyType !== 'ec') return null;
      if (keys.size >= KEY_CACHE_MAX) keys.clear();
      keys.set(kid, key);
      return key;
    } catch {
      return null;
    }
  };

  return {
    async verify(token) {
      if (token === undefined || token === '') return err('missing');
      const parts = token.split('.');
      if (parts.length !== 3) return err('malformed');
      const [h = '', p = '', s = ''] = parts;
      const header = decodeJson(h);
      const payload = decodeJson(p);
      if (header === null || payload === null) return err('malformed');
      if (header['alg'] !== 'ES256') return err('bad_algorithm');
      if (header['signer'] !== o.albArn) return err('wrong_signer');
      const kid = header['kid'];
      if (typeof kid !== 'string' || !KID.test(kid)) return err('malformed');
      const exp = typeof header['exp'] === 'number' ? header['exp'] : payload['exp'];
      if (typeof exp !== 'number' || exp <= o.nowSeconds()) return err('expired');
      const key = await keyFor(kid);
      if (key === null) return err('key_unavailable');
      const signature = Buffer.from(s.replace(/=+$/, ''), 'base64url');
      const valid = verify(
        'sha256',
        Buffer.from(`${h}.${p}`),
        { key, dsaEncoding: 'ieee-p1363' },
        signature,
      );
      if (!valid) return err('bad_signature');
      const email = payload['email'];
      if (typeof email !== 'string' || email === '') return err('no_email');
      return ok({ email: email.toLowerCase() });
    },
  };
}
