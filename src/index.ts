#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
	addTask,
	findTaskById,
	getAttachment,
	listTasks,
	mutateTask,
	refreshSync,
	LumbreApiError,
	type LumbreConfig
} from './lumbre-client.js';
import { formatTaskFull, formatTaskList } from './format.js';

/**
 * Conector MCP de Lumbre (transporte stdio, pensado para Claude Code). Fase 1:
 * `add_task` (escribe vía `/api/ingest`) y `list_tasks` (lee vía
 * `GET /api/tasks`, incluye los adjuntos de cada tarea). `read_attachment` lee
 * los BYTES de un adjunto (vía `GET /api/attachments/:id`, mismo token
 * ampliado para servirlos por `Authorization: Bearer` además de por sesión).
 * Fase 2: `complete_task`/`cancel_task`/`update_task`/`reschedule_task`/
 * `delete_task`/`set_section`/`move_to_list` (mutan una tarea EXISTENTE vía
 * `/api/mutations` — ver PHASE2.md). Todas
 * usan el token personal de email-to-task de Lumbre (Ajustes → email
 * entrante), NUNCA hardcodeado — ver README.md.
 *
 * Todas las tools de Fase 2 necesitan el `taskId` de antemano: lo normal es
 * llamar primero a `list_tasks` para resolverlo por contenido/fecha. Igual
 * `read_attachment` necesita el `attachment_id` que trae `list_tasks` en el
 * campo `attachments` de cada tarea. TODAS validan que el `taskId` EXISTE
 * antes de encolar (ver `requireTaskExists` más abajo) — bug real hasta
 * 2026-07-17: un id mal transcrito se encolaba igual y se perdía en silencio.
 *
 * `list_tasks` trunca las notas de cada tarea a ~240 caracteres por defecto
 * (para no inflar el contexto en listados largos); `fullNotes: true` las deja
 * íntegras para TODO el lote, y `get_task(taskId)` devuelve una única tarea
 * completa (notas verbatim + `createdAt` + lista/sección) — pensado para
 * reeditar una nota con `update_task` (que la REEMPLAZA entera) sin destruir
 * lo que la versión truncada no traía.
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
			'"apúntame", "recuérdame", "añade a mi lista/tarea/planificador" o similar. `section` ' +
			'coloca la tarea en una sección/heading concreta DENTRO de `list` (se crea si no ' +
			'existe); se ignora sin `list`.',
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
			listId: z
				.string()
				.uuid()
				.optional()
				.describe(
					'Id ESTABLE de la lista destino, PREFERENTE sobre `list` (inmune a renames); sácalo ' +
						'de list_tasks. Si se omite, se usa `list` por nombre (se crea si no existe).'
				),
			section: z
				.string()
				.max(200)
				.optional()
				.describe(
					'Nombre de la sección/heading dentro de `list` donde colocar la tarea (se crea si ' +
						'no existe). Se ignora si no se indica `list`.'
				),
			priority: z.enum(['p1', 'p2', 'p3', 'p4']).optional().describe('p1 = más urgente; p4 = ninguna'),
			date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Día programado, YYYY-MM-DD'),
			deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Fecha límite ⚑, YYYY-MM-DD'),
			time: z
				.string()
				.regex(/^([01]\d|2[0-3]):[0-5]\d$/)
				.optional()
				.describe('Hora "HH:MM" (24h) DENTRO de `date`; sin `date` no tiene efecto visible'),
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
	'refresh_sync',
	{
		title: 'Forzar el refresco del sync de Lumbre',
		description:
			'Fuerza el flush del sync de Lumbre ANTES de leer, para evitar que list_tasks devuelva un ' +
			'estado ligeramente rancio (el servidor guarda los cambios recibidos por WebSocket con un ' +
			'pequeño rebote/debounce). Úsala justo antes de list_tasks cuando importe ver el estado más ' +
			'reciente posible (p. ej. justo después de que el usuario diga que acaba de cambiar algo en ' +
			'la app). LÍMITE: solo garantiza lo que YA llegó al servidor por WebSocket — si el dispositivo ' +
			'del usuario está offline ahora mismo, sus cambios sin enviar no se pueden recuperar desde ' +
			'aquí, esperar no sirve de nada en ese caso. Sin parámetros.',
		inputSchema: {}
	},
	async () => {
		try {
			await refreshSync(config);
			return textResult('Sync de Lumbre refrescado: el servidor ya tiene persistido todo lo que le había llegado.');
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
			'filtro `list` acota además por el nombre (case-insensitive) de una lista de "Algún ' +
			'día"/proyecto — si no se indica `scope` explícito junto con `list`, el servidor ignora ' +
			'el alcance temporal por defecto y trae toda la lista (la mayoría de sus tareas no tienen ' +
			'fecha). Un `list` que no coincide con ninguna lista devuelve una lista vacía, no un error. ' +
			'`section` acota además por el nombre (case-insensitive) de una sección DENTRO de `list` ' +
			'(p. ej. "Bugs"/"Propuestas" dentro de un proyecto) — la respuesta agrupa las tareas por ' +
			'sección con una cabecera por grupo.',
		inputSchema: {
			scope: z
				.enum(['today', 'week', 'inbox', 'someday', 'overdue', 'all'])
				.optional()
				.describe('Alcance temporal; default "today" ("all" si se usa `list` sin `scope`)'),
			list: z
				.string()
				.optional()
				.describe('Nombre (case-insensitive) de una lista de "Algún día"/proyecto a filtrar'),
			section: z
				.string()
				.optional()
				.describe(
					'Nombre (case-insensitive) de una sección dentro de `list` a filtrar (Fase B, ' +
						'listas=proyectos); combinado con `list`, solo casa una sección de ESA lista'
				),
			includeDone: z.boolean().optional().describe('Incluir tareas ya completadas; default false'),
			fullNotes: z
				.boolean()
				.optional()
				.describe(
					'Si true, las notas de CADA tarea del lote salen íntegras y sin colapsar saltos de ' +
						'línea, en vez de truncadas a ~240 caracteres (default false, para no inflar el ' +
						'contexto en listados largos). Útil si vas a reeditar la nota con update_task (que ' +
						'la REEMPLAZA entera) y el lote ya está acotado (p. ej. con `list`/`section`). Para ' +
						'una sola tarea concreta, mejor get_task.'
				)
		}
	},
	async (input) => {
		try {
			const tasks = await listTasks(config, input);
			return textResult(formatTaskList(tasks, input.scope ?? 'today', { fullNotes: input.fullNotes }));
		} catch (err) {
			return errorResult(err);
		}
	}
);

server.registerTool(
	'get_task',
	{
		title: 'Leer una tarea completa de Lumbre',
		description:
			'Devuelve UNA tarea de Lumbre entera y sin recortar (notas íntegras y verbatim, fecha de ' +
			'creación, lista/sección con sus ids) — pensado para reeditar su nota con update_task sin ' +
			'perder lo que list_tasks trunca por defecto (~240 caracteres). Da error si el taskId no ' +
			'existe entre las tareas visibles del usuario (resuélvelo antes con list_tasks).',
		inputSchema: {
			taskId: z.string().uuid().describe('Id de la tarea (ver list_tasks)')
		}
	},
	async (input) => {
		try {
			const task = await findTaskById(config, input.taskId);
			if (!task) return errorResult(taskNotFoundError(input.taskId));
			return textResult(formatTaskFull(task));
		} catch (err) {
			return errorResult(err);
		}
	}
);

server.registerTool(
	'read_attachment',
	{
		title: 'Leer un adjunto de Lumbre',
		description:
			'Descarga un adjunto de una tarea de Lumbre por su id (ver el campo `attachments` de ' +
			'list_tasks, que trae el id y el nombre de cada adjunto). Si es una imagen, la devuelve ' +
			'para que puedas verla directamente; si no (PDF, etc.), devuelve solo su metadata — no hay ' +
			'forma de leer el contenido de un adjunto no-imagen con esta tool.',
		inputSchema: {
			attachment_id: z
				.string()
				.uuid()
				.describe('Id del adjunto (ver el campo `attachments` de list_tasks)')
		}
	},
	async (input) => {
		try {
			const { contentType, bytes } = await getAttachment(config, input.attachment_id);
			if (contentType.startsWith('image/')) {
				return {
					content: [
						{ type: 'image' as const, data: bytes.toString('base64'), mimeType: contentType }
					]
				};
			}
			return textResult(
				`Adjunto ${input.attachment_id}: tipo "${contentType}", ${bytes.length} bytes. No es una ` +
					'imagen, así que esta tool no puede mostrar su contenido (solo lo descarga en el ' +
					'servidor MCP; no hay forma de mostrártelo a partir de aquí).'
			);
		} catch (err) {
			return errorResult(err);
		}
	}
);

// ── Fase 2: mutar una tarea existente (ver PHASE2.md) ──────────────────────

/** Aviso compartido en las tools de Fase 2: la app es asíncrona/eventual
 *  (igual que `add_task`), así que ninguna da confirmación inmediata de que
 *  la mutación se aplicó de verdad — solo de que quedó encolada. */
