#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
	addTask,
	assertTaskUsable,
	buildBatchFromOps,
	collectExistenceCheckIds,
	findTaskById,
	findTasksByIds,
	getAttachment,
	listTasks,
	mutateTask,
	priorityToLevel,
	refreshSync,
	runBatch,
	taskNotFoundError,
	LumbreApiError,
	type BatchResultItem,
	type LumbreConfig,
	type LumbreTask,
	type MutateTasksOp
} from './lumbre-client.js';
import { formatTaskFull, formatTaskList } from './format.js';

/**
 * Conector MCP de Lumbre (transporte stdio, pensado para Claude Code). Fase 1:
 * `add_task` (escribe vía `/api/ingest`) y `list_tasks` (lee vía
 * `GET /api/tasks`, incluye los adjuntos de cada tarea). `read_attachment` lee
 * los BYTES de un adjunto (vía `GET /api/attachments/:id`, mismo token
 * ampliado para servirlos por `Authorization: Bearer` además de por sesión).
 * Fase 2: `complete_task`/`cancel_task`/`update_task`/`reschedule_task`/
 * `delete_task`/`set_section`/`move_to_list`/`add_subtask`/`complete_subtask`/
 * `remove_section` (mutan una tarea EXISTENTE vía `/api/mutations` — ver
 * PHASE2.md; `remove_section` es la excepción, muta una SECCIÓN).
 * `create_list`/`nest_list`/`rename_list`/`remove_list` (paridad UI↔MCP —
 * gestión de listas de "Algún día", `docs/20-contrato-lista.md`): mutan una
 * LISTA, no una tarea; `create_list` es la única que CREA (genera su propio
 * id con `randomUUID()` antes de encolar, ver su JSDoc más abajo). Todas
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
			'perder lo que list_tasks trunca por defecto (~240 caracteres). Si la tarea tiene subtareas ' +
			'(checklist, #17), las incluye con su id y su estado hecha/pendiente — es la ÚNICA forma de ' +
			'obtener el id de una subtarea (list_tasks nunca las lista), necesario para complete_subtask. ' +
			'Da error si el taskId no existe entre las tareas visibles del usuario (resuélvelo antes con ' +
			'list_tasks).',
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

/**
 * Comprueba que `taskId` EXISTE antes de encolar cualquier mutación sobre él,
 * y (SELECTIVAMENTE, ver `allowSubtask`) que no sea una subtarea si la tool
 * no admite una ahí. `/api/mutations` NO valida esto server-side (deliberado
 * — ver el JSDoc de ese endpoint: `tasks` es una proyección que puede ir
 * desfasada del CRDT real, así que el drenaje del CLIENTE descarta en
 * silencio cualquier `taskId` que no encuentre). Sin el chequeo de
 * EXISTENCIA aquí, un id mal transcrito (typo real que mordió a David el
 * 2026-07-17: `9c184fe4-2103-…` en vez de `9c184fe4-ddb2-4103-…`) se
 * encolaba igual y el MCP contestaba "Encolado…" tan tranquilo, perdiendo la
 * mutación sin avisar. La EXISTENCIA sí se puede comprobar en el acto (a
 * diferencia de si la mutación llegó a APLICARSE, que sigue siendo asíncrono
 * — ver `ASYNC_NOTE`), así que sí merece la pena gastar la llamada extra a
 * `GET /api/tasks?id=` (vía `findTaskById`) antes de encolar.
 *
 * Fino wrapper de red sobre `assertTaskUsable` (`lumbre-client.ts`, función
 * PURA que hace la comprobación en sí — allí vive el JSDoc completo del
 * criterio `allowSubtask` por tool, y sus tests). Lanza si no existe, o si
 * existe pero es una subtarea y `allowSubtask` es `false`; el llamante ya
 * está dentro de un `try/catch` que lo convierte en `errorResult`.
 */
async function requireTaskExists(
	taskId: string,
	opts: { allowSubtask?: boolean } = {}
): Promise<void> {
	const task = await findTaskById(config, taskId);
	assertTaskUsable(task, taskId, opts);
}

