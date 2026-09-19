import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getListLinks, linkListNote, listLists, listNotFoundError, unlinkListNote } from '../lumbre-client.js';
import { formatListDetail, formatListLinks, formatListSummaries } from '../format.js';
import { errorResult, textResult, type ToolCtx } from './shared.js';

/** Misma validación pura que aplica Lumbre antes de guardar un destino de
 * Obsidian. Recibe el valor ya recortado y no lo normaliza ni reserializa. */
function isValidObsidianDeepLink(raw: string): boolean {
	if (raw.length > 2_048 || new TextEncoder().encode(raw).length > 2_048) return false;
	try {
		const url = new URL(raw);
		return url.protocol === 'obsidian:' && !url.username && !url.password && raw.length > 'obsidian://'.length;
	} catch {
		return false;
	}
}

const listNoteTargetInputSchema = {
	listId: z.string().guid().describe('Id del proyecto o área (ver list_lists o list_tasks)'),
	url: z
		.string()
		.trim()
		.refine(isValidObsidianDeepLink, 'URL de Obsidian inválida')
		.describe('Deep link obsidian:// de la nota (máx. 2048 caracteres y bytes UTF-8)'),
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
			description:
				'Lee los vínculos configurados para UN proyecto o área por su listId (incluye URL y metadata; puede ser ' +
					'Obsidian obsidian://). No abre ni lee el contenido de los destinos. Respuesta vacía si no tiene vínculos.',
			inputSchema: {
				listId: z.string().guid().describe('Id del proyecto o área (ver list_lists o list_tasks)')
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
			description:
				'Devuelve el detalle completo de UN proyecto o área por su listId: nombre, tipo (proyecto/área), ' +
					'padre, estado (cierre/aparcado/fecha, si el servidor los trae), recuento de tareas y la nota ' +
					'ÍNTEGRA y verbatim — útil antes de reescribirla con mutate_tasks({op:"set_list_notes"}), que la ' +
					'reemplaza entera. Error si el listId no existe.',
			inputSchema: {
				listId: z.string().guid().describe('Id del proyecto o área (ver list_lists o list_tasks)')
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
			description:
				'Vincula de forma síncrona e idempotente una nota de Obsidian con un proyecto o área. ' +
				'Guarda solo el deep link y el nombre visible; no lee ni copia el contenido de la nota.',
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
			description:
				'Desvincula de forma síncrona e idempotente una nota de Obsidian de un proyecto o área. ' +
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
