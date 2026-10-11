import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyStartupFailure, installGracefulShutdown } from './http-lifecycle.js';
import { createHttpApp } from './http.js';
import { OAuthService } from './oauth.js';

/**
 * Ciclo de vida del proceso del relé (`http-lifecycle.ts`): la causa
 * clasificada de un arranque fallido (H2 de
 * `docs/audit-recuperacion-despliegue-20261010.md`) y el apagado ordenado
 * ante SIGTERM (H3).
 */

const SECRET = 'secreto-backchannel-de-prueba-32-caracteres';
const EMPTY_STORE = {
	version: 3,
	grants: [],
	usedRefreshTokens: [],
	authorizationRequests: [],
	authorizationCodes: [],
	revocationOutbox: []
};

const cleanup: string[] = [];

async function stateDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'lumbre-mcp-lifecycle-'));
	cleanup.push(dir);
	return dir;
}

afterEach(async () => {
	for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** El error REAL que lanza `ensureReady` con ese directorio de estado. */
async function readinessError(dir: string, options: { secret?: string } = {}): Promise<unknown> {
	const service = new OAuthService({ stateDir: dir, backchannelSecret: options.secret ?? SECRET });
	try {
		await service.ensureReady();
	} catch (error) {
		return error;
	}
	throw new Error('ensureReady no falló');
}

const VALID_KEY = Buffer.alloc(32, 7).toString('base64url');

describe('classifyStartupFailure — causa fija, contra los errores reales de OAuthService', () => {
	it('clave_ausente: hay store y falta oauth.key', async () => {
		const dir = await stateDir();
		await writeFile(join(dir, 'oauth-store.json'), JSON.stringify(EMPTY_STORE), { mode: 0o600 });
		expect(classifyStartupFailure(await readinessError(dir))).toBe('clave_ausente');
	});

	it('clave_invalida: oauth.key no mide 32 bytes', async () => {
		const dir = await stateDir();
		await writeFile(join(dir, 'oauth.key'), 'corta', { mode: 0o600 });
		expect(classifyStartupFailure(await readinessError(dir))).toBe('clave_invalida');
	});

	it('clave_invalida: una clave de 32 bytes que no descifra el store', async () => {
		// Una autorización pendiente deja en el store un valor cifrado con la
		// clave del directorio; luego se cambia la clave por otra válida.
		const dir = await stateDir();
		const service = new OAuthService({
			stateDir: dir,
			backchannel: {
				ensureConfigured() {},
				async createAuthorizationRequest() {
					const requestId = randomUUID();
					return {
						authorizationUrl: `https://app.lumbre.pro/connect?request=${requestId}`,
						requestId,
						expiresAt: Date.now() + 10 * 60_000
					};
				},
				async exchange() { throw new Error('no usado'); },
				async introspect() { throw new Error('no usado'); },
				async revoke() {}
			},
			fetch: async (url) =>
				new Response(
					JSON.stringify({
						client_id: String(url),
						client_name: 'Claude (prueba)',
						redirect_uris: ['https://claude.ai/api/mcp/auth_callback']
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } }
				)
		});
		await service.ensureReady();
		const app = createHttpApp('https://app.lumbre.test', service);
		app.listen(0, '127.0.0.1');
		await new Promise<void>((resolve) => app.once('listening', resolve));
		try {
			const port = (app.address() as AddressInfo).port;
			const query = new URLSearchParams({
				response_type: 'code',
				client_id: 'https://claude.ai/.well-known/oauth-client/lumbre',
				redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
				scope: 'lumbre:mcp',
				resource: 'https://mcp.lumbre.pro/mcp',
				code_challenge: 'A'.repeat(43),
				code_challenge_method: 'S256'
			});
			const res = await fetch(`http://127.0.0.1:${port}/authorize?${query}`, { redirect: 'manual' });
			expect(res.status).toBe(302);
		} finally {
			await new Promise<void>((resolve) => app.close(() => resolve()));
		}
		await writeFile(join(dir, 'oauth.key'), VALID_KEY, { mode: 0o600 });
		expect(classifyStartupFailure(await readinessError(dir))).toBe('clave_invalida');
	});

	it('store_json_invalido: store truncado; la causa no arrastra el texto del fichero', async () => {
		const dir = await stateDir();
		await writeFile(join(dir, 'oauth.key'), VALID_KEY, { mode: 0o600 });
		await writeFile(join(dir, 'oauth-store.json'), '{"version":3,"grants":[{"secreto":"no-debe-salir"', { mode: 0o600 });
		const error = await readinessError(dir);
		// El mensaje original sí lleva el texto (por eso no se registra nunca).
		expect(error).toBeInstanceOf(SyntaxError);
		expect(classifyStartupFailure(error)).toBe('store_json_invalido');
	});

	it('store_incoherente: JSON válido fuera de contrato', async () => {
		const dir = await stateDir();
		await writeFile(join(dir, 'oauth.key'), VALID_KEY, { mode: 0o600 });
		await writeFile(join(dir, 'oauth-store.json'), JSON.stringify({ ...EMPTY_STORE, grants: {} }), { mode: 0o600 });
		expect(classifyStartupFailure(await readinessError(dir))).toBe('store_incoherente');
	});

	it('store_version: store provisional v2', async () => {
		const dir = await stateDir();
		await writeFile(join(dir, 'oauth.key'), VALID_KEY, { mode: 0o600 });
		await writeFile(join(dir, 'oauth-store.json'), JSON.stringify({ ...EMPTY_STORE, version: 2 }), { mode: 0o600 });
		expect(classifyStartupFailure(await readinessError(dir))).toBe('store_version');
	});

	it('secreto_backchannel: secreto corto', async () => {
		expect(classifyStartupFailure(await readinessError(await stateDir(), { secret: 'corto' }))).toBe('secreto_backchannel');
	});

	it('app_base_url: LUMBRE_APP_BASE_URL que no es la de Lumbre (lanza al construir)', () => {
		let error: unknown;
		try {
			new OAuthService({ stateDir: '/nunca-se-usa', lumbreAppBaseUrl: 'https://otra.example' });
		} catch (caught) {
			error = caught;
		}
		expect(classifyStartupFailure(error)).toBe('app_base_url');
	});

	it('io:<código>: el store es un directorio', async () => {
		const dir = await stateDir();
		await writeFile(join(dir, 'oauth.key'), VALID_KEY, { mode: 0o600 });
		await mkdir(join(dir, 'oauth-store.json'));
		expect(classifyStartupFailure(await readinessError(dir))).toBe('io:EISDIR');
	});

	it('clave_invalida: una encryptionKey inyectada que no mide 32 bytes (lanza al construir)', () => {
		let error: unknown;
		try {
			new OAuthService({ stateDir: '/nunca-se-usa', encryptionKey: Buffer.alloc(16) });
		} catch (caught) {
			error = caught;
		}
		expect(classifyStartupFailure(error)).toBe('clave_invalida');
	});

	it('TODO `throw new Error(...)` de oauth.ts y del backchannel tiene causa: uno nuevo sin clasificar pone esto rojo', async () => {
		// Lectura estática: los errores de petición de `oauth.ts` son
		// `OAuthError` (no casan con este patrón); los `Error` a secas son los
		// de carga y validación del store, la clave y la configuración, que
		// son justo los que pueden tumbar el arranque.
		const sources = await Promise.all(
			['src/oauth.ts', 'src/lumbre-oauth-backchannel.ts'].map((path) => readFile(path, 'utf8'))
		);
		const messages: string[] = [];
		const pattern = /throw new Error\(\s*(['`])((?:(?!\1).)*)\1\s*\)/g;
		for (const source of sources) {
			for (const match of source.matchAll(pattern)) {
				// Las plantillas: `${…}` se sustituye por un valor cualquiera.
				messages.push(match[2]!.replace(/\$\{[^}]*\}/g, 'https://app.lumbre.pro'));
			}
		}
		// Si la expresión dejara de casar, el test pasaría sin mirar nada.
		expect(messages.length).toBeGreaterThanOrEqual(30);
		const unclassified = messages.filter((message) => classifyStartupFailure(new Error(message)) === 'desconocido');
		expect(unclassified).toEqual([]);
	});

	it('desconocido para todo lo demás, y un código que no tiene forma de errno no pasa', () => {
		expect(classifyStartupFailure(new Error('otra cosa'))).toBe('desconocido');
		expect(classifyStartupFailure('texto')).toBe('desconocido');
		expect(classifyStartupFailure(undefined)).toBe('desconocido');
		expect(classifyStartupFailure(Object.assign(new Error('x'), { code: 'Etoken lm_at_123' }))).toBe('desconocido');
		expect(classifyStartupFailure(Object.assign(new Error('x'), { code: 'ERR_OSSL_BAD' }))).toBe('desconocido');
	});
});

describe('installGracefulShutdown — SIGTERM drena en vez de cortar', () => {
	interface Harness {
		server: Server;
		port: number;
		signals: EventEmitter;
		exits: number[];
		lines: string[];
		uninstall: () => void;
		exited: Promise<number>;
	}

	const harnesses: Harness[] = [];

	afterEach(async () => {
		for (const h of harnesses.splice(0)) {
			h.uninstall();
			h.server.closeAllConnections();
			await new Promise<void>((resolve) => h.server.close(() => resolve()));
		}
	});

	async function start(
		handler: (res: import('node:http').ServerResponse) => void,
		options: { timeoutMs?: number; drain?: () => Promise<void> } = {}
	): Promise<Harness> {
		const server = createServer((_req, res) => handler(res));
		server.listen(0, '127.0.0.1');
		await new Promise<void>((resolve) => server.once('listening', resolve));
		const signals = new EventEmitter();
		const exits: number[] = [];
		const lines: string[] = [];
		let resolveExit!: (code: number) => void;
		const exited = new Promise<number>((resolve) => (resolveExit = resolve));
		const uninstall = installGracefulShutdown(server, {
			timeoutMs: options.timeoutMs ?? 2_000,
			drain: options.drain,
			signalSource: signals,
			exit: (code) => {
				exits.push(code);
				resolveExit(code);
			},
			log: (line) => lines.push(line)
		});
		const h = { server, port: (server.address() as AddressInfo).port, signals, exits, lines, uninstall, exited };
		harnesses.push(h);
		return h;
	}

	/** Petición con keep-alive (como la de Caddy hacia el contenedor). */
	function get(port: number): Promise<{ status: number } | { error: string }> {
		return new Promise((resolve) => {
			const req = httpRequest({ host: '127.0.0.1', port, path: '/', headers: { connection: 'keep-alive' } }, (res) => {
				res.resume();
				res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
			});
			req.on('error', (error: NodeJS.ErrnoException) => resolve({ error: error.code ?? 'error' }));
			req.end();
		});
	}

	it('una petición en vuelo termina con 200 y el proceso sale con 0 sin esperar al plazo', async () => {
		const h = await start((res) => setTimeout(() => res.end('ok'), 200));
		const inFlight = get(h.port);
		await new Promise((resolve) => setTimeout(resolve, 50));
		const t0 = Date.now();
		h.signals.emit('SIGTERM');
		expect(await inFlight).toEqual({ status: 200 });
		expect(await h.exited).toBe(0);
		expect(Date.now() - t0).toBeLessThan(1_500);
		expect(h.lines.join('\n')).toMatch(/SIGTERM: apagado ordenado/);
	});

	it('espera al drenaje (la cola de escritura) antes de salir', async () => {
		let drained = false;
		const h = await start((res) => res.end('ok'), {
			drain: async () => {
				await new Promise((resolve) => setTimeout(resolve, 150));
				drained = true;
			}
		});
		h.signals.emit('SIGINT');
		expect(await h.exited).toBe(0);
		expect(drained).toBe(true);
	});

	it('una petición que no acaba se corta al agotar el plazo y sale con 1', async () => {
		const h = await start(() => {
			/* nunca responde */
		}, { timeoutMs: 200 });
		const stuck = get(h.port);
		await new Promise((resolve) => setTimeout(resolve, 50));
		h.signals.emit('SIGTERM');
		expect(await h.exited).toBe(1);
		expect(await stuck).toHaveProperty('error');
		expect(h.lines.join('\n')).toMatch(/plazo agotado/);
	});

	it('una segunda señal durante el apagado sale en el acto', async () => {
		const h = await start(() => {
			/* nunca responde */
		}, { timeoutMs: 5_000 });
		void get(h.port);
		await new Promise((resolve) => setTimeout(resolve, 50));
		h.signals.emit('SIGTERM');
		h.signals.emit('SIGTERM');
		expect(await h.exited).toBe(1);
		expect(h.exits).toEqual([1]);
	});
});
