#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
	addTask,
	assertTaskUsable,
	buildBatchFromOps,
	collectExistenceCheckIds,
	findTaskById,
	findTasksByIds,
	getAttachment,
	listLists,
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
import { formatListSummaries, formatTaskFull, formatTaskList } from './format.js';
import {
	computeAutoNotesRender,
	computeNotesSinceRender,
	DEFAULT_NOTES_RECENT_HOURS,
	hasNotes,
	parseNotesSince,
	recordNotesSeen,
	type NotesMode
} from './notes.js';

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
 * id con `randomUUID()` antes de encolar, ver su JSDoc más abajo). `list_lists`
 * (fix b00303b5) lee TODAS las listas vivas con su recuento vía
 * `GET /api/tasks?includeLists=1` — a diferencia de `list_tasks({list})`, SÍ
 * distingue una lista que existe pero está vacía de una que no existe (ambas
 * dan `[]` en `list_tasks`, ver su JSDoc). Todas
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
 * `list_tasks({ notes })` decide qué notas mostrar (default `'auto'`, ver
 * `src/notes.ts`): GARANTÍA — en `auto` una nota sale ÍNTEGRA (si lleva
 * `@done`/`#done`, si `notesUpdatedAt` es POSTERIOR a la última vez que este
 * MCP la mostró — huella local en disco por marca, ya no por hash, desde
 * 2026-07-25 — o si se tocó dentro de `notesRecentHours` cuando aún no hay
 * huella) o como marcador `✎N ↻fecha` con su tamaño y la fecha de la última
 * edición, NUNCA truncada a medias (un truncado se confunde con "ya la leí
 * completa", que es justo el bug que motivó esta feature — David escribe su
 * feedback al final de la nota, y el preview de 240 chars se lo comía el 90%
 * de las veces). `notesSince` es una consulta de precisión aparte, SIN
 * estado: solo la marca decide, ignorando @done/huella — "qué cambió desde
 * X". `'none'` omite las notas, `'preview'` es el recorte legado a ~240
 * chars (ya no es el default), `'full'` las deja íntegras para TODO el lote
 * (`fullNotes: true` sigue siendo su alias). `get_task(taskId)` devuelve una
 * única tarea completa (notas verbatim + `createdAt` + lista/sección) —
 * pensado para reeditar una nota con `update_task` (que la REEMPLAZA entera)
 * sin destruir lo que un marcador/preview no traía.
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
	const baseUrl = process.env.LUMBRE_BASE_URL?.trim() || 'https://app.lumbre.pro';
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

// Exportado para poder inspeccionarlo/reconectarlo a un transporte in-memory
// desde `index.test.ts` (ver su cabecera) — la superficie de tools YA
// registrada, sin repetir los 21 `registerTool` de este fichero.
export const server = new McpServer({ name: 'lumbre-mcp', version: '0.1.0' });

const recurrenceSchema = z
	.object({
		freq: z.enum(['daily', 'weekly', 'monthly', 'yearly']).describe('Frecuencia de la repetición'),
		interval: z.number().int().positive().optional().describe('Cada cuántas unidades (default 1)')
	})
	.describe('Recurrencia simple (freq + interval), como la celda "Repetir" del quick-add de Lumbre');

