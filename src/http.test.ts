import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

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

	it('tools/list responde con las 25 tools de producción, sin `$schema` y bajo el mismo techo de bytes que index.test.ts', async () => {
		const res = await fetch(`${baseUrl}/mcp`, {
			method: 'POST',
			headers: { ...JSON_RPC_HEADERS, authorization: 'Bearer tok-válido' },
			body: JSON.stringify(toolsListBody())
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { result: { tools: Array<{ name: string; inputSchema: unknown }> } };
		expect(body.result.tools).toHaveLength(25);
		expect(JSON.stringify(body.result.tools)).not.toMatch(/\$schema/);
		// Mismo techo que `index.test.ts` (medido allí sobre transporte
		// in-memory) — aquí se confirma que el mismo `stripToolsListSchema`
		// aplicado sobre `StreamableHTTPServerTransport` da el mismo resultado
		// que sobre stdio/in-memory, no un tamaño distinto por transporte.
		expect(JSON.stringify(body.result.tools).length).toBeLessThan(25600);
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
		expect(body.result.tools).toHaveLength(25);
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
