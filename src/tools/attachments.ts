import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
	deleteAttachment,
	getAttachment,
	MAX_IMAGE_ATTACHMENT_BYTES,
	requestUploadPermit,
	uploadAttachment,
	type SubtaskDecision
} from '../lumbre-client.js';
import {
	buildUploadCommand,
	decodeBase64Attachment,
	LOCAL_PATH_PLACEHOLDER,
	readLocalAttachment
} from '../attachments.js';
import type { CachedTask } from '../existence-cache.js';
import { requireTaskExists } from './task-existence.js';
import { errorResult, textResult, type ToolCtx } from './shared.js';

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
const LOCAL_ATTACHMENTS_CONNECTOR_COMMAND =
	'claude mcp add lumbre-adjuntos --env LUMBRE_TOKEN=tu-token --env LUMBRE_MCP_TOOLSET=attachments ' +
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
function remoteFileAccessError(): string {
	return (
		'Este conector corre en mcp.lumbre.pro (transporte HTTP remoto) y no tiene forma de ver ' +
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
			'sí puede usar file_path.'
	);
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
const SUBTASK_ATTACHMENTS: SubtaskDecision = { allowSubtask: true };

/**
 * Familia «adjuntos»: `read_attachment`/`add_attachment`/`delete_attachment`
 * — las tres que quedan registradas solas en `toolset: 'attachments'` (ver
 * `CreateServerOptions` en `index.ts`). Extraída de `index.ts` tal cual
 * (tarea de partir el servidor en `src/tools/` por familia, 2026-09-17): cero
 * cambios de comportamiento, solo `config`/`localFilesystem` explícitos por
 * `ctx` en vez de closure, y `requireTaskExists(ctx, …)` en vez de
 * `requireTaskExists(…)` capturada.
 */
export function registerAttachmentTools(server: McpServer, ctx: ToolCtx) {
	const readAttachmentTool = server.registerTool(
		'read_attachment',
		{
			annotations: { readOnlyHint: true },
			description:
				'Descarga un adjunto de una tarea de Lumbre por su id (ver el campo `attachments` de ' +
				'list_tasks). Si es una imagen, la devuelve para verla directamente; si no (PDF, etc.), ' +
				'devuelve solo su metadata, sin descargarlo. Imágenes hasta 3,5 MiB.',
			inputSchema: {
				attachment_id: z
					.string()
					.guid()
					.describe('Id del adjunto (ver el campo `attachments` de list_tasks)')
			}
		},
		async (input) => {
			try {
				const { contentType, size, bytes, skipped } = await getAttachment(
					ctx.config,
					input.attachment_id
				);
				if (bytes !== undefined) {
					return {
						content: [
							{ type: 'image' as const, data: bytes.toString('base64'), mimeType: contentType }
						]
					};
				}
				const sizeLabel = size === null ? 'tamaño desconocido' : `${size} bytes`;
				if (skipped === 'image-too-large') {
					return textResult(
						`Adjunto ${input.attachment_id}: imagen "${contentType}", ${sizeLabel}. Supera el tope de ` +
							`${MAX_IMAGE_ATTACHMENT_BYTES / (1024 * 1024)} MiB para devolverla como imagen (un base64 ` +
							'mayor no cabe como imagen en el contexto del modelo), así que no se ha descargado.'
					);
				}
				return textResult(
					`Adjunto ${input.attachment_id}: tipo "${contentType}", ${sizeLabel}. No es una ` +
						'imagen, así que esta tool no puede mostrar su contenido (no se ha descargado: ' +
						'no hay forma de mostrártelo a partir de aquí).'
				);
			} catch (err) {
				return errorResult(err);
			}
		}
	);

	const addAttachmentTool = server.registerTool(
		'add_attachment',
		{
			annotations: { destructiveHint: false },
			description:
				'Sube un fichero y lo deja adjunto a una tarea o subtarea. EXACTAMENTE una vía: ' +
				'`file_path` (ruta LOCAL, tope 25 MB) SOLO si este conector corre en tu máquina (stdio); ' +
				'contra mcp.lumbre.pro da error explicativo. `content_base64` siempre funciona, pero SOLO ' +
				'para unos KB (lo emites tú como modelo: cientos de KB son ~100k+ tokens), tope 1 MB, y ' +
				'exige `filename`. Para un fichero grande o local usa prepare_attachment_upload.',
			inputSchema: {
				taskId: z.string().guid().describe('Id de la tarea a la que adjuntar (ver list_tasks; de una subtarea, get_task de su madre)'),
				file_path: z
					.string()
					.min(1)
					.optional()
					.describe(
						'Ruta LOCAL absoluta o "~/…" (una relativa se rechaza). Solo con el conector local (stdio); ' +
							'el remoto da error con la alternativa.'
					),
				content_base64: z
					.string()
					.min(1)
					.optional()
					.describe(
						'Bytes en base64, para el conector remoto o ficheros pequeños (unos KB; tope 1 MB ' +
							'decodificado). Requiere `filename`.'
					),
				filename: z
					.string()
					.min(1)
					.optional()
					.describe(
						'Nombre con el que se guarda. Opcional con file_path (basename); obligatorio con content_base64.'
					)
			}
		},
		async (input) => {
			try {
				const hasFilePath = input.file_path !== undefined;
				const hasBase64 = input.content_base64 !== undefined;
				if (hasFilePath === hasBase64) {
					return errorResult(
						new Error(
							hasFilePath
								? 'Indica UNA sola vía: file_path o content_base64, no las dos a la vez.'
								: 'Indica una vía para el fichero: file_path (conector local) o content_base64 ' +
									'(cualquier conector, ficheros pequeños).'
						)
					);
				}

				let file: { bytes: Buffer; filename: string; mime: string };
				let task: CachedTask;
				if (hasBase64) {
					if (!input.filename?.trim()) {
						return errorResult(
							new Error('filename es obligatorio con content_base64 (no hay ruta de la que sacarlo).')
						);
					}
					// Decodifica/valida ANTES de tocar red (`requireTaskExists` incluida)
					// — un base64 inválido o por encima del tope no debe gastar la
					// llamada de existencia.
					file = decodeBase64Attachment(input.content_base64!, input.filename);
					// Una subtarea vale (25 sep 2026, ver `SUBTASK_ATTACHMENTS`).
					task = await requireTaskExists(ctx, input.taskId, SUBTASK_ATTACHMENTS);
				} else if (!ctx.localFilesystem) {
					// Ni requireTaskExists ni uploadAttachment: contra este disco NO
					// existe una ruta correcta que probar (ver `remoteFileAccessError`),
					// así que ni se toca la red.
					return errorResult(new Error(remoteFileAccessError()));
				} else {
					task = await requireTaskExists(ctx, input.taskId, SUBTASK_ATTACHMENTS);
					file = await readLocalAttachment(input.file_path!, input.filename);
				}

				const attachment = await uploadAttachment(ctx.config, {
					taskId: input.taskId,
					filename: file.filename,
					mime: file.mime,
					store: task.spaceId ? task.storeId ?? task.spaceId : undefined,
					bytes: file.bytes
				});
				return textResult(
					`Adjunto subido a Lumbre: "${attachment.filename}" (${attachment.mime}, ${attachment.size} ` +
						`bytes, id ${attachment.id}) en la tarea ${input.taskId}. Ya está enlazado (esta vía es ` +
						'SÍNCRONA): léelo con read_attachment cuando quieras, sin esperar a ningún sync.'
				);
			} catch (err) {
				return errorResult(err);
			}
		}
	);

	// Remite aquí `add_attachment` para ficheros grandes o locales (David, 27 oct
	// 2026: «mandarle al mcp un archivo local... así no gastas tokens»). El MCP
	// remoto no ve el disco: pide el permiso y el AGENTE sube con curl. El
	// permiso solo sale en `text` de la respuesta: ni URL, ni log, ni error.
	const prepareAttachmentUploadTool = server.registerTool(
		'prepare_attachment_upload',
		{
			annotations: { destructiveHint: false },
			description:
				'Para subir un fichero LOCAL o grande (hasta 25 MB) sin pasar sus bytes por el modelo: ' +
				'devuelve un permiso de un solo uso (10 min) y un comando curl que ejecutas tú en tu ' +
				'terminal. Luego comprueba con get_task.',
			inputSchema: {
				taskId: z.string().guid().describe('Id de la tarea o subtarea destino'),
				filename: z.string().min(1).describe('Nombre con el que se guardará (su extensión fija el mime)')
			}
		},
		async (input) => {
			try {
				const task = await requireTaskExists(ctx, input.taskId, SUBTASK_ATTACHMENTS);
				const upload = await requestUploadPermit(ctx.config, input.taskId, task.spaceId ? task.storeId ?? task.spaceId : undefined);
				const cmd = buildUploadCommand({
					uploadUrl: upload.uploadUrl,
					permit: upload.permit,
					filename: input.filename
				});
				const mb = (upload.maxBytes / (1024 * 1024)).toFixed(0);
				return textResult(
					`Permiso de subida para "${cmd.filename}" en la tarea ${input.taskId}. Un solo uso, ` +
						`caduca ${upload.expiresAt}, tope ${upload.maxBytes} bytes (${mb} MB). El permiso es un ` +
						'secreto: no lo copies a tareas, notas ni logs.\n' +
						`uploadUrl: ${upload.uploadUrl}\n` +
						`permit: ${upload.permit}\n` +
						`mime: ${cmd.mime}\n` +
						`Cabeceras (${upload.method}, cuerpo binario crudo):\n` +
						Object.entries(cmd.headers)
							.map(([name, value]) => `  ${name}: ${value}`)
							.join('\n') +
						`\n\nEjecútalo en tu terminal sustituyendo ${LOCAL_PATH_PLACEHOLDER} por la ruta del fichero:\n\n` +
						`${cmd.curl}\n\n` +
						'Respuesta 200: el adjunto ya está enlazado; compruébalo con get_task. Errores: 401 ' +
						'(caducado o ya usado), 413 (tamaño o cuota) o 404 → pide otro permiso; 403 → el ' +
						'taskId no es el del permiso; 429 → reintenta con el mismo mientras no caduque.'
				);
			} catch (err) {
				return errorResult(err);
			}
		}
	);

	const deleteAttachmentTool = server.registerTool(
		'delete_attachment',
		{
			annotations: { destructiveHint: true },
			description:
				'Elimina un adjunto de Lumbre por su id (ver `attachments` en get_task/list_tasks). ' +
				'Sin deshacer: confirma con el usuario antes.',
			inputSchema: {
				attachment_id: z
					.string()
					.guid()
					.describe('Id del adjunto que se va a eliminar (ver get_task/list_tasks)')
			}
		},
		async (input) => {
			try {
				await deleteAttachment(ctx.config, input.attachment_id);
				return textResult(
					`Adjunto ${input.attachment_id} eliminado de Lumbre. La operación no se puede deshacer desde el MCP.`
				);
			} catch (err) {
				return errorResult(err);
			}
		}
	);

	return { readAttachmentTool, addAttachmentTool, prepareAttachmentUploadTool, deleteAttachmentTool };
}
