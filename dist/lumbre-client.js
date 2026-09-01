import { randomUUID } from 'node:crypto';
/** Error con el status HTTP adjunto, para poder dar mensajes específicos (401, 429…). */
export class LumbreApiError extends Error {
    status;
    constructor(message, status) {
        super(message);
        this.status = status;
        this.name = 'LumbreApiError';
    }
}
/** Cuerpo de error `{ message }` que produce `error()` de SvelteKit, si acaso. */
function extractMessage(body) {
    if (body && typeof body === 'object' && 'message' in body) {
        const m = body.message;
        if (typeof m === 'string')
            return m;
    }
    return null;
}
async function request(config, path, init = {}) {
    const url = `${config.baseUrl.replace(/\/$/, '')}${path}`;
    let res;
    try {
        res = await fetch(url, {
            ...init,
            headers: {
                authorization: `Bearer ${config.token}`,
                ...init.headers
            }
        });
    }
    catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        throw new LumbreApiError(`No se pudo conectar con Lumbre en ${config.baseUrl} (${cause}). ¿Es correcto LUMBRE_BASE_URL?`);
    }
    const contentType = res.headers.get('content-type') ?? '';
    const body = contentType.includes('application/json')
        ? await res.json().catch(() => null)
        : await res.text().catch(() => null);
    if (!res.ok) {
        if (res.status === 401) {
            throw new LumbreApiError('Token inválido o no configurado (LUMBRE_TOKEN). Consíguelo en Ajustes → email entrante de Lumbre.', 401);
        }
        if (res.status === 429) {
            throw new LumbreApiError('Demasiadas peticiones a Lumbre; espera un momento y reintenta.', 429);
        }
        const detail = extractMessage(body) ?? (typeof body === 'string' ? body : JSON.stringify(body));
        throw new LumbreApiError(`Lumbre respondió ${res.status}: ${detail}`, res.status);
    }
    return body;
}
/** `POST /api/ingest`: encola una tarea nueva (el cliente de Lumbre la materializa al sincronizar). */
export async function addTask(config, input) {
    const body = await request(config, '/api/ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input)
    });
    if (!body || typeof body !== 'object' || body.ok !== true) {
        throw new LumbreApiError('Lumbre no confirmó la ingesta (respuesta inesperada).');
    }
}
/** `GET /api/tasks`: lee las tareas del usuario dueño del token. */
export async function listTasks(config, input) {
    const params = new URLSearchParams();
    if (input.scope)
        params.set('scope', input.scope);
    if (input.days !== undefined)
        params.set('days', String(input.days));
    if (input.list)
        params.set('list', input.list);
    if (input.section)
        params.set('section', input.section);
    if (input.includeDone)
        params.set('includeDone', 'true');
    if (input.includeArchived)
        params.set('includeArchived', 'true');
    if (input.limit)
        params.set('limit', String(input.limit));
    if (input.notesQuery)
        params.set('notes', input.notesQuery);
    const qs = params.toString();
    const body = await request(config, `/api/tasks${qs ? `?${qs}` : ''}`);
    if (!Array.isArray(body)) {
        throw new LumbreApiError('Lumbre devolvió una respuesta inesperada para /api/tasks.');
    }
    return body;
}
/**
 * `GET /api/tasks?includeLists=1`: enumera TODAS las listas de "Algún día"
 * vivas del usuario, INCLUIDAS las que no tienen ninguna tarea todavía. Sin
 * esto, una lista con 0 tareas es invisible para el MCP — `list_tasks` solo
 * puede "ver" una lista a través de las tareas que contiene, así que una
 * lista recién creada (por la app o por `create_list`) no aparece en ningún
 * sitio hasta que se le añade la primera tarea (bug real, b00303b5).
 */
