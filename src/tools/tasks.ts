import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
	addTask,
	findTaskById,
	findTasksByIds,
	listTasks,
	reservedStatusTagsError,
	reservedStatusTagsIn,
	taskNotFoundError,
	type LumbreTask,
	type TaskScope
} from '../lumbre-client.js';
import { formatTaskFull, formatTaskList } from '../format.js';
import { resolveRefs } from '../refs.js';
import {
	computeAutoNotesRender,
	computeNotesSinceRender,
	DEFAULT_NOTES_RECENT_HOURS,
	hasNotes,
	parseNotesSince,
	recordNotesSeen,
	type AutoNotesResult,
	type NotesMode
} from '../notes.js';
import {
	errorResult,
	formatOutcomeReport,
	recurrenceSchema,
	subtasksSchema,
	tagSchema,
	textResult,
	type ToolCtx
} from './shared.js';

/**
 * Modo efectivo de `notes` para `list_tasks`: `input.notes` si vino
 * informado, si no `'full'` cuando `fullNotes: true` (alias legado, ver el
 * `.describe()` de ambos campos en `list_tasks`), si no `'auto'` (default
 * nuevo). Función PURA — sin red — para poder testear el alias sin mockear
 * `fetch` (mismo patrón que `mutateTasksOpSchema`/`buildBatchFromOps`).
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
 * Familia «tareas individuales»: `add_task` (alta suelta), `list_tasks` y
 * `get_task`. Las nueve tools de Fase 2 que vivían aquí
 * (`complete_task`/`cancel_task`/`update_task`/`reschedule_task`/
 * `delete_task`/`set_section`/`remove_section`/`add_subtask`/
 * `complete_subtask`, ver PHASE2.md) se retiraron el 2026-09-19: son ops de
 * `mutate_tasks`/`organize` (ver el comentario al final de esta función y el
 * JSDoc de `src/tools/batch.ts`).
 */
