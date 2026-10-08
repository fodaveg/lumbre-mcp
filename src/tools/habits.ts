import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listHabits } from '../lumbre-client.js';
import { formatHabitList } from '../format.js';
import { errorResult, textResult, type ToolCtx } from './shared.js';

/**
 * Familia «hábitos» (MC6, 2026-09-24): `list_habits`, la única tool de esta
 * familia — lee hábitos y su historial vía `GET /api/habits` (R9: mismo auth
 * y límite 120/min que `list_tasks`; una app anterior a R9 da un error
 * legible, ver `listHabits`). Escritura (`register_habit`) vive en `mutate_tasks`
 * (`tools/batch.ts`), no aquí — mismo criterio que el resto del MCP: lectura y
 * mutación de un dominio en tools distintas.
 */
export function registerHabitTools(server: McpServer, ctx: ToolCtx) {
	const listHabitsTool = server.registerTool(
		'list_habits',
		{
			annotations: { readOnlyHint: true },
			description:
				'Enumera tus hábitos (id, nombre, clase, archivado) con sus últimas ocurrencias. ' +
				'Por defecto solo los vivos; `includeArchived` los incluye. Para registrar una ' +
				'ocurrencia, usa mutate_tasks({op:"register_habit"}).',
			inputSchema: {
				includeArchived: z.boolean().optional().describe('Incluir hábitos archivados; default false')
			}
		},
		async (input) => {
			try {
				const { habits, habitLog } = await listHabits(ctx.config);
				return textResult(formatHabitList(habits, habitLog, input.includeArchived ?? false));
			} catch (err) {
				return errorResult(err);
			}
		}
	);

	return { listHabitsTool };
}
