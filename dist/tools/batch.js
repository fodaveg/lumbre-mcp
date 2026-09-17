import { z } from 'zod';
import { buildBatchFromOps, collectExistenceCheckIds, excludeIngestForBrokenListPromises, filterPhase2AfterPhase1, findTasksByIds, planBatchPhases, runBatch } from '../lumbre-client.js';
import { ASYNC_NOTE, errorResult, formatOpShapeError, recurrenceSchema, tagSchema, textResult } from './shared.js';
/**
 * `mutate_tasks` usa DOS schemas de las mismas 15 formas por-op, no uno
 * (medido: aplanar `ops.items` bajó su JSON Schema EXPUESTO de 7.638 a ~3.1k
 * caracteres — el 27% de toda la superficie de `tools/list` — ver la tarea
 * que lo motivó, 2026-07-25):
 *
 * - `mutateTasksOpSchema` (EXPUESTO, más abajo): UN objeto plano con los 22
 *   campos que usan las 16 ops, TODOS opcionales, cada uno con su
 *   `.describe()` UNA sola vez. Antes esto era un `z.discriminatedUnion` de
 *   15 ramas casi idénticas → `anyOf` con los mismos campos y las mismas
 *   descripciones repetidas 15 veces en el JSON Schema que ve el modelo. El
 *   contrato real por-op (qué campo es obligatorio/ajeno a cada `op`) YA NO
 *   vive en el tipo expuesto: vive en la `description` de `ops` (tabla
 *   compacta, `*` = obligatorio) y en el README ("Ejecutar varias
 *   operaciones a la vez").
 * - `mutateTasksStrictOpSchema` (INTERNO — NO forma parte de `inputSchema`,
 *   nunca se serializa): las MISMAS 15 formas por-op de siempre, con los
 *   MISMOS tipos y la MISMA obligatoriedad que tenía cada rama del
 *   `discriminatedUnion` de antes, cada una `.strict()` (rechaza cualquier
 *   campo ajeno a esa op). El handler de `mutate_tasks`, más abajo, la usa
 *   para re-validar cada elemento de `ops` ANTES de tocar red — así
 *   `{op:'complete', date:'2026-01-01'}` (campo `date` ajeno a `complete`)
 *   SIGUE fallando exactamente igual que antes. La diferencia es DÓNDE: con
 *   el `discriminatedUnion` expuesto, una op mal formada tumbaba el
 *   `mutate_tasks` ENTERO en el framework (`validateToolInput`), antes de
 *   que el handler viera nada; ahora entra en el mismo informe de "éxito
 *   parcial" que ya existía para un `taskId` inexistente — se reporta esa
 *   op concreta y las demás, si son válidas, se encolan igual. Mejora de
 *   comportamiento, no solo de tamaño.
 *
 * `create_list.listId` (encadenar dentro del MISMO lote, sin depender de la
 * respuesta): dale tú mismo un uuid v4 al crearla y úsalo en el
 * `move_to_list`/`nest_list` que la targetee en OTRA op del mismo lote —
 * detalle completo (antes en la `.describe()` de esa variante, 335
 * caracteres que solo importan una vez, no repetidos por tool call) movido
 * al README.
 */
