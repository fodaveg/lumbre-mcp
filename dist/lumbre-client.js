import { randomUUID } from 'node:crypto';
// El tope de bajada es el MISMO que el de subida y vive en un solo sitio
// (`attachments.ts`), que no importa nada de aquí: no hay ciclo.
import { MAX_ATTACHMENT_BYTES } from './attachments.js';
/** Error con el status HTTP adjunto, para poder dar mensajes específicos (401, 429…). */
export class LumbreApiError extends Error {
    status;
    constructor(message, status) {
        super(message);
        this.status = status;
        this.name = 'LumbreApiError';
    }
}
/**
 * Mensaje de un 401 de la API de Lumbre, según `config.authMode` — ÚNICO sitio
 * que decide ese texto (tarea 0a717ae9), reutilizado por `request`,
 * `getAttachment` y `uploadAttachment`. Antes las tres funciones repetían el
 * mismo literal a mano y siempre nombraban `LUMBRE_TOKEN`, aunque el proceso
 * corriera en modo OAuth (`http.ts`, token resuelto de un access token OAuth
 * 2.1 vía `resolveAccessToken`) — ahí ese nombre no significa nada para quien
 * lo lee (nunca configuró ningún `LUMBRE_TOKEN`) ni le dice cómo arreglarlo:
 * el problema no es un env var suyo, es la autorización OAuth con Lumbre.
 */
function unauthorizedApiError(config) {
    if (config.authMode === 'oauth') {
        return new LumbreApiError('La autorización OAuth de Lumbre no es válida o fue revocada. Vuelve a conectar Lumbre desde tu cliente.', 401);
    }
    return new LumbreApiError('Token inválido o no configurado (LUMBRE_TOKEN). Consíguelo en Ajustes → email entrante de Lumbre.', 401);
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
            throw unauthorizedApiError(config);
        }
        if (res.status === 429) {
            throw new LumbreApiError('Demasiadas peticiones a Lumbre; espera un momento y reintenta.', 429);
        }
        const detail = extractMessage(body) ?? (typeof body === 'string' ? body : JSON.stringify(body));
        throw new LumbreApiError(`Lumbre respondió ${res.status}: ${detail}`, res.status);
    }
    return body;
}
/** `notices` de una respuesta de la app: solo las cadenas, `[]` si no hay o
 *  si la forma no encaja (un servidor anterior no manda la clave). */
function readNotices(body) {
    const raw = body.notices;
    return Array.isArray(raw) ? raw.filter((n) => typeof n === 'string') : [];
}
/** `POST /api/ingest`: crea una tarea. La app la encola y la materializa en
 *  el servidor en la misma petición; los dispositivos la reciben al
 *  sincronizar. Devuelve los `notices` para que la tool se los cuente al
 *  modelo (MC1 del audit de paridad: antes se tiraban). */
export async function addTask(config, input) {
    const body = await request(config, '/api/ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input)
    });
    if (!body || typeof body !== 'object' || body.ok !== true) {
        throw new LumbreApiError('Lumbre no confirmó la ingesta (respuesta inesperada).');
    }
    return { notices: readNotices(body) };
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
 * `GET /api/tasks?includeLists=1`: enumera TODOS los proyectos y áreas
 * vivos del usuario, INCLUIDOS los que no tienen ninguna tarea todavía. Sin
 * esto, un contenedor con 0 tareas es invisible para el MCP — `list_tasks` solo
 * puede "verlo" a través de las tareas que contiene, así que un proyecto
 * recién creado (por la app o por `create_list`) no aparece en ningún
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
 * `GET /api/list-links?listId=`: lee los vínculos configurados para UN proyecto o área.
 * Un destino sin vínculos devuelve `[]`; no se consulta ni se expone contenido
 * del destino, incluidos los targets con esquema `obsidian://`.
 */
export async function getListLinks(config, listId) {
    const params = new URLSearchParams({ listId });
    const body = await request(config, `/api/list-links?${params.toString()}`);
    if (!body || typeof body !== 'object' || !Array.isArray(body.links)) {
        throw new LumbreApiError('Lumbre devolvió una respuesta inesperada para /api/list-links?listId=.');
    }
    return body.links;
}
function isListLink(value, listId, url, label) {
    if (!value || typeof value !== 'object')
        return false;
    const link = value;
    return (typeof link.id === 'string' &&
        link.listId === listId &&
        link.kind === 'obsidian' &&
        link.targetKey === url &&
        link.url === url &&
        link.label === label &&
        typeof link.updatedAt === 'string');
}
/** Escritura síncrona e idempotente de un vínculo de nota de Obsidian. */
export async function linkListNote(config, input) {
    const url = input.url.trim();
    const label = input.label.trim();
    const body = await request(config, '/api/list-links', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            type: 'link',
            listId: input.listId,
            target: { kind: 'obsidian', url, label }
        })
    });
    if (!body ||
        typeof body !== 'object' ||
        body.ok !== true ||
        body.type !== 'link' ||
        body.listId !== input.listId ||
        typeof body.deleted !== 'boolean' ||
        !isListLink(body.link, input.listId, url, label)) {
        throw new LumbreApiError('Lumbre no confirmó el vínculo de lista (respuesta inesperada).');
    }
    return body;
}
/** Retirada síncrona e idempotente de un vínculo de nota de Obsidian. */
export async function unlinkListNote(config, input) {
    const url = input.url.trim();
    const label = input.label.trim();
    const body = await request(config, '/api/list-links', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            type: 'unlink',
            listId: input.listId,
            target: { kind: 'obsidian', url, label }
        })
    });
    if (!body ||
        typeof body !== 'object' ||
        body.ok !== true ||
        body.type !== 'unlink' ||
        body.listId !== input.listId ||
        typeof body.deleted !== 'boolean' ||
        typeof body.removed !== 'boolean') {
        throw new LumbreApiError('Lumbre no confirmó la retirada del vínculo de lista (respuesta inesperada).');
    }
    return body;
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
/**
 * Error uniforme para un `listId` que no aparece entre los proyectos/áreas
 * vivos del usuario (`get_list`) — mismo criterio que `taskNotFoundError`:
 * dice SOLO lo que este chequeo sabe (no salió en `GET /api/tasks?includeLists=1`),
 * sin afirmar que "no existe" a secas, y propone el siguiente paso.
 */