export async function listLists(config) {
    const body = await request(config, '/api/tasks?includeLists=1');
    if (!body || typeof body !== 'object' || !Array.isArray(body.lists)) {
        throw new LumbreApiError('Lumbre devolvió una respuesta inesperada para /api/tasks?includeLists=1.');
    }
    return body.lists;
}
/**
 * Busca UNA tarea por `id` vía `GET /api/tasks?id=` (lookup directo, no
 * listado — ver ese endpoint en el repo principal) y la devuelve, o
 * `undefined` si no existe/no es del usuario del token. A diferencia del
 * viejo enfoque (barrer `scope=all` con `list_tasks` y filtrar aquí), este
 * endpoint busca entre TODAS las tareas vivas del usuario — de primer nivel
 * Y SUBTAREAS —, así que:
 *
 * - No hay tope de cuenta (antes una cuenta con más de 500 tareas vivas de
 *   primer nivel podía dar un falso "no existe" para un id real fuera de esa
 *   ventana; el lookup por `id` no pagina).
 * - Encuentra el id de una SUBTAREA, que `list_tasks`/`scope=all` nunca
 *   exponen — precondición para poder comprobar la existencia de una
 *   subtarea antes de completarla (ver `complete_subtask` en `index.ts`).
 *
 * `opts.includeArchived` reenvía `includeArchived=true`, la única excepción
 * a los filtros que normalmente ignora el lookup por id. Sin indicarlo, las
 * archivadas siguen sin aparecer (comportamiento histórico).
 *
 * La usan tanto `get_task` (para devolver la tarea completa, con sus
 * subtareas si las tiene) como el chequeo de existencia de las tools de
 * mutación (ver `requireTaskExists` en `index.ts`): un `taskId` mal
 * transcrito (bug real, ver la tarea que motiva este fichero) hoy se
 * encolaba igual y se perdía en silencio al drenar.
 */
export async function findTaskById(config, taskId, opts = {}) {
    const params = new URLSearchParams({ id: taskId });
    if (opts.includeArchived)
        params.set('includeArchived', 'true');
    const body = await request(config, `/api/tasks?${params.toString()}`);
    if (!Array.isArray(body)) {
        throw new LumbreApiError('Lumbre devolvió una respuesta inesperada para /api/tasks?id=.');
    }
    return body[0];
}
/** Tope de ids por petición que impone `GET /api/tasks?ids=` en el servidor
 *  (ver su JSDoc en el repo principal) — `findTasksByIds` trocea por encima
 *  de esto en vez de mandar un `ids=` que el servidor rechazaría. */
const MAX_IDS_PER_REQUEST = 200;
/**
 * Busca VARIAS tareas de golpe vía `GET /api/tasks?ids=` (feature batch —
 * espejo de `findTaskById`, pero para un LOTE): UNA sola petición (o varias
 * en TROCEADO de `MAX_IDS_PER_REQUEST` si `ids` se pasa de ese tope, ver
 * abajo) → un `Map` por `id`, en vez de una `findTaskById` por cada
 * `taskId`/`subtaskId` a comprobar. Pensado tanto para `mutate_tasks`
 * (`index.ts`, existencia de todo el lote en una sola llamada de red — o
 * pocas, si se trocea) como para la FASE 2 de `list_tasks({notes:'auto'})`
 * (traer el texto íntegro solo de las notas que la fase 1 decidió íntegras,
 * ver `notesQuery`/el bloque de `list_tasks` en `index.ts`). Ids sin
 * coincidencia (no existen, ajenas al token, o repetidos) simplemente no
 * tienen entrada en el `Map` — el llamante lo distingue con `.get(id)` →
 * `undefined`, mismo criterio que `findTaskById` devolviendo `undefined`.
 * `ids: []` no llama a la red (`Map` vacío directo).
 *
 * `notesQuery` (mismo significado que `ListTasksInput.notesQuery`): sin
 * indicar, el servidor sirve notas completas (comportamiento de siempre) —
 * la fase 2 de `list_tasks` lo manda explícito (`'full'`) por claridad, pese
 * a que ya sea el default del servidor. `includeArchived` se usa en esa misma
 * fase cuando el listado inicial incluyó archivadas: sin propagarlo, una nota
 * de una tarea archivada desaparecería entre `notes=length` y `notes=full`.
 */
