# obsidian-mcp

An [MCP](https://modelcontextprotocol.io) server that gives an MCP client safe read/write access to an Obsidian vault, reachable from anywhere but only by one authenticated identity.

It runs alongside the official [`obsidian-headless`](https://github.com/obsidianmd/obsidian-headless) client on a small always-on Linux box, so the vault stays continuously synchronized with Obsidian Sync while an AI client reads and writes notes in it.

```
Mac Obsidian  ─┐
                ├─ Obsidian Sync ─→ VPS vault (~/vaults/main)
iPhone Obsidian ┘                    (obsidian-sync.service)
                                            │
                                            ▼
MCP client ─→ OAuth ─→ Cloudflare Access ─→ Cloudflare Tunnel ─→ obsidian-mcp
                       (identity policy)     (outbound only)     (127.0.0.1:3000)
                                                                        │
                                                          validates Cf-Access-Jwt-Assertion
```

The origin has **zero inbound ports open** for this service. `cloudflared` dials out
to Cloudflare; nothing dials in. The only open inbound port on the host is SSH.

## Design constraints

Two decisions shape the whole implementation:

1. **Loopback only.** The server binds explicitly to `127.0.0.1`, never `0.0.0.0`. Public reachability is provided entirely by Cloudflare Tunnel, which makes an *outbound* connection — so the host never opens an inbound port, and the origin is unreachable over its public IP.
2. **The vault is the only reachable filesystem.** Every client-supplied path is untrusted input. There is no shell tool, no delete, no rename, and no general filesystem access — because a note-writing agent does not need them, and their absence removes whole categories of failure.
3. **No unauthenticated request reaches a tool — including from localhost.** The process refuses to start without Cloudflare Access configuration, and validates the Access JWT on every `/mcp` request. There is deliberately no loopback bypass: anything that can reach port 3000 (another local process, a future misconfigured proxy, a compromised dependency) still has to present a valid, Cloudflare-signed assertion.

## Tools

Five tools, no more:

| Tool | Input | Behavior |
|---|---|---|
| `list_notes` | `directory?`, `limit?` | Recursively lists `.md` files, returns vault-relative paths |
| `read_note` | `path` | Reads one `.md` note |
| `search_notes` | `query`, `limit?` | Case-insensitive literal text search, returns paths + snippets |
| `write_note` | `path`, `content` | Creates or overwrites a `.md` note, creating parent dirs |
| `append_note` | `path`, `content`, `create_if_missing?` | Appends UTF-8 text to a `.md` note |

Deliberately **not** exposed: delete, rename, shell/command execution, arbitrary filesystem reads, package installation, network requests, or direct `ob` CLI invocation.

## Authentication

Cloudflare Access sits in front of the tunnel and enforces an identity policy before
traffic is admitted. Only one exact email address is allowed; there is no
"everyone", no domain-wide rule, and no service token.

Because MCP clients are not browsers and cannot follow a login redirect,
[Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
is enabled on the Access application. Cloudflare then acts as a standard OAuth 2.0
authorization server for this hostname: an unauthenticated request gets a `401` with a
`WWW-Authenticate` header pointing at OAuth discovery metadata (RFC 8414 / RFC 9728),
the client opens a browser once for login, and thereafter refreshes silently.

Access token lifetime is short (15 minutes) with a longer grant/refresh session
(2 weeks), which is Cloudflare's recommended shape for CLI and agent clients: the
identity policy is re-evaluated on every token refresh, so access is continuously
verified rather than granted once for a fortnight.

Cloudflare passes the authenticated identity to the origin as a signed JWT in the
`Cf-Access-Jwt-Assertion` header, and [`src/access.ts`](src/access.ts) verifies it with
[`jose`](https://github.com/panva/jose) before any MCP code runs:

- **Signature** against Cloudflare's JWKS at `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, fetched at runtime and cached by `kid`. Keys are never hard-coded — Cloudflare rotates them roughly every 6 weeks, and `createRemoteJWKSet` re-fetches on an unseen `kid`, so rotation needs no restart.
- **Algorithm pinned to RS256**, which rejects `alg: none` and HMAC algorithm-confusion forgeries.
- **Issuer** must equal the configured team domain, so a token from another Cloudflare tenant fails.
- **Audience** must equal this application's AUD tag, so a token minted for a different Access application fails.
- **Expiry** is enforced, and `exp` is *required* to be present — `jose` does not demand it by default, so a no-expiry token would otherwise be accepted forever.
- **Subject** must be present, which also rejects service-token requests.

Failures return `401` with a `WWW-Authenticate: Bearer` challenge and a JSON-RPC error
body. The reason is deliberately not disclosed to the client, so the endpoint cannot be
used as an oracle for probing which part of a forged token was wrong.

Logging is restricted to `Authentication succeeded` / `Authentication rejected: missing token`
/ `Authentication rejected: invalid token`. Tokens, claims, emails, and cookies are never
logged. As defence in depth the server also keeps an explicit `Host`/`Origin` allowlist
(loopback plus the published hostname), so DNS-rebinding protection survives being placed
behind a proxy.

## Security model

All path handling lives in [`src/vault.ts`](src/vault.ts). A client path is rejected unless it survives every one of these:

- **Relative only** — absolute paths, `~`-prefixed paths, drive letters, NUL bytes, and over-long paths are refused outright.
- **Normalized, then contained** — containment is checked with `path.relative()`, not `startsWith()`. A bare prefix check would let `/home/ubuntu/vaults/main-evil` masquerade as `/home/ubuntu/vaults/main`.
- **Re-validated after `realpath()`** — the *resolved* path must still sit inside the vault, so a symlink inside the vault pointing at `/etc/passwd` is rejected rather than followed. For files that don't exist yet, the deepest existing ancestor is resolved and the missing segments re-attached, so a symlinked parent directory can't smuggle a write out either.
- **Excluded directories** — any path segment named `.obsidian` or `.git` is refused, for reads, writes, listing, and search alike.
- **Markdown only** — reads, writes, and appends require a `.md` extension.
- **Symlinks are never followed while walking** — directory traversal skips symlink entries entirely.

Resource limits exist so a malformed or hostile request can't exhaust memory:

| Limit | Value |
|---|---|
| Max note read | 1 MiB |
| Max write/append payload | 512 KiB |
| `list_notes` results | 2000 max (200 default) |
| `search_notes` results | 100 max (20 default) |
| Notes scanned per search | 5000 |
| Directory depth | 24 |
| Process memory (systemd) | 512 MiB |

Logging records tool name, relative path, and byte counts. **Note contents are never logged**, and neither are credentials or tokens. No secrets appear anywhere in this repository; the server reads only environment variables for configuration.

## Configuration

| Variable | Default |
|---|---|
| `VAULT_ROOT` | `/home/ubuntu/vaults/main` |
| `MCP_HOST` | `127.0.0.1` |
| `MCP_PORT` | `3000` |
| `CF_ACCESS_TEAM_DOMAIN` | *required* — e.g. `https://myteam.cloudflareaccess.com` |
| `CF_ACCESS_AUD` | *required* — the Access application's 64-char AUD tag |
| `MCP_PUBLIC_HOSTNAME` | optional — public hostname to add to the Host/Origin allowlist |

`CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` are **not secrets** (the AUD tag is a public
identifier; the trust anchor is Cloudflare's signing key, fetched at runtime). They are
required all the same: if either is missing or malformed the process logs a config error
and exits `78` rather than serving the vault unauthenticated.

Local endpoint: `http://127.0.0.1:3000/mcp` (Streamable HTTP). Any other path returns 404.

## Requirements

- Node.js 22 or newer
- MCP TypeScript SDK **v2** (`@modelcontextprotocol/server`, `/node`, `/client`), implementing the 2026-07-28 spec. This is *not* the deprecated monolithic v1 `@modelcontextprotocol/sdk` package; the serving API differs (`createMcpHandler` + `toNodeHandler` rather than per-request `StreamableHTTPServerTransport` + `connect()`).

## Build and run

```bash
npm install
npm run build      # tsc -> dist/
npm start          # serves http://127.0.0.1:3000/mcp
```

## Verification

`test/mcp-verify.mjs` is a real MCP client — it performs a genuine handshake over Streamable HTTP and exercises every tool, rather than asserting on raw HTTP responses.

```bash
npm run verify
```

It covers the five tools end to end (write a note, read it back, append, read again, confirm it appears in listing and search) and then attacks the sandbox: `../etc/passwd`, `../../etc/passwd`, `/etc/passwd`, `~/secret.md`, `notes/../../etc/passwd`, `.obsidian/app.json`, writes outside the vault, non-markdown writes, and a symlink escape. All must be rejected.

> **Note:** the suite creates a `_mcp_test/` directory inside the vault and removes it afterwards. If the vault is live-synced, those files will briefly replicate to Obsidian Sync and then be deleted. Point `VAULT_ROOT` at a scratch copy if that matters. In particular the symlink-escape case creates a symlink inside the vault; a running sync client may follow and upload it before the test cleans up, so prefer a scratch vault for that test.

## Deployment

[`obsidian-mcp.service`](obsidian-mcp.service) runs the server under systemd as an unprivileged user, restarting on failure and starting at boot. It is hardened with `ProtectSystem=strict` and `ProtectHome=read-only`, with the vault re-opened via `ReadWritePaths`, so the process cannot write anywhere else on the filesystem even if the application logic were bypassed.

```bash
sudo install -m 644 -o root -g root obsidian-mcp.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now obsidian-mcp.service
systemctl status obsidian-mcp.service
```

## Layout

```
src/vault.ts       path sandbox: validation, containment, symlink resolution, markdown walk
src/access.ts      Cloudflare Access JWT verification (JWKS, issuer, audience, expiry)
src/server.ts      MCP server, tool definitions, limits, logging, authenticated HTTP mount
test/mcp-verify.mjs    full MCP client suite (functional + sandbox attacks)
test/access-verify.mjs authentication suite (missing/malformed/forged/expired/wrong-aud)
test/postcheck.mjs     short re-check against a running hardened service
obsidian-mcp.service   systemd unit
```

## License

MIT