export function registerTaskTools(server: McpServer, ctx: ToolCtx) {
	const addTaskTool = server.registerTool(
		'add_task',
		{
			description:
				'Añade una tarea nueva a Lumbre (planificador semanal). Dispara con "apúntame", ' +
				'"recuérdame", "añade a mi proyecto/área". La respuesta trae los avisos de la app (p. ej. si la ' +
				'colocó en otro sitio). ' +
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
					.guid()
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
				subtasks: subtasksSchema
					.optional()
					.describe(`Subtareas a crear junto con la tarea (máx. 50, 500 caracteres cada una)`),
				notes: z.string().max(10000).optional().describe('Notas/descripción larga'),
				tags: z
					.array(tagSchema)
					.optional()
					.describe(
					'Tags propios; [] deja la tarea explícitamente sin tags. acked/wip/done/not-done ' +
						'(case-insensitive) se rechazan: ese estado va como @marca en content, no aquí'
				)
			}
		},
		async (input) => {
			try {
				const reserved = reservedStatusTagsIn(input.tags);
				if (reserved.length > 0) return errorResult(new Error(reservedStatusTagsError(reserved)));
				const { notices } = await addTask(ctx.config, input);
				// Los `notices` de `/api/ingest` cuentan los desvíos que aplicó la app
				// (MC1 del audit de paridad, 23 sep 2026: antes se tiraban y el modelo
				// daba por buena una tarea que había acabado en la Bandeja).
				const noticeBlock = formatOutcomeReport([], notices);
				return textResult(
					`Tarea añadida a Lumbre: “${input.text}”.${noticeBlock !== '' ? `\n${noticeBlock}` : ''}`
				);
			} catch (err) {
				return errorResult(err);
			}
		}
	);

	const listTasksTool = server.registerTool(
		'list_tasks',
		{
			description:
				'Lee tareas de Lumbre. `scope`: today (default), week, upcoming, inbox/someday, overdue, ' +
				'all (auto "all" si usas `list` sin `scope`). `list` filtra por nombre; si no existe da ' +
				'vacío igual que un proyecto o área vacíos — usa list_lists para distinguir. `section` ' +
				'agrupa por sección dentro de `list`; `includeArchived` permite consultar archivadas. ' +
				'`notes` decide qué notas trae cada tarea (criterio completo en ese campo;' +
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
							'(equivale a fullNotes:true) — útil si vas a reeditar con la op update (que ' +
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
					const tasks = await listTasks(ctx.config, input);
					ctx.taskCache.setAll(tasks);
					const autoRender = computeNotesSinceRender(tasks, since);
					const refs = await resolveRefs(ctx.config, refTexts(tasks, 'auto', autoRender), {
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
					const tasks = await listTasks(ctx.config, { ...input, notesQuery: 'none' });
					ctx.taskCache.setAll(tasks);
					const refs = await resolveRefs(ctx.config, refTexts(tasks, notesMode), {
						includeArchived: input.includeArchived
					});
					return textResult(formatTaskList(tasks, effectiveScopeLabel(input), { notesMode, refs }));
				}

				if (notesMode === 'auto') {
					const { list, autoRender } = await listTasksAutoTwoPhase(input);
					const refs = await resolveRefs(ctx.config, refTexts(list, notesMode, autoRender), {
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
				const tasks = await listTasks(ctx.config, input);
				ctx.taskCache.setAll(tasks);
				if (notesMode === 'full') {
					// Íntegra en 'full' también cuenta como SURFACEADA — misma huella
					// que 'auto' registra, para que una vuelta con `notes: 'full'` no
					// haga que la siguiente en 'auto' vuelva a marcar "cambió" sin
					// haber cambiado — ver el JSDoc de `recordNotesSeen`.
					await recordNotesSeen(
						tasks
							.filter(hasNotes)
							.map((t) => ({ taskId: t.id, notes: t.notes as string, notesUpdatedAt: t.notesUpdatedAt })),
						ctx.notesSeenStore
					);
				}
				const refs = await resolveRefs(ctx.config, refTexts(tasks, notesMode), {
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
		const phase1 = await listTasks(ctx.config, { ...input, notesQuery: 'length' });
		const isNewServer = phase1.some((t) => 'notesLength' in t);

		if (!isNewServer) {
			ctx.taskCache.setAll(phase1);
			const autoRender = await computeAutoNotesRender(
				phase1,
				{ windowHours: input.notesRecentHours },
				ctx.notesSeenStore
			);
			return { list: phase1, autoRender };
		}

		const autoRender = await computeAutoNotesRender(
			phase1,
			{ windowHours: input.notesRecentHours },
			ctx.notesSeenStore
		);

		const fullIds = phase1
			.filter((t) => autoRender.perTask.get(t.id)?.kind === 'full')
			.map((t) => t.id);
		let fullTasksById = new Map<string, LumbreTask>();
		if (fullIds.length > 0) {
			try {
				fullTasksById = await findTasksByIds(ctx.config, fullIds, {
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

		ctx.taskCache.setAll(list);
		return { list, autoRender };
	}

	const getTaskTool = server.registerTool(
		'get_task',
		{
			description:
				'Devuelve UNA tarea entera y sin recortar (notas íntegras, fecha de creación, ' +
				'proyecto o área/sección). Si tiene subtareas, las incluye con su id y estado — única forma de ' +
				'obtener el id de una subtarea. `includeArchived` permite recuperarla si está archivada. ' +
				'Error si el taskId no existe.',

			inputSchema: {
				taskId: z.string().guid().describe('Id de la tarea (ver list_tasks)'),
				includeArchived: z
					.boolean()
					.optional()
					.describe('Permitir recuperar la tarea por id aunque esté archivada; default false')
			}
		},
		async (input) => {
			try {
				const task = await findTaskById(ctx.config, input.taskId, {
					includeArchived: input.includeArchived
				});
				if (!task) return errorResult(taskNotFoundError(input.taskId));
				ctx.taskCache.set(task);
				// La nota (si la hay) sale SIEMPRE íntegra aquí (`formatTaskFull`) — se
				// registra como vista, misma huella que `list_tasks({notes:'auto'})`
				// consulta (ver `notes.ts`); best-effort, nunca puede romper esta
				// lectura.
				if (hasNotes(task)) {
					await recordNotesSeen(
						[{ taskId: task.id, notes: task.notes as string, notesUpdatedAt: task.notesUpdatedAt }],
						ctx.notesSeenStore
					);
				}
				// Referencias EN VIVO del texto, la nota (que aquí sale siempre íntegra)
				// y las subtareas — ver `refs.ts`. Cero peticiones extra si no hay
				// ninguna referencia, que es el caso normal.
				const refs = await resolveRefs(
					ctx.config,
					[task.content, task.notes, ...(task.subtasks ?? []).map((s) => s.content)],
					{ includeArchived: input.includeArchived }
				);
				return textResult(formatTaskFull(task, refs));
			} catch (err) {
				return errorResult(err);
			}
		}
	);

	// ── Fase 2 (mutar una tarea existente, ver PHASE2.md): YA NO VIVE AQUÍ ────
	//
	// Las nueve tools sueltas de mutación individual (`complete_task`,
	// `cancel_task`, `update_task`, `reschedule_task`, `delete_task`,
	// `set_section`, `remove_section`, `add_subtask`, `complete_subtask`) se
	// retiraron el 2026-09-19 (tarea 6f62c877, decisión de David del 17 sep):
	// son las ops del mismo nombre de `mutate_tasks` (`complete`, `cancel`,
	// `update`, `reschedule`, `set_section`, `add_subtask`,
	// `complete_subtask`) y de `organize` (`delete`, `remove_section`), que ya
	// las cubrían entero con la MISMA validación de existencia y el mismo
	// payload (`translateOp` en `lumbre-client.ts`). Lo que compra la poda:
	// -6.5k caracteres de `tools/list` y una frontera MECÁNICA entre mutar una
	// tarea y borrar/reorganizar, que es lo que separa lo que puede hacer un
	// subagente portable de lo que no (ver `src/tools/batch.ts`).
	//
	// Esta familia se queda con las tres que NO son mutación por-tarea:
	// `add_task` (alta suelta, la entrada más usada del MCP), `list_tasks` y
	// `get_task`.

	// ── Gestión de proyectos y áreas (paridad UI↔MCP, docs/20-contrato-lista.md) ──
	//
	// `create_list`/`nest_list`/`rename_list`/`remove_list`/`move_to_list` NO
	// tienen tool suelta desde el 2026-08-27 (podadas: 3.506 bytes de
	// `tools/list`, 5 tools por 19 llamadas/mes de uso real medido sobre un
	// mes de transcripts); desde el 2026-09-19 son ops de `organize`
	// (`organizeOpSchema`/`organizeStrictOpSchema`/`translateOp`), junto con
	// `remove_section` y `delete`. Identidad = el id, no el nombre
	// (`rename_list` no la cambia). `remove_list` nunca pierde tareas (se
	// reasignan) ni permite borrar la última lista viva ni la Bandeja de
	// entrada canónica (§5 "Prohibidos" del contrato). Detalle completo del
	// contrato de lista en `docs/20-contrato-lista.md`.

	return { addTaskTool, listTasksTool, getTaskTool };
}
