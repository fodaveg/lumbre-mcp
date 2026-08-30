import type { LumbreBrlEntry, LumbreTask } from './lumbre-client.js';

/**
 * Caché de proceso, corta a propósito, para el GET de existencia que hacen
 * `requireTaskExists`/`requireBrlEntryExists` (`index.ts`) antes de encolar
 * una mutación: si el `taskId`/`entryId` se acaba de resolver con un listado
 * (`list_tasks`, `get_task`, `mutate_tasks`, `list_brl_entries`) en la MISMA
 * sesión, no hace falta repetir el `GET /api/tasks?id=`/`GET /api/brl/:date`
 * antes de cada `POST` que le siga.
 *
 * TTL de POCOS SEGUNDOS, no minutos — y es la parte que importa, no un
 * detalle de ajuste: el chequeo de existencia nació para pillar un id mal
 * transcrito que se perdía en silencio (ver el JSDoc de `requireTaskExists`),
 * y un "existe" RANCIO tras un borrado hecho desde OTRO dispositivo (fuera
 * del alcance de esta caché, que vive solo en ESTE proceso y no ve el CRDT)
 * rompería exactamente esa garantía. Unos pocos segundos cubren el patrón
 * real (varias tool calls seguidas dentro del mismo turno) sin arriesgar una
 * ventana de staleness que importe.
 */
export const EXISTENCE_CACHE_TTL_MS = 5000;

interface CacheEntry<T> {
	value: T;
	expiresAt: number;
}

/**
 * Caché de existencia de TAREAS. Vive en la instancia que crea `createServer`
 * (`index.ts`), no en módulo — para que un futuro transporte HTTP stateless
 * pueda crear una instancia limpia por petición en vez de compartir estado
 * entre peticiones de usuarios distintos.
 *
 * `now` inyectable (default `Date.now`) para poder testear la expiración sin
 * `setTimeout`/temporizadores falsos — mismo patrón que `opts.now` de
 * `computeAutoNotesRender` en `notes.ts`.
 */
export class TaskExistenceCache {
	private readonly entries = new Map<string, CacheEntry<LumbreTask>>();

	constructor(
		private readonly ttlMs: number = EXISTENCE_CACHE_TTL_MS,
		private readonly now: () => number = Date.now
	) {}

	/** Tarea cacheada y AÚN vigente para `taskId`, o `undefined` — nunca vista,
	 *  o expirada (en cuyo caso también se poda de la caché, de paso). */
	get(taskId: string): LumbreTask | undefined {
		const entry = this.entries.get(taskId);
		if (!entry) return undefined;
		if (entry.expiresAt <= this.now()) {
			this.entries.delete(taskId);
			return undefined;
		}
		return entry.value;
	}

	/** Registra/refresca `task` con un TTL nuevo desde ahora — usado tanto al
	 *  resolver un `taskId` suelto (`requireTaskExists`, `get_task`) como al
	 *  volcar un listado entero (`list_tasks`, `mutate_tasks`), ver `setAll`.
	 *  Una archivada recuperada mediante `includeArchived` NO entra: esta caché
	 *  evita el lookup de precondición de las tools de mutación, y una lectura
	 *  ampliada no debe autorizar indirectamente una escritura que el lookup
	 *  normal (`includeArchived=false`) rechazaría. */
	set(task: LumbreTask): void {
		if (task.archivedAt) {
			this.entries.delete(task.id);
			return;
		}
		this.entries.set(task.id, { value: task, expiresAt: this.now() + this.ttlMs });
	}

	/** Atajo de `set` para un lote (`listTasks`/`findTasksByIds`). */
	setAll(tasks: Iterable<LumbreTask>): void {
		for (const task of tasks) this.set(task);
	}

	/** Borra la entrada de `taskId` — cualquier mutación LOCAL sobre ese id
	 *  (encolada desde ESTE proceso) la invalida, para no servir un "existe"
	 *  de antes de esa mutación. No-op si `taskId` no estaba cacheado (p. ej.
	 *  es un `listId`/`sectionId`, que nunca pasa por esta caché). */
	invalidate(taskId: string): void {
		this.entries.delete(taskId);
	}
}

