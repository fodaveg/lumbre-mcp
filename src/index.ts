#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { stripToolsListSchema } from './schema-strip.js';
import { z } from 'zod';
import {
	addTask,
	buildBatchFromOps,
	collectExistenceCheckIds,
	excludeIngestForBrokenListPromises,
	filterPhase2AfterPhase1,
	findTaskById,
	findTasksByIds,
	listTasks,
	planBatchPhases,
	priorityToLevel,
	runBatch,
	taskNotFoundError,
	type BatchResultItem,
	type BrokenListPromise,
	type LumbreConfig,
	type LumbreTask,
	type MutateTasksOp,
	type TaskScope
} from './lumbre-client.js';
import { formatTaskFull, formatTaskList } from './format.js';
import { resolveRefs } from './refs.js';
import { ASYNC_NOTE, errorResult, formatOpShapeError, textResult, type ToolCtx } from './tools/shared.js';
import { registerSyncTools } from './tools/sync.js';
import { registerAttachmentTools } from './tools/attachments.js';
import { registerListTools } from './tools/lists.js';
import { registerBrlTools } from './tools/brl.js';
// Reexportadas tal cual: `index.test.ts` las importa directamente de
// `index.js` (guardarraíl de superficie expuesta, ver su JSDoc).
export { mutateBrlOpSchema, mutateBrlStrictOpSchema } from './tools/brl.js';
import { requireTaskExists, mutateTaskInvalidating } from './tools/task-existence.js';
import {
	computeAutoNotesRender,
	computeNotesSinceRender,
	DEFAULT_NOTES_RECENT_HOURS,
	fileNotesSeenStore,
	hasNotes,
	parseNotesSince,
	recordNotesSeen,
	type AutoNotesResult,
	type NotesMode,
	type NotesSeenStore
} from './notes.js';
import { EXISTENCE_CACHE_TTL_MS, getExistenceCachesForToken } from './existence-cache.js';

/**
 * Conector MCP de Lumbre (transporte stdio, pensado para Claude Code). Fase 1:
 * `add_task` (escribe vía `/api/ingest`) y `list_tasks` (lee vía
 * `GET /api/tasks`, incluye los adjuntos de cada tarea). `read_attachment` lee
 * los BYTES de un adjunto (vía `GET /api/attachments/:id`, mismo token
 * ampliado para servirlos por `Authorization: Bearer` además de por sesión).
 * `add_attachment` es la vía inversa: sube un fichero LOCAL (por ruta, ver
 * `attachments.ts`) y lo enlaza a una tarea vía `POST /api/attachments` —a
 * diferencia de TODO lo demás en esta lista, es SÍNCRONA: no se encola, el
 * adjunto ya está enlazado cuando la tool responde (ver su JSDoc, más abajo).
 * `delete_attachment` retira un adjunto existente por id mediante
 * `DELETE /api/attachments/:id`; es destructiva y no ofrece deshacer.
 * Fase 2: `complete_task`/`cancel_task`/`update_task`/`reschedule_task`/
 * `delete_task`/`set_section`/`add_subtask`/`complete_subtask`/
 * `remove_section` (mutan una tarea EXISTENTE vía `/api/mutations` — ver
 * PHASE2.md; `remove_section` es la excepción, muta una SECCIÓN). La gestión
 * de listas de "Algún día" (crear/anidar/renombrar/borrar una lista, mover
 * una tarea a otra lista — paridad UI↔MCP, `docs/20-contrato-lista.md`) YA NO
 * tiene tool suelta (podadas el 2026-08-27, medido: 3.506 bytes de
 * `tools/list` por 19 llamadas/mes de uso real): son las ops
 * `create_list`/`nest_list`/`rename_list`/`remove_list`/`move_to_list` de
 * `mutate_tasks`, que ya las cubría entera — `create_list.listId` es incluso
 * un SUPERCONJUNTO (encadenar dentro del mismo lote, cosa que la tool suelta
 * no tenía). `list_lists` (fix b00303b5) lee TODAS las listas vivas con su
 * recuento vía `GET /api/tasks?includeLists=1` — a diferencia de
 * `list_tasks({list})`, SÍ distingue una lista que existe pero está vacía de
 * una que no existe (ambas dan `[]` en `list_tasks`, ver su JSDoc); si trae
 * nota, la línea termina con el marcador `✎N ↻fecha` (tarea 827a7878, ver
 * `notes.ts`), nunca la nota entera. `get_list({ listId })` devuelve el
 * detalle de UN proyecto/área (tipo, padre, estado, recuento) con su nota
 * ÍNTEGRA y verbatim — pensada para leerla antes de reescribirla con
 * `mutate_tasks({op:"set_list_notes"})`, que la REEMPLAZA entera.
 * `list_brl_entries`/`mutate_brl` (BRL, add-on experimental): leen y mutan el
 * REGISTRO del día —entradas `-` (nota) y `=` (pensamiento)—, que NO son
 * tareas y no salen en `list_tasks`; ver el bloque «BRL» más abajo (los tres
 * verbos sueltos, `add`/`update`/`delete_brl_entry`, se podaron el mismo día
 * que las de lista — mismo criterio: `mutate_brl` los cubre entero). Todas
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
 *
 * `list_tasks`/`get_task` resuelven además, EN VIVO, las referencias
 * `[[task:ID|Etiqueta]]`/`[[list:ID|Etiqueta]]` que traiga el texto o las notas
 * del lote (`refs.ts`): título ACTUAL + estado + id + marcador `✎N` si la tarea
 * referenciada tiene nota, y ROTA declarada si el destino ya no existe. Antes
 * se reenviaba la etiqueta congelada del enlace, así que una referencia rota
 * era indistinguible de una viva. Cuesta como mucho DOS peticiones extra por
 * lote (una `?ids=` con todos los ids de tarea de golpe + una `?includeLists=1`
 * solo si hay referencias a listas) y CERO si el lote no tiene referencias.
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
	// `authMode: 'token'` — este proceso stdio SIEMPRE lee una credencial
	// estática de env (ver el JSDoc de `LumbreConfig.authMode`); un 401 de la
	// API sí puede resolverse configurando `LUMBRE_TOKEN` de nuevo.
	return { baseUrl, token, authMode: 'token' };
}

const recurrenceSchema = z
	.object({
		freq: z.enum(['daily', 'weekly', 'monthly', 'yearly']).describe('Frecuencia de la repetición'),
		interval: z.number().int().positive().optional().describe('Cada cuántas unidades (default 1)')
	})
	.describe('Recurrencia simple (freq + interval), como la celda "Repetir" del quick-add de Lumbre');

const tagSchema = z.string().regex(/^[\p{L}\p{N}_][\p{L}\p{N}_-]*$/u);

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

/**
 * Alcance EFECTIVO de `list_tasks`, el que va en la cabecera de
 * `formatTaskList` — tiene que ser el mismo default que aplica el SERVIDOR
 * (ver el JSDoc de `ListTasksInput.list` en `lumbre-client.ts`: sin `scope`
 * explícito y con `list`, el servidor amplía el alcance temporal a "all"),
 * no el default LOCAL de esta tool ("today"). Bug real medido el 2026-09-17:
 * `list_tasks({ list: "addons", section: "MCP" })`, sin `scope`, devolvía
 * "3 tareas (scope=today)" con el contenido de scope=all — la cabecera
 * pintaba `input.scope ?? 'today'` sin mirar `list`, mientras la petición al
 * servidor sí se beneficiaba de su propio default ampliado. Función PURA —
 * sin red — mismo patrón que `effectiveNotesMode`.
 */
