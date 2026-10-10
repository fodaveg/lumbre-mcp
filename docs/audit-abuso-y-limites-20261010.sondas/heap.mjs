// Uso: node heap.mjs <a|b|c|d>
//  a: 300 bearers distintos x 1 list_tasks (y otra oleada de 300 para ver si se estabiliza el registro LRU)
//  b: 2000 peticiones list_tasks del MISMO bearer
//  c: 500 /authorize sin completar (c1 límites por defecto, c2 límites relajados, hasta 1200)
//  d: 500 tools/call CONCURRENTES con upstream lento (3 s): ¿hay tope de concurrencia?
import { join } from 'node:path';
import { boot, req, MCP_HEADERS, LIST_TASKS, bearer, pool, tally, dirStats, mb, sleep } from './lib.mjs';

const scenario = process.argv[2];
const out = (o) => console.log(JSON.stringify(o));

import { Agent } from "node:http";
const bigAgent = new Agent({ keepAlive: true, maxSockets: 1000 });
async function mcp(app, auth) {
	return req(app, { headers: { ...MCP_HEADERS, authorization: auth }, body: LIST_TASKS, agent: bigAgent });
}

if (scenario === 'a') {
	const s = await boot();
	out({ cfg: await s.dbg('/cfg') });
	const base = await s.dbg();
	out({ step: 'baseline', ...base });
	for (const wave of [1, 2, 3]) {
		const t0 = performance.now();
		const rs = await pool(300, 20, () => mcp(s.app, bearer()));
		const dt = performance.now() - t0;
		const m = await s.dbg();
		out({
			step: `oleada ${wave}: 300 bearers distintos`,
			status: tally(rs),
			secs: mb(dt / 1000),
			reqPerSec: mb(300 / (dt / 1000)),
			...m,
			notesSeenFiles: dirStats(s.stateLumbre, /^notes-seen-/),
			upstream: await s.upStats()
		});
	}
	// misma ráfaga, esperando 6 s (TTL de 5 s) por si algo se poda solo
	await sleep(6000);
	out({ step: 'tras 6 s en reposo', ...(await s.dbg()) });
	await s.stop();
} else if (scenario === 'b') {
	const s = await boot();
	const auth = bearer();
	await mcp(s.app, auth); // calienta
	const base = await s.dbg();
	out({ step: 'baseline (tras 1 petición)', ...base });
	for (const n of [500, 2000, 5000, 10000]) {
		const t0 = performance.now();
		const rs = await pool(n, 20, () => mcp(s.app, auth));
		const dt = performance.now() - t0;
		out({
			step: `${n} peticiones mismo bearer`,
			status: tally(rs),
			secs: mb(dt / 1000),
			reqPerSec: mb(n / (dt / 1000)),
			...(await s.dbg()),
			upstream: await s.upStats()
		});
	}
	await s.stop();
} else if (scenario === 'c') {
	for (const relax of [false, true]) {
		const s = await boot({ relax });
		const base = await s.dbg();
		out({ variant: relax ? 'c2 límites relajados' : 'c1 límites por defecto', baseline: base });
		const authz = (i) =>
			req(s.app, {
				method: 'GET',
				headers: { 'x-forwarded-for': relax ? `10.0.${(i >> 8) & 255}.${i & 255}` : '203.0.113.9' },
				path:
					'/authorize?' +
					new URLSearchParams({
						response_type: 'code',
						client_id: `https://claude.ai/oauth/probe-${relax ? i : 0}/client.json`,
						redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
						scope: 'lumbre:mcp',
						resource: 'https://mcp.lumbre.pro/mcp',
						code_challenge: 'A'.repeat(43),
						code_challenge_method: 'S256',
						state: 'x'.repeat(64)
					})
			});
		for (const total of relax ? [500, 1200] : [500]) {
			const already = relax && total === 1200 ? 500 : 0;
			const t0 = performance.now();
			const rs = await pool(total - already, relax ? 8 : 1, (i) => authz(i + already));
			const dt = performance.now() - t0;
			const st = dirStats(s.stateLumbre, /^oauth-store\.json$/);
			let pending = null;
			try {
				pending = JSON.parse((await import('node:fs')).readFileSync(join(s.stateLumbre, 'oauth-store.json'), 'utf8')).authorizationRequests.length;
			} catch {}
			const lat = rs.map((r) => r.ms).sort((a, b) => a - b);
			out({
				step: `${total} /authorize acumulados`,
				status: tally(rs),
				secs: mb(dt / 1000),
				pendingInStore: pending,
				storeBytes: st.bytes,
				bytesPerEntry: pending ? Math.round(st.bytes / pending) : null,
				latMsMedian: mb(lat[lat.length >> 1]),
				latMsP99: mb(lat[Math.floor(lat.length * 0.99)]),
				latMsLast20Avg: mb(rs.slice(-20).reduce((a, r) => a + r.ms, 0) / 20),
				backchannelCalls: await s.dbg('/bc'),
				...(await s.dbg())
			});
		}
		await s.stop();
	}
} else if (scenario === 'd') {
	const s = await boot({ upDelay: 3000 });
	const base = await s.dbg();
	out({ step: 'baseline', ...base });
	const t0 = performance.now();
	let peak = 0;
	const sampler = setInterval(async () => {
		try { peak = Math.max(peak, (await s.dbg()).rssMB); } catch {}
	}, 500);
	const rs = await pool(500, 500, () => mcp(s.app, bearer()));
	clearInterval(sampler);
	const dt = performance.now() - t0;
	out({
		step: '500 tools/call concurrentes, upstream 3 s',
		status: tally(rs),
		secs: mb(dt / 1000),
		peakRssMBsampled: mb(peak),
		upstream: await s.upStats(),
		...(await s.dbg())
	});
	await s.stop();
} else {
	console.error('escenario desconocido');
	process.exit(2);
}
process.exit(0);