server.registerTool(
	'add_task',
	{
		description:
			'Añade una tarea nueva a Lumbre (planificador semanal). Dispara con "apúntame", ' +
			'"recuérdame", "añade a mi lista/tarea". Se encola y se materializa al sincronizar. ' +
			'`section` coloca la tarea DENTRO de `list` (se crea si no existe); se ignora sin `list`.',
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
				.describe('Hora "HH:MM" (24h); sin `date`, la tarea se agenda hoy'),
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
		description:
			'Fuerza el flush de sync de Lumbre antes de leer (evita que list_tasks devuelva estado ' +
			'rancio). Solo garantiza lo que YA llegó al servidor por WebSocket — si el dispositivo ' +
			'del usuario está offline, sus cambios sin enviar no se pueden recuperar. Sin parámetros.',

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

/**
 * Modo efectivo de `notes` para `list_tasks`: `input.notes` si vino
 * informado, si no `'full'` cuando `fullNotes: true` (alias legado, ver el
 * `.describe()` de ambos campos más arriba), si no `'auto'` (default nuevo).
 * Función PURA — sin red — para poder testear el alias sin mockear `fetch`
 * (mismo patrón que `mutateTasksOpSchema`/`buildBatchFromOps`).
 */
export function effectiveNotesMode(input: { notes?: NotesMode; fullNotes?: boolean }): NotesMode {
	return input.notes ?? (input.fullNotes ? 'full' : 'auto');
}

server.registerTool(
	'list_tasks',
	{
		description:
			'Lee tareas de Lumbre. `scope`: today (default), week, inbox/someday, overdue, all ' +
			'(auto "all" si usas `list` sin `scope`). `list` filtra por nombre; si no existe da ' +
			'vacío igual que una lista vacía existente — usa list_lists para distinguir. `section` ' +
			'agrupa por sección dentro de `list`. `notes` controla las notas de cada tarea (default ' +
			'"auto": íntegra si @done/#done, si cambió desde la última vez que la viste, o si se tocó ' +
			'hace poco (`notesRecentHours`), si no un marcador ✎N con su tamaño y fecha — NUNCA un ' +
			'texto recortado a medias; la cabecera del listado detalla el criterio y te avisa de ' +
			'cuáles no has leído). `notesSince` es una consulta de precisión aparte: solo lo tocado ' +
			'desde esa fecha.',

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
			notes: z
				.enum(['auto', 'none', 'preview', 'full'])
				.optional()
				.describe(
					'"auto" (default): íntegra si @done/#done, si cambió desde la última vez que este MCP ' +
						'la mostró (huella local por `notesUpdatedAt`), o si se tocó dentro de ' +
						'`notesRecentHours` (solo la 1ª vez que se ve esa tarea) — si no, un marcador ' +
						'"✎N ↻fecha" con su tamaño y la fecha de la última edición — GARANTÍA: nunca un ' +
						'recorte a medias. "none": sin notas. "preview": recorte legado a ~240 chars, ' +
						'colapsado a una línea. "full": todas íntegras y verbatim para TODO el lote ' +
						'(equivale a fullNotes:true) — útil si vas a reeditar con update_task (que ' +
						'REEMPLAZA la nota entera). Para una sola tarea concreta, mejor get_task. Se ignora ' +
						'si mandas `notesSince`.'
				),
			fullNotes: z
				.boolean()
				.optional()
				.describe('DEPRECATED, alias de notes:"full" (se ignora si `notes` viene informado).'),
			notesRecentHours: z
				.number()
				.positive()
				.optional()
				.describe(
					`Solo con "auto": ventana (horas, default ${DEFAULT_NOTES_RECENT_HOURS}) para dar por ` +
						'íntegra la nota de una tarea que el MCP ve por 1ª vez (sin huella local aún) — ' +
						'más ventana = más notas íntegras de golpe, más chars en la respuesta.'
				),
			notesSince: z
				.string()
				.min(10)
				.optional()
				.describe(
					'Consulta de precisión, SIN estado: "YYYY-MM-DD" o ISO completo — íntegra SOLO si la ' +
						'nota se editó desde esa fecha (`notesUpdatedAt`), marcador el resto. Ignora `notes`/' +
						'`fullNotes`, @done/#done y la huella local por completo (mezclar criterios haría ' +
						'la consulta impredecible): úsalo para "qué ha cambiado desde X", no para lectura ' +
						'normal.'
				)
		}
	},
	async (input) => {
		try {
			const tasks = await listTasks(config, input);

			if (input.notesSince !== undefined) {
				const since = parseNotesSince(input.notesSince);
				if (!since) {
					return errorResult(
						new Error(
							`notesSince inválido: "${input.notesSince}" (usa "YYYY-MM-DD" o ISO 8601 completo).`
						)
					);
				}
				const autoRender = computeNotesSinceRender(tasks, since);
				return textResult(
					formatTaskList(tasks, input.scope ?? 'today', {
						notesMode: 'auto',
						autoRender,
						notesSinceLabel: input.notesSince
					})
				);
			}

			const notesMode = effectiveNotesMode(input);
			if (notesMode === 'auto') {
				const autoRender = await computeAutoNotesRender(tasks, { windowHours: input.notesRecentHours });
				return textResult(
					formatTaskList(tasks, input.scope ?? 'today', {
						notesMode,
						autoRender,
						notesWindowHours: input.notesRecentHours
					})
				);
			}
			if (notesMode === 'full') {
				// Íntegra en 'full' también cuenta como SURFACEADA — misma huella
				// que 'auto' registra, para que una vuelta con `notes: 'full'` no
				// haga que la siguiente en 'auto' vuelva a marcar "cambió" sin
				// haber cambiado — ver el JSDoc de `recordNotesSeen`.
				await recordNotesSeen(
					tasks
						.filter(hasNotes)
						.map((t) => ({ taskId: t.id, notes: t.notes as string, notesUpdatedAt: t.notesUpdatedAt }))
				);
			}
			return textResult(formatTaskList(tasks, input.scope ?? 'today', { notesMode }));
		} catch (err) {
			return errorResult(err);
		}
	}
);

server.registerTool(
	'list_lists',
	{
		description:
			'Enumera TODAS las listas de "Algún día" con su recuento de tareas, incluidas las ' +
			'vacías (recuento 0) — a diferencia de list_tasks({list}), que no distingue vacía de ' +
			'inexistente. Sin parámetros.',

		inputSchema: {}
	},
	async () => {
		try {
			const lists = await listLists(config);
			return textResult(formatListSummaries(lists));
		} catch (err) {
			return errorResult(err);
		}
	}
);

server.registerTool(
	'get_task',
	{
		description:
			'Devuelve UNA tarea entera y sin recortar (notas íntegras, fecha de creación, ' +
			'lista/sección). Si tiene subtareas, las incluye con su id y estado — única forma de ' +
			'obtener el id de una subtarea. Error si el taskId no existe.',

		inputSchema: {
			taskId: z.string().uuid().describe('Id de la tarea (ver list_tasks)')
		}
	},
	async (input) => {
		try {
			const task = await findTaskById(config, input.taskId);
			if (!task) return errorResult(taskNotFoundError(input.taskId));
			// La nota (si la hay) sale SIEMPRE íntegra aquí (`formatTaskFull`) — se
			// registra como vista, misma huella que `list_tasks({notes:'auto'})`
			// consulta (ver `notes.ts`); best-effort, nunca puede romper esta
			// lectura.
			if (hasNotes(task)) {
				await recordNotesSeen([
					{ taskId: task.id, notes: task.notes as string, notesUpdatedAt: task.notesUpdatedAt }
				]);
			}
			return textResult(formatTaskFull(task));
		} catch (err) {
			return errorResult(err);
		}
	}
);

server.registerTool(
	'read_attachment',
	{
		description:
			'Descarga un adjunto de una tarea de Lumbre por su id (ver el campo `attachments` de ' +
			'list_tasks). Si es una imagen, la devuelve para verla directamente; si no (PDF, etc.), ' +
			'devuelve solo su metadata — no hay forma de leer su contenido con esta tool.',
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

/**
 * Aviso compartido en las tools de Fase 2 y en `mutate_tasks` (15 usos): la
 * app de Lumbre es ASÍNCRONA/eventual (igual que `add_task`) — cada mutación
 * se encola y se aplica la próxima vez que un dispositivo del usuario
 * sincronice, no al instante, y ninguna tool da confirmación inmediata de que
 * se aplicó de verdad (usa `list_tasks` más tarde para comprobarlo). Versión
 * CORTA a propósito: repetida 15 veces en `tools/list`, la redacción larga
 * costaba ~3.3k caracteres solo en esta frase — el detalle completo
 * (por qué es eventual, el rebote del WebSocket, etc.) vive una única vez en
 * `README.md` ("Qué hace — Fase 2").
 */
const ASYNC_NOTE = 'Asíncrono (como add_task): se encola y se aplica al sincronizar, sin confirmación inmediata.';

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
		description:
			`Marca una tarea (o SUBTAREA, aunque para eso es más claro complete_subtask) como hecha, o ` +
			`la desmarca con done:false. ${ASYNC_NOTE}`,
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
		description:
			`Cancela una tarea existente ("no se hizo ni se hará", distinto de completarla); sale ` +
			`igual de pendientes/rollover. Dispara con "cancela"/"descarta" (sin borrarla). ` +
			`cancelled:false la restaura. ${ASYNC_NOTE}`,

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
		description:
			`Edita texto, notas, prioridad u hora de una tarea existente (NO subtareas: rechaza su id ` +
			`con error). Los campos que omitas no cambian; \`notes\` REEMPLAZA las anteriores enteras. ` +
			`${ASYNC_NOTE}`,
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
				.describe('Hora "HH:MM" (24h); si la tarea no tiene día se agenda hoy. null la quita')
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
		description:
			`Mueve una tarea existente a otro día, o a "Algún día"/Bandeja de entrada con date:null. ` +
			`NO aplica a una SUBTAREA (rechaza su id con error). ${ASYNC_NOTE}`,
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
		description:
			`Borra (soft-delete) una tarea existente, o una SUBTAREA suya (borra solo esa). ACCIÓN ` +
			`DELICADA: sin confirmación inmediata ni deshacer — confírmalo con el usuario antes de ` +
			`llamarla. ${ASYNC_NOTE}`,

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
		description:
			'Mueve una tarea existente a una sección dentro de SU lista (se crea si no existe), o ' +
			'la saca con section:null. Se ignora si la tarea no tiene lista propia. NO aplica a ' +
			'subtareas. ' + ASYNC_NOTE,

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
		description:
			'Borra una sección dentro de una lista; sus tareas no se borran, solo quedan sueltas ' +
			'en la MISMA lista. Resuelve `sectionId` desde una tarea que viva ahí ' +
			'(list_tasks/get_task); si no existe, se ignora. ' + ASYNC_NOTE,

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

// ── Gestión de listas de "Algún día" (paridad UI↔MCP, docs/20-contrato-lista.md) ──
//
// `create_list`/`nest_list`/`rename_list`/`remove_list` mutan una LISTA, no
// una tarea; `create_list` es la única que CREA (genera su propio id con
// `randomUUID()` antes de encolar, ver su comentario más abajo). Identidad =
// el id, no el nombre (`rename_list` no la cambia). `remove_list` nunca
// pierde tareas (se reasignan) ni permite borrar la última lista viva ni la
// Bandeja de entrada canónica (§5 "Prohibidos" del contrato). Detalle
// completo del contrato de lista en `docs/20-contrato-lista.md`.

server.registerTool(
	'create_list',
	{
		description:
			`Crea una lista/proyecto de "Algún día" nueva. Devuelve el \`listId\` generado: úsalo ` +
			`después en add_task (\`listId\`), move_to_list o nest_list. ${ASYNC_NOTE}`,
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
		description:
			`Fija el padre de una lista existente (la anida), o la deja de primer nivel con ` +
			`parentId:null. Un anidado inválido (ciclo, auto-anidado, o la Bandeja de entrada) o ` +
			`un id inexistente se descarta en silencio. ${ASYNC_NOTE}`,

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
		description:
			`Renombra una lista EXISTENTE; su identidad (id) y sus tareas no cambian. ${ASYNC_NOTE}`,
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
		description:
			`Borra una lista existente; sus tareas no se pierden (se reasignan o quedan como ` +
			`tarea normal) y sus hijas pasan a primer nivel. No aplica a la última lista viva ni ` +
			`a la Bandeja de entrada: se ignora. ${ASYNC_NOTE}`,

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
		description:
			`Mueve una tarea existente a otra lista, o la desvincula con listId:null. Prefiere ` +
			`\`listId\` (estable) sobre \`list\` (nombre, se crea si no existe). Conserva fecha, ` +
			`limpia sección. NO aplica a subtareas. ${ASYNC_NOTE}`,

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
		description:
			`Añade subtareas (checklist) a una tarea existente. Un solo nivel: si \`taskId\` ya ` +
			`es subtarea, se descarta en silencio. Para crearlas junto con la tarea, usa add_task ` +
			`con \`subtasks\`. ${ASYNC_NOTE}`,

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
		description:
			`Marca hecha (o desmarca con done:false) una SUBTAREA por su id — mismo mecanismo que ` +
			`complete_task, sin cascada sobre la tarea padre. Resuelve \`subtaskId\` con ` +
			`get_task(taskId) de su padre. ${ASYNC_NOTE}`,

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
 * `mutate_tasks` usa DOS schemas de las mismas 15 formas por-op, no uno
 * (medido: aplanar `ops.items` bajó su JSON Schema EXPUESTO de 7.638 a ~3.1k
 * caracteres — el 27% de toda la superficie de `tools/list` — ver la tarea
 * que lo motivó, 2026-07-25):
 *
 * - `mutateTasksOpSchema` (EXPUESTO, más abajo): UN objeto plano con los 21
 *   campos que usan las 15 ops, TODOS opcionales, cada uno con su
 *   `.describe()` UNA sola vez. Antes esto era un `z.discriminatedUnion` de
 *   15 ramas casi idénticas → `anyOf` con los mismos campos y las mismas
 *   descripciones repetidas 15 veces en el JSON Schema que ve el modelo. El
 *   contrato real por-op (qué campo es obligatorio/ajeno a cada `op`) YA NO
 *   vive en el tipo expuesto: vive en la `description` de `ops` (tabla
 *   compacta, `*` = obligatorio) y en el README ("Ejecutar varias
 *   operaciones a la vez").
 * - `mutateTasksStrictOpSchema` (INTERNO — NO forma parte de `inputSchema`,
 *   nunca se serializa): las MISMAS 15 formas por-op de siempre, con los
 *   MISMOS tipos y la MISMA obligatoriedad que tenía cada rama del
 *   `discriminatedUnion` de antes, cada una `.strict()` (rechaza cualquier
 *   campo ajeno a esa op). El handler de `mutate_tasks`, más abajo, la usa
 *   para re-validar cada elemento de `ops` ANTES de tocar red — así
 *   `{op:'complete', date:'2026-01-01'}` (campo `date` ajeno a `complete`)
 *   SIGUE fallando exactamente igual que antes. La diferencia es DÓNDE: con
 *   el `discriminatedUnion` expuesto, una op mal formada tumbaba el
 *   `mutate_tasks` ENTERO en el framework (`validateToolInput`), antes de
 *   que el handler viera nada; ahora entra en el mismo informe de "éxito
 *   parcial" que ya existía para un `taskId` inexistente — se reporta esa
 *   op concreta y las demás, si son válidas, se encolan igual. Mejora de
 *   comportamiento, no solo de tamaño.
 *
 * `create_list.listId` (encadenar dentro del MISMO lote, sin depender de la
 * respuesta): dale tú mismo un uuid v4 al crearla y úsalo en el
 * `move_to_list`/`nest_list` que la targetee en OTRA op del mismo lote —
 * detalle completo (antes en la `.describe()` de esa variante, 335
 * caracteres que solo importan una vez, no repetidos por tool call) movido
 * al README.
 */
export const mutateTasksStrictOpSchema = z.discriminatedUnion('op', [
	z
		.object({
			op: z.literal('add_task'),
			text: z.string().min(1).max(2000),
			list: z.string().max(200).optional(),
			listId: z.string().uuid().optional(),
			section: z.string().max(200).optional(),
			priority: z.enum(['p1', 'p2', 'p3', 'p4']).optional(),
			date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
			deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
			time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
			recurrence: recurrenceSchema.optional(),
			subtasks: z.array(z.string()).optional(),
			notes: z.string().max(10000).optional()
		})
		.strict(),
	z
		.object({
			op: z.literal('complete'),
			taskId: z.string().uuid(),
			done: z.boolean().optional()
		})
		.strict(),
	z
		.object({
			op: z.literal('cancel'),
			taskId: z.string().uuid(),
			cancelled: z.boolean().optional()
		})
		.strict(),
	z
		.object({
			op: z.literal('update'),
			taskId: z.string().uuid(),
			content: z.string().min(1).max(2000).optional(),
			notes: z.string().max(10000).optional(),
			priority: z.enum(['p1', 'p2', 'p3', 'p4']).optional(),
			time: z.union([z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), z.null()]).optional()
		})
		.strict(),
	z
		.object({
			op: z.literal('reschedule'),
			taskId: z.string().uuid(),
			date: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.null()])
		})
		.strict(),
	z
		.object({
			op: z.literal('delete'),
			taskId: z.string().uuid()
		})
		.strict(),
	z
		.object({
			op: z.literal('set_section'),
			taskId: z.string().uuid(),
			section: z.string().max(200).nullable()
		})
		.strict(),
	z
		.object({
			op: z.literal('move_to_list'),
			taskId: z.string().uuid(),
			listId: z.union([z.string().uuid(), z.null()]).optional(),
			list: z.string().max(200).optional()
		})
		.strict(),
	z
		.object({
			op: z.literal('add_subtask'),
			taskId: z.string().uuid(),
			subtasks: z.array(z.string()).min(1).max(50)
		})
		.strict(),
	z
		.object({
			op: z.literal('complete_subtask'),
			subtaskId: z.string().uuid(),
			done: z.boolean().optional()
		})
		.strict(),
	z
		.object({
			op: z.literal('remove_section'),
			sectionId: z.string().uuid()
		})
		.strict(),
	z
		.object({
			op: z.literal('create_list'),
			name: z.string().min(1).max(200),
			color: z.string().max(20).optional(),
			icon: z.string().max(16).optional(),
			listId: z.string().uuid().optional()
		})
		.strict(),
	z
		.object({
			op: z.literal('nest_list'),
			listId: z.string().uuid(),
			parentId: z.union([z.string().uuid(), z.null()])
		})
		.strict(),
	z
		.object({
			op: z.literal('rename_list'),
			listId: z.string().uuid(),
			name: z.string().min(1).max(200)
		})
		.strict(),
	z
		.object({
			op: z.literal('remove_list'),
			listId: z.string().uuid()
		})
		.strict()
]);

/**
 * Schema EXPUESTO de un elemento de `ops` (ver el JSDoc de
 * `mutateTasksStrictOpSchema` de arriba para el porqué de tenerlos
 * separados): plano, los 21 campos que usan las 15 ops TODOS opcionales
 * (salvo `op`), cada uno con su `.describe()` UNA sola vez. `.strict()` aquí
 * solo pilla un nombre de campo que no es NINGUNO de los 21 conocidos
 * (typo); que un campo válido en general no aplique a la `op` concreta de
 * ESE elemento lo pilla `mutateTasksStrictOpSchema` en el handler, no este
 * schema.
 */
export const mutateTasksOpSchema = z
	.object({
		op: z
			.enum([
				'add_task',
				'complete',
				'cancel',
				'update',
				'reschedule',
				'delete',
				'set_section',
				'move_to_list',
				'add_subtask',
				'complete_subtask',
				'remove_section',
				'create_list',
				'nest_list',
				'rename_list',
				'remove_list'
			])
			.describe('Operación a ejecutar — contrato por-op en la description de `ops`, más abajo'),
		taskId: z.string().uuid().optional().describe('Id de la tarea (o subtarea, según la op) — ver list_tasks/get_task'),
		subtaskId: z.string().uuid().optional().describe('Id de la subtarea — ver get_task de su tarea padre'),
		sectionId: z.string().uuid().optional().describe('Id de la sección — ver el campo `sectionId` en list_tasks/get_task'),
		listId: z
			.union([z.string().uuid(), z.null()])
			.optional()
			.describe('Id ESTABLE de una lista: destino, padre, o PRE-GENERADO por ti (create_list, para encadenar)'),
		text: z.string().min(1).max(2000).optional().describe('Texto de la tarea nueva'),
		content: z.string().min(1).max(2000).optional().describe('Nuevo texto/título de la tarea'),
		name: z.string().min(1).max(200).optional().describe('Nombre de la lista'),
		list: z.string().max(200).optional().describe('Nombre de la lista destino (se crea si no existe)'),
		section: z.string().max(200).nullable().optional().describe('Nombre de la sección/heading, o null para quitarla'),
		notes: z.string().max(10000).optional().describe('Notas/descripción (reemplaza las anteriores enteras)'),
		priority: z.enum(['p1', 'p2', 'p3', 'p4']).optional().describe('p1 = más urgente … p4 = ninguna/quitar la prioridad'),
		date: z
			.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.null()])
			.optional()
			.describe('Día YYYY-MM-DD, o null para "Algún día"/Bandeja de entrada'),
		deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Fecha límite ⚑, YYYY-MM-DD'),
		time: z
			.union([z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), z.null()])
			.optional()
			.describe('Hora "HH:MM" (24h); null la quita'),
		recurrence: recurrenceSchema.optional().describe('Recurrencia simple (freq + interval)'),
		subtasks: z.array(z.string()).optional().describe('Textos de las subtareas a añadir/crear, en orden'),
		done: z.boolean().optional().describe('true = completar (default); false = desmarcar'),
		cancelled: z.boolean().optional().describe('true = cancelar (default); false = restaurar'),
		color: z.string().max(20).optional().describe('red|amber|green|blue|violet|pink, o un hex libre "#rrggbb"'),
		icon: z.string().max(16).optional().describe('Emoji/icono de la lista'),
		parentId: z.union([z.string().uuid(), z.null()]).optional().describe('Id de la lista padre destino, o null para desanidar')
	})
	.strict();