/**
 * Caché de existencia de ENTRADAS DEL REGISTRO (BRL) — mismo motivo/TTL que
 * `TaskExistenceCache`, gemela para `requireBrlEntryExists`. Solo guarda la
 * EXISTENCIA (el TTL hace de booleano), no la entrada entera: a diferencia de
 * una tarea, una entrada de BRL no se vuelve a mostrar desde esta caché, solo
 * se comprueba que sigue ahí. Clave compuesta `date::entryId` porque una
 * entrada del registro solo se puede buscar POR DÍA (no hay lookup por id
 * suelto, ver `listBrlEntries` en `lumbre-client.ts`).
 */
export class BrlExistenceCache {
	private readonly entries = new Map<string, number>();

	constructor(
		private readonly ttlMs: number = EXISTENCE_CACHE_TTL_MS,
		private readonly now: () => number = Date.now
	) {}

	private key(date: string, entryId: string): string {
		return `${date}::${entryId}`;
	}

	/** `true` si `entryId` del día `date` está en caché y AÚN vigente. */
	has(date: string, entryId: string): boolean {
		const key = this.key(date, entryId);
		const expiresAt = this.entries.get(key);
		if (expiresAt === undefined) return false;
		if (expiresAt <= this.now()) {
			this.entries.delete(key);
			return false;
		}
		return true;
	}

	/** Registra TODAS las entradas de `date` (un `list_brl_entries` o el fetch
	 *  de fallback de `requireBrlEntryExists`) con un TTL nuevo desde ahora. */
	setAll(date: string, entries: Iterable<LumbreBrlEntry>): void {
		const expiresAt = this.now() + this.ttlMs;
		for (const entry of entries) this.entries.set(this.key(date, entry.id), expiresAt);
	}

	/** Borra la entrada `(date, entryId)` — una edición/borrado LOCAL sobre
	 *  ella la invalida (`update_brl_entry`/`delete_brl_entry`). */
	invalidate(date: string, entryId: string): void {
		this.entries.delete(this.key(date, entryId));
	}
}

/**
 * Registro de `taskCache`/`brlCache` POR TOKEN, a nivel de MÓDULO — sobrevive
 * mientras viva el proceso (`node dist/http.js`), no la petición que lo pide.
 *
 * Nace del bug medido el 26 ago 2026 contra `mcp.lumbre.pro`: `http.ts` llama
 * a `createServer` DENTRO de cada `POST` (transporte stateless, ver su
 * JSDoc), y `createServer` instanciaba `TaskExistenceCache`/`BrlExistenceCache`
 * como estado de la LLAMADA — nacían y morían con la petición, así que el
 * TTL de 5 s nunca llegaba a acertar ni una vez en remoto: cada mutación
 * seguía pagando el `GET` de existencia que esta caché existe para evitar.
 * En stdio (`main`, un proceso por cliente) esto nunca se notó porque el
 * proceso YA vivía entre tool calls, aunque `createServer` solo se llamara
 * una vez.
 *
 * Indexado por TOKEN y NUNCA compartido entre tokens distintos: dos
 * credenciales no deben poder ver ni invalidar la caché de existencia la una
 * de la otra — sería una fuga de aislamiento entre cuentas, no un simple
 * detalle de rendimiento, aunque hoy Lumbre sea monousuario (el servidor no
 * lo sabe: el token es la única frontera que tiene).
 *
 * Fuga acotada, con dos guardas perezosas (se disparan al pedir una caché,
 * sin temporizador de fondo):
 *  1. `pruneIdleTokens`: un token sin actividad más de `IDLE_EVICT_MS` se
 *     retira en el próximo acceso a CUALQUIER token — el TTL de 5 s poda las
 *     ENTRADAS de cada caché solas, pero la clave del token en este registro
 *     no, así que hace falta esta segunda poda o el registro solo crece.
 *  2. `evictLeastRecentlyUsedIfOverCap`: si aun con la poda de arriba el
 *     registro supera `MAX_TOKENS` (un cliente mandando muchos
 *     `Authorization` distintos en poco tiempo, ataque o bug), se retira el
 *     token MENOS usado recientemente hasta volver al tope — protege contra
 *     una ráfaga que la poda por inactividad todavía no ha tenido ocasión de
 *     limpiar.
 *
 * ⚠️ Esto asume un ÚNICO proceso: si `mcp.lumbre.pro` llegara a escalar a más
 * de una instancia, o el runtime reciclara el proceso, cada una tendría su
 * propio registro y el acierto de caché volvería a caer sin ningún error ni
 * test que lo avise — exactamente el mismo hueco, un nivel más arriba. No se
 * arregla aquí: se deja escrito para quien lo toque.
 */
