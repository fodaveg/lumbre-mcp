import { z } from 'zod';
import { getBlockAgenda, getUpcoming, LumbreApiError } from '../lumbre-client.js';
import { formatAgenda } from '../format.js';
import { errorResult, textResult } from './shared.js';
/**
 * Familia «agenda» (lote 2): `get_agenda`, lectura de eventos, tareas, hábitos y bloques
 * de Horario con dos peticiones: `/api/upcoming` (días o semana) y `/api/today?blocks=1`.
 * Ninguna de las dos acepta `spaceId`, por eso la tool no lo ofrece.
 */
export function registerAgendaTools(server, ctx) {
    const getAgendaTool = server.registerTool('get_agenda', {
        annotations: { readOnlyHint: true },
        description: 'Agenda desde hoy: eventos y tareas por día, y bloques de Horario de hoy sin terminar. ' +
            '`days` 1..14 (default 1) o `week:true` (semana en curso, con hábitos); no ambos.',
        inputSchema: {
            days: z.number().int().min(1).max(14).optional(),
            week: z.boolean().optional()
        }
    }, async (input) => {
        try {
            if (input.week && input.days !== undefined) {
                return errorResult(new Error('Pasa days o week, no los dos.'));
            }
            const upcoming = await getUpcoming(ctx.config, input.week ? { week: true } : { days: input.days ?? 1 });
            // Los bloques son accesorios: si fallan (salvo 401) la tool responde igual y lo dice.
            let blocks;
            try {
                blocks = await getBlockAgenda(ctx.config);
            }
            catch (err) {
                if (err instanceof LumbreApiError && err.status === 401)
                    throw err;
                const reason = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim();
                blocks = reason.length > 100 ? `${reason.slice(0, 97)}...` : reason || 'error desconocido';
            }
            return textResult(formatAgenda(upcoming, blocks));
        }
        catch (err) {
            return errorResult(err);
        }
    });
    return { getAgendaTool };
}
//# sourceMappingURL=agenda.js.map