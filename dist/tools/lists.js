import { z } from 'zod';
import { getListById, getListLinksResult, getListSections, getTaskLinks, getTaskLinksOfNote, isHebraNoteId, LumbreApiError, linkListNote, linkTaskNote, getListCatalog, listNotFoundError, parseListNoteUrl, parseTaskNoteTarget, unlinkListNote, unlinkTaskNote } from '../lumbre-client.js';
import { formatListDetail, formatListLinks, formatListSummaries, formatTaskLinks, formatTaskLinksOfNote } from '../format.js';
import { errorResult, spaceIdSchema, textResult } from './shared.js';
const listNoteTargetInputSchema = {
    listId: z.string().guid().describe('Id del proyecto o área (ver list_lists)'),
    url: z
        .string()
        .trim()
        .refine((url) => parseListNoteUrl(url) !== null, 'URL de Obsidian o Hebra inválida')
        .describe('URL obsidian://, https://app.hebra.pro/note/<uuid> o hebra://note/<uuid> (máx. 2048 caracteres/bytes)'),
    label: z.string().trim().min(1).max(300).describe('Nombre visible de la nota (1..300 caracteres)')
};
const taskNoteTargetInputSchema = {
    taskId: z.string().guid(),
    url: z
        .string()
        .trim()
        .refine((url) => parseTaskNoteTarget(url) !== null, 'URL de nota inválida para una tarea: usa obsidian://…, https://app.hebra.pro/note/<uuid> exacta ' +
        '(sin query ni fragmento) o hebra://note/<uuid>[?target=note:<uuid>[:heading:…|:block:…]]')
        .describe('URL obsidian://, https://app.hebra.pro/note/<uuid> o hebra://note/<uuid>'),
    label: z.string().trim().min(1).max(300).describe('Nombre visible (1..300)')
};
/**
 * Familia «listas y proyectos»: `list_lists`/`get_list_links`/`get_list`/
 * `link_list_note`/`unlink_list_note` — paridad UI↔MCP de proyectos/áreas
 * (`docs/20-contrato-lista.md`). Extraída de `index.ts` tal cual (tarea de
 * partir el servidor en `src/tools/` por familia, 2026-09-17): cero cambios
 * de comportamiento, solo `config` explícito por `ctx` en vez de closure.
 */