const ASYNC_NOTE =
	'La aplicación de Lumbre es ASÍNCRONA/eventual (igual que add_task): la mutación se encola y se ' +
	'aplica la próxima vez que un dispositivo del usuario sincronice, no al instante. No hay ' +
	'confirmación de que se aplicó de verdad (usa list_tasks más tarde para comprobarlo).';

/** Error uniforme para un `taskId` que no aparece entre las tareas visibles
 *  del usuario — ver `requireTaskExists` para el porqué. */
function taskNotFoundError(taskId: string): Error {
	return new Error(
		`No existe ninguna tarea con id ${taskId} entre las tareas visibles del usuario (¿se transcribió ` +
			'mal? resuelve el id de nuevo con list_tasks). No se ha encolado ninguna mutación.'
	);
}

/**
 * Comprueba que `taskId` EXISTE antes de encolar cualquier mutación sobre él.
 * `/api/mutations` NO valida esto server-side (deliberado — ver el JSDoc de
 * ese endpoint: `tasks` es una proyección que puede ir desfasada del CRDT
 * real, así que el drenaje del CLIENTE descarta en silencio cualquier
 * `taskId` que no encuentre). Sin este chequeo aquí, un id mal transcrito
 * (typo real que mordió a David el 2026-07-17: `9c184fe4-2103-…` en vez de
 * `9c184fe4-ddb2-4103-…`) se encolaba igual y el MCP contestaba "Encolado…"
 * tan tranquilo, perdiendo la mutación sin avisar. La EXISTENCIA sí se puede
 * comprobar en el acto (a diferencia de si la mutación llegó a APLICARSE,
 * que sigue siendo asíncrono — ver `ASYNC_NOTE`), así que sí merece la pena
 * gastar la llamada extra a `GET /api/tasks` (vía `findTaskById`) antes de
 * encolar. Lanza si no existe; el llamante ya está dentro de un `try/catch`
 * que lo convierte en `errorResult`.
 */
