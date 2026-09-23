import { z } from 'zod';
import { LumbreApiError } from '../lumbre-client.js';
/** Respuesta de texto plano — la forma que usan casi todas las tools. */
export function textResult(text) {
    return { content: [{ type: 'text', text }] };
}
/** Respuesta de error uniforme: mensaje de `LumbreApiError`/`Error` tal cual,
 *  o `String(err)` para cualquier otra cosa lanzada. */
export function errorResult(err) {
    const message = err instanceof LumbreApiError ? err.message : err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}
/**
 * Frase compartida por las descriptions de `mutate_tasks`/`organize`/
 * `mutate_brl`: qué dice el informe que devuelven.
 *
 * Sustituye el 23 sep 2026 a `ASYNC_NOTE` («se encola y se aplica al
 * sincronizar, sin confirmación inmediata»), que era falsa desde que la app
 * drena en el servidor en la misma petición y devuelve el resultado por op
 * (`materialization` en `/api/batch`, `outcome` en `/api/mutations`). MC1 y
 * MC9 del audit de paridad. Versión CORTA a propósito: se paga en
 * `tools/list` tres veces.
 */
export const OUTCOME_NOTE = 'El informe dice por op si la app la aplicó, no tuvo efecto o falló.';
/** Nombre corto para el recuento, en el orden en que se pinta. */
const OUTCOME_COUNT_LABEL = {
    applied: 'aplicadas',
    noop: 'sin efecto',
    'not-found': 'sin objetivo',
    failed: 'fallidas al aplicar',
    quarantined: 'en cuarentena',
    queued: 'pendientes de aplicar',
    unconfirmed: 'sin confirmar'
};
/** Qué significa cada estado que NO es `applied`, para la línea por op. */
const OUTCOME_DETAIL = {
    noop: 'sin efecto: la app no cambió nada (ya estaba así, o el objetivo no admite el cambio)',
    'not-found': 'sin efecto: la app no encontró el objetivo (inexistente, borrado o archivado)',
    failed: 'falló al aplicarse; la app la reintentará en un drenaje posterior',
    quarantined: 'retenida en cuarentena por la app para revisión; no se ha aplicado',
    queued: 'aceptada pero sin aplicar (cuarentena o fallo al drenar); relee antes de darla por hecha',
    unconfirmed: 'encolada; este servidor no dice si se aplicó, relee para comprobarlo'
};
/**
 * Bloque del informe con el resultado REAL de las ops aceptadas y los avisos
 * de la app (MC1 del audit de paridad, 23 sep 2026: hasta entonces los tres
 * informes decían «encoladas» y el modelo leía un no-op o un fallo del
 * drenaje como éxito). Compartido por `mutate_tasks`/`organize`
 * (`tools/batch.ts`) y `mutate_brl` (`tools/brl.ts`).
 *
 * Forma: una línea de recuento («aplicadas» siempre, el resto solo si hay),
 * una línea por op que NO se aplicó con su índice, y los avisos. Vacío si no
 * hay ninguna op aceptada ni avisos.
 */
export function formatOutcomeReport(entries, notices) {
    const lines = [];
    if (entries.length > 0) {
        const counts = new Map();
        for (const e of entries)
            counts.set(e.outcome, (counts.get(e.outcome) ?? 0) + 1);
        const parts = Object.keys(OUTCOME_COUNT_LABEL)
            .filter((o) => o === 'applied' || (counts.get(o) ?? 0) > 0)
            .map((o) => `${counts.get(o) ?? 0} ${OUTCOME_COUNT_LABEL[o]}`);
        lines.push(`Resultado en la app: ${parts.join(', ')}.`);
        const notApplied = entries
            .filter((e) => e.outcome !== 'applied')
            .sort((a, b) => a.index - b.index)
            .map((e) => `  [${e.index}] ${e.op}: ${OUTCOME_DETAIL[e.outcome]}`);
        if (notApplied.length > 0)
            lines.push(`sin aplicar:\n${notApplied.join('\n')}`);
    }
    if (notices.length > 0) {
        lines.push(`avisos de la app:\n${notices.map((n) => `  - ${n}`).join('\n')}`);
    }
    return lines.join('\n');
}
/**
 * Mapa op → tool que la implementa, con las 16 ops de tarea repartidas entre
 * las DOS tools de lote (2026-09-19, tarea 6f62c877): `mutate_tasks` opera
 * sobre UNA tarea (`add_task`/`complete`/`cancel`/`update`/`reschedule`/
 * `set_section`/`add_subtask`/`complete_subtask`) y `organize` reorganiza y
 * borra (`delete`/`remove_section`/`create_list`/`nest_list`/`rename_list`/
 * `remove_list`/`set_list_notes`/`move_to_list`). Se consulta en los DOS
 * sentidos: cada tool usa el mapa para señalar a la otra cuando recibe una op
 * ajena (ver `formatOpShapeError`, justo debajo), así que un modelo que
 * mande `delete` a `mutate_tasks` lee dónde vive de verdad en vez de un
 * "discriminador inválido" a secas.
 */
