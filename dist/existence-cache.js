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
    ttlMs;
    now;
    entries = new Map();
    constructor(ttlMs = EXISTENCE_CACHE_TTL_MS, now = Date.now) {
        this.ttlMs = ttlMs;
        this.now = now;
    }
    /** Tarea cacheada y AÚN vigente para `taskId`, o `undefined` — nunca vista,
     *  o expirada (en cuyo caso también se poda de la caché, de paso). */
    get(taskId) {
        const entry = this.entries.get(taskId);
        if (!entry)
            return undefined;
        if (entry.expiresAt <= this.now()) {
            this.entries.delete(taskId);
            return undefined;
        }
        return entry.value;
    }
    /** Registra/refresca `task` con un TTL nuevo desde ahora — usado tanto al
     *  resolver un `taskId` suelto (`requireTaskExists`, `get_task`) como al
     *  volcar un listado entero (`list_tasks`, `mutate_tasks`), ver `setAll`. */
    set(task) {
        this.entries.set(task.id, { value: task, expiresAt: this.now() + this.ttlMs });
    }
    /** Atajo de `set` para un lote (`listTasks`/`findTasksByIds`). */
    setAll(tasks) {
        for (const task of tasks)
            this.set(task);
    }
    /** Borra la entrada de `taskId` — cualquier mutación LOCAL sobre ese id
     *  (encolada desde ESTE proceso) la invalida, para no servir un "existe"
     *  de antes de esa mutación. No-op si `taskId` no estaba cacheado (p. ej.
     *  es un `listId`/`sectionId`, que nunca pasa por esta caché). */
    invalidate(taskId) {
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
    ttlMs;
    now;
    entries = new Map();
    constructor(ttlMs = EXISTENCE_CACHE_TTL_MS, now = Date.now) {
        this.ttlMs = ttlMs;
        this.now = now;
    }
    key(date, entryId) {
        return `${date}::${entryId}`;
    }
    /** `true` si `entryId` del día `date` está en caché y AÚN vigente. */
    has(date, entryId) {
        const key = this.key(date, entryId);
        const expiresAt = this.entries.get(key);
        if (expiresAt === undefined)
            return false;
        if (expiresAt <= this.now()) {
            this.entries.delete(key);
            return false;
        }
        return true;
    }
    /** Registra TODAS las entradas de `date` (un `list_brl_entries` o el fetch
     *  de fallback de `requireBrlEntryExists`) con un TTL nuevo desde ahora. */
    setAll(date, entries) {
        const expiresAt = this.now() + this.ttlMs;
        for (const entry of entries)
            this.entries.set(this.key(date, entry.id), expiresAt);
    }
    /** Borra la entrada `(date, entryId)` — una edición/borrado LOCAL sobre
     *  ella la invalida (`update_brl_entry`/`delete_brl_entry`). */
    invalidate(date, entryId) {
        this.entries.delete(this.key(date, entryId));
    }
}
//# sourceMappingURL=existence-cache.js.map