export async function findTasksByIds(config, ids, opts = {}) {
    if (ids.length === 0)
        return new Map();
    const map = new Map();
    for (let i = 0; i < ids.length; i += MAX_IDS_PER_REQUEST) {
        const chunk = ids.slice(i, i + MAX_IDS_PER_REQUEST);
        const params = new URLSearchParams({ ids: chunk.join(',') });
        if (opts.notesQuery)
            params.set('notes', opts.notesQuery);
        if (opts.includeArchived)
            params.set('includeArchived', 'true');
        const body = await request(config, `/api/tasks?${params.toString()}`);
        if (!Array.isArray(body)) {
            throw new LumbreApiError('Lumbre devolvió una respuesta inesperada para /api/tasks?ids=.');
        }
        for (const t of body)
            map.set(t.id, t);
    }
    return map;
}
/**
 * Error uniforme para un `taskId`/`subtaskId` que no aparece entre las
 * tareas visibles del usuario — ver `assertTaskUsable`.
 *
 * El mensaje dice SOLO lo que este chequeo sabe de verdad: que el id no
 * salió en `GET /api/tasks?id=`. NO afirma que la tarea "no existe" a
 * secas — `findTaskById` (ver su JSDoc) filtra las tareas ARCHIVADAS
 * incluso pidiendo `includeDone=true`, así que un id de una tarea archivada
 * cae exactamente por esta misma rama, y "no existe" sería falso en ese
 * caso. Antes decía justo eso y empujaba a la hipótesis equivocada
 * ("¿se transcribió mal?"): dos sesiones dieron por hecho que unas tareas
 * NUNCA habían existido, cuando estaban archivadas. `includeArchived` ya se
 * puede pedir en `list_tasks`/`get_task`; el mensaje propone ese siguiente
 * paso sin afirmar que el id sea inexistente.
 */
export function taskNotFoundError(taskId) {
    return new Error(`El id ${taskId} no está entre las tareas (ni subtareas) que devuelve el servidor para este ` +
        'usuario. Puede que se transcribiera mal (resuélvelo de nuevo con list_tasks), que sea una ' +
        'subtarea (usa get_task sobre la tarea padre) o que esté ARCHIVADA: reintenta list_tasks/' +
        'get_task con includeArchived:true. No se ha encolado ninguna mutación.');
}
/** Error uniforme cuando `taskId` SÍ existe pero es una subtarea y la tool no
 *  aplica ahí — ver `assertTaskUsable`. */
export function subtaskNotAllowedError(taskId) {
    return new Error(`El id ${taskId} es de una SUBTAREA: esta operación no aplica a una subtarea (es de residencia/` +
        'agenda/edición, pensada para tareas de primer nivel). Si querías completarla, cancelarla o ' +
        'borrarla, usa complete_subtask/cancel_task/delete_task; si querías operar sobre la tarea ' +
        'PADRE, resuelve su id con list_tasks. No se ha encolado ninguna mutación.');
}
/**
 * Decide si una tool puede operar sobre `task` (YA resuelto por
 * `findTaskById`, o `undefined` si no existe): lanza `taskNotFoundError` si
 * no existe, o `subtaskNotAllowedError` si es una subtarea (`parentId`
 * informado) y `opts.allowSubtask` es `false` (default). Función PURA — sin
 * red — a propósito: separada de `requireTaskExists` (`index.ts`, el fino
 * wrapper que la conecta con `findTaskById`) para poder testear la matriz de
 * decisión (qué tool acepta/rechaza un `subtaskId`) sin mockear `fetch` — ver
 * `lumbre-client.test.ts`.
 *
 * `allowSubtask` (default `false`, code-review 🟠 — hallazgo tras la 1ª
 * versión de esta feature): ampliar `findTaskById` para que resuelva
 * subtareas (precondición de `complete_subtask`) dejaba, de rebote, que
 * CUALQUIER tool de mutación aceptara un `subtaskId` — incluidas
 * `reschedule_task`/`move_to_list` (`task-ops.moveTask`/
 * `reassignTaskProject`, SIN guard de `parentId`), que corromperían la ley de
 * residencia (docs/20-contrato-lista.md, ver `reconcileTaskInvariants` en
 * `task-ops.ts`) escribiendo `date`/`somedayListId` en la fila de una
 * subtarea. La política, tool por tool (ver cada `requireTaskExists(...)` en
 * `index.ts`):
 *  - `allowSubtask: true` — `complete_task`, `cancel_task`, `delete_task`,
 *    `complete_subtask`, `add_subtask` (no tocan residencia/agenda; `get_task`
 *    ni siquiera pasa por aquí, pero acepta un `subtaskId` igual).
 *  - `allowSubtask: false` (default) — `update_task`, `reschedule_task`,
 *    `set_section`, `move_to_list` (residencia/agenda/edición: no aplican a
 *    una subtarea).
 */