export function effectiveScopeLabel(input: { scope?: TaskScope; list?: string }): TaskScope {
	return input.scope ?? (input.list ? 'all' : 'today');
}

/**
 * Textos del lote que hay que escanear en busca de referencias
 * (`[[task:…]]`/`[[list:…]]`, ver `refs.ts`): SIEMPRE el contenido de cada
 * tarea, y sus notas SOLO si de verdad se van a pintar en esta respuesta —
 * resolver la referencia de una nota que sale como marcador (o que `notes:
 * 'none'` omite) gastaría hueco del `?ids=` para algo que nadie va a leer.
 * Pura, sin red: decide QUÉ pedir, no lo pide. `'preview'` sí se incluye
 * entero aunque el recorte a 240 chars pueda dejar fuera alguna referencia
 * (modo legado, no vale la pena afinar más).
 */
export function refTexts(
	tasks: LumbreTask[],
	notesMode: NotesMode,
	autoRender?: AutoNotesResult
): (string | null | undefined)[] {
	const texts: (string | null | undefined)[] = [];
	for (const t of tasks) {
		texts.push(t.content);
		if (notesMode === 'none') continue;
		if (notesMode === 'auto' && autoRender?.perTask.get(t.id)?.kind !== 'full') continue;
		texts.push(t.notes);
	}
	return texts;
}

/**
 * `mutate_tasks` usa DOS schemas de las mismas 15 formas por-op, no uno
 * (medido: aplanar `ops.items` bajó su JSON Schema EXPUESTO de 7.638 a ~3.1k
 * caracteres — el 27% de toda la superficie de `tools/list` — ver la tarea
 * que lo motivó, 2026-07-25):
 *
 * - `mutateTasksOpSchema` (EXPUESTO, más abajo): UN objeto plano con los 22
 *   campos que usan las 16 ops, TODOS opcionales, cada uno con su
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
			tags: z.array(tagSchema).optional(),
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
			tags: z.array(tagSchema).optional(),
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
		.strict(),
	z
		.object({
			op: z.literal('set_list_notes'),
			listId: z.string().uuid(),
			notes: z.string().max(10000).nullable(),
			revive: z.boolean().optional()
		})
		.strict()
]);

/**
 * Schema EXPUESTO de un elemento de `ops` (ver el JSDoc de
 * `mutateTasksStrictOpSchema` de arriba para el porqué de tenerlos
 * separados): plano, los campos que usan las 16 ops TODOS opcionales
 * (salvo `op`). Poda de superficie (2026-08-25, medido: bajó el JSON Schema
 * EXPUESTO de este objeto de 3.994 a 3.683 caracteres — ver el test de
 * superficie en `index.test.ts`): cada campo tiene `.describe()` SOLO si
 * aporta algo que el nombre del campo + su
 * tipo/patrón no dicen ya (semántica de `null`, default al omitir, o el
 * comportamiento no obvio de un campo como `list`/`notes`) — `text`,
 * `content`, `name`, `deadline`, `icon` y `recurrence` se quedan sin
 * `.describe()` propio porque esa info ya vive en el nombre del campo, en
 * `recurrenceSchema`, o en la tool individual (`create_list` para `icon`).
 * `.strict()` aquí solo pilla un nombre de campo desconocido (typo); que un campo válido en general no aplique a la `op`
 * concreta de ESE elemento lo pilla `mutateTasksStrictOpSchema` en el
 * handler, no este schema.
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
				'remove_list',
				'set_list_notes'
			])
			.describe('Operación a ejecutar — contrato por-op en la description de `ops`'),
		taskId: z.string().uuid().optional().describe('Id de la tarea — ver list_tasks/get_task'),
		subtaskId: z.string().uuid().optional().describe('Id de la subtarea — ver get_task de su tarea padre'),
		sectionId: z.string().uuid().optional().describe('Id de la sección — ver list_tasks/get_task'),
		listId: z
			.union([z.string().uuid(), z.null()])
			.optional()
			.describe('Id del proyecto o área: destino, padre, o uno generado para encadenar con create_list'),
		// `text`/`content`/`name`/`deadline`: sin describe propio — el nombre
		// del campo ya lo dice todo (texto de la tarea nueva o su nuevo
		// texto/título, nombre de la lista, fecha límite) y no hay semántica
		// extra (null, default, autocreación…) que documentar; qué op usa cuál
		// ya está en la description de `ops`.
		text: z.string().min(1).max(2000).optional(),
		content: z.string().min(1).max(2000).optional(),
		tags: z.array(tagSchema).optional(),
		name: z.string().min(1).max(200).optional(),
		list: z.string().max(200).optional().describe('Nombre del proyecto o área destino (se crea como proyecto si no existe)'),
		section: z.string().max(200).nullable().optional().describe('Nombre de la sección, o null para quitarla'),
		notes: z
			.union([z.string().max(10000), z.null()])
			.optional()
			.describe('Notas (reemplaza las anteriores enteras; null las borra en set_list_notes)'),
		priority: z.enum(['p1', 'p2', 'p3', 'p4']).optional().describe('p1 = más urgente … p4 = ninguna'),
		date: z
			.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.null()])
			.optional()
			.describe('YYYY-MM-DD, o null para "Algún día"/Bandeja de entrada'),
		deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
		time: z
			.union([z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), z.null()])
			.optional()
			.describe('24h; null la quita'),
		// `recurrence`: sin describe propio — `recurrenceSchema` ya documenta
		// `freq`/`interval` campo a campo (compartido con `add_task`).
		recurrence: recurrenceSchema.optional(),
		subtasks: z.array(z.string()).optional().describe('Textos de las subtareas, en orden'),
		done: z.boolean().optional().describe('true = completar (default); false = desmarcar'),
		cancelled: z.boolean().optional().describe('true = cancelar (default); false = restaurar'),
		color: z.string().max(20).optional().describe('red|amber|green|blue|violet|pink, o un hex libre "#rrggbb"'),
		revive: z.boolean().optional().describe('true restaura una nota de proyecto o área borrada previamente'),
		// `icon`: sin describe propio — mismo criterio que `text`/`name`; su
		// semántica (emoji/icono del proyecto o área) ya la dice el nombre del campo.
		icon: z.string().max(16).optional(),
		parentId: z.union([z.string().uuid(), z.null()]).optional().describe('Id del proyecto o área padre, o null para desanidar')
	})
	.strict();

/**
 * Opciones de `createServer` — la costura de portabilidad (M1): el arranque
 * stdio (`main`, más abajo) pasa `localFilesystem: true` explícito; un futuro
 * transporte no-stdio podría inyectar otra (p. ej. un `NotesSeenStore` en
 * memoria por-request, en vez de fichero).
 */
