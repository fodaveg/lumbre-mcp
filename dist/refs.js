import { findTasksByIds, listLists } from './lumbre-client.js';
import { formatNoteMarker } from './notes.js';
/**
 * Resolución EN VIVO de las referencias `[[task:ID|Etiqueta]]` /
 * `[[list:ID|Etiqueta]]` que pueden aparecer en el texto o en las notas de una
 * tarea (Feature C de la app, ver `src/lib/markdown.ts` del repo principal).
 *
 * POR QUÉ: la app las resuelve contra el store en cada render — enseña el
 * título ACTUAL y pinta un chip roto si el destino ya no existe —, pero el MCP
 * reenviaba la ETIQUETA CONGELADA del momento en que se creó el enlace. Si la
 * tarea referenciada se renombraba, se completaba o se borraba, el agente que
 * leía por MCP veía texto viejo y no tenía forma de enterarse; una referencia
 * rota era indistinguible de una viva, que es el caso peligroso.
 *
 * Reglas (mismas que la app):
 * - El **id es la verdad**; la etiqueta guardada es una copia caducada. Si
 *   difieren, gana el título actual.
 * - Una referencia cuyo destino ya no existe se declara **ROTA** con su id, en
 *   vez de enseñar una etiqueta que ya no corresponde a nada.
 * - El **id sigue visible** en la salida: quien lee suele querer actuar sobre
 *   esa tarea (completarla, reprogramarla…) sin una segunda llamada.
 *
 * Y una regla PROPIA del MCP, que la app no necesita (David, 2026-07-26): una
 * referencia no es decoración, es la señal de que ahí hay contexto que el
 * lector debe ir a buscar. Por eso la referencia resuelta anuncia además si la
 * tarea referenciada **tiene notas**, con el MISMO marcador `✎N ↻DDmmm` que
 * usan las notas sin leer (`formatNoteMarker`, `notes.ts`): así se decide con
 * datos si merece la pena el `get_task`, en vez de a ciegas. Lo que NO se hace
 * es volcar la nota referenciada dentro del listado — sería recursivo, dispara
 * el tamaño de la salida y hay ciclos posibles (A referencia a B y B a A).
 *
 * COSTE: como mucho **dos** peticiones extra por lote, y solo si el lote tiene
 * referencias — una `GET /api/tasks?ids=` con TODOS los ids de tarea de golpe
 * (nunca una por referencia) y, únicamente si además hay referencias a listas,
 * una `GET /api/tasks?includeLists=1` (no hay forma de resolver un id de lista
 * por `?ids=`, que solo mira tareas). Sin referencias, cero llamadas. El
 * tamaño/fecha de las notas viene YA en la respuesta de `?ids=`, así que el
 * marcador sale a coste cero.
 */
/** Token de referencia — MISMA expresión que `REF_TOKEN` en `src/lib/markdown.ts`
 *  del repo de la app: el id restringido a un charset seguro, la etiqueta
 *  cualquier cosa que no sea `]` ni salto de línea. Global: se usa con
 *  `matchAll`/`replace`, siempre desde el principio del texto (`lastIndex` se
 *  reinicia solo en esos dos usos). */
const REF_TOKEN = /\[\[(task|list):([A-Za-z0-9_-]+)\|([^\]\n]*)\]\]/g;
/** Uuid v4-ish: lo que acepta `GET /api/tasks?ids=` (`isValidUuid` en el repo
 *  principal). Un id de referencia con otra forma NO se manda: un solo elemento
 *  no-uuid haría que la API respondiera 400 y se quedarían sin resolver TODAS
 *  las referencias del lote, no solo la rara. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Tope de `?ids=` por petición (`MAX_IDS` del endpoint). Por encima de esto
 *  habría que partir en varias peticiones — no se hace: los ids que sobran se
 *  quedan SIN COMPROBAR y se pintan como tales, nunca como rotos (declararlos
 *  rotos sería mentir, y "roto" es justo la señal que tiene que ser fiable). */
