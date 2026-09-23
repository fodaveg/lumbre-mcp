import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { LumbreApiError, listBrlEntries, mutateTask } from '../lumbre-client.js';
import { errorResult, formatOpShapeError, formatOutcomeReport, OUTCOME_NOTE, textResult } from './shared.js';
/**
 * Las cuatro tools de BRL (`list_brl_entries` + los tres verbos) son el espejo,
 * para el REGISTRO, de lo que `list_tasks`/`add_task`/`update_task`/
 * `delete_task` son para las tareas. Dos avisos que valen para las cuatro:
 *
 *  - El registro NO son tareas. Una entrada `-`/`=` es un apunte de diario del
 *    día ("he comprado el pan", "igual conviene madrugar"), no algo que hacer:
 *    no se completa, no se reprograma y no sale en `list_tasks`. Si lo que el
 *    usuario quiere es algo que hacer, la tool es `add_task`.
 *  - El add-on puede estar APAGADO en la cuenta; entonces las cuatro fallan con
 *    un error explícito y no se encola nada.
 *
 * `update_brl_entry`/`delete_brl_entry` necesitan el id de la entrada, y la
 * ÚNICA forma de conseguirlo es `list_brl_entries` (la nota completa en
 * Markdown que sirve el mismo endpoint no lleva ids a propósito).
 */
const BRL_DATE = 'Día del registro, YYYY-MM-DD';
/**
 * Mismo par de schemas que `mutateTasksOpSchema`/`mutateTasksStrictOpSchema`
 * (ver su JSDoc en `tools/batch.ts` para el porqué de tenerlos separados),
 * pero para las 3 ops del BRL (`add`/`update`/`delete`, podadas de
 * `add_brl_entry`/`update_brl_entry`/`delete_brl_entry` el 2026-08-27 — ver
 * el bloque «BRL» de `registerBrlTools`). `mutateBrlStrictOpSchema`
 * (INTERNO, nunca se serializa): las 3 formas por-op EXACTAS que tenían las
 * tres tools sueltas, `.strict()` cada una — el handler de `mutate_brl` la
 * usa para re-validar cada elemento de `ops` antes de tocar red, igual que
 * `mutate_tasks` con la suya. `mutateBrlOpSchema` (EXPUESTO, más abajo): un
 * objeto plano con los 5 campos que usan las 3 ops, todos opcionales salvo
 * `op`/`date` (`date` es obligatorio en las 3, así que no gana nada quedando
 * opcional). A diferencia de `mutateTasksOpSchema` (16 ops, 22 campos), aquí
 * el ahorro de aplanar es pequeño — 3 ops con casi los mismos 2-3 campos cada
 * una— así que el peso real de este schema sale de medirlo (ver el test de
 * superficie en `index.test.ts`), no se asume solo por copiar el patrón.
 */
export const mutateBrlStrictOpSchema = z.discriminatedUnion('op', [
    z
        .object({
        op: z.literal('add'),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        text: z.string().min(1).max(2000),
        kind: z.enum(['note', 'thought']).optional(),
        time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional()
    })
        .strict(),
    z
        .object({
        op: z.literal('update'),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        entryId: z.string().guid(),
        text: z.string().min(1).max(2000),
        kind: z.enum(['note', 'thought']).optional()
    })
        .strict(),
    z
        .object({
        op: z.literal('delete'),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        entryId: z.string().guid()
    })
        .strict()
]);
export const mutateBrlOpSchema = z
    .object({
    op: z
        .enum(['add', 'update', 'delete'])
        .describe('Operación a ejecutar — contrato por-op en la description de `ops`'),
    date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe(BRL_DATE),
    entryId: z.string().guid().optional().describe('Id de la entrada (ver list_brl_entries)'),
    // `text`: sin describe propio — mismo criterio que `mutateTasksOpSchema`,
    // el contrato por-op (obligatorio en add/update, ajeno a delete) ya vive
    // en la description de `ops`.
    text: z.string().min(1).max(2000).optional(),
    kind: z.enum(['note', 'thought']).optional().describe('note = nota `-` (default); thought = pensamiento `=`'),
    time: z
        .string()
        .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
        .optional()
        .describe('Hora "HH:MM" (24h) — solo add; sin ella, hora del reloj si `date` es hoy')
})
    .strict();
