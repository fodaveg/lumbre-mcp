// Amplificación hacia el upstream sin credencial válida + DoS del presupuesto de /authorize.
//  e1: 3000 POST /mcp con bearer basura (upstream devuelve 401): ¿429 propio? ¿fichero de huella? ¿heap?
//  e2: UN POST con un array JSON-RPC de ~20 000 tools/call (≈2 MiB) con bearer basura
//  e3: DoS de /authorize: IP A gasta el cupo del client_id; IP B legítima recibe 429 (límites por defecto)
import { boot, req, MCP_HEADERS, LIST_TASKS, bearer, pool, tally, dirStats, mb } from './lib.mjs';

const out = (o) => console.log(JSON.stringify(o));
const MB = 1048576;

{
	const s = await boot({ upStatus: 401 });
	const base = await s.dbg();
	const t0 = performance.now();
	const rs = await pool(3000, 30, () => req(s.app, { headers: { ...MCP_HEADERS, authorization: bearer(), 'x-forwarded-for': '198.51.100.7' }, body: LIST_TASKS }));
	const dt = performance.now() - t0;
	out({
		q: 'e1', test: '3000 POST /mcp con bearer basura, 1 sola IP, upstream 401',
		status: tally(rs), secs: mb(dt / 1000), reqPerSec: mb(3000 / (dt / 1000)),
		upstream: await s.upStats(), notesSeenFiles: dirStats(s.stateLumbre, /^notes-seen-/),
		heapBeforeMB: mb(base.heapUsedMB), after: await s.dbg()
	});
	// y sin bearer: SÍ hay limitador (30 fallos/min/IP)
	const r401 = await pool(60, 1, () => req(s.app, { headers: { ...MCP_HEADERS, 'x-forwarded-for': '198.51.100.8' }, body: LIST_TASKS }));
	out({ q: 'e1', test: '60 POST /mcp SIN bearer, 1 IP', status: tally(r401) });
	await s.stop();
}

{
	const s = await boot({ upStatus: 401 });
	const one = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_tasks","arguments":{}}}';
	const n = Math.floor((2 * MB - 2) / (one.length + 1 + 4));
	const body = '[' + Array.from({ length: n }, (_, i) => one.replace('"id":1', `"id":${i}`)).join(',') + ']';
	const base = await s.dbg();
	let peak = 0;
	const smp = setInterval(async () => { try { peak = Math.max(peak, (await s.dbg()).rssMB); } catch {} }, 200);
	const r = await req(s.app, { headers: { ...MCP_HEADERS, authorization: bearer() }, body });
	clearInterval(smp);
	out({
		q: 'e2', test: 'UN POST /mcp con array de tools/call, bearer basura', bodyBytes: body.length, calls: n,
		status: r.status, secs: mb(r.ms / 1000), respMB: mb(r.body.length / MB),
		upstream: await s.upStats(), rssBeforeMB: mb(base.rssMB), rssPeakSampledMB: mb(peak), after: await s.dbg()
	});
	await s.stop();
}

{
	const s = await boot();
	const cid = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
	const authz = (ip) =>
		req(s.app, {
			method: 'GET',
			headers: { 'x-forwarded-for': ip },
			path: '/authorize?' + new URLSearchParams({
				response_type: 'code', client_id: cid, redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
				scope: 'lumbre:mcp', resource: 'https://mcp.lumbre.pro/mcp', code_challenge: 'A'.repeat(43),
				code_challenge_method: 'S256'
			})
		});
	const atk = [];
	for (let i = 0; i < 12; i++) atk.push(await authz(`203.0.113.${i + 1}`)); // 12 IPs distintas, 1 petición cada una
	const legit = await authz('192.0.2.50');
	out({ q: 'e3', test: 'atacante: 12 /authorize con el client_id público de claude.ai desde 12 IPs; luego usuario legítimo', attacker: tally(atk), legitStatus: legit.status, legitBody: legit.body.slice(0, 160), backchannel: await s.dbg('/bc') });
	await s.stop();
}
process.exit(0);
