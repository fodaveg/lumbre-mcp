import { DEFAULT_NOTES_RECENT_HOURS } from './notes.js';
/** Etiqueta corta de prioridad, o '' si p4/ninguna (mismo criterio que la app). */
function priorityLabel(priority) {
    return priority ? `p${priority}` : '';
}
/** Longitud máxima de las notas mostradas por tarea antes de truncar con "…"
 *  — SOLO en `notesMode: 'preview'` (legado); `'auto'` (default) nunca trunca
 *  a medias, ver `buildNotesLine`/`decideAutoNoteRender` en `notes.ts`. */
const NOTES_PREVIEW_LENGTH = 240;
/** Notas colapsadas a una línea (saltos de línea → espacio) y truncadas, para
 *  no romper el formato "una tarea, una línea" de `formatTask`. */
function notesPreview(notes) {
    const collapsed = notes.replace(/\s+/g, ' ').trim();
    if (collapsed.length <= NOTES_PREVIEW_LENGTH)
        return collapsed;
    return `${collapsed.slice(0, NOTES_PREVIEW_LENGTH)}…`;
}
/** Notas TAL CUAL (sin truncar NI colapsar saltos de línea) — para
 *  `notesMode: 'full'`/`'auto'` (cuando toca íntegra)/`get_task`: el caso de
 *  uso es reeditarlas con `update_task` (que REEMPLAZA la nota entera), así
 *  que hasta los saltos de línea importan; colapsarlos como hace
 *  `notesPreview` los destruiría. */
function notesFull(notes) {
    return notes.trim();
}
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
/** Marcador `✎N` (tamaño) + `↻DDmmm` (fecha de la última edición de la
 *  nota, si se conoce) — compacto a propósito: es lo que hace honesto el
 *  hueco que queda del bootstrap de `notes: 'auto'` (ver `notes.ts`), porque
 *  incluso sin el texto permite juzgar si la nota se tocó DESPUÉS de cerrar
 *  la tarea. `updatedAt: null` (no debería pasar ya, ver el JSDoc de
 *  `LumbreTask.notesUpdatedAt`) cae al marcador legado, solo con el tamaño. */
function formatNoteMarker(length, updatedAt) {
    const dateSuffix = updatedAt ? formatMarkerDate(updatedAt) : '';
    return dateSuffix ? `✎${length} ↻${dateSuffix}` : `✎${length}`;
}
/**
 * Texto de la línea de notas de `t` según `opts.notesMode`, o `null` si no
 * hay que mostrar ninguna (sin nota, o `notesMode: 'none'`). GARANTÍA de
 * `'auto'`: el resultado es SIEMPRE el texto verbatim completo (`notesFull`)
 * o un marcador `✎N` con el tamaño real — nunca un recorte a medias, que es
 * justo lo que se puede confundir con "ya la leí completa" (motivo de esta
 * feature, ver `notes.ts`). Si `opts.autoRender` no trae decisión para `t.id`
 * (no debería pasar: `computeAutoNotesRender` cubre TODA tarea con nota del
 * mismo lote — solo ocurriría si se llama con opciones inconsistentes), cae a
 * marcador con la longitud real en vez de arriesgar un truncado.
 */
function buildNotesLine(t, opts) {
    if (!t.notes || t.notes.trim() === '')
        return null;
    const mode = opts.notesMode ?? 'preview';
    if (mode === 'none')
        return null;
    if (mode === 'full')
        return notesFull(t.notes);
    if (mode === 'preview')
        return notesPreview(t.notes);
    // 'auto' (o `notesSince`, que reusa este mismo camino — ver `formatTaskList`)
    const decision = opts.autoRender?.perTask.get(t.id);
    if (!decision)
        return formatNoteMarker(t.notes.trim().length, t.notesUpdatedAt ?? null);
    return decision.kind === 'full' ? notesFull(t.notes) : formatNoteMarker(decision.length, decision.updatedAt);
}
/**
 * Normaliza el título (`content`) de una tarea para comparar duplicados:
 * `trim` + minúsculas, sin tocar tags/emoji/puntuación — dos tareas con el
 * MISMO texto salvo mayúsculas o espacios de sobra cuentan como la misma
 * (ver `duplicateTitleKeys`, más abajo, para el porqué de NO quitar `@done`/
 * `#done`).
 */