export function assertTaskUsable(task, taskId, opts = {}) {
    if (!task)
        throw taskNotFoundError(taskId);
    if (!opts.allowSubtask && task.parentId)
        throw subtaskNotAllowedError(taskId);
}
/**
 * `GET /api/attachments/:id`: descarga los bytes de un adjunto propio. Mismo
 * token que el resto (`Authorization: Bearer`); ese endpoint solo sirve el
 * adjunto si pertenece al dueño del token (anti-IDOR server-side, ver el
 * endpoint en el repo principal). No pasa por `request()` porque la respuesta
 * no es JSON.
 */
export async function getAttachment(config, id) {
    const url = `${config.baseUrl.replace(/\/$/, '')}/api/attachments/${id}`;
    let res;
    try {
        res = await fetch(url, { headers: { authorization: `Bearer ${config.token}` } });
    }
    catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        throw new LumbreApiError(`No se pudo conectar con Lumbre en ${config.baseUrl} (${cause}). ¿Es correcto LUMBRE_BASE_URL?`);
    }
    if (!res.ok) {
        if (res.status === 401) {
            throw new LumbreApiError('Token inválido o no configurado (LUMBRE_TOKEN). Consíguelo en Ajustes → email entrante de Lumbre.', 401);
        }
        if (res.status === 404) {
            throw new LumbreApiError(`Adjunto ${id} no encontrado (o no pertenece al dueño del token).`, 404);
        }
        if (res.status === 429) {
            throw new LumbreApiError('Demasiadas peticiones a Lumbre; espera un momento y reintenta.', 429);
        }
        throw new LumbreApiError(`Lumbre respondió ${res.status} al pedir el adjunto ${id}.`, res.status);
    }
    return {
        contentType: res.headers.get('content-type') ?? 'application/octet-stream',
        bytes: Buffer.from(await res.arrayBuffer())
    };
}
/**
 * `DELETE /api/attachments/:id`: retira un adjunto propio. El endpoint aplica
 * el borrado de metadata antes de responder y oculta por igual un id ajeno o
 * inexistente (404 anti-IDOR). Usa `request()` porque la respuesta sí es JSON
 * (`{ ok: true }`); solo especializa el 404 para que el modelo sepa que debe
 * volver a resolver el id desde `get_task`, sin afirmar si existía para otra
 * cuenta.
 */
export async function deleteAttachment(config, id) {
    let body;
    try {
        body = await request(config, `/api/attachments/${id}`, { method: 'DELETE' });
    }
    catch (err) {
        if (err instanceof LumbreApiError && err.status === 404) {
            throw new LumbreApiError(`Adjunto ${id} no encontrado (o no pertenece al dueño del token).`, 404);
        }
        throw err;
    }
    if (!body || typeof body !== 'object' || body.ok !== true) {
        throw new LumbreApiError('Lumbre no confirmó el borrado del adjunto (respuesta inesperada).');
    }
}
/**
 * Cabecera con el mime REAL del adjunto (`x-lumbre-content-type`) — MISMA
 * constante, mismo nombre, que `ATTACHMENT_CONTENT_TYPE_HEADER` en el repo
 * principal (`src/lib/attachment-upload-parse.ts:43`, leída en
 * `src/routes/api/attachments/+server.ts:177`; desplegado, comprobado contra
 * prod el 2026-08-27: `content-type: application/octet-stream` +
 * `x-lumbre-content-type: image/png` → 200 con `"mime":"image/png"`). Ver el
 * JSDoc de `uploadAttachment` para el porqué de mandar el mime aquí y no en
 * `Content-Type`.
 */
