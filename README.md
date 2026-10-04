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
2. **The vault is the only reachable filesystem.** Every client-supplied path is untrusted input. There is no shell tool and no general filesystem access — because a note-editing agent does not need them, and their absence removes whole categories of failure. The tools that *do* mutate the vault (write, append, patch, tag, image, delete, move) are each confined to the same path sandbox, and deletes are recoverable by default.
3. **No unauthenticated request reaches a tool — including from localhost.** The process refuses to start without Cloudflare Access configuration, and validates the Access JWT on every `/mcp` request. There is deliberately no loopback bypass: anything that can reach port 3000 (another local process, a future misconfigured proxy, a compromised dependency) still has to present a valid, Cloudflare-signed assertion.

## Tools

Fourteen tools:

| Tool | Input | Behavior |
|---|---|---|
| `list_notes` | `directory?`, `tags?`, `modified_after?`/`_before?`, `created_after?`/`_before?`, `sort?`, `limit?` | Lists `.md` notes with created/modified dates and tags, **most recently changed first** |
| `read_note` | `path`, `include_images?` | Reads one `.md` note plus its dates and tags; optionally returns the images it embeds |
| `search_notes` | `query`, same filters as `list_notes`, `sort?`, `limit?` | Literal text search over body, file name, and tags; **ranked by relevance weighted toward recent edits** |
| `write_note` | `path`, `content`, `stamp_dates?` | Creates or overwrites a `.md` note, creating parent dirs; keeps `created:`/`updated:` current |
| `append_note` | `path`, `content`, `create_if_missing?`, `stamp_dates?` | Appends UTF-8 text to a `.md` note |
| `patch_note` | `path`, `old_text`, `new_text`, `expected_matches?`, `stamp_dates?` | Replaces an exact snippet in place; refuses to write if the anchor is missing or ambiguous |
| `delete_note` | `path`, `permanent?` | Moves a `.md` note to `.trash/` (recoverable); `permanent: true` erases it |
| `move_note` | `from`, `to`, `overwrite?`, `update_links?` | Renames or moves a note **or a whole folder**, rewriting `[[wikilinks]]` that pointed at it |
| `get_backlinks` | `path`, `limit?` | Lists notes linking to a note, with line numbers and link text |
| `list_tags` | `prefix?`, `directory?`, `limit?` | Every tag in use, with note counts and last use — the vocabulary to tag against |
| `update_tags` | `path`, `add?`, `remove?`, `preserve_modified?` | Adds/removes frontmatter tags without touching anything else in the note |
| `add_image` | `url` or `data_base64`, `filename?`, `folder?`, `note_path?`, `after_text?`, `width?`, `create_note?` | Saves an image into the vault and optionally embeds it as `![[...]]` |
| `read_image` | `path` | Returns a vault image as image content so the model can see it |
| `create_upload_link` | `note_path?`, `folder?`, `create_note?`, `expires_minutes?` | Mints a single-use upload page for images from a phone or computer (fallback) |
| `start_image_upload` | `note_path?`, `after_text?`, `width?`, `filename?`, `folder?`, `create_note?` | For a chat-attached image: mints a single-use 15-minute drop URL; the model's code sandbox `curl`s the file there and the server saves + embeds it |

Deliberately **not** exposed: shell/command execution, arbitrary filesystem reads, package installation, general network requests, or direct `ob` CLI invocation. The only outbound request the server makes is `add_image`'s https image download, which is fenced (see **Images**).

`move_note` is what makes the vault reorganisable: it accepts a directory on both
sides, so `move_note from="raw/journal" to="active/journal"` relocates the folder and
everything inside it — including non-markdown attachments, which are moved with the
folder even though they can never be addressed individually. It also repairs the
`[[wikilinks]]` that pointed at whatever moved (see **Link handling**).

`patch_note` is the tool to reach for when editing an existing note. `write_note`
replaces the entire file, which means a model that re-emits a long note can silently
drop a paragraph — and in a synced vault that loss propagates to every device before
anyone notices. `patch_note` cannot do that: it only ever substitutes text it has
already matched, and it refuses to write at all when the anchor is missing or appears a
different number of times than expected.

## Dates and recency

Every note result carries `created` and `modified`, as ISO timestamps in the vault's
timezone (`NOTE_TIMEZONE`, default `America/New_York`):

