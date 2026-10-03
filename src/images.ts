/**
 * Image handling: format detection, safe filenames, a guarded URL fetcher, and
 * the small HTML page used for browser uploads.
 *
 * Why three ways in
 * -----------------
 * An MCP client can only pass a tool *text* arguments, which leaves three
 * realistic routes for getting an image into the vault:
 *
 *  1. `data_base64` — fine for small images the model genuinely has bytes for
 *     (a generated chart, a tiny icon). Impractical for photos: the model would
 *     have to emit megabytes of base64 as tokens.
 *  2. `url` — the server downloads a public https image. Covers "add that image
 *     from the web to my note".
 *  3. An upload link — the server mints a single-use URL, the user opens it and
 *     picks files (works from a phone camera roll). This is the route for an
 *     image attached in a chat, because the model sees that image but cannot
 *     hand its bytes to a tool.
 */
import { request as httpsRequest } from 'node:https';
import { lookup as dnsLookup } from 'node:dns';
import { isIP } from 'node:net';
import type { LookupFunction } from 'node:net';

export interface ImageType {
  mime: string;
  ext: string;
}

/** Image formats Obsidian renders on every platform. HEIC is deliberately absent. */
export const IMAGE_EXTENSIONS: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** Identify an image by its magic bytes. The file name and declared type are never trusted. */
export function detectImage(buf: Uint8Array): ImageType | null {
  const b = buf;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    return { mime: 'image/png', ext: 'png' };
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) {
    return { mime: 'image/gif', ext: 'gif' };
  }
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    return { mime: 'image/webp', ext: 'webp' };
  }
  return null;
}

