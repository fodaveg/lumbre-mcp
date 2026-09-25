import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
	buildBatchFromOps,
	collectExistenceCheckIds,
	collectSeriesSeedIds,
	excludeIngestForBrokenListPromises,
	filterPhase2AfterPhase1,
	findTasksByIds,
	planBatchPhases,
	runBatch,
	type BatchResponse,
	type BatchResultItem,
	type BrokenListPromise,
	type LumbreTask,
	type MutateTasksOp
} from '../lumbre-client.js';
import {
	errorResult,
	exposedRecurrenceSchema,
	formatOpShapeError,
	formatOutcomeReport,
	NOTES_OVERWRITE_CAVEAT,
	OUTCOME_NOTE,
	recurrencePatchSchema,
	recurrenceSchema,
	subtasksSchema,
	tagSchema,
	textResult,
	type OpOutcomeEntry,
	type ToolCtx
} from './shared.js';

/**
 * `true` si el elemento CRUDO es un `update` que escribe texto de notas no
 * vacío (MC8 del audit de paridad, 24 sep 2026: ver `NOTES_OVERWRITE_CAVEAT`
 * en `shared.ts`). `notes: ''`/`undefined` no cuenta: un borrado explícito de
 * nota no puede taparse a sí mismo, así que el aviso no aporta nada ahí. Se
 * lee del elemento CRUDO (no del validado ni traducido): es el mismo patrón
 * que `opNameAt`, más abajo en `runOpsBatch`.
 */
function opWritesVisibleNotes(raw: Record<string, unknown>): boolean {
	return raw.op === 'update' && typeof raw.notes === 'string' && raw.notes.length > 0;
}

/**
 * DOS tools de lote sobre las MISMAS ops de siempre (16 hasta el 23 sep 2026,
 * 21 desde MC6, ver abajo), repartidas por lo que hacen (2026-09-19, tarea
 * 6f62c877 — decisión de David del 17 sep):
 *
 * - `mutate_tasks`: solo opera sobre UNA tarea — `add_task`, `complete`,
 *   `cancel`, `update`, `reschedule`, `set_section`, `add_subtask`,
 *   `complete_subtask`, `restore` (2026-09-24, sacar de la Papelera: no
 *   destruye nada, así que no va a `organize`) y, desde MC6 (2026-09-24,
 *   paridad UI↔MCP), `set_waiting`/`clear_waiting` (estado «esperando») y
 *   `register_habit` (ocurrencia de un hábito — su objetivo no es una tarea).
 * - `organize`: lo DESTRUCTIVO y la reorganización — `delete`,
 *   `remove_section`, `create_list`, `nest_list`, `rename_list`,
 *   `remove_list`, `set_list_notes`, `move_to_list` (esta va aquí, y no con
 *   las de tarea, porque se encadena con `create_list` por el `listId`
 *   generado en el MISMO lote) y, desde MC6, `set_list_kind` (tipo visible
 *   de un proyecto o área existente; `create_list.listKind` es su
 *   equivalente al crear).
 *
 * El reparto compra dos cosas a la vez. (1) Tamaño: las 9 tools sueltas de
 * mutación individual (`complete_task`…`complete_subtask`) desaparecen —
 * `mutate_tasks`/`organize` ya las cubrían entero — y cada schema EXPUESTO
 * pasa a declarar SOLO los campos que usan SUS ops, no los de las demás.
 * (2) Una frontera MECÁNICA para los subagentes portables
 * (`skills/lumbre/assets/subagents/contracts.json`): a `lumbre-tagger` y
 * `lumbre-daily-operator` se les da `mutate_tasks` y NO `organize`, así que
 * no pueden borrar ni reorganizar porque esas ops no existen en su tool — ya
 * no es una regla en prosa que el modelo deba respetar.
 *
 * Cada tool tiene DOS schemas de las mismas formas por-op, no uno (medido en
 * su día: aplanar `ops.items` bajó el JSON Schema EXPUESTO de `mutate_tasks`
 * de 7.638 a ~3,1k caracteres — ver la tarea que lo motivó, 2026-07-25):
 *
 * - El schema EXPUESTO (`mutateTasksOpSchema`/`organizeOpSchema`): UN objeto
 *   plano con los campos que usan las ops de ESA tool, TODOS opcionales, cada
 *   uno con su `.describe()` UNA sola vez. Antes esto era un
 *   `z.discriminatedUnion` de 15 ramas casi idénticas → `anyOf` con los
 *   mismos campos y las mismas descripciones repetidas 15 veces en el JSON
 *   Schema que ve el modelo. El contrato real por-op (qué campo es
 *   obligatorio/ajeno a cada `op`) NO vive en el tipo expuesto: vive en la
 *   `description` de `ops` (tabla compacta, `*` = obligatorio) y en el README
 *   ("Ejecutar varias operaciones a la vez").
 * - El schema ESTRICTO (`mutateTasksStrictOpSchema`/`organizeStrictOpSchema`,
 *   INTERNOS — no forman parte de ningún `inputSchema`, nunca se serializan):
 *   las MISMAS formas por-op de siempre, con los MISMOS tipos y la MISMA
 *   obligatoriedad, cada una `.strict()` (rechaza cualquier campo ajeno a esa
 *   op). El handler re-valida con ellos cada elemento de `ops` ANTES de tocar
 *   red — así `{op:'complete', date:'2026-01-01'}` (campo `date` ajeno a
 *   `complete`) SIGUE fallando igual que siempre, solo que dentro del informe
 *   de "éxito parcial" que ya existía para un `taskId` inexistente: se
 *   reporta esa op concreta y las demás, si son válidas, se encolan igual.
 *
 * Por qué el `op` EXPUESTO es un `z.string()` y no un `z.enum` de las ops
 * de su tool: un valor fuera del enum lo rechaza el FRAMEWORK
 * (`validateToolInput`, antes de que el handler exista), y eso tumba la
 * llamada entera con un volcado de Zod. Con `z.string()`, una op de la otra
 * tool (`{op:'delete'}` en `mutate_tasks`) llega al handler, la rechaza el
 * schema estricto por discriminador inválido y `formatOpShapeError` la
 * contesta con el puntero del mapa `TASK_OP_TOOL` («la op "delete" no existe
 * en mutate_tasks; está en organize»), como un fallo MÁS del informe parcial.
 * El listado de ops válidas sigue a la vista del modelo en la `description`
 * de la tool y en la tabla de `ops`, que es donde ya vivía el contrato.
 *
 * `create_list.listId` (encadenar dentro del MISMO lote de `organize`, sin
 * depender de la respuesta): dale tú mismo un uuid v4 al crearla y úsalo en
 * el `move_to_list`/`nest_list` que la targetee en OTRA op del mismo lote —
 * detalle completo en el README. Un lote MIXTO (`create_list` en `organize` +
 * `add_task` en `mutate_tasks`) ya no cabe en una sola llamada: son dos, o un
 * `add_task` con `list` por NOMBRE, que crea la lista si no existe.
 */