export const mutateTasksStrictOpSchema = z.discriminatedUnion('op', [
    z
        .object({
        op: z.literal('add_task'),
        text: z.string().min(1).max(2000),
        list: z.string().max(200).optional(),
        listId: z.string().uuid().optional(),
        section: z.string().max(200).optional(),
        priority: z.enum(['p1', 'p2', 'p3', 'p4']).optional(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        tags: z.array(tagSchema).optional(),
        time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
        recurrence: recurrenceSchema.optional(),
        subtasks: z.array(z.string()).optional(),
        notes: z.string().max(10000).optional()
    })
        .strict(),
    z
        .object({
        op: z.literal('complete'),
        taskId: z.string().uuid(),
        done: z.boolean().optional()
    })
        .strict(),
    z
        .object({
        op: z.literal('cancel'),
        taskId: z.string().uuid(),
        cancelled: z.boolean().optional()
    })
        .strict(),
    z
        .object({
        op: z.literal('update'),
        taskId: z.string().uuid(),
        content: z.string().min(1).max(2000).optional(),
        notes: z.string().max(10000).optional(),
        tags: z.array(tagSchema).optional(),
        priority: z.enum(['p1', 'p2', 'p3', 'p4']).optional(),
        time: z.union([z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), z.null()]).optional()
    })
        .strict(),
    z
        .object({
        op: z.literal('reschedule'),
        taskId: z.string().uuid(),
        date: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.null()])
    })
        .strict(),
    z
        .object({
        op: z.literal('delete'),
        taskId: z.string().uuid()
    })
        .strict(),
    z
        .object({
        op: z.literal('set_section'),
        taskId: z.string().uuid(),
        section: z.string().max(200).nullable()
    })
        .strict(),
    z
        .object({
        op: z.literal('move_to_list'),
        taskId: z.string().uuid(),
        listId: z.union([z.string().uuid(), z.null()]).optional(),
        list: z.string().max(200).optional()
    })
        .strict(),
    z
        .object({
        op: z.literal('add_subtask'),
        taskId: z.string().uuid(),
        subtasks: z.array(z.string()).min(1).max(50)
    })
        .strict(),
    z
        .object({
        op: z.literal('complete_subtask'),
        subtaskId: z.string().uuid(),
        done: z.boolean().optional()
    })
        .strict(),
    z
        .object({
        op: z.literal('remove_section'),
        sectionId: z.string().uuid()
    })
        .strict(),
    z
        .object({
        op: z.literal('create_list'),
        name: z.string().min(1).max(200),
        color: z.string().max(20).optional(),
        icon: z.string().max(16).optional(),
        listId: z.string().uuid().optional()
    })
        .strict(),
    z
        .object({
        op: z.literal('nest_list'),
        listId: z.string().uuid(),
        parentId: z.union([z.string().uuid(), z.null()])
    })
        .strict(),
    z
        .object({
        op: z.literal('rename_list'),
        listId: z.string().uuid(),
        name: z.string().min(1).max(200)
    })
        .strict(),
    z
        .object({
        op: z.literal('remove_list'),
        listId: z.string().uuid()
    })
        .strict(),
    z
        .object({
        op: z.literal('set_list_notes'),
        listId: z.string().uuid(),
        notes: z.string().max(10000).nullable(),
        revive: z.boolean().optional()
    })
        .strict()
]);
/**
 * Schema EXPUESTO de un elemento de `ops` (ver el JSDoc de
 * `mutateTasksStrictOpSchema` de arriba para el porqué de tenerlos
 * separados): plano, los campos que usan las 16 ops TODOS opcionales
 * (salvo `op`). Poda de superficie (2026-08-25, medido: bajó el JSON Schema
 * EXPUESTO de este objeto de 3.994 a 3.683 caracteres — ver el test de
 * superficie en `index.test.ts`): cada campo tiene `.describe()` SOLO si
 * aporta algo que el nombre del campo + su
 * tipo/patrón no dicen ya (semántica de `null`, default al omitir, o el
 * comportamiento no obvio de un campo como `list`/`notes`) — `text`,
 * `content`, `name`, `deadline`, `icon` y `recurrence` se quedan sin
 * `.describe()` propio porque esa info ya vive en el nombre del campo, en
 * `recurrenceSchema`, o en la tool individual (`create_list` para `icon`).
 * `.strict()` aquí solo pilla un nombre de campo desconocido (typo); que un campo válido en general no aplique a la `op`
 * concreta de ESE elemento lo pilla `mutateTasksStrictOpSchema` en el
 * handler, no este schema.
 */
