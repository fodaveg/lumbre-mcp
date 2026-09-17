import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Tests del transporte HTTP remoto (`http.ts`, tarea M2, cableado a la
 * factory real de `index.ts` tras M1). Levanta el server real de
 * `createHttpApp` en un puerto EFÍMERO (`listen(0)`) y le habla con `fetch`
 * crudo — el mismo patrón que usaría `scripts/smoke-remote.mjs` contra un
 * despliegue real. Ninguno de estos tests llama a una tool (`tools/call`),
 * solo `initialize`/`tools/list`, así que ninguno toca red de verdad hacia
 * app.lumbre.pro — no hace falta mockear `fetch` (ver `lumbre-client.test.ts`
 * para ese patrón si algún día se añade un test de `tools/call`).
 *
 * `enableJsonResponse: true` (fijado en `http.ts`) hace que cada respuesta
 * sea JSON directo, no un stream SSE — así los tests son `fetch` + `.json()`
 * sin parsear `text/event-stream` a mano.
 */

let baseUrl: string;
let server: Server;

const JSON_RPC_HEADERS = {
	'content-type': 'application/json',
	accept: 'application/json, text/event-stream'
};

function initializeBody(id = 1) {
	return {
		jsonrpc: '2.0',
		id,
		method: 'initialize',
		params: {
			protocolVersion: '2025-06-18',
			capabilities: {},
			clientInfo: { name: 'http-test-client', version: '0.0.0' }
		}
	};
}

function toolsListBody(id = 2) {
	return { jsonrpc: '2.0', id, method: 'tools/list', params: {} };
}