export const mutateTasksStrictOpSchema = z.discriminatedUnion('op', [
	z
		.object({
			op: z.literal('add_task'),
			text: z.string().min(1).max(2000),
			list: z.string().max(200).optional(),
			listId: z.string().guid().optional(),
			section: z.string().max(200).optional(),
			priority: z.enum(['p1', 'p2', 'p3', 'p4']).optional(),
			date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
			deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
			tags: z.array(tagSchema).optional(),
			time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
			recurrence: recurrenceSchema.optional(),
			subtasks: subtasksSchema.optional(),
			notes: z.string().max(10000).optional()
		})
		.strict(),
	z
		.object({
			op: z.literal('complete'),
			taskId: z.string().guid(),
			done: z.boolean().optional()
		})
		.strict(),
	z
		.object({
			op: z.literal('cancel'),
			taskId: z.string().guid(),
			cancelled: z.boolean().optional()
		})
		.strict(),
	// `restore` (2026-09-24): saca de la Papelera. Solo `taskId`; la tarea está
	// BORRADA, así que el motor no le pide existencia previa (ver
	// `TASK_TARGET_ALLOW_SUBTASK` en `lumbre-client.ts`) y decide el servidor.
	z
		.object({
			op: z.literal('restore'),
			taskId: z.string().guid()
		})
		.strict(),
	z
		.object({
			op: z.literal('update'),
			taskId: z.string().guid(),
			content: z.string().min(1).max(2000).optional(),
			notes: z.string().max(10000).optional(),
			tags: z.array(tagSchema).optional(),
			priority: z.enum(['p1', 'p2', 'p3', 'p4']).optional(),
			time: z.union([z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), z.null()]).optional(),
			recurrence: z.union([recurrencePatchSchema, z.null()]).optional(),
			// MC6 (2026-09-24): PROHIBIDOS en una subtarea (§2.5) — rechazado en
			// `buildBatchFromOps`, no aquí (necesita saber si el `taskId` es
			// subtarea, que solo se resuelve tras la comprobación de existencia).
			deadline: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.null()]).optional(),
			reminders: z.array(z.number().int().nonnegative()).optional()
		})
		.strict(),
	z
		.object({
			op: z.literal('reschedule'),
			taskId: z.string().guid(),
			date: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.null()])
		})
		.strict(),
	z
		.object({
			op: z.literal('set_section'),
			taskId: z.string().guid(),
			section: z.string().max(200).nullable()
		})
		.strict(),
	// `set_waiting`/`clear_waiting` (MC6, paridad UI↔MCP — estado «esperando»).
	z
		.object({
			op: z.literal('set_waiting'),
			taskId: z.string().guid(),
			until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
			for: z.union([z.string().max(2000), z.null()]).optional()
		})
		.strict(),
	z
		.object({
			op: z.literal('clear_waiting'),
			taskId: z.string().guid()
		})
		.strict(),
	z
		.object({
			op: z.literal('add_subtask'),
			taskId: z.string().guid(),
			subtasks: subtasksSchema.min(1)
		})
		.strict(),
	z
		.object({
			op: z.literal('complete_subtask'),
			subtaskId: z.string().guid(),
			done: z.boolean().optional()
		})
		.strict(),
	// `register_habit` (MC6): registra una ocurrencia del hábito `habitId` (NO
	// una tarea — no pasa el chequeo de existencia de tarea, ver
	// `TASK_TARGET_ALLOW_SUBTASK` en `lumbre-client.ts`). `date` opcional: hasta
	// que la app resuelva el HOY local del usuario cuando falte, omitirla falla
	// server-side (ver el JSDoc de `RegisterHabitMutationPayload`).
	z
		.object({
			op: z.literal('register_habit'),
			habitId: z.string().guid(),
			date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
		})
		.strict(),
	// MC7 (2026-09-24, tarea 8eee8c72): visibilidad de tarea, salto de
	// ocurrencia y ciclo de vida de hábito — ver el JSDoc de `MutateTasksOp`
	// en `lumbre-client.ts` para el contrato completo de cada una.
	z
		.object({
			op: z.literal('archive'),
			taskId: z.string().guid()
		})
		.strict(),
	z
		.object({
			op: z.literal('unarchive'),
			taskId: z.string().guid()
		})
		.strict(),
	z
		.object({
			op: z.literal('skip_occurrence'),
			seriesId: z.string().guid(),
			date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
			occurrenceId: z.string().guid().optional()
		})
		.strict(),
	z
		.object({
			op: z.literal('archive_habit'),
			habitId: z.string().guid()
		})
		.strict(),
	z
		.object({
			op: z.literal('unarchive_habit'),
			habitId: z.string().guid()
		})
		.strict()
]);