export interface CreateServerOptions {
	/** Huella de notas vistas (ver `notes.ts`) — default `fileNotesSeenStore`
	 *  (el fichero en `XDG_STATE_HOME`, el que usa el arranque stdio). */
	notesSeenStore?: NotesSeenStore;
	/** Reloj de las cachés de existencia (`taskCache`/`brlCache`, ver
	 *  `existence-cache.ts`) — default `Date.now`; inyectable solo para poder
	 *  testear la expiración del TTL sin `setTimeout`/temporizadores falsos. */
	now?: () => number;
	/**
	 * Si este proceso VE el disco del usuario — decide cómo se comporta
	 * `add_attachment({ file_path })` (ver su JSDoc, más abajo): con acceso,
	 * lee la ruta local tal cual (comportamiento de siempre); sin acceso,
	 * devuelve un error explicativo SIN tocar disco ni red, porque
	 * `resolveLocalPath`/`fs.stat` se resolverían contra el disco del
	 * SERVIDOR, no el del usuario que pregunta — bug real, medido el 2026-08-27
	 * contra `mcp.lumbre.pro`: "No existe el fichero" con el fichero existiendo
	 * en el Mac del usuario en ese mismo instante, porque el `fs.stat` corría
	 * en el VPS.
	 *
	 * Default `true` (el MENOS sorprendente para quien construye un servidor
	 * sin pensar en el transporte: es el comportamiento que ya tenía esta
	 * función antes de que existiera esta opción, y el que espera
	 * `index.test.ts`, que construye servidores sin pasar `opts`). Los DOS
	 * transportes reales lo pasan EXPLÍCITO en vez de confiar en el default:
	 * `main()` (stdio, más abajo) con `true` — corre en la máquina del
	 * usuario —, `http.ts` con `false` — corre en el VPS compartido, cada
	 * petición es de un usuario distinto y NINGUNO ve su disco desde ahí.
	 */
	localFilesystem?: boolean;
	/**
	 * Acota qué tools registra `createServer` — pensado para un SEGUNDO
	 * conector stdio LOCAL dedicado a adjuntos (ver README, "Transporte HTTP
	 * remoto"): con `'attachments'`, solo `add_attachment`/`read_attachment`/
	 * `delete_attachment`; con cualquier otro valor (incluido `undefined`, el
	 * default), las 24 de siempre. Existe para que David pueda tener el
	 * conector remoto (24 tools) Y un conector local de adjuntos a la vez sin
	 * duplicar las 24 en el contexto de cada sesión (`tools/list` ya pesa ~26
	 * KB de JSON; dos
	 * copias son dos veces ese coste, y el modelo encima tendría que acertar
	 * cuál de los dos `add_task`/`list_tasks` usar). `main()` la lee de
	 * `LUMBRE_MCP_TOOLSET` (env); `http.ts` NUNCA la pasa — el conector
	 * remoto sigue exponiendo las 24 siempre, pase lo que pase con la env del
	 * proceso que lo arrancó.
	 */
	toolset?: 'all' | 'attachments';
}

/**
 * Factory del servidor MCP de Lumbre: registra las tools con `config`
 * INYECTADO (nada de estado de módulo, ver el histórico de este fichero) y
 * devuelve el `McpServer` ya construido, sin conectar a ningún transporte —
 * eso es cosa del llamante (`main`, más abajo, para stdio; `http.ts` para el
 * transporte remoto). Registra las 24 de siempre salvo que
 * `opts.toolset === 'attachments'` (ver su JSDoc arriba), en cuyo caso solo
 * quedan `add_attachment`/`read_attachment`/`delete_attachment` — las demás
 * se registran igual
 * (para no bifurcar cada una de las 21 llamadas a `registerTool` con un
 * `if`) y se retiran acto seguido con `.remove()`, ANTES de que este
 * `McpServer` se conecte a ningún transporte: ningún cliente llega a ver el
 * estado intermedio de "24 registradas".
 *
 * `taskCache`/`brlCache` (cachés cortas de existencia, ver
 * `existence-cache.ts`) salen del registro de MÓDULO indexado por
 * `config.token` — no de una instancia nueva por llamada: en el transporte
 * HTTP remoto (`http.ts`) esta factory se invoca DENTRO de cada petición, así
 * que una caché de instancia nacía y moría con ella sin llegar a acertar
 * nunca (medido: 0 aciertos en remoto). El registro sí sobrevive entre
 * llamadas — vive mientras viva el proceso — y aísla por token (ver el
 * JSDoc de `getExistenceCachesForToken`), así que dos credenciales
 * distintas nunca comparten caché.
 */
