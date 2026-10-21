import { open } from 'node:fs/promises';

/**
 * `setupFiles` de vitest: en los tests, `FileHandle.sync()` no vacía la caché
 * del disco. Solo cuenta la llamada.
 *
 * POR QUÉ. El almacén OAuth (`oauth.ts`) hace `sync()` del temporal y del
 * directorio en cada escritura (`mutateStore`, la clave), y está bien que lo
 * haga en producción: es su garantía de durabilidad. Pero en macOS libuv
 * implementa ese `sync()` con `fcntl(F_FULLFSYNC)`, que vacía la caché de
 * escritura de la unidad ENTERA y espera a que termine, con lo que hayan
 * escrito los demás procesos de la máquina. Su latencia es la de toda la
 * máquina, no la del test: medida aquí, 3,7 ms de mediana en reposo y hasta
 * 758 ms con otro proceso escribiendo 3 GiB.
 *
 * Y no era un coste marginal: en `oauth.test.ts` + `sumego-oidc.test.ts`,
 * 2.338 `sync()` sumaban 8,5 de los 16,6 s de reloj (el 51 %). «store v3
 * rechaza credenciales…» hace 44 (148 de sus 221 ms), así que con 115 ms por
 * vaciado ya no cabe en los 5 s de vitest. Inyectando 150 ms por `sync()` se
 * reproduce, siempre, el fallo de las corridas con carga del 21 oct 2026:
 * 5 s de test + 10 s de `afterEach` (ver `close-servers.ts`).
 *
 * Lo que los tests SÍ comprueban sigue intacto: que el código pide el
 * `sync()` y en qué orden respecto al `rename` (`persistenceStep`, y el
 * contador de abajo en `harness.test.ts`). Lo que ningún test puede
 * comprobar —que el dato sobrevive a un corte de luz— no lo comprobaba
 * tampoco el vaciado real.
 */

const STATE = Symbol.for('lumbre-mcp.test.no-disk-flush');

interface NoDiskFlushState {
	/** `sync()` y `datasync()` pedidos desde que arrancó el proceso. */
	calls: number;
}

type SyncMethod = (this: unknown) => Promise<void>;

const registry = globalThis as typeof globalThis & { [STATE]?: NoDiskFlushState };

// El prototipo de `FileHandle` es del PROCESO, no del módulo: vitest evalúa
// este fichero una vez por fichero de test, y sin esta guarda cada uno
// envolvería al anterior.
if (!registry[STATE]) {
	const state: NoDiskFlushState = { calls: 0 };
	const handle = await open(process.execPath, 'r');
	const proto = Object.getPrototypeOf(handle) as { sync: SyncMethod; datasync: SyncMethod };
	await handle.close();
	const counted: SyncMethod = async function () {
		state.calls += 1;
	};
	proto.sync = counted;
	proto.datasync = counted;
	registry[STATE] = state;
}

// Sin exportaciones a propósito: `harness.test.ts` lee el contador por
// `Symbol.for` y no importa este módulo, porque importarlo lo instalaría y el
// test ya no podría detectar que `vitest.config.ts` ha dejado de cargarlo.
export {};
