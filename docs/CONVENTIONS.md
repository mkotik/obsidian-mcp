# Conventions

How personal MCP servers are named, laid out, and deployed on the shared host.
Read this before adding a new one.

This repo holds **all** of them. The host, the tunnel, and the Cloudflare account
are shared infrastructure; each MCP is a tenant on top of that.

---

## 1. Naming

The rule: **shared things get generic names, tenants get their own name.** The
original mistake was naming the box, the tunnel, and the repo after their first
tenant (Obsidian), which stops making sense the moment there are two.

| Layer | Scope | Convention | Current |
|---|---|---|---|
| OCI instance | shared | `mcp-host` | `mcp-host` |
| OS hostname | shared | `mcp-host` | `mcp-host` |
| Cloudflare tunnel | shared | `personal-mcp` | `personal-mcp` |
| Git repository | shared | `personal-mcp` | `personal-mcp` |
| Public hostname | per service | `<service>.deangoldsteen.com` | `obsidian.` |
| Access application | per service | `<service>-mcp` | `obsidian-mcp` |
| systemd unit | per service | `<service>-mcp.service` | `obsidian-mcp.service` |
| Loopback port | per service | see registry below | 3000 |
| MCP server name | per service | `<service>-<noun>` | `obsidian-vault` |

### Why exactly one subdomain level

Cloudflare Universal SSL (the free certificate) covers the apex and **one** level
of subdomain only. `imessage.deangoldsteen.com` is covered;
`imessage.mcp.deangoldsteen.com` is **not** and would serve an invalid
certificate unless you buy Advanced Certificate Manager.

> Reference: <https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/>

So: always `<service>.deangoldsteen.com`. Never a deeper name.

### When a tenant needs two hostnames

A tenant with two different *callers* gets two hostnames and two Access
applications, because they need different authentication. iMessage is the first
such case: `imessage.deangoldsteen.com` is owner-only Managed OAuth for me,
while `imessage-ingest.deangoldsteen.com` is a machine endpoint gated by an
Access **service token** for the Mac sender.

That produces one deliberate naming exception. The ingestion app is called
`imessage-ingest`, not `imessage-ingest-mcp`, because it is not an MCP server —
it is an ingestion API. The `-mcp` suffix is reserved for things that actually
speak MCP.

Port blocks are allocated per tenant in hundreds (`31xx`, `32xx`) rather than
sequentially, so a tenant's services stay visually grouped.

### Port registry

Every service binds to `127.0.0.1` on its own port. Nothing binds `0.0.0.0`.
**Update this table when you claim a port.**

| Port | Service | Status |
|---:|---|---|
| 3000 | obsidian mcp | in use |
| 3100 | imessage ingest | in use |
| 3200 | imessage mcp | in use |
| 3300 | *(next tenant)* | free |
| 20241 | cloudflared metrics | in use (not ours) |

---

## 2. Repository layout

Today the repo holds a single service at the root. When the **second** service
lands, move to:

```
personal-mcp/
├── packages/core/          shared: Access JWT, bootstrap, logging, limits
├── services/obsidian/      vault tools
├── services/imessage/      message tools
├── deploy/                 unit templates, this registry
└── docs/
```

**The shared core is deliberately not extracted yet.** About 340 of the current
1,470 lines are generic infrastructure (`src/access.ts`, the HTTP bootstrap, host
validation, the `guard`/`log`/limits helpers), but extracting an abstraction with
only one consumer means guessing at the interface. Extract it as step one of
building the second service, where a real second caller validates the shape.

Until then, treat `src/access.ts` as **read-only in spirit**: it is the thing that
will become `packages/core`, so avoid making it Obsidian-specific.

---

## 3. Security invariants

Every MCP on this host must satisfy all of these. They are not negotiable per
service; a single weak tenant compromises the host.

1. **Bind `127.0.0.1` only.** Never `0.0.0.0`, never `[::]`.
2. **Zero new inbound ports.** The OCI security list stays TCP/22 only. Traffic
   arrives through the tunnel's outbound connection or not at all.
3. **Origin re-validates the Access JWT.** Never trust that a request arrived via
   Cloudflare. There is no localhost bypass — an unauthenticated request from the
   box itself must still get 401.