/** Formas ESTRICTAS de las 9 ops de `organize` (ver el JSDoc de arriba): las
 *  8 que tenían en `mutate_tasks` antes del reparto, byte a byte, más
 *  `set_list_kind` (MC6). */
export const organizeStrictOpSchema = z.discriminatedUnion('op', [
	z
		.object({
			op: z.literal('delete'),
			taskId: z.string().guid()
		})
		.strict(),
	z
		.object({
			op: z.literal('remove_section'),
			sectionId: z.string().guid()
		})
		.strict(),
	z
		.object({
			op: z.literal('create_list'),
			name: z.string().min(1).max(200),
			color: z.string().max(20).optional(),
			icon: z.string().max(16).optional(),
			listId: z.string().guid().optional(),
			listKind: z.enum(['area', 'project']).optional()
		})
		.strict(),
	z
		.object({
			op: z.literal('nest_list'),
			listId: z.string().guid(),
			parentId: z.union([z.string().guid(), z.null()])
		})
		.strict(),
	z
		.object({
			op: z.literal('rename_list'),
			listId: z.string().guid(),
			name: z.string().min(1).max(200)
		})
		.strict(),
	z
		.object({
			op: z.literal('remove_list'),
			listId: z.string().guid()
		})
		.strict(),
	z
		.object({
			op: z.literal('set_list_notes'),
			listId: z.string().guid(),
			notes: z.string().max(10000).nullable(),
			revive: z.boolean().optional()
		})
		.strict(),
	z
		.object({
			op: z.literal('move_to_list'),
			taskId: z.string().guid(),
			listId: z.union([z.string().guid(), z.null()]).optional(),
			list: z.string().max(200).optional()
		})
		.strict(),
	// `set_list_kind` (MC6): cambia el tipo visible de un proyecto o área
	// EXISTENTE; `create_list.listKind`, arriba, es su equivalente al crear.
	z
		.object({
			op: z.literal('set_list_kind'),
			listId: z.string().guid(),
			listKind: z.enum(['area', 'project'])
		})
		.strict(),
	// `delete_habit` (MC7, 2026-09-24): borra un HÁBITO — destructiva, sin
	// `restore`, así que vive en `organize` con el resto de lo destructivo, no
	// junto a `archive_habit`/`unarchive_habit` en `mutate_tasks`.
	z
		.object({
			op: z.literal('delete_habit'),
			habitId: z.string().guid()
		})
		.strict()
]);