- **`modified`** is the filesystem mtime. It is authoritative: it moves on every edit
  from any device, because Obsidian Sync preserves the source mtime when it downloads.
- **`created`** is the frontmatter `created:` when present and parseable, otherwise the
  earliest of birthtime, mtime, and a remembered "first seen" time. Birthtime alone is
  not trustworthy on this host: every note's birthtime is the moment Obsidian Sync
  first downloaded it, and a sync that replaces a file resets it. The first-seen index
  (`/var/lib/obsidian-mcp/first-seen.json`, via systemd `StateDirectory=`) stops the
  date from drifting forward across restarts, and `move_note` carries it to the new path.
  `created_source` says which one was used.
- A frontmatter `updated:` is reported as `updated_frontmatter`, never preferred over
  mtime; if the two differ by more than a day and a half the note is flagged
  `dates_mismatch: true`.

`list_notes` and `search_notes` filter on either date with `modified_after`,
`modified_before`, `created_after`, `created_before`. Each accepts `YYYY-MM-DD`, an ISO
timestamp, `today`, `yesterday`, or a relative age (`7d`, `2w`, `3m`, `1y`). A bare date
used as an upper bound includes that whole day. Responses include `now` so "this week"
is unambiguous to the model.

**Ranking.** `list_notes` defaults to most-recently-modified first. `search_notes`
scores each hit as *relevance × recency*: relevance is `3` for a file-name hit, `2` for a
tag hit, plus `log2(1 + body matches)`; recency is `0.4 + 0.6 × 0.5^(age / half-life)`
with a 30-day half-life (`RECENCY_HALF_LIFE_DAYS`). A note edited today gets the full
weight, a note untouched for months keeps 40%, so recent work rises to the top but a
much stronger match on an old note still wins. `sort: "modified" | "created"` overrides it.

**Stamping.** The write tools keep frontmatter dates current: a note gets `created:`
if it has none (the existing creation time, never "now" for an old note) and `updated:`
refreshed to today. Values follow the vault's convention, `YYYY-MM-DD`. An existing
`created:` is never changed, a placeholder such as `YYYY-MM-DD` in a template is left
alone, a note whose frontmatter is not valid YAML is not touched, and `write_note`
carries the original `created:` forward even when the new content omits it. Pass
`stamp_dates: false` per call, or set `STAMP_DATES=false`, to write verbatim. Links that
`move_note` rewrites in other notes are mechanical and are not stamped.

Frontmatter edits are line-based rather than parse-and-reserialize: only the lines of
the key being changed are replaced, so other keys, comments, quoting, and plugin keys
(Excalidraw, Dataview) stay byte-identical — which matters in a synced vault, where
reformatting churn would land on every device.

## Tags

Tags are read the way Obsidian reads them: frontmatter `tags:` (or legacy `tag:`) as a
list or a comma/space-separated string, plus inline `#tags` in the body, ignoring code
blocks, inline code, and `%%comments%%`. Matching is case-insensitive, and a parent tag
matches its nested children (`project` matches `project/alpha`).

- `list_notes` / `search_notes` take `tags: [...]` (all must match). `search_notes` also
  matches the query against tags.
- `list_tags` returns the vault's tag vocabulary with counts and last use. Its tool
  description tells the model to consult it before tagging, so tags are reused rather
  than duplicated (`ml` vs `machine-learning`).
- `update_tags` adds and removes tags in the frontmatter `tags:` list only. Input is
  normalised (`#Reading List` → `Reading-List`), deduplicated case-insensitively, and
  validated (letters, digits, `-`, `_`, `/`; not purely numeric). It writes the note's
  existing style — a block list stays a block list, otherwise the vault's flow style
  `tags: [a, b]`. Inline tags are prose and are never rewritten; if a removal leaves one
  behind, the response says so (`still_inline`).
- By default `update_tags` **preserves the note's modified time** (nudged forward 1 s so
  sync still sees a newer version). Otherwise bulk re-tagging would make hundreds of
  old notes look freshly edited and wreck recency ranking. `preserve_modified: false`
  treats the edit as a real update.

## Images

An MCP client can only pass a tool text arguments, so there are four ways in:

| Route | Use it for |
|---|---|
| `add_image` with `url` | An image on the web. The server downloads it. |
| `add_image` with `data_base64` | Small images the model genuinely has bytes for (a generated chart). Impractical for photos — the model would have to emit megabytes of base64. |
| `start_image_upload` | **An image attached in chat (the default).** Claude.ai never hands attachment bytes to a tool, but its code sandbox has the file and can make HTTPS requests to allowed domains. The tool mints a presigned URL, `https://<host>/drop/<token>`; the sandbox runs the returned `curl -F images=@<file> <url>`, and the server validates, saves, and embeds the images on arrival and answers with JSON. One tool call, one curl. |
| `create_upload_link` | **Fallback** (no code execution, or the drop fails): a single-use page where you pick images yourself, behind the normal Access login. |

### Drop URLs (`/drop/<token>`)

`/drop/` is the **one path served without a Cloudflare Access JWT**, because Claude's sandbox has no Access session. It is a presigned URL, so the token is the credential:

- 192-bit random token, minted only through the authenticated `/mcp` endpoint, held in memory (a restart revokes all).
- **Single use:** consumed by the first POST, before the body is read, whether or not the upload succeeds. 15-minute lifetime. At most 20 outstanding.
- POST `multipart/form-data` only; GET and unknown tokens get a bare 404 without the body being read. Images only (PNG, JPEG, GIF, WebP by magic bytes), same size caps as `/upload/`.
- Bound at mint time to its destination note, folder, placement, and width; the uploader cannot choose a path.
- Separate grant table from `/upload/`: a browser upload-link token never works on `/drop/`, and `/upload/` still requires Access.
- Tokens are never logged.

Setup:

- **Cloudflare:** a separate Access application `obsidian-drop` with destination `obsidian.deangoldsteen.com/drop` and a single **Bypass / Everyone** policy. Path-specific apps take precedence over the hostname app, so everything else on the hostname (including `/dropx`) stays behind `owner-only`.
- **Claude** (Settings → Capabilities): *Code execution and file creation* on, *Allow network egress* on, and the vault hostname (`obsidian.deangoldsteen.com`) in *Additional allowed domains*.

Why not a GitHub relay: Claude's sandbox proxies github.com and api.github.com and refuses writes to any repo not attached to the chat, so a push-then-import design cannot work from there.

Images are saved under the attachments folder (`ATTACHMENTS_DIR`, else Obsidian's
`attachmentFolderPath` setting, else `attachments/`) and embedded with an unambiguous
path-form link, `![[attachments/name.png]]` or `![[attachments/name.png|300]]`.
`read_image` and `read_note include_images: true` return images as MCP image content so
the model can actually see them.

Safety properties:

- **Format comes from the bytes.** PNG, JPEG, GIF, and WebP are identified by magic
  number; the caller's file name and declared type are ignored, and the extension is
  always the detected one. HEIC is refused with a specific message (Obsidian cannot
  render it everywhere); the upload page asks iOS for JPEG, which it converts to.
- **Never overwrites.** Files are created with `O_EXCL`; a name collision gets a ` 1`,
  ` 2` suffix. File names are sanitised (no separators, control characters, `..` runs,
  or leading dots) and every folder goes through the same path sandbox as notes.
- **The download is fenced.** https only, no credentials in the URL, at most 3 redirects
  (each re-checked), 15 s timeout, 20 MB cap enforced while streaming, and the response
  must actually be an image. The DNS lookup used *by the socket itself* refuses
  loopback, RFC 1918, link-local (including the `169.254.169.254` metadata service),
  CGNAT, multicast, and IPv6 equivalents, so a DNS-rebinding answer cannot slip in
  between check and connect.
- **Upload links are capabilities on top of auth, not instead of it.** `/upload/<token>`
  sits behind the same Cloudflare Access application and the same JWT verification as
  `/mcp`. The token is 192 random bits, single-use (consumed once anything is stored),
  expires (30 minutes by default, 24 hours max), is held only in memory (a restart
  revokes all of them), and at most 20 can be outstanding. The page sends a strict CSP,
  `no-store`, and `no-referrer` so the token does not leak.

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
- **Markdown only** — note reads, writes, and appends require a `.md` extension. The image tools are the one exception: they read and create only files whose bytes are PNG/JPEG/GIF/WebP, and never overwrite.
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
| Image saved (any route) | 20 MiB |
| `data_base64` argument | 12 MiB of text (~9 MiB image) |
| Image returned to the client | 5 MiB (model input limit) |
| Images per `read_note include_images` | 4, 10 MiB total |
| One browser upload | 100 MiB, 20 files |
| Outstanding upload links | 20 |
| Process memory (systemd) | 512 MiB |

