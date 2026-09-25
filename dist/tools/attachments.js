import { z } from 'zod';
import { deleteAttachment, getAttachment, uploadAttachment } from '../lumbre-client.js';
import { decodeBase64Attachment, readLocalAttachment } from '../attachments.js';
import { requireTaskExists } from './task-existence.js';
import { errorResult, textResult } from './shared.js';
/**
 * Comando `claude mcp add` LISTO PARA COPIAR del conector stdio local acotado
 * a adjuntos (`LUMBRE_MCP_TOOLSET=attachments`, ver `CreateServerOptions` y
 * `toolsetFromEnv`): solo registra las tres tools de adjuntos
 * (`add_attachment`/`read_attachment`/`delete_attachment`) para poder tenerlo
 * enchufado A LA VEZ que el conector
 * remoto sin duplicar la superficie de `tools/list` en el contexto de cada
 * sesión. Usado tanto en `remoteFileAccessError` (el error que ve el modelo
 * en el momento en que lo necesita) como en el README.
 */
const LOCAL_ATTACHMENTS_CONNECTOR_COMMAND = 'claude mcp add lumbre-adjuntos --env LUMBRE_TOKEN=tu-token --env LUMBRE_MCP_TOOLSET=attachments ' +
    '-- node /ruta/absoluta/a/lumbre-mcp/dist/index.js';
/**
 * Error de `add_attachment({ file_path })` cuando este servidor NO ve el
 * disco del usuario (`localFilesystem: false`, ver `CreateServerOptions` —
 * hoy, el transporte HTTP remoto de `http.ts`/`mcp.lumbre.pro`). A propósito
 * NO reintenta ni delega en `readLocalAttachment`/`fs.stat`: contra ESTE
 * proceso, cualquier ruta —exista o no en la máquina del usuario— resolvería
 * contra el disco del VPS, así que un "No existe el fichero" ahí sería un
 * error LITERALMENTE CIERTO pero sobre la máquina equivocada — el bug real
 * que motiva esta pieza (medido el 2026-08-27: la captura sí existía en el
 * Mac de David en ese mismo instante). Explica la topología y las dos
 * salidas: `content_base64` para algo pequeño, o el conector local de arriba
 * para algo grande.
 */
function remoteFileAccessError() {
    return ('Este conector corre en mcp.lumbre.pro (transporte HTTP remoto) y no tiene forma de ver ' +
        'el disco de tu ordenador — "file_path" no funciona aquí, y un "no existe el fichero" ' +
        'sería sobre el disco del SERVIDOR, no el tuyo, así que ni se ha intentado leer. Dos ' +
        'alternativas:\n' +
        '  1. Fichero pequeño (unos KB — un .txt, un .log): pásalo con `content_base64` en vez ' +
        'de `file_path` (y `filename`, obligatorio en ese modo).\n' +
        '  2. Fichero grande (una captura, un PDF): añade el conector LOCAL de Lumbre, que sí ' +
        'corre en tu máquina y ve tu disco:\n\n' +
        `     ${LOCAL_ATTACHMENTS_CONNECTOR_COMMAND}\n\n` +
        '     (sustituye "tu-token" por tu token de email-to-task y la ruta por la de tu clon; ' +
        'ver README, "Transporte HTTP remoto"). Con ese conector enchufado, add_attachment ahí ' +
        'sí puede usar file_path.');
}
/**
 * `add_attachment` admite el id de una SUBTAREA en sus dos vías (encargo de
 * David, 25 sep 2026: «las subtareas ahora son tareas completas, se les puede
 * poner adjuntos y notas como en las tareas madre»). Medido en la app antes
 * de abrirlo: `POST /api/attachments` solo lee `taskId` (query en la vía de
 * máquina) y lo valida con `isTaskLive` (`src/lib/sync/store.ts`), que busca
 * la fila en la tabla de tareas del CRDT sin mirar `parentId`, y una subtarea
 * es una fila más de esa tabla con `parentId` (docs/18 §2.5). No existe un
 * campo aparte para la madre: el `taskId` de la subtarea basta.
 */