/**
 * Schema EXPUESTO de un elemento de `ops` de `mutate_tasks` (ver el JSDoc de
 * arriba para el porqué de tenerlo separado del estricto): plano, con los
 * campos que usan SUS ops —ya no los de `organize`— y todos opcionales salvo
 * `op`. Poda de superficie heredada (2026-08-25): cada campo lleva
 * `.describe()` SOLO si aporta algo que el nombre del campo + su tipo/patrón
 * no digan ya (semántica de `null`, default al omitir, o el comportamiento no
 * obvio de un campo como `list`/`notes`).
 *
 * `.passthrough()` y no `.strict()` (2026-09-19): un campo desconocido ya no
 * tumba la llamada entera en el framework, sino que llega al schema estricto
 * del handler, que lo reporta como fallo de ESA op —igual que un campo válido
 * pero ajeno a su `op`— y deja pasar el resto del lote. Mismo criterio que ya
 * seguía el resto de fallos de forma.
 */
export const mutateTasksOpSchema = z
	.object({
		op: z.string().describe('Operación — las 17 de esta tool, con su contrato, en la description de `ops`'),
		taskId: z.string().guid().optional().describe('Id de la tarea — ver list_tasks/get_task'),
		subtaskId: z.string().guid().optional().describe('Id de la subtarea — ver get_task de su tarea padre'),
		listId: z.string().guid().optional().describe('Id del proyecto o área destino de un add_task'),
		habitId: z
			.string()
			.guid()
			.optional()
			.describe('Id del hábito (register_habit/archive_habit/unarchive_habit) — ver list_habits'),
		seriesId: z
			.string()
			.guid()
			.optional()
			.describe(
				'skip_occurrence: id de la SEMILLA de la serie (no de una ocurrencia) — list_tasks/get_task la ' +
					'muestran como "semilla" en su propia línea y como "serie:<id>" en cada ocurrencia'
			),
		occurrenceId: z
			.string()
			.guid()
			.optional()
			.describe(
				'skip_occurrence: id de la fila de la ocurrencia en list_tasks. Pásalo si está materializada ' +
					'(imprescindible si se movió de día); sin él solo salta bien una ocurrencia sin mover'
			),
		// `text`/`content`/`deadline`: sin describe propio — el nombre del campo
		// ya lo dice todo (texto de la tarea nueva o su nuevo texto, fecha
		// límite) y no hay semántica extra (null, default, autocreación…) que
		// documentar; qué op usa cuál ya está en la description de `ops`.
		text: z.string().min(1).max(2000).optional(),
		content: z.string().min(1).max(2000).optional(),
		tags: z
			.array(tagSchema)
			.optional()
			.describe('add_task/update: acked/wip/done/not-done se rechazan (ese estado va como @marca en content)'),
		list: z.string().max(200).optional().describe('Nombre del proyecto o área destino (se crea como proyecto si no existe)'),
		section: z.string().max(200).nullable().optional().describe('Nombre de la sección, o null para quitarla'),
		notes: z.string().max(10000).optional().describe('Notas (reemplazan las anteriores enteras)'),
		priority: z.enum(['p1', 'p2', 'p3', 'p4']).optional().describe('p1 = más urgente … p4 = ninguna'),
		date: z
			.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.null()])
			.optional()
			.describe(
				'YYYY-MM-DD, o null para "Algún día"/Bandeja de entrada. En register_habit, el día a registrar ' +
					'(opcional: sin servidor con el HOY local desplegado, omitirla falla). En skip_occurrence, ' +
					'el día de la ocurrencia a saltar (obligatorio, junto con seriesId)'
			),
		deadline: z
			.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.null()])
			.optional()
			.describe('update: null la quita. PROHIBIDO sobre una subtarea'),
		time: z
			.union([z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), z.null()])
			.optional()
			.describe('24h; null la quita'),
		// `recurrence`: un solo campo para las dos ops que lo usan (`add_task`
		// crea con la regla entera, `update` manda un cambio parcial); la
		// forma exacta de cada una la impone su schema estricto (ver `shared.ts`).
		recurrence: z.union([exposedRecurrenceSchema, z.null()]).optional(),
		reminders: z
			.array(z.number().int().nonnegative())
			.optional()
			.describe('update: offsets en minutos-antes de time; [] los quita. PROHIBIDO sobre una subtarea'),
		subtasks: subtasksSchema.optional().describe('Textos de las subtareas, en orden (máx. 50, 500 caracteres cada una)'),
		done: z.boolean().optional().describe('true = completar (default); false = desmarcar'),
		cancelled: z.boolean().optional().describe('true = cancelar (default); false = quitar la cancelación'),
		until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('set_waiting: fecha de reconsulta, estrictamente futura'),
		for: z
			.union([z.string().max(2000), z.null()])
			.optional()
			.describe('set_waiting: a quién o qué se espera (texto libre)')
	})
	.passthrough();