/**
 * Mensaje legible para un elemento de `ops` que no encaja en la forma
 * ESTRICTA de su `op` (`mutateTasksStrictOpSchema`): identifica la op y,
 * campo a campo, qué falta o qué sobra — para que el modelo pueda corregir
 * ESE elemento concreto sin adivinar cuál de los 21 campos venía mal.
 */
function formatOpShapeError(op: string, error: z.ZodError): string {
	const parts = error.issues.map((issue) => {
		if (issue.code === 'unrecognized_keys') {
			return `campo(s) que no aplican a "${op}": ${issue.keys.join(', ')}`;
		}
		const field = issue.path.length > 0 ? issue.path.join('.') : '(op)';
		return `${field}: ${issue.message}`;
	});
	return `${op}: ${parts.join('; ')}`;
}

server.registerTool(
	'mutate_tasks',
	{
		description:
			`Vía PREFERENTE para VARIAS operaciones de golpe (crear y/o mutar): resuelve existencias y ` +
			`encola en UNA sola llamada, en vez de una tool call por operación. Cada elemento de \`ops\` ` +
			`equivale a su tool individual (mapeo op↔tool en el README); contrato por-op en la description ` +
			`de \`ops\`. Las tools sueltas siguen existiendo. Éxito PARCIAL: una op inválida no bloquea las ` +
			`demás — el resultado detalla qué falló por posición y el \`id\` de cada una encolada ` +
			`(create_list→listId, add_task→taskId). Encadenar un create_list con otra op del MISMO lote: ` +
			`dale tú el \`listId\` (uuid v4) al crearla. ${ASYNC_NOTE}`,
		inputSchema: {
			ops: z
				.array(mutateTasksOpSchema)
				.min(1)
				.max(200)
				.describe(
					'Operaciones a ejecutar, en el orden indicado (máx. 200 por llamada). Contrato por-op ' +
						'(`*` = obligatorio, el resto opcional): add_task: text* [list|listId, section, ' +
						'priority, date, deadline, time, recurrence, subtasks, notes] · complete: taskId* ' +
						'[done] · cancel: taskId* [cancelled] · update: taskId*, ≥1 de [content, notes, ' +
						'priority, time] · reschedule: taskId*, date* · delete: taskId* · set_section: ' +
						'taskId*, section* · move_to_list: taskId*, uno de [listId, list] · add_subtask: ' +
						'taskId*, subtasks* · complete_subtask: subtaskId* [done] · remove_section: sectionId* ' +
						'· create_list: name* [color, icon, listId] · nest_list: listId*, parentId* · ' +
						'rename_list: listId*, name* · remove_list: listId*'
				)
		}
	},
	async (input) => {
		try {
			// Re-validación ESTRICTA por-op ANTES de tocar red: `mutateTasksOpSchema`
			// (el schema EXPUESTO) es deliberadamente laxo, así que un elemento cuya
			// forma no encaje con SU `op` (campo obligatorio ausente, o un campo
			// válido en general pero ajeno a esa op) todavía no se ha rechazado en
			// este punto — ver el JSDoc de `mutateTasksStrictOpSchema`. Se reporta
			// como un fallo MÁS del informe de éxito parcial (mismo array que
			// `taskId` inexistente), no tumba el `mutate_tasks` entero.
			const rawOps = input.ops as Record<string, unknown>[];
			const validated: MutateTasksOp[] = [];
			// Índice, dentro de `validated` (compactado, sin los descartados por
			// forma), de la posición ORIGINAL en `input.ops` — mismo patrón de
			// indirección que ya usa `buildBatchFromOps` para `batchOps` vs `ops`,
			// aplicado un nivel más arriba.
			const validatedOriginalIndexes: number[] = [];
			const shapeFailures: { index: number; error: string }[] = [];
			rawOps.forEach((raw, index) => {
				const result = mutateTasksStrictOpSchema.safeParse(raw);
				if (!result.success) {
					shapeFailures.push({ index, error: formatOpShapeError(String(raw.op), result.error) });
					return;
				}
				validated.push(result.data as MutateTasksOp);
				validatedOriginalIndexes.push(index);
			});

			const idsToCheck = collectExistenceCheckIds(validated);
			const existing: Map<string, LumbreTask> =
				idsToCheck.length > 0 ? await findTasksByIds(config, idsToCheck) : new Map();
			const built = buildBatchFromOps(validated, existing);
			const batchOps = built.batchOps;
			const originalIndexes = built.originalIndexes.map((i) => validatedOriginalIndexes[i]);

			const results: BatchResultItem[] = batchOps.length > 0 ? await runBatch(config, batchOps) : [];

			// Tres fuentes de fallo ahora (forma inválida, descartadas ANTES de
			// mandar el batch por `buildBatchFromOps`, y las que el servidor
			// rechazó al validar/encolar) se combinan en un único informe,
			// ordenado por posición ORIGINAL en `ops` — el modelo ve exactamente
			// qué operación falló y por qué, sin tener que distinguir entre las
			// tres fases. Las EXITOSAS con `id` (code-review 🟠 #3a: antes se
			// perdían — el modelo no podía enterarse del `listId` de un
			// `create_list` sin una `list_tasks` de más) también se recogen, para
			// poder encadenarlas en un turno posterior (o confirmar el id que ya
			// se auto-generó, si la op no traía uno propio — ver `create_list`).
			const failures: { index: number; error: string }[] = [
				...shapeFailures,
				...built.skipped.map((s) => ({ index: validatedOriginalIndexes[s.index], error: s.error }))
			];
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

			// `op` se lee del elemento CRUDO (`rawOps`), no de `validated` (que no
			// tiene entrada para los descartados por forma) — el schema EXPUESTO
			// ya garantiza que es uno de los 15 nombres válidos.
			const opNameAt = (index: number) => String(rawOps[index].op);
			const failureLines = failures.map((f) => `  [${f.index}] ${opNameAt(f.index)}: ${f.error}`);
			const idLines = succeededWithId.map((s) => `  [${s.index}] ${opNameAt(s.index)}: id ${s.id}`);
			let summary = `Lumbre: ${okCount}/${rawOps.length} operación(es) encoladas.`;
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

/**
 * Borra `$schema` de `value`, recursivamente (arrays y objetos anidados) — la
 * conversión zod→JSON Schema del SDK mete
 * `"$schema":"http://json-schema.org/draft-07/schema#"` en el `inputSchema`
 * de CADA tool (una vez por tool, no una vez global): 1.071 chars en las 21
 * tools de hoy, que ni la API de Anthropic ni ningún cliente MCP leen (el
 * `$schema` de JSON Schema es metadata de qué DIALECTO usar para validar el
 * documento; aquí lo fija el propio SDK al generar, no hace falta que viaje).
 * Muta `value` in-place (no clona) — el llamante ya tiene una copia efímera
 * del mensaje JSON-RPC que va a mandar, no hay nada más que la referencie.
 */
export function stripSchemaRecursively(value: unknown): void {
	if (Array.isArray(value)) {
		for (const item of value) stripSchemaRecursively(item);
		return;
	}
	if (value && typeof value === 'object') {
		delete (value as Record<string, unknown>).$schema;
		for (const v of Object.values(value as Record<string, unknown>)) stripSchemaRecursively(v);
	}
}

/**
 * Envuelve `transport.send` para interceptar la respuesta de `tools/list`
 * (un mensaje JSON-RPC `result` con un array `tools`) y borrarle `$schema` a
 * cada `inputSchema` ANTES de que salga por el wire — ver `stripSchemaRecursively`.
 *
 * POR QUÉ AQUÍ Y NO sustituyendo el handler de `tools/list`: `McpServer`
 * registra ESE handler internamente (`setToolRequestHandlers`, ver
 * `node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js`) con la
 * lógica real de listar/filtrar/convertir cada tool registrada — pisarlo
 * significaría reimplementar esa lógica a mano y que se desincronice en
 * cuanto el SDK cambie de versión. Envolver `send` es un parche NO invasivo
 * (no toca la lógica de negocio del SDK, solo el mensaje ya serializado justo
 * antes de mandarlo) y a prueba de que el SDK cambie CÓMO genera `$schema`
 * (mientras siga siendo un campo llamado igual en `inputSchema`, esto lo pilla).
 *
 * Recibe y devuelve un `Transport` genérico (no específicamente
 * `StdioServerTransport`) para poder aplicar la MISMA lógica sobre un
 * transporte in-memory en tests (`index.test.ts`) sin duplicar código; en
 * producción se aplica sobre el `StdioServerTransport` real, más abajo.
 *
 * ALERTA para quien lea esto dentro de un año: NO es evidente por qué existe
 * (parece un parche raro sobre un objeto ajeno) — el motivo es puramente de
 * coste en tokens de la superficie de tools (ver la tarea que lo introdujo,
 * 2026-07-25); si el SDK algún día deja de emitir `$schema`, esto se puede
 * borrar sin más.
 */
export function stripToolsListSchema(transport: Transport): Transport {
	const originalSend = transport.send.bind(transport);
	transport.send = async (message: JSONRPCMessage, options?: TransportSendOptions) => {
		const result = (message as { result?: unknown }).result;
		if (result && typeof result === 'object' && Array.isArray((result as { tools?: unknown }).tools)) {
			stripSchemaRecursively((result as { tools: unknown }).tools);
		}
		return originalSend(message, options);
	};
	return transport;
}

const transport = stripToolsListSchema(new StdioServerTransport());
await server.connect(transport);