beforeAll(async () => {
	const { createHttpApp } = await import('./http.js');
	const app = createHttpApp('https://app.lumbre.test');
	server = app.listen(0);
	await new Promise<void>((resolve) => server.once('listening', resolve));
	const port = (server.address() as AddressInfo).port;
	baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
	await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe('GET /healthz', () => {
	it('200 texto plano, sin auth', async () => {
		const res = await fetch(`${baseUrl}/healthz`);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('ok');
	});
});

describe('POST /mcp — auth fail-closed', () => {
	it('sin Authorization: 401 con cuerpo JSON-RPC de error', async () => {
		const res = await fetch(`${baseUrl}/mcp`, {
			method: 'POST',
			headers: JSON_RPC_HEADERS,
			body: JSON.stringify(initializeBody())
		});
		expect(res.status).toBe(401);
		expect(res.headers.get('www-authenticate')).toBe(
			'Bearer resource_metadata="https://mcp.lumbre.pro/.well-known/oauth-protected-resource/mcp", scope="lumbre:mcp"'
		);
		const body = (await res.json()) as { jsonrpc: string; error: { code: number; message: string } };
		expect(body.jsonrpc).toBe('2.0');
		expect(body.error.message).toMatch(/Authorization/);
	});

	it('con Authorization mal formado (sin "Bearer "): 401', async () => {
		const res = await fetch(`${baseUrl}/mcp`, {
			method: 'POST',
			headers: { ...JSON_RPC_HEADERS, authorization: 'tok-123' },
			body: JSON.stringify(initializeBody())
		});
		expect(res.status).toBe(401);
	});
});

describe('POST /mcp — DNS-rebinding (Host/Origin)', () => {
	it('Origin fuera de la lista permitida: 403, ANTES de mirar el token', async () => {
		const res = await fetch(`${baseUrl}/mcp`, {
			method: 'POST',
			headers: { ...JSON_RPC_HEADERS, origin: 'https://evil.example', authorization: 'Bearer tok-123' },
			body: JSON.stringify(initializeBody())
		});
		expect(res.status).toBe(403);
	});

	it('sin Origin (cliente no-navegador): pasa la validación (solo protege contra un navegador)', async () => {
		const res = await fetch(`${baseUrl}/mcp`, {
			method: 'POST',
			headers: { ...JSON_RPC_HEADERS, authorization: 'Bearer tok-123' },
			body: JSON.stringify(initializeBody())
		});
		expect(res.status).not.toBe(403);
	});
});

describe('POST /mcp — con token, contra el servidor real (createServer de index.ts, M1)', () => {
	it('initialize responde 200 con el nombre del server', async () => {
		const res = await fetch(`${baseUrl}/mcp`, {
			method: 'POST',
			headers: { ...JSON_RPC_HEADERS, authorization: 'Bearer tok-válido' },
			body: JSON.stringify(initializeBody())
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { result: { serverInfo: { name: string } } };
		expect(body.result.serverInfo.name).toBe('lumbre-mcp');
	});

	it('tools/list responde con las 24 tools de producción, sin `$schema` y bajo el mismo techo de bytes que index.test.ts', async () => {
		const res = await fetch(`${baseUrl}/mcp`, {
			method: 'POST',
			headers: { ...JSON_RPC_HEADERS, authorization: 'Bearer tok-válido' },
			body: JSON.stringify(toolsListBody())
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { result: { tools: Array<{ name: string; inputSchema: unknown }> } };
		expect(body.result.tools).toHaveLength(24);
		expect(JSON.stringify(body.result.tools)).not.toMatch(/\$schema/);
		// Mismo techo que `index.test.ts` (medido allí sobre transporte
		// in-memory) — aquí se confirma que el mismo `stripToolsListSchema`
		// aplicado sobre `StreamableHTTPServerTransport` da el mismo resultado
		// que sobre stdio/in-memory, no un tamaño distinto por transporte.
		// Subido a 24 tools/28.500 al añadir `get_list` (tarea 827a7878) — ver `index.test.ts`.
		expect(JSON.stringify(body.result.tools).length).toBeLessThan(28500);
	});

	it('cada petición es un McpServer NUEVO (stateless): dos peticiones seguidas, ninguna arrastra estado de la otra', async () => {
		const first = await fetch(`${baseUrl}/mcp`, {
			method: 'POST',
			headers: { ...JSON_RPC_HEADERS, authorization: 'Bearer tok-a' },
			body: JSON.stringify(toolsListBody(10))
		});
		const second = await fetch(`${baseUrl}/mcp`, {
			method: 'POST',
			headers: { ...JSON_RPC_HEADERS, authorization: 'Bearer tok-b' },
			body: JSON.stringify(toolsListBody(11))
		});
		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		// Ninguna de las dos trae `mcp-session-id`: modo stateless de verdad.
		expect(first.headers.get('mcp-session-id')).toBeNull();
		expect(second.headers.get('mcp-session-id')).toBeNull();
	});
});

describe('POST /mcp — la caché de existencia SOBREVIVE entre peticiones HTTP (bug medido el 26 ago 2026)', () => {
	/**
	 * `getExistenceCachesForToken` (`existence-cache.ts`) vive en un registro
	 * de MÓDULO justo por esto: `handleMcpRequest` llama a `createServer`
	 * DENTRO de cada `POST` (transporte stateless, ver el JSDoc de cabecera de
	 * `http.ts`), así que un test que solo comprobara "la caché acierta" con
	 * UN `McpServer` in-memory (como el de `index.test.ts`) pasa en verde con
	 * el bug intacto: nunca cruza dos peticiones HTTP reales, que es donde
	 * `createServer` se llama dos veces. Este test sí — dos `fetch` de verdad
	 * contra el `server.listen(0)` de `beforeAll`, el mismo camino que
	 * `scripts/smoke-remote.mjs` usa contra producción.
	 *
	 * El `fetch` global se mockea para DOS destinos a la vez: las llamadas del
	 * propio test contra `baseUrl` (el server HTTP local, real) se dejan pasar
	 * al `fetch` original; las que `lumbre-client.ts` hace contra
	 * `https://app.lumbre.test` (el `baseUrl` que `createHttpApp` recibió en
	 * `beforeAll`) se responden con los fixtures de abajo — mismo patrón que
	 * `index.test.ts` (`countExistenceGets`/`jsonResponse`), llevado al
	 * transporte HTTP.
	 */
	const TASK_ID = '44444444-4444-4444-4444-444444444444';
	const originalFetch = globalThis.fetch;

	function lumbreTask(overrides: Record<string, unknown> = {}) {
		return {
			id: TASK_ID,
			content: 'tarea de prueba (http)',
			notes: null,
			done: false,
			priority: null,
			date: null,
			deadline: null,
			list: null,
			createdAt: new Date().toISOString(),
			parentId: null,
			...overrides
		};
	}

	function jsonResponse(body: unknown, status = 200): Response {
		return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
	}

	/** Cuenta las llamadas a `GET /api/tasks?id=` (el chequeo de existencia
	 *  de `findTaskById` dentro de `requireTaskExists`) — separado de la
	 *  llamada del propio test contra el server HTTP local. */
	function countExistenceGets(fetchSpy: ReturnType<typeof vi.fn>): number {
		return fetchSpy.mock.calls.filter((call) => String(call[0]).includes('/api/tasks?id=')).length;
	}

	function stubUpstreamFetch(): ReturnType<typeof vi.fn> {
		const fetchSpy = vi.fn(async (url: string | URL, init?: RequestInit) => {
			const u = String(url);
			if (u.startsWith(baseUrl)) return originalFetch(url, init); // el propio server HTTP local
			if (u.includes('/api/tasks?id=')) return jsonResponse([lumbreTask()]);
			if (u.includes('/api/mutations')) return jsonResponse({ ok: true });
			throw new Error(`fetch no mockeado en este test: ${u}`);
		});
		vi.stubGlobal('fetch', fetchSpy);
		return fetchSpy;
	}

	async function toolCall(
		token: string,
		id: number,
		name: string,
		args: Record<string, unknown>
	): Promise<{ status: number; isError?: boolean }> {
		const res = await fetch(`${baseUrl}/mcp`, {
			method: 'POST',
			headers: { ...JSON_RPC_HEADERS, authorization: `Bearer ${token}` },
			body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
		});
		const body = (await res.json()) as { result?: { isError?: boolean } };
		return { status: res.status, isError: body.result?.isError };
	}

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('dos peticiones HTTP con el MISMO token: la segunda no repite el GET de existencia', async () => {
		const fetchSpy = stubUpstreamFetch();
		const token = 'tok-cache-mismo';

		// get_task puebla la caché (siempre trae fresco, ver su JSDoc en index.ts).
		const first = await toolCall(token, 101, 'get_task', { taskId: TASK_ID });
		expect(first.isError).not.toBe(true);
		expect(countExistenceGets(fetchSpy)).toBe(1);

		// complete_task, PETICIÓN HTTP DISTINTA, mismo token: si `createServer`
		// instanciara la caché por petición (el bug de 26 ago), esto repetiría
		// el GET. Con el registro por token, reutiliza el hit.
		const second = await toolCall(token, 102, 'complete_task', { taskId: TASK_ID });
		expect(second.isError).not.toBe(true);
		expect(countExistenceGets(fetchSpy)).toBe(1);
	});

	it('aislamiento: dos peticiones con tokens DISTINTOS no comparten caché', async () => {
		const fetchSpy = stubUpstreamFetch();

		const first = await toolCall('tok-cache-a', 201, 'get_task', { taskId: TASK_ID });
		expect(first.isError).not.toBe(true);
		expect(countExistenceGets(fetchSpy)).toBe(1);

		// Mismo taskId, TOKEN DISTINTO: no debe heredar el hit del token anterior
		// — dos credenciales no comparten (ni invalidan) la caché de la otra.
		const second = await toolCall('tok-cache-b', 202, 'complete_task', { taskId: TASK_ID });
		expect(second.isError).not.toBe(true);
		expect(countExistenceGets(fetchSpy)).toBe(2);
	});
});

describe('POST /mcp — el 401 de una tool según el modo de autenticación (tarea 0a717ae9)', () => {
	/**
	 * `request()`/`getAttachment`/`uploadAttachment` (`lumbre-client.ts`)
	 * convertían CUALQUIER 401 de `app.lumbre.pro` en «Token inválido o no
	 * configurado (LUMBRE_TOKEN)», también cuando la credencial venía de un
	 * access token OAuth 2.1 resuelto por el broker — un mensaje que no dice
	 * nada de cómo arreglarlo (este proceso remoto nunca lee `LUMBRE_TOKEN`) y
	 * confunde a quien lo usa. `unauthorizedApiError` decide ahora el texto
	 * según `config.authMode`, fijado en `handleMcpRequest` (`http.ts`) según
	 * de dónde salió el token. Un caso por modo, con una tool real
	 * (`list_lists`, sin parámetros) contra un 401 mockeado de Lumbre.
	 */
	const originalFetch = globalThis.fetch;

	function jsonResponse(body: unknown, status = 200): Response {
		return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
	}

	async function callListLists(
		target: string,
		authorization: string
	): Promise<{ isError?: boolean; text: string }> {
		const res = await fetch(`${target}/mcp`, {
			method: 'POST',
			headers: { ...JSON_RPC_HEADERS, authorization },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: { name: 'list_lists', arguments: {} }
			})
		});
		const body = (await res.json()) as {
			result?: { isError?: boolean; content?: Array<{ text?: string }> };
		};
		return { isError: body.result?.isError, text: body.result?.content?.[0]?.text ?? '' };
	}

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('modo token (Bearer directo, mismo tipo de credencial que LUMBRE_TOKEN): conserva el mensaje de siempre', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string | URL, init?: RequestInit) => {
				const u = String(url);
				if (u.startsWith(baseUrl)) return originalFetch(url, init);
				return jsonResponse({ message: 'unauthorized' }, 401);
			})
		);

		const { isError, text } = await callListLists(baseUrl, 'Bearer tok-directo-revocado');
		expect(isError).toBe(true);
		expect(text).toMatch(/LUMBRE_TOKEN/);
	});

	it('modo OAuth (access token resuelto por el broker): NO nombra LUMBRE_TOKEN, invita a reconectar', async () => {
		const { createHttpApp } = await import('./http.js');
		const { OAuthService } = await import('./oauth.js');
		const stateDir = await mkdtemp(join(tmpdir(), 'lumbre-mcp-401-oauth-'));
		const oauth = new OAuthService({ stateDir });
		vi.spyOn(oauth, 'isOAuthAccessToken').mockReturnValue(true);
		vi.spyOn(oauth, 'resolveAccessToken').mockResolvedValue('upstream-token-revocado');

		const oauthApp = createHttpApp('https://app.lumbre.test', oauth);
		const oauthServer = oauthApp.listen(0);
		await new Promise<void>((resolve) => oauthServer.once('listening', resolve));
		const oauthBaseUrl = `http://127.0.0.1:${(oauthServer.address() as AddressInfo).port}`;

		try {
			vi.stubGlobal(
				'fetch',
				vi.fn(async (url: string | URL, init?: RequestInit) => {
					const u = String(url);
					if (u.startsWith(oauthBaseUrl)) return originalFetch(url, init);
					return jsonResponse({ message: 'unauthorized' }, 401);
				})
			);

			const { isError, text } = await callListLists(oauthBaseUrl, 'Bearer lm_at_cualquiera');
			expect(isError).toBe(true);
			expect(text).not.toMatch(/LUMBRE_TOKEN/);
			expect(text).toMatch(/OAuth/);
			expect(text).toMatch(/reconecta|Vuelve a conectar/i);
		} finally {
			await new Promise<void>((resolve, reject) => oauthServer.close((err) => (err ? reject(err) : resolve())));
		}
	});
});

