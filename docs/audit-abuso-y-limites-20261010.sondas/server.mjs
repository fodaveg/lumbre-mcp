// Servidor lumbre-mcp REAL (dist compilado de HEAD) contra upstream falso, con backchannel y CIMD
// simulados (inyectados por las costuras de createOAuthService, igual que los tests).
// Env: PORT_FILE_DIR (donde escribe ports.json), UP_PORT, STATE (XDG_STATE_HOME), RELAX=1 (quita límites
// OAuth para medir coste por entrada), SWEEP=1 (arranca el barrido de credenciales).
// Un listener de DEPURACIÓN aparte (127.0.0.1:0) devuelve memoria tras gc: GET /mem, /bc.
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const BUILD = new URL('./build/dist/', import.meta.url);
const { createHttpApp, startCredentialSweep } = await import(new URL('http.js', BUILD));
const { createOAuthService } = await import(new URL('oauth.js', BUILD));

const state = process.env.STATE;
process.env.XDG_STATE_HOME = state;
const stateDir = join(state, 'lumbre-mcp');
const upstream = `http://127.0.0.1:${process.env.UP_PORT}`;

const bcCalls = { requests: 0, exchange: 0, introspect: 0, revoke: 0 };
const backchannel = {
	ensureConfigured() {},
	async createAuthorizationRequest() {
		bcCalls.requests += 1;
		const requestId = randomUUID();
		return {
			authorizationUrl: `https://app.lumbre.pro/connect?request=${requestId}`,
			requestId,
			expiresAt: Date.now() + 10 * 60_000
		};
	},
	async exchange() { bcCalls.exchange += 1; throw new Error('no usado'); },
	async introspect() { bcCalls.introspect += 1; return { active: false }; },
	async revoke() { bcCalls.revoke += 1; }
};
const fakeFetch = async (url) => {
	const clientId = String(url);
	return new Response(
		JSON.stringify({
			client_id: clientId,
			client_name: 'Claude (falso)',
			redirect_uris: ['https://claude.ai/api/mcp/auth_callback']
		}),
		{ status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'max-age=300' } }
	);
};

const relax = process.env.RELAX === '1';
const oauth = createOAuthService({
	stateDir,
	backchannel,
	fetch: fakeFetch,
	...(relax
		? {
				publicLimits: {
					authorize: { requestsPerMinute: 1e9, concurrent: 1e6 },
					token: { requestsPerMinute: 1e9, concurrent: 1e6 },
					revoke: { requestsPerMinute: 1e9, concurrent: 1e6 }
				},
				authorizeBudget: { perClientPerMinute: 1e9, globalPerMinute: 1e9 },
				failedMcpAttemptsPerMinute: 1e9
			}
		: {})
});
await oauth.ensureReady();
const app = createHttpApp(upstream, oauth);
if (process.env.SWEEP === '1') startCredentialSweep(app, oauth);

const open = new Set();
app.on('connection', (s) => { open.add(s); s.on('close', () => open.delete(s)); });
await new Promise((r) => app.listen(Number(process.env.PORT || 0), '127.0.0.1', r));

const dbg = createServer((req, res) => {
	if (req.url === '/cfg') {
		res.end(JSON.stringify({
			requestTimeout: app.requestTimeout, headersTimeout: app.headersTimeout,
			keepAliveTimeout: app.keepAliveTimeout, maxConnections: app.maxConnections ?? null,
			maxRequestsPerSocket: app.maxRequestsPerSocket, node: process.version
		}));
		return;
	}
	if (req.url === '/bc') {
		res.end(JSON.stringify(bcCalls));
		return;
	}
	global.gc?.();
	global.gc?.();
	const m = process.memoryUsage();
	res.end(JSON.stringify({ heapUsedMB: m.heapUsed / 1048576, externalMB: m.external / 1048576, arrayBuffersMB: m.arrayBuffers / 1048576, rssMB: m.rss / 1048576, sockets: open.size }));
});
await new Promise((r) => dbg.listen(0, '127.0.0.1', r));
writeFileSync(
	join(process.env.PORT_FILE_DIR, 'ports.json'),
	JSON.stringify({ app: app.address().port, dbg: dbg.address().port, pid: process.pid })
);
console.log('READY');