export function listNotFoundError(listId) {
    return new Error(`El id ${listId} no está entre los proyectos/áreas que devuelve el servidor para este usuario. ` +
        'Puede que se transcribiera mal (resuélvelo de nuevo con list_lists) o que se haya borrado. ' +
        'No se ha encolado ninguna mutación.');
}
/**
 * Error uniforme cuando `taskId` SÍ existe pero es una subtarea y la tool no
 * aplica ahí — ver `assertTaskUsable`.
 *
 * Solo lo ven ya las ops que siguen CERRADAS a una subtarea, así que el texto
 * nombra el motivo REAL de cada una (residencia) en vez del viejo «es de
 * residencia/agenda/edición»: desde que `op:"update"` acepta un `subtaskId`,
 * decir «edición» era falso y empujaba al modelo a rendirse en un caso que sí
 * funciona. Nombra OPS, no tools (2026-09-19): las nueve tools sueltas de
 * mutación individual ya no existen y citarlas mandaba al modelo a llamar
 * algo que no está en `tools/list`.
 */
export function subtaskNotAllowedError(taskId) {
    return new Error(`El id ${taskId} es de una SUBTAREA y esta operación no aplica ahí: una subtarea no tiene ` +
        'lista ni sección propias — vive en la checklist de su padre (docs/18-que-es-una-tarea.md ' +
        '§2.5, prohibidos en subtarea: `somedayListId`, `sectionId`). Eso deja fuera move_to_list y ' +
        'set_section. Si querías cambiar de lista o de sección lo que la contiene, resuelve el id de ' +
        'la tarea PADRE con list_tasks y opera sobre él. Sobre la SUBTAREA sí valen las ops update ' +
        '(texto, notas, prioridad, hora), reschedule (darle fecha o quitársela con date:null), ' +
        'complete/complete_subtask, cancel y add_subtask de mutate_tasks, y delete de organize. No ' +
        'se ha encolado ninguna mutación.');
}
/**
 * Error uniforme cuando `add_subtask` targetea una tarea que YA es una
 * subtarea (MC2 del audit de paridad, 23 sep 2026): el anidamiento es de UN
 * solo nivel («Naturaleza», docs/18-que-es-una-tarea.md §2.5: «subtarea →
 * padre, nunca subcadena»), una regla DISTINTA de la de residencia que
 * cierra `set_section`/`move_to_list` (por eso no reutiliza
 * `subtaskNotAllowedError`, que hablaría de lista/sección sin venir a
 * cuento). Hasta esa fecha el servidor la descartaba en SILENCIO (`break` en
 * el case `addSubtask` de `inbound-materialize.ts`) y aun así devolvía
 * `applied`; se corta aquí, ANTES de encolar, en vez de fiarse de ese
 * resultado — ver `buildBatchFromOps`.
 */
export function nestedSubtaskNotAllowedError(taskId) {
    return new Error(`El id ${taskId} es de una SUBTAREA: no se le pueden añadir subtareas propias — el anidamiento ` +
        'es de UN solo nivel (docs/18-que-es-una-tarea.md §2.5, «subtarea → padre, nunca subcadena»). ' +
        'Añade la subtarea nueva sobre la tarea PADRE (resuélvela con list_tasks/get_task). No se ha ' +
        'encolado ninguna mutación.');
}
/**
 * Error uniforme cuando `set_section` targetea una tarea que no pertenece a
 * ningún proyecto o área (MC2 del audit de paridad, 23 sep 2026): una
 * sección solo existe DENTRO de una lista, así que asignarla —o quitarla— no
 * tiene destino. Hasta esa fecha el servidor la ignoraba en SILENCIO (`if
 * (!t.somedayListId) break` en el case `setSection` de
 * `inbound-materialize.ts`) y aun así devolvía `applied`; se corta aquí,
 * ANTES de encolar — ver `buildBatchFromOps`.
 */
export function taskWithoutListNotAllowedError(taskId) {
    return new Error(`La tarea ${taskId} no pertenece a ningún proyecto o área, así que no puede tener sección. ` +
        'Muévela primero con move_to_list (organize) y repite set_section. No se ha encolado ninguna ' +
        'mutación.');
}
/**
 * Error uniforme cuando un `update` targetea una SUBTAREA y trae `deadline` y/o
 * `reminders` (MC6, 2026-09-24): `docs/18-que-es-una-tarea.md` §2.5 los lista
 * PROHIBIDOS en subtarea, junto con `somedayListId`/`sectionId`/`recurrence`
 * — una restricción del mundo o un aviso no tiene sentido en una checklist
 * hija de una tarea más pendiente. A diferencia de `set_section`/`add_subtask`
 * (MC2), aquí no hay un `applied` falso medido contra el materializador real:
 * se corta de todos modos, ANTES de encolar, por el mismo motivo que esos dos
 * — el cliente ya sabe de antemano que el campo no aplica al objetivo.
 */
