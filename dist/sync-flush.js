/**
 * Marca de proceso, por TOKEN, de "hubo al menos una mutación encolada desde
 * ESTE servidor MCP desde el último flush de sync" — la consultan las tools
 * de LECTURA (`list_tasks`, `get_task`, `list_lists`, `list_brl_entries`,
 * `read_attachment`, ver `index.ts`) para refrescar el sync ELLAS MISMAS
 * cuando hace falta, en vez de depender de que el modelo se acuerde de
 * llamar a `refresh_sync` a mano. Medido sobre 2.056 transcripts reales:
 * 506 llamadas manuales a `refresh_sync`, 2.463 lecturas y 1.854 mutaciones
 * — y se le olvidaba llamarla a veces, con la lectura saliendo rancia sin
 * ningún aviso. Simulado sobre ese mismo corpus, esta marca da 344 flushes
 * automáticos donde hoy hay 506 a mano, con menos huecos en blanco.
 *
 * MISMA mina que `existence-cache.ts` — léela primero si no la conoces: el
 * transporte HTTP remoto (`http.ts`) llama a `createServer` DENTRO de cada
 * `POST` (transporte stateless), así que una marca guardada en una variable
 * de la clausura de `createServer` nace y muere con ESA petición — la
 * mutación de una petición nunca llegaría a marcar la lectura de la
 * siguiente, y `mcp.lumbre.pro` no tendría error, test rojo ni síntoma
 * visible, solo la optimización sin efecto (exactamente lo que le pasó a
 * las cachés de existencia, arreglado en `b000c9c`). Por eso este registro
 * también vive a nivel de MÓDULO, indexado por token, y sobrevive entre
 * llamadas a `createServer` mientras viva el proceso.
 *
 * Poda por inactividad y tope de tokens — MISMOS valores que
 * `existence-cache.ts` y por el mismo motivo (ver el JSDoc de
 * `getExistenceCachesForToken` ahí), pero repetidos aquí en vez de
 * compartidos: son dos registros con ciclo de vida independiente, uno con
 * TTL por entrada y otro sin él (ver más abajo), y acoplarlos solo ahorraría
 * dos constantes a costa de mezclar dos responsabilidades en un mismo
 * fichero.
 *
 * A diferencia de `TaskExistenceCache`/`BrlExistenceCache`, esta marca NO
 * tiene TTL: no caduca sola con el tiempo, solo la limpia un flush que tuvo
 * éxito (`clearMutationPending`, llamada desde `index.ts` tras un
 * `refreshSync` que no lanzó). Una mutación que sigue sin flushear sigue
 * rancia por mucho que pase el tiempo, así que no hay "ventana" temporal que
 * expirar — solo el estado binario "pendiente / ya flusheada".
 *
 * ⚠️ Mismo límite que `existence-cache.ts`: esto asume un ÚNICO proceso. Si
 * `mcp.lumbre.pro` llegara a escalar a más de una instancia (o el runtime
 * reciclara el proceso), cada una tendría su propio registro y una mutación
 * encolada en una instancia no marcaría la lectura que cae en OTRA — mismo
 * hueco, un nivel más arriba, sin ningún error ni test que lo avise. No se
 * arregla aquí: se deja escrito para quien lo toque.
 */
/** Ver el JSDoc de `IDLE_EVICT_MS` en `existence-cache.ts` — mismo criterio,
 *  mismo valor. */
const IDLE_EVICT_MS = 30 * 60 * 1000;
/** Ver el JSDoc de `MAX_TOKENS` en `existence-cache.ts` — mismo criterio,
 *  mismo valor. */
const MAX_TOKENS = 200;
const registryByToken = new Map();
function pruneIdleTokens(nowMs) {
    for (const [token, state] of registryByToken) {
        if (nowMs - state.lastAccessMs > IDLE_EVICT_MS)
            registryByToken.delete(token);
    }
}
/** `Map` conserva el orden de INSERCIÓN, no de último acceso — de ahí que
 *  `getState` borre y reinserte la clave en cada acceso: así el primer token
 *  que itera este bucle es siempre el menos usado recientemente. Mismo
 *  patrón que `evictLeastRecentlyUsedIfOverCap` en `existence-cache.ts`. */
function evictLeastRecentlyUsedIfOverCap() {
    while (registryByToken.size > MAX_TOKENS) {
        const oldestToken = registryByToken.keys().next().value;
        if (oldestToken === undefined)
            break;
        registryByToken.delete(oldestToken);
    }
}
function getState(token, nowMs) {
    pruneIdleTokens(nowMs);
    let state = registryByToken.get(token);
    if (!state) {
        state = { pending: false, lastAccessMs: nowMs };
    }
    else {
        registryByToken.delete(token);
    }
    state.lastAccessMs = nowMs;
    registryByToken.set(token, state);
    evictLeastRecentlyUsedIfOverCap();
    return state;
}
/**
 * Marca `token` con "hay una mutación sin flushear" — la llama toda tool de
 * MUTACIÓN de `index.ts` tras encolar con éxito (`add_task`, `update_task`,
 * `complete_task`, `cancel_task`, `delete_task`, `add_subtask`,
 * `complete_subtask`, `reschedule_task`, `set_section`, `remove_section`,
 * `mutate_tasks`, `mutate_brl`, `add_attachment`). En `mutate_tasks`/
 * `mutate_brl` (éxito parcial) se llama si AL MENOS una operación se encoló
 * bien, no si todas.
 */
export function markMutationPending(token, now = Date.now) {
    getState(token, now()).pending = true;
}
/** `true` si `token` tiene una mutación pendiente de flush. */
export function isMutationPending(token, now = Date.now) {
    return getState(token, now()).pending;
}
/** Limpia la marca de `token` — SOLO se llama tras un flush que tuvo éxito
 *  (si `refreshSync` falla, se deja puesta a propósito para reintentar en la
 *  próxima lectura, ver `autoFlushSyncIfPending` en `index.ts`). */
export function clearMutationPending(token, now = Date.now) {
    getState(token, now()).pending = false;
}
/**
 * SOLO PARA TESTS: vacía el registro entero. Mismo motivo que
 * `resetExistenceCacheRegistryForTests` (`existence-cache.ts`): sin esto, dos
 * tests que usan el MISMO token (habitual: un `TEST_CONFIG` compartido)
 * heredarían la marca del test anterior en vez de partir de un registro
 * limpio. En producción nunca se llama.
 */
export function resetSyncFlushRegistryForTests() {
    registryByToken.clear();
}
//# sourceMappingURL=sync-flush.js.map