interface TokenCacheBundle {
	taskCache: TaskExistenceCache;
	brlCache: BrlExistenceCache;
	lastAccessMs: number;
}

/** Un token sin ninguna petición en media hora se considera abandonado
 *  (dispositivo apagado, credencial rotada…) — media hora es generoso frente
 *  al patrón real (varias tool calls dentro del mismo turno/sesión), así que
 *  no corta un uso legítimo, solo el goteo de tokens que ya no vuelven. */
const IDLE_EVICT_MS = 30 * 60 * 1000;

/** Tope duro de tokens distintos vivos a la vez — cubre con margen los
 *  dispositivos reales de un usuario (Claude Code, claude.ai web/móvil,
 *  alguna credencial rotada a medio expirar) sin dejar el registro abierto a
 *  crecer sin límite si algo (ataque o bug) manda muchos `Authorization`
 *  distintos antes de que `IDLE_EVICT_MS` tenga ocasión de podarlos. */
const MAX_TOKENS = 200;

const registryByToken = new Map<string, TokenCacheBundle>();

function pruneIdleTokens(nowMs: number): void {
	for (const [token, bundle] of registryByToken) {
		if (nowMs - bundle.lastAccessMs > IDLE_EVICT_MS) registryByToken.delete(token);
	}
}

/** `Map` conserva el orden de INSERCIÓN, no de último acceso — de ahí que
 *  `getExistenceCachesForToken` borre y reinserte la clave en cada acceso
 *  (ver más abajo): así el primer token que itera este bucle es siempre el
 *  menos usado recientemente. */
function evictLeastRecentlyUsedIfOverCap(): void {
	while (registryByToken.size > MAX_TOKENS) {
		const oldestToken = registryByToken.keys().next().value;
		if (oldestToken === undefined) break;
		registryByToken.delete(oldestToken);
	}
}

/**
 * `taskCache`/`brlCache` para `token` — los crea la primera vez que ve ese
 * token y devuelve el MISMO par en accesos siguientes, para que el TTL
 * persista entre llamadas a `createServer` distintas (una por petición HTTP
 * en `http.ts`) en vez de nacer y morir con cada una.
 *
 * `ttlMs`/`now` solo importan la PRIMERA vez que se ve `token` — es cuando se
 * construyen las cachés; accesos siguientes devuelven el par ya creado, con
 * el reloj con el que nació, sea cual sea el que se les pase después (mismo
 * criterio que `opts.now` de `createServer`: el reloj de test se fija al
 * construir, no en cada lectura). En producción es irrelevante — solo hay un
 * `now` real (`Date.now`) para todos los tokens.
 */
export function getExistenceCachesForToken(
	token: string,
	ttlMs: number,
	now: () => number
): { taskCache: TaskExistenceCache; brlCache: BrlExistenceCache } {
	const nowMs = now();
	pruneIdleTokens(nowMs);

	let bundle = registryByToken.get(token);
	if (!bundle) {
		bundle = { taskCache: new TaskExistenceCache(ttlMs, now), brlCache: new BrlExistenceCache(ttlMs, now), lastAccessMs: nowMs };
	} else {
		// Borrar+reinsertar mueve la clave al final del orden de inserción, que
		// es lo que lee `evictLeastRecentlyUsedIfOverCap` como "más reciente".
		registryByToken.delete(token);
	}
	bundle.lastAccessMs = nowMs;
	registryByToken.set(token, bundle);

	evictLeastRecentlyUsedIfOverCap();
	return bundle;
}

/**
 * SOLO PARA TESTS: vacía el registro entero. Sin esto, dos tests que usan el
 * MISMO token (habitual: un `TEST_CONFIG` compartido) heredarían el bundle
 * — y el `now` congelado en él — del test anterior, en vez de partir de una
 * caché limpia. En producción nunca se llama: el registro solo se vacía por
 * las podas de arriba o al morir el proceso.
 */
export function resetExistenceCacheRegistryForTests(): void {
	registryByToken.clear();
}