export function subtaskFieldsNotAllowedError(taskId, fields) {
    return new Error(`El id ${taskId} es de una SUBTAREA: ${fields.join('/')} no aplica ahí (docs/18-que-es-una-tarea.md ` +
        '§2.5, prohibidos en subtarea junto con somedayListId/sectionId/recurrence). Manda esos campos ' +
        'en un update aparte sobre la tarea PADRE. No se ha encolado ninguna mutación.');
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
 * CUALQUIER tool de mutación aceptara un `subtaskId`, incluidas las que
 * corromperían la ley de residencia escribiendo `somedayListId`/`sectionId`
 * en la fila de una subtarea.
 *
 * QUÉ CAMBIÓ (2026-09-04): aquella primera versión cerró las cuatro de golpe
 * («residencia/agenda/edición») apoyándose en que `task-ops.moveTask` no
 * tenía guard de `parentId`. Esa premisa YA NO ES CIERTA y el conjunto de
 * campos lo fija ahora un contrato normativo, no esta matriz:
 * `docs/18-que-es-una-tarea.md` §2.5 «Subtareas [DECIDIDO 2 sep 2026]»
 * PERMITE en una subtarea `content`, `notes`, `priority`, `time`, `date`,
 * `daypart`, `done`, `position`/`dayPosition` y tags, y PROHÍBE
 * `somedayListId`, `sectionId`, `reminders`, `deadline` y `recurrence`. Los
 * cinco campos de `update_task` son exactamente cinco de los permitidos, y
 * el guard de residencia vive HOY en la app (`src/lib/sync/task-ops.ts`:
 * `moveTask` solo adopta en la Bandeja si `src.parentId === undefined`,
 * `moveTaskToList` es no-op sobre una subtarea, `reconcileTaskInvariants`
 * solo repara primer nivel) — no aquí.
 *
 * La política, op por op (`TASK_TARGET_ALLOW_SUBTASK`, más abajo, es la tabla
 * viva; desde el 2026-09-19 no hay tools sueltas de mutación, solo ops de
 * `mutate_tasks`/`organize`, y `add_attachment` es la única tool que sigue
 * llamando a `requireTaskExists` por su cuenta):
 *  - `allowSubtask: true` — `complete`, `cancel`, `delete`,
 *    `complete_subtask`, `add_subtask` (no tocan residencia) y, desde
 *    2026-09-04, `update`: sus cinco campos son accidentales PERMITIDOS
 *    en subtarea (§2.5) y su camino en el servidor está medido como
 *    subtask-safe — `inbound-materialize.ts` case `'update'` solo escribe
 *    celdas (`editTaskContent`/`setTaskNotes`/`setTaskPriority`) y, para
 *    `time` sin día, llama a `moveTask` con `date !== null`, la rama que NO
 *    escribe `somedayListId`. También `reschedule`, SIN condición sobre el
 *    payload desde 2026-09-04 (ver más abajo).
 *    `get_task` ni siquiera pasa por aquí, pero acepta un `subtaskId` igual.
 *  - `allowSubtask: false` (default) — `set_section` y `move_to_list`
 *    (escriben `sectionId`/`somedayListId`, PROHIBIDOS en subtarea por §2.5);
 *    y `add_attachment`, que queda fuera del alcance de §2.5 y conserva su
 *    criterio anterior.
 *
 * `reschedule` estuvo CONDICIONADO al payload (sí con fecha, no con
 * `date: null`) mientras `task-ops.unscheduleTask` de la app no tuvo guard de
 * `parentId` y desagendar una subtarea le escribía `somedayListId` y le pisaba
 * `position`. Esa condición de salida se CUMPLIÓ: el guard entró en la app en
 * `a745235a` (desplegado; `unscheduleTask` abre con
 * `if (t.parentId !== undefined) { unscheduleSubtask(store, t); return; }`, y
 * `unscheduleSubtask` solo limpia fecha y hora). El guard vive en
 * `unscheduleTask` misma, que es la que llama el gemelo headless
 * `inbound-materialize.ts` —el camino que recorre una mutación del MCP—, no
 * solo la fachada cliente; por eso `reschedule` pasó a `true` a secas y se
 * retiraron `rescheduleSubtaskDecision`, `subtaskDecisionFor` y
 * `subtaskUnscheduleNotAllowedError`.
 *
 * Los dos cerrados por §2.5 lo están a propósito y en voz alta: hoy
 * `moveTaskToList` se los tragaría como no-op MUDO, así que este error es lo
 * único que le dice al modelo que no pasó nada.
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
            throw unauthorizedApiError(config);
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
        bytes: await readBoundedBody(res, id)
    };
}
/**
 * Lee el cuerpo de la descarga con el tope de `MAX_ATTACHMENT_BYTES` (25 MiB,
 * el mismo límite AUTORITATIVO del servidor al SUBIR, ver `attachments.ts`):
 * si nada puede subir más de 25 MiB, nada legítimo puede bajar más.
 *
 * Hasta ahora era un `res.arrayBuffer()` a pelo, sin tope: el tamaño de lo que
 * se materializa en memoria lo decidía el otro lado de la conexión. Con este
 * conector corriendo en un VPS compartido (`http.ts`), una respuesta enorme
 * —una Lumbre comprometida, un proxy intermedio, un `LUMBRE_BASE_URL` mal
 * puesto apuntando a cualquier otra cosa— se convertía en memoria del proceso.
 *
 * Dos comprobaciones, como en el resto del repo (`readBoundedJson` del
 * backchannel): el `content-length` declarado ANTES de leer nada, y la cuenta
 * real mientras llega, porque esa cabecera puede faltar o mentir. Al pasarse
 * se CANCELA el stream: no se sigue descargando algo que ya se ha descartado.
 */