export const ATTACHMENT_CONTENT_TYPE_HEADER = 'x-lumbre-content-type';
/**
 * `POST /api/attachments?taskId=<uuid>`: sube los bytes de un fichero y lo
 * deja adjunto y ENLAZADO a esa tarea — a diferencia de `addTask`/`mutateTask`
 * (encolan, se aplican al sincronizar), este endpoint escribe la metadata al
 * CRDT él mismo antes de responder 200: cuando responde, el adjunto YA está
 * visible, sin esperar a ningún sync (ver `add_attachment` en `index.ts`).
 *
 * No pasa por `request()`: el cuerpo no es JSON (son los bytes crudos del
 * fichero) y la cabecera del nombre necesita ir URL-encodeada, nunca en la
 * query (acabaría en los access-logs). `Content-Type` viaja SIEMPRE fijo a
 * `application/octet-stream`, y el mime real de `input.mime` va aparte, en
 * `ATTACHMENT_CONTENT_TYPE_HEADER` — hasta 2026-08-26 `Content-Type` llevaba
 * el mime real (degradado a mano en `mimeForFilename` para los cuatro que
 * SvelteKit intercepta, ver abajo); desde que el servidor sabe leer
 * `x-lumbre-content-type` (comprobado contra prod, ver el JSDoc de la
 * constante) ya no hace falta esa degradación NI arriesgarse a que un mime
 * futuro que no esté en la lista cuele un 403 mudo: `application/octet-stream`
 * nunca es, por construcción, ninguno de los cuatro Content-Type que
 * `is_form_content_type` (`@sveltejs/kit` 2.66.0, `src/utils/http.js:93`,
 * llamada desde `src/runtime/server/respond.js:83`; el cuarto sale de
 * `src/runtime/form-utils.js:69`) intercepta ANTES de nuestro handler cuando
 * la petición no trae `Origin` (el caso de este MCP, que corre fuera del
 * navegador) — ese sigue siendo el guardarraíl real (ver el test que lo
 * comprueba en `lumbre-client.test.ts`), solo cambia DÓNDE viaja el mime.
 */
