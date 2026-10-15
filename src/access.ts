/**
 * Cloudflare Access JWT verification.
 *
 * Cloudflare Access sits in front of this server (via Cloudflare Tunnel) and
 * injects a signed assertion into every authenticated request:
 *
 *     Cf-Access-Jwt-Assertion: <RS256 JWT>
 *
 * Cloudflare's docs recommend validating that header rather than the
 * `CF_Authorization` cookie, because the cookie is not guaranteed to be sent
 * (notably for non-browser clients using Managed OAuth).
 *
 * Why the origin validates at all, when the tunnel is already private:
 * defence in depth. Anything that can reach 127.0.0.1:3000 — another local
 * process, a future misconfigured proxy, a compromised dependency — would
 * otherwise have unauthenticated read/write access to the whole vault. There is
 * deliberately NO localhost bypass.
 *
 * Never logged here: the token, its claims, the user's email, or any cookie.
 */

import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { IncomingMessage } from 'node:http';

/** Header Cloudflare Access populates on authenticated requests. */
const ACCESS_JWT_HEADER = 'cf-access-jwt-assertion';

/** Cloudflare signs Access application tokens with RS256. Pinning the
 *  algorithm prevents algorithm-confusion attacks (e.g. a forged `alg: none`
 *  or an HMAC token signed with the public key as its secret). */
const ALLOWED_ALGORITHMS = ['RS256'];

/** Reject absurd tokens before doing any crypto. A real Access JWT is ~1 KB. */
const MAX_TOKEN_CHARS = 8192;

/** Small tolerance for clock skew between Cloudflare's edge and this VM. */
const CLOCK_TOLERANCE_SECONDS = 5;

/** An AUD tag is a 64-character hex string. */
const AUD_PATTERN = /^[0-9a-f]{64}$/;

export type AuthFailureReason = 'missing token' | 'invalid token';

export type AuthResult = { ok: true } | { ok: false; reason: AuthFailureReason };

/** Thrown at startup when deployment configuration is missing or malformed. */
export class AccessConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccessConfigError';
  }
}

export interface AccessConfigInput {
  /**
   * Cloudflare Zero Trust team domain. Accepts any of:
   *   "myteam"
   *   "myteam.cloudflareaccess.com"
   *   "https://myteam.cloudflareaccess.com"
   */
  teamDomain: string | undefined;
  /** The Access application's Application Audience (AUD) tag. */
  aud: string | undefined;
}

export interface AccessVerifier {
  /** Canonical issuer, e.g. "https://myteam.cloudflareaccess.com". */
  readonly issuer: string;
  /** JWKS endpoint the verifier fetches signing keys from. */
  readonly jwksUrl: string;
  /** Verify one request. Never throws. */
  verify(req: IncomingMessage): Promise<AuthResult>;
}

/**
 * Normalize a team domain into the exact `iss` value Cloudflare puts in the
 * token, which is the bare origin with no trailing slash or path.
 */
function normalizeIssuer(raw: string): string {
  let value = raw.trim();
  if (value.length === 0) throw new AccessConfigError('CF_ACCESS_TEAM_DOMAIN is empty');

  // Tolerate a scheme being supplied, but require it to be https.
  if (/^https?:\/\//i.test(value)) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new AccessConfigError('CF_ACCESS_TEAM_DOMAIN is not a valid URL');
    }
    if (parsed.protocol !== 'https:') {
      throw new AccessConfigError('CF_ACCESS_TEAM_DOMAIN must use https');
    }
    if (parsed.pathname !== '/' && parsed.pathname !== '') {
      throw new AccessConfigError('CF_ACCESS_TEAM_DOMAIN must not include a path');
    }
    value = parsed.host;
  }

  value = value.replace(/\/+$/, '');

  // Bare team name -> full team domain.
  if (!value.includes('.')) value = `${value}.cloudflareaccess.com`;

  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/i.test(value)) {
    throw new AccessConfigError(
      'CF_ACCESS_TEAM_DOMAIN must be a <team>.cloudflareaccess.com domain'
    );
  }

  return `https://${value.toLowerCase()}`;
}

function normalizeAud(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (value.length === 0) throw new AccessConfigError('CF_ACCESS_AUD is empty');
  if (!AUD_PATTERN.test(value)) {
    throw new AccessConfigError('CF_ACCESS_AUD must be a 64-character hex AUD tag');
  }
  return value;
}

/**
 * Build a verifier. Throws AccessConfigError if configuration is absent or
 * malformed, so the process fails to start rather than silently serving the
 * vault without authentication.
 */
export function createAccessVerifier(input: AccessConfigInput): AccessVerifier {
  if (input.teamDomain === undefined) {
    throw new AccessConfigError('CF_ACCESS_TEAM_DOMAIN is not set');
  }
  if (input.aud === undefined) {
    throw new AccessConfigError('CF_ACCESS_AUD is not set');
  }

  const issuer = normalizeIssuer(input.teamDomain);
  const allowedServiceTokenIds = new Set(
    (process.env.CF_ACCESS_SERVICE_TOKEN_IDS ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
  );
  const audience = normalizeAud(input.aud);
  const jwksUrl = `${issuer}/cdn-cgi/access/certs`;

  // Cloudflare rotates signing keys roughly every 6 weeks (old keys stay valid
  // for 7 days). createRemoteJWKSet fetches by `kid`, caches, and re-fetches
  // when it sees an unknown one, so rotation is handled without a restart and
  // without ever hard-coding a key.
  const jwks = createRemoteJWKSet(new URL(jwksUrl), {
    cacheMaxAge: 6 * 60 * 60 * 1000, // 6 hours
    cooldownDuration: 30 * 1000, // don't hammer the endpoint on bad tokens
    timeoutDuration: 5 * 1000,
  });

  async function verify(req: IncomingMessage): Promise<AuthResult> {
    const raw = req.headers[ACCESS_JWT_HEADER];
    const token = Array.isArray(raw) ? raw[0] : raw;

    if (typeof token !== 'string' || token.trim().length === 0) {
      return { ok: false, reason: 'missing token' };
    }
    if (token.length > MAX_TOKEN_CHARS) {
      return { ok: false, reason: 'invalid token' };
    }

    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer,
        audience,
        algorithms: ALLOWED_ALGORITHMS,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
      });

      // jose already enforced signature, `iss`, `aud`, and `exp`/`nbf` when
      // present. It does NOT require `exp` to exist, so demand it explicitly:
      // a token with no expiry must never be accepted.
      if (typeof payload.exp !== 'number') return { ok: false, reason: 'invalid token' };

      // Identity-based requests carry a non-empty `sub`. Service-token requests
      // carry `common_name` (the token's client ID) and an empty `sub`; those are
      // accepted ONLY if that client ID is in CF_ACCESS_SERVICE_TOKEN_IDS
      // (comma-separated). Unset or empty means service tokens stay rejected.
      const hasSub = typeof payload.sub === 'string' && payload.sub.length > 0;
      if (!hasSub) {
        const cn = payload.common_name;
        if (typeof cn !== 'string' || cn.length === 0 || !allowedServiceTokenIds.has(cn)) {
          return { ok: false, reason: 'invalid token' };
        }
      }

      return { ok: true };
    } catch {
      // Deliberately opaque: the reason (bad signature, wrong audience, expired,
      // malformed) is not surfaced to the client and not logged, so the endpoint
      // cannot be used as an oracle.
      return { ok: false, reason: 'invalid token' };
    }
  }

  return { issuer, jwksUrl, verify };
}
