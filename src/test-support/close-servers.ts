import type { Server } from 'node:http';

/**
 * Cierra los servidores HTTP que levantó un test, SIN esperar al keep-alive.
 *
 * `server.close()` a secas deja de aceptar conexiones y cierra las que están
 * ociosas EN ESE INSTANTE (Node ≥ 19), pero no las que tienen una petición en
 * vuelo: cuando esa petición termina, la conexión se queda viva como
 * keep-alive y `close()` no resuelve hasta que caduca. Los arneses de
 * `oauth.test.ts` y `sumego-oidc.test.ts` suben `keepAliveTimeout` a 60 s (ver
 * su `listen`), así que ese `await` del `afterEach` tardaba un minuto: medido
 * con Node 24, una petición en vuelo al llamar a `close()` lo deja sin
 * resolver pasados 3 s, y la respuesta llega a los 300 ms.
 *
 * Eso convertía un test que se pasaba de su plazo en una cascada (21 oct 2026,
 * 2 de 9 corridas con la máquina cargada): el test agotaba sus 5 s, vitest
 * pasaba al `afterEach` mientras el cuerpo del test SEGUÍA corriendo con su
 * petición en vuelo, el `afterEach` se quedaba en este `close()` hasta su
 * propio plazo (10 s: los «15007 ms») y el cuerpo huérfano seguía
 * levantando servidores y escribiendo en disco encima del test siguiente.
 *
 * `closeAllConnections()` justo después de `close()` corta también las que
 * están en vuelo; el `afterEach` ya no depende de nada que vaya a ocurrir
 * después. Vacía `servers` (como hacían los `splice(0)` de los arneses) para
 * que un servidor que se registre después vaya al siguiente cierre.
 */
export async function closeServers(servers: Server[]): Promise<void> {
	await Promise.all(
		servers.splice(0).map((server) => {
			const closed = new Promise<void>((resolve) => server.close(() => resolve()));
			server.closeAllConnections();
			return closed;
		})
	);
}