async function requireTaskExists(taskId: string): Promise<void> {
	const task = await findTaskById(config, taskId);
	if (!task) throw taskNotFoundError(taskId);
}

/** Traduce `'p1'..'p4'` (de cara al modelo) al nivel numérico que espera
 *  `/api/mutations` para `kind: 'update'`: `p4` = quitar la prioridad (`null`). */
function priorityToLevel(p: 'p1' | 'p2' | 'p3' | 'p4'): 1 | 2 | 3 | null {
	return p === 'p4' ? null : (Number(p[1]) as 1 | 2 | 3);
}

server.registerTool(
	'complete_task',
	{
		title: 'Completar/descompletar una tarea de Lumbre',
		description:
			`Marca una tarea existente como hecha, o la desmarca con done:false. ${ASYNC_NOTE} Necesita ` +
			'el `taskId` de la tarea — resuélvelo antes con list_tasks (por contenido/fecha).',
		inputSchema: {
			taskId: z.string().uuid().describe('Id de la tarea (ver list_tasks)'),
			done: z.boolean().optional().describe('true = completar (default); false = desmarcar')
		}
	},
	async (input) => {
		try {
			await requireTaskExists(input.taskId);
			await mutateTask(config, {
				taskId: input.taskId,
				kind: 'complete',
				payload: { done: input.done ?? true }
			});
			return textResult(
				`Encolado en Lumbre: ${input.done === false ? 'desmarcar' : 'completar'} la tarea ${input.taskId} ` +
					'(se aplicará al sincronizar).'
			);
		} catch (err) {
			return errorResult(err);
		}
	}
);