4. **One Access application per hostname, policy `owner-only`.** Never a broad
   rule ("Everyone", "emails ending in…").
5. **Never log** note or message contents, tokens, JWTs, cookies, or the owner's
   email. Permitted vocabulary: `Authentication succeeded`,
   `Authentication rejected: missing token`, `Authentication rejected: invalid token`.
6. **systemd hardening is copied verbatim** from `obsidian-mcp.service`:
   `User=ubuntu`, `NoNewPrivileges`, `ProtectSystem=strict` with a narrow
   `ReadWritePaths`, `ProtectHome=read-only`, `RestrictAddressFamilies`,
   `MemoryMax`. Run as `ubuntu`, never root.
7. **Validate and sandbox every client-supplied path or identifier.** Assume
   hostile input.
8. **No secrets in the repo.** Scan before every commit. The tunnel token, SSH
   keys, and any object-storage credentials live only on the host, mode 0600.
   Service secrets go in `/etc/<service>/` (root, 0600) and reach the process
   through systemd `LoadCredential=`, never `Environment=` (the obsidian
   inbox token is the reference: `/etc/obsidian-mcp/inbox-token`).

Non-secret and safe to commit: the Zero Trust team domain, the Access AUD tag,
hostnames, ports.

---

## 4. Adding a new MCP

Checklist. Steps 1–3 are Cloudflare; 4–7 are the host.

1. **Claim a port** in the registry above.
2. **Publish the hostname.** Zero Trust → Networks → Tunnels & Mesh →
   `personal-mcp` → *Published application routes* → add
   `<service>.deangoldsteen.com`, path empty, service `HTTP://127.0.0.1:<port>`.
   DNS is created automatically.
3. **Protect it before it serves anything.** Zero Trust → Access controls →
   Applications. Either add the hostname as a destination on an existing app, or
   create `<service>-mcp` with policy `owner-only`. A self-hosted app supports up
   to five destinations.
   - Adding to an **existing** app reuses its AUD — no origin config change.
   - A **new** app gets a new AUD, which the new service must be configured with.
   - Enable Managed OAuth and Dynamic Client Registration; add the client's exact
     redirect URI to the allowlist (Claude uses
     `https://claude.ai/api/mcp/auth_callback`).
4. **Write the unit** as `<service>-mcp.service`, copying the hardening block
   verbatim and setting `MCP_PORT`, `MCP_PUBLIC_HOSTNAME`, `CF_ACCESS_AUD`.
5. **Verify exposure** before declaring done:
   ```bash
   ss -ltnp | grep <port>          # must be 127.0.0.1, never 0.0.0.0
   curl -o /dev/null -w '%{http_code}\n' https://<service>.deangoldsteen.com/mcp   # 401
   curl -o /dev/null -w '%{http_code}\n' http://129.213.93.108:<port>/mcp          # 000
   ```
6. **Test against the live authenticated endpoint**, not just local HTTP. A real
   Cloudflare assertion cannot be stubbed — the issuer check rejects a local JWKS.
   Get a bearer token via the OAuth flow and run the suite against the real URL.
7. **Update this file** — port registry, naming table, and the layout tree.

### Renaming a hostname without downtime

`MCP_PUBLIC_HOSTNAME` accepts a comma-separated list, so:

1. Add the new tunnel route pointing at the same port.
2. Add the new hostname as an Access destination **before** it can serve traffic.
3. Add it to `MCP_PUBLIC_HOSTNAME` alongside the old one; restart.
4. Verify both return 401 unauthenticated and both work authenticated.
5. Move clients over.
6. Remove the old hostname from all three places, in **reverse** order: tunnel
   route first, then the Access destination, then `MCP_PUBLIC_HOSTNAME`.
   Deleting the tunnel route also deletes the DNS record.

Order matters in both directions, for the same reason — a hostname must never be
routable while Access is not in front of it:

- **Adding:** route → Access → allowlist leaves a brief window where the
  hostname reaches the origin unauthenticated (the origin's host allowlist still
  rejects it with 403, but that is the last line of defence, not the first).
  Safest is to add the Access destination first.