export const MAX_REF_IDS = 200;
/** Resolución vacía: ni referencias ni comprobaciones. Es lo que devuelve
 *  `resolveRefs` cuando el lote no tiene ninguna referencia (cero llamadas) y
 *  lo que usan por defecto los pintores que no reciben resolución. */
export function emptyRefResolution() {
    return {
        tasks: new Map(),
        lists: new Map(),
        checkedTasks: new Set(),
        checkedLists: new Set(),
        refTaskIds: [],
        refListIds: []
    };
}
/**
 * Ids referenciados en `texts`, deduplicados y en orden de aparición. Pura, sin
 * red: es lo que decide si hay que llamar a la API y con qué ids. Textos
 * `null`/`undefined`/vacíos se ignoran (una tarea sin notas no aporta nada).
 */
export function collectRefIds(texts) {
    const taskIds = new Set();
    const listIds = new Set();
    for (const text of texts) {
        if (!text)
            continue;
        for (const match of text.matchAll(REF_TOKEN)) {
            const [, kind, id] = match;
            if (kind === 'task')
                taskIds.add(id);
            else
                listIds.add(id);
        }
    }
    return { taskIds: [...taskIds], listIds: [...listIds] };
}
/**
 * Resuelve TODAS las referencias de `texts` contra el estado real, con el
 * mínimo de peticiones posible (ver el coste en la cabecera del módulo):
 *
 * - Sin referencias → cero llamadas (`emptyRefResolution`).
 * - Con referencias a tareas → UNA `findTasksByIds` con todos los ids uuid de
 *   golpe (hasta `MAX_REF_IDS`).
 * - Con referencias a listas → UNA `listLists` (trae TODAS las listas vivas del
 *   usuario, así que resuelve cualquier número de referencias a lista).
 *
 * BEST-EFFORT de principio a fin: si una de las dos peticiones falla (red, 429,
 * token…) NO se propaga el error — un listado de tareas no puede caerse porque
 * una nota tuviera un enlace. Los ids de esa parte quedan sin comprobar y se
 * pintan «sin resolver», que es la única lectura honesta (nunca «rota»).
 */
export async function resolveRefs(config, texts) {
    const { taskIds, listIds } = collectRefIds(texts);
    const resolution = emptyRefResolution();
    resolution.refTaskIds = taskIds;
    resolution.refListIds = listIds;
    if (taskIds.length === 0 && listIds.length === 0)
        return resolution;
    if (taskIds.length > 0) {
        // Solo uuids y solo hasta el tope del endpoint: un id con otra forma o de
        // más devolvería 400 y dejaría sin resolver TODO el lote.
        const askable = taskIds.filter((id) => UUID_RE.test(id)).slice(0, MAX_REF_IDS);
        if (askable.length > 0) {
            try {
                resolution.tasks = await findTasksByIds(config, askable);
                for (const id of askable)
                    resolution.checkedTasks.add(id);
            }
            catch {
                // Best-effort: sin comprobar → «sin resolver», nunca «rota».
            }
        }
    }
    if (listIds.length > 0) {
        try {
            const lists = await listLists(config);
            for (const l of lists)
                resolution.lists.set(l.id, l.name);
            // `listLists` trae TODAS las listas vivas, así que cualquier id de lista
            // referenciado queda comprobado: si no está en el mapa, es que ya no
            // existe (rota), no que no se haya mirado.
            for (const id of listIds)
                resolution.checkedLists.add(id);
        }
        catch {
            // Best-effort — ver arriba.
        }
    }
    return resolution;
}
/** Estado de una tarea de un vistazo, con el mismo vocabulario que el resto del
 *  MCP. `cancelled` solo llega si la API lo expone (ver el JSDoc de
 *  `LumbreTask.cancelled`); mientras no lo haga, una tarea cancelada viaja como
 *  `done: true` y se lee «hecha». */
