import { z } from 'zod';
import { listHabitsExport } from '../lumbre-client.js';
import { formatHabitList } from '../format.js';
import { errorResult, textResult } from './shared.js';
/**
 * Familia «hábitos» (MC6, 2026-09-24): `list_habits`, la única tool de esta
 * familia — lee hábitos y su historial vía `GET /api/export` (mismo auth que
 * `list_tasks`, límite MÁS ESTRICTO: 10/min, ver el JSDoc de
 * `listHabitsExport`). Escritura (`register_habit`) vive en `mutate_tasks`
 * (`tools/batch.ts`), no aquí — mismo criterio que el resto del MCP: lectura y
 * mutación de un dominio en tools distintas.
 */
export function registerHabitTools(server, ctx) {
    const listHabitsTool = server.registerTool('list_habits', {
        description: 'Enumera tus hábitos (id, nombre, clase, archivado) con sus últimas ocurrencias, vía ' +
            'GET /api/export — mismo token que list_tasks, pero límite MÁS ESTRICTO (10/min: vuelca la ' +
            'cuenta entera). Por defecto solo los vivos; `includeArchived` los incluye. Para registrar una ' +
            'ocurrencia, usa mutate_tasks({op:"register_habit"}).',
        inputSchema: {
            includeArchived: z.boolean().optional().describe('Incluir hábitos archivados; default false')
        }
    }, async (input) => {
        try {
            const { habits, habitLog } = await listHabitsExport(ctx.config);
            return textResult(formatHabitList(habits, habitLog, input.includeArchived ?? false));
        }
        catch (err) {
            return errorResult(err);
        }
    });
    return { listHabitsTool };
}
//# sourceMappingURL=habits.js.map