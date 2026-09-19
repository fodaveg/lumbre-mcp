import { assertTaskUsable, findTaskById } from '../lumbre-client.js';
/**
 * Comprueba que `taskId` EXISTE antes de encolar cualquier mutación sobre él,
 * y (SELECTIVAMENTE, ver `allowSubtask`) que no sea una subtarea si la tool
 * no admite una ahí. `/api/mutations` NO valida esto server-side (deliberado
 * — ver el JSDoc de ese endpoint: `tasks` es una proyección que puede ir
 * desfasada del CRDT real, así que el drenaje del CLIENTE descarta en
 * silencio cualquier `taskId` que no encuentre). Sin el chequeo de
 * EXISTENCIA aquí, un id mal transcrito (typo real que mordió a David el
 * 2026-07-17: `9c184fe4-2103-…` en vez de `9c184fe4-ddb2-4103-…`) se
 * encolaba igual y el MCP contestaba "Encolado…" tan tranquilo, perdiendo la
 * mutación sin avisar. La EXISTENCIA sí se puede comprobar en el acto (a
 * diferencia de si la mutación llegó a APLICARSE, que sigue siendo asíncrono
 * — ver `ASYNC_NOTE`), así que sí merece la pena gastar la llamada extra a
 * `GET /api/tasks?id=` (vía `findTaskById`) antes de encolar.
 *
 * Fino wrapper de red sobre `assertTaskUsable` (`lumbre-client.ts`, función
 * PURA que hace la comprobación en sí — allí vive el JSDoc completo del
 * criterio `allowSubtask` por tool, y sus tests). Lanza si no existe, o si
 * existe pero es una subtarea y `allowSubtask` es `false`; el llamante ya
 * está dentro de un `try/catch` que lo convierte en `errorResult`.
 *
 * `opts` es una `SubtaskDecision` (objeto con nombre) y no un booleano
 * suelto para que la llamada diga QUÉ decide el flag: `{ allowSubtask: true }`
 * se lee en el sitio, un `true` pelado repartido por diez tools no.
 *
 * Compartida por dos familias (`tools/attachments.ts` y `tools/tasks.ts`, ver
 * la tarea de partir `index.ts`, 2026-09-17): antes era una closure de
 * `createServer` sobre `config`/`taskCache`; ahora recibe `ctx` explícito
 * como primer argumento — mismo comportamiento, sin capturar nada.
 */
export async function requireTaskExists(ctx, taskId, opts = {}) {
    // Caché corta (`taskCache`, ver `existence-cache.ts`): si `taskId` se
    // acaba de resolver con un listado en esta MISMA sesión (list_tasks,
    // get_task, mutate_tasks), no repetimos el `GET /api/tasks?id=` — el TTL
    // es de pocos segundos justo para no confiar en un "existe" viejo.
    const cached = ctx.taskCache.get(taskId);
    if (cached !== undefined) {
        assertTaskUsable(cached, taskId, opts);
        return;
    }
    const task = await findTaskById(ctx.config, taskId);
    if (task)
        ctx.taskCache.set(task);
    assertTaskUsable(task, taskId, opts);
}
// `mutateTaskInvalidating` (wrapper de `mutateTask` que invalidaba
// `taskCache` tras encolar) se retiró el 2026-09-19 con las nueve tools
// sueltas de Fase 2, sus únicas llamantes: `mutate_tasks`/`organize` encolan
// por `runBatch` e invalidan la caché ellas mismas al final del lote (ver
// `runOpsBatch` en `tools/batch.ts`).
//# sourceMappingURL=task-existence.js.map