async function readBoundedBody(res, id) {
    const tooLarge = () => new LumbreApiError(`El adjunto ${id} supera el tope de ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MiB y no se ha descargado.`);
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_BYTES) {
        await res.body?.cancel().catch(() => undefined);
        throw tooLarge();
    }
    if (!res.body)
        return Buffer.alloc(0);
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done)
            break;
        size += value.byteLength;
        if (size > MAX_ATTACHMENT_BYTES) {
            await reader.cancel().catch(() => undefined);
            throw tooLarge();
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks);
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
            throw unauthorizedApiError(config);
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
const MUTATION_OUTCOMES = ['applied', 'noop', 'not-found', 'quarantined', 'queued'];
/**
 * `POST /api/mutations`: encola UNA mutación y la app la drena en el servidor
 * en la misma petición. Devuelve el `outcome` real y los `notices` (MC1 del
 * audit de paridad: hasta el 23 sep 2026 se miraba solo `ok`, que significa
 * «validada y encolada», y un `not-found` salía como éxito).
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
    const outcome = body.outcome;
    return {
        ...(typeof outcome === 'string' && MUTATION_OUTCOMES.includes(outcome)
            ? { outcome: outcome }
            : {}),
        notices: readNotices(body)
    };
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
/** `GET /api/export`: vuelca la cuenta ENTERA (tareas, listas, hábitos…) — ver
 *  el JSDoc del endpoint en el repo principal. `list_habits` solo usa
 *  `habits`/`habitLog` de la respuesta; el resto se ignora tal cual llega
 *  (no se valida su forma, evita acoplar este cliente al resto del export).
 *  MISMA auth que `GET /api/tasks` (token personal o concesión MCP), pero un
 *  límite MÁS ESTRICTO (10/min, ver el JSDoc del endpoint): no la llames en
 *  bucle. `habitLog` ausente (servidor que no lo manda) cae a `[]`, nunca un
 *  error — el listado sigue siendo útil sin las últimas ocurrencias. */
export async function listHabitsExport(config) {
    const body = await request(config, '/api/export');
    if (!body || typeof body !== 'object' || !Array.isArray(body.habits)) {
        throw new LumbreApiError('Lumbre devolvió una respuesta inesperada para /api/export.');
    }
    const habitLogRaw = body.habitLog;
    return {
        habits: body.habits,
        habitLog: Array.isArray(habitLogRaw) ? habitLogRaw : []
    };
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
 *
 * Devuelve también los `notices` (MC1 del audit de paridad, 23 sep 2026:
 * hasta entonces se devolvía solo `results` y los avisos se perdían).
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
    return { results: body.results, notices: readNotices(body) };
}
/**
 * `allowSubtask` por `op`, SOLO para las 11 variantes cuyo target es una
 * TAREA (`taskId`/`subtaskId`) — mismo criterio, MISMOS valores, que la
 * matriz que aplica `requireTaskExists` (ver el JSDoc de
 * `assertTaskUsable` para el porqué completo). Las ops de PROYECTO/ÁREA/SECCIÓN
 * (`remove_section`/`create_list`/`nest_list`/`rename_list`/`remove_list`/
 * `set_list_notes`) y
 * `add_task` NO están aquí: no targetean una tarea, así que no comprueban
 * existencia. La PRESENCIA de una clave es la señal de "esta op
 * necesita comprobación de existencia" (ver `collectExistenceCheckIds`/
 * `buildBatchFromOps`).
 *
 * Quién decide cada valor: el contrato `docs/18-que-es-una-tarea.md` §2.5
 * («Subtareas [DECIDIDO 2 sep 2026]»), no esta tabla — una op vale sobre una
 * subtarea si los campos que escribe están entre los ACCIDENTALES PERMITIDOS
 * ahí. `update` pasó a `true` el 2026-09-04 porque sus cinco campos
 * (`content`/`notes`/`tags`/`priority`/`time`) son cinco de los permitidos, y
 * `reschedule` ese mismo día (`date` también es de los permitidos) en cuanto
 * la app cerró su único agujero, el desagendar sin guard de `parentId` —
 * `task-ops.unscheduleTask`, arreglado en `a745235a`, ver `assertTaskUsable`.
 * `set_section` y `move_to_list` siguen en `false` porque escriben
 * `sectionId`/`somedayListId`, PROHIBIDOS. El porqué completo, con el camino
 * de servidor medido de cada una, en el JSDoc de `assertTaskUsable`.
 *
 * `restore` targetea una tarea y aun así NO está aquí, a propósito: su
 * objetivo es una tarea BORRADA, que `findTasksByIds` nunca devuelve, así que
 * la comprobación de existencia la rechazaría siempre. Viaja sin comprobar y
 * el servidor decide (`applied`, o `noop` + aviso `restore-purged`).
 *
 * MC6 (2026-09-24): `set_waiting`/`clear_waiting` entran a `true` — «esperando»
 * (`waitingUntil`/`waitingFor`) es un estado de tarea sin guard de `parentId`
 * en `waiting-ops.ts` (repo principal), ni prohibido por §2.5. `register_habit`
 * NO está aquí: su objetivo es un HÁBITO, no una tarea (mismo motivo que
 * `restore` para la comprobación de existencia, pero aquí porque el id ni
 * siquiera es de la tabla de tareas). `set_list_kind` tampoco: targetea un
 * proyecto/área, como `nest_list`/`rename_list`/`remove_list`.
 *
 * La tabla es la ÚNICA fuente de la decisión: la leen `buildBatchFromOps`
 * (para el `allowSubtask` que pasa a `assertTaskUsable`) y
 * `collectExistenceCheckIds` (solo por la PRESENCIA de la clave: qué ops
 * necesitan comprobación de existencia). Ninguna op depende ya del PAYLOAD;
 * si alguna volviera a depender, no se refina aquí a mano en cada consumidor
 * —eso es justo lo que abre un agujero por una superficie y no por la otra—
 * sino en una función compartida por las dos, como fue
 * `rescheduleSubtaskDecision` hasta el 2026-09-04.
 */
