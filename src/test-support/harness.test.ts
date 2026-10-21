import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OAuthService } from '../oauth.js';
import { closeServers } from './close-servers.js';

/**
 * Lo que impide que un test HTTP del almacén OAuth dependa de la carga de la
 * máquina (cuelgues del 21 oct 2026). Cada test falla de forma determinista
 * si se quita su mitad del arreglo; ver `close-servers.ts` y
 * `no-disk-flush.ts`.
 */
describe('arnés de los tests HTTP', () => {
	it('closeServers no espera al keep-alive de una petición que estaba en vuelo', async () => {
		// Sin `closeAllConnections`, el `await` de abajo no resuelve hasta que
		// caduca el keep-alive (60 s, como en los arneses): el test se agota.
		let arrived!: () => void;
		const inFlight = new Promise<void>((resolve) => {
			arrived = resolve;
		});
		let respond: (() => void) | undefined;
		const server = createServer((_req, res) => {
			respond = () => res.end('ok');
			arrived();
		});
		server.keepAliveTimeout = 60_000;
		server.listen(0, '127.0.0.1');
		await once(server, 'listening');
		const { port } = server.address() as AddressInfo;
		const response = fetch(`http://127.0.0.1:${port}/`).then(
			(res) => res.text(),
			() => 'cortada'
		);
		await inFlight;
		const servers = [server];
		const closing = closeServers(servers);
		// La respuesta termina DESPUÉS de empezar el cierre, como la de un test
		// que se pasó de plazo y sigue corriendo durante su `afterEach`.
		respond!();
		await closing;
		expect(servers).toEqual([]);
		expect(server.listening).toBe(false);
		expect(await response).toBe('cortada');
	});

	it('los sync() del almacén se piden igual pero no vacían el disco', async () => {
		const state = (globalThis as Record<symbol, { calls: number } | undefined>)[
			Symbol.for('lumbre-mcp.test.no-disk-flush')
		];
		expect(state, 'vitest.config.ts tiene que cargar src/test-support/no-disk-flush.ts').toBeDefined();
		const dir = await mkdtemp(join(tmpdir(), 'lumbre-mcp-harness-'));
		try {
			const before = state!.calls;
			const service = new OAuthService({
				stateDir: dir,
				backchannelSecret: 'secreto-backchannel-de-prueba-32-caracteres',
				fetch: async () => {
					throw new Error('este test no habla con nadie');
				}
			});
			// Crear la clave: `sync()` del temporal y del directorio. La
			// durabilidad del código no cambia; solo deja de pagarse en el test.
			await service.ensureReady();
			expect(state!.calls - before).toBe(2);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