export function registerListTools(server, ctx) {
    const listListsTool = server.registerTool('list_lists', {
        annotations: { readOnlyHint: true },
        description: 'Enumera TODOS los proyectos y áreas con su recuento de tareas, incluidos los ' +
            'vacíos (list_tasks({list}) no distingue vacío de ' +
            'inexistente). Sin spaceId, Personal.',
        inputSchema: {
            spaceId: spaceIdSchema
        }
    }, async (input) => {
        try {
            const { lists, spaces } = await getListCatalog(ctx.config, {
                notes: 'length',
                ...(input.spaceId ? { spaceId: input.spaceId } : {})
            });
            return textResult(formatListSummaries(lists, spaces));
        }
        catch (err) {
            return errorResult(err);
        }
    });
    const getListLinksTool = server.registerTool('get_list_links', {
        annotations: { readOnlyHint: true },
        description: 'Vínculos de un proyecto o área por listId (URL, kind y metadata). ' +
            'No abre el destino. Vacío si no tiene vínculos.',
        inputSchema: {
            listId: z.string().guid().describe('Id del proyecto o área (ver list_lists)')
        }
    }, async (input) => {
        try {
            const { links, spaceId } = await getListLinksResult(ctx.config, input.listId);
            return textResult(formatListLinks(input.listId, links, spaceId));
        }
        catch (err) {
            return errorResult(err);
        }
    });
    const getListTool = server.registerTool('get_list', {
        annotations: { readOnlyHint: true },
        description: 'Detalle de UN proyecto o área por listId: nombre, tipo, padre, estado, recuento de tareas, ' +
            'secciones y la nota ÍNTEGRA — léela antes de reescribirla con organize({op:"set_list_notes"}), ' +
            'que la reemplaza entera. Error si no existe.',
        inputSchema: {
            listId: z.string().guid().describe('Id del proyecto o área (ver list_lists)')
        }
    }, async (input) => {
        try {
            const list = await getListById(ctx.config, input.listId);
            if (!list)
                return errorResult(listNotFoundError(input.listId));
            // Nombre del padre: una segunda petición solo si hay padre. Si falla (o el
            // padre ya no existe) no falla la tool: se pinta el id, como antes.
            let parentName = null;
            if (list.parentListId) {
                try {
                    parentName = (await getListById(ctx.config, list.parentListId))?.name ?? null;
                }
                catch {
                    parentName = null;
                }
            }
            // Secciones con su recuento: otra petición aparte (`includeSections=1`).
            // Si falla, la tool responde igual y lo dice en una línea.
            // Un 401 se relanza como cualquier error de autenticación; el resto da la
            // línea «no disponibles» con la causa breve.
            let sections;
            try {
                sections = await getListSections(ctx.config, list.id, list.spaceId);
            }
            catch (err) {
                if (err instanceof LumbreApiError && err.status === 401)
                    throw err;
                const reason = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim();
                sections = reason.length > 100 ? `${reason.slice(0, 97)}...` : reason || 'error desconocido';
            }
            return textResult(formatListDetail(list, parentName, sections));
        }
        catch (err) {
            return errorResult(err);
        }
    });
    const linkListNoteTool = server.registerTool('link_list_note', {
        annotations: { destructiveHint: false, idempotentHint: true },
        description: 'Vincula, síncrono e idempotente, una nota de Obsidian o Hebra con un proyecto o área. ' +
            'No lee ni copia su contenido.',
        inputSchema: listNoteTargetInputSchema
    }, async (input) => {
        try {
            const result = await linkListNote(ctx.config, input);
            return textResult(`Nota vinculada al proyecto o área ${result.listId}. deleted=${result.deleted}.\n` +
                formatListLinks(result.listId, [result.link], result.spaceId));
        }
        catch (err) {
            return errorResult(err);
        }
    });
    const unlinkListNoteTool = server.registerTool('unlink_list_note', {
        annotations: { idempotentHint: true },
        description: 'Desvincula, idempotente, una nota de un proyecto o área. ' +
            '`removed=false`: ya no estaba.',
        inputSchema: listNoteTargetInputSchema
    }, async (input) => {
        try {
            const result = await unlinkListNote(ctx.config, input);
            return textResult(`Vínculo de nota retirado del proyecto o área ${result.listId}. ` +
                `removed=${result.removed}; deleted=${result.deleted}.` +
                (result.spaceId ? ` espacio: ${result.spaceId}.` : ''));
        }
        catch (err) {
            return errorResult(err);
        }
    });
    const linkTaskNoteTool = server.registerTool('link_task_note', {
        annotations: { destructiveHint: false, idempotentHint: true },
        description: 'Vincula una nota de Obsidian o Hebra con una tarea, síncrono e idempotente. ' +
            'En un espacio, el vínculo es tuyo: los demás miembros no lo ven.',
        inputSchema: taskNoteTargetInputSchema
    }, async (input) => {
        try {
            const result = await linkTaskNote(ctx.config, input);
            return textResult(`Nota vinculada a la tarea ${result.taskId}.${result.archived ? ' La tarea está archivada o cancelada; el vínculo se guardó igualmente.' : ''}\n` +
                formatTaskLinks(result.taskId, [result.link]));
        }
        catch (err) {
            return errorResult(err);
        }
    });
    const unlinkTaskNoteTool = server.registerTool('unlink_task_note', {
        annotations: { idempotentHint: true },
        description: 'Desvincula una nota de una tarea, idempotente. `removed=false`: ya no estaba.',
        inputSchema: taskNoteTargetInputSchema
    }, async (input) => {
        try {
            const result = await unlinkTaskNote(ctx.config, input);
            return textResult(`Vínculo de nota retirado de la tarea ${result.taskId}. removed=${result.removed}.` +
                (result.archived ? ' La tarea está archivada o cancelada.' : ''));
        }
        catch (err) {
            return errorResult(err);
        }
    });
    const getTaskLinksTool = server.registerTool('get_task_links', {
        annotations: { readOnlyHint: true },
        description: 'Vínculos de nota de UNA tarea (taskId) o tareas vinculadas a UNA nota de Hebra (noteId). ' +
            'Exactamente uno. Por nota, vacío no distingue sin vínculos de sin permiso.',
        inputSchema: {
            taskId: z.string().guid().optional(),
            noteId: z.string().optional()
        }
    }, async (input) => {
        try {
            const hasTask = input.taskId !== undefined;
            const hasNote = input.noteId !== undefined;
            if (hasTask === hasNote) {
                return errorResult(new Error('Pasa exactamente uno: taskId o noteId.'));
            }
            if (input.taskId !== undefined) {
                return textResult(formatTaskLinks(input.taskId, await getTaskLinks(ctx.config, input.taskId)));
            }
            const noteId = input.noteId.trim();
            if (!isHebraNoteId(noteId)) {
                return errorResult(new Error('noteId no es un uuid de nota de Hebra.'));
            }
            return textResult(formatTaskLinksOfNote(noteId.toLowerCase(), await getTaskLinksOfNote(ctx.config, noteId)));
        }
        catch (err) {
            return errorResult(err);
        }
    });
    return {
        listListsTool,
        getListLinksTool,
        getListTool,
        linkListNoteTool,
        unlinkListNoteTool,
        linkTaskNoteTool,
        unlinkTaskNoteTool,
        getTaskLinksTool
    };
}
//# sourceMappingURL=lists.js.map