### Destructive tools

`delete_note` and `move_note` mutate the vault, and the vault is live-synced, so a
change propagates to every device within seconds. Three properties keep that safe:

- **Deletes are recoverable by default.** `delete_note` moves the note to
  `.trash/<timestamp>/<original path>/` rather than unlinking it. The timestamped
  subdirectory preserves the original path, so same-named notes can't collide and a
  restore is a plain `move_note` back out. `permanent: true` opts into a real unlink,
  and deleting something already inside `.trash/` always erases it.
- **`.trash/` is hidden, not excluded.** It is skipped when walking, so trashed notes
  never appear in `list_notes` or `search_notes` results, but it remains addressable by
  explicit path so a note can be inspected and restored. `.obsidian` and `.git`, by
  contrast, stay hard-excluded everywhere.
- **Moves refuse to clobber or corrupt.** An existing destination is rejected unless
  `overwrite: true` (files only — directories never overwrite), and moving a folder into
  itself or into one of its own descendants is rejected up front rather than failing
  halfway and orphaning files.

All mutating tools resolve **every** path they touch — source *and* destination — through
the same sandbox as the read tools, so traversal, absolute paths, `~`, symlink escapes,
`.obsidian`/`.git`, and non-markdown targets are refused identically.

Logging records tool name, relative path, and byte counts. **Note contents are never logged**, and neither are credentials or tokens. No secrets appear anywhere in this repository; the server reads only environment variables for configuration.

## Link handling

Obsidian resolves `[[Note]]` by basename, so moving a note between folders usually
does *not* break a bare link — but a **rename** breaks every bare link to it, and a
**folder move** breaks any path-form `[[folder/Note]]` link. `move_note` fixes both:

- It snapshots the vault before the move, resolves every wikilink against that
  snapshot, and rewrites only the links that actually pointed at something that moved.
- Link *style* is preserved: a bare link stays bare when that remains unambiguous, and
  a path-form link stays path-form. Embed prefixes (`![[...]]`), `#headings`, and
  `|aliases` are carried through untouched.
- An **ambiguous** bare target — two notes sharing a basename — is deliberately left
  alone rather than guessed at, so a rewrite can never silently repoint a link at the
  wrong note.
- The response lists every note edited and every link changed, so a reorganisation is
  auditable rather than a black box. Pass `update_links: false` to skip rewriting.

Only wikilinks are rewritten. Markdown-style `[text](note.md)` links are left alone:
their encoding rules vary, and rewriting them incorrectly is worse than not rewriting
them. Because `move_note` reports what it changed, an unhandled link style stays
visible instead of being quietly mangled.

`get_backlinks` uses the same resolver, which is why it finds references that a plain
text search would miss — a bare `[[Note]]`, a path-form link, and an aliased
`[[Note|something else]]` all resolve to the same note.

## Configuration

| Variable | Default |
|---|---|
| `VAULT_ROOT` | `/home/ubuntu/vaults/main` |
| `MCP_HOST` | `127.0.0.1` |
| `MCP_PORT` | `3000` |
| `CF_ACCESS_TEAM_DOMAIN` | *required* — e.g. `https://myteam.cloudflareaccess.com` |
| `CF_ACCESS_AUD` | *required* — the Access application's 64-char AUD tag |
| `MCP_PUBLIC_HOSTNAME` | optional — public hostname(s) for the Host/Origin allowlist; the first is also the base URL of upload links |
| `NOTE_TIMEZONE` | `America/New_York` — how dates are read from and written to frontmatter |
| `STATE_DIR` | `$STATE_DIRECTORY` (systemd) — where the created-date index is kept; unset means memory only |
| `RECENCY_HALF_LIFE_DAYS` | `30` — how fast search's recency boost decays |
| `STAMP_DATES` | `true` — set `false` to stop write tools maintaining `created:`/`updated:` |
| `ATTACHMENTS_DIR` | Obsidian's `attachmentFolderPath`, else `attachments` |

`CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` are **not secrets** (the AUD tag is a public
identifier; the trust anchor is Cloudflare's signing key, fetched at runtime). They are
required all the same: if either is missing or malformed the process logs a config error
and exits `78` rather than serving the vault unauthenticated.

Local endpoint: `http://127.0.0.1:3000/mcp` (Streamable HTTP), plus `/upload/<token>` for upload links. Any other path returns 404.

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

It covers the read/write tools end to end (write a note, read it back, append, read again, confirm it appears in listing and search) and then attacks the sandbox: `../etc/passwd`, `../../etc/passwd`, `/etc/passwd`, `~/secret.md`, `notes/../../etc/passwd`, `.obsidian/app.json`, writes outside the vault, non-markdown writes, and a symlink escape. All must be rejected.

> **Note:** the suite creates a `_mcp_test/` directory inside the vault and removes it afterwards. If the vault is live-synced, those files will briefly replicate to Obsidian Sync and then be deleted. Point `VAULT_ROOT` at a scratch copy if that matters. In particular the symlink-escape case creates a symlink inside the vault; a running sync client may follow and upload it before the test cleans up, so prefer a scratch vault for that test.

`test/tools-verify.mjs` covers the two destructive tools against a live authenticated
endpoint, since they cannot be exercised without a valid Cloudflare Access assertion:

```bash
MCP_URL=https://mcp.example.com/mcp MCP_BEARER=<access-token> npm run tools-verify
```

It creates its own uniquely-named throwaway subtree, then checks: rename in place, move
into a not-yet-existing folder, whole-folder relocation, overwrite refusal and explicit
overwrite, soft delete to `.trash/`, that the trashed note is absent from both listing
and search, restore back out of `.trash/`, and permanent delete. It then runs 18 sandbox
attacks against both tools (traversal, absolute, `~`, `.obsidian`, `.git`, non-markdown,
directory delete, move in/out of the vault, folder-into-itself, clobbering an existing
folder) and requires every one to be rejected. It removes its subtree on the way out.

`test/edit-verify.mjs` covers `patch_note`, `get_backlinks`, and link-aware moves
against a live authenticated endpoint:

```bash
MCP_URL=https://mcp.example.com/mcp MCP_BEARER=<access-token> npm run edit-verify
```

It asserts the patch refusals leave the note **byte-identical**, that backlinks are
found through bare, path-form, aliased, and embed links, and that a rename rewrites
bare links while a folder move leaves them alone (because they still resolve) and fixes
path-form links instead. Like the other suites it works in its own throwaway subtree
and cleans up after itself.

`test/features-verify.mjs` covers dates, ranking, stamping, tags, and images — 84
checks including SSRF refusals, filename traversal, upload-link single use, and
created-date survival across renames:

```bash
MCP_URL=https://obsidian.example.com/mcp MCP_BEARER=<access-token> npm run features-verify
```

Run locally with `VAULT_ROOT` set as well, and it also backdates file times to assert
ranking and date-window filters deterministically. All suites accept `MCP_ACCESS_JWT`
(the raw `Cf-Access-Jwt-Assertion`) in place of `MCP_BEARER` for local runs.

The pure link logic — parsing, resolution, ambiguity refusal, style preservation — is
also covered by unit assertions that need no server or vault; see `src/links.ts` for
the contract each case pins down.

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
src/links.ts       wikilink parsing, resolution, and style-preserving rewriting
src/notes.ts       per-note dates and tags, metadata cache, created-date index, recency weight
src/frontmatter.ts YAML frontmatter parsing and line-preserving key edits
src/edit.ts        date stamping and tag edits built on frontmatter.ts
src/tags.ts        Obsidian tag extraction, normalisation, nested matching
src/images.ts      image detection, safe names, fenced https download, upload pages
src/access.ts      Cloudflare Access JWT verification (JWKS, issuer, audience, expiry)
src/server.ts      MCP server, tool definitions, limits, logging, authenticated HTTP mount
test/mcp-verify.mjs    full MCP client suite (functional + sandbox attacks)
test/access-verify.mjs authentication suite (missing/malformed/forged/expired/wrong-aud)
test/tools-verify.mjs  delete/move suite (trash, restore, folder moves, 18 sandbox cases)
test/edit-verify.mjs   patch/backlinks/link-rewrite suite
test/features-verify.mjs dates/ranking/stamping/tags/images suite
test/drop-verify.mjs   presigned /drop/ upload suite (curl, no JWT, single use, isolation from /upload/)
test/postcheck.mjs     short re-check against a running hardened service
obsidian-mcp.service   systemd unit
```

## License

MIT