function taskStateLabel(t) {
    if (t.cancelled)
        return 'cancelada';
    return t.done ? 'hecha' : 'pendiente';
}
/** Sufijo `✎N ↻DDmmm` si la tarea referenciada TIENE nota, o `''` si no —
 *  el dato con el que se decide si vale la pena traérsela con `get_task`. El
 *  texto de la nota NUNCA se vuelca aquí (ver la cabecera del módulo). */
function noteHint(t) {
    const trimmed = t.notes?.trim() ?? '';
    if (trimmed === '')
        return '';
    return ` ${formatNoteMarker(trimmed.length, t.notesUpdatedAt ?? null)}`;
}
/** Aplana las referencias que pueda traer DENTRO el título de una tarea ya
 *  resuelta: se sustituyen por su etiqueta guardada, en texto plano. Sin esto,
 *  el título inyectado podría reintroducir un `[[task:…]]` en la salida y
 *  parecer una referencia sin resolver (o invitar a una resolución recursiva,
 *  que es justo lo que no se hace — ver la cabecera del módulo). */
function flattenRefTokens(text) {
    return text.replace(REF_TOKEN, (_m, _kind, _id, label) => label);
}
/**
 * Sustituye cada referencia de `text` por su forma RESUELTA. Pura (la red ya la
 * hizo `resolveRefs`) y sin coste si el texto no lleva ninguna referencia — el
 * `replace` no encuentra nada y devuelve el mismo string.
 *
 * Formato (compacto a propósito: la salida de un MCP se paga en cada
 * respuesta), un solo patrón para los cinco casos:
 *
 * ```
 * →tarea[pendiente] "Título ACTUAL" ✎573 ↻24jul id:<uuid>
 * →tarea[hecha] "Título ACTUAL" id:<uuid>          (sin notas → sin marcador)
 * →tarea[ROTA] id:<uuid>                            (ya no existe)
 * →tarea[sin resolver] id:<uuid>                    (no se pudo comprobar)
 * →lista "Nombre ACTUAL" id:<uuid>
 * ```
 *
 * La etiqueta guardada en la nota NO se pinta nunca: o hay título actual (que
 * la sustituye, aunque difiera) o la referencia está rota, y entonces enseñar
 * la etiqueta vieja es exactamente lo que se quería dejar de hacer.
 */
export function renderRefs(text, resolution) {
    if (!resolution)
        return text;
    return text.replace(REF_TOKEN, (_m, kind, id) => {
        if (kind === 'task') {
            if (!resolution.checkedTasks.has(id))
                return `→tarea[sin resolver] id:${id}`;
            const task = resolution.tasks.get(id);
            if (!task)
                return `→tarea[ROTA] id:${id}`;
            const title = flattenRefTokens(task.content);
            return `→tarea[${taskStateLabel(task)}] "${title}"${noteHint(task)} id:${id}`;
        }
        if (!resolution.checkedLists.has(id))
            return `→lista[sin resolver] id:${id}`;
        const name = resolution.lists.get(id);
        if (name === undefined)
            return `→lista[ROTA] id:${id}`;
        return `→lista "${flattenRefTokens(name)}" id:${id}`;
    });
}
/** Ver `RefCounts`. Pura; cuenta ids DISTINTOS, no ocurrencias (una misma
 *  tarea referenciada tres veces es un solo destino que leer). */
export function refCounts(resolution) {
    let live = 0;
    let broken = 0;
    let unresolved = 0;
    let withNotes = 0;
    for (const id of resolution.refTaskIds) {
        if (!resolution.checkedTasks.has(id))
            unresolved++;
        else {
            const task = resolution.tasks.get(id);
            if (!task)
                broken++;
            else {
                live++;
                if ((task.notes?.trim() ?? '') !== '')
                    withNotes++;
            }
        }
    }
    for (const id of resolution.refListIds) {
        if (!resolution.checkedLists.has(id))
            unresolved++;
        else if (resolution.lists.has(id))
            live++;
        else
            broken++;
    }
    return {
        live,
        broken,
        unresolved,
        withNotes,
        total: resolution.refTaskIds.length + resolution.refListIds.length
    };
}
//# sourceMappingURL=refs.js.map