function normalizeTaskTitle(content) {
    return content.trim().toLowerCase();
}
/**
 * Títulos (normalizados con `normalizeTaskTitle`) que aparecen 2+ veces en
 * `tasks` — el lote COMPLETO que se está formateando (`formatTaskList`, no
 * solo el grupo de sección de turno), para que dos duplicados repartidos en
 * secciones distintas se sigan detectando. Deliberadamente NO se quita
 * `@done`/`#done` del texto antes de comparar: esa etiqueta vive en el
 * `content` como texto normal elegido por quien creó la tarea (el estado
 * REAL es el campo `done`, ya visible en el `[x]`/`[ ]` de la línea — ver
 * `hasDoneTag` en `notes.ts`, que es sobre las NOTAS, no sobre esto), así que
 * "Pagar factura" y "Pagar factura @done" son títulos distintos a ojos de
 * esta función, no el mismo título con y sin marca.
 */
function duplicateTitleKeys(tasks) {
    const counts = new Map();
    for (const t of tasks) {
        const key = normalizeTaskTitle(t.content);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const duplicates = new Set();
    for (const [key, count] of counts) {
        if (count >= 2)
            duplicates.add(key);
    }
    return duplicates;
}
/** Una tarea → una línea compacta y legible (NO JSON crudo, para no saturar
 *  al modelo). `isDuplicateTitle` (ver `duplicateTitleKeys`, calculado UNA
 *  vez por `formatTaskList` sobre el lote entero): solo cuando es `true` se
 *  añade el tag `creada:<timestamp>` — su ÚNICO uso es desempatar cuál es la
 *  más nueva entre dos tareas con el mismo título; en el caso normal (título
 *  único en el lote) no aporta nada y solo alarga la línea. */
function formatTask(t, opts, isDuplicateTitle) {
    const box = t.done ? '[x]' : '[ ]';
    const tags = [];
    const prio = priorityLabel(t.priority);
    if (prio)
        tags.push(prio);
    if (t.date)
        tags.push(t.date);
    if (t.deadline)
        tags.push(`⚑${t.deadline}`);
    // `createdAt` recortado a minuto (sin segundos/ms): SOLO si hay otra tarea
    // con el mismo título en este mismo lote — sirve para desempatar
    // duplicados ("deja el más nuevo") sin alargar la línea de más en el caso
    // normal (título único), que es la inmensa mayoría.
    if (isDuplicateTitle)
        tags.push(`creada:${t.createdAt.slice(0, 16)}`);
    const suffix = tags.length > 0 ? ` (${tags.join(', ')})` : '';
    // El id (UUID) al final de la línea: TODAS las tools de mutación
    // (update_task, complete_task, reschedule_task, delete_task, set_section) lo
    // EXIGEN, y `list_tasks` es el único sitio donde el modelo puede obtenerlo.
    // Sin esto sus descripciones ("resuélvelo antes con list_tasks") eran
    // imposibles de cumplir y las mutaciones quedaban de facto inservibles.
    let line = `- ${box} ${t.content}${suffix}  · id: ${t.id}`;
    // Línea aparte con las notas (si las hay y el modo no es 'none') — ver
    // `buildNotesLine` para el criterio completo por `notesMode`.
    const notesLine = buildNotesLine(t, opts);
    if (notesLine !== null)
        line += `\n  notas: ${notesLine}`;
    if (!t.attachments || t.attachments.length === 0)
        return line;
    // Una línea aparte con los adjuntos (nombre + id): el modelo necesita el id
    // para pedir los bytes con la tool `read_attachment`.
    const attachmentsLine = `  📎 adjuntos: ${t.attachments
        .map((a) => `${a.filename} (id: ${a.id})`)
        .join(' · ')}`;
    return `${line}\n${attachmentsLine}`;
}
/**
 * Tarea → bloque legible con TODOS sus campos (para `get_task`, ver
 * `index.ts`): a diferencia de `formatTask` (pensado para listados, una línea
 * por tarea), este vuelca lista/sección/`createdAt` explícitos y las notas
 * SIEMPRE íntegras y verbatim (ver `notesFull`) — el caso de uso es leer una
 * tarea entera para poder reeditar su nota con `update_task` sin perder nada.
 *
 * `subtasks` (si la tarea es de primer nivel y tiene alguna, ver
 * `LumbreTask.subtasks`): una línea `[x]`/`[ ]` por subtarea, con SU id — es
 * el ÚNICO sitio donde el modelo puede obtener el id de una subtarea, para
 * poder pasárselo después a `complete_subtask`.
 */
export function formatTaskFull(t) {
    const lines = [
        `Tarea ${t.id}`,
        `- contenido: ${t.content}`,
        `- estado: ${t.done ? 'hecha' : 'pendiente'}`,
        `- prioridad: ${priorityLabel(t.priority) || '(ninguna)'}`,
        `- fecha: ${t.date ?? '(sin fecha)'}`,
        `- deadline: ${t.deadline ? `⚑${t.deadline}` : '(sin deadline)'}`,
        `- lista: ${t.list ? `"${t.list}"${t.somedayListId ? ` (listId: ${t.somedayListId})` : ''}` : '(sin lista)'}`,
        `- sección: ${t.section ? `"${t.section}"${t.sectionId ? ` (sectionId: ${t.sectionId})` : ''}` : '(sin sección)'}`,
        `- creada: ${t.createdAt}`
    ];
    if (t.notes && t.notes.trim() !== '') {
        lines.push(`- notas:\n${notesFull(t.notes)}`);
    }
    else {
        lines.push('- notas: (sin notas)');
    }
    if (t.attachments && t.attachments.length > 0) {
        lines.push(`- 📎 adjuntos: ${t.attachments.map((a) => `${a.filename} (id: ${a.id})`).join(' · ')}`);
    }
    if (t.subtasks && t.subtasks.length > 0) {
        lines.push('- subtareas:');
        for (const s of t.subtasks) {
            lines.push(`  ${s.done ? '[x]' : '[ ]'} ${s.content}  · id: ${s.id}`);
        }
    }
    return lines.join('\n');
}
/**
 * Leyenda de listas: una línea por lista de "Algún día" DISTINTA presente en
 * el lote (deduplicada por el par `(nombre, listId)`, no solo por nombre —
 * dos listas distintas pueden compartir nombre, ver el comentario de
 * `distinctLists` más abajo). Da al modelo el `listId` ESTABLE de cada lista
 * sin que tenga que inspeccionar tarea por tarea; lo necesita para `add_task`
 * (`listId`) y `move_to_list`. Tareas sin lista, o cuya lista aún no tenga
 * `somedayListId` resuelto, no aportan entrada. Devuelve `[]` si ninguna
 * tarea del lote tiene lista (el llamante omite la leyenda en ese caso).
 */
function listLegend(tasks) {
    const seen = new Set();
    const lines = [];
    for (const t of tasks) {
        if (!t.list || !t.somedayListId)
            continue;
        const key = `${t.list} ${t.somedayListId}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        lines.push(`· lista "${t.list}" — listId: ${t.somedayListId}`);
    }
    return lines;
}
/**
 * Cabecera de notas para `notesMode: 'auto'` (`list_tasks`, con o sin
 * `notesSince`): declara qué CRITERIO se aplicó y lleva la instrucción de
 * "sin leer" DENTRO de la salida — tiene que viajar ahí porque la sesión de
 * mañana no tendrá el contexto de esta tarea. `null` si el lote no tiene
 * NINGUNA nota (no aporta nada, solo ruido).
 *
 * Dos variantes de criterio, mutuamente excluyentes (mismo criterio que
 * `computeAutoNotesRender` vs `computeNotesSinceRender`):
 * - Normal (`opts.sinceLabel` ausente): `íntegras` cubre @done/#done, cambió
 *   desde la última vez que se vio, o se tocó dentro de la ventana de
 *   bootstrap (`opts.windowHours`, default `DEFAULT_NOTES_RECENT_HOURS`).
 * - `notesSince` (`opts.sinceLabel` presente): ÚNICAMENTE la marca desde esa
 *   fecha decide (ver `decideNotesSinceRender`) — la cabecera lo declara
 *   explícito para que no se confunda con el criterio normal.
 *
 * `con marcador` son las que el modelo NO ha leído todavía — la instrucción
 * se lo dice explícitamente para que no las dé por revisadas sin más.
 */
function autoNotesHeaderLine(autoRender, opts) {
    const { fullCount, markerCount } = autoRender;
    if (fullCount + markerCount === 0)
        return null;
    const fullWord = fullCount === 1 ? 'íntegra' : 'íntegras';
    const criterion = opts.sinceLabel
        ? `tocadas desde ${opts.sinceLabel}`
        : `@done · cambiadas · tocadas <${opts.windowHours ?? DEFAULT_NOTES_RECENT_HOURS}h`;
    return (`notas: ${fullCount} ${fullWord} (${criterion}) · ` +
        `${markerCount} con marcador → SIN LEER, usa get_task antes de darlas por revisadas`);
}
/**
 * Lista completa → texto compacto con cabecera de recuento + alcance,
 * agrupado por sección (Fase B, listas=proyectos): una cabecera `## <sección>`
 * por grupo, en el orden en que aparecen en la respuesta del servidor (ya
 * viene ordenada por fecha/posición). Las tareas sin sección van bajo
 * `## (sin sección)` — SOLO se muestra esa cabecera si hay alguna tarea CON
 * sección en el lote (si ninguna tarea tiene sección, listar secciones no
 * aporta nada y solo añade ruido). Esto ayuda al modelo a distinguir, p. ej.,
 * bugs de propuestas dentro del mismo proyecto sin tener que parsear el texto.
 *
 * El agrupado real es por el PAR `(list, section)`, no solo por `section`:
 * cuando se listan tareas de VARIAS listas a la vez (query sin `?list=`), dos
 * proyectos con secciones homónimas (p. ej. "Bugs" en dos listas distintas)
 * NO deben fusionarse bajo la misma cabecera. Si en el lote hay una única
 * lista distinta (o ninguna), la cabecera se queda como antes (`## <sección>`,
 * sin repetir el nombre de la lista, redundante en ese caso); si hay más de
 * una lista distinta, se antepone su nombre (`## <lista> · <sección>`).
 *
 * `opts.notesMode` (default `'preview'`, aunque `index.ts` siempre pasa uno
 * explícito) pasa a cada `formatTask` — ver `buildNotesLine` para el
 * criterio completo por modo. En `'auto'`, además, la cabecera declara los
 * recuentos (`autoNotesHeaderLine`) — la instrucción tiene que viajar EN la
 * salida porque la sesión que la lea mañana no tendrá este contexto.
 *
 * `creada:<timestamp>` (tag de `formatTask`) se calcula UNA vez aquí sobre
 * el lote ENTERO (`duplicateTitleKeys`), antes de agrupar por sección — así
 * dos tareas con el mismo título repartidas en secciones/listas distintas
 * también se detectan como duplicado, no solo las que caen en el mismo grupo.
 */
export function formatTaskList(tasks, scope, opts = {}) {
    if (tasks.length === 0)
        return `Sin tareas (scope=${scope}).`;
    const header = `${tasks.length} tarea${tasks.length === 1 ? '' : 's'} (scope=${scope}):`;
    const notesHeaderLine = (opts.notesMode ?? 'preview') === 'auto' && opts.autoRender
        ? autoNotesHeaderLine(opts.autoRender, {
            windowHours: opts.notesWindowHours,
            sinceLabel: opts.notesSinceLabel
        })
        : null;
    // Leyenda de listas primero (si alguna tarea tiene lista): da el `listId`
    // de cada una sin tocar el formato por-tarea, que se deja intacto para no
    // añadir ruido repetido línea a línea.
    const legend = listLegend(tasks);
    const prefixLines = [...(notesHeaderLine ? [notesHeaderLine] : []), ...legend];
    const prefix = prefixLines.length > 0 ? [...prefixLines, ''] : [];
    const duplicateTitles = duplicateTitleKeys(tasks);
    const isDuplicateTitle = (t) => duplicateTitles.has(normalizeTaskTitle(t.content));
    const hasAnySection = tasks.some((t) => t.section);
    if (!hasAnySection) {
        return [...prefix, header, ...tasks.map((t) => formatTask(t, opts, isDuplicateTitle(t)))].join('\n');
    }
    // "Listas distintas" = valores de t.list no nulos, deduplicados. Si el lote
    // solo toca una (o ninguna, todas null), no hace falta desambiguar.
    const distinctLists = new Set(tasks.map((t) => t.list).filter((l) => !!l));
    const showList = distinctLists.size > 1;
    const groups = [];
    for (const t of tasks) {
        const sectionLabel = t.section ?? '(sin sección)';
        const listLabel = t.list ?? '(sin lista)';
        const label = showList ? `${listLabel} · ${sectionLabel}` : sectionLabel;
        // Clave de agrupación separada de la etiqueta visible: JSON.stringify
        // evita colisiones si un nombre de lista/sección contiene el separador.
        const key = JSON.stringify([showList ? listLabel : null, sectionLabel]);
        const group = groups.find((g) => g.key === key);
        if (group)
            group.tasks.push(t);
        else
            groups.push({ key, label, tasks: [t] });
    }
    const body = groups.flatMap((g) => [`## ${g.label}`, ...g.tasks.map((t) => formatTask(t, opts, isDuplicateTitle(t)))]);
    return [...prefix, header, ...body].join('\n');
}
/**
 * Formatea el resultado de `list_lists` (`GET /api/tasks?includeLists=1`):
 * TODAS las listas vivas del usuario, con su recuento — INCLUIDAS las de
 * recuento 0 (b00303b5: antes una lista vacía no aparecía en NINGÚN sitio
 * del MCP, indistinguible de "no existe").
 */
export function formatListSummaries(lists) {
    if (lists.length === 0)
        return 'Sin listas.';
    const header = `${lists.length} lista${lists.length === 1 ? '' : 's'}:`;
    const body = lists.map((l) => `· ${l.name} — ${l.taskCount} tarea${l.taskCount === 1 ? '' : 's'} (listId: ${l.id})`);
    return [header, ...body].join('\n');
}
//# sourceMappingURL=format.js.map