describe('POST /mcp/<token> — token en el path (app de Claude, sin cabeceras)', () => {
	const VALID_PATH_TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

	it('token bien formado en el path autentica igual que la cabecera: 200', async () => {
		const res = await fetch(`${baseUrl}/mcp/${VALID_PATH_TOKEN}`, {
			method: 'POST',
			headers: JSON_RPC_HEADERS,
			body: JSON.stringify(initializeBody())
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { result: { serverInfo: { name: string } } };
		expect(body.result.serverInfo.name).toBe('lumbre-mcp');
	});

	it('tools/list también funciona por el path', async () => {
		const res = await fetch(`${baseUrl}/mcp/${VALID_PATH_TOKEN}`, {
			method: 'POST',
			headers: JSON_RPC_HEADERS,
			body: JSON.stringify(toolsListBody())
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { result: { tools: unknown[] } };
		expect(body.result.tools).toHaveLength(24);
	});

	it('si vienen las dos formas, gana la cabecera', async () => {
		// El token del path es deliberadamente inválido (mal formado): si
		// ganase el path, `createServer` se llamaría con ÉL y el smoke no
		// distinguiría cuál se usó — en vez de eso, forzamos que el path esté
		// mal formado para comprobar que NO tumba la petición: como pierde
		// frente a la cabecera, ni se llega a mirar su forma.
		const res = await fetch(`${baseUrl}/mcp/no-es-un-token-valido`, {
			method: 'POST',
			headers: { ...JSON_RPC_HEADERS, authorization: 'Bearer tok-de-cabecera' },
			body: JSON.stringify(initializeBody())
		});
		expect(res.status).toBe(200);
	});

	it('path mal formado y SIN cabecera: 401, igual que sin token', async () => {
		const res = await fetch(`${baseUrl}/mcp/no-es-un-token-valido`, {
			method: 'POST',
			headers: JSON_RPC_HEADERS,
			body: JSON.stringify(initializeBody())
		});
		expect(res.status).toBe(401);
	});

	it('/mcp/ (segmento vacío): 401', async () => {
		const res = await fetch(`${baseUrl}/mcp/`, {
			method: 'POST',
			headers: JSON_RPC_HEADERS,
			body: JSON.stringify(initializeBody())
		});
		expect(res.status).toBe(401);
	});

	it('/mcp/algo/mas (varios segmentos): 401, no 404', async () => {
		const res = await fetch(`${baseUrl}/mcp/algo/mas`, {
			method: 'POST',
			headers: JSON_RPC_HEADERS,
			body: JSON.stringify(initializeBody())
		});
		expect(res.status).toBe(401);
	});

	it('GET /healthz sigue sin pedir token (el path token no lo toca)', async () => {
		const res = await fetch(`${baseUrl}/healthz`);
		expect(res.status).toBe(200);
	});

	it('el log de la petición NUNCA contiene el token, ni el bien formado ni el mal formado', async () => {
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			await fetch(`${baseUrl}/mcp/${VALID_PATH_TOKEN}`, {
				method: 'POST',
				headers: JSON_RPC_HEADERS,
				body: JSON.stringify(initializeBody())
			});
			const malformedToken = 'no-es-un-token-valido-pero-tampoco-deberia-salir';
			await fetch(`${baseUrl}/mcp/${malformedToken}`, {
				method: 'POST',
				headers: JSON_RPC_HEADERS,
				body: JSON.stringify(initializeBody())
			});
			const loggedLines = errSpy.mock.calls.map((call) => call.join(' ')).join('\n');
			expect(loggedLines).not.toContain(VALID_PATH_TOKEN);
			expect(loggedLines).not.toContain(malformedToken);
		} finally {
			errSpy.mockRestore();
		}
	});
});

describe('POST /mcp — método HTTP no soportado', () => {
	it('GET /mcp: 405 (modo stateless, sin stream de servidor)', async () => {
		const res = await fetch(`${baseUrl}/mcp`, { method: 'GET', headers: JSON_RPC_HEADERS });
		expect(res.status).toBe(405);
	});
});

describe('ruta desconocida', () => {
	it('404 texto plano', async () => {
		const res = await fetch(`${baseUrl}/no-existe`);
		expect(res.status).toBe(404);
	});
});

describe('POST /mcp — huella de notas SEGREGADA por cuenta (createAccountNotesSeenStore, notes.ts)', () => {
	/**
	 * Bug que esta feature cierra: `handleMcpRequest` (`http.ts`) llamaba a
	 * `createServer` sin `notesSeenStore`, así que caía en `fileNotesSeenStore`
	 * — UN fichero (`notes-seen.json`) compartido por CUALQUIER token que
	 * hablara con este relé (ver `deploy/compose.yml`). Estos tests corren
	 * contra el server HTTP real (mismo patrón que el describe de la caché de
	 * existencia más arriba: dos `fetch` de verdad, no un `McpServer` in-memory
	 * — un test así SÍ cruza dos llamadas reales a `createServer`, que es
	 * donde vivía el bug) y comprueban el fichero en disco bajo un
	 * `XDG_STATE_HOME` temporal propio de este bloque.
	 */
	let stateDir: string;
	const originalFetch = globalThis.fetch;
	const TASK_ID = '55555555-5555-5555-5555-555555555555';

	beforeEach(async () => {
		stateDir = await mkdtemp(join(tmpdir(), 'lumbre-mcp-http-notes-test-'));
		process.env.XDG_STATE_HOME = stateDir;
	});

	afterEach(async () => {
		delete process.env.XDG_STATE_HOME;
		vi.unstubAllGlobals();
	});

	function taskWithNote(notesUpdatedAt: string) {
		return {
			id: TASK_ID,
			content: 'tarea con nota (http, huella por cuenta)',
			notes: 'una nota cualquiera para probar la huella por cuenta',
			notesUpdatedAt,
			done: false,
			priority: null,
			date: null,
			deadline: null,
			list: null,
			createdAt: new Date().toISOString(),
			parentId: null
		};
	}

	function jsonResponse(body: unknown, status = 200): Response {
		return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
	}

	function stubUpstreamFetch(notesUpdatedAt: string): ReturnType<typeof vi.fn> {
		const fetchSpy = vi.fn(async (url: string | URL, init?: RequestInit) => {
			const u = String(url);
			if (u.startsWith(baseUrl)) return originalFetch(url, init); // el propio server HTTP local
			if (u.includes('/api/tasks')) return jsonResponse([taskWithNote(notesUpdatedAt)]);
			throw new Error(`fetch no mockeado en este test: ${u}`);
		});
		vi.stubGlobal('fetch', fetchSpy);
		return fetchSpy;
	}

	async function listTasksAuto(token: string, id: number): Promise<Response> {
		return fetch(`${baseUrl}/mcp`, {
			method: 'POST',
			headers: { ...JSON_RPC_HEADERS, authorization: `Bearer ${token}` },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id,
				method: 'tools/call',
				params: { name: 'list_tasks', arguments: { scope: 'all' } }
			})
		});
	}

	async function accountFiles(): Promise<string[]> {
		const dir = join(stateDir, 'lumbre-mcp');
		const names = await readdir(dir).catch(() => [] as string[]);
		return names.filter((n) => n.startsWith('notes-seen-') && n !== 'notes-seen.json');
	}

	it('dos cuentas (tokens) distintas: un fichero de huella POR CUENTA, ninguno compartido', async () => {
		stubUpstreamFetch('2026-07-20T00:00:00.000Z');
		const resA = await listTasksAuto('token-cuenta-http-a', 301);
		expect(resA.status).toBe(200);
		const resB = await listTasksAuto('token-cuenta-http-b', 302);
		expect(resB.status).toBe(200);

		expect(await accountFiles()).toHaveLength(2);
	});

	it('el nombre de los ficheros de cuenta no contiene el token en claro', async () => {
		stubUpstreamFetch('2026-07-20T00:00:00.000Z');
		const token = 'token-http-con-forma-reconocible-abc123';
		const res = await listTasksAuto(token, 303);
		expect(res.status).toBe(200);

		const dir = join(stateDir, 'lumbre-mcp');
		const names = await readdir(dir);
		for (const name of names) expect(name).not.toContain(token);
	});

	it('la MISMA cuenta reutiliza su fichero entre dos peticiones HTTP distintas (no crea uno nuevo cada vez)', async () => {
		stubUpstreamFetch('2026-07-20T00:00:00.000Z');
		const token = 'token-http-reuso';

		await listTasksAuto(token, 304);
		const afterFirst = await accountFiles();
		expect(afterFirst).toHaveLength(1);

		await listTasksAuto(token, 305); // segunda petición HTTP, mismo token
		const afterSecond = await accountFiles();
		expect(afterSecond).toEqual(afterFirst); // sigue siendo el MISMO fichero
	});

	it('el conector stdio local sigue usando `notes-seen.json` (sin sufijo) — no lo toca este transporte', async () => {
		stubUpstreamFetch('2026-07-20T00:00:00.000Z');
		await listTasksAuto('token-cuenta-http-c', 306);

		const dir = join(stateDir, 'lumbre-mcp');
		const names = await readdir(dir);
		expect(names).not.toContain('notes-seen.json'); // el transporte HTTP nunca escribe el fichero sin sufijo
	});
});
