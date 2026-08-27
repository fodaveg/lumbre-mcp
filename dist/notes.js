import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
/** `true` si `content` lleva el tag de estado `@done` (matchea también
 *  `#done` — la convención de Lumbre migró de `@tag` a `#tag` libre en julio
 *  2026, ver `MEMORY.md` del usuario). Delimitado por límites de palabra
 *  (espacio/inicio/fin de línea) para no colar `@doneish` ni una palabra que
 *  simplemente contenga "done". `@done`/`#done` es el estado en el que David
 *  escribe su feedback ("trabajo del agente hecho, pendiente de mi revisión"),
 *  así que su nota siempre sale íntegra en modo `auto` — capa 1, SIN estado
 *  (no depende del fichero de huellas, ver más abajo). Exportada con test
 *  propio (ver `notes.test.ts`) para que un cambio de convención futuro no
 *  mate esta regla en silencio.
 */
export function hasDoneTag(content) {
    return /(?:^|\s)[@#]done(?=\s|$)/i.test(content);
}
/** `true` si la tarea tiene una nota no vacía. Con el texto presente (`notes`,
 *  modo `full` de siempre, o un servidor VIEJO que ignoró `notes=length`)
 *  decide igual que siempre `formatTask`/`formatTaskFull`: por su longitud
 *  tras `trim`. Sin texto (`notes: null` — fase 1 de `list_tasks({notes:
 *  'auto'})` contra un servidor NUEVO, ver `ListTasksInput.notesQuery`) cae a
 *  `notesLength`, que trae la MISMA información sin el texto (ver su JSDoc en
 *  `lumbre-client.ts`) — antes de esto, una tarea con nota en fase 1 se leía
 *  como "sin nota" (bug: `t.notes` vale `null` ahí aunque SÍ tenga nota) y se
 *  quedaba fuera de `computeAutoNotesRender`. */
export function hasNotes(t) {
    if (t.notes != null)
        return t.notes.trim() !== '';
    return typeof t.notesLength === 'number' && t.notesLength > 0;
}
/** `Date` válida a partir de un `notesUpdatedAt` (ISO) que puede venir
 *  ausente/`null`/mal formado — nunca lanza, `undefined` en cualquier caso
 *  dudoso (mismo criterio "desconocido → trátalo como si no lo tuviera" que
 *  pide el JSDoc de `LumbreTask.notesUpdatedAt`). */
function parseNotesUpdatedAt(value) {
    if (typeof value !== 'string' || value.trim() === '')
        return undefined;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? undefined : d;
}
/** Ventana de bootstrap por defecto (horas) de la capa 2 en modo `auto` — ver
 *  el JSDoc de `decideAutoNoteRender`. Medido sobre las notas reales de David
 *  (2026-07-25, `GET /api/tasks?scope=all`, 121/182 tareas con nota) para
 *  elegir el default: 6h → 22 notas tocadas, **24h → 31 notas / 32k chars**,
 *  3d → 62/51k, 7d → 82/69k, 14d → 123/93k (7 días ya es casi todo el
 *  backlog — inviable como "íntegra por defecto"). 24h es el punto en el que
 *  "la toqué hoy o ayer, seguro que aplica" sigue siendo verdad sin arrastrar
 *  medio backlog la primera vez que corre el MCP en una máquina nueva. */
export const DEFAULT_NOTES_RECENT_HOURS = 24;
/**
 * Decide cómo debe salir la nota de UNA tarea en modo `auto` — función PURA,
 * sin I/O (separada de `computeAutoNotesRender`, que sí toca el fichero de
 * huellas, para poder testear la matriz de decisión sin mockear el
 * filesystem ni el reloj). Dos capas, en este orden:
 *
 * 1. Por TAG, sin estado: `@done`/`#done` en `content` → siempre íntegra.
 * 2. Por MARCA (`notesUpdatedAt`, desde 2026-07-25 — antes era un hash local
 *    del texto, ver el histórico de este fichero): si hay `previous` (la
 *    última huella vista de esta tarea) y `notesUpdatedAt` es POSTERIOR a
 *    `previous.u` → íntegra (comparación EXACTA, sin ventana: la marca ya lo
 *    dice con precisión). Si es igual o anterior (o desconocida) → marcador.
 *
 *    Sin `previous` (nunca vista, o vista con una versión más vieja del MCP
 *    sin este fichero, o con el formato legado `{h,n}` — ver
 *    `readSeenEntry`): no hay huella contra la que comparar, así que cae al
 *    BOOTSTRAP — íntegra si `notesUpdatedAt` cae dentro de
 *    `opts.windowHours` (default `DEFAULT_NOTES_RECENT_HOURS`) desde
 *    `opts.now`, si no marcador. Esta ventana es SOLO para el arranque (la
 *    primera vez que el MCP ve una tarea, o en una máquina nueva sin
 *    fichero de huellas): en cuanto hay una huella previa, la comparación de
 *    arriba es exacta y ya no necesita ventana.
 *
 * `notesUpdatedAt` ausente/`null`/inválido (no debería pasar ya — ver el
 * JSDoc de `LumbreTask.notesUpdatedAt` — pero puede en tareas viejas o si la
 * API cambia): se trata como "desconocido" y cae a marcador, salvo que la
 * capa 1 (`@done`/`#done`) ya la haya resuelto íntegra. Nunca lanza.
 *
 * `noteLength` (chars, TRAS `.trim()`) en vez del texto de la nota — la
 * matriz de decisión de abajo NUNCA necesitó el texto en sí, solo su
 * longitud (para el marcador) y `content`/`notesUpdatedAt`/`previous`. Con
 * esto puede decidir con solo `LumbreTask.notesLength` (fase 1 de
 * `list_tasks({notes:'auto'})` contra un servidor NUEVO, ver
 * `computeAutoNotesRender`), sin esperar a la fase 2 que trae el texto
 * completo de las que salgan íntegras.
 */
export function decideAutoNoteRender(content, noteLength, notesUpdatedAt, previous, opts) {
    const length = noteLength;
    const updated = parseNotesUpdatedAt(notesUpdatedAt);
    const updatedAt = updated ? notesUpdatedAt : null;
    if (hasDoneTag(content))
        return { kind: 'full', length, updatedAt };
    if (previous) {
        const previousMark = parseNotesUpdatedAt(previous.u);
        if (updated && previousMark && updated.getTime() > previousMark.getTime()) {
            return { kind: 'full', length, updatedAt };
        }
        return { kind: 'marker', length, updatedAt };
    }
    if (updated) {
        const ageMs = opts.now.getTime() - updated.getTime();
        const windowMs = opts.windowHours * 60 * 60 * 1000;
        if (ageMs >= 0 && ageMs <= windowMs)
            return { kind: 'full', length, updatedAt };
    }
    return { kind: 'marker', length, updatedAt };
}
/**
 * Decide cómo debe salir la nota de UNA tarea para `notesSince` (consulta de
 * precisión, sin estado — ver el JSDoc de `computeNotesSinceRender`):
 * ÚNICAMENTE la marca decide, sin capa 1 (`@done`/`#done`) ni capa 2 (huella
 * local) — mezclar criterios haría la consulta impredecible (una tarea
 * `@done` con nota vieja saldría "íntegra" aunque no cambiara desde `since`,
 * que es justo lo contrario de lo que se está preguntando). `notesUpdatedAt`
 * desconocido/inválido → marcador, igual que en `decideAutoNoteRender`.
 */
export function decideNotesSinceRender(notes, notesUpdatedAt, since) {
    const trimmed = notes.trim();
    const length = trimmed.length;
    const updated = parseNotesUpdatedAt(notesUpdatedAt);
    const updatedAt = updated ? notesUpdatedAt : null;
    if (updated && updated.getTime() >= since.getTime())
        return { kind: 'full', length, updatedAt };
    return { kind: 'marker', length, updatedAt };
}
/**
 * Parsea el `notesSince` de `list_tasks` (`YYYY-MM-DD` o ISO 8601 completo) a
 * un `Date`: una fecha suelta se interpreta como el INICIO de ese día en UTC
 * (medianoche), mismo criterio de "fecha sin hora = todo el día" que el resto
 * del MCP. `undefined` si `raw` no es una fecha válida — el llamante
 * (`index.ts`) lo convierte en un error de tool explícito, no en un fallback
 * silencioso: es una consulta EXPLÍCITA del usuario, así que una fecha mal
 * escrita merece decírselo, no "como si no hubiera pasado `notesSince`".
 */
export function parseNotesSince(raw) {
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00.000Z` : raw;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? undefined : d;
}
// ── Marcador `✎N ↻DDmmm` (tamaño + fecha de la última edición) ─────────────
/** Meses en español, abreviados a 3 letras minúsculas — sufijo de fecha del
 *  marcador (`✎N ↻DDmmm`, ver `formatNoteMarker`). */
const SPANISH_MONTHS = [
    'ene',
    'feb',
    'mar',
    'abr',
    'may',
    'jun',
    'jul',
    'ago',
    'sep',
    'oct',
    'nov',
    'dic'
];
/** `DDmmm` (p. ej. `24jul`) a partir de un ISO — `''` si no es una fecha
 *  válida (el llamante, `formatNoteMarker`, cae al marcador sin fecha). */
function formatMarkerDate(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime()))
        return '';
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${day}${SPANISH_MONTHS[d.getUTCMonth()]}`;
}
/**
 * Marcador `✎N` (tamaño) + `↻DDmmm` (fecha de la última edición de la nota, si
 * se conoce) — compacto a propósito: es lo que hace honesto el hueco que queda
 * del bootstrap de `notes: 'auto'`, porque incluso sin el texto permite juzgar
 * si la nota se tocó DESPUÉS de cerrar la tarea. `updatedAt: null` (no debería
 * pasar ya, ver el JSDoc de `LumbreTask.notesUpdatedAt`) cae al marcador
 * legado, solo con el tamaño.
 *
 * Vive aquí (y no en `format.ts`, donde nació) porque lo usan DOS pintores: la
 * línea de notas de un listado (`format.ts`) y la resolución en vivo de una
 * referencia `[[task:…]]` (`refs.ts`), que anuncia con el MISMO marcador si la
 * tarea referenciada trae sustancia que merezca un `get_task`. Un solo formato
 * de marcador en todo el MCP: si cambia, cambia en los dos sitios a la vez.
 */
export function formatNoteMarker(length, updatedAt) {
    const dateSuffix = updatedAt ? formatMarkerDate(updatedAt) : '';
    return dateSuffix ? `✎${length} ↻${dateSuffix}` : `✎${length}`;
}
/** Cap de entradas del fichero de huellas — sin esto crece sin límite (una
 *  entrada por tarea que haya pasado alguna vez por `list_tasks`/`get_task`
 *  desde que existe este fichero). 2.000 sobra de sobra para las ~200 tareas
 *  vivas de un usuario real y dejaría hueco para una temporada de historial. */
const MAX_STATE_ENTRIES = 2000;
/** `true` si `value` es una entrada VÁLIDA del formato NUEVO (con marca `u`
 *  ISO + longitud `n`) — distingue del formato viejo `{h,n}` (hash, retirado
 *  el 2026-07-25 al pasar la capa 2 de "cambió el hash" a "la marca es
 *  posterior") y de cualquier otra basura. Una entrada vieja/irreconocible se
 *  trata como "nunca vista" (cae al bootstrap de `decideAutoNoteRender`, y se
 *  reescribe al formato nuevo en cuanto esa nota se vuelve a tocar) en vez de
 *  romper con un JSON de la forma anterior. */
function readSeenEntry(value) {
    if (value &&
        typeof value === 'object' &&
        typeof value.u === 'string' &&
        typeof value.n === 'number') {
        return value;
    }
    return undefined;
}
/** Hay 4+ procesos MCP vivos a la vez (una sesión de Claude Code por
 *  ventana), cada uno con su propio servidor stdio — todos pueden leer/
 *  escribir este fichero a la vez. No hay lock: una carrera perdida hace, como
 *  mucho, que una nota se muestre íntegra dos veces (aceptable); lo que NO es
 *  aceptable es corromper el fichero para el resto — de ahí la escritura
 *  atómica (temporal único por proceso + `rename`, nunca se escribe encima
 *  del fichero final directamente) en `saveNotesSeenState`. */
function stateDir() {
    const base = process.env.XDG_STATE_HOME?.trim() || join(homedir(), '.local', 'state');
    return join(base, 'lumbre-mcp');
}
function stateFile() {
    return join(stateDir(), 'notes-seen.json');
}
/**
 * Lee el fichero de huellas. Tolerante a TODO (fichero ausente, permisos,
 * JSON corrupto, no es un objeto): en cualquier caso devuelve `{}` en vez de
 * lanzar — la capa 1 (`@done`/`#done`) de `decideAutoNoteRender` sigue
 * funcionando igual sin huella, y la capa 2 degrada a "todo marcador" (nunca a
 * "todo íntegro", que sería el error caro — ver el hueco conocido). Las
 * entradas del fichero pueden estar en formato VIEJO (`{h,n}`, de una versión
 * anterior del MCP) — este loader las devuelve tal cual (`unknown` por
 * entrada); es `readSeenEntry`, en el punto de uso, quien las reconoce como
 * "no válidas" y las trata como no vistas. NUNCA debe poder romper una
 * llamada a `list_tasks`/`get_task`.
 */
export async function loadNotesSeenState() {
    try {
        const raw = await readFile(stateFile(), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed;
        }
        return {};
    }
    catch {
        return {};
    }
}
/**
 * Escribe el fichero de huellas de forma atómica (temporal único +
 * `rename`), y NUNCA lanza (el llamante no necesita `try/catch`): si el
 * directorio no se puede crear, o la escritura o el rename fallan (disco
 * lleno, permisos…), la llamada simplemente no persiste nada esta vez — el
 * listado ya se ha devuelto con la mejor decisión posible, perder la huella
 * de esta pasada es aceptable (peor caso: la próxima vez esa nota vuelve a
 * salir como si no se hubiera visto).
 */
export async function saveNotesSeenState(state) {
    try {
        const dir = stateDir();
        await mkdir(dir, { recursive: true });
        const tmpPath = join(dir, `.notes-seen.${process.pid}.${randomUUID()}.tmp`);
        await writeFile(tmpPath, JSON.stringify(state));
        await rename(tmpPath, stateFile());
    }
    catch {
        // Best-effort — ver JSDoc de arriba.
    }
}
/** Implementación por defecto de `NotesSeenStore`: el fichero de huellas en
 *  disco (`loadNotesSeenState`/`saveNotesSeenState` de arriba) — la que usa
 *  el arranque stdio de `createServer` (`index.ts`) cuando no se le inyecta
 *  otra. */
export const fileNotesSeenStore = {
    load: loadNotesSeenState,
    save: saveNotesSeenState
};
/**
 * Marca `taskId` como visto CON `notesUpdatedAt` (la marca de la nota que se
 * acaba de mostrar) — inserta/reemplaza su entrada y la mueve al FINAL (más
 * reciente); `state` es un objeto plano, pero `Map` preserva orden de
 * inserción y `Object.fromEntries` lo conserva al volver a objeto, así que
 * "al final" = "recién tocada" sin necesitar un campo de timestamp aparte de
 * `u`. Poda por el otro extremo (el MENOS reciente) si se pasa de
 * `MAX_STATE_ENTRIES`. Función PURA (no toca disco) — separada de
 * `saveNotesSeenState` para poder testear la poda sin filesystem.
 *
 * Fast path SIN CAMBIOS (perf, 2026-08-25 — evita que `computeAutoNotesRender`
 * reescriba el fichero de huellas ENTERO en cada listado aunque nada haya
 * cambiado de verdad): si ya hay una entrada NUEVA (`readSeenEntry`, no
 * legado) para `taskId` con la MISMA `u`/`n` que se le iba a poner, no toca
 * el `Map` en absoluto y devuelve `state` — la MISMA referencia, sin copiar —
 * para que el llamante pueda detectar "no hubo cambio" con `!==` sin tener
 * que comparar el contenido. Solo cuenta como "sin cambio" volver a ver la
 * MISMA marca; una entrada nueva, una `notesUpdatedAt` distinta o la poda por
 * el cap SIEMPRE devuelven un objeto nuevo.
 *
 * Sin `notesUpdatedAt` válido (ausente/`null`/mal formado — no debería pasar
 * ya, ver el JSDoc de `LumbreTask.notesUpdatedAt`) no hay nada útil que
 * registrar: la capa 2 compara marcas, no ya un hash de texto, así que una
 * entrada sin `u` sería papel mojado. En ese caso se BORRA cualquier entrada
 * previa de esa tarea (propia o en formato legado `{h,n}`, ver
 * `readSeenEntry`) en vez de dejarla ahí mintiendo sobre cuándo se vio por
 * última vez — la próxima pasada cae al bootstrap, que es el criterio
 * correcto cuando no hay marca. Si no había NADA que borrar, tampoco hay
 * cambio: mismo fast path, misma referencia de vuelta.
 *
 * `noteLength` (chars, TRAS `.trim()`) en vez del texto de la nota — igual
 * que `decideAutoNoteRender`, esto solo se guarda como dato informativo
 * (`n`, nunca se usa para decidir), así que no hace falta el texto completo:
 * `computeAutoNotesRender` puede llamar aquí con solo `LumbreTask.notesLength`
 * (fase 1, servidor NUEVO), sin esperar el texto de la fase 2.
 */
export function touchNotesSeen(state, taskId, noteLength, notesUpdatedAt, maxEntries = MAX_STATE_ENTRIES) {
    const updated = parseNotesUpdatedAt(notesUpdatedAt);
    if (!updated) {
        if (!(taskId in state))
            return state;
        const map = new Map(Object.entries(state));
        map.delete(taskId);
        return Object.fromEntries(map);
    }
    const existing = readSeenEntry(state[taskId]);
    if (existing && existing.u === notesUpdatedAt && existing.n === noteLength)
        return state;
    const map = new Map(Object.entries(state));
    map.delete(taskId);
    const entry = { u: notesUpdatedAt, n: noteLength };
    map.set(taskId, entry);
    while (map.size > maxEntries) {
        const oldestKey = map.keys().next().value;
        if (oldestKey === undefined)
            break;
        map.delete(oldestKey);
    }
    return Object.fromEntries(map);
}
/**
 * Registra como VISTAS (huella actualizada) las notas de `entries` en una
 * sola carga+guardado del fichero de estado — usado tanto por `get_task`
 * (una tarea) como por `list_tasks` en modo `full` (todo el lote; en modo
 * `auto` la huella se actualiza dentro de `computeAutoNotesRender`, que ya
 * hace su propia carga porque también la NECESITA para decidir). Solo se
 * llama cuando la nota se ha SURFACEADO íntegra — nunca en `none`/`preview`,
 * donde la cola de la nota no se ha visto de verdad (ver el JSDoc de
 * `NotesMode`); tampoco en `notesSince`, que es una consulta explícita SIN
 * estado (ver `computeNotesSinceRender`) — no lee ni escribe este fichero.
 * Best-effort de principio a fin: nunca lanza.
 *
 * `store` (default `fileNotesSeenStore`) es la costura de portabilidad — ver
 * su JSDoc más arriba.
 */
export async function recordNotesSeen(entries, store = fileNotesSeenStore) {
    if (entries.length === 0)
        return;
    try {
        let state = await store.load();
        for (const e of entries) {
            state = touchNotesSeen(state, e.taskId, e.notes.trim().length, e.notesUpdatedAt);
        }
        await store.save(state);
    }
    catch {
        // Best-effort — ver JSDoc de arriba.
    }
}
// ── Modo `auto` de `list_tasks` ─────────────────────────────────────────────
/** Longitud (chars, tras `.trim()`) de la nota de `t`, de donde haya:
 *  `t.notes` si vino el texto (modo `full` de siempre, o un servidor VIEJO
 *  que ignoró `notes=length`), si no `t.notesLength` (fase 1 contra un
 *  servidor NUEVO — ver su JSDoc en `lumbre-client.ts`). `0` si ninguno de
 *  los dos trae nada útil (no debería llamarse aquí en ese caso — los
 *  llamantes de este módulo solo la usan tras filtrar por `hasNotes`). */
function noteLengthOf(t) {
    if (t.notes != null)
        return t.notes.trim().length;
    return typeof t.notesLength === 'number' ? t.notesLength : 0;
}
/**
 * Decide el render de TODAS las notas del lote para `notes: 'auto'` (default
 * de `list_tasks`) y, de paso, actualiza el fichero de huellas con lo que
 * acaba de mostrar — una sola carga y un solo guardado para todo el lote
 * (hasta 500 tareas), no uno por tarea. Tareas sin nota no aportan entrada
 * (nada que decidir ni que recordar).
 *
 * `opts.now`/`opts.windowHours` son SOLO para el bootstrap de
 * `decideAutoNoteRender` (tareas sin huella previa) — `now` inyectable para
 * poder testear la ventana sin depender de `Date.now()` real; `windowHours`
 * es `notesRecentHours` de `list_tasks` (default `DEFAULT_NOTES_RECENT_HOURS`).
 *
 * Hueco conocido, MENOR desde que `notesUpdatedAt` existe (antes era el hueco
 * grande de esta feature, ver el histórico): una nota que David tocó ANTES de
 * que el MCP viera esa tarea por primera vez (o antes de que existiera este
 * fichero) sale íntegra solo si cae dentro de la ventana de bootstrap —
 * fuera de ella, marcador la primera vez, aunque no haya cambiado desde
 * entonces. La cabecera del listado (`formatTaskList`) es la mitigación:
 * declara cuántas quedaron con marcador y recuerda `get_task` antes de darlas
 * por revisadas.
 *
 * `store` (default `fileNotesSeenStore`) es la costura de portabilidad — ver
 * su JSDoc más arriba.
 *
 * `store.save` se llama SOLO si la huella cambió de verdad (perf, 2026-08-25):
 * `touchNotesSeen` devuelve la MISMA referencia de `state` cuando una tarea ya
 * estaba registrada con la misma marca (ver su JSDoc) — si NINGUNA tarea del
 * lote la cambió, `nextState` sigue siendo `=== previousState` al final del
 * bucle y no hace falta reescribir el fichero. Antes se guardaba SIEMPRE que
 * hubiera al menos una tarea con nota, aunque el listado fuera idéntico al
 * anterior.
 */
export async function computeAutoNotesRender(tasks, opts = {}, store = fileNotesSeenStore) {
    const withNotes = tasks.filter(hasNotes);
    const perTask = new Map();
    if (withNotes.length === 0)
        return { perTask, fullCount: 0, markerCount: 0 };
    const now = opts.now ?? new Date();
    const windowHours = opts.windowHours ?? DEFAULT_NOTES_RECENT_HOURS;
    const previousState = await store.load();
    let fullCount = 0;
    let markerCount = 0;
    let nextState = previousState;
    for (const t of withNotes) {
        const previous = readSeenEntry(previousState[t.id]);
        const length = noteLengthOf(t);
        const decision = decideAutoNoteRender(t.content, length, t.notesUpdatedAt, previous, {
            now,
            windowHours
        });
        perTask.set(t.id, decision);
        if (decision.kind === 'full')
            fullCount++;
        else
            markerCount++;
        nextState = touchNotesSeen(nextState, t.id, length, t.notesUpdatedAt);
    }
    if (nextState !== previousState)
        await store.save(nextState);
    return { perTask, fullCount, markerCount };
}
/**
 * Decide el render de TODAS las notas del lote para `notesSince` (parámetro
 * de precisión de `list_tasks`, ver `index.ts`) — a diferencia de
 * `computeAutoNotesRender`, es PURA y SÍNCRONA: no lee ni escribe el fichero
 * de huellas (es una consulta explícita "qué cambió desde X", no debe
 * interferir con el estado que usa `auto`, ni depender de él). El criterio es
 * ÚNICAMENTE la marca (`decideNotesSinceRender`): ni `@done`/`#done` ni
 * huella local, ver su JSDoc para el porqué de la exclusividad.
 */
export function computeNotesSinceRender(tasks, since) {
    const withNotes = tasks.filter(hasNotes);
    const perTask = new Map();
    let fullCount = 0;
    let markerCount = 0;
    for (const t of withNotes) {
        const decision = decideNotesSinceRender(t.notes, t.notesUpdatedAt, since);
        perTask.set(t.id, decision);
        if (decision.kind === 'full')
            fullCount++;
        else
            markerCount++;
    }
    return { perTask, fullCount, markerCount };
}
//# sourceMappingURL=notes.js.map