const TASK_TARGET_ALLOW_SUBTASK = {
    complete: true,
    cancel: true,
    delete: true,
    add_subtask: true,
    complete_subtask: true,
    update: true,
    reschedule: true,
    set_section: false,
    move_to_list: false,
    set_waiting: true,
    clear_waiting: true
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
/** Tags de desarrollo (tarea 2db86c2d, 2026-09-24): el estado va como marca
 *  `@estado` al final de `content` (`skills/lumbre/references/
 *  development.md`), NUNCA como tag estructurado — un `#wip` en `tags` crea
 *  una ETIQUETA, no un estado, y el mecánico de este flujo (`lumbre-tagger`)
 *  lee la marca en `content`, no `tags`. Case-insensitive. */
const RESERVED_STATUS_TAGS = ['acked', 'wip', 'done', 'not-done'];
/** Tags de `tags` que colisionan con `RESERVED_STATUS_TAGS`, o `[]` si
 *  `tags` es `undefined` o ninguno colisiona. Pura — compartida por `add_task`
 *  (tool suelta, `tools/tasks.ts`) y las ops `add_task`/`update` de
 *  `mutate_tasks` (`localValidationError`, más abajo). */
export function reservedStatusTagsIn(tags) {
    if (!tags)
        return [];
    return tags.filter((t) => RESERVED_STATUS_TAGS.includes(t.toLowerCase()));
}
/** Mensaje de rechazo para `reservedStatusTagsIn`, con los tags concretos que
 *  colisionaron (preservando cómo los escribió el llamante, no la forma
 *  normalizada). */
export function reservedStatusTagsError(tags) {
    return (`tags: ${tags.join(', ')} no vale${tags.length > 1 ? 'n' : ''} ahí — el estado de desarrollo va como ` +
        '@marca al final de content, nunca en tags (crearía una etiqueta, no un estado).');
}
/** Validación local (sin red) de una op, previa a la comprobación de
 *  existencia — mismos guards que hacían `update_task`/`move_to_list`
 *  ANTES de llamar a `requireTaskExists` en `index.ts` (ver esas tools):
 *  `update` necesita al menos un campo a cambiar; `move_to_list` necesita
 *  `listId` o `list`; `add_task`/`update` rechazan un tag de desarrollo en
 *  `tags` (tarea 2db86c2d). `null` si la op pasa (nada que reportar aquí). */
function localValidationError(op) {
    if (op.op === 'add_task' || op.op === 'update') {
        const reserved = reservedStatusTagsIn(op.tags);
        if (reserved.length > 0)
            return `${op.op}: ${reservedStatusTagsError(reserved)}`;
    }
    if (op.op === 'update') {
        if (op.content === undefined &&
            op.notes === undefined &&
            op.tags === undefined &&
            op.priority === undefined &&
            op.time === undefined &&
            op.recurrence === undefined &&
            op.deadline === undefined &&
            op.reminders === undefined) {
            return ('update: indica al menos un campo a cambiar (content, notes, tags, priority, time, ' +
                'recurrence, deadline o reminders).');
        }
    }
    if (op.op === 'move_to_list' && op.listId === undefined && op.list === undefined) {
        return 'move_to_list: indica `listId` o `list` (la lista destino).';
    }
    return null;
}
/** `MutateTasksOp` → `BatchOp` — MISMA traducción, campo a campo, que
 *  construían las tools individuales para su `mutateTask`/`addTask` antes de
 *  retirarse (2026-09-19): cada rama de este `switch` es el equivalente de
 *  una de ellas. `create_list` usa el `listId` PRE-GENERADO
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
        case 'restore':
            return { type: 'mutate', taskId: op.taskId, kind: 'restore', payload: {} };
        case 'update':
            return {
                type: 'mutate',
                taskId: op.taskId,
                kind: 'update',
                payload: {
                    ...(op.content !== undefined ? { content: op.content } : {}),
                    ...(op.notes !== undefined ? { notes: op.notes } : {}),
                    ...(op.tags !== undefined ? { tags: op.tags } : {}),
                    ...(op.priority !== undefined ? { priority: priorityToLevel(op.priority) } : {}),
                    ...(op.time !== undefined ? { time: op.time } : {}),
                    // Ya fusionada con la regla vigente en `buildBatchFromOps`
                    // (`mergeRecurrencePatch`), así que aquí es una regla entera o `null`.
                    ...(op.recurrence !== undefined ? { recurrence: op.recurrence } : {}),
                    ...(op.deadline !== undefined ? { deadline: op.deadline } : {}),
                    ...(op.reminders !== undefined ? { reminders: op.reminders } : {})
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
        case 'set_waiting':
            return {
                type: 'mutate',
                taskId: op.taskId,
                kind: 'setWaiting',
                payload: { until: op.until, ...(op.for !== undefined ? { for: op.for } : {}) }
            };
        case 'clear_waiting':
            return { type: 'mutate', taskId: op.taskId, kind: 'clearWaiting', payload: {} };
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
                    ...(op.icon !== undefined ? { icon: op.icon } : {}),
                    ...(op.listKind !== undefined ? { listKind: op.listKind } : {})
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
        case 'set_list_notes':
            return {
                type: 'mutate',
                taskId: op.listId,
                kind: 'setListNotes',
                payload: {
                    notes: op.notes,
                    ...(op.revive !== undefined ? { revive: op.revive } : {})
                }
            };
        case 'set_list_kind':
            return {
                type: 'mutate',
                taskId: op.listId,
                kind: 'setListKind',
                payload: { listKind: op.listKind }
            };
        case 'register_habit':
            return {
                type: 'mutate',
                taskId: op.habitId,
                kind: 'registerHabit',
                payload: op.date !== undefined ? { date: op.date } : {}
            };
    }
}
/**
 * Fusiona el cambio PARCIAL de regla que pide el modelo con la regla VIGENTE
 * de la tarea y devuelve la regla ENTERA que hay que mandar (la app la
 * sustituye completa: `setTaskRecurrence` no fusiona). Pura, sin red.
 *
 * Por qué existe (MC3 del audit de paridad, 23 sep 2026): mandar solo lo que
 * el modelo cambió borraba el resto, y sin `streak` la app desengancha el
 * hábito. Ahora un campo no enviado se conserva; se quita solo si el parche lo
 * pide de forma explícita (`null` en `byWeekday`/`until`/`count`,
 * `streak: false`, `mode: 'calendar'`).
 *
 * `current` distingue dos ausencias: `null` = la tarea no tiene regla (el
 * parche tiene que traer `freq`, y se usa tal cual) y `undefined` = no se sabe
 * (servidor anterior a exponer `recurrence`): ahí solo se acepta un parche con
 * `freq`, sabiendo que lo no enviado no se puede conservar.
 *
 * `byWeekday` se descarta si la regla resultante no es semanal de calendario:
 * la app lo ignora en ese caso, y dejarlo haría creer que sigue vigente.
 */
export function mergeRecurrencePatch(patch, current) {
    const base = current ?? {};
    const merged = { ...base, ...patch };
    const freq = merged.freq;
    if (freq === undefined) {
        return {
            error: current === undefined
                ? 'no se pudo leer la regla actual de la tarea; manda la regla completa, con freq.'
                : 'la tarea no repite; para ponerle regla indica al menos freq.'
        };
    }
    const rule = { freq };
    if (merged.mode === 'afterCompletion')
        rule.mode = 'afterCompletion';
    if (merged.interval !== undefined)
        rule.interval = merged.interval;
    if (merged.byWeekday !== undefined &&
        merged.byWeekday !== null &&
        merged.byWeekday.length > 0 &&
        freq === 'weekly' &&
        rule.mode !== 'afterCompletion') {
        rule.byWeekday = merged.byWeekday;
    }
    if (merged.until !== undefined && merged.until !== null)
        rule.until = merged.until;
    if (merged.count !== undefined && merged.count !== null)
        rule.count = merged.count;
    if (merged.streak === true)
        rule.streak = true;
    return { rule };
}
/** Campos de `update` distintos de `recurrence` (ver CX7 en `buildBatchFromOps`). */
const UPDATE_EXTRA_FIELDS = ['content', 'notes', 'tags', 'priority', 'time', 'deadline', 'reminders'];
/** Id de la semilla si `task` es una OCURRENCIA de una serie (su `seriesId`
 *  apunta a otra fila); `null` si es la semilla o no es de ninguna serie.
 *  Mismo criterio que `isSeriesOccurrence` en el repo principal. */
function seriesSeedIdOf(task) {
    const seriesId = task?.seriesId;
    return seriesId && seriesId !== task.id ? seriesId : null;
}
/**
 * Regla contra la que fusionar un parche parcial de `recurrence` sobre
 * `taskId` (CX6): la de su SEMILLA si es una ocurrencia y la semilla está en
 * `existing`, la de la propia fila en otro caso. Sin semilla legible (borrada)
 * se usa la de la fila: la app no escribe una regla nueva en una serie sin
 * semilla viva, así que el resultado no puede pisar nada.
 */
function currentSeriesRule(existing, taskId) {
    const row = existing.get(taskId);
    const seedId = seriesSeedIdOf(row);
    const seed = seedId === null ? undefined : existing.get(seedId);
    return seed !== undefined ? seed.recurrence : row?.recurrence;
}
/**
 * Ids de SEMILLA que `mutate_tasks` debe leer (con archivadas incluidas) antes
 * de `buildBatchFromOps` (CX6): los de las ocurrencias con un parche parcial
 * de `recurrence` cuya semilla no está ya en `existing`. Deduplicados.
 */
export function collectSeriesSeedIds(ops, existing) {
    const ids = new Set();
    for (const op of ops) {
        if (op.op !== 'update' || op.recurrence === undefined || op.recurrence === null)
            continue;
        const seedId = seriesSeedIdOf(existing.get(op.taskId));
        if (seedId !== null && !existing.has(seedId))
            ids.add(seedId);
    }
    return [...ids];
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
        // `undefined` = la op no targetea una tarea (lista/sección/`add_task`):
        // no comprueba existencia. Mismo criterio, MISMA tabla, que
        // `collectExistenceCheckIds`.
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
        // MC2 del audit de paridad (23 sep 2026): dos ramas del materializador de
        // la app descartan la op en SILENCIO y aun así devuelven `applied`
        // (`inbound-materialize.ts`, cases `setSection`/`addSubtask`) — se
        // rechaza aquí, ANTES de encolar, en los dos casos que el cliente ya
        // puede saber de antemano que no van a aplicarse (ver los JSDoc de
        // `taskWithoutListNotAllowedError`/`nestedSubtaskNotAllowedError`). No
        // toca la cola ni el drenaje: los sigue tratando tal como responden hoy.
        if (op.op === 'set_section' && !existing.get(op.taskId)?.somedayListId) {
            skipped.push({ index, error: taskWithoutListNotAllowedError(op.taskId).message });
            return;
        }
        if (op.op === 'add_subtask' && existing.get(op.taskId)?.parentId) {
            skipped.push({ index, error: nestedSubtaskNotAllowedError(op.taskId).message });
            return;
        }
        // MC6: `deadline`/`reminders` son PROHIBIDOS en una subtarea (§2.5) —
        // a diferencia del resto de campos de `update` (accidentales permitidos,
        // ver `TASK_TARGET_ALLOW_SUBTASK`), estos dos no tienen camino de
        // servidor "subtask-safe" documentado. Se rechaza aquí, ANTES de
        // encolar, en vez de dejar que el materializador escriba una celda que
        // el contrato de tarea prohíbe.
        if (op.op === 'update' && (op.deadline !== undefined || op.reminders !== undefined)) {
            if (existing.get(op.taskId)?.parentId) {
                const fields = ['deadline', 'reminders'].filter((f) => op[f] !== undefined);
                skipped.push({ index, error: subtaskFieldsNotAllowedError(op.taskId, fields).message });
                return;
            }
        }
        // CX7: sobre una tarea ARCHIVADA la app solo aplica el apagado de la
        // regla (`clearArchivedSeedRecurrence`, antes de su guard de tarea
        // viva); el resto de campos del mismo `update` nunca se aplicaba y el
        // informe los daba por hechos. Se rechaza la op entera, nombrando los
        // campos, para que el modelo los mande aparte si la desarchiva.
        if (op.op === 'update' && op.recurrence === null) {
            const target = existing.get(op.taskId);
            const extra = UPDATE_EXTRA_FIELDS.filter((field) => op[field] !== undefined);
            if (target?.archivedAt && extra.length > 0) {
                skipped.push({
                    index,
                    error: `update: la tarea ${op.taskId} está archivada y sobre ella solo se aplica ` +
                        `recurrence:null; manda recurrence:null a solas (sobran: ${extra.join(', ')}).`
                });
                return;
            }
        }
        // La app SUSTITUYE la regla entera en un `update`; el modelo manda un
        // cambio parcial. Se fusiona aquí con la regla VIGENTE, para que un
        // campo no enviado (`streak`, `byWeekday`…) no se pierda por omisión.
        // La vigente es la de la SEMILLA (CX6): la app escribe la regla de una
        // ocurrencia en toda su serie (`setSeriesRuleFromOccurrence`), y una
        // ocurrencia CERRADA conserva la copia de la regla que tenía al cerrarse.
        if (op.op === 'update' && op.recurrence !== undefined && op.recurrence !== null) {
            const merged = mergeRecurrencePatch(op.recurrence, currentSeriesRule(existing, op.taskId));
            if ('error' in merged) {
                skipped.push({ index, error: `update: ${merged.error}` });
                return;
            }
            batchOps.push(translateOp({ ...op, recurrence: merged.rule }));
            originalIndexes.push(index);
            return;
        }
        batchOps.push(translateOp(op));
        originalIndexes.push(index);
    });
    return { batchOps, originalIndexes, skipped };
}
/**
 * Detecta si `batchOps` (YA traducidas, ver `buildBatchFromOps`) tiene
 * dependencia intra-lote — una op `ingest` cuyo `task.listId` coincide con el
 * `taskId` de una op `mutate`/`createList` del MISMO array — y, si la hay,
 * reparte `batchOps` en DOS fases (`mutate` primero, `ingest` después) en vez
 * de una. Pura, sin red: separada de la llamada real (`runBatch` × 1 o 2, en
 * `index.ts`) para poder testearla sin mockear `fetch`.
 *
 * Sin dependencia (incluida una op `ingest` con un `listId` de una lista YA
 * EXISTENTE, que no se crea en este lote): `split: false`, una sola fase con
 * `batchOps` tal cual — CERO cambio de comportamiento ni coste extra de red
 * frente a antes de este fix.
 *
 * Con dependencia: fase 1 = TODAS las ops `mutate` del lote (no solo los
 * `createList` de los que depende alguna alta: el resto de mutaciones viaja
 * igual, no hay motivo para retrasarlas), en su orden original; fase 2 = TODAS
 * las ops `ingest` del lote, en su orden original. Qué altas de la fase 2
 * sobreviven de verdad (una vez se sabe si su `createList` salió `ok`) lo
 * decide `filterPhase2AfterPhase1`, DESPUÉS de mandar la fase 1 — este
 * planificador no toca red, así que no puede saberlo todavía.
 */