export function createServer(config: LumbreConfig, opts: CreateServerOptions = {}): McpServer {
	const notesSeenStore = opts.notesSeenStore ?? fileNotesSeenStore;
	const { taskCache, brlCache } = getExistenceCachesForToken(config.token, EXISTENCE_CACHE_TTL_MS, opts.now ?? Date.now);
	const localFilesystem = opts.localFilesystem ?? true;
	const toolset = opts.toolset ?? 'all';

	const server = new McpServer({ name: 'lumbre-mcp', version: '0.1.0' });

	// Contexto explícito para las familias YA migradas a `src/tools/` (ver el
	// JSDoc de `ToolCtx`) — crece según avanza la partición de este fichero.
	const ctx: ToolCtx = { config, taskCache, brlCache, notesSeenStore, localFilesystem };

	const addTaskTool = server.registerTool(
		'add_task',
		{
			description:
				'Añade una tarea nueva a Lumbre (planificador semanal). Dispara con "apúntame", ' +
				'"recuérdame", "añade a mi proyecto/área". Se encola y se materializa al sincronizar. ' +
				'`section` coloca la tarea DENTRO de `list` (se crea si no existe); se ignora sin `list`.',
			inputSchema: {
				text: z.string().min(1).max(2000).describe('Texto de la tarea (obligatorio)'),
				list: z
					.string()
					.max(200)
					.optional()
					.describe(
						'Nombre del proyecto o área destino (se crea como proyecto si no existe). Sin `list` y sin ' +
							'date, el cliente la coloca en "hoy" al materializarla.'
					),
				listId: z
					.string()
					.uuid()
					.optional()
					.describe(
						'Id ESTABLE del proyecto o área destino, PREFERENTE sobre `list` (inmune a renames); sácalo ' +
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
				notes: z.string().max(10000).optional().describe('Notas/descripción larga'),
				tags: z
					.array(tagSchema)
					.optional()
					.describe('Tags propios; [] deja la tarea explícitamente sin tags')
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

	// Familia «sync» (extraída a `src/tools/sync.ts`, ver su JSDoc: por qué
	// `refresh_sync` casi nunca hace falta tras una escritura de ESTE MCP).
	const { refreshSyncTool } = registerSyncTools(server, ctx);

	const listTasksTool = server.registerTool(
		'list_tasks',
		{
			description:
				'Lee tareas de Lumbre. `scope`: today (default), week, upcoming, inbox/someday, overdue, ' +
				'all (auto "all" si usas `list` sin `scope`). `list` filtra por nombre; si no existe da ' +
				'vacío igual que un proyecto o área vacíos — usa list_lists para distinguir. `section` ' +
				'agrupa por sección dentro de `list`; `includeArchived` permite consultar archivadas. ' +
				'`notes` decide qué notas trae cada tarea (criterio completo en su `.describe()`; ' +
				'GARANTÍA: nunca un texto recortado a medias; la cabecera avisa de las no leídas). ' +
				'`notesSince` es una consulta de precisión aparte: solo lo tocado desde esa fecha.',

			inputSchema: {
				scope: z
					.enum(['today', 'week', 'upcoming', 'inbox', 'someday', 'overdue', 'all'])
					.optional()
					.describe(
						'Alcance temporal; default "today" ("all" si se usa `list` sin `scope`). "week" es la ' +
							'semana de CALENDARIO; "upcoming" es una ventana rodante que siempre empieza hoy'
					),
				days: z
					.number()
					.int()
					.min(1)
					.max(14)
					.optional()
					.describe('Solo con scope "upcoming": días de la ventana contando hoy (default 7, máx 14)'),
				list: z
					.string()
					.optional()
					.describe('Nombre (case-insensitive) de un proyecto o área a filtrar'),
				section: z
					.string()
					.optional()
					.describe(
						'Nombre (case-insensitive) de una sección dentro de `list` a filtrar (Fase B, ' +
							'proyectos/áreas); combinado con `list`, solo casa una sección de ESE destino'
					),
				includeDone: z.boolean().optional().describe('Incluir tareas ya completadas; default false'),
				includeArchived: z
					.boolean()
					.optional()
					.describe(
						'Incluir tareas archivadas; default false. En listados sigue combinándose con ' +
							'includeDone y el resto de filtros'
					),
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
				if (input.notesSince !== undefined) {
					const since = parseNotesSince(input.notesSince);
					if (!since) {
						return errorResult(
							new Error(
								`notesSince inválido: "${input.notesSince}" (usa "YYYY-MM-DD" o ISO 8601 completo).`
							)
						);
					}
					// Consulta de precisión, siempre con las notas ENTERAS (sin
					// `notesQuery`, ver el JSDoc de `computeNotesSinceRender`): no es el
					// camino que optimiza esta feature, así que se queda con el
					// comportamiento de siempre.
					const tasks = await listTasks(config, input);
					taskCache.setAll(tasks);
					const autoRender = computeNotesSinceRender(tasks, since);
					const refs = await resolveRefs(config, refTexts(tasks, 'auto', autoRender), {
						includeArchived: input.includeArchived
					});
					return textResult(
						formatTaskList(tasks, effectiveScopeLabel(input), {
							notesMode: 'auto',
							autoRender,
							notesSinceLabel: input.notesSince,
							refs
						})
					);
				}

				const notesMode = effectiveNotesMode(input);

				if (notesMode === 'none') {
					// El texto no se usa para nada: una sola petición, ahorro máximo —
					// un servidor VIEJO ignora `notes=none` y todo sigue funcionando
					// igual, solo que sin ahorrar.
					const tasks = await listTasks(config, { ...input, notesQuery: 'none' });
					taskCache.setAll(tasks);
					const refs = await resolveRefs(config, refTexts(tasks, notesMode), {
						includeArchived: input.includeArchived
					});
					return textResult(formatTaskList(tasks, effectiveScopeLabel(input), { notesMode, refs }));
				}

				if (notesMode === 'auto') {
					const { list, autoRender } = await listTasksAutoTwoPhase(input);
					const refs = await resolveRefs(config, refTexts(list, notesMode, autoRender), {
						includeArchived: input.includeArchived
					});
					return textResult(
						formatTaskList(list, effectiveScopeLabel(input), {
							notesMode,
							autoRender,
							notesWindowHours: input.notesRecentHours,
							refs
						})
					);
				}

				// 'preview'/'full': notas enteras de siempre, sin optimizar ('full'
				// las necesita TODAS íntegras, 'preview' las trunca aquí mismo a
				// partir del texto completo).
				const tasks = await listTasks(config, input);
				taskCache.setAll(tasks);
				if (notesMode === 'full') {
					// Íntegra en 'full' también cuenta como SURFACEADA — misma huella
					// que 'auto' registra, para que una vuelta con `notes: 'full'` no
					// haga que la siguiente en 'auto' vuelva a marcar "cambió" sin
					// haber cambiado — ver el JSDoc de `recordNotesSeen`.
					await recordNotesSeen(
						tasks
							.filter(hasNotes)
							.map((t) => ({ taskId: t.id, notes: t.notes as string, notesUpdatedAt: t.notesUpdatedAt })),
						notesSeenStore
					);
				}
				const refs = await resolveRefs(config, refTexts(tasks, notesMode), {
					includeArchived: input.includeArchived
				});
				return textResult(formatTaskList(tasks, effectiveScopeLabel(input), { notesMode, refs }));
			} catch (err) {
				return errorResult(err);
			}
		}
	);

	/**
	 * `list_tasks({notes:'auto'})` (default) en DOS FASES — perf, 2026-08-25:
	 * antes, `listTasks` traía el texto de TODAS las notas siempre, aunque la
	 * mayoría (las que la decisión manda a marcador) se tiran en local (medido
	 * contra datos reales: de un `scope=all` de 542 KB, 307 KB — 56,6% — eran
	 * texto de notas, ver el encargo de esta feature).
	 *
	 * 1. Fase 1: `GET /api/tasks?notes=length` — cada tarea trae `notesLength`
	 *    en vez del texto (ver `ListTasksInput.notesQuery`).
	 * 2. Detección de servidor VIEJO (aún no conoce `notes=length`, ver el
	 *    JSDoc de `LumbreTask.notesLength`): NINGUNA tarea trae la PROPIEDAD
	 *    `notesLength` (con `in`, no comprobando si vale `null` — un servidor
	 *    NUEVO también puede mandar `notesLength: null` en una tarea sin nota)
	 *    → ya nos ha dado las notas enteras igual (ignoró el parámetro), así
	 *    que seguimos con ESE mismo lote: repliegue a coste CERO, sin 2ª
	 *    petición.
	 * 3. Servidor NUEVO: decide íntegra/marcador por tarea con lo que ya
	 *    sabemos (`computeAutoNotesRender`, que ahora sabe leer `notesLength`
	 *    sin necesitar el texto — ver `notes.ts`).
	 * 4. Fase 2: SOLO para las que la decisión marcó íntegras, `GET
	 *    /api/tasks?ids=<esos ids>&notes=full` (una petición; trocea >200 ids
	 *    — `findTasksByIds`) para traer su texto. Conjunto vacío → ninguna
	 *    petición extra.
	 * 5. GARANTÍA (README): si la fase 2 falla, o devuelve MENOS tareas de las
	 *    pedidas (p. ej. una tarea borrada entre medias) o con la nota vacía,
	 *    esa nota se REPLIEGA a marcador — con la longitud/fecha YA conocidas
	 *    de la fase 1 — en vez de colar un texto a medias o una nota vacía
	 *    disfrazada de "sin nota".
	 */
	async function listTasksAutoTwoPhase(
		input: Parameters<typeof listTasks>[1] & { notesRecentHours?: number }
	): Promise<{ list: LumbreTask[]; autoRender: Awaited<ReturnType<typeof computeAutoNotesRender>> }> {
		const phase1 = await listTasks(config, { ...input, notesQuery: 'length' });
		const isNewServer = phase1.some((t) => 'notesLength' in t);

		if (!isNewServer) {
			taskCache.setAll(phase1);
			const autoRender = await computeAutoNotesRender(
				phase1,
				{ windowHours: input.notesRecentHours },
				notesSeenStore
			);
			return { list: phase1, autoRender };
		}

		const autoRender = await computeAutoNotesRender(
			phase1,
			{ windowHours: input.notesRecentHours },
			notesSeenStore
		);

		const fullIds = phase1
			.filter((t) => autoRender.perTask.get(t.id)?.kind === 'full')
			.map((t) => t.id);
		let fullTasksById = new Map<string, LumbreTask>();
		if (fullIds.length > 0) {
			try {
				fullTasksById = await findTasksByIds(config, fullIds, {
					notesQuery: 'full',
					includeArchived: input.includeArchived
				});
			} catch {
				// La fase 2 falló DEL TODO (red, 5xx…): `fullTasksById` se queda
				// vacío y cada tarea "íntegra" cae al mismo repliegue de abajo
				// (tarea ausente del Map) — GARANTÍA, nunca a medias ni rompe el
				// listado entero por un fallo que solo afecta al TEXTO de la nota.
			}
		}

		const list = phase1.map((t) => {
			const decision = autoRender.perTask.get(t.id);
			if (decision?.kind !== 'full') return t;
			const full = fullTasksById.get(t.id);
			if (!full || !hasNotes(full)) {
				// Repliegue a marcador (garantía de arriba): la fase 2 no trajo esta
				// tarea (borrada entre medias, p. ej.), falló del todo, o su nota ya
				// no está — NUNCA texto a medias ni una nota vacía disfrazada de "sin
				// nota".
				autoRender.perTask.set(t.id, { ...decision, kind: 'marker' });
				autoRender.fullCount--;
				autoRender.markerCount++;
				return t;
			}
			return { ...t, notes: full.notes };
		});

		taskCache.setAll(list);
		return { list, autoRender };
	}

	// Familia «listas y proyectos» (extraída a `src/tools/lists.ts`, paridad
	// UI↔MCP, `docs/20-contrato-lista.md`).
	const { listListsTool, getListLinksTool, getListTool, linkListNoteTool, unlinkListNoteTool } =
		registerListTools(server, ctx);

	const getTaskTool = server.registerTool(
		'get_task',
		{
			description:
				'Devuelve UNA tarea entera y sin recortar (notas íntegras, fecha de creación, ' +
				'proyecto o área/sección). Si tiene subtareas, las incluye con su id y estado — única forma de ' +
				'obtener el id de una subtarea. `includeArchived` permite recuperarla si está archivada. ' +
				'Error si el taskId no existe.',

			inputSchema: {
				taskId: z.string().uuid().describe('Id de la tarea (ver list_tasks)'),
				includeArchived: z
					.boolean()
					.optional()
					.describe('Permitir recuperar la tarea por id aunque esté archivada; default false')
			}
		},
		async (input) => {
			try {
				const task = await findTaskById(config, input.taskId, {
					includeArchived: input.includeArchived
				});
				if (!task) return errorResult(taskNotFoundError(input.taskId));
				taskCache.set(task);
				// La nota (si la hay) sale SIEMPRE íntegra aquí (`formatTaskFull`) — se
				// registra como vista, misma huella que `list_tasks({notes:'auto'})`
				// consulta (ver `notes.ts`); best-effort, nunca puede romper esta
				// lectura.
				if (hasNotes(task)) {
					await recordNotesSeen(
						[{ taskId: task.id, notes: task.notes as string, notesUpdatedAt: task.notesUpdatedAt }],
						notesSeenStore
					);
				}
				// Referencias EN VIVO del texto, la nota (que aquí sale siempre íntegra)
				// y las subtareas — ver `refs.ts`. Cero peticiones extra si no hay
				// ninguna referencia, que es el caso normal.
				const refs = await resolveRefs(
					config,
					[task.content, task.notes, ...(task.subtasks ?? []).map((s) => s.content)],
					{ includeArchived: input.includeArchived }
				);
				return textResult(formatTaskFull(task, refs));
			} catch (err) {
				return errorResult(err);
			}
		}
	);

	// Familia «adjuntos» (extraída a `src/tools/attachments.ts`): las tres tools
	// que quedan solas en `toolset: 'attachments'`, ver `CreateServerOptions`.
	const { readAttachmentTool, addAttachmentTool, deleteAttachmentTool } = registerAttachmentTools(server, ctx);

	// ── Fase 2: mutar una tarea existente (ver PHASE2.md) ──────────────────────
	//
	// `requireTaskExists`/`mutateTaskInvalidating` (comprobación de existencia y
	// wrapper de `mutateTask` que invalida la caché, ver su JSDoc completo en
	// `tools/task-existence.ts`) se extrajeron ahí porque `tools/attachments.ts`
	// TAMBIÉN las necesita (`add_attachment`) — ya no son closures de esta
	// función, reciben `ctx` explícito.

	const completeTaskTool = server.registerTool(
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
				await requireTaskExists(ctx, input.taskId, { allowSubtask: true });
				await mutateTaskInvalidating(ctx, {
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

	const cancelTaskTool = server.registerTool(
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
				await requireTaskExists(ctx, input.taskId, { allowSubtask: true });
				await mutateTaskInvalidating(ctx, {
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

	const updateTaskTool = server.registerTool(
		'update_task',
		{
			description:
				`Edita texto, notas, tags propios, prioridad u hora de una tarea existente, o de una ` +
				`SUBTAREA suya (los cinco campos valen igual en una subtarea). Los campos que omitas ` +
				`no cambian; \`notes\` REEMPLAZA las anteriores enteras. ${ASYNC_NOTE}`,
			inputSchema: {
				taskId: z.string().uuid().describe('Id de la tarea (ver list_tasks)'),
				content: z.string().min(1).max(2000).optional().describe('Nuevo texto/título de la tarea'),
				notes: z
					.string()
					.max(10000)
					.optional()
					.describe('Nuevas notas/descripción (reemplaza las anteriores por completo)'),
				tags: z
					.array(tagSchema)
					.optional()
					.describe('Reemplazo completo de tags propios; [] los quita'),
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
				input.tags === undefined &&
				input.priority === undefined &&
				input.time === undefined
			) {
				return errorResult(
					new Error('Indica al menos un campo a cambiar (content, notes, tags, priority o time).')
				);
			}
			try {
				// `allowSubtask: true` (2026-09-04): `content`/`notes`/`priority`/
				// `tags`/`time` son cinco de los accidentales PERMITIDOS en una subtarea
				// por `docs/18-que-es-una-tarea.md` §2.5 — ver el JSDoc de
				// `assertTaskUsable` para el camino de servidor que lo respalda.
				await requireTaskExists(ctx, input.taskId, { allowSubtask: true });
				await mutateTaskInvalidating(ctx, {
					taskId: input.taskId,
					kind: 'update',
					payload: {
						...(input.content !== undefined ? { content: input.content } : {}),
						...(input.notes !== undefined ? { notes: input.notes } : {}),
						...(input.tags !== undefined ? { tags: input.tags } : {}),
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

	const rescheduleTaskTool = server.registerTool(
		'reschedule_task',
		{
			description:
				`Mueve una tarea existente a otro día, o a "Algún día"/Bandeja de entrada con date:null. ` +
				`Acepta también el id de una SUBTAREA (una subtarea con date:null se queda sin fecha en ` +
				`la checklist de su padre; no cae a la Bandeja). ${ASYNC_NOTE}`,
			inputSchema: {
				taskId: z.string().uuid().describe('Id de la tarea (ver list_tasks)'),
				date: z
					.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.null()])
					.describe('Día destino, YYYY-MM-DD, o null para mandarla a "Algún día"/Bandeja de entrada')
			}
		},
		async (input) => {
			try {
				// `allowSubtask: true` SIN condición sobre el payload (2026-09-04):
				// `date` es un accidental permitido en subtarea (docs/18 §2.5) y
				// desagendar una ya no la saca de la checklist de su padre — el
				// guard de `parentId` de `task-ops.unscheduleTask` entró en la app
				// en `a745235a`. Mismo valor que la tabla de `mutate_tasks`
				// (`TASK_TARGET_ALLOW_SUBTASK`, entrada `reschedule`).
				await requireTaskExists(ctx, input.taskId, { allowSubtask: true });
				await mutateTaskInvalidating(ctx, {
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

	const deleteTaskTool = server.registerTool(
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
				await requireTaskExists(ctx, input.taskId, { allowSubtask: true });
				await mutateTaskInvalidating(ctx, { taskId: input.taskId, kind: 'delete', payload: {} });
				return textResult(
					`Encolado en Lumbre el borrado de la tarea ${input.taskId} (se aplicará al sincronizar).`
				);
			} catch (err) {
				return errorResult(err);
			}
		}
	);

	const setSectionTool = server.registerTool(
		'set_section',
		{
			description:
				'Mueve una tarea existente a una sección dentro de SU proyecto o área (se crea si no existe), o ' +
				'la saca con section:null. Se ignora si la tarea no tiene residencia propia. NO aplica a ' +
				'subtareas. ' + ASYNC_NOTE,

			inputSchema: {
				taskId: z.string().uuid().describe('Id de la tarea (ver list_tasks)'),
				section: z
					.string()
					.max(200)
					.nullable()
					.describe(
						'Nombre de la sección destino dentro del proyecto o área de la tarea (se crea si no existe). ' +
							'null = quitarla de su sección actual.'
					)
			}
		},
		async (input) => {
			try {
				await requireTaskExists(ctx, input.taskId, { allowSubtask: false });
				await mutateTaskInvalidating(ctx, {
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

	const removeSectionTool = server.registerTool(
		'remove_section',
		{
			description:
				'Borra una sección dentro de un proyecto o área; sus tareas no se borran, solo quedan sueltas ' +
				'en el MISMO contenedor. Resuelve `sectionId` desde una tarea que viva ahí ' +
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
				await mutateTaskInvalidating(ctx, {
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

	// ── Gestión de proyectos y áreas (paridad UI↔MCP, docs/20-contrato-lista.md) ──
	//
	// `create_list`/`nest_list`/`rename_list`/`remove_list`/`move_to_list` NO
	// tienen tool suelta desde el 2026-08-27 (podadas: 3.506 bytes de
	// `tools/list`, 5 tools por 19 llamadas/mes de uso real medido sobre un
	// mes de transcripts): son las ops del mismo nombre en `mutate_tasks`
	// (`mutateTasksOpSchema`/`mutateTasksStrictOpSchema`/`translateOp`), que ya
	// las implementaba entero — `create_list.listId` es incluso un
	// SUPERCONJUNTO (encadenar dentro del mismo lote, cosa que la tool suelta
	// no tenía). Identidad = el id, no el nombre (`rename_list` no la
	// cambia). `remove_list` nunca pierde tareas (se reasignan) ni permite
	// borrar la última lista viva ni la Bandeja de entrada canónica (§5
	// "Prohibidos" del contrato). Detalle completo del contrato de lista en
	// `docs/20-contrato-lista.md`.

	const addSubtaskTool = server.registerTool(
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
				await requireTaskExists(ctx, input.taskId, { allowSubtask: true });
				await mutateTaskInvalidating(ctx, {
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

	const completeSubtaskTool = server.registerTool(
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
				await requireTaskExists(ctx, input.subtaskId, { allowSubtask: true });
				await mutateTaskInvalidating(ctx, {
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

	// Familia «BRL» (extraída a `src/tools/brl.ts`, add-on experimental de
	// registro del día).
	const { listBrlEntriesTool, mutateBrlTool } = registerBrlTools(server, ctx);

	// ── Feature batch (`plan-batch.md`): N operaciones en UNA sola tool call ───

	const mutateTasksTool = server.registerTool(
		'mutate_tasks',
		{
			description:
				`Vía PREFERENTE para VARIAS operaciones de golpe (crear y/o mutar): resuelve existencias y ` +
				`encola en UNA sola llamada, en vez de una tool call por operación. Cada elemento de \`ops\` ` +
				`equivale a su tool individual (mapeo op↔tool en el README) — salvo las ops de proyecto/área, sin ` +
				`tool suelta desde el 2026-08-27: mutate_tasks es su ÚNICA vía. Contrato por-op en la ` +
				`description de \`ops\`. Éxito PARCIAL: una op inválida no bloquea las ` +
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
							'priority, date, deadline, time, recurrence, subtasks, notes, tags] · complete: taskId* ' +
							'[done] · cancel: taskId* [cancelled] · update: taskId*, ≥1 de [content, notes, tags, ' +
							'priority, time] · reschedule: taskId*, date* · delete: taskId* · set_section: ' +
							'taskId*, section* · move_to_list: taskId*, uno de [listId, list] · add_subtask: ' +
							'taskId*, subtasks* · complete_subtask: subtaskId* [done] · remove_section: sectionId* ' +
							'· create_list: name* [color, icon, listId] · nest_list: listId*, parentId* · ' +
							'rename_list: listId*, name* · remove_list: listId* · set_list_notes: listId*, notes* [revive]'
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
				// `listId` → primer `create_list` del lote que prometió esa lista y NO
				// llegó a mandarse (forma inválida o validación local) — agujero 🔴
				// cerrado en la revisión de este mismo fix: `planBatchPhases` solo ve
				// `batchOps` (lo que SOBREVIVIÓ), así que un `create_list` roto por
				// forma (p. ej. sin `name`) se colaba como "sin dependencia" y el
				// `add_task` con ese `listId` viajaba SOLO, huérfano — ver
				// `excludeIngestForBrokenListPromises`. Se queda con el índice ORIGINAL
				// más bajo si varios `create_list` prometen el mismo `listId`.
				const brokenListIds = new Map<string, BrokenListPromise>();
				function recordBrokenListId(listId: unknown, index: number, error: string): void {
					if (typeof listId !== 'string') return;
					const existing = brokenListIds.get(listId);
					if (existing === undefined || index < existing.index) {
						brokenListIds.set(listId, { index, error });
					}
				}
				rawOps.forEach((raw, index) => {
					const result = mutateTasksStrictOpSchema.safeParse(raw);
					if (!result.success) {
						const error = formatOpShapeError(String(raw.op), result.error);
						shapeFailures.push({ index, error });
						if (raw.op === 'create_list') recordBrokenListId(raw.listId, index, error);
						return;
					}
					validated.push(result.data as MutateTasksOp);
					validatedOriginalIndexes.push(index);
				});

				const idsToCheck = collectExistenceCheckIds(validated);
				const existing: Map<string, LumbreTask> =
					idsToCheck.length > 0 ? await findTasksByIds(config, idsToCheck) : new Map();
				taskCache.setAll(existing.values());
				const built = buildBatchFromOps(validated, existing);
				// `create_list` no tiene validación local NI de existencia hoy (no
				// targetea una tarea), así que en la práctica nunca cae aquí — pero si
				// algún día la tuviera, un descarte de `create_list` en `built.skipped`
				// rompe su promesa de `listId` exactamente igual que uno por forma.
				for (const s of built.skipped) {
					const op = validated[s.index];
					if (op.op === 'create_list' && op.listId !== undefined) {
						recordBrokenListId(op.listId, validatedOriginalIndexes[s.index], s.error);
					}
				}
				const batchOps = built.batchOps;
				const originalIndexes = built.originalIndexes.map((i) => validatedOriginalIndexes[i]);

				// Incidente 071553: `POST /api/batch` del repo principal materializa
				// TODAS las ingestas antes que TODAS las mutaciones, sin mirar el
				// orden de `ops` — un `create_list` + N `add_task` con ese `listId`
				// en la MISMA llamada crea las tareas con la lista aún inexistente
				// (sin lista, fecha de HOY). Antes de planificar fases se excluyen las
				// altas cuya lista prometida YA se sabe rota (`brokenListIds`, arriba) —
				// esas NUNCA viajan, en ninguna fase. `planBatchPhases` reparte lo que
				// queda: detecta la dependencia PENDIENTE (un `create_list` que sí llegó
				// a `batchOps`, resultado aún desconocido) y, SOLO si existe, parte la
				// llamada en dos (ver su JSDoc); sin dependencia, `plan.phases` es un
				// único elemento tal cual — mismo coste de red que antes de este fix.
				const preFiltered = excludeIngestForBrokenListPromises(
					batchOps,
					originalIndexes,
					brokenListIds
				);
				const plan = planBatchPhases(preFiltered.batchOps, preFiltered.originalIndexes);
				let results: BatchResultItem[];
				let resultOriginalIndexes: number[];
				const phaseFailures: { index: number; error: string }[] = [];
				if (!plan.split) {
					const phase = plan.phases[0];
					results = phase.ops.length > 0 ? await runBatch(config, phase.ops) : [];
					resultOriginalIndexes = phase.originalIndexes;
				} else {
					const [mutatePhase] = plan.phases;
					const phase1Results =
						mutatePhase.ops.length > 0 ? await runBatch(config, mutatePhase.ops) : [];
					// Con el resultado REAL de la fase 1 ya se sabe qué `create_list`
					// salió `ok`: las altas que dependían de uno que falló NO se mandan
					// (nunca huérfanas con fecha de hoy) y entran en el informe como un
					// fallo más, citando la op `create_list` causante.
					const phase2 = filterPhase2AfterPhase1(plan, phase1Results);
					phaseFailures.push(...phase2.skipped);
					const phase2Results =
						phase2.ops.length > 0 ? await runBatch(config, phase2.ops) : [];
					results = [...phase1Results, ...phase2Results];
					resultOriginalIndexes = [...mutatePhase.originalIndexes, ...phase2.originalIndexes];
				}
				// Cualquier op 'mutate' del lote pudo tocar una tarea que ya estuviera
				// en `taskCache` (poblada arriba) — se invalida sin mirar el resultado
				// individual: barato, y evita servir un "existe" rancio si otra op del
				// MISMO lote la borró justo antes. No-op para las ops de lista/sección
				// (su `taskId` nunca estuvo cacheado aquí). Cubre las DOS fases: itera
				// sobre `batchOps` (el conjunto completo, previo al reparto), no sobre
				// las fases sueltas.
				for (const op of batchOps) {
					if (op.type === 'mutate') taskCache.invalidate(op.taskId);
				}

				// Cinco fuentes de fallo ahora (forma inválida, descartadas ANTES de
				// mandar el batch por `buildBatchFromOps`, altas huérfanas descartadas
				// ANTES de planificar fases por `excludeIngestForBrokenListPromises`
				// — su `create_list` nunca llegó a mandarse —, altas huérfanas
				// descartadas entre fase 1 y fase 2 por `filterPhase2AfterPhase1` — su
				// `create_list` SÍ se mandó pero falló —, y las que el servidor rechazó
				// al validar/encolar) se combinan en un único informe, ordenado por
				// posición ORIGINAL en `ops` — el modelo ve exactamente qué operación
				// falló y por qué, sin tener que distinguir entre las fases. Las
				// EXITOSAS con `id` (code-review 🟠 #3a: antes se perdían — el modelo
				// no podía enterarse del `listId` de un `create_list` sin una
				// `list_tasks` de más) también se recogen, para poder encadenarlas en
				// un turno posterior (o confirmar el id que ya se auto-generó, si la
				// op no traía uno propio — ver `create_list`).
				const failures: { index: number; error: string }[] = [
					...shapeFailures,
					...built.skipped.map((s) => ({ index: validatedOriginalIndexes[s.index], error: s.error })),
					...preFiltered.skipped,
					...phaseFailures
				];
				const succeededWithId: { index: number; id: string }[] = [];
				results.forEach((r, i) => {
					const index = resultOriginalIndexes[i];
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

	// Modo acotado (`toolset === 'attachments'`, ver `CreateServerOptions`):
	// retira las 21 tools que NO son `add_attachment`/`read_attachment`/
	// `delete_attachment` — TODAS se registraron arriba igual (para no bifurcar
	// cada una de las 21 llamadas a `registerTool` con un `if`), así que aquí
	// solo se deshace lo
	// que sobra, ANTES de que `server` se conecte a ningún transporte: ningún
	// cliente llega a ver el `tools/list` de 24 en el intermedio.
	if (toolset === 'attachments') {
		for (const tool of [
			addTaskTool,
			refreshSyncTool,
			listTasksTool,
			listListsTool,
			getListLinksTool,
			getListTool,
			linkListNoteTool,
			unlinkListNoteTool,
			getTaskTool,
			completeTaskTool,
			cancelTaskTool,
			updateTaskTool,
			rescheduleTaskTool,
			deleteTaskTool,
			setSectionTool,
			removeSectionTool,
			addSubtaskTool,
			completeSubtaskTool,
			listBrlEntriesTool,
			mutateBrlTool,
			mutateTasksTool
		]) {
			tool.remove();
		}
	}

	return server;
}

// Extraído a `schema-strip.ts` (tarea M2, transporte HTTP remoto) para que
// `http.ts` pueda reutilizar la MISMA limpieza de `$schema` sin importar
// este módulo entero (exige `LUMBRE_TOKEN` y conecta stdio al importarse).
// Reexportado aquí para no romper a `index.test.ts`, que ya las importaba
// de `index.js`.
export { stripSchemaRecursively, stripToolsListSchema } from './schema-strip.js';

/**
 * Modo acotado del arranque stdio (ver `CreateServerOptions.toolset`):
 * `LUMBRE_MCP_TOOLSET=attachments` registra solo `add_attachment`/
 * `read_attachment`/`delete_attachment`, pensado para un SEGUNDO conector
 * stdio local dedicado (David enchufa a la vez el remoto de las 24 tools y
 * este, sin duplicar superficie — ver README). Cualquier otro valor (incluido
 * no ponerla) cae
 * al default `'all'` de `createServer` — nunca falla por un valor raro, un
 * typo en la env simplemente no acota nada.
 */
function toolsetFromEnv(): CreateServerOptions['toolset'] {
	return process.env.LUMBRE_MCP_TOOLSET?.trim() === 'attachments' ? 'attachments' : 'all';
}

/**
 * Arranque real por stdio (el único transporte que corre en la máquina del
 * usuario): resuelve `config` desde el entorno (`loadConfig`, que SÍ puede
 * `process.exit(1)` si falta `LUMBRE_TOKEN` — ver su JSDoc), crea el servidor
 * con `createServer` y lo conecta a `StdioServerTransport`. Pasa
 * `localFilesystem: true` EXPLÍCITO (aunque hoy coincide con el default, ver
 * `CreateServerOptions`): este proceso corre en la máquina del usuario, así
 * que `add_attachment({ file_path })` sí puede leer su disco — a diferencia
 * de `http.ts`, que pasa `false`. `toolset` sale de `LUMBRE_MCP_TOOLSET`
 * (`toolsetFromEnv`).
 *
 * Separado de la carga del módulo (antes `loadConfig()`/`new McpServer()`
 * corrían como efecto secundario del propio `import`, lo que obligaba a
 * `index.test.ts` a fijar `LUMBRE_TOKEN` en el entorno y a cerrar una
 * conexión stdio real antes de poder testear nada) — importar este fichero ya
 * no hace NADA por sí solo; solo `main()` (o el guard de más abajo) arranca
 * de verdad.
 */
export async function main(): Promise<void> {
	const config = loadConfig();
	const server = createServer(config, { localFilesystem: true, toolset: toolsetFromEnv() });
	const transport = stripToolsListSchema(new StdioServerTransport());
	await server.connect(transport);
}

// Solo arranca stdio si este fichero se ejecuta DIRECTAMENTE (`node
// dist/index.js`), no cuando otro módulo lo importa (tests, un futuro
// entrypoint HTTP): `process.argv[1]` es el script que Node lanzó, y se
// compara por URL de fichero (no por string a pelo) para que funcione igual
// en Windows, donde las rutas no son comparables tal cual.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main();
}