/**
 * Schema EXPUESTO de un elemento de `ops` de `organize` — mismo criterio que
 * el de `mutate_tasks` de arriba (plano, todo opcional salvo `op`,
 * `.passthrough()`, contrato por-op en la description de `ops`), con los
 * campos que usan SUS ops.
 */
export const organizeOpSchema = z
	.object({
		op: z.string().describe('Operación — las 10 de esta tool, con su contrato, en la description de `ops`'),
		taskId: z.string().guid().optional().describe('Id de la tarea a borrar o mover — ver list_tasks/get_task'),
		habitId: z.string().guid().optional().describe('Id del hábito (delete_habit) — ver list_habits'),
		sectionId: z.string().guid().optional().describe('Id de la sección — ver el campo sectionId de una tarea que viva en ella'),
		listId: z
			.union([z.string().guid(), z.null()])
			.optional()
			.describe('Id del proyecto o área: destino, objetivo, o uno que generes tú para encadenar con create_list'),
		parentId: z.union([z.string().guid(), z.null()]).optional().describe('Id del proyecto o área padre, o null para desanidar'),
		// `name`/`icon`: sin describe propio — su semántica (nombre del proyecto
		// o área, emoji del proyecto) ya la dice el nombre del campo.
		name: z.string().min(1).max(200).optional(),
		list: z.string().max(200).optional().describe('Nombre del proyecto o área destino (se crea como proyecto si no existe)'),
		notes: z
			.union([z.string().max(10000), z.null()])
			.optional()
			.describe('Nota del proyecto o área (reemplaza la anterior entera; null la borra)'),
		color: z.string().max(20).optional().describe('red|amber|green|blue|violet|pink, o un hex libre "#rrggbb"'),
		icon: z.string().max(16).optional(),
		revive: z.boolean().optional().describe('true restaura una nota de proyecto o área borrada previamente'),
		listKind: z.enum(['area', 'project']).optional().describe('create_list/set_list_kind: tipo visible del contenedor')
	})
	.passthrough();

/**
 * Motor de lote COMPARTIDO por `mutate_tasks` y `organize` (antes era el
 * cuerpo del handler de `mutate_tasks`, extraído tal cual al partir la tool
 * en dos: cero cambios de comportamiento). Valida por-op contra el schema
 * ESTRICTO de la tool que llama, resuelve existencias, planifica fases y
 * devuelve el informe de éxito PARCIAL.
 *
 * `toolName` solo viaja hasta `formatOpShapeError`, para que una op de la
 * OTRA tool reciba el puntero a la suya (ver `TASK_OP_TOOL` en `shared.ts`).
 */