export function planBatchPhases(batchOps, originalIndexes) {
    // `taskId` de cada `create_list` del lote — la lista que "nace" en esta
    // misma llamada.
    const createdListIds = new Set();
    for (const op of batchOps) {
        if (op.type === 'mutate' && op.kind === 'createList')
            createdListIds.add(op.taskId);
    }
    const dependents = [];
    if (createdListIds.size > 0) {
        batchOps.forEach((op, i) => {
            if (op.type === 'ingest' && op.task.listId && createdListIds.has(op.task.listId)) {
                dependents.push({ index: originalIndexes[i], listId: op.task.listId });
            }
        });
    }
    if (dependents.length === 0) {
        return { split: false, phases: [{ ops: batchOps, originalIndexes }], dependents: [] };
    }
    const mutatePhase = { ops: [], originalIndexes: [] };
    const ingestPhase = { ops: [], originalIndexes: [] };
    batchOps.forEach((op, i) => {
        const phase = op.type === 'mutate' ? mutatePhase : ingestPhase;
        phase.ops.push(op);
        phase.originalIndexes.push(originalIndexes[i]);
    });
    return { split: true, phases: [mutatePhase, ingestPhase], dependents };
}
/**
 * Segundo paso del reparto, YA con el resultado real de la fase 1 (`runBatch`
 * de `plan.phases[0].ops`): decide qué ops de la fase 2 (`plan.phases[1]`) se
 * mandan de verdad y cuáles se descartan por depender de un `create_list` que
 * NO salió `ok` — nunca se manda una alta huérfana con fecha de HOY (el
 * síntoma del incidente 071553). Pura, sin red: separada de `mutate_tasks`
 * para poder testearla sin mockear `fetch`. Con `plan.split` en `false`
 * devuelve todo vacío — no hay fase 2 que filtrar.
 *
 * El mensaje de cada descarte cita el índice ORIGINAL de la op `create_list`
 * causante (`ver el fallo de la op [N]`), para que el modelo pueda leer su
 * error concreto en el mismo informe sin tener que adivinar cuál era. Si DOS
 * `create_list` del lote comparten el mismo `listId` (raro, pero el schema no
 * lo impide), la promesa solo se da por cumplida si TODAS salieron `ok`; el
 * mensaje cita la que falló con el índice ORIGINAL más bajo — antes (code
 * review 🔴) un `Map` simple se quedaba con la ÚLTIMA, y podía citar una op
 * equivocada o dar la lista por creada con una hermana rota.
 */