const SUBTASK_ATTACHMENTS = { allowSubtask: true };
/**
 * Familia «adjuntos»: `read_attachment`/`add_attachment`/`delete_attachment`
 * — las tres que quedan registradas solas en `toolset: 'attachments'` (ver
 * `CreateServerOptions` en `index.ts`). Extraída de `index.ts` tal cual
 * (tarea de partir el servidor en `src/tools/` por familia, 2026-09-17): cero
 * cambios de comportamiento, solo `config`/`localFilesystem` explícitos por
 * `ctx` en vez de closure, y `requireTaskExists(ctx, …)` en vez de
 * `requireTaskExists(…)` capturada.
 */
export function registerAttachmentTools(server, ctx) {
    const readAttachmentTool = server.registerTool('read_attachment', {
        description: 'Descarga un adjunto de una tarea de Lumbre por su id (ver el campo `attachments` de ' +
            'list_tasks). Si es una imagen, la devuelve para verla directamente; si no (PDF, etc.), ' +
            'devuelve solo su metadata — no hay forma de leer su contenido con esta tool.',
        inputSchema: {
            attachment_id: z
                .string()
                .guid()
                .describe('Id del adjunto (ver el campo `attachments` de list_tasks)')
        }
    }, async (input) => {
        try {
            const { contentType, bytes } = await getAttachment(ctx.config, input.attachment_id);
            if (contentType.startsWith('image/')) {
                return {
                    content: [
                        { type: 'image', data: bytes.toString('base64'), mimeType: contentType }
                    ]
                };
            }
            return textResult(`Adjunto ${input.attachment_id}: tipo "${contentType}", ${bytes.length} bytes. No es una ` +
                'imagen, así que esta tool no puede mostrar su contenido (solo lo descarga en el ' +
                'servidor MCP; no hay forma de mostrártelo a partir de aquí).');
        }
        catch (err) {
            return errorResult(err);
        }
    });
    const addAttachmentTool = server.registerTool('add_attachment', {
        description: 'Sube un fichero y lo deja adjunto a una tarea o subtarea (SÍNCRONA, a diferencia de add_task/' +
            'mutate_tasks: ya está enlazado al responder). Acepta EXACTAMENTE una de dos vías — ' +
            '`file_path` (ruta LOCAL, absoluta o "~/…", tope 25 MB) SOLO funciona si este conector ' +
            'corre en tu propia máquina (stdio local); contra el conector remoto de mcp.lumbre.pro ' +
            'devuelve un error explicativo, nunca intenta leer tu disco. `content_base64` funciona ' +
            'siempre, pero es SOLO para ficheros de unos KB (un .txt, un .log): el argumento lo emites ' +
            'TÚ como modelo, y una imagen de unos cientos de KB son ~100-200k tokens en base64 — tope ' +
            '1 MB decodificado. `filename` es obligatorio con `content_base64` (no hay ruta de la que ' +
            'sacar un nombre). Ver README para el detalle de mimes/límites y el conector local dedicado.',
        inputSchema: {
            taskId: z.string().guid().describe('Id de la tarea a la que adjuntar (ver list_tasks; de una subtarea, get_task de su madre)'),
            file_path: z
                .string()
                .min(1)
                .optional()
                .describe('Ruta LOCAL del fichero, absoluta o "~/…" (una relativa se rechaza). Exactamente uno ' +
                'de file_path/content_base64. Solo funciona si ESTE conector corre en tu máquina ' +
                '(stdio local) — contra el conector remoto da un error explicativo con la alternativa.'),
            content_base64: z
                .string()
                .min(1)
                .optional()
                .describe('Bytes del fichero en base64, para cuando no hay file_path posible (conector remoto) ' +
                'o el fichero es pequeño. SOLO para unos KB (un .txt/.log corto) — tope 1 MB ' +
                'decodificado; para algo más grande usa file_path con el conector local. Exactamente ' +
                'uno de file_path/content_base64. Requiere `filename`.'),
            filename: z
                .string()
                .min(1)
                .optional()
                .describe('Nombre con el que se guarda. Con file_path, opcional (por defecto su basename); con ' +
                'content_base64, OBLIGATORIO (no hay ruta de la que sacarlo).')
        }
    }, async (input) => {
        try {
            const hasFilePath = input.file_path !== undefined;
            const hasBase64 = input.content_base64 !== undefined;
            if (hasFilePath === hasBase64) {
                return errorResult(new Error(hasFilePath
                    ? 'Indica UNA sola vía: file_path o content_base64, no las dos a la vez.'
                    : 'Indica una vía para el fichero: file_path (conector local) o content_base64 ' +
                        '(cualquier conector, ficheros pequeños).'));
            }
            let file;
            if (hasBase64) {
                if (!input.filename?.trim()) {
                    return errorResult(new Error('filename es obligatorio con content_base64 (no hay ruta de la que sacarlo).'));
                }
                // Decodifica/valida ANTES de tocar red (`requireTaskExists` incluida)
                // — un base64 inválido o por encima del tope no debe gastar la
                // llamada de existencia.
                file = decodeBase64Attachment(input.content_base64, input.filename);
                // Una subtarea vale (25 sep 2026, ver `SUBTASK_ATTACHMENTS`).
                await requireTaskExists(ctx, input.taskId, SUBTASK_ATTACHMENTS);
            }
            else if (!ctx.localFilesystem) {
                // Ni requireTaskExists ni uploadAttachment: contra este disco NO
                // existe una ruta correcta que probar (ver `remoteFileAccessError`),
                // así que ni se toca la red.
                return errorResult(new Error(remoteFileAccessError()));
            }
            else {
                await requireTaskExists(ctx, input.taskId, SUBTASK_ATTACHMENTS);
                file = await readLocalAttachment(input.file_path, input.filename);
            }
            const attachment = await uploadAttachment(ctx.config, {
                taskId: input.taskId,
                filename: file.filename,
                mime: file.mime,
                bytes: file.bytes
            });
            return textResult(`Adjunto subido a Lumbre: "${attachment.filename}" (${attachment.mime}, ${attachment.size} ` +
                `bytes, id ${attachment.id}) en la tarea ${input.taskId}. Ya está enlazado (esta vía es ` +
                'SÍNCRONA): léelo con read_attachment cuando quieras, sin esperar a ningún sync.');
        }
        catch (err) {
            return errorResult(err);
        }
    });
    const deleteAttachmentTool = server.registerTool('delete_attachment', {
        description: 'Elimina un adjunto de Lumbre por su id (ver `attachments` en get_task/list_tasks). ' +
            'Es una operación DESTRUCTIVA y sin deshacer desde el MCP: úsala solo con autorización ' +
            'clara. El éxito confirma que el adjunto ya no está disponible para esa cuenta.',
        inputSchema: {
            attachment_id: z
                .string()
                .guid()
                .describe('Id del adjunto que se va a eliminar (ver get_task/list_tasks)')
        },
        outputSchema: {
            deleted: z.literal(true),
            attachment_id: z.string().guid()
        }
    }, async (input) => {
        try {
            await deleteAttachment(ctx.config, input.attachment_id);
            return {
                content: [
                    {
                        type: 'text',
                        text: `Adjunto ${input.attachment_id} eliminado de Lumbre. La operación no se puede deshacer desde el MCP.`
                    }
                ],
                structuredContent: { deleted: true, attachment_id: input.attachment_id }
            };
        }
        catch (err) {
            return errorResult(err);
        }
    });
    return { readAttachmentTool, addAttachmentTool, deleteAttachmentTool };
}
//# sourceMappingURL=attachments.js.map