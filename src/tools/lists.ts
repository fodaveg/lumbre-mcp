import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getListLinks, linkListNote, listLists, listNotFoundError, parseListNoteUrl, unlinkListNote } from '../lumbre-client.js';
import { formatListDetail, formatListLinks, formatListSummaries } from '../format.js';
import { errorResult, textResult, type ToolCtx } from './shared.js';

const listNoteTargetInputSchema = {
	listId: z.string().guid().describe('Id del proyecto o área (ver list_lists)'),
	url: z
		.string()
		.trim()
		.refine((url) => parseListNoteUrl(url) !== null, 'URL de Obsidian o Hebra inválida')
		.describe(
			'URL obsidian://, https://app.hebra.pro/note/<uuid> o hebra://note/<uuid> (máx. 2048 caracteres/bytes)'
		),
	label: z.string().trim().min(1).max(300).describe('Nombre visible de la nota (1..300 caracteres)')
};

/**
 * Familia «listas y proyectos»: `list_lists`/`get_list_links`/`get_list`/
 * `link_list_note`/`unlink_list_note` — paridad UI↔MCP de proyectos/áreas
 * (`docs/20-contrato-lista.md`). Extraída de `index.ts` tal cual (tarea de
 * partir el servidor en `src/tools/` por familia, 2026-09-17): cero cambios
 * de comportamiento, solo `config` explícito por `ctx` en vez de closure.
 */
export function registerListTools(server: McpServer, ctx: ToolCtx) {
	const listListsTool = server.registerTool(
		'list_lists',
		{
			annotations: { readOnlyHint: true },
			description:
				'Enumera TODOS los proyectos y áreas con su recuento de tareas, incluidos los ' +
				'vacíos (recuento 0) — a diferencia de list_tasks({list}), que no distingue vacío de ' +
				'inexistente. Sin parámetros.',

			inputSchema: {}
		},
		async () => {
			try {
				const lists = await listLists(ctx.config);
				return textResult(formatListSummaries(lists));
			} catch (err) {
				return errorResult(err);
			}
		}
	);

	const getListLinksTool = server.registerTool(
		'get_list_links',
		{
			annotations: { readOnlyHint: true },
			description:
				'Lee los vínculos de un proyecto o área por listId (URL, kind y metadata). ' +
				'No abre el destino. Vacío si no tiene vínculos.',
			inputSchema: {
				listId: z.string().guid().describe('Id del proyecto o área (ver list_lists)')
			}
		},
		async (input) => {
			try {
				const links = await getListLinks(ctx.config, input.listId);
				return textResult(formatListLinks(input.listId, links));
			} catch (err) {
				return errorResult(err);
			}
		}
	);

	const getListTool = server.registerTool(
		'get_list',
		{
			annotations: { readOnlyHint: true },
			description:
				'Devuelve el detalle completo de UN proyecto o área por su listId: nombre, tipo (proyecto/área), ' +
					'padre, estado (cierre/aparcado/fecha, si el servidor los trae), recuento de tareas y la nota ' +
					'ÍNTEGRA y verbatim — útil antes de reescribirla con organize({op:"set_list_notes"}), que la ' +
					'reemplaza entera. Error si el listId no existe.',
			inputSchema: {
				listId: z.string().guid().describe('Id del proyecto o área (ver list_lists)')
			}
		},
		async (input) => {
			try {
				const lists = await listLists(ctx.config);
				const list = lists.find((l) => l.id === input.listId);
				if (!list) return errorResult(listNotFoundError(input.listId));
				return textResult(formatListDetail(list));
			} catch (err) {
				return errorResult(err);
			}
		}
	);

	const linkListNoteTool = server.registerTool(
		'link_list_note',
		{
			annotations: { destructiveHint: false, idempotentHint: true },
			description:
				'Vincula de forma síncrona e idempotente una nota de Obsidian o Hebra con un proyecto o área. ' +
				'Guarda enlace e identidad de la nota; no lee ni copia su contenido.',
			inputSchema: listNoteTargetInputSchema
		},
		async (input) => {
			try {
				const result = await linkListNote(ctx.config, input);
				return textResult(
					`Nota vinculada al proyecto o área ${result.listId}. deleted=${result.deleted}.\n` +
					formatListLinks(result.listId, [result.link])
				);
			} catch (err) {
				return errorResult(err);
			}
		}
	);

	const unlinkListNoteTool = server.registerTool(
		'unlink_list_note',
		{
			annotations: { idempotentHint: true },
			description:
				'Desvincula de forma síncrona e idempotente una nota de Obsidian o Hebra de un proyecto o área. ' +
				'`removed=false` confirma que el vínculo ya no estaba registrado.',
			inputSchema: listNoteTargetInputSchema
		},
		async (input) => {
			try {
				const result = await unlinkListNote(ctx.config, input);
				return textResult(
					`Vínculo de nota retirado del proyecto o área ${result.listId}. ` +
					`removed=${result.removed}; deleted=${result.deleted}.`
				);
			} catch (err) {
				return errorResult(err);
			}
		}
	);

	return { listListsTool, getListLinksTool, getListTool, linkListNoteTool, unlinkListNoteTool };
}