async function runOpsBatch(
	ctx: ToolCtx,
	rawOps: Record<string, unknown>[],
	strictOpSchema: z.ZodTypeAny,
	toolName: 'mutate_tasks' | 'organize'
): Promise<string> {
	// Re-validación ESTRICTA por-op ANTES de tocar red: el schema EXPUESTO es
	// deliberadamente laxo, así que un elemento cuya forma no encaje con SU
	// `op` (campo obligatorio ausente, un campo válido en general pero ajeno a
	// esa op, o una op de la otra tool) todavía no se ha rechazado en este
	// punto — ver el JSDoc de la cabecera. Se reporta como un fallo MÁS del
	// informe de éxito parcial (mismo array que un `taskId` inexistente), no
	// tumba la llamada entera.
	const validated: MutateTasksOp[] = [];
	// Índice, dentro de `validated` (compactado, sin los descartados por
	// forma), de la posición ORIGINAL en `input.ops` — mismo patrón de
	// indirección que ya usa `buildBatchFromOps` para `batchOps` vs `ops`,
	// aplicado un nivel más arriba.
	const validatedOriginalIndexes: number[] = [];
	const shapeFailures: { index: number; error: string }[] = [];
	// `listId` → primer `create_list` del lote que prometió esa lista y NO
	// llegó a mandarse (forma inválida o validación local) — agujero 🔴
	// cerrado en la revisión de aquel fix: `planBatchPhases` solo ve
	// `batchOps` (lo que SOBREVIVIÓ), así que un `create_list` roto por forma
	// (p. ej. sin `name`) se colaba como "sin dependencia" y el `move_to_list`
	// con ese `listId` viajaba SOLO, huérfano — ver
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
		const result = strictOpSchema.safeParse(raw);
		if (!result.success) {
			const error = formatOpShapeError(String(raw.op), result.error, toolName);
			shapeFailures.push({ index, error });
			if (raw.op === 'create_list') recordBrokenListId(raw.listId, index, error);
			return;
		}
		validated.push(result.data as MutateTasksOp);
		validatedOriginalIndexes.push(index);
	});

	const idsToCheck = collectExistenceCheckIds(validated);
	const existing: Map<string, LumbreTask> =
		idsToCheck.length > 0 ? await findTasksByIds(ctx.config, idsToCheck) : new Map();
	// Cuatro ops aplican (o pueden aplicar) sobre una tarea ARCHIVADA, que
	// `findTasksByIds` normal (arriba) no ve: `update` con `recurrence: null`
	// (apagar una semilla que sigue generando, ver `clearArchivedSeedRecurrence`
	// en el repo principal — CX7), `unarchive` (MC7: su objetivo CASI SIEMPRE
	// está archivado, es su caso de uso principal), `delete` (MC7: acepta
	// ahora tareas archivadas) y `archive` (archivar una ya archivada es `noop`
	// SIN aviso en la app, `materializeLifecycleMutation` de
	// `lifecycle-inbound.ts`, `4eda45d`; sin reintento moría aquí como "no
	// existe"). Solo para esos ids, y solo si la búsqueda normal no los vio, se
	// repite incluyendo archivadas, en UNA sola petición agrupada — así una op
	// legítima sobre una archivada no muere con un falso "no existe".
	const archivedLookupIds = validated
		.filter(
			(op) =>
				(op.op === 'update' && op.recurrence === null && !existing.has(op.taskId)) ||
				((op.op === 'unarchive' || op.op === 'delete' || op.op === 'archive') &&
					!existing.has(op.taskId))
		)
		.map((op) => (op as { taskId: string }).taskId);
	if (archivedLookupIds.length > 0) {
		const archived = await findTasksByIds(ctx.config, [...new Set(archivedLookupIds)], {
			includeArchived: true
		});
		for (const [id, task] of archived) existing.set(id, task);
	}
	ctx.taskCache.setAll(existing.values());
	// CX6: un parche parcial de `recurrence` desde una ocurrencia se fusiona
	// contra la regla de su SEMILLA, que puede estar archivada. Solo se leen
	// para la fusión: no son objetivo de ninguna op, así que no entran en la
	// caché de existencia.
	const seedIds = collectSeriesSeedIds(validated, existing);
	const seeds: Map<string, LumbreTask> =
		seedIds.length > 0
			? await findTasksByIds(ctx.config, seedIds, { includeArchived: true })
			: new Map();
	const built = buildBatchFromOps(validated, seeds.size > 0 ? new Map([...seeds, ...existing]) : existing);
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

	// Incidente 071553: `POST /api/batch` del repo principal materializa TODAS
	// las ingestas antes que TODAS las mutaciones, sin mirar el orden de
	// `ops`. Desde que `create_list` y `add_task` viven en tools DISTINTAS ese
	// cruce ya no cabe en una sola llamada, pero el reparto en fases se
	// conserva tal cual: sigue siendo el que garantiza que una dependencia
	// PENDIENTE no viaje con su alta, y no cuesta nada cuando no la hay
	// (`plan.phases` es un único elemento, mismo coste de red que sin fases).
	const preFiltered = excludeIngestForBrokenListPromises(batchOps, originalIndexes, brokenListIds);
	const plan = planBatchPhases(preFiltered.batchOps, preFiltered.originalIndexes);
	let results: BatchResultItem[];
	let resultOriginalIndexes: number[];
	// Avisos de la app de todas las peticiones del lote (una o dos, según las
	// fases), sin repetir: cada drenaje ya los deduplica por dentro.
	const notices: string[] = [];
	const EMPTY: BatchResponse = { results: [], notices: [] };
	const phaseFailures: { index: number; error: string }[] = [];
	if (!plan.split) {
		const phase = plan.phases[0];
		const response = phase.ops.length > 0 ? await runBatch(ctx.config, phase.ops) : EMPTY;
		results = response.results;
		notices.push(...response.notices);
		resultOriginalIndexes = phase.originalIndexes;
	} else {
		const [mutatePhase] = plan.phases;
		const phase1 = mutatePhase.ops.length > 0 ? await runBatch(ctx.config, mutatePhase.ops) : EMPTY;
		// Con el resultado REAL de la fase 1 ya se sabe qué `create_list` salió
		// `ok`: las altas que dependían de uno que falló NO se mandan (nunca
		// huérfanas con fecha de hoy) y entran en el informe como un fallo más,
		// citando la op `create_list` causante.
		const phase2 = filterPhase2AfterPhase1(plan, phase1.results);
		phaseFailures.push(...phase2.skipped);
		const phase2Response = phase2.ops.length > 0 ? await runBatch(ctx.config, phase2.ops) : EMPTY;
		results = [...phase1.results, ...phase2Response.results];
		notices.push(...phase1.notices, ...phase2Response.notices.filter((n) => !phase1.notices.includes(n)));
		resultOriginalIndexes = [...mutatePhase.originalIndexes, ...phase2.originalIndexes];
	}
	// Cualquier op 'mutate' del lote pudo tocar una tarea que ya estuviera en
	// `taskCache` (poblada arriba) — se invalida sin mirar el resultado
	// individual: barato, y evita servir un "existe" rancio si otra op del
	// MISMO lote la borró justo antes. No-op para las ops de lista/sección (su
	// `taskId` nunca estuvo cacheado aquí). Cubre las DOS fases: itera sobre
	// `batchOps` (el conjunto completo, previo al reparto), no sobre las fases
	// sueltas.
	for (const op of batchOps) {
		if (op.type === 'mutate') ctx.taskCache.invalidate(op.taskId);
	}

	// Cinco fuentes de fallo (forma inválida —incluida una op de la otra
	// tool—, descartadas ANTES de mandar el batch por `buildBatchFromOps`,
	// altas huérfanas descartadas ANTES de planificar fases por
	// `excludeIngestForBrokenListPromises`, altas huérfanas descartadas entre
	// fase 1 y fase 2 por `filterPhase2AfterPhase1`, y las que el servidor
	// rechazó al validar/encolar) se combinan en un único informe, ordenado
	// por posición ORIGINAL en `ops` — el modelo ve exactamente qué operación
	// falló y por qué, sin tener que distinguir entre las fases. Las EXITOSAS
	// con `id` (code-review 🟠 #3a: antes se perdían — el modelo no podía
	// enterarse del `listId` de un `create_list` sin una `list_tasks` de más)
	// también se recogen, para poder encadenarlas en un turno posterior (o
	// confirmar el id que ya se auto-generó, si la op no traía uno propio).
	const failures: { index: number; error: string }[] = [
		...shapeFailures,
		...built.skipped.map((s) => ({ index: validatedOriginalIndexes[s.index], error: s.error })),
		...preFiltered.skipped,
		...phaseFailures
	];
	// `op` se lee del elemento CRUDO (`rawOps`), no de `validated` (que no
	// tiene entrada para los descartados por forma).
	const opNameAt = (index: number) => String(rawOps[index].op);
	const succeededWithId: { index: number; id: string }[] = [];
	// Resultado REAL de cada op aceptada (MC1 del audit de paridad): `ok` solo
	// dice «validada y encolada»; si se aplicó lo dice `materialization`. Un
	// servidor que no lo manda deja la op «sin confirmar», nunca «aplicada».
	const outcomes: OpOutcomeEntry[] = [];
	results.forEach((r, i) => {
		const index = resultOriginalIndexes[i];
		if (r.ok) {
			if (r.id !== undefined) succeededWithId.push({ index, id: r.id });
			const outcome = r.materialization ?? 'unconfirmed';
			outcomes.push({
				index,
				op: opNameAt(index),
				outcome,
				...(outcome === 'applied' && opWritesVisibleNotes(rawOps[index]) ? { caveat: NOTES_OVERWRITE_CAVEAT } : {})
			});
		} else {
			failures.push({ index, error: r.error ?? 'error desconocido' });
		}
	});
	const okCount = results.filter((r) => r.ok).length;
	failures.sort((a, b) => a.index - b.index);
	succeededWithId.sort((a, b) => a.index - b.index);

	const failureLines = failures.map((f) => `  [${f.index}] ${opNameAt(f.index)}: ${f.error}`);
	const idLines = succeededWithId.map((s) => `  [${s.index}] ${opNameAt(s.index)}: id ${s.id}`);
	let summary = `Lumbre: ${okCount}/${rawOps.length} operación(es) encoladas.`;
	const outcomeReport = formatOutcomeReport(outcomes, notices);
	if (outcomeReport !== '') summary += `\n${outcomeReport}`;
	if (idLines.length > 0) summary += `\nids asignados:\n${idLines.join('\n')}`;
	if (failureLines.length > 0) {
		summary += `\n${failureLines.length} fallaron:\n${failureLines.join('\n')}`;
	}
	return summary;
}