/** True for HEIC/HEIF, so the caller can give a specific error instead of "unknown format". */
export function looksLikeHeic(buf: Uint8Array): boolean {
  if (buf.length < 12) return false;
  const box = String.fromCharCode(...buf.slice(4, 12));
  return /^ftyp(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(box);
}

export function mimeForPath(p: string): string | null {
  const ext = p.toLowerCase().split('.').pop() ?? '';
  return IMAGE_EXTENSIONS[ext] ?? null;
}

/**
 * Turn an arbitrary name into a safe file stem: no path separators, no control
 * characters, no leading dots, bounded length. Falls back to `image`.
 */
export function safeStem(name: string | undefined): string {
  let s = (name ?? '').normalize('NFKC');
  s = s.replace(/\.[A-Za-z0-9]{1,5}$/, ''); // drop any extension; the real one comes from the bytes
  s = s.replace(/[\u0000-\u001f\u007f/\\:*?"<>|#^[\]]+/g, ' ');
  s = s.replace(/\.{2,}/g, ' '); // no `..` runs, even though the name can never leave its folder
  s = s.replace(/\s+/g, ' ').trim().replace(/^[.\s]+/, '');
  if (s.length > 80) s = s.slice(0, 80).trim();
  return s.length > 0 ? s : 'image';
}

/** `YYYYMMDD-HHmmss` in the vault timezone, for collision-resistant default names. */
export function stampForName(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${g('year')}${g('month')}${g('day')}-${g('hour')}${g('minute')}${g('second')}`;
}

/** Decode base64 or a `data:image/...;base64,` URL. Returns null on malformed input. */
export function decodeBase64Image(input: string): Buffer | null {
  let s = input.trim();
  const dataUrl = /^data:[^;,]*;base64,/i.exec(s);
  if (dataUrl) s = s.slice(dataUrl[0].length);
  s = s.replace(/\s+/g, '');
  if (s.length === 0 || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(s)) return null;
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// ---------------------------------------------------------------------------
// Guarded download
// ---------------------------------------------------------------------------

/** Addresses the server must never fetch: loopback, private, link-local, CGNAT, metadata, multicast. */
export function isForbiddenAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6 === '::' || v6 === '::1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return isForbiddenAddress(mapped[1]);
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v6) || v6.startsWith('64:ff9b:') || v6.startsWith('2001:db8');
}

/**
 * DNS lookup that refuses forbidden addresses. Because the check runs inside
 * the socket's own lookup, the address that is validated is the address that
 * is connected to — a DNS-rebinding answer cannot slip in between.
 */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  const forbidden = () => Object.assign(new Error('forbidden address'), { code: 'EFORBIDDEN' });
  // Node's happy-eyeballs path asks for every address (`all: true`) and expects
  // an array back, so honour whichever shape the socket requested. Any
  // forbidden answer rejects the whole lookup rather than being filtered out.
  if (options.all) {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return (callback as (e: Error | null, a: unknown) => void)(err, []);
      const list = addresses as unknown as Array<{ address: string; family: number }>;
      if (list.length === 0 || list.some((a) => isForbiddenAddress(a.address))) {
        return (callback as (e: Error | null, a: unknown) => void)(forbidden(), []);
      }
      (callback as (e: Error | null, a: unknown) => void)(null, list);
    });
    return;
  }
  dnsLookup(hostname, { ...options, all: false }, (err, address, family) => {
    if (err) return callback(err, '', 0);
    if (typeof address !== 'string' || isForbiddenAddress(address)) return callback(forbidden(), '', 0);
    callback(null, address, family as number);
  });
};

export class FetchImageError extends Error {}

/**
 * Download an image over https from a public host. Refuses plain http, IP
 * literals in private ranges, redirects to anything not equally safe, bodies
 * over `maxBytes`, and anything whose bytes are not a supported image.
 */
export async function fetchImage(rawUrl: string, maxBytes: number, timeoutMs = 15_000, redirects = 3): Promise<{ data: Buffer; type: ImageType; finalUrl: string }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new FetchImageError('url is not valid');
  }
  if (url.protocol !== 'https:') throw new FetchImageError('only https:// image URLs are accepted');
  if (url.username || url.password) throw new FetchImageError('URLs with credentials are not accepted');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && isForbiddenAddress(host)) throw new FetchImageError('that address is not reachable from this server');

  const res = await new Promise<{ status: number; location?: string; data?: Buffer }>((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method: 'GET',
        lookup: guardedLookup,
        timeout: timeoutMs,
        headers: { 'user-agent': 'obsidian-mcp/1.1 (+image fetch)', accept: 'image/*' },
      },
      (r) => {
        const status = r.statusCode ?? 0;
        if (status >= 300 && status < 400 && r.headers.location) {
          r.resume();
          resolve({ status, location: r.headers.location });
          return;
        }
        if (status !== 200) {
          r.resume();
          reject(new FetchImageError(`image URL returned HTTP ${status}`));
          return;
        }
        const declared = Number(r.headers['content-length'] ?? 0);
        if (declared > maxBytes) {
          r.destroy();
          reject(new FetchImageError(`image is larger than the ${Math.round(maxBytes / 1048576)} MB limit`));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        r.on('data', (c: Buffer) => {
          total += c.length;
          if (total > maxBytes) {
            r.destroy();
            reject(new FetchImageError(`image is larger than the ${Math.round(maxBytes / 1048576)} MB limit`));
            return;
          }
          chunks.push(c);
        });
        r.on('end', () => resolve({ status, data: Buffer.concat(chunks) }));
        r.on('error', () => reject(new FetchImageError('download failed')));
      }
    );
    req.on('timeout', () => req.destroy(new FetchImageError('download timed out')));
    req.on('error', (e) => reject(e instanceof FetchImageError ? e : new FetchImageError((e as NodeJS.ErrnoException).code === 'EFORBIDDEN' ? 'that address is not reachable from this server' : 'download failed')));
    req.end();
  });

  if (res.location !== undefined) {
    if (redirects <= 0) throw new FetchImageError('too many redirects');
    return fetchImage(new URL(res.location, url).toString(), maxBytes, timeoutMs, redirects - 1);
  }
  const data = res.data ?? Buffer.alloc(0);
  const type = detectImage(data);
  if (!type) {
    throw new FetchImageError(looksLikeHeic(data) ? 'HEIC images are not supported; use JPEG or PNG' : 'the URL did not return a PNG, JPEG, GIF, or WebP image');
  }
  return { data, type, finalUrl: url.toString() };
}

// ---------------------------------------------------------------------------
// Upload page
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const PAGE_STYLE = `
  :root { color-scheme: light; }
  body { font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #f6f5f2; color: #1f1f1f; }
  main { max-width: 34rem; margin: 0 auto; padding: 2.5rem 1.25rem; }
  h1 { font: 600 1.6rem/1.2 Georgia, serif; margin: 0 0 .5rem; }
  p { color: #444; margin: .25rem 0 1rem; }
  code { background: #ebe9e4; padding: .1rem .35rem; border-radius: 4px; font-size: .9em; word-break: break-all; }
  form { background: #fff; border-radius: 12px; padding: 1.25rem; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  input[type=file] { display: block; width: 100%; margin: .5rem 0 1rem; font-size: 1rem; }
  button { font: 600 1rem sans-serif; background: #6c4ed9; color: #fff; border: 0; border-radius: 8px; padding: .75rem 1.25rem; width: 100%; }
  button:disabled { opacity: .6; }
  ul { padding-left: 1.2rem; } .muted { color: #666; font-size: .9rem; }
`;

export function uploadFormPage(opts: { action: string; notePath: string | null; folder: string; expiresAt: number; maxMb: number }): string {
  const target = opts.notePath
    ? `Images will be saved to <code>${esc(opts.folder)}/</code> and embedded at the end of <code>${esc(opts.notePath)}</code>.`
    : `Images will be saved to <code>${esc(opts.folder)}/</code>.`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Add images to vault</title><style>${PAGE_STYLE}</style></head><body><main>
<h1>Add images to your vault</h1>
<p>${target}</p>
<form method="post" action="${esc(opts.action)}" enctype="multipart/form-data" onsubmit="this.querySelector('button').disabled=true;this.querySelector('button').textContent='Uploading…'">
  <label for="f">Choose images (PNG, JPEG, GIF, WebP, up to ${opts.maxMb} MB each)</label>
  <input id="f" type="file" name="images" accept="image/png,image/jpeg,image/gif,image/webp" multiple required>
  <button type="submit">Upload</button>
</form>
<p class="muted">This link works once and expires at ${esc(new Date(opts.expiresAt).toUTCString())}.</p>
</main></body></html>`;
}

export function uploadResultPage(opts: { saved: Array<{ path: string; bytes: number }>; errors: string[]; notePath: string | null }): string {
  const ok = opts.saved.map((s) => `<li><code>${esc(s.path)}</code> (${Math.max(1, Math.round(s.bytes / 1024))} KB)</li>`).join('');
  const bad = opts.errors.map((e) => `<li>${esc(e)}</li>`).join('');
  const title = opts.saved.length > 0 ? 'Uploaded' : 'Nothing was saved';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>${PAGE_STYLE}</style></head><body><main>
<h1>${title}</h1>
${ok ? `<p>Saved ${opts.saved.length} image${opts.saved.length === 1 ? '' : 's'}${opts.notePath ? ` and embedded ${opts.saved.length === 1 ? 'it' : 'them'} in <code>${esc(opts.notePath)}</code>` : ''}:</p><ul>${ok}</ul>` : ''}
${bad ? `<p>Problems:</p><ul>${bad}</ul>` : ''}
<p class="muted">You can close this tab and go back to your chat.</p>
</main></body></html>`;
}

export function messagePage(title: string, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${PAGE_STYLE}</style></head><body><main><h1>${esc(title)}</h1><p>${esc(message)}</p></main></body></html>`;
}