server.registerTool(
	'cancel_task',
	{
		title: 'Cancelar/restaurar una tarea de Lumbre',
		description:
			'Cancela una tarea EXISTENTE: equivalente a completarla, pero marcada como "no se hizo ni ' +
			'se hará" (distinto de complete_task, que significa que sí se hizo) — sale igualmente de ' +
			'pendientes/rollover. Usa esta tool cuando el usuario diga "cancela", "ya no hace falta", ' +
			`"descarta esta tarea" (sin querer decir que la borre). ${ASYNC_NOTE} Con cancelled:false ` +
			'restaura la tarea cancelada a pendiente (equivalente a "deshacer"). Necesita el `taskId` — ' +
			'resuélvelo antes con list_tasks.',
		inputSchema: {
			taskId: z.string().uuid().describe('Id de la tarea (ver list_tasks)'),
			cancelled: z.boolean().optional().describe('true = cancelar (default); false = restaurar')
		}
	},
	async (input) => {
		try {
			await requireTaskExists(input.taskId);
			await mutateTask(config, {
				taskId: input.taskId,
				kind: 'cancel',
				payload: { cancelled: input.cancelled ?? true }
			});
			return textResult(
				`Encolado en Lumbre: ${input.cancelled === false ? 'restaurar' : 'cancelar'} la tarea ${input.taskId} ` +
					'(se aplicará al sincronizar).'
			);
		} catch (err) {
			return errorResult(err);
		}
	}
);

server.registerTool(
	'update_task',
	{
		title: 'Editar una tarea de Lumbre',
		description:
			`Edita el texto, las notas, la prioridad o la hora de una tarea existente. ${ASYNC_NOTE} ` +
			'Indica solo los campos que quieras cambiar; los que omitas se dejan igual. Necesita el ' +
			'`taskId` — resuélvelo antes con list_tasks (por contenido/fecha).',
		inputSchema: {
			taskId: z.string().uuid().describe('Id de la tarea (ver list_tasks)'),
			content: z.string().min(1).max(2000).optional().describe('Nuevo texto/título de la tarea'),
			notes: z
				.string()
				.max(10000)
				.optional()
				.describe('Nuevas notas/descripción (reemplaza las anteriores por completo)'),
			priority: z
				.enum(['p1', 'p2', 'p3', 'p4'])
				.optional()
				.describe('p1 = más urgente … p3; p4 = quitar la prioridad'),
			time: z
				.union([z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), z.null()])
				.optional()
				.describe('Hora "HH:MM" (24h) DENTRO del día programado, o null para quitarla')
		}
	},
	async (input) => {
		if (
			input.content === undefined &&
			input.notes === undefined &&
			input.priority === undefined &&
			input.time === undefined
		) {
			return errorResult(
				new Error('Indica al menos un campo a cambiar (content, notes, priority o time).')
			);
		}
		try {
			await requireTaskExists(input.taskId);
			await mutateTask(config, {
				taskId: input.taskId,
				kind: 'update',
				payload: {
					...(input.content !== undefined ? { content: input.content } : {}),
					...(input.notes !== undefined ? { notes: input.notes } : {}),
					...(input.priority !== undefined ? { priority: priorityToLevel(input.priority) } : {}),
					...(input.time !== undefined ? { time: input.time } : {})
				}
			});
			return textResult(
				`Encolada en Lumbre la edición de la tarea ${input.taskId} (se aplicará al sincronizar).`
			);
		} catch (err) {
			return errorResult(err);
		}
	}
);

server.registerTool(
	'reschedule_task',
	{
		title: 'Reprogramar una tarea de Lumbre',
		description:
			`Mueve una tarea existente a otro día, o a "Algún día"/Bandeja de entrada (date: null). ` +
			`${ASYNC_NOTE} Necesita el \`taskId\` — resuélvelo antes con list_tasks (por contenido/fecha).`,
		inputSchema: {
			taskId: z.string().uuid().describe('Id de la tarea (ver list_tasks)'),
			date: z
				.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.null()])
				.describe('Día destino, YYYY-MM-DD, o null para mandarla a "Algún día"/Bandeja de entrada')
		}
	},
	async (input) => {
		try {
			await requireTaskExists(input.taskId);
			await mutateTask(config, {
				taskId: input.taskId,
				kind: 'reschedule',
				payload: { date: input.date }
			});
			return textResult(
				`Encolado en Lumbre el cambio de fecha de la tarea ${input.taskId} a ` +
					`${input.date ?? '"Algún día"'} (se aplicará al sincronizar).`
			);
		} catch (err) {
			return errorResult(err);
		}
	}
);

