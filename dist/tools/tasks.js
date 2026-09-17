import { z } from 'zod';
import { addTask, findTaskById, findTasksByIds, listTasks, priorityToLevel, taskNotFoundError } from '../lumbre-client.js';
import { formatTaskFull, formatTaskList } from '../format.js';
import { resolveRefs } from '../refs.js';
import { computeAutoNotesRender, computeNotesSinceRender, DEFAULT_NOTES_RECENT_HOURS, hasNotes, parseNotesSince, recordNotesSeen } from '../notes.js';
import { requireTaskExists, mutateTaskInvalidating } from './task-existence.js';
import { ASYNC_NOTE, errorResult, recurrenceSchema, tagSchema, textResult } from './shared.js';
/**
 * Modo efectivo de `notes` para `list_tasks`: `input.notes` si vino
 * informado, si no `'full'` cuando `fullNotes: true` (alias legado, ver el
 * `.describe()` de ambos campos en `list_tasks`), si no `'auto'` (default
 * nuevo). Función PURA — sin red — para poder testear el alias sin mockear
 * `fetch` (mismo patrón que `mutateTasksOpSchema`/`buildBatchFromOps`).
 */
export function effectiveNotesMode(input) {
    return input.notes ?? (input.fullNotes ? 'full' : 'auto');
}
/**
 * Alcance EFECTIVO de `list_tasks`, el que va en la cabecera de
 * `formatTaskList` — tiene que ser el mismo default que aplica el SERVIDOR
 * (ver el JSDoc de `ListTasksInput.list` en `lumbre-client.ts`: sin `scope`
 * explícito y con `list`, el servidor amplía el alcance temporal a "all"),
 * no el default LOCAL de esta tool ("today"). Bug real medido el 2026-09-17:
 * `list_tasks({ list: "addons", section: "MCP" })`, sin `scope`, devolvía
 * "3 tareas (scope=today)" con el contenido de scope=all — la cabecera
 * pintaba `input.scope ?? 'today'` sin mirar `list`, mientras la petición al
 * servidor sí se beneficiaba de su propio default ampliado. Función PURA —
 * sin red — mismo patrón que `effectiveNotesMode`.
 */
export function effectiveScopeLabel(input) {
    return input.scope ?? (input.list ? 'all' : 'today');
}
/**
 * Textos del lote que hay que escanear en busca de referencias
 * (`[[task:…]]`/`[[list:…]]`, ver `refs.ts`): SIEMPRE el contenido de cada
 * tarea, y sus notas SOLO si de verdad se van a pintar en esta respuesta —
 * resolver la referencia de una nota que sale como marcador (o que `notes:
 * 'none'` omite) gastaría hueco del `?ids=` para algo que nadie va a leer.
 * Pura, sin red: decide QUÉ pedir, no lo pide. `'preview'` sí se incluye
 * entero aunque el recorte a 240 chars pueda dejar fuera alguna referencia
 * (modo legado, no vale la pena afinar más).
 */
export function refTexts(tasks, notesMode, autoRender) {
    const texts = [];
    for (const t of tasks) {
        texts.push(t.content);
        if (notesMode === 'none')
            continue;
        if (notesMode === 'auto' && autoRender?.perTask.get(t.id)?.kind !== 'full')
            continue;
        texts.push(t.notes);
    }
    return texts;
}
/**
 * Familia «tareas individuales»: `add_task`/`list_tasks`/`get_task` y las
 * nueve de Fase 2 (`complete_task`/`cancel_task`/`update_task`/
 * `reschedule_task`/`delete_task`/`set_section`/`remove_section`/
 * `add_subtask`/`complete_subtask`, ver PHASE2.md). Extraída de `index.ts`
 * tal cual (tarea de partir el servidor en `src/tools/` por familia,
 * 2026-09-17): cero cambios de comportamiento, solo `config`/`taskCache`/
 * `notesSeenStore` explícitos por `ctx` en vez de closure.
 */
