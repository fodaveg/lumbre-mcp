// Utilidades de las sondas: arranque/parada de upstream falso y servidor, cliente HTTP con keep-alive.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { request as httpRequest, Agent } from 'node:http';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const HERE = new URL('.', import.meta.url).pathname;
export const WORK = process.env.WORK ?? HERE; // scratchpad (se usa como TMPDIR de las sondas)

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function startChild(file, env, tag) {
	const child = spawn(process.execPath, ['--expose-gc', ...(env.NODE_FLAGS ? env.NODE_FLAGS.split(' ') : []), file], {
		env: { ...process.env, ...env },
		stdio: ['ignore', 'pipe', 'pipe']
	});
	child.tag = tag;
	child.out = '';
	child.err = '';
	child.stdout.on('data', (d) => (child.out += d));
	child.stderr.on('data', (d) => (child.err += d));
	return child;
}

export async function waitFor(fn, ms = 15000) {
	const end = Date.now() + ms;
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() > end) throw new Error('timeout esperando');
		await sleep(50);
	}
}

/** Arranca upstream falso + servidor real. Devuelve helpers y `stop()`. */
export async function boot({ relax = false, sweep = false, upDelay = 0, upStatus = 0, stateDir } = {}) {
	const state = stateDir ?? mkdtempSync(join(WORK, 'state-'));
	const up = startChild(join(HERE, 'upstream.mjs'), { UP_DELAY_MS: String(upDelay), ...(upStatus ? { UP_STATUS: String(upStatus) } : {}) }, 'up');
	const upPort = await waitFor(() => /UPSTREAM_PORT=(\d+)/.exec(up.out)?.[1]);
	const portDir = mkdtempSync(join(WORK, 'ports-'));
	const srv = startChild(
		join(HERE, 'server.mjs'),
		{ UP_PORT: upPort, STATE: state, PORT_FILE_DIR: portDir, RELAX: relax ? '1' : '0', SWEEP: sweep ? '1' : '0' },
		'srv'
	);
	const ports = await waitFor(() => {
		try {
			return JSON.parse(readFileSync(join(portDir, 'ports.json'), 'utf8'));
		} catch {
			if (srv.exitCode !== null) throw new Error('servidor murió: ' + srv.err);
			return null;
		}
	});
	const dbg = async (p = '/mem') => (await fetch(`http://127.0.0.1:${ports.dbg}${p}`)).json();
	const upStats = async () => (await fetch(`http://127.0.0.1:${upPort}/__stats`)).json();
	return {
		state,
		stateLumbre: join(state, 'lumbre-mcp'),
		app: ports.app,
		upPort,
		srv,
		up,
		dbg,
		upStats,
		async stop() {
			srv.kill('SIGKILL');
			up.kill('SIGKILL');
			await sleep(100);
		}
	};
}

const agent = new Agent({ keepAlive: true, maxSockets: 64 });

export function req(port, { method = 'POST', path = '/mcp', headers = {}, body, agent: a = agent } = {}) {
	return new Promise((resolve) => {
		const t0 = performance.now();
		const r = httpRequest(
			{ host: '127.0.0.1', port, method, path, headers, agent: a },
			(res) => {
				const chunks = [];
				res.on('data', (c) => chunks.push(c));
				res.on('end', () =>
					resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString(), ms: performance.now() - t0 })
				);
			}
		);
		r.on('error', (e) => resolve({ status: 0, error: e.code ?? e.message, ms: performance.now() - t0 }));
		if (body !== undefined) r.write(body);
		r.end();
	});
}

export const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
export const LIST_TASKS = JSON.stringify({
	jsonrpc: '2.0',
	id: 1,
	method: 'tools/call',
	params: { name: 'list_tasks', arguments: {} }
});

export const bearer = () => 'Bearer ' + randomBytes(16).toString('hex');

/** Ejecuta `n` tareas con concurrencia `c`. */
export async function pool(n, c, fn) {
	let next = 0;
	const results = new Array(n);
	await Promise.all(
		Array.from({ length: c }, async () => {
			for (;;) {
				const i = next++;
				if (i >= n) return;
				results[i] = await fn(i);
			}
		})
	);
	return results;
}

export const tally = (rs) => rs.reduce((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});

export function dirStats(dir, re) {
	let n = 0;
	let bytes = 0;
	for (const f of readdirSync(dir)) {
		if (re && !re.test(f)) continue;
		n += 1;
		bytes += statSync(join(dir, f)).size;
	}
	return { files: n, bytes };
}

export const mb = (x) => Math.round(x * 100) / 100;