export function filterPhase2AfterPhase1(plan, phase1Results) {
    if (!plan.split || plan.phases.length < 2) {
        return { ops: [], originalIndexes: [], skipped: [] };
    }
    const [phase1, phase2] = plan.phases;
    // `listId` → TODAS las entradas {índice ORIGINAL, ok} de los `create_list`
    // de la fase 1 que la prometen (normalmente una sola).
    const entriesByListId = new Map();
    phase1.ops.forEach((op, i) => {
        if (op.type === 'mutate' && op.kind === 'createList') {
            const entries = entriesByListId.get(op.taskId) ?? [];
            entries.push({ originalIndex: phase1.originalIndexes[i], ok: phase1Results[i]?.ok === true });
            entriesByListId.set(op.taskId, entries);
        }
    });
    const dependentListIdByIndex = new Map(plan.dependents.map((d) => [d.index, d.listId]));
    const ops = [];
    const originalIndexes = [];
    const skipped = [];
    phase2.ops.forEach((op, i) => {
        const origIndex = phase2.originalIndexes[i];
        const listId = dependentListIdByIndex.get(origIndex);
        if (listId !== undefined) {
            const entries = entriesByListId.get(listId) ?? [];
            const allOk = entries.length > 0 && entries.every((e) => e.ok);
            if (!allOk) {
                const firstFailing = entries
                    .filter((e) => !e.ok)
                    .sort((a, b) => a.originalIndex - b.originalIndex)[0];
                skipped.push({
                    index: origIndex,
                    error: `la lista ${listId} no se pudo crear en este lote` +
                        (firstFailing !== undefined ? ` (ver el fallo de la op [${firstFailing.originalIndex}])` : '') +
                        '; la tarea no se ha creado'
                });
                return;
            }
        }
        ops.push(op);
        originalIndexes.push(origIndex);
    });
    return { ops, originalIndexes, skipped };
}
/**
 * Filtra de `batchOps` (recién traducidas por `buildBatchFromOps`, ANTES de
 * `planBatchPhases`) las ops `ingest` cuyo `task.listId` referencia un
 * `create_list` del MISMO lote que YA falló sin llegar a mandarse
 * (`brokenListIds`, ver `BrokenListPromise`) — nunca las manda, en NINGUNA
 * fase, y las reporta como fallo con su índice ORIGINAL, citando la op
 * `create_list` causante.
 *
 * El agujero que esto cierra (🔴, revisión sobre el commit que introdujo
 * `planBatchPhases`): ese planificador solo ve `batchOps`, que es la SALIDA
 * de `buildBatchFromOps` — un `create_list` descartado por forma inválida
 * (p. ej. `{op:'create_list', listId:'L'}` sin `name`) nunca entra ahí, así
 * que `planBatchPhases` no encontraba ninguna dependencia y el `add_task`
 * dependiente viajaba SOLO, en una única petición, con la lista inexistente
 * — exactamente el síntoma del incidente 071553, solo que disparado por un
 * `create_list` mal formado en vez de uno bien formado que aún no se ha
 * mandado. La promesa de un `listId` (que el lote pretende crear ESA lista)
 * la hace la FORMA de la op (`op:'create_list'`, con ese `listId`), no que
 * haya sobrevivido a la validación — así que este filtro corre ANTES,
 * sobre `batchOps`+`brokenListIds` (que el llamante construye a partir de
 * los descartes por forma y por validación local, ANTES de traducir), y dejar
 * a `planBatchPhases` la parte que SÍ puede resolver por red (fase 1).
 *
 * Pura, sin red: separada de `mutate_tasks` (`index.ts`, que construye
 * `brokenListIds`) para poder testearla sin mockear `fetch`.
 */
export function excludeIngestForBrokenListPromises(batchOps, originalIndexes, brokenListIds) {
    if (brokenListIds.size === 0) {
        return { batchOps, originalIndexes, skipped: [] };
    }
    const filteredOps = [];
    const filteredIndexes = [];
    const skipped = [];
    batchOps.forEach((op, i) => {
        if (op.type === 'ingest' && op.task.listId) {
            const broken = brokenListIds.get(op.task.listId);
            if (broken !== undefined) {
                skipped.push({
                    index: originalIndexes[i],
                    error: `la lista ${op.task.listId} no se pudo crear en este lote ` +
                        `(ver el fallo de la op [${broken.index}]); la tarea no se ha creado`
                });
                return;
            }
        }
        filteredOps.push(op);
        filteredIndexes.push(originalIndexes[i]);
    });
    return { batchOps: filteredOps, originalIndexes: filteredIndexes, skipped };
}
//# sourceMappingURL=lumbre-client.js.map