/**
 * Familia «BRL» (add-on experimental): `list_brl_entries`/`mutate_brl`.
 * Extraída de `index.ts` tal cual (tarea de partir el servidor en
 * `src/tools/` por familia, 2026-09-17): cero cambios de comportamiento,
 * solo `config`/`brlCache` explícitos por `ctx` en vez de closure.
 */
export function registerBrlTools(server, ctx) {
    /**
     * Comprueba que `entryId` EXISTE en el registro de `date` antes de encolar una
     * edición o un borrado — gemelo de `requireTaskExists` para el BRL, y por el
     * MISMO motivo (el typo real de 2026-07-17): `/api/mutations` no valida el
     * target server-side, así que un id mal transcrito se encolaba igual, el
     * materializador lo descartaba en silencio y esta tool contestaba «Encolado…»
     * tan tranquila. Medido en local el 2026-08-09 sobre la 1ª versión de estas
     * tools: `delete_brl_entry` con un uuid inventado respondía «Encolado el
     * borrado» sin borrar nada.
     *
     * De aquí sale la razón de que `update_brl_entry`/`delete_brl_entry` pidan
     * `date` además del id: una entrada solo se puede buscar POR DÍA
     * (`GET /api/brl/:date`), no hay lookup por id suelto como el de las tareas
     * (`GET /api/tasks?id=`). El dato no le cuesta nada al modelo: viene en la
     * misma llamada a `list_brl_entries` de la que sacó el id.
     */
    async function requireBrlEntryExists(date, entryId) {
        // Caché corta (`brlCache`, ver `existence-cache.ts`), gemela de la de
        // `requireTaskExists`: si `entryId` ya se vio en un `list_brl_entries` de
        // ESE `date` dentro del TTL, no repetimos el `GET /api/brl/:date`.
        if (ctx.brlCache.has(date, entryId))
            return;
        const entries = await listBrlEntries(ctx.config, date);
        ctx.brlCache.setAll(date, entries);
        if (entries.some((entry) => entry.id === entryId))
            return;
        throw new Error(`El registro del ${date} no tiene ninguna entrada con id ${entryId} (¿se transcribió mal, o ` +
            'es de otro día?). Resuélvelo de nuevo con list_brl_entries. No se ha encolado nada.');
    }
    const listBrlEntriesTool = server.registerTool('list_brl_entries', {
        description: 'Lee el registro (BRL) de un día: entradas `-` (nota) y `=` (pensamiento), con id y hora. ' +
            'Única forma de obtener el id que pide mutate_brl (ops update/delete). No son tareas.',
        inputSchema: {
            date: z
                .string()
                .regex(/^\d{4}-\d{2}-\d{2}$/)
                .describe(BRL_DATE)
        }
    }, async (input) => {
        try {
            const entries = await listBrlEntries(ctx.config, input.date);
            ctx.brlCache.setAll(input.date, entries);
            if (entries.length === 0)
                return textResult(`El registro del ${input.date} está vacío.`);
            return textResult([
                `Registro del ${input.date} (${entries.length} entrada(s)):`,
                ...entries.map((e) => `${e.id}  ${e.time || '--:--'}  ${e.entry}`)
            ].join('\n'));
        }
        catch (err) {
            return errorResult(err);
        }
    });
    /**
     * Sustituye a `add_brl_entry`/`update_brl_entry`/`delete_brl_entry`
     * (podadas el 2026-08-27, cero llamadas medidas en un mes para las tres —
     * el BRL en sí NO se toca, David lo usa desde el móvil/web, fuera de esa
     * medición): mismo criterio de agrupar que `mutate_tasks`, pero SIN
     * `runBatch` — no hay `POST /api/batch` para el BRL (ese endpoint es solo
     * tareas, ver `BatchOp` en `lumbre-client.ts`), así que esto es un
     * `mutateTask`/`requireBrlEntryExists` por op, en el ORDEN pedido,
     * exactamente lo que hacía cada tool suelta — solo que en UNA tool call.
     * Éxito PARCIAL igual que `mutate_tasks`: una op que falla (forma
     * inválida o `entryId` inexistente) no aborta las siguientes.
     */
    const mutateBrlTool = server.registerTool('mutate_brl', {
        description: `Vía PREFERENTE (y desde el 2026-08-27, ÚNICA — sustituye a add/update/delete_brl_entry) ` +
            `para VARIAS entradas del registro (BRL) de golpe: añade, reescribe o borra en una sola ` +
            `llamada. Contrato por-op en la description de \`ops\`. Éxito PARCIAL: una op inválida no ` +
            `bloquea las demás — el resultado detalla qué falló por posición y el \`id\` de cada \`add\` ` +
            `encolado. La op \`delete\` es DELICADA: sin deshacer — confírmala con el usuario antes. ` +
            `${OUTCOME_NOTE}`,
        inputSchema: {
            ops: z
                .array(mutateBrlOpSchema)
                .min(1)
                .max(200)
                .describe('Operaciones a ejecutar, en el orden indicado (máx. 200 por llamada). Contrato por-op ' +
                '(`*` = obligatorio, el resto opcional): add: date*, text* [kind, time] · update: ' +
                'date*, entryId*, text* [kind] · delete: date*, entryId*')
        }
    }, async (input) => {
        const rawOps = input.ops;
        const results = [];
        // Resultado REAL de cada op aceptada y avisos de la app (MC1 del audit
        // de paridad, 23 sep 2026): `/api/mutations` devuelve `outcome`, y hasta
        // entonces se tiraba — un `not-found` salía como éxito.
        const outcomes = [];
        const notices = [];
        const record = (index, id, res) => {
            results.push({ index, ok: true, id });
            outcomes.push({ index, op: String(rawOps[index].op), outcome: res.outcome ?? 'unconfirmed' });
            for (const n of res.notices)
                if (!notices.includes(n))
                    notices.push(n);
        };
        for (let i = 0; i < rawOps.length; i++) {
            const raw = rawOps[i];
            const parsed = mutateBrlStrictOpSchema.safeParse(raw);
            if (!parsed.success) {
                results.push({ index: i, ok: false, error: formatOpShapeError(String(raw.op), parsed.error) });
                continue;
            }
            const op = parsed.data;
            try {
                if (op.op === 'add') {
                    // Id PRE-GENERADO aquí, igual que `add_brl_entry` (idempotencia de
                    // creación si el lote se reabre tras un fallo, ver `createBrlEntry`
                    // en el repo principal).
                    const entryId = randomUUID();
                    const res = await mutateTask(ctx.config, {
                        taskId: entryId,
                        kind: 'createBrlEntry',
                        payload: {
                            date: op.date,
                            entry: `${op.kind === 'thought' ? '=' : '-'} ${op.text}`,
                            ...(op.time !== undefined ? { time: op.time } : {})
                        }
                    });
                    record(i, entryId, res);
                }
                else if (op.op === 'update') {
                    await requireBrlEntryExists(op.date, op.entryId);
                    const res = await mutateTask(ctx.config, {
                        taskId: op.entryId,
                        kind: 'updateBrlEntry',
                        payload: { entry: `${op.kind === 'thought' ? '=' : '-'} ${op.text}` }
                    });
                    ctx.brlCache.invalidate(op.date, op.entryId);
                    record(i, op.entryId, res);
                }
                else {
                    await requireBrlEntryExists(op.date, op.entryId);
                    const res = await mutateTask(ctx.config, { taskId: op.entryId, kind: 'removeBrlEntry', payload: {} });
                    ctx.brlCache.invalidate(op.date, op.entryId);
                    record(i, op.entryId, res);
                }
            }
            catch (err) {
                results.push({
                    index: i,
                    ok: false,
                    error: err instanceof LumbreApiError ? err.message : err instanceof Error ? err.message : String(err)
                });
            }
        }
        const okCount = results.filter((r) => r.ok).length;
        const idLines = results
            .filter((r) => r.ok)
            .map((r) => `  [${r.index}] ${String(rawOps[r.index].op)}: id ${r.id}`);
        const failureLines = results
            .filter((r) => !r.ok)
            .map((r) => `  [${r.index}] ${String(rawOps[r.index].op)}: ${r.error}`);
        let summary = `Lumbre: ${okCount}/${rawOps.length} operación(es) encoladas.`;
        const outcomeReport = formatOutcomeReport(outcomes, notices);
        if (outcomeReport !== '')
            summary += `\n${outcomeReport}`;
        if (idLines.length > 0)
            summary += `\nids asignados:\n${idLines.join('\n')}`;
        if (failureLines.length > 0)
            summary += `\n${failureLines.length} fallaron:\n${failureLines.join('\n')}`;
        return textResult(summary);
    });
    return { listBrlEntriesTool, mutateBrlTool };
}
//# sourceMappingURL=brl.js.map