/**
 * Familia «lote de tareas» (`plan-batch.md`): `mutate_tasks` (operar sobre
 * una tarea) y `organize` (reorganizar y borrar) — N operaciones de golpe en
 * UNA sola tool call, con el mismo motor (`runOpsBatch`, arriba) y el mismo
 * informe de éxito parcial. Ver el JSDoc de la cabecera para el reparto de
 * las 27 ops (17+10, MC7) y por qué son dos tools y no una.
 */
export function registerBatchTool(server: McpServer, ctx: ToolCtx) {
	const mutateTasksTool = server.registerTool(
		'mutate_tasks',
		{
			description:
				`Opera sobre UNA TAREA, en lote: add_task, complete, cancel, update, reschedule, ` +
				`set_section, add_subtask, complete_subtask, restore (saca de la Papelera), set_waiting, ` +
				`clear_waiting, register_habit, archive_habit, unarchive_habit (hábito, no tarea), archive, ` +
				`unarchive (visibilidad, no ciclo de vida) y skip_occurrence (salta una ocurrencia de una ` +
				`serie). Vía ÚNICA para mutar una tarea (no hay tool ` +
				`suelta por operación) y preferente para varias de golpe: resuelve existencias y encola en ` +
				`UNA llamada. Borrar y reorganizar NO están aquí, están en organize. Éxito PARCIAL: una op ` +
				`inválida no bloquea las demás — el resultado detalla qué falló por posición y el taskId de ` +
				`cada add_task encolada. ${OUTCOME_NOTE}`,
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
							'priority, time, recurrence (parcial, conserva lo no enviado; null la apaga, también ' +
							'en una semilla archivada), deadline, reminders (deadline/reminders PROHIBIDOS sobre ' +
							'una subtarea)] · ' +
							'reschedule: taskId*, date* · set_section: taskId*, section* · ' +
							'set_waiting: taskId*, until* (estrictamente futura) [for] · clear_waiting: taskId* · ' +
							'add_subtask: taskId*, subtasks* · complete_subtask: subtaskId* [done] · ' +
							'restore: taskId* (tarea borrada; sin efecto si ya se purgó) · ' +
							'register_habit: habitId* [date] (habitId, no taskId; sin server con el HOY local ' +
							'desplegado, omitir date falla) · ' +
							'archive: taskId* (archiva la tarea; noop si ya lo estaba) · ' +
							'unarchive: taskId* (desarchiva; noop si ya estaba viva) · ' +
							'skip_occurrence: seriesId*, date* [occurrenceId] (seriesId = SEMILLA de la serie, no ' +
							'una ocurrencia; noop con aviso si no lo es) · archive_habit: habitId* · ' +
							'unarchive_habit: habitId*'
					)
			}
		},
		async (input) => {
			try {
				return textResult(
					await runOpsBatch(ctx, input.ops as Record<string, unknown>[], mutateTasksStrictOpSchema, 'mutate_tasks')
				);
			} catch (err) {
				return errorResult(err);
			}
		}
	);

	const organizeTool = server.registerTool(
		'organize',
		{
			description:
				`Reorganiza y borra: delete (tarea), remove_section, create_list, nest_list, rename_list, ` +
				`remove_list, set_list_notes, move_to_list, set_list_kind, delete_habit. Vía ÚNICA para ` +
				`proyectos, áreas y secciones, y la única que borra. ACCIONES DELICADAS: sin deshacer — confirma con el usuario antes de ` +
				`borrar. Mismo lote y mismo éxito PARCIAL que mutate_tasks, con el listId de cada ` +
				`create_list; para encadenar en el MISMO lote, dale tú ese listId (uuid v4). ${OUTCOME_NOTE}`,
			inputSchema: {
				ops: z
					.array(organizeOpSchema)
					.min(1)
					.max(200)
					.describe(
						'Operaciones a ejecutar, en el orden indicado (máx. 200 por llamada). Contrato por-op ' +
							'(`*` = obligatorio, el resto opcional): delete: taskId* · remove_section: sectionId* · ' +
							'create_list: name* [color, icon, listId, listKind] · nest_list: listId*, parentId* · ' +
							'rename_list: listId*, name* · remove_list: listId* · set_list_notes: listId*, notes* ' +
							'[revive] · move_to_list: taskId*, uno de [listId, list] · ' +
							'set_list_kind: listId*, listKind* ("area"|"project") · ' +
							'delete_habit: habitId* (borra el hábito, sin deshacer)'
					)
			}
		},
		async (input) => {
			try {
				return textResult(
					await runOpsBatch(ctx, input.ops as Record<string, unknown>[], organizeStrictOpSchema, 'organize')
				);
			} catch (err) {
				return errorResult(err);
			}
		}
	);

	return { mutateTasksTool, organizeTool };
}
