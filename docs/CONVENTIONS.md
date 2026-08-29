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

### Port registry

Every service binds to `127.0.0.1` on its own port. Nothing binds `0.0.0.0`.
**Update this table when you claim a port.**

| Port | Service | Status |
|---:|---|---|
| 3000 | obsidian | in use |
| 3001 | imessage | reserved |
| 3002 | *(next)* | free |
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
6. Remove the old hostname from all three places.

Order matters: if you add the host to the allowlist before Access covers it, the
hostname is briefly reachable without Cloudflare authentication in front.

---

## 5. Current state

| | |
|---|---|
| Host | `mcp-host`, Oracle Always Free, ARM64, 1 vCPU, 5.8 GB RAM, 41 GB free |
| Tunnel | `personal-mcp` (`2c2de917-4a72-4cb9-8df8-de4ce9d7f6d4`) |
| Obsidian MCP | `obsidian.deangoldsteen.com` + legacy `mcp.deangoldsteen.com` → `127.0.0.1:3000` |
| Access app | `obsidian-mcp`, policy `owner-only`, two destinations, one AUD |

`mcp.deangoldsteen.com` is retained only so the existing Claude connector keeps
working. Retire it once clients point at `obsidian.` — remove the tunnel route,
the Access destination, and the entry in `MCP_PUBLIC_HOSTNAME`.

### Deployment

There are no git credentials on the host. Deployment is: edit locally → `scp` →
`npm run build` → `systemctl restart`. GitHub is updated separately through the
web UI, and file hashes are compared across local, host, and GitHub to confirm
the three copies match. A deploy key would remove this friction and is the
obvious next improvement.