export async function uploadAttachment(config, input) {
    const params = new URLSearchParams({ taskId: input.taskId });
    const url = `${config.baseUrl.replace(/\/$/, '')}/api/attachments?${params.toString()}`;
    let res;
    try {
        res = await fetch(url, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${config.token}`,
                'content-type': 'application/octet-stream',
                [ATTACHMENT_CONTENT_TYPE_HEADER]: input.mime,
                'x-lumbre-filename': encodeURIComponent(input.filename)
            },
            // `Buffer<ArrayBufferLike>` vs el `BodyInit` de los tipos DOM de fetch:
            // Buffer ES un Uint8Array en runtime (Node lo implementa así), el cast
            // es solo para el checker de tipos.
            body: input.bytes
        });
    }
    catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        throw new LumbreApiError(`No se pudo conectar con Lumbre en ${config.baseUrl} (${cause}). ¿Es correcto LUMBRE_BASE_URL?`);
    }
    const contentType = res.headers.get('content-type') ?? '';
    const body = contentType.includes('application/json')
        ? await res.json().catch(() => null)
        : await res.text().catch(() => null);
    if (!res.ok) {
        if (res.status === 401) {
            throw new LumbreApiError('Token inválido o no configurado (LUMBRE_TOKEN). Consíguelo en Ajustes → email entrante de Lumbre.', 401);
        }
        if (res.status === 404) {
            throw new LumbreApiError(extractMessage(body) ?? 'La tarea no existe, está borrada o archivada.', 404);
        }
        if (res.status === 413) {
            // DOS causas distintas (fichero > 25 MiB, o cuota agregada de la cuenta
            // agotada) — el servidor ya las distingue en su mensaje, así que se
            // propaga TAL CUAL en vez de generalizar a "demasiado grande".
            throw new LumbreApiError(extractMessage(body) ?? 'Lumbre rechazó el adjunto (413): demasiado grande, o cuota agotada.', 413);
        }
        if (res.status === 429) {
            throw new LumbreApiError('Demasiadas peticiones a Lumbre; espera un momento y reintenta.', 429);
        }
        const detail = extractMessage(body) ?? (typeof body === 'string' ? body : JSON.stringify(body));
        throw new LumbreApiError(`Lumbre respondió ${res.status} al subir el adjunto: ${detail}`, res.status);
    }
    if (!body || typeof body !== 'object' || typeof body.id !== 'string') {
        throw new LumbreApiError('Lumbre no confirmó la subida del adjunto (respuesta inesperada).');
    }
    return body;
}
/**
 * `POST /api/sync/flush`: fuerza el flush del sync ANTES de leer (bug:
 * ventana de debounce del persister — ver ese endpoint en el repo
 * principal). Sin cuerpo. Útil justo antes de un `listTasks` cuando importa
 * ver el estado más reciente posible; NO recupera cambios de un cliente que
 * esté offline y nunca los haya mandado por WS (límite server-side).
 */
export async function refreshSync(config) {
    const body = await request(config, '/api/sync/flush', { method: 'POST' });
    if (!body || typeof body !== 'object' || body.ok !== true) {
        throw new LumbreApiError('Lumbre no confirmó el flush del sync (respuesta inesperada).');
    }
}
/**
 * `POST /api/mutations`: encola una mutación sobre una tarea EXISTENTE (el
 * cliente de Lumbre la aplica al sincronizar — no es instantáneo). Espejo de
 * `addTask`.
 */
export async function mutateTask(config, input) {
    const body = await request(config, '/api/mutations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input)
    });
    if (!body || typeof body !== 'object' || body.ok !== true) {
        throw new LumbreApiError('Lumbre no confirmó la mutación (respuesta inesperada).');
    }
}
/**
 * `GET /api/brl/:date?format=json`: entradas del registro de un día CON SU ID.
 *
 * Es la única forma de resolver el id que necesitan `update_brl_entry`/
 * `delete_brl_entry`: la representación por defecto de ese endpoint es la nota
 * completa en Markdown, que deliberadamente NO lleva ids (es la nota que lee el
 * usuario, no un formato de máquina). 403 si el add-on BRL está apagado en la
 * cuenta.
 */
export async function listBrlEntries(config, date) {
    const body = await request(config, `/api/brl/${date}?format=json`);
    if (!body || typeof body !== 'object' || !Array.isArray(body.entries)) {
        throw new LumbreApiError('Lumbre devolvió una respuesta inesperada para /api/brl/:date.');
    }
    return body.entries;
}
/** Traduce `'p1'..'p4'` (de cara al modelo) al nivel numérico que espera
 *  `/api/mutations`/`/api/batch` para `kind: 'update'`: `p4` = quitar la
 *  prioridad (`null`). Vive aquí (no en `index.ts`) porque `translateOp`
 *  (más abajo) también la necesita, y `lumbre-client.ts` no depende de
 *  `index.ts` (evita el ciclo). */
export function priorityToLevel(p) {
    return p === 'p4' ? null : Number(p[1]);
}
/**
 * `POST /api/batch`: encola TODAS las `ops` de golpe (el servidor las valida
 * y encola una por una, éxito PARCIAL — una op inválida no tumba las demás,
 * ver el JSDoc del endpoint) y drena UNA sola vez. Espejo de `addTask`/
 * `mutateTask`, pero para un LOTE entero en vez de una operación suelta — es
 * la vía PREFERENTE para `mutate_tasks` (`index.ts`) cuando hay varias
 * operaciones seguidas: 1 petición + 1 drenaje en vez de N.
 */
export async function runBatch(config, ops) {
    const body = await request(config, '/api/batch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ops })
    });
    if (!body ||
        typeof body !== 'object' ||
        body.ok !== true ||
        !Array.isArray(body.results)) {
        throw new LumbreApiError('Lumbre no confirmó el batch (respuesta inesperada).');
    }
    return body.results;
}
/**
 * `allowSubtask` por `op`, SOLO para las 9 variantes cuyo target es una
 * TAREA (`taskId`/`subtaskId`) — mismo criterio, MISMOS valores, que la
 * matriz de `requireTaskExists` en `index.ts` (ver el JSDoc de
 * `assertTaskUsable` para el porqué completo). Las ops de LISTA/SECCIÓN
 * (`remove_section`/`create_list`/`nest_list`/`rename_list`/`remove_list`) y
 * `add_task` NO están aquí: no targetean una tarea, así que no comprueban
 * existencia (mismo criterio que sus tools individuales, que tampoco llaman
 * `requireTaskExists`). La PRESENCIA de una clave es la señal de "esta op
 * necesita comprobación de existencia" (ver `collectExistenceCheckIds`/
 * `buildBatchFromOps`).
 */
const TASK_TARGET_ALLOW_SUBTASK = {
    complete: true,
    cancel: true,
    delete: true,
    add_subtask: true,
    complete_subtask: true,
    update: false,
    reschedule: false,
    set_section: false,
    move_to_list: false
};
/** `taskId`/`subtaskId` de una op que targetea una tarea, o `undefined` si es
 *  de lista/sección/creación (ver `TASK_TARGET_ALLOW_SUBTASK`). */
function targetIdOf(op) {
    if ('taskId' in op)
        return op.taskId;
    if ('subtaskId' in op)
        return op.subtaskId;
    return undefined;
}
/**
 * Ids que `mutate_tasks` debe resolver con `findTasksByIds` ANTES de mandar
 * el lote — deduplicados (varias ops pueden targetear la misma tarea). Pura,
 * sin red: separada de la llamada real para poder testearla sola.
 */
export function collectExistenceCheckIds(ops) {
    const ids = new Set();
    for (const op of ops) {
        if (TASK_TARGET_ALLOW_SUBTASK[op.op] === undefined)
            continue;
        const id = targetIdOf(op);
        if (id !== undefined)
            ids.add(id);
    }
    return [...ids];
}
/** Validación local (sin red) de una op, previa a la comprobación de
 *  existencia — mismos guards que hacían `update_task`/`move_to_list`
 *  ANTES de llamar a `requireTaskExists` en `index.ts` (ver esas tools):
 *  `update` necesita al menos un campo a cambiar; `move_to_list` necesita
 *  `listId` o `list`. `null` si la op pasa (nada que reportar aquí). */
function localValidationError(op) {
    if (op.op === 'update') {
        if (op.content === undefined &&
            op.notes === undefined &&
            op.priority === undefined &&
            op.time === undefined) {
            return 'update: indica al menos un campo a cambiar (content, notes, priority o time).';
        }
    }
    if (op.op === 'move_to_list' && op.listId === undefined && op.list === undefined) {
        return 'move_to_list: indica `listId` o `list` (la lista destino).';
    }
    return null;
}
/** `MutateTasksOp` → `BatchOp` — MISMA traducción, campo a campo, que cada
 *  tool individual construye para su `mutateTask`/`addTask` (ver `index.ts`:
 *  `complete_task`, `update_task`, `create_list`… — cada rama de este
 *  `switch` es su equivalente). `create_list` usa el `listId` PRE-GENERADO
 *  por el llamante si vino (encadenado intra-lote), o genera uno con
 *  `randomUUID()` si no — ver el JSDoc de `MutateTasksOp['create_list']`. */
function translateOp(op) {
    switch (op.op) {
        case 'add_task': {
            const { op: _discard, ...task } = op;
            return { type: 'ingest', task };
        }
        case 'complete':
            return {
                type: 'mutate',
                taskId: op.taskId,
                kind: 'complete',
                payload: { done: op.done ?? true }
            };
        case 'cancel':
            return {
                type: 'mutate',
                taskId: op.taskId,
                kind: 'cancel',
                payload: { cancelled: op.cancelled ?? true }
            };
        case 'update':
            return {
                type: 'mutate',
                taskId: op.taskId,
                kind: 'update',
                payload: {
                    ...(op.content !== undefined ? { content: op.content } : {}),
                    ...(op.notes !== undefined ? { notes: op.notes } : {}),
                    ...(op.priority !== undefined ? { priority: priorityToLevel(op.priority) } : {}),
                    ...(op.time !== undefined ? { time: op.time } : {})
                }
            };
        case 'reschedule':
            return { type: 'mutate', taskId: op.taskId, kind: 'reschedule', payload: { date: op.date } };
        case 'delete':
            return { type: 'mutate', taskId: op.taskId, kind: 'delete', payload: {} };
        case 'set_section':
            return {
                type: 'mutate',
                taskId: op.taskId,
                kind: 'setSection',
                payload: { section: op.section }
            };
        case 'move_to_list':
            return {
                type: 'mutate',
                taskId: op.taskId,
                kind: 'moveToList',
                payload: op.listId !== undefined ? { listId: op.listId } : { list: op.list }
            };
        case 'add_subtask':
            return {
                type: 'mutate',
                taskId: op.taskId,
                kind: 'addSubtask',
                payload: { subtasks: op.subtasks }
            };
        case 'complete_subtask':
            return {
                type: 'mutate',
                taskId: op.subtaskId,
                kind: 'complete',
                payload: { done: op.done ?? true }
            };
        case 'remove_section':
            return {
                type: 'mutate',
                taskId: op.sectionId,
                kind: 'removeSection',
                payload: { sectionId: op.sectionId }
            };
        case 'create_list':
            // `listId` PRE-GENERADO por el llamante (encadenado intra-lote, ver el
            // JSDoc de `MutateTasksOp['create_list']`) si vino; si no, uno nuevo —
            // MISMO criterio que la tool individual `create_list`.
            return {
                type: 'mutate',
                taskId: op.listId ?? randomUUID(),
                kind: 'createList',
                payload: {
                    name: op.name,
                    ...(op.color !== undefined ? { color: op.color } : {}),
                    ...(op.icon !== undefined ? { icon: op.icon } : {})
                }
            };
        case 'nest_list':
            return {
                type: 'mutate',
                taskId: op.listId,
                kind: 'nestList',
                payload: { parentId: op.parentId }
            };
        case 'rename_list':
            return {
                type: 'mutate',
                taskId: op.listId,
                kind: 'renameList',
                payload: { name: op.name }
            };
        case 'remove_list':
            return { type: 'mutate', taskId: op.listId, kind: 'removeList', payload: {} };
    }
}
/**
 * Núcleo PURO (sin red) de `mutate_tasks`: valida localmente cada op
 * (`localValidationError`) y, si targetea una tarea, comprueba su existencia
 * contra `existing` (`assertTaskUsable`, con el `allowSubtask` que le toque —
 * ver `TASK_TARGET_ALLOW_SUBTASK`); lo que pasa ambos filtros se traduce a
 * `BatchOp` (`translateOp`). Separado de la llamada real (`findTasksByIds` +
 * `runBatch`, en `index.ts`) para poder testearlo sin mockear `fetch` — mismo
 * patrón que `assertTaskUsable`/`lumbre-client.test.ts`.
 */
export function buildBatchFromOps(ops, existing) {
    const batchOps = [];
    const originalIndexes = [];
    const skipped = [];
    ops.forEach((op, index) => {
        const localError = localValidationError(op);
        if (localError !== null) {
            skipped.push({ index, error: localError });
            return;
        }
        const allowSubtask = TASK_TARGET_ALLOW_SUBTASK[op.op];
        if (allowSubtask !== undefined) {
            const targetId = targetIdOf(op);
            try {
                assertTaskUsable(existing.get(targetId), targetId, { allowSubtask });
            }
            catch (err) {
                skipped.push({ index, error: err instanceof Error ? err.message : String(err) });
                return;
            }
        }
        batchOps.push(translateOp(op));
        originalIndexes.push(index);
    });
    return { batchOps, originalIndexes, skipped };
}
//# sourceMappingURL=lumbre-client.js.map