export const TASK_OP_TOOL = {
    add_task: 'mutate_tasks',
    complete: 'mutate_tasks',
    cancel: 'mutate_tasks',
    update: 'mutate_tasks',
    reschedule: 'mutate_tasks',
    set_section: 'mutate_tasks',
    add_subtask: 'mutate_tasks',
    complete_subtask: 'mutate_tasks',
    delete: 'organize',
    remove_section: 'organize',
    create_list: 'organize',
    nest_list: 'organize',
    rename_list: 'organize',
    remove_list: 'organize',
    set_list_notes: 'organize',
    move_to_list: 'organize'
};
/**
 * Mensaje legible para un elemento de `ops` que no encaja en la forma
 * ESTRICTA de su `op` (`mutateTasksStrictOpSchema`/`organizeStrictOpSchema`/
 * `mutateBrlStrictOpSchema`, ver `tools/batch.ts`/`tools/brl.ts`): identifica
 * la op y, campo a campo, qué falta o qué sobra — para que el modelo pueda
 * corregir ESE elemento concreto sin adivinar cuál campo venía mal.
 * Compartida por `mutate_tasks`, `organize` y `mutate_brl`: la forma del
 * mensaje no depende de qué dominio mutan.
 *
 * `tool` (opcional, las dos tools de tarea lo pasan): si la op EXISTE pero es
 * de la OTRA tool, el mensaje deja de ser el volcado de Zod y pasa a ser el
 * puntero del mapa `TASK_OP_TOOL` — el único fallo de forma cuya corrección
 * no es tocar un campo, sino cambiar de tool.
 */
export function formatOpShapeError(op, error, tool) {
    const owner = TASK_OP_TOOL[op];
    if (tool !== undefined && owner !== undefined && owner !== tool) {
        return `la op "${op}" no existe en ${tool}; está en ${owner} — mándala en una llamada a ${owner}.`;
    }
    return formatZodOpShapeError(op, error);
}
/** Volcado campo a campo de un `ZodError` de forma (el caso normal de
 *  `formatOpShapeError`, separado para que el puntero op→tool de arriba se
 *  lea de un vistazo). */
function formatZodOpShapeError(op, error) {
    const parts = error.issues.map((issue) => {
        if (issue.code === 'unrecognized_keys') {
            return `campo(s) que no aplican a "${op}": ${issue.keys.join(', ')}`;
        }
        const field = issue.path.length > 0 ? issue.path.join('.') : '(op)';
        return `${field}: ${issue.message}`;
    });
    return `${op}: ${parts.join('; ')}`;
}
/**
 * Campos de una regla de repetición, la forma COMPLETA que acepta la app
 * (`Recurrence` de `$lib/recurrence` en el repo principal, normalizada por
 * `normalizeRecurrence`). Hasta el 23 sep 2026 aquí solo había `freq` e
 * `interval` y Zod borraba el resto sin avisar (MC3 del audit de paridad).
 * `.describe()` solo donde el nombre no basta: cada carácter se paga en
 * `tools/list`, y este esquema aparece en `add_task` y en `mutate_tasks`.
 */
const recurrenceFields = {
    mode: z.enum(['calendar', 'afterCompletion']).optional().describe('afterCompletion: cuenta desde que la completas'),
    freq: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
    interval: z.number().int().positive().optional().describe('Cada cuántas unidades (default 1)'),
    byWeekday: z.array(z.number().int().min(0).max(6)).min(1).optional().describe('Solo weekly: 0=lunes … 6=domingo'),
    until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Último día, inclusive'),
    count: z.number().int().positive().optional().describe('Máximo de ocurrencias'),
    streak: z.boolean().optional().describe('true = hábito (cuenta racha)')
};
/**
 * Regla ENTERA, para CREAR (`add_task` de `tools/tasks.ts` y la op `add_task`
 * de `mutate_tasks`). `.strict()`: un campo que la app no conoce falla en voz
 * alta en vez de desaparecer, que es justo lo que ocultaba MC3.
 */
export const recurrenceSchema = z.object(recurrenceFields).strict();
/**
 * Campos de un cambio PARCIAL de regla (op `update` de `mutate_tasks`): todo
 * opcional, y `null` quita `byWeekday`/`until`/`count`. La fusión con la
 * regla vigente la hace `mergeRecurrencePatch` (`lumbre-client.ts`).
 */
const recurrencePatchFields = {
    ...recurrenceFields,
    freq: recurrenceFields.freq.optional(),
    byWeekday: z.union([recurrenceFields.byWeekday.unwrap(), z.null()]).optional(),
    until: z.union([recurrenceFields.until.unwrap(), z.null()]).optional(),
    count: z.union([recurrenceFields.count.unwrap(), z.null()]).optional()
};
/** Cambio parcial ESTRICTO, para el schema interno de la op `update`. */
export const recurrencePatchSchema = z.object(recurrencePatchFields).strict();
/**
 * Versión que EXPONE `mutate_tasks` (un solo campo `recurrence` para sus dos
 * ops, `add_task` y `update`): laxa, con `freq` opcional y `.passthrough()`,
 * para que un fallo de forma no tumbe el lote entero en el framework y llegue
 * al schema estricto de su op, que lo reporta por posición (ver la cabecera
 * de `tools/batch.ts`).
 */
export const exposedRecurrenceSchema = z
    .object(recurrencePatchFields)
    .passthrough()
    .describe('Al crear, freq obligatorio. En update solo cambia lo enviado; null quita byWeekday/until/count');
/** Forma de un tag propio — compartida por `tools/tasks.ts` (`add_task`) y
 *  `tools/batch.ts` (`mutateTasksOpSchema.tags`, ops `add_task`/`update`). */
export const tagSchema = z.string().regex(/^[\p{L}\p{N}_][\p{L}\p{N}_-]*$/u);
//# sourceMappingURL=shared.js.map