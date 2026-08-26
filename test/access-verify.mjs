/**
 * Cloudflare Access authentication tests for the Obsidian MCP server.
 *
 * These run against the live server on http://127.0.0.1:3000/mcp and prove that
 * the origin rejects unauthenticated and forged assertions — including from
 * localhost, where there is deliberately no bypass.
 *
 * A genuine Cloudflare-signed token cannot be minted locally, so the positive
 * path (a real Access JWT) is verified end-to-end through the tunnel instead.
 * What is proved here is that every *invalid* shape is refused, and that the
 * refusal happens before any MCP or vault code runs.
 *
 * Nothing here prints a token.
 */

import { generateKeyPair, SignJWT, exportJWK } from 'jose';
import { connect } from 'node:net';

const URL_MCP = process.env.MCP_URL ?? 'http://127.0.0.1:3000/mcp';
const AUD = process.env.CF_ACCESS_AUD ?? '';
const TEAM = process.env.CF_ACCESS_TEAM_DOMAIN ?? '';

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Minimal MCP initialize request body. */
const INIT_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2026-07-28',
    capabilities: {},
    clientInfo: { name: 'access-verify', version: '1.0.0' },
  },
});

async function post(headers) {
  const res = await fetch(URL_MCP, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: INIT_BODY,
  });
  const text = await res.text();
  return { status: res.status, wwwAuth: res.headers.get('www-authenticate'), text };
}

/**
 * Send a minimal POST /mcp over a raw TCP socket with an arbitrary Host header,
 * and resolve the HTTP status code. Needed because fetch() will not let us forge
 * Host, which is exactly what a DNS-rebinding attacker would do.
 */
function rawRequestStatus(hostHeader) {
  return new Promise((resolve, reject) => {
    const u = new global.URL(URL_MCP);
    const socket = connect({ host: u.hostname, port: Number(u.port || 80) }, () => {
      const body = INIT_BODY;
      socket.write(
        `POST ${u.pathname} HTTP/1.1\r\n` +
          `Host: ${hostHeader}\r\n` +
          'Content-Type: application/json\r\n' +
          'Accept: application/json, text/event-stream\r\n' +
          `Content-Length: ${Buffer.byteLength(body)}\r\n` +
          'Connection: close\r\n\r\n' +
          body
      );
    });
    let data = '';
    socket.setTimeout(10000, () => { socket.destroy(); reject(new Error('timeout')); });
    socket.on('data', (c) => { data += c.toString('utf8'); });
    socket.on('error', reject);
    socket.on('close', () => {
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(data);
      resolve(m ? Number(m[1]) : 0);
    });
  });
}

async function main() {
  console.log(`\n=== Cloudflare Access origin validation: ${URL_MCP} ===\n`);

  if (!AUD || !TEAM) {
    console.error('FATAL: set CF_ACCESS_AUD and CF_ACCESS_TEAM_DOMAIN to run these tests.');
    process.exitCode = 1;
    return;
  }
  const issuer = TEAM.startsWith('https://') ? TEAM.replace(/\/+$/, '') : `https://${TEAM}`;

  // -- 1. No assertion at all, from localhost. Must still be refused. --------
  {
    const r = await post({});
    check('missing JWT -> 401', r.status === 401, `got ${r.status}`);
    check(
      'missing JWT -> WWW-Authenticate: Bearer',
      (r.wwwAuth ?? '').toLowerCase().startsWith('bearer'),
      `got ${r.wwwAuth}`
    );
    check('missing JWT -> no MCP result leaked', !r.text.includes('serverInfo'), r.text.slice(0, 80));
  }

  // -- 2. Structurally broken tokens. ---------------------------------------
  for (const [label, value] of [
    ['not a JWT', 'this-is-not-a-jwt'],
    ['two segments only', 'aaaa.bbbb'],
    ['empty string', ''],
    ['garbage base64', 'e30.e30.!!!!'],
  ]) {
    const r = await post({ 'cf-access-jwt-assertion': value });
    check(`malformed JWT (${label}) -> 401`, r.status === 401, `got ${r.status}`);
  }

  // -- 3. Well-formed, correctly signed... by the wrong key. ----------------
  // This is the important forgery case: an attacker who can reach the origin
  // and mint their own RS256 token must not be trusted.
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'attacker-key';
  jwk.alg = 'RS256';
  jwk.use = 'sig';

  const mint = (claims, kid = 'attacker-key') =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' })
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);

  {
    const token = await mint({ aud: AUD, iss: issuer, sub: 'attacker', email: 'x@example.com' });
    const r = await post({ 'cf-access-jwt-assertion': token });
    check('valid-looking JWT signed by foreign key -> 401', r.status === 401, `got ${r.status}`);
  }

  // -- 4. Wrong audience (a token for a different Access app). ---------------
  {
    const token = await mint({ aud: 'f'.repeat(64), iss: issuer, sub: 'someone' });
    const r = await post({ 'cf-access-jwt-assertion': token });
    check('wrong audience -> 401', r.status === 401, `got ${r.status}`);
  }

  // -- 5. Wrong issuer (another Cloudflare tenant). --------------------------
  {
    const token = await mint({ aud: AUD, iss: 'https://someone-else.cloudflareaccess.com', sub: 's' });
    const r = await post({ 'cf-access-jwt-assertion': token });
    check('wrong issuer -> 401', r.status === 401, `got ${r.status}`);
  }

  // -- 6. Expired token. ----------------------------------------------------
  {
    const token = await new SignJWT({ aud: AUD, iss: issuer, sub: 's' })
      .setProtectedHeader({ alg: 'RS256', kid: 'attacker-key', typ: 'JWT' })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(privateKey);
    const r = await post({ 'cf-access-jwt-assertion': token });
    check('expired token -> 401', r.status === 401, `got ${r.status}`);
  }

  // -- 7. alg=none / unsigned token. ----------------------------------------
  {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const token = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ aud: AUD, iss: issuer, sub: 's', exp: Math.floor(Date.now() / 1000) + 600 })}.`;
    const r = await post({ 'cf-access-jwt-assertion': token });
    check('alg=none unsigned token -> 401', r.status === 401, `got ${r.status}`);
  }

  // -- 8. No-expiry token (jose does not require exp; we do). ---------------
  {
    const token = await new SignJWT({ aud: AUD, iss: issuer, sub: 's' })
      .setProtectedHeader({ alg: 'RS256', kid: 'attacker-key', typ: 'JWT' })
      .setIssuedAt()
      .sign(privateKey);
    const r = await post({ 'cf-access-jwt-assertion': token });
    check('token with no exp -> 401', r.status === 401, `got ${r.status}`);
  }

  // -- 9. Host header still guarded (DNS rebinding). ------------------------
  // fetch() refuses to set Host (it is a forbidden header name), so this one
  // has to go out over a raw socket to actually exercise the guard.
  {
    const status = await rawRequestStatus('evil.example.com');
    check('foreign Host header -> 403', status === 403, `got ${status}`);
  }

  // -- 10. Non-/mcp paths are not served. -----------------------------------
  {
    const base = URL_MCP.replace(/\/mcp$/, '');
    const res = await fetch(`${base}/`, { method: 'GET' });
    check('GET / -> 404', res.status === 404, `got ${res.status}`);
  }

  console.log(`\n===== RESULT: ${passed} passed, ${failed} failed =====\n`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('FATAL', err?.stack ?? err);
  process.exitCode = 1;
});