export const mutateTasksOpSchema = z
    .object({
    op: z
        .enum([
        'add_task',
        'complete',
        'cancel',
        'update',
        'reschedule',
        'delete',
        'set_section',
        'move_to_list',
        'add_subtask',
        'complete_subtask',
        'remove_section',
        'create_list',
        'nest_list',
        'rename_list',
        'remove_list',
        'set_list_notes'
    ])
        .describe('Operación a ejecutar — contrato por-op en la description de `ops`'),
    taskId: z.string().uuid().optional().describe('Id de la tarea — ver list_tasks/get_task'),
    subtaskId: z.string().uuid().optional().describe('Id de la subtarea — ver get_task de su tarea padre'),
    sectionId: z.string().uuid().optional().describe('Id de la sección — ver list_tasks/get_task'),
    listId: z
        .union([z.string().uuid(), z.null()])
        .optional()
        .describe('Id del proyecto o área: destino, padre, o uno generado para encadenar con create_list'),
    // `text`/`content`/`name`/`deadline`: sin describe propio — el nombre
    // del campo ya lo dice todo (texto de la tarea nueva o su nuevo
    // texto/título, nombre de la lista, fecha límite) y no hay semántica
    // extra (null, default, autocreación…) que documentar; qué op usa cuál
    // ya está en la description de `ops`.
    text: z.string().min(1).max(2000).optional(),
    content: z.string().min(1).max(2000).optional(),
    tags: z.array(tagSchema).optional(),
    name: z.string().min(1).max(200).optional(),
    list: z.string().max(200).optional().describe('Nombre del proyecto o área destino (se crea como proyecto si no existe)'),
    section: z.string().max(200).nullable().optional().describe('Nombre de la sección, o null para quitarla'),
    notes: z
        .union([z.string().max(10000), z.null()])
        .optional()
        .describe('Notas (reemplaza las anteriores enteras; null las borra en set_list_notes)'),
    priority: z.enum(['p1', 'p2', 'p3', 'p4']).optional().describe('p1 = más urgente … p4 = ninguna'),
    date: z
        .union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.null()])
        .optional()
        .describe('YYYY-MM-DD, o null para "Algún día"/Bandeja de entrada'),
    deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    time: z
        .union([z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), z.null()])
        .optional()
        .describe('24h; null la quita'),
    // `recurrence`: sin describe propio — `recurrenceSchema` ya documenta
    // `freq`/`interval` campo a campo (compartido con `add_task`).
    recurrence: recurrenceSchema.optional(),
    subtasks: z.array(z.string()).optional().describe('Textos de las subtareas, en orden'),
    done: z.boolean().optional().describe('true = completar (default); false = desmarcar'),
    cancelled: z.boolean().optional().describe('true = cancelar (default); false = restaurar'),
    color: z.string().max(20).optional().describe('red|amber|green|blue|violet|pink, o un hex libre "#rrggbb"'),
    revive: z.boolean().optional().describe('true restaura una nota de proyecto o área borrada previamente'),
    // `icon`: sin describe propio — mismo criterio que `text`/`name`; su
    // semántica (emoji/icono del proyecto o área) ya la dice el nombre del campo.
    icon: z.string().max(16).optional(),
    parentId: z.union([z.string().uuid(), z.null()]).optional().describe('Id del proyecto o área padre, o null para desanidar')
})
    .strict();
/**
 * Familia «lote de tareas» (`plan-batch.md`): UNA sola tool, `mutate_tasks`
 * — N operaciones de golpe en UNA sola tool call. Extraída de `index.ts`
 * tal cual (última familia de la tarea de partir el servidor en
 * `src/tools/`, 2026-09-17, la de mayor riesgo por su tamaño y por planificar
 * fases): cero cambios de comportamiento, solo `config`/`taskCache`
 * explícitos por `ctx` en vez de closure.
 */