- **Removing:** delete the route first. That stops traffic before Access
  protection is taken away.

---

## 5. Current state

| | |
|---|---|
| Host | `mcp-host`, Oracle Always Free, ARM64, 1 vCPU, 5.8 GB RAM, 41 GB free |
| Tunnel | `personal-mcp` (`2c2de917-4a72-4cb9-8df8-de4ce9d7f6d4`) |
| Obsidian MCP | `obsidian.deangoldsteen.com` → `127.0.0.1:3000` |
| iMessage ingest | `imessage-ingest.deangoldsteen.com` → `127.0.0.1:3100` |
| iMessage MCP | `imessage.deangoldsteen.com` → `127.0.0.1:3200` |
| Access apps | `obsidian-mcp` and `imessage-mcp` (`owner-only`); `imessage-ingest` (service token) |

### Shared code is still not extracted

`src/shared/access.ts` was **copied**, not shared, into `imessage-server`, and
the two copies have now diverged: the iMessage copy gained a
`principal: 'user' | 'service'` option plus `expectedCommonName` pinning,
because Cloudflare service-token JWTs carry `common_name` instead of `sub` and
the original explicitly rejected them.

Two copies were the right call for two tenants. At the **third**, either
back-port the principal option to Obsidian and extract a genuinely shared
package, or accept the divergence deliberately and write it down. Do not let a
third copy drift silently.

`mcp.deangoldsteen.com` was retired on 2026-08-29. It read like a generic
entry point but resolved to a single service, which would have been actively
misleading once a second MCP existed. Deleting the tunnel route also removed
its DNS record automatically.

The name is now free. If a **gateway** MCP is ever built — one endpoint
aggregating a curated subset of tools from every service, so a single connector
serves all agents — `mcp.deangoldsteen.com` is the right name for it. Note the
tradeoff that argues against building one prematurely: every tool's schema is
injected into the model's context on every request, and selection accuracy falls
as near-duplicate tools accumulate. A gateway that re-exports the union of all
services (16 + 6 + 8 + …) buys one-URL convenience at the cost of a quality tax on
every request. If built, curate rather than concatenate.

### Deployment

**Push to `main` and it deploys.** Each repo on the host has an
`auto-deploy@<name>.timer` that checks GitHub every 3 minutes. Files live in
[`deploy/auto-deploy/`](../deploy/auto-deploy/) and are installed at
`/usr/local/sbin/auto-deploy`, `/etc/auto-deploy/<name>.conf`, and
`/etc/systemd/system/auto-deploy@.{service,timer}`.

When `main` moves, `auto-deploy <name>`:

1. fetches as the unprivileged `deploy` user over a **read-only deploy key**
   (one per repo, `~deploy/.ssh/`, GitHub host key pinned to its published
   fingerprint) — the host never holds credentials that can write to GitHub;
2. exports the commit to a scratch dir and runs `npm ci`, `npm run build`, and
   the repo's tests there, still as `deploy`, so dependency install scripts
   never run as root;
3. snapshots the live directory, rsyncs the build in, restarts the services in
   order, and health-checks them (obsidian: unauthenticated `POST /mcp` → 401;
   imessage: `/health` on 3100 and 3200);
4. on any failure **rolls back** to the snapshot, records the commit as failed so
   it is not retried every 3 minutes, and exits non-zero. A later commit, or
   `sudo FORCE=1 auto-deploy <name>`, tries again.

Unit files are **never** installed automatically — they run as root and carry
the hardening, so a change to one is flagged in the log (`NOTE: … differs from
the installed unit`) and installed by hand. Rollback restores code, not the
database: an imessage commit that adds a migration is applied by
`imessage-ingest` on start and stays applied.

```bash
journalctl -u 'auto-deploy@*' -n 50 --no-pager      # what deployed, what failed
systemctl list-timers 'auto-deploy@*'
sudo cat /var/lib/auto-deploy/<name>.deployed        # live commit
sudo FORCE=1 /usr/local/sbin/auto-deploy <name>      # deploy now / retry a failed commit
```

GitHub is updated through the web UI (no write credentials anywhere on the host).
