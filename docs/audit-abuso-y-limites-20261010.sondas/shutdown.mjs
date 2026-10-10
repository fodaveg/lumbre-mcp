// Q7: 50 peticiones en vuelo + SIGTERM sobre el ENTRYPOINT REAL (node dist/http.js), fuera de Docker.
// Upstream falso con 4 s de latencia para que las 50 estén en vuelo. Cortafuegos noprod.mjs activo.
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { Agent } from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { HERE, WORK, startChild, waitFor, sleep, req, MCP_HEADERS, LIST_TASKS, bearer, tally } from './lib.mjs';

const out = (o) => console.log(JSON.stringify(o));
const up = startChild(join(HERE, 'upstream.mjs'), { UP_DELAY_MS: '4000' }, 'up');
const upPort = await waitFor(() => /UPSTREAM_PORT=(\d+)/.exec(up.out)?.[1]);
const free = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const state = mkdtempSync(join(WORK, 'state-shutdown-'));
const srv = spawn(process.execPath, ['--import', join(HERE, 'noprod.mjs'), join(HERE, 'build/dist/http.js')], {
	env: {
		...process.env, PORT: String(free), LUMBRE_BASE_URL: `http://127.0.0.1:${upPort}`, XDG_STATE_HOME: state,
		LUMBRE_MCP_BACKCHANNEL_SECRET: 'x'.repeat(40)
	},
	stdio: ['ignore', 'pipe', 'pipe']
});
let err = '';
srv.stderr.on('data', (d) => (err += d));
srv.on('exit', (code, sig) => { srv.exited = { code, sig, at: performance.now() }; });
await waitFor(() => /escuchando/.test(err));

const agent = new Agent({ keepAlive: false, maxSockets: 100 });
const t0 = performance.now();
const pending = Array.from({ length: 50 }, () => req(free, { headers: { ...MCP_HEADERS, authorization: bearer() }, body: LIST_TASKS, agent }));
await waitFor(async () => ((await (await fetch(`http://127.0.0.1:${upPort}/__stats`)).json()).maxInflight >= 50));
const tKill = performance.now();
srv.kill('SIGTERM');
const results = await Promise.all(pending);
await sleep(300);
out({
	q: 'Q7', test: '50 en vuelo + SIGTERM (proceso normal, no PID 1)',
	inFlightAtSigterm: 50, results: tally(results.map((r) => ({ status: r.status ? r.status : r.error }))),
	firstFailMsAfterSigterm: Math.round(Math.min(...results.map((r) => r.ms)) - (tKill - t0)),
	exited: srv.exited ? { code: srv.exited.code, signal: srv.exited.sig, msAfterSigterm: Math.round(srv.exited.at - tKill) } : 'sigue vivo',
	noprodBlocks: (err.match(/NOPROD/g) ?? []).length
});

// Control: ¿un SIGTERM con las peticiones YA terminadas sale limpio?
srv.kill('SIGKILL');
up.kill('SIGKILL');
process.exit(0);