server.registerTool(
	'delete_task',
	{
		title: 'Borrar una tarea de Lumbre',
		description:
			`Borra (soft-delete) una tarea existente de Lumbre. ${ASYNC_NOTE} ACCIÓN DELICADA: no hay ` +
			'confirmación inmediata de que se aplicó y no se puede deshacer desde esta tool — confírmalo ' +
			'con el usuario antes de llamarla. Necesita el `taskId` — resuélvelo antes con list_tasks.',
		inputSchema: {
			taskId: z.string().uuid().describe('Id de la tarea a borrar (ver list_tasks)')
		}
	},
	async (input) => {
		try {
			await requireTaskExists(input.taskId);
			await mutateTask(config, { taskId: input.taskId, kind: 'delete', payload: {} });
			return textResult(
				`Encolado en Lumbre el borrado de la tarea ${input.taskId} (se aplicará al sincronizar).`
			);
		} catch (err) {
			return errorResult(err);
		}
	}
);

server.registerTool(
	'set_section',
	{
		title: 'Mover una tarea de Lumbre a una sección/heading',
		description:
			'Mueve una tarea EXISTENTE a una sección/heading dentro de SU lista/proyecto (se crea si no ' +
			'existe), o la saca de su sección con section: null. Solo aplica si la tarea ya pertenece a ' +
			'una lista de "Algún día"/proyecto (si no, se ignora en silencio — una sección solo existe ' +
			`dentro de una lista). ${ASYNC_NOTE} Necesita el \`taskId\` — resuélvelo antes con list_tasks.`,
		inputSchema: {
			taskId: z.string().uuid().describe('Id de la tarea (ver list_tasks)'),
			section: z
				.string()
				.max(200)
				.nullable()
				.describe(
					'Nombre de la sección destino dentro de la lista de la tarea (se crea si no existe). ' +
						'null = quitarla de su sección actual.'
				)
		}
	},
	async (input) => {
		try {
			await requireTaskExists(input.taskId);
			await mutateTask(config, {
				taskId: input.taskId,
				kind: 'setSection',
				payload: { section: input.section }
			});
			return textResult(
				`Encolado en Lumbre: mover la tarea ${input.taskId} a la sección ` +
					`${input.section === null ? '(ninguna)' : `"${input.section}"`} (se aplicará al sincronizar).`
			);
		} catch (err) {
			return errorResult(err);
		}
	}
);

server.registerTool(
	'move_to_list',
	{
		title: 'Mover una tarea de Lumbre a otra lista',
		description:
			'Mueve una tarea EXISTENTE a otra lista de "Algún día"/proyecto (o la desvincula de la ' +
			'suya). Targetea por `listId` (id ESTABLE, preferente, inmune a renames — sácalo de ' +
			'list_tasks) o por `list` (nombre, se crea si no existe); `listId: null` explícito ' +
			'desvincula la tarea de su lista actual. CONSERVA la fecha de la tarea y limpia su ' +
			`sección (una sección solo existe dentro de su lista de origen). ${ASYNC_NOTE} Necesita ` +
			'el `taskId` — resuélvelo antes con list_tasks.',
		inputSchema: {
			taskId: z.string().uuid().describe('Id de la tarea (ver list_tasks)'),
			listId: z
				.union([z.string().uuid(), z.null()])
				.optional()
				.describe(
					'Id ESTABLE de la lista destino (ver list_tasks), PREFERENTE sobre `list`. ' +
						'null = desvincular la tarea de su lista actual.'
				),
			list: z
				.string()
				.max(200)
				.optional()
				.describe('Nombre de la lista destino (se crea si no existe); se ignora si se indica `listId`.')
		}
	},
	async (input) => {
		if (input.listId === undefined && input.list === undefined) {
			return errorResult(new Error('Indica `listId` o `list` (la lista destino).'));
		}
		try {
			await requireTaskExists(input.taskId);
			await mutateTask(config, {
				taskId: input.taskId,
				kind: 'moveToList',
				payload: input.listId !== undefined ? { listId: input.listId } : { list: input.list! }
			});
			const target =
				input.listId === null
					? '(ninguna lista)'
					: input.listId !== undefined
						? `listId ${input.listId}`
						: `"${input.list}"`;
			return textResult(
				`Encolado en Lumbre: mover la tarea ${input.taskId} a ${target} (se aplicará al sincronizar).`
			);
		} catch (err) {
			return errorResult(err);
		}
	}
);

const transport = new StdioServerTransport();
await server.connect(transport);
