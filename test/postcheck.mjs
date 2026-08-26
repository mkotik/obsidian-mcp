import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const client = new Client({ name: 'postcheck', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3000/mcp')));

const p = (r) => { try { return JSON.parse(r.content[0].text); } catch { return { _raw: r.content[0].text }; } };
const call = (name, args) => client.callTool({ name, arguments: args });

const tools = (await client.listTools()).tools.map((t) => t.name).sort();
console.log('tools:', tools.join(','));

const list = p(await call('list_notes', { limit: 5 }));
console.log('list_notes total_found:', list.total_found);

const read = p(await call('read_note', { path: list.notes[0] }));
console.log('read_note ok:', read.bytes, 'bytes from', read.path);

const search = p(await call('search_notes', { query: 'the', limit: 3 }));
console.log('search_notes matched:', search.result_count);

const NOTE = '_mcp_postcheck/hardened.md';
const w = p(await call('write_note', { path: NOTE, content: '# hardened\n\nwrite-ok\n' }));
console.log('write_note under hardening:', w.path, w.bytes_written, 'bytes');
const a = p(await call('append_note', { path: NOTE, content: 'append-ok\n' }));
console.log('append_note under hardening:', a.bytes_appended, 'bytes');
const back = p(await call('read_note', { path: NOTE }));
console.log('content verified:', back.content.includes('write-ok') && back.content.includes('append-ok'));

const bad = await call('read_note', { path: '../../etc/passwd' });
console.log('traversal still rejected:', bad.isError === true);

const outside = await call('write_note', { path: '../outside.md', content: 'x' });
console.log('write outside vault still rejected:', outside.isError === true);

await client.close();
