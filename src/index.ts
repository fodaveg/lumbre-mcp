#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { addTask, listTasks, LumbreApiError, type LumbreConfig } from './lumbre-client.js';
import { formatTaskList } from './format.js';

/**
 * Conector MCP de Lumbre — Fase 1 (transporte stdio, pensado para Claude Code).
 * Dos tools: `add_task` (escribe vía `/api/ingest`) y `list_tasks` (lee vía
 * `GET /api/tasks`). Ambas usan el token personal de email-to-task de Lumbre
 * (Ajustes → email entrante), NUNCA hardcodeado — ver README.md.
 *
 * Fase 2 (mutar tareas existentes: completar/editar/reprogramar/borrar) queda
 * diseñada pero SIN implementar — ver PHASE2.md.
 */

function loadConfig(): LumbreConfig {
	const token = process.env.LUMBRE_TOKEN?.trim();
	if (!token) {
		console.error(
			'[lumbre-mcp] Falta LUMBRE_TOKEN. Configúralo en el bloque `env` de tu ' +
				'mcpServers (Ajustes → email entrante en Lumbre para conseguirlo). ' +
				'Sin él, ninguna tool puede autenticarse — ver mcp/README.md.'
		);
		process.exit(1);
	}
	const baseUrl = process.env.LUMBRE_BASE_URL?.trim() || 'https://lumbre.pro';
	return { baseUrl, token };
}

function textResult(text: string) {
	return { content: [{ type: 'text' as const, text }] };
}

function errorResult(err: unknown) {
	const message = err instanceof LumbreApiError ? err.message : err instanceof Error ? err.message : String(err);
	return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
}

const config = loadConfig();

const server = new McpServer({ name: 'lumbre-mcp', version: '0.1.0' });

const recurrenceSchema = z
	.object({
		freq: z.enum(['daily', 'weekly', 'monthly', 'yearly']).describe('Frecuencia de la repetición'),
		interval: z.number().int().positive().optional().describe('Cada cuántas unidades (default 1)')
	})
	.describe('Recurrencia simple (freq + interval), como la celda "Repetir" del quick-add de Lumbre');

server.registerTool(
	'add_task',
	{
		title: 'Añadir tarea a Lumbre',
		description:
			'Añade una tarea nueva a Lumbre (planificador semanal personal). Se encola y se ' +
			'materializa en el planificador la próxima vez que un dispositivo sincronice — no es ' +
			'instantáneo si no hay ningún dispositivo online. Usa esta tool cuando el usuario pida ' +
			'"apúntame", "recuérdame", "añade a mi lista/tarea/planificador" o similar.',
		inputSchema: {
			text: z.string().min(1).max(2000).describe('Texto de la tarea (obligatorio)'),
			list: z
				.string()
				.max(200)
				.optional()
				.describe(
					'Nombre de la lista de "Algún día" destino (se crea si no existe). Sin lista y sin ' +
						'date, el cliente la coloca en "hoy" al materializarla.'
				),
			priority: z.enum(['p1', 'p2', 'p3', 'p4']).optional().describe('p1 = más urgente; p4 = ninguna'),
			date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Día programado, YYYY-MM-DD'),
			deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Fecha límite ⚑, YYYY-MM-DD'),
			recurrence: recurrenceSchema.optional(),
			subtasks: z.array(z.string()).optional().describe('Subtareas a crear junto con la tarea'),
			notes: z.string().max(10000).optional().describe('Notas/descripción larga')
		}
	},
	async (input) => {
		try {
			await addTask(config, input);
			return textResult(`Tarea añadida a Lumbre: “${input.text}”.`);
		} catch (err) {
			return errorResult(err);
		}
	}
);

server.registerTool(
	'list_tasks',
	{
		title: 'Listar tareas de Lumbre',
		description:
			'Lee las tareas del usuario en Lumbre. `scope` acota el rango temporal: "today" ' +
			'(default), "week", "inbox"/"someday" (sin fecha), "overdue" (vencidas) o "all". El ' +
			'filtro `list` (por nombre de lista) NO está soportado todavía por el servidor — si se ' +
			'usa, la tool devolverá el error explicativo de Lumbre.',
		inputSchema: {
			scope: z
				.enum(['today', 'week', 'inbox', 'someday', 'overdue', 'all'])
				.optional()
				.describe('Alcance temporal; default "today"'),
			list: z.string().optional().describe('NO soportado aún (ver descripción de la tool)'),
			includeDone: z.boolean().optional().describe('Incluir tareas ya completadas; default false')
		}
	},
	async (input) => {
		try {
			const tasks = await listTasks(config, input);
			return textResult(formatTaskList(tasks, input.scope ?? 'today'));
		} catch (err) {
			return errorResult(err);
		}
	}
);

const transport = new StdioServerTransport();
await server.connect(transport);