export function registerTaskTools(server, ctx) {
    const addTaskTool = server.registerTool('add_task', {
        description: 'Añade una tarea nueva a Lumbre (planificador semanal). Dispara con "apúntame", ' +
            '"recuérdame", "añade a mi proyecto/área". Se encola y se materializa al sincronizar. ' +
            '`section` coloca la tarea DENTRO de `list` (se crea si no existe); se ignora sin `list`.',
        inputSchema: {
            text: z.string().min(1).max(2000).describe('Texto de la tarea (obligatorio)'),
            list: z
                .string()
                .max(200)
                .optional()
                .describe('Nombre del proyecto o área destino (se crea como proyecto si no existe). Sin `list` y sin ' +
                'date, el cliente la coloca en "hoy" al materializarla.'),
            listId: z
                .string()
                .uuid()
                .optional()
                .describe('Id ESTABLE del proyecto o área destino, PREFERENTE sobre `list` (inmune a renames); sácalo ' +
                'de list_tasks. Si se omite, se usa `list` por nombre (se crea si no existe).'),
            section: z
                .string()
                .max(200)
                .optional()
                .describe('Nombre de la sección/heading dentro de `list` donde colocar la tarea (se crea si ' +
                'no existe). Se ignora si no se indica `list`.'),
            priority: z.enum(['p1', 'p2', 'p3', 'p4']).optional().describe('p1 = más urgente; p4 = ninguna'),
            date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Día programado, YYYY-MM-DD'),
            deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Fecha límite ⚑, YYYY-MM-DD'),
            time: z
                .string()
                .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
                .optional()
                .describe('Hora "HH:MM" (24h); sin `date`, la tarea se agenda hoy'),
            recurrence: recurrenceSchema.optional(),
            subtasks: z.array(z.string()).optional().describe('Subtareas a crear junto con la tarea'),
            notes: z.string().max(10000).optional().describe('Notas/descripción larga'),
            tags: z
                .array(tagSchema)
                .optional()
                .describe('Tags propios; [] deja la tarea explícitamente sin tags')
        }
    }, async (input) => {
        try {
            await addTask(ctx.config, input);
            return textResult(`Tarea añadida a Lumbre: “${input.text}”.`);
        }
        catch (err) {
            return errorResult(err);
        }
    });
    const listTasksTool = server.registerTool('list_tasks', {
        description: 'Lee tareas de Lumbre. `scope`: today (default), week, upcoming, inbox/someday, overdue, ' +
            'all (auto "all" si usas `list` sin `scope`). `list` filtra por nombre; si no existe da ' +
            'vacío igual que un proyecto o área vacíos — usa list_lists para distinguir. `section` ' +
            'agrupa por sección dentro de `list`; `includeArchived` permite consultar archivadas. ' +
            '`notes` decide qué notas trae cada tarea (criterio completo en ese campo;' +
            'GARANTÍA: nunca un texto recortado a medias; la cabecera avisa de las no leídas). ' +
            '`notesSince` es una consulta de precisión aparte: solo lo tocado desde esa fecha.',
        inputSchema: {
            scope: z
                .enum(['today', 'week', 'upcoming', 'inbox', 'someday', 'overdue', 'all'])
                .optional()
                .describe('Alcance temporal; default "today" ("all" si se usa `list` sin `scope`). "week" es la ' +
                'semana de CALENDARIO; "upcoming" es una ventana rodante que siempre empieza hoy'),
            days: z
                .number()
                .int()
                .min(1)
                .max(14)
                .optional()
                .describe('Solo con scope "upcoming": días de la ventana contando hoy (default 7, máx 14)'),
            list: z
                .string()
                .optional()
                .describe('Nombre (case-insensitive) de un proyecto o área a filtrar'),
            section: z
                .string()
                .optional()
                .describe('Nombre (case-insensitive) de una sección dentro de `list` a filtrar (Fase B, ' +
                'proyectos/áreas); combinado con `list`, solo casa una sección de ESE destino'),
            includeDone: z.boolean().optional().describe('Incluir tareas ya completadas; default false'),
            includeArchived: z
                .boolean()
                .optional()
                .describe('Incluir tareas archivadas; default false. En listados sigue combinándose con ' +
                'includeDone y el resto de filtros'),
            notes: z
                .enum(['auto', 'none', 'preview', 'full'])
                .optional()
                .describe('"auto" (default): íntegra si @done/#done, si cambió desde la última vez que este MCP ' +
                'la mostró (huella local por `notesUpdatedAt`), o si se tocó dentro de ' +
                '`notesRecentHours` (solo la 1ª vez que se ve esa tarea) — si no, un marcador ' +
                '"✎N ↻fecha" con su tamaño y la fecha de la última edición — GARANTÍA: nunca un ' +
                'recorte a medias. "none": sin notas. "preview": recorte legado a ~240 chars, ' +
                'colapsado a una línea. "full": todas íntegras y verbatim para TODO el lote ' +
                '(equivale a fullNotes:true) — útil si vas a reeditar con update_task (que ' +
                'REEMPLAZA la nota entera). Para una sola tarea concreta, mejor get_task. Se ignora ' +
                'si mandas `notesSince`.'),
            fullNotes: z
                .boolean()
                .optional()
                .describe('DEPRECATED, alias de notes:"full" (se ignora si `notes` viene informado).'),
            notesRecentHours: z
                .number()
                .positive()
                .optional()
                .describe(`Solo con "auto": ventana (horas, default ${DEFAULT_NOTES_RECENT_HOURS}) para dar por ` +
                'íntegra la nota de una tarea que el MCP ve por 1ª vez (sin huella local aún) — ' +
                'más ventana = más notas íntegras de golpe, más chars en la respuesta.'),
            notesSince: z
                .string()
                .min(10)
                .optional()
                .describe('Consulta de precisión, SIN estado: "YYYY-MM-DD" o ISO completo — íntegra SOLO si la ' +
                'nota se editó desde esa fecha (`notesUpdatedAt`), marcador el resto. Ignora `notes`/' +
                '`fullNotes`, @done/#done y la huella local por completo (mezclar criterios haría ' +
                'la consulta impredecible): úsalo para "qué ha cambiado desde X", no para lectura ' +
                'normal.')
        }
    }, async (input) => {
        try {
            if (input.notesSince !== undefined) {
                const since = parseNotesSince(input.notesSince);
                if (!since) {
                    return errorResult(new Error(`notesSince inválido: "${input.notesSince}" (usa "YYYY-MM-DD" o ISO 8601 completo).`));
                }
                // Consulta de precisión, siempre con las notas ENTERAS (sin
                // `notesQuery`, ver el JSDoc de `computeNotesSinceRender`): no es el
                // camino que optimiza esta feature, así que se queda con el
                // comportamiento de siempre.
                const tasks = await listTasks(ctx.config, input);
                ctx.taskCache.setAll(tasks);
                const autoRender = computeNotesSinceRender(tasks, since);
                const refs = await resolveRefs(ctx.config, refTexts(tasks, 'auto', autoRender), {
                    includeArchived: input.includeArchived
                });
                return textResult(formatTaskList(tasks, effectiveScopeLabel(input), {
                    notesMode: 'auto',
                    autoRender,
                    notesSinceLabel: input.notesSince,
                    refs
                }));
            }
            const notesMode = effectiveNotesMode(input);
            if (notesMode === 'none') {
                // El texto no se usa para nada: una sola petición, ahorro máximo —
                // un servidor VIEJO ignora `notes=none` y todo sigue funcionando
                // igual, solo que sin ahorrar.
                const tasks = await listTasks(ctx.config, { ...input, notesQuery: 'none' });
                ctx.taskCache.setAll(tasks);
                const refs = await resolveRefs(ctx.config, refTexts(tasks, notesMode), {
                    includeArchived: input.includeArchived
                });
                return textResult(formatTaskList(tasks, effectiveScopeLabel(input), { notesMode, refs }));
            }
            if (notesMode === 'auto') {
                const { list, autoRender } = await listTasksAutoTwoPhase(input);
                const refs = await resolveRefs(ctx.config, refTexts(list, notesMode, autoRender), {
                    includeArchived: input.includeArchived
                });
                return textResult(formatTaskList(list, effectiveScopeLabel(input), {
                    notesMode,
                    autoRender,
                    notesWindowHours: input.notesRecentHours,
                    refs
                }));
            }
            // 'preview'/'full': notas enteras de siempre, sin optimizar ('full'
            // las necesita TODAS íntegras, 'preview' las trunca aquí mismo a
            // partir del texto completo).
            const tasks = await listTasks(ctx.config, input);
            ctx.taskCache.setAll(tasks);
            if (notesMode === 'full') {
                // Íntegra en 'full' también cuenta como SURFACEADA — misma huella
                // que 'auto' registra, para que una vuelta con `notes: 'full'` no
                // haga que la siguiente en 'auto' vuelva a marcar "cambió" sin
                // haber cambiado — ver el JSDoc de `recordNotesSeen`.
                await recordNotesSeen(tasks
                    .filter(hasNotes)
                    .map((t) => ({ taskId: t.id, notes: t.notes, notesUpdatedAt: t.notesUpdatedAt })), ctx.notesSeenStore);
            }
            const refs = await resolveRefs(ctx.config, refTexts(tasks, notesMode), {
                includeArchived: input.includeArchived
            });
            return textResult(formatTaskList(tasks, effectiveScopeLabel(input), { notesMode, refs }));
        }
        catch (err) {
            return errorResult(err);
        }
    });
    /**
     * `list_tasks({notes:'auto'})` (default) en DOS FASES — perf, 2026-08-25:
     * antes, `listTasks` traía el texto de TODAS las notas siempre, aunque la
     * mayoría (las que la decisión manda a marcador) se tiran en local (medido
     * contra datos reales: de un `scope=all` de 542 KB, 307 KB — 56,6% — eran
     * texto de notas, ver el encargo de esta feature).
     *
     * 1. Fase 1: `GET /api/tasks?notes=length` — cada tarea trae `notesLength`
     *    en vez del texto (ver `ListTasksInput.notesQuery`).
     * 2. Detección de servidor VIEJO (aún no conoce `notes=length`, ver el
     *    JSDoc de `LumbreTask.notesLength`): NINGUNA tarea trae la PROPIEDAD
     *    `notesLength` (con `in`, no comprobando si vale `null` — un servidor
     *    NUEVO también puede mandar `notesLength: null` en una tarea sin nota)
     *    → ya nos ha dado las notas enteras igual (ignoró el parámetro), así
     *    que seguimos con ESE mismo lote: repliegue a coste CERO, sin 2ª
     *    petición.
     * 3. Servidor NUEVO: decide íntegra/marcador por tarea con lo que ya
     *    sabemos (`computeAutoNotesRender`, que ahora sabe leer `notesLength`
     *    sin necesitar el texto — ver `notes.ts`).
     * 4. Fase 2: SOLO para las que la decisión marcó íntegras, `GET
     *    /api/tasks?ids=<esos ids>&notes=full` (una petición; trocea >200 ids
     *    — `findTasksByIds`) para traer su texto. Conjunto vacío → ninguna
     *    petición extra.
     * 5. GARANTÍA (README): si la fase 2 falla, o devuelve MENOS tareas de las
     *    pedidas (p. ej. una tarea borrada entre medias) o con la nota vacía,
     *    esa nota se REPLIEGA a marcador — con la longitud/fecha YA conocidas
     *    de la fase 1 — en vez de colar un texto a medias o una nota vacía
     *    disfrazada de "sin nota".
     */
    async function listTasksAutoTwoPhase(input) {
        const phase1 = await listTasks(ctx.config, { ...input, notesQuery: 'length' });
        const isNewServer = phase1.some((t) => 'notesLength' in t);
        if (!isNewServer) {
            ctx.taskCache.setAll(phase1);
            const autoRender = await computeAutoNotesRender(phase1, { windowHours: input.notesRecentHours }, ctx.notesSeenStore);
            return { list: phase1, autoRender };
        }
        const autoRender = await computeAutoNotesRender(phase1, { windowHours: input.notesRecentHours }, ctx.notesSeenStore);
        const fullIds = phase1
            .filter((t) => autoRender.perTask.get(t.id)?.kind === 'full')
            .map((t) => t.id);
        let fullTasksById = new Map();
        if (fullIds.length > 0) {
            try {
                fullTasksById = await findTasksByIds(ctx.config, fullIds, {
                    notesQuery: 'full',
                    includeArchived: input.includeArchived
                });
            }
            catch {
                // La fase 2 falló DEL TODO (red, 5xx…): `fullTasksById` se queda
                // vacío y cada tarea "íntegra" cae al mismo repliegue de abajo
                // (tarea ausente del Map) — GARANTÍA, nunca a medias ni rompe el
                // listado entero por un fallo que solo afecta al TEXTO de la nota.
            }
        }
        const list = phase1.map((t) => {
            const decision = autoRender.perTask.get(t.id);
            if (decision?.kind !== 'full')
                return t;
            const full = fullTasksById.get(t.id);
            if (!full || !hasNotes(full)) {
                // Repliegue a marcador (garantía de arriba): la fase 2 no trajo esta
                // tarea (borrada entre medias, p. ej.), falló del todo, o su nota ya
                // no está — NUNCA texto a medias ni una nota vacía disfrazada de "sin
                // nota".
                autoRender.perTask.set(t.id, { ...decision, kind: 'marker' });
                autoRender.fullCount--;
                autoRender.markerCount++;
                return t;
            }
            return { ...t, notes: full.notes };
        });
        ctx.taskCache.setAll(list);
        return { list, autoRender };
    }
    const getTaskTool = server.registerTool('get_task', {
        description: 'Devuelve UNA tarea entera y sin recortar (notas íntegras, fecha de creación, ' +
            'proyecto o área/sección). Si tiene subtareas, las incluye con su id y estado — única forma de ' +
            'obtener el id de una subtarea. `includeArchived` permite recuperarla si está archivada. ' +
            'Error si el taskId no existe.',
        inputSchema: {
            taskId: z.string().uuid().describe('Id de la tarea (ver list_tasks)'),
            includeArchived: z
                .boolean()
                .optional()
                .describe('Permitir recuperar la tarea por id aunque esté archivada; default false')
        }
    }, async (input) => {
        try {
            const task = await findTaskById(ctx.config, input.taskId, {
                includeArchived: input.includeArchived
            });
            if (!task)
                return errorResult(taskNotFoundError(input.taskId));
            ctx.taskCache.set(task);
            // La nota (si la hay) sale SIEMPRE íntegra aquí (`formatTaskFull`) — se
            // registra como vista, misma huella que `list_tasks({notes:'auto'})`
            // consulta (ver `notes.ts`); best-effort, nunca puede romper esta
            // lectura.
            if (hasNotes(task)) {
                await recordNotesSeen([{ taskId: task.id, notes: task.notes, notesUpdatedAt: task.notesUpdatedAt }], ctx.notesSeenStore);
            }
            // Referencias EN VIVO del texto, la nota (que aquí sale siempre íntegra)
            // y las subtareas — ver `refs.ts`. Cero peticiones extra si no hay
            // ninguna referencia, que es el caso normal.
            const refs = await resolveRefs(ctx.config, [task.content, task.notes, ...(task.subtasks ?? []).map((s) => s.content)], { includeArchived: input.includeArchived });
            return textResult(formatTaskFull(task, refs));
        }
        catch (err) {
            return errorResult(err);
        }
    });
    // ── Fase 2: mutar una tarea existente (ver PHASE2.md) ──────────────────────
    const completeTaskTool = server.registerTool('complete_task', {
        description: `Marca una tarea (o SUBTAREA, aunque para eso es más claro complete_subtask) como hecha, o ` +
            `la desmarca con done:false. ${ASYNC_NOTE}`,
        inputSchema: {
            taskId: z.string().uuid().describe('Id de la tarea (ver list_tasks)'),
            done: z.boolean().optional().describe('true = completar (default); false = desmarcar')
        }
    }, async (input) => {
        try {
            await requireTaskExists(ctx, input.taskId, { allowSubtask: true });
            await mutateTaskInvalidating(ctx, {
                taskId: input.taskId,
                kind: 'complete',
                payload: { done: input.done ?? true }
            });
            return textResult(`Encolado en Lumbre: ${input.done === false ? 'desmarcar' : 'completar'} la tarea ${input.taskId} ` +
                '(se aplicará al sincronizar).');
        }
        catch (err) {
            return errorResult(err);
        }
    });
    const cancelTaskTool = server.registerTool('cancel_task', {
        description: `Cancela una tarea existente ("no se hizo ni se hará", distinto de completarla); sale ` +
            `igual de pendientes/rollover. Dispara con "cancela"/"descarta" (sin borrarla). ` +
            `cancelled:false la restaura. ${ASYNC_NOTE}`,
        inputSchema: {
            taskId: z.string().uuid().describe('Id de la tarea (ver list_tasks)'),
            cancelled: z.boolean().optional().describe('true = cancelar (default); false = restaurar')
        }
    }, async (input) => {
        try {
            await requireTaskExists(ctx, input.taskId, { allowSubtask: true });
            await mutateTaskInvalidating(ctx, {
                taskId: input.taskId,
                kind: 'cancel',
                payload: { cancelled: input.cancelled ?? true }
            });
            return textResult(`Encolado en Lumbre: ${input.cancelled === false ? 'restaurar' : 'cancelar'} la tarea ${input.taskId} ` +
                '(se aplicará al sincronizar).');
        }
        catch (err) {
            return errorResult(err);
        }
    });
    const updateTaskTool = server.registerTool('update_task', {
        description: `Edita texto, notas, tags propios, prioridad u hora de una tarea existente, o de una ` +
            `SUBTAREA suya (los cinco campos valen igual en una subtarea). Los campos que omitas ` +
            `no cambian; \`notes\` REEMPLAZA las anteriores enteras. ${ASYNC_NOTE}`,
        inputSchema: {
            taskId: z.string().uuid().describe('Id de la tarea (ver list_tasks)'),
            content: z.string().min(1).max(2000).optional().describe('Nuevo texto/título de la tarea'),
            notes: z
                .string()
                .max(10000)
                .optional()
                .describe('Nuevas notas/descripción (reemplaza las anteriores por completo)'),
            tags: z
                .array(tagSchema)
                .optional()
                .describe('Reemplazo completo de tags propios; [] los quita'),
            priority: z
                .enum(['p1', 'p2', 'p3', 'p4'])
                .optional()
                .describe('p1 = más urgente … p3; p4 = quitar la prioridad'),
            time: z
                .union([z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), z.null()])
                .optional()
                .describe('Hora "HH:MM" (24h); si la tarea no tiene día se agenda hoy. null la quita')
        }
    }, async (input) => {
        if (input.content === undefined &&
            input.notes === undefined &&
            input.tags === undefined &&
            input.priority === undefined &&
            input.time === undefined) {
            return errorResult(new Error('Indica al menos un campo a cambiar (content, notes, tags, priority o time).'));
        }
        try {
            // `allowSubtask: true` (2026-09-04): `content`/`notes`/`priority`/
            // `tags`/`time` son cinco de los accidentales PERMITIDOS en una subtarea
            // por `docs/18-que-es-una-tarea.md` §2.5 — ver el JSDoc de
            // `assertTaskUsable` para el camino de servidor que lo respalda.
            await requireTaskExists(ctx, input.taskId, { allowSubtask: true });
            await mutateTaskInvalidating(ctx, {
                taskId: input.taskId,
                kind: 'update',
                payload: {
                    ...(input.content !== undefined ? { content: input.content } : {}),
                    ...(input.notes !== undefined ? { notes: input.notes } : {}),
                    ...(input.tags !== undefined ? { tags: input.tags } : {}),
                    ...(input.priority !== undefined ? { priority: priorityToLevel(input.priority) } : {}),
                    ...(input.time !== undefined ? { time: input.time } : {})
                }
            });
            return textResult(`Encolada en Lumbre la edición de la tarea ${input.taskId} (se aplicará al sincronizar).`);
        }
        catch (err) {
            return errorResult(err);
        }
    });
    const rescheduleTaskTool = server.registerTool('reschedule_task', {
        description: `Mueve una tarea existente a otro día, o a "Algún día"/Bandeja de entrada con date:null. ` +
            `Acepta también el id de una SUBTAREA (una subtarea con date:null se queda sin fecha en ` +
            `la checklist de su padre; no cae a la Bandeja). ${ASYNC_NOTE}`,
        inputSchema: {
            taskId: z.string().uuid().describe('Id de la tarea (ver list_tasks)'),
            date: z
                .union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.null()])
                .describe('Día destino, YYYY-MM-DD, o null para mandarla a "Algún día"/Bandeja de entrada')
        }
    }, async (input) => {
        try {
            // `allowSubtask: true` SIN condición sobre el payload (2026-09-04):
            // `date` es un accidental permitido en subtarea (docs/18 §2.5) y
            // desagendar una ya no la saca de la checklist de su padre — el
            // guard de `parentId` de `task-ops.unscheduleTask` entró en la app
            // en `a745235a`. Mismo valor que la tabla de `mutate_tasks`
            // (`TASK_TARGET_ALLOW_SUBTASK`, entrada `reschedule`).
            await requireTaskExists(ctx, input.taskId, { allowSubtask: true });
            await mutateTaskInvalidating(ctx, {
                taskId: input.taskId,
                kind: 'reschedule',
                payload: { date: input.date }
            });
            return textResult(`Encolado en Lumbre el cambio de fecha de la tarea ${input.taskId} a ` +
                `${input.date ?? '"Algún día"'} (se aplicará al sincronizar).`);
        }
        catch (err) {
            return errorResult(err);
        }
    });
    const deleteTaskTool = server.registerTool('delete_task', {
        description: `Borra (soft-delete) una tarea existente, o una SUBTAREA suya (borra solo esa). ACCIÓN ` +
            `DELICADA: sin confirmación inmediata ni deshacer — confírmalo con el usuario antes de ` +
            `llamarla. ${ASYNC_NOTE}`,
        inputSchema: {
            taskId: z.string().uuid().describe('Id de la tarea (o subtarea) a borrar (ver list_tasks/get_task)')
        }
    }, async (input) => {
        try {
            await requireTaskExists(ctx, input.taskId, { allowSubtask: true });
            await mutateTaskInvalidating(ctx, { taskId: input.taskId, kind: 'delete', payload: {} });
            return textResult(`Encolado en Lumbre el borrado de la tarea ${input.taskId} (se aplicará al sincronizar).`);
        }
        catch (err) {
            return errorResult(err);
        }
    });
    const setSectionTool = server.registerTool('set_section', {
        description: 'Mueve una tarea existente a una sección dentro de SU proyecto o área (se crea si no existe), o ' +
            'la saca con section:null. Se ignora si la tarea no tiene residencia propia. NO aplica a ' +
            'subtareas. ' + ASYNC_NOTE,
        inputSchema: {
            taskId: z.string().uuid().describe('Id de la tarea (ver list_tasks)'),
            section: z
                .string()
                .max(200)
                .nullable()
                .describe('Nombre de la sección destino dentro del proyecto o área de la tarea (se crea si no existe). ' +
                'null = quitarla de su sección actual.')
        }
    }, async (input) => {
        try {
            await requireTaskExists(ctx, input.taskId, { allowSubtask: false });
            await mutateTaskInvalidating(ctx, {
                taskId: input.taskId,
                kind: 'setSection',
                payload: { section: input.section }
            });
            return textResult(`Encolado en Lumbre: mover la tarea ${input.taskId} a la sección ` +
                `${input.section === null ? '(ninguna)' : `"${input.section}"`} (se aplicará al sincronizar).`);
        }
        catch (err) {
            return errorResult(err);
        }
    });
    const removeSectionTool = server.registerTool('remove_section', {
        description: 'Borra una sección dentro de un proyecto o área; sus tareas no se borran, solo quedan sueltas ' +
            'en el MISMO contenedor. Resuelve `sectionId` desde una tarea que viva ahí ' +
            '(list_tasks/get_task); si no existe, se ignora. ' + ASYNC_NOTE,
        inputSchema: {
            sectionId: z
                .string()
                .uuid()
                .describe('Id de la sección a borrar (ver el campo `sectionId` de una tarea que viva en ella, en list_tasks/get_task)')
        }
    }, async (input) => {
        try {
            await mutateTaskInvalidating(ctx, {
                taskId: input.sectionId,
                kind: 'removeSection',
                payload: { sectionId: input.sectionId }
            });
            return textResult(`Encolado en Lumbre el borrado de la sección ${input.sectionId} (se aplicará al sincronizar).`);
        }
        catch (err) {
            return errorResult(err);
        }
    });
    // ── Gestión de proyectos y áreas (paridad UI↔MCP, docs/20-contrato-lista.md) ──
    //
    // `create_list`/`nest_list`/`rename_list`/`remove_list`/`move_to_list` NO
    // tienen tool suelta desde el 2026-08-27 (podadas: 3.506 bytes de
    // `tools/list`, 5 tools por 19 llamadas/mes de uso real medido sobre un
    // mes de transcripts): son las ops del mismo nombre en `mutate_tasks`
    // (`mutateTasksOpSchema`/`mutateTasksStrictOpSchema`/`translateOp`), que ya
    // las implementaba entero — `create_list.listId` es incluso un
    // SUPERCONJUNTO (encadenar dentro del mismo lote, cosa que la tool suelta
    // no tenía). Identidad = el id, no el nombre (`rename_list` no la
    // cambia). `remove_list` nunca pierde tareas (se reasignan) ni permite
    // borrar la última lista viva ni la Bandeja de entrada canónica (§5
    // "Prohibidos" del contrato). Detalle completo del contrato de lista en
    // `docs/20-contrato-lista.md`.
    const addSubtaskTool = server.registerTool('add_subtask', {
        description: `Añade subtareas (checklist) a una tarea existente. Un solo nivel: si \`taskId\` ya ` +
            `es subtarea, se descarta en silencio. Para crearlas junto con la tarea, usa add_task ` +
            `con \`subtasks\`. ${ASYNC_NOTE}`,
        inputSchema: {
            taskId: z.string().uuid().describe('Id de la tarea PADRE (ver list_tasks)'),
            subtasks: z
                .array(z.string())
                .min(1)
                .max(50)
                .describe('Textos de las subtareas a añadir, en orden (cada uno se recorta a 500 caracteres)')
        }
    }, async (input) => {
        try {
            // `allowSubtask: true` (no relaja nada nuevo): si `taskId` YA es una
            // subtarea, esto solo evita adelantar el rechazo aquí — el
            // materializador (`task-ops`/`inbound-materialize.ts`) descarta la
            // mutación en silencio de todas formas, comportamiento YA documentado
            // arriba y sin cambios por este fix.
            await requireTaskExists(ctx, input.taskId, { allowSubtask: true });
            await mutateTaskInvalidating(ctx, {
                taskId: input.taskId,
                kind: 'addSubtask',
                payload: { subtasks: input.subtasks }
            });
            return textResult(`Encolado en Lumbre: ${input.subtasks.length} subtarea(s) para la tarea ${input.taskId} ` +
                '(se aplicará al sincronizar).');
        }
        catch (err) {
            return errorResult(err);
        }
    });
    const completeSubtaskTool = server.registerTool('complete_subtask', {
        description: `Marca hecha (o desmarca con done:false) una SUBTAREA por su id — mismo mecanismo que ` +
            `complete_task, sin cascada sobre la tarea padre. Resuelve \`subtaskId\` con ` +
            `get_task(taskId) de su padre. ${ASYNC_NOTE}`,
        inputSchema: {
            subtaskId: z.string().uuid().describe('Id de la subtarea (ver get_task de su tarea padre)'),
            done: z.boolean().optional().describe('true = completar (default); false = desmarcar')
        }
    }, async (input) => {
        try {
            await requireTaskExists(ctx, input.subtaskId, { allowSubtask: true });
            await mutateTaskInvalidating(ctx, {
                taskId: input.subtaskId,
                kind: 'complete',
                payload: { done: input.done ?? true }
            });
            return textResult(`Encolado en Lumbre: ${input.done === false ? 'desmarcar' : 'completar'} la subtarea ` +
                `${input.subtaskId} (se aplicará al sincronizar).`);
        }
        catch (err) {
            return errorResult(err);
        }
    });
    return {
        addTaskTool,
        listTasksTool,
        getTaskTool,
        completeTaskTool,
        cancelTaskTool,
        updateTaskTool,
        rescheduleTaskTool,
        deleteTaskTool,
        setSectionTool,
        removeSectionTool,
        addSubtaskTool,
        completeSubtaskTool
    };
}
//# sourceMappingURL=tasks.js.map