server.registerTool(
	'complete_task',
	{
		title: 'Completar/descompletar una tarea de Lumbre',
		description:
			`Marca una tarea existente como hecha, o la desmarca con done:false. También admite el id de ` +
			`una SUBTAREA (aunque para eso es más claro complete_subtask). ${ASYNC_NOTE} Necesita ` +
			'el `taskId` de la tarea — resuélvelo antes con list_tasks (por contenido/fecha).',
		inputSchema: {
			taskId: z.string().uuid().describe('Id de la tarea (ver list_tasks)'),
			done: z.boolean().optional().describe('true = completar (default); false = desmarcar')
		}
	},
	async (input) => {
		try {
			await requireTaskExists(input.taskId, { allowSubtask: true });
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
			await requireTaskExists(input.taskId, { allowSubtask: true });
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
			`Edita el texto, las notas, la prioridad o la hora de una tarea existente. NO aplica a una ` +
			`SUBTAREA (rechaza su id con error). ${ASYNC_NOTE} Indica solo los campos que quieras ` +
			'cambiar; los que omitas se dejan igual. Necesita el `taskId` — resuélvelo antes con ' +
			'list_tasks (por contenido/fecha).',
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
			await requireTaskExists(input.taskId, { allowSubtask: false });
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
			`Mueve una tarea existente a otro día, o a "Algún día"/Bandeja de entrada (date: null). NO ` +
			`aplica a una SUBTAREA (rechaza su id con error: una subtarea no tiene agenda propia). ` +
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
			await requireTaskExists(input.taskId, { allowSubtask: false });
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
			`Borra (soft-delete) una tarea existente de Lumbre — también admite el id de una SUBTAREA ` +
			`(borra solo esa subtarea, no toca el resto de la checklist). ${ASYNC_NOTE} ACCIÓN DELICADA: ` +
			'no hay confirmación inmediata de que se aplicó y no se puede deshacer desde esta tool — ' +
			'confírmalo con el usuario antes de llamarla. Necesita el `taskId` — resuélvelo antes con ' +
			'list_tasks (o con get_task de la tarea padre si es una subtarea).',
		inputSchema: {
			taskId: z.string().uuid().describe('Id de la tarea (o subtarea) a borrar (ver list_tasks/get_task)')
		}
	},
	async (input) => {
		try {
			await requireTaskExists(input.taskId, { allowSubtask: true });
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
			'dentro de una lista). NO aplica a una SUBTAREA (rechaza su id con error). ' +
			`${ASYNC_NOTE} Necesita el \`taskId\` — resuélvelo antes con list_tasks.`,
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
			await requireTaskExists(input.taskId, { allowSubtask: false });
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
	'remove_section',
	{
		title: 'Borrar una sección de Lumbre',
		description:
			'Borra (tombstone) una sección/heading DENTRO de una lista de "Algún día"/proyecto de Lumbre. ' +
			'Las tareas que vivían en esa sección NUNCA se borran: solo pierden su sección (quedan ' +
			'sueltas, "sin sección", DENTRO de la MISMA lista — no cambian de residencia). Sin ' +
			'`list_sections` todavía: resuelve el `sectionId` a borrar desde el campo `sectionId` de ' +
			`una tarea que ya viva ahí (ver list_tasks/get_task). ${ASYNC_NOTE} Si el \`sectionId\` no ` +
			'existe (mal transcrito, o ajeno), el materializador lo descarta EN SILENCIO — no hay forma ' +
			'de confirmarlo desde esta tool, comprueba con list_tasks.',
		inputSchema: {
			sectionId: z
				.string()
				.uuid()
				.describe(
					'Id de la sección a borrar (ver el campo `sectionId` de una tarea que viva en ella, en list_tasks/get_task)'
				)
		}
	},
	async (input) => {
		try {
			await mutateTask(config, {
				taskId: input.sectionId,
				kind: 'removeSection',
				payload: { sectionId: input.sectionId }
			});
			return textResult(
				`Encolado en Lumbre el borrado de la sección ${input.sectionId} (se aplicará al sincronizar).`
			);
		} catch (err) {
			return errorResult(err);
		}
	}
);

server.registerTool(
	'create_list',
	{
		title: 'Crear una lista de "Algún día" en Lumbre',
		description:
			'Crea una lista/proyecto de "Algún día" nueva en Lumbre (contenedor de tareas fuera del ' +
			'tiempo, con identidad propia — docs/20-contrato-lista.md). Devuelve el `listId` generado: ' +
			'úsalo después con add_task (`listId`), move_to_list, o nest_list para anidarla bajo otra ' +
			`lista. ${ASYNC_NOTE}`,
		inputSchema: {
			name: z.string().min(1).max(200).describe('Nombre de la lista (obligatorio)'),
			color: z
				.string()
				.max(20)
				.optional()
				.describe(
					'Color de la lista: uno de red|amber|green|blue|violet|pink, o un hex libre "#rrggbb". ' +
						'Sin color por defecto.'
				),
			icon: z.string().max(16).optional().describe('Emoji/icono de la lista. Sin icono por defecto.')
		}
	},
	async (input) => {
		try {
			// El id lo genera esta tool, ANTES de encolar (mismo criterio que
			// `clientTaskId` para `add_task`): `create_list` es la ÚNICA mutación
			// de lista que CREA en vez de mutar algo existente, así que no hay un
			// `listId` previo que targetear — ver el JSDoc de `MUTATION_KINDS`
			// (`$lib/server/repos/mutations.ts` en el repo principal).
			const listId = randomUUID();
			await mutateTask(config, {
				taskId: listId,
				kind: 'createList',
				payload: {
					name: input.name,
					...(input.color !== undefined ? { color: input.color } : {}),
					...(input.icon !== undefined ? { icon: input.icon } : {})
				}
			});
			return textResult(
				`Encolada en Lumbre la lista "${input.name}" (listId ${listId}; se aplicará al sincronizar).`
			);
		} catch (err) {
			return errorResult(err);
		}
	}
);

server.registerTool(
	'nest_list',
	{
		title: 'Anidar o desanidar una lista de Lumbre',
		description:
			'Fija el padre de una lista de "Algún día" EXISTENTE (la anida bajo otra), o la deja de ' +
			'primer nivel con parentId: null (desanidar). Sin una tool para listar listas todavía: ' +
			'resuelve `listId`/`parentId` con el que devolvió create_list, o con el campo ' +
			`\`somedayListId\` de una tarea que ya viva en esa lista (list_tasks/get_task). ${ASYNC_NOTE} ` +
			'Si el anidado se rechaza (crearía un ciclo, auto-anidado, o la lista es la Bandeja de ' +
			'entrada, que nunca es anidable) o `listId`/`parentId` no existen, el materializador lo ' +
			'descarta EN SILENCIO — no hay forma de confirmarlo desde esta tool.',
		inputSchema: {
			listId: z.string().uuid().describe('Id de la lista a anidar/desanidar'),
			parentId: z
				.union([z.string().uuid(), z.null()])
				.describe('Id de la lista padre destino, o null para dejarla de primer nivel')
		}
	},
	async (input) => {
		try {
			await mutateTask(config, {
				taskId: input.listId,
				kind: 'nestList',
				payload: { parentId: input.parentId }
			});
			const target = input.parentId === null ? '(primer nivel)' : `bajo la lista ${input.parentId}`;
			return textResult(
				`Encolado en Lumbre: anidar la lista ${input.listId} ${target} (se aplicará al sincronizar).`
			);
		} catch (err) {
			return errorResult(err);
		}
	}
);

server.registerTool(
	'rename_list',
	{
		title: 'Renombrar una lista de Lumbre',
		description:
			'Renombra una lista de "Algún día" EXISTENTE de Lumbre; su identidad y sus tareas no ' +
			'cambian (docs/20-contrato-lista.md: la identidad es el id, no el nombre). Sin una tool ' +
			'para listar listas todavía: resuelve `listId` con el que devolvió create_list, o con el ' +
			`campo \`somedayListId\` de una tarea que ya viva ahí (list_tasks/get_task). ${ASYNC_NOTE}`,
		inputSchema: {
			listId: z.string().uuid().describe('Id de la lista a renombrar'),
			name: z.string().min(1).max(200).describe('Nuevo nombre')
		}
	},
	async (input) => {
		try {
			await mutateTask(config, {
				taskId: input.listId,
				kind: 'renameList',
				payload: { name: input.name }
			});
			return textResult(
				`Encolado en Lumbre: renombrar la lista ${input.listId} a "${input.name}" ` +
					'(se aplicará al sincronizar).'
			);
		} catch (err) {
			return errorResult(err);
		}
	}
);

server.registerTool(
	'remove_list',
	{
		title: 'Borrar una lista de Lumbre',
		description:
			'Borra (tombstone) una lista/proyecto de "Algún día" EXISTENTE de Lumbre. Sus tareas NUNCA ' +
			'se pierden: las sin fecha se reasignan a otra lista viva; las "prestadas" (con fecha) ' +
			'pierden el vínculo y quedan como tarea de día normal. Sus listas hijas directas pasan a ' +
			'primer nivel (no se borran en cascada). No aplica a la ÚLTIMA lista viva ni a la Bandeja ' +
			'de entrada canónica (docs/20-contrato-lista.md §5, "Prohibidos"): se ignora en silencio ' +
			'en ambos casos — no hay forma de confirmarlo desde esta tool, comprueba con list_tasks. ' +
			'Sin una tool para listar listas todavía: resuelve `listId` con el que devolvió ' +
			`create_list, o con el campo \`somedayListId\` de una tarea que ya viva ahí ` +
			`(list_tasks/get_task). ${ASYNC_NOTE}`,
		inputSchema: {
			listId: z.string().uuid().describe('Id de la lista a borrar')
		}
	},
	async (input) => {
		try {
			await mutateTask(config, { taskId: input.listId, kind: 'removeList', payload: {} });
			return textResult(
				`Encolado en Lumbre el borrado de la lista ${input.listId} (se aplicará al sincronizar).`
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
			'sección (una sección solo existe dentro de su lista de origen). NO aplica a una SUBTAREA ' +
			`(rechaza su id con error: una subtarea no tiene residencia propia). ${ASYNC_NOTE} Necesita ` +
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
			await requireTaskExists(input.taskId, { allowSubtask: false });
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

server.registerTool(
	'add_subtask',
	{
		title: 'Añadir subtareas a una tarea de Lumbre',
		description:
			'Añade una o más subtareas (checklist, #17) a una tarea EXISTENTE de Lumbre. ' +
			`${ASYNC_NOTE} No se puede añadir subtareas a una SUBTAREA (anidamiento de UN nivel: ` +
			'una subtarea no puede tener subtareas propias); si `taskId` ya es una subtarea, el ' +
			'servidor descarta la mutación en silencio (usa list_tasks para comprobar si aplicó). ' +
			'Necesita el `taskId` de la tarea PADRE — resuélvelo antes con list_tasks (por ' +
			'contenido/fecha). Para añadir subtareas al CREAR una tarea nueva, usa add_task con ' +
			'`subtasks` en vez de esta tool.',
		inputSchema: {
			taskId: z.string().uuid().describe('Id de la tarea PADRE (ver list_tasks)'),
			subtasks: z
				.array(z.string())
				.min(1)
				.max(50)
				.describe('Textos de las subtareas a añadir, en orden (cada uno se recorta a 500 caracteres)')
		}
	},
	async (input) => {
		try {
			// `allowSubtask: true` (no relaja nada nuevo): si `taskId` YA es una
			// subtarea, esto solo evita adelantar el rechazo aquí — el
			// materializador (`task-ops`/`inbound-materialize.ts`) descarta la
			// mutación en silencio de todas formas, comportamiento YA documentado
			// arriba y sin cambios por este fix.
			await requireTaskExists(input.taskId, { allowSubtask: true });
			await mutateTask(config, {
				taskId: input.taskId,
				kind: 'addSubtask',
				payload: { subtasks: input.subtasks }
			});
			return textResult(
				`Encolado en Lumbre: ${input.subtasks.length} subtarea(s) para la tarea ${input.taskId} ` +
					'(se aplicará al sincronizar).'
			);
		} catch (err) {
			return errorResult(err);
		}
	}
);

server.registerTool(
	'complete_subtask',
	{
		title: 'Completar/descompletar una subtarea de Lumbre',
		description:
			'Marca una SUBTAREA (checklist, #17) existente como hecha, o la desmarca con done:false. ' +
			'Completar una subtarea es completar una tarea: MISMO mecanismo que complete_task, aplicado ' +
			'a su id — no cascada nada sobre la tarea padre (cada subtarea se completa de forma ' +
			`independiente). ${ASYNC_NOTE} Necesita el \`subtaskId\`: resuélvelo con get_task(taskId) de ` +
			'la tarea PADRE (list_tasks nunca lista subtareas, así que no aparecen ahí).',
		inputSchema: {
			subtaskId: z.string().uuid().describe('Id de la subtarea (ver get_task de su tarea padre)'),
			done: z.boolean().optional().describe('true = completar (default); false = desmarcar')
		}
	},
	async (input) => {
		try {
			await requireTaskExists(input.subtaskId, { allowSubtask: true });
			await mutateTask(config, {
				taskId: input.subtaskId,
				kind: 'complete',
				payload: { done: input.done ?? true }
			});
			return textResult(
				`Encolado en Lumbre: ${input.done === false ? 'desmarcar' : 'completar'} la subtarea ` +
					`${input.subtaskId} (se aplicará al sincronizar).`
			);
		} catch (err) {
			return errorResult(err);
		}
	}
);

// ── Feature batch (`plan-batch.md`): N operaciones en UNA sola tool call ───

/**
 * `discriminatedUnion` por `op`: una entrada por cada tool de mutación (Fase
 * 2) + `add_task`. MISMOS campos y MISMOS schemas zod que la tool individual
 * correspondiente (copiados de arriba, no reinventados) — la única novedad es
 * el discriminante `op` y que viajan varias a la vez dentro de `ops`. Sin
 * `restore` (ninguna tool individual lo expone tampoco). Sin `refresh_sync`/
 * `list_tasks`/`get_task`/`read_attachment` (son lecturas, no mutaciones
 * encolables).
 */
const mutateTasksOpSchema = z.discriminatedUnion('op', [
	z.object({
		op: z.literal('add_task'),
		text: z.string().min(1).max(2000).describe('Texto de la tarea (obligatorio)'),
		list: z
			.string()
			.max(200)
			.optional()
			.describe('Nombre de la lista de "Algún día" destino (se crea si no existe)'),
		listId: z
			.string()
			.uuid()
			.optional()
			.describe('Id ESTABLE de la lista destino, PREFERENTE sobre `list` — sácalo de list_tasks'),
		section: z
			.string()
			.max(200)
			.optional()
			.describe('Nombre de la sección/heading dentro de `list` (se crea si no existe)'),
		priority: z.enum(['p1', 'p2', 'p3', 'p4']).optional().describe('p1 = más urgente; p4 = ninguna'),
		date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Día programado, YYYY-MM-DD'),
		deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Fecha límite ⚑, YYYY-MM-DD'),
		time: z
			.string()
			.regex(/^([01]\d|2[0-3]):[0-5]\d$/)
			.optional()
			.describe('Hora "HH:MM" (24h) DENTRO de `date`'),
		recurrence: recurrenceSchema.optional(),
		subtasks: z.array(z.string()).optional().describe('Subtareas a crear junto con la tarea'),
		notes: z.string().max(10000).optional().describe('Notas/descripción larga')
	}),
	z.object({
		op: z.literal('complete'),
		taskId: z.string().uuid().describe('Id de la tarea (o subtarea) a completar'),
		done: z.boolean().optional().describe('true = completar (default); false = desmarcar')
	}),
	z.object({
		op: z.literal('cancel'),
		taskId: z.string().uuid().describe('Id de la tarea (o subtarea) a cancelar'),
		cancelled: z.boolean().optional().describe('true = cancelar (default); false = restaurar')
	}),
	z.object({
		op: z.literal('update'),
		taskId: z.string().uuid().describe('Id de la tarea (NO aplica a subtareas)'),
		content: z.string().min(1).max(2000).optional().describe('Nuevo texto/título'),
		notes: z.string().max(10000).optional().describe('Nuevas notas (reemplaza las anteriores)'),
		priority: z
			.enum(['p1', 'p2', 'p3', 'p4'])
			.optional()
			.describe('p1 = más urgente … p3; p4 = quitar la prioridad'),
		time: z
			.union([z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), z.null()])
			.optional()
			.describe('Hora "HH:MM" (24h), o null para quitarla')
	}),
	z.object({
		op: z.literal('reschedule'),
		taskId: z.string().uuid().describe('Id de la tarea (NO aplica a subtareas)'),
		date: z
			.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.null()])
			.describe('Día destino, YYYY-MM-DD, o null para "Algún día"/Bandeja de entrada')
	}),
	z.object({
		op: z.literal('delete'),
		taskId: z.string().uuid().describe('Id de la tarea (o subtarea) a borrar')
	}),
	z.object({
		op: z.literal('set_section'),
		taskId: z.string().uuid().describe('Id de la tarea (NO aplica a subtareas)'),
		section: z.string().max(200).nullable().describe('Sección destino, o null para quitarla')
	}),
	z.object({
		op: z.literal('move_to_list'),
		taskId: z.string().uuid().describe('Id de la tarea (NO aplica a subtareas)'),
		listId: z
			.union([z.string().uuid(), z.null()])
			.optional()
			.describe('Id ESTABLE de la lista destino, PREFERENTE sobre `list`; null = desvincular'),
		list: z.string().max(200).optional().describe('Nombre de la lista destino (se crea si no existe)')
	}),
	z.object({
		op: z.literal('add_subtask'),
		taskId: z.string().uuid().describe('Id de la tarea PADRE'),
		subtasks: z.array(z.string()).min(1).max(50).describe('Textos de las subtareas a añadir, en orden')
	}),
	z.object({
		op: z.literal('complete_subtask'),
		subtaskId: z.string().uuid().describe('Id de la subtarea (ver get_task de su tarea padre)'),
		done: z.boolean().optional().describe('true = completar (default); false = desmarcar')
	}),
	z.object({
		op: z.literal('remove_section'),
		sectionId: z.string().uuid().describe('Id de la sección a borrar')
	}),
	z.object({
		op: z.literal('create_list'),
		name: z.string().min(1).max(200).describe('Nombre de la lista (obligatorio)'),
		color: z
			.string()
			.max(20)
			.optional()
			.describe('red|amber|green|blue|violet|pink, o un hex libre "#rrggbb"'),
		icon: z.string().max(16).optional().describe('Emoji/icono de la lista'),
		listId: z
			.string()
			.uuid()
			.optional()
			.describe(
				'Id (uuid) que TENDRÁ la lista — opcional, para ENCADENAR con otra op del MISMO ' +
					'`mutate_tasks` (p. ej. un `move_to_list`/`nest_list` posterior con ese mismo `listId`, ' +
					'sin depender de una llamada previa para conocerlo). Genera tú mismo un uuid v4 si lo ' +
					'necesitas; si se omite, el servidor asigna uno (que solo conocerás en la respuesta).'
			)
	}),
	z.object({
		op: z.literal('nest_list'),
		listId: z.string().uuid().describe('Id de la lista a anidar/desanidar'),
		parentId: z.union([z.string().uuid(), z.null()]).describe('Lista padre destino, o null para desanidar')
	}),
	z.object({
		op: z.literal('rename_list'),
		listId: z.string().uuid().describe('Id de la lista a renombrar'),
		name: z.string().min(1).max(200).describe('Nuevo nombre')
	}),
	z.object({
		op: z.literal('remove_list'),
		listId: z.string().uuid().describe('Id de la lista a borrar')
	})
]);

server.registerTool(
	'mutate_tasks',
	{
		title: 'Ejecutar varias operaciones en Lumbre de una sola vez',
		description:
			'Vía PREFERENTE cuando hay que hacer VARIAS operaciones en Lumbre (crear y/o mutar) de golpe: ' +
			'resuelve TODAS las existencias de tarea del lote en UNA sola comprobación y las encola en UNA ' +
			'sola petición (en vez de una tool call por operación, cada una con su propio round-trip) — ' +
			'úsala en cuanto vayas a hacer más de una operación seguida. Cada elemento de `ops` es EXACTAMENTE ' +
			'lo mismo que la tool individual equivalente (`op:"add_task"` = add_task, `op:"complete"` = ' +
			'complete_task, `op:"cancel"` = cancel_task, `op:"update"` = update_task, `op:"reschedule"` = ' +
			'reschedule_task, `op:"delete"` = delete_task, `op:"set_section"` = set_section, ' +
			'`op:"move_to_list"` = move_to_list, `op:"add_subtask"` = add_subtask, `op:"complete_subtask"` = ' +
			'complete_subtask, `op:"remove_section"` = remove_section, `op:"create_list"` = create_list, ' +
			'`op:"nest_list"` = nest_list, `op:"rename_list"` = rename_list, `op:"remove_list"` = remove_list). ' +
			'Las tools individuales SIGUEN existiendo para una operación suelta. Éxito PARCIAL: una op inválida ' +
			'(taskId inexistente, subtarea donde no aplica, payload inválido) no impide las demás — el ' +
			'resultado detalla qué operación (por su posición en `ops`, 0-indexada) falló y por qué, Y el ' +
			'`id` de cada una que sí se encoló (el de una `create_list` es su `listId`, el de un `add_task` ' +
			'su `taskId` nuevo). ENCADENAR dentro del MISMO lote: la única op que crea algo cuyo id necesites ' +
			'referenciar EN OTRA op del mismo `mutate_tasks` es `create_list` — dale tú mismo un `listId` ' +
			'(uuid v4) al crearla y úsalo en el `move_to_list`/`nest_list` que la targetee, en vez de esperar ' +
			'a la respuesta (el id de un `add_task` lo asigna el servidor y solo se conoce DESPUÉS, no se ' +
			`puede referenciar dentro de la misma llamada). ${ASYNC_NOTE}`,
		inputSchema: {
			ops: z
				.array(mutateTasksOpSchema)
				.min(1)
				.max(200)
				.describe('Operaciones a ejecutar, en el orden indicado (máx. 200 por llamada)')
		}
	},
	async (input) => {
		try {
			const ops = input.ops as MutateTasksOp[];
			const idsToCheck = collectExistenceCheckIds(ops);
			const existing: Map<string, LumbreTask> =
				idsToCheck.length > 0 ? await findTasksByIds(config, idsToCheck) : new Map();
			const { batchOps, originalIndexes, skipped } = buildBatchFromOps(ops, existing);

			const results: BatchResultItem[] = batchOps.length > 0 ? await runBatch(config, batchOps) : [];

			// Ambas fuentes de fallo (descartadas ANTES de mandar el batch, y las
			// que el servidor rechazó al validar/encolar) se combinan en un único
			// informe, ordenado por posición ORIGINAL en `ops` — el modelo ve
			// exactamente qué operación falló y por qué, sin tener que distinguir
			// entre ambas fases. Las EXITOSAS con `id` (code-review 🟠 #3a: antes
			// se perdían — el modelo no podía enterarse del `listId` de un
			// `create_list` sin una `list_tasks` de más) también se recogen, para
			// poder encadenarlas en un turno posterior (o confirmar el id que ya
			// se auto-generó, si la op no traía uno propio — ver `create_list`).
			const failures: { index: number; error: string }[] = [...skipped];
			const succeededWithId: { index: number; id: string }[] = [];
			results.forEach((r, i) => {
				const index = originalIndexes[i];
				if (r.ok) {
					if (r.id !== undefined) succeededWithId.push({ index, id: r.id });
				} else {
					failures.push({ index, error: r.error ?? 'error desconocido' });
				}
			});
			const okCount = results.filter((r) => r.ok).length;
			failures.sort((a, b) => a.index - b.index);
			succeededWithId.sort((a, b) => a.index - b.index);

			const failureLines = failures.map((f) => `  [${f.index}] ${ops[f.index].op}: ${f.error}`);
			const idLines = succeededWithId.map((s) => `  [${s.index}] ${ops[s.index].op}: id ${s.id}`);
			let summary = `Lumbre: ${okCount}/${ops.length} operación(es) encoladas.`;
			if (idLines.length > 0) summary += `\nids asignados:\n${idLines.join('\n')}`;
			if (failureLines.length > 0) {
				summary += `\n${failureLines.length} fallaron:\n${failureLines.join('\n')}`;
			}
			summary += `\n\n${ASYNC_NOTE}`;
			return textResult(summary);
		} catch (err) {
			return errorResult(err);
		}
	}
);

const transport = new StdioServerTransport();
await server.connect(transport);
