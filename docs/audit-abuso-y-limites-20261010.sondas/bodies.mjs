// Q2/Q3: límites de cuerpo por ruta, chunked, sesiones MCP, batch JSON-RPC y DoS del presupuesto de /authorize.
import { request as httpRequest, Agent } from 'node:http';
import { boot, req, MCP_HEADERS, LIST_TASKS, bearer, mb, sleep } from './lib.mjs';

const out = (o) => console.log(JSON.stringify(o));
const s = await boot();
const noKeep = () => new Agent({ keepAlive: false });

/** Sube `bytes` en trozos de 64 KiB. chunked=true => sin Content-Length. */
function upload(path, { bytes, chunked, headers = {}, method = 'POST', abortAfterMs = 20000 }) {
	return new Promise((resolve) => {
		const t0 = performance.now();
		let sent = 0;
		let status;
		let done = false;
		const finish = (extra) => {
			if (done) return;
			done = true;
			resolve({ status, sentMB: mb(sent / 1048576), ms: Math.round(performance.now() - t0), ...extra });
			r.destroy();
		};
		const h = { ...headers };
		if (!chunked) h['content-length'] = String(bytes);
		const r = httpRequest({ host: '127.0.0.1', port: s.app, path, method, headers: h, agent: noKeep() }, (res) => {
			status = res.statusCode;
			res.resume();
			res.on('end', () => finish({ note: 'respuesta completa' }));
		});
		r.on('error', (e) => finish({ error: e.code }));
		setTimeout(() => finish({ note: 'cortado por la sonda' }), abortAfterMs).unref();
		const chunk = Buffer.alloc(65536, 0x61);
		const pump = () => {
			while (sent < bytes && !done) {
				const n = Math.min(chunk.length, bytes - sent);
				sent += n;
				if (!r.write(n === chunk.length ? chunk : chunk.subarray(0, n))) {
					r.once('drain', pump);
					return;
				}
			}
			if (!done) r.end();
		};
		pump();
	});
}

const MB = 1048576;
const auth = { ...MCP_HEADERS, authorization: bearer(), 'content-type': 'application/json' };
const form = { 'content-type': 'application/x-www-form-urlencoded' };

out({ q: 'Q2', test: 'POST /mcp bearer, 10 MB con Content-Length', ...(await upload('/mcp', { bytes: 10 * MB, headers: auth })) });
out({ q: 'Q2', test: 'POST /mcp bearer, 10 MB chunked sin Content-Length', ...(await upload('/mcp', { bytes: 10 * MB, chunked: true, headers: auth })) });
out({ q: 'Q2', test: 'POST /mcp SIN bearer, 10 MB con Content-Length', ...(await upload('/mcp', { bytes: 10 * MB, headers: MCP_HEADERS })) });
out({ q: 'Q2', test: 'POST /mcp SIN bearer, 10 MB chunked', ...(await upload('/mcp', { bytes: 10 * MB, chunked: true, headers: MCP_HEADERS })) });
out({ q: 'Q2', test: 'POST /token 10 MB con Content-Length', ...(await upload('/token', { bytes: 10 * MB, headers: form })) });
out({ q: 'Q2', test: 'POST /token 10 MB chunked', ...(await upload('/token', { bytes: 10 * MB, chunked: true, headers: form })) });
out({ q: 'Q2', test: 'POST /revoke 10 MB chunked', ...(await upload('/revoke', { bytes: 10 * MB, chunked: true, headers: form })) });
out({ q: 'Q2', test: 'POST /authorize 10 MB chunked', ...(await upload('/authorize', { bytes: 10 * MB, chunked: true, headers: form })) });
out({ q: 'Q2', test: 'POST /register 10 MB', ...(await upload('/register', { bytes: 10 * MB, headers: form })) });
out({ q: 'Q2', test: 'POST /oauth/lumbre/callback 10 MB chunked', ...(await upload('/oauth/lumbre/callback', { bytes: 10 * MB, chunked: true, headers: form })) });
out({ q: 'Q2', test: 'tope exacto /mcp: 2 MiB (2097152) con Content-Length', ...(await upload('/mcp', { bytes: 2 * MB, headers: auth })) });
out({ q: 'Q2', test: 'tope exacto /mcp: 2 MiB + 1', ...(await upload('/mcp', { bytes: 2 * MB + 1, headers: auth })) });
out({ q: 'Q2', test: 'tras las subidas', mem: await s.dbg() });

// ── JSON válido de 2 MiB con anidamiento profundo ──
{
	const deep = '['.repeat(2 * MB - 2) + ']]'.slice(0, 2);
	const r = await req(s.app, { headers: auth, body: deep });
	out({ q: 'Q2', test: 'JSON "[[[[…" de 2 MiB', status: r.status, ms: Math.round(r.ms) });
}

// ── Q3: sesiones ──
{
	const init = JSON.stringify({
		jsonrpc: '2.0', id: 1, method: 'initialize',
		params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '0' } }
	});
	const r = await req(s.app, { headers: auth, body: init });
	out({ q: 'Q3', test: 'initialize: ¿mcp-session-id en la respuesta?', status: r.status, sessionHeader: r.headers['mcp-session-id'] ?? null });
	const r2 = await req(s.app, { headers: { ...auth, 'mcp-session-id': 'inventada' }, body: LIST_TASKS });
	out({ q: 'Q3', test: 'tools/call con mcp-session-id inventado', status: r2.status });
	const g = await req(s.app, { method: 'GET', headers: { ...auth, accept: 'text/event-stream' } });
	out({ q: 'Q3', test: 'GET /mcp (stream SSE)', status: g.status });
	const d = await req(s.app, { method: 'DELETE', headers: auth });
	out({ q: 'Q3', test: 'DELETE /mcp', status: d.status });
}

// ── Batch JSON-RPC: ¿un POST ejecuta N tool calls? ──
{
	const before = (await s.upStats()).counts['/api/tasks'] ?? 0;
	const N = 500;
	const batch = JSON.stringify(Array.from({ length: N }, (_, i) => ({ jsonrpc: '2.0', id: i + 1, method: 'tools/call', params: { name: 'list_tasks', arguments: {} } })));
	const r = await req(s.app, { headers: { ...auth, 'mcp-protocol-version': '2025-06-18' }, body: batch });
	const after = (await s.upStats()).counts['/api/tasks'] ?? 0;
	out({ q: 'batch', test: `1 POST con array de ${N} tools/call`, bodyBytes: batch.length, status: r.status, ms: Math.round(r.ms), respBytes: r.body.length, upstreamCalls: after - before, respHead: r.body.slice(0, 160) });
	const r3 = await req(s.app, { headers: { ...auth, 'mcp-protocol-version': '2025-06-18' }, body: batch.replace(/list_tasks/g, 'list_tasks') });
	out({ q: 'batch', test: 'repetido', status: r3.status, ms: Math.round(r3.ms), upstreamTotal: (await s.upStats()).counts['/api/tasks'] });
}
out({ mem: await s.dbg() });
await s.stop();
process.exit(0);