export function registerBatchTool(server, ctx) {
    const mutateTasksTool = server.registerTool('mutate_tasks', {
        description: `Vía PREFERENTE para VARIAS operaciones de golpe (crear y/o mutar): resuelve existencias y ` +
            `encola en UNA sola llamada, en vez de una tool call por operación. Cada elemento de \`ops\` ` +
            `equivale a su tool individual (mapeo op↔tool en el README) — salvo las ops de proyecto/área, sin ` +
            `tool suelta desde el 2026-08-27: mutate_tasks es su ÚNICA vía. Contrato por-op en la ` +
            `description de \`ops\`. Éxito PARCIAL: una op inválida no bloquea las ` +
            `demás — el resultado detalla qué falló por posición y el \`id\` de cada una encolada ` +
            `(create_list→listId, add_task→taskId). Encadenar un create_list con otra op del MISMO lote: ` +
            `dale tú el \`listId\` (uuid v4) al crearla. ${ASYNC_NOTE}`,
        inputSchema: {
            ops: z
                .array(mutateTasksOpSchema)
                .min(1)
                .max(200)
                .describe('Operaciones a ejecutar, en el orden indicado (máx. 200 por llamada). Contrato por-op ' +
                '(`*` = obligatorio, el resto opcional): add_task: text* [list|listId, section, ' +
                'priority, date, deadline, time, recurrence, subtasks, notes, tags] · complete: taskId* ' +
                '[done] · cancel: taskId* [cancelled] · update: taskId*, ≥1 de [content, notes, tags, ' +
                'priority, time] · reschedule: taskId*, date* · delete: taskId* · set_section: ' +
                'taskId*, section* · move_to_list: taskId*, uno de [listId, list] · add_subtask: ' +
                'taskId*, subtasks* · complete_subtask: subtaskId* [done] · remove_section: sectionId* ' +
                '· create_list: name* [color, icon, listId] · nest_list: listId*, parentId* · ' +
                'rename_list: listId*, name* · remove_list: listId* · set_list_notes: listId*, notes* [revive]')
        }
    }, async (input) => {
        try {
            // Re-validación ESTRICTA por-op ANTES de tocar red: `mutateTasksOpSchema`
            // (el schema EXPUESTO) es deliberadamente laxo, así que un elemento cuya
            // forma no encaje con SU `op` (campo obligatorio ausente, o un campo
            // válido en general pero ajeno a esa op) todavía no se ha rechazado en
            // este punto — ver el JSDoc de `mutateTasksStrictOpSchema`. Se reporta
            // como un fallo MÁS del informe de éxito parcial (mismo array que
            // `taskId` inexistente), no tumba el `mutate_tasks` entero.
            const rawOps = input.ops;
            const validated = [];
            // Índice, dentro de `validated` (compactado, sin los descartados por
            // forma), de la posición ORIGINAL en `input.ops` — mismo patrón de
            // indirección que ya usa `buildBatchFromOps` para `batchOps` vs `ops`,
            // aplicado un nivel más arriba.
            const validatedOriginalIndexes = [];
            const shapeFailures = [];
            // `listId` → primer `create_list` del lote que prometió esa lista y NO
            // llegó a mandarse (forma inválida o validación local) — agujero 🔴
            // cerrado en la revisión de este mismo fix: `planBatchPhases` solo ve
            // `batchOps` (lo que SOBREVIVIÓ), así que un `create_list` roto por
            // forma (p. ej. sin `name`) se colaba como "sin dependencia" y el
            // `add_task` con ese `listId` viajaba SOLO, huérfano — ver
            // `excludeIngestForBrokenListPromises`. Se queda con el índice ORIGINAL
            // más bajo si varios `create_list` prometen el mismo `listId`.
            const brokenListIds = new Map();
            function recordBrokenListId(listId, index, error) {
                if (typeof listId !== 'string')
                    return;
                const existing = brokenListIds.get(listId);
                if (existing === undefined || index < existing.index) {
                    brokenListIds.set(listId, { index, error });
                }
            }
            rawOps.forEach((raw, index) => {
                const result = mutateTasksStrictOpSchema.safeParse(raw);
                if (!result.success) {
                    const error = formatOpShapeError(String(raw.op), result.error);
                    shapeFailures.push({ index, error });
                    if (raw.op === 'create_list')
                        recordBrokenListId(raw.listId, index, error);
                    return;
                }
                validated.push(result.data);
                validatedOriginalIndexes.push(index);
            });
            const idsToCheck = collectExistenceCheckIds(validated);
            const existing = idsToCheck.length > 0 ? await findTasksByIds(ctx.config, idsToCheck) : new Map();
            ctx.taskCache.setAll(existing.values());
            const built = buildBatchFromOps(validated, existing);
            // `create_list` no tiene validación local NI de existencia hoy (no
            // targetea una tarea), así que en la práctica nunca cae aquí — pero si
            // algún día la tuviera, un descarte de `create_list` en `built.skipped`
            // rompe su promesa de `listId` exactamente igual que uno por forma.
            for (const s of built.skipped) {
                const op = validated[s.index];
                if (op.op === 'create_list' && op.listId !== undefined) {
                    recordBrokenListId(op.listId, validatedOriginalIndexes[s.index], s.error);
                }
            }
            const batchOps = built.batchOps;
            const originalIndexes = built.originalIndexes.map((i) => validatedOriginalIndexes[i]);
            // Incidente 071553: `POST /api/batch` del repo principal materializa
            // TODAS las ingestas antes que TODAS las mutaciones, sin mirar el
            // orden de `ops` — un `create_list` + N `add_task` con ese `listId`
            // en la MISMA llamada crea las tareas con la lista aún inexistente
            // (sin lista, fecha de HOY). Antes de planificar fases se excluyen las
            // altas cuya lista prometida YA se sabe rota (`brokenListIds`, arriba) —
            // esas NUNCA viajan, en ninguna fase. `planBatchPhases` reparte lo que
            // queda: detecta la dependencia PENDIENTE (un `create_list` que sí llegó
            // a `batchOps`, resultado aún desconocido) y, SOLO si existe, parte la
            // llamada en dos (ver su JSDoc); sin dependencia, `plan.phases` es un
            // único elemento tal cual — mismo coste de red que antes de este fix.
            const preFiltered = excludeIngestForBrokenListPromises(batchOps, originalIndexes, brokenListIds);
            const plan = planBatchPhases(preFiltered.batchOps, preFiltered.originalIndexes);
            let results;
            let resultOriginalIndexes;
            const phaseFailures = [];
            if (!plan.split) {
                const phase = plan.phases[0];
                results = phase.ops.length > 0 ? await runBatch(ctx.config, phase.ops) : [];
                resultOriginalIndexes = phase.originalIndexes;
            }
            else {
                const [mutatePhase] = plan.phases;
                const phase1Results = mutatePhase.ops.length > 0 ? await runBatch(ctx.config, mutatePhase.ops) : [];
                // Con el resultado REAL de la fase 1 ya se sabe qué `create_list`
                // salió `ok`: las altas que dependían de uno que falló NO se mandan
                // (nunca huérfanas con fecha de hoy) y entran en el informe como un
                // fallo más, citando la op `create_list` causante.
                const phase2 = filterPhase2AfterPhase1(plan, phase1Results);
                phaseFailures.push(...phase2.skipped);
                const phase2Results = phase2.ops.length > 0 ? await runBatch(ctx.config, phase2.ops) : [];
                results = [...phase1Results, ...phase2Results];
                resultOriginalIndexes = [...mutatePhase.originalIndexes, ...phase2.originalIndexes];
            }
            // Cualquier op 'mutate' del lote pudo tocar una tarea que ya estuviera
            // en `taskCache` (poblada arriba) — se invalida sin mirar el resultado
            // individual: barato, y evita servir un "existe" rancio si otra op del
            // MISMO lote la borró justo antes. No-op para las ops de lista/sección
            // (su `taskId` nunca estuvo cacheado aquí). Cubre las DOS fases: itera
            // sobre `batchOps` (el conjunto completo, previo al reparto), no sobre
            // las fases sueltas.
            for (const op of batchOps) {
                if (op.type === 'mutate')
                    ctx.taskCache.invalidate(op.taskId);
            }
            // Cinco fuentes de fallo ahora (forma inválida, descartadas ANTES de
            // mandar el batch por `buildBatchFromOps`, altas huérfanas descartadas
            // ANTES de planificar fases por `excludeIngestForBrokenListPromises`
            // — su `create_list` nunca llegó a mandarse —, altas huérfanas
            // descartadas entre fase 1 y fase 2 por `filterPhase2AfterPhase1` — su
            // `create_list` SÍ se mandó pero falló —, y las que el servidor rechazó
            // al validar/encolar) se combinan en un único informe, ordenado por
            // posición ORIGINAL en `ops` — el modelo ve exactamente qué operación
            // falló y por qué, sin tener que distinguir entre las fases. Las
            // EXITOSAS con `id` (code-review 🟠 #3a: antes se perdían — el modelo
            // no podía enterarse del `listId` de un `create_list` sin una
            // `list_tasks` de más) también se recogen, para poder encadenarlas en
            // un turno posterior (o confirmar el id que ya se auto-generó, si la
            // op no traía uno propio — ver `create_list`).
            const failures = [
                ...shapeFailures,
                ...built.skipped.map((s) => ({ index: validatedOriginalIndexes[s.index], error: s.error })),
                ...preFiltered.skipped,
                ...phaseFailures
            ];
            const succeededWithId = [];
            results.forEach((r, i) => {
                const index = resultOriginalIndexes[i];
                if (r.ok) {
                    if (r.id !== undefined)
                        succeededWithId.push({ index, id: r.id });
                }
                else {
                    failures.push({ index, error: r.error ?? 'error desconocido' });
                }
            });
            const okCount = results.filter((r) => r.ok).length;
            failures.sort((a, b) => a.index - b.index);
            succeededWithId.sort((a, b) => a.index - b.index);
            // `op` se lee del elemento CRUDO (`rawOps`), no de `validated` (que no
            // tiene entrada para los descartados por forma) — el schema EXPUESTO
            // ya garantiza que es uno de los 15 nombres válidos.
            const opNameAt = (index) => String(rawOps[index].op);
            const failureLines = failures.map((f) => `  [${f.index}] ${opNameAt(f.index)}: ${f.error}`);
            const idLines = succeededWithId.map((s) => `  [${s.index}] ${opNameAt(s.index)}: id ${s.id}`);
            let summary = `Lumbre: ${okCount}/${rawOps.length} operación(es) encoladas.`;
            if (idLines.length > 0)
                summary += `\nids asignados:\n${idLines.join('\n')}`;
            if (failureLines.length > 0) {
                summary += `\n${failureLines.length} fallaron:\n${failureLines.join('\n')}`;
            }
            summary += `\n\n${ASYNC_NOTE}`;
            return textResult(summary);
        }
        catch (err) {
            return errorResult(err);
        }
    });
    return { mutateTasksTool };
}
//# sourceMappingURL=batch.js.map