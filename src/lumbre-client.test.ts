import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	assertTaskUsable,
	ATTACHMENT_CONTENT_TYPE_HEADER,
	buildBatchFromOps,
	collectExistenceCheckIds,
	deleteAttachment,
	excludeIngestForBrokenListPromises,
	filterPhase2AfterPhase1,
	findTaskById,
	findTasksByIds,
	listLists,
	listTasks,
	planBatchPhases,
	rescheduleSubtaskDecision,
	runBatch,
	subtaskDecisionFor,
	subtaskNotAllowedError,
	subtaskUnscheduleNotAllowedError,
	taskNotFoundError,
	uploadAttachment,
	type BatchOp,
	type BatchResultItem,
	type LumbreConfig,
	type LumbreTask,
	type MutateTasksOp
} from './lumbre-client.js';

/**
 * `assertTaskUsable` es la comprobación PURA (sin red) que decide si una
 * tool puede operar sobre un `taskId` ya resuelto — la reutiliza
 * `requireTaskExists` (`index.ts`) para las 7 tools de mutación existentes,
 * y `add_subtask`/`complete_subtask`. Se testea aquí, aislada de `fetch` y
 * de `McpServer` (importar `index.ts` directamente no es seguro en test:
 * conecta un `StdioServerTransport` y exige `LUMBRE_TOKEN` en el arranque
 * del módulo), con la MISMA matriz de decisión que usa cada tool — ver el
 * JSDoc de `assertTaskUsable`.
 */

function topLevelTask(overrides: Partial<LumbreTask> = {}): LumbreTask {
	return {
		id: 'top-1',
		content: 'tarea de primer nivel',
		notes: null,
		done: false,
		priority: null,
		date: null,
		deadline: null,
		list: null,
		createdAt: new Date().toISOString(),
		parentId: null,
		...overrides
	};
}

function subtask(overrides: Partial<LumbreTask> = {}): LumbreTask {
	return topLevelTask({ id: 'sub-1', content: 'subtarea', parentId: 'top-1', ...overrides });
}

describe('assertTaskUsable', () => {
	it('taskId inexistente (`task` undefined): lanza SIEMPRE, con o sin allowSubtask', () => {
		expect(() => assertTaskUsable(undefined, 'no-existe')).toThrow(/no está entre/i);
		expect(() => assertTaskUsable(undefined, 'no-existe', { allowSubtask: true })).toThrow(/no está entre/i);
	});

	it('tarea de primer nivel: SIEMPRE se acepta, con o sin allowSubtask', () => {
		expect(() => assertTaskUsable(topLevelTask(), 'top-1')).not.toThrow();
		expect(() => assertTaskUsable(topLevelTask(), 'top-1', { allowSubtask: false })).not.toThrow();
		expect(() => assertTaskUsable(topLevelTask(), 'top-1', { allowSubtask: true })).not.toThrow();
	});

	it('subtarea SIN allowSubtask (default): se RECHAZA con un error claro (no un 500 genérico)', () => {
		expect(() => assertTaskUsable(subtask(), 'sub-1')).toThrow(/SUBTAREA/);
		expect(() => assertTaskUsable(subtask(), 'sub-1', { allowSubtask: false })).toThrow(/SUBTAREA/);
	});

	it('subtarea CON allowSubtask:true: se acepta', () => {
		expect(() => assertTaskUsable(subtask(), 'sub-1', { allowSubtask: true })).not.toThrow();
	});

	/**
	 * Matriz exacta que usa cada tool de `index.ts` (ver el JSDoc de
	 * `assertTaskUsable` y de `requireTaskExists`): fija aquí para que un
	 * cambio accidental del flag en una tool rompa este test, no solo el
	 * comportamiento en producción.
	 */
	const ACCEPT_SUBTASK = [
		'complete_task',
		'cancel_task',
		'delete_task',
		'complete_subtask',
		'add_subtask',
		'update_task'
	];
	const REJECT_SUBTASK = ['set_section', 'move_to_list'];

	it.each(ACCEPT_SUBTASK)('%s: acepta un subtaskId (no escribe residencia)', () => {
		expect(() => assertTaskUsable(subtask(), 'sub-1', { allowSubtask: true })).not.toThrow();
	});

	it.each(REJECT_SUBTASK)('%s: RECHAZA un subtaskId (evita corromper la residencia)', () => {
		expect(() => assertTaskUsable(subtask(), 'sub-1', { allowSubtask: false })).toThrow(subtaskNotAllowedError('sub-1').message);
	});

	it('`subtaskError` inyectado: el rechazo sale con ESE error, no con el genérico', () => {
		expect(() =>
			assertTaskUsable(subtask(), 'sub-1', {
				allowSubtask: false,
				subtaskError: subtaskUnscheduleNotAllowedError
			})
		).toThrow(subtaskUnscheduleNotAllowedError('sub-1').message);
	});

	it('los mensajes de error mencionan explícitamente cómo seguir (list_tasks/get_task/complete_subtask)', () => {
		expect(taskNotFoundError('x').message).toMatch(/list_tasks/);
		expect(subtaskNotAllowedError('x').message).toMatch(/complete_subtask/);
	});

	it('subtaskNotAllowedError NO afirma que editar una subtarea esté prohibido — update_task sí vale', () => {
		// Regresión del texto viejo («es de residencia/agenda/edición»): desde
		// que `update_task` acepta un `subtaskId`, decir "edición" mandaba al
		// modelo a rendirse en un caso que funciona. El mensaje debe nombrar el
		// motivo REAL (lista/sección) y apuntar a update_task como vía viva.
		const message = subtaskNotAllowedError('x').message;
		expect(message).toMatch(/update_task/);
		expect(message).not.toMatch(/residencia\/agenda\/edición/);
		expect(message).toMatch(/lista ni sección/i);
	});

	it('taskNotFoundError NO afirma que la tarea no existe — nombra la posibilidad de que esté archivada', () => {
		// Regresión: `findTaskById` filtra las ARCHIVADAS incluso con
		// `includeDone=true` (ver su JSDoc en lumbre-client.ts), así que "no
		// existe" es falso en ese caso — dos sesiones dieron por buenas tareas
		// que en realidad estaban archivadas por culpa de este mensaje.
		const message = taskNotFoundError('x').message;
		expect(message).not.toMatch(/no existe ninguna tarea/i);
		expect(message).toMatch(/archivad/i);
	});
});

/**
 * Superficie 1 de las DOS que comparten la condición: la tool individual
 * `reschedule_task` (`index.ts`), que hace exactamente
 * `requireTaskExists(taskId, rescheduleSubtaskDecision(input.date))` →
 * `assertTaskUsable(task, taskId, decision)`. Se prueba esa composición y no
 * la tool: importar `index.ts` en un test no es seguro (conecta un
 * `StdioServerTransport` y exige `LUMBRE_TOKEN` al cargar el módulo), mismo
 * motivo por el que `assertTaskUsable` se testea aislada más arriba.
 * La superficie 2 (`op:"reschedule"` de `mutate_tasks`) está en
 * `describe('buildBatchFromOps')`, y las dos llaman a la MISMA
 * `rescheduleSubtaskDecision` — si divergieran, uno de los dos bloques cae.
 */
describe('rescheduleSubtaskDecision (tool individual reschedule_task)', () => {
	it('subtarea + fecha: PASA (date es un accidental permitido, §2.5; el servidor usa moveTask)', () => {
		const decision = rescheduleSubtaskDecision('2026-01-01');
		expect(decision.allowSubtask).toBe(true);
		expect(() => assertTaskUsable(subtask(), 'sub-1', decision)).not.toThrow();
	});

	it('subtarea + date:null: se RECHAZA, y con SU error (no el genérico de lista/sección)', () => {
		const decision = rescheduleSubtaskDecision(null);
		expect(decision.allowSubtask).toBe(false);
		expect(() => assertTaskUsable(subtask(), 'sub-1', decision)).toThrow(
			subtaskUnscheduleNotAllowedError('sub-1').message
		);
		// El motivo importa: con el genérico, el modelo concluiría que tampoco
		// puede ponerle fecha a la subtarea — que sí puede.
		expect(() => assertTaskUsable(subtask(), 'sub-1', decision)).not.toThrow(
			subtaskNotAllowedError('sub-1').message
		);
	});

	it('CONTROL — tarea RAÍZ + date:null: sigue pasando (esto no cambia para una tarea de primer nivel)', () => {
		expect(() =>
			assertTaskUsable(topLevelTask(), 'top-1', rescheduleSubtaskDecision(null))
		).not.toThrow();
	});

	it('el error de desagendar dice qué SÍ se puede hacer con la subtarea', () => {
		const message = subtaskUnscheduleNotAllowedError('x').message;
		expect(message).toMatch(/reschedule_task con date:"YYYY-MM-DD"/);
		expect(message).toMatch(/update_task/);
		expect(message).toMatch(/delete_task/);
	});
});

// ── Feature batch (`plan-batch.md`) ─────────────────────────────────────────

const config: LumbreConfig = { baseUrl: 'https://lumbre.test', token: 'tok-123' };

/** `fetch` mockeado — response JSON con status 200 por defecto (ajustable). */
function mockFetchJson(body: unknown, status = 200): void {
	vi.stubGlobal(
		'fetch',
		vi.fn().mockResolvedValue(
			new Response(JSON.stringify(body), {
				status,
				headers: { 'content-type': 'application/json' }
			})
		)
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('findTasksByIds', () => {
	it('ids: [] no llama a la red — Map vacío directo', async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		const map = await findTasksByIds(config, []);
		expect(map.size).toBe(0);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('manda GET /api/tasks?ids=a,b,c y parsea el array de respuesta a un Map por id', async () => {
		const taskA: LumbreTask = {
			id: 'a',
			content: 'tarea A',
			notes: null,
			done: false,
			priority: null,
			date: null,
			deadline: null,
			list: null,
			createdAt: new Date().toISOString()
		};
		const fetchSpy = vi.fn().mockResolvedValue(
			new Response(JSON.stringify([taskA]), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
		);
		vi.stubGlobal('fetch', fetchSpy);

		const map = await findTasksByIds(config, ['a', 'b']);
		expect(map.size).toBe(1);
		expect(map.get('a')).toEqual(taskA);
		expect(map.get('b')).toBeUndefined();

		const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('https://lumbre.test/api/tasks?ids=a%2Cb');
		expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok-123');
	});

	it('respuesta que no es un array lanza LumbreApiError', async () => {
		mockFetchJson({ not: 'an-array' });
		await expect(findTasksByIds(config, ['a'])).rejects.toThrow(/inesperada/);
	});

	it('manda `notes=` cuando se indica (fase 2 de list_tasks: notesQuery: "full")', async () => {
		const fetchSpy = vi.fn().mockResolvedValue(
			new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } })
		);
		vi.stubGlobal('fetch', fetchSpy);
		await findTasksByIds(config, ['a'], { notesQuery: 'full' });
		const [url] = fetchSpy.mock.calls[0] as [string];
		expect(url).toBe('https://lumbre.test/api/tasks?ids=a&notes=full');
	});

	it('reenvía includeArchived=true (no 1) junto a `notes=` en la fase 2', async () => {
		const fetchSpy = vi.fn().mockResolvedValue(
			new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } })
		);
		vi.stubGlobal('fetch', fetchSpy);
		await findTasksByIds(config, ['a'], { notesQuery: 'full', includeArchived: true });
		const [url] = fetchSpy.mock.calls[0] as [string];
		expect(url).toBe('https://lumbre.test/api/tasks?ids=a&notes=full&includeArchived=true');
		expect(url).not.toContain('includeArchived=1');
	});

	it('trocea por encima de MAX_IDS_PER_REQUEST (200): dos peticiones, resultado fusionado', async () => {
		const ids = Array.from({ length: 250 }, (_, i) => `id-${i}`);
		const fetchSpy = vi.fn(async (url: string | URL) => {
			const u = new URL(String(url));
			const reqIds = (u.searchParams.get('ids') ?? '').split(',');
			const tasks = reqIds.map((id) => ({
				id,
				content: `tarea ${id}`,
				notes: null,
				done: false,
				priority: null,
				date: null,
				deadline: null,
				list: null,
				createdAt: new Date().toISOString()
			}));
			return new Response(JSON.stringify(tasks), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		});
		vi.stubGlobal('fetch', fetchSpy);

		const map = await findTasksByIds(config, ids);

		expect(fetchSpy).toHaveBeenCalledTimes(2);
		const firstIds = new URL(String(fetchSpy.mock.calls[0][0])).searchParams.get('ids')!.split(',');
		const secondIds = new URL(String(fetchSpy.mock.calls[1][0])).searchParams.get('ids')!.split(',');
		expect(firstIds).toHaveLength(200);
		expect(secondIds).toHaveLength(50);
		expect(map.size).toBe(250);
		for (const id of ids) expect(map.get(id)?.id).toBe(id);
	});
});

// b00303b5: `list_lists` — lee TODAS las listas, incluidas las de recuento 0
// (una lista vacía es invisible en `list_tasks`, que solo "ve" listas a
// través de sus tareas).
describe('listLists', () => {
	it('manda GET /api/tasks?includeLists=1 y devuelve `lists` tal cual, INCLUIDAS las de taskCount 0', async () => {
		const lists = [
			{ id: 'l1', name: 'Con tareas', taskCount: 3 },
			{ id: 'l2', name: 'Recién creada', taskCount: 0 }
		];
		const fetchSpy = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ lists }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
		);
		vi.stubGlobal('fetch', fetchSpy);

		const result = await listLists(config);
		expect(result).toEqual(lists);
		expect(result.find((l) => l.name === 'Recién creada')?.taskCount).toBe(0);

		const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('https://lumbre.test/api/tasks?includeLists=1');
		expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok-123');
	});

	it('respuesta sin `lists` (array) lanza LumbreApiError', async () => {
		mockFetchJson({ not: 'lists' });
		await expect(listLists(config)).rejects.toThrow(/inesperada/);
	});
});

// `scope=upcoming` + `days` (2026-07-26): ventana RODANTE de N días contando
// hoy — `week` es la semana de CALENDARIO y en domingo no tiene nada delante.
describe('listTasks — scope upcoming', () => {
	it('reenvía `scope=upcoming` y `days` tal cual en la query', async () => {
		const fetchSpy = vi.fn().mockResolvedValue(
			new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
		);
		vi.stubGlobal('fetch', fetchSpy);

		await listTasks(config, { scope: 'upcoming', days: 3 });
		expect(fetchSpy.mock.calls[0][0]).toBe('https://lumbre.test/api/tasks?scope=upcoming&days=3');
	});

	it('sin `days` no manda el parámetro (el default 7 lo pone el servidor)', async () => {
		const fetchSpy = vi.fn().mockResolvedValue(
			new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
		);
		vi.stubGlobal('fetch', fetchSpy);

		await listTasks(config, { scope: 'upcoming' });
		expect(fetchSpy.mock.calls[0][0]).toBe('https://lumbre.test/api/tasks?scope=upcoming');
	});
});

describe('includeArchived — contrato GET /api/tasks', () => {
	it('listTasks reenvía el literal includeArchived=true (no 1) y conserva los demás filtros', async () => {
		const fetchSpy = vi.fn().mockResolvedValue(
			new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
		);
		vi.stubGlobal('fetch', fetchSpy);

		await listTasks(config, { scope: 'all', includeDone: true, includeArchived: true });
		const [url] = fetchSpy.mock.calls[0] as [string];
		expect(url).toBe(
			'https://lumbre.test/api/tasks?scope=all&includeDone=true&includeArchived=true'
		);
		expect(url).not.toContain('includeArchived=1');
	});

	it('findTaskById permite recuperar una archivada solo cuando se solicita y usa `true`', async () => {
		const fetchSpy = vi.fn().mockImplementation(() =>
			Promise.resolve(
				new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
			)
		);
		vi.stubGlobal('fetch', fetchSpy);

		await findTaskById(config, 'task-1');
		await findTaskById(config, 'task-1', { includeArchived: true });

		expect(fetchSpy.mock.calls[0][0]).toBe('https://lumbre.test/api/tasks?id=task-1');
		expect(fetchSpy.mock.calls[1][0]).toBe(
			'https://lumbre.test/api/tasks?id=task-1&includeArchived=true'
		);
	});
});

describe('runBatch', () => {
	it('manda POST /api/batch con {ops} y devuelve `results` tal cual', async () => {
		const results: BatchResultItem[] = [{ index: 0, type: 'mutate', ok: true, id: 'x' }];
		const fetchSpy = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ ok: true, results }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
		);
		vi.stubGlobal('fetch', fetchSpy);

		const ops = [{ type: 'mutate' as const, taskId: 'x', kind: 'complete' as const, payload: { done: true } }];
		const got = await runBatch(config, ops);
		expect(got).toEqual(results);

		const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('https://lumbre.test/api/batch');
		expect(init.method).toBe('POST');
		expect(JSON.parse(init.body as string)).toEqual({ ops });
	});

	it('respuesta sin `results` array lanza LumbreApiError', async () => {
		mockFetchJson({ ok: true });
		await expect(runBatch(config, [])).rejects.toThrow(/no confirmó el batch/);
	});
});

describe('collectExistenceCheckIds', () => {
	it('recoge taskId/subtaskId SOLO de las 9 ops que targetean una tarea, deduplicados', () => {
		const ops: MutateTasksOp[] = [
			{ op: 'complete', taskId: 't1' },
			{ op: 'cancel', taskId: 't1' }, // repetido: una sola entrada
			{ op: 'complete_subtask', subtaskId: 's1' },
			{ op: 'add_task', text: 'nueva' }, // NO targetea tarea existente
			{ op: 'create_list', name: 'Lista' }, // NO targetea tarea
			{ op: 'remove_section', sectionId: 'sec1' } // NO targetea tarea
		];
		expect(collectExistenceCheckIds(ops).sort()).toEqual(['s1', 't1']);
	});

	it('lote vacío → []', () => {
		expect(collectExistenceCheckIds([])).toEqual([]);
	});
});

describe('buildBatchFromOps', () => {
	function topLevel(id: string, overrides: Partial<LumbreTask> = {}): LumbreTask {
		return {
			id,
			content: `tarea ${id}`,
			notes: null,
			done: false,
			priority: null,
			date: null,
			deadline: null,
			list: null,
			createdAt: new Date().toISOString(),
			parentId: null,
			...overrides
		};
	}

	it('op mutate-sobre-tarea con id EXISTENTE se traduce a BatchOp y viaja', () => {
		const ops: MutateTasksOp[] = [{ op: 'complete', taskId: 't1', done: true }];
		const existing = new Map([['t1', topLevel('t1')]]);
		const { batchOps, originalIndexes, skipped } = buildBatchFromOps(ops, existing);
		expect(skipped).toEqual([]);
		expect(originalIndexes).toEqual([0]);
		expect(batchOps).toEqual([
			{ type: 'mutate', taskId: 't1', kind: 'complete', payload: { done: true } }
		]);
	});

	it('op mutate-sobre-tarea con id INEXISTENTE se descarta (skipped), NO viaja en batchOps', () => {
		const ops: MutateTasksOp[] = [{ op: 'complete', taskId: 'no-existe' }];
		const { batchOps, originalIndexes, skipped } = buildBatchFromOps(ops, new Map());
		expect(batchOps).toEqual([]);
		expect(originalIndexes).toEqual([]);
		expect(skipped).toEqual([{ index: 0, error: expect.stringMatching(/no está entre/i) }]);
	});

	it('una op fallida no impide las demás — el índice ORIGINAL se conserva pese al hueco', () => {
		const ops: MutateTasksOp[] = [
			{ op: 'complete', taskId: 'no-existe' },
			{ op: 'delete', taskId: 't1' }
		];
		const existing = new Map([['t1', topLevel('t1')]]);
		const { batchOps, originalIndexes, skipped } = buildBatchFromOps(ops, existing);
		expect(skipped).toEqual([{ index: 0, error: expect.any(String) }]);
		expect(originalIndexes).toEqual([1]); // la única enviada es la op de índice 1
		expect(batchOps).toEqual([{ type: 'mutate', taskId: 't1', kind: 'delete', payload: {} }]);
	});

	it.each([
		['set_section', { op: 'set_section', taskId: 's1', section: 'Bugs' } satisfies MutateTasksOp],
		['move_to_list', { op: 'move_to_list', taskId: 's1', list: 'Proyecto' } satisfies MutateTasksOp]
	])('subtarea en `op:"%s"` (residencia): se descarta', (_name, op) => {
		const sub = topLevel('s1', { parentId: 't1' });
		const { batchOps, skipped } = buildBatchFromOps([op], new Map([['s1', sub]]));
		expect(batchOps).toEqual([]);
		expect(skipped[0].error).toMatch(/SUBTAREA/);
	});

	/**
	 * Superficie 2 de la decisión CONDICIONAL (la 1 es la tool individual, en
	 * `describe('rescheduleSubtaskDecision …')`): con fecha entra, con
	 * `date: null` se descarta. Las dos salen de la MISMA
	 * `rescheduleSubtaskDecision`, vía `subtaskDecisionFor`.
	 */
	it('subtarea en `op:"reschedule"` CON fecha: se ACEPTA y viaja en batchOps', () => {
		const sub = topLevel('s1', { parentId: 't1' });
		const ops: MutateTasksOp[] = [{ op: 'reschedule', taskId: 's1', date: '2026-01-01' }];
		const { batchOps, skipped } = buildBatchFromOps(ops, new Map([['s1', sub]]));
		expect(skipped).toEqual([]);
		expect(batchOps).toEqual([
			{ type: 'mutate', taskId: 's1', kind: 'reschedule', payload: { date: '2026-01-01' } }
		]);
	});

	it('subtarea en `op:"reschedule"` con date:null: se descarta con el error de DESAGENDAR', () => {
		const sub = topLevel('s1', { parentId: 't1' });
		const ops: MutateTasksOp[] = [{ op: 'reschedule', taskId: 's1', date: null }];
		const { batchOps, skipped } = buildBatchFromOps(ops, new Map([['s1', sub]]));
		expect(batchOps).toEqual([]);
		expect(skipped).toEqual([
			{ index: 0, error: subtaskUnscheduleNotAllowedError('s1').message }
		]);
	});

	it('CONTROL — tarea RAÍZ en `op:"reschedule"` con date:null: sigue viajando', () => {
		const ops: MutateTasksOp[] = [{ op: 'reschedule', taskId: 't1', date: null }];
		const { batchOps, skipped } = buildBatchFromOps(ops, new Map([['t1', topLevel('t1')]]));
		expect(skipped).toEqual([]);
		expect(batchOps).toEqual([
			{ type: 'mutate', taskId: 't1', kind: 'reschedule', payload: { date: null } }
		]);
	});

	it('el descarte de un `reschedule` con date:null NO tumba el resto del lote (éxito PARCIAL, como los demás)', () => {
		const sub = topLevel('s1', { parentId: 't1' });
		const ops: MutateTasksOp[] = [
			{ op: 'reschedule', taskId: 's1', date: null },
			{ op: 'reschedule', taskId: 's1', date: '2026-01-01' },
			{ op: 'complete', taskId: 't1' }
		];
		const existing = new Map([
			['s1', sub],
			['t1', topLevel('t1')]
		]);
		const { batchOps, originalIndexes, skipped } = buildBatchFromOps(ops, existing);
		expect(skipped).toEqual([{ index: 0, error: expect.stringMatching(/SUBTAREA/) }]);
		expect(originalIndexes).toEqual([1, 2]); // se conservan los índices ORIGINALES
		expect(batchOps).toHaveLength(2);
	});

	it('`subtaskDecisionFor`: solo `reschedule` depende del payload; el resto sale de la tabla', () => {
		// Guardarraíl del punto único: si alguien añadiera OTRA op condicional
		// sin pasar por `subtaskDecisionFor`, las dos superficies divergirían.
		expect(subtaskDecisionFor({ op: 'reschedule', taskId: 's1', date: null })).toEqual({
			allowSubtask: false,
			subtaskError: subtaskUnscheduleNotAllowedError
		});
		expect(subtaskDecisionFor({ op: 'reschedule', taskId: 's1', date: '2026-01-01' })).toEqual({
			allowSubtask: true
		});
		expect(subtaskDecisionFor({ op: 'update', taskId: 's1', content: 'x' })).toEqual({
			allowSubtask: true
		});
		expect(subtaskDecisionFor({ op: 'set_section', taskId: 's1', section: null })).toEqual({
			allowSubtask: false
		});
		// Op que NO targetea una tarea: sin comprobación de existencia.
		expect(subtaskDecisionFor({ op: 'create_list', name: 'X' })).toBeUndefined();
	});

	/**
	 * Contracara POSITIVA de la anterior: `op:"update"` sobre una subtarea NO
	 * se descarta y llega ENTERA a la traducción a `BatchOp` — sus cuatro
	 * campos son accidentales permitidos en subtarea (docs/18 §2.5). Si
	 * alguien vuelve a poner `update: false` en `TASK_TARGET_ALLOW_SUBTASK`,
	 * este test se pone rojo aquí, no en producción.
	 */
	it('subtarea en `op:"update"`: se ACEPTA y viaja en batchOps (docs/18 §2.5)', () => {
		const sub = topLevel('s1', { parentId: 't1' });
		const ops: MutateTasksOp[] = [
			{ op: 'update', taskId: 's1', content: 'texto nuevo', notes: 'nota', priority: 'p1', time: '09:30' }
		];
		const { batchOps, skipped } = buildBatchFromOps(ops, new Map([['s1', sub]]));
		expect(skipped).toEqual([]);
		expect(batchOps).toEqual([
			{
				type: 'mutate',
				taskId: 's1',
				kind: 'update',
				payload: { content: 'texto nuevo', notes: 'nota', priority: 1, time: '09:30' }
			}
		]);
	});

	it('subtarea CON allowSubtask (complete/cancel/delete/add_subtask/complete_subtask): se acepta', () => {
		const sub = topLevel('s1', { parentId: 't1' });
		const ops: MutateTasksOp[] = [{ op: 'complete_subtask', subtaskId: 's1', done: true }];
		const { batchOps, skipped } = buildBatchFromOps(ops, new Map([['s1', sub]]));
		expect(skipped).toEqual([]);
		expect(batchOps).toEqual([
			{ type: 'mutate', taskId: 's1', kind: 'complete', payload: { done: true } }
		]);
	});

	it('ops de LISTA/SECCIÓN y add_task NUNCA comprueban existencia (no están en `existing`, viajan igual)', () => {
		const ops: MutateTasksOp[] = [
			{ op: 'add_task', text: 'nueva tarea' },
			{ op: 'create_list', name: 'Lista' },
			{ op: 'remove_section', sectionId: 'sec1' },
			{ op: 'nest_list', listId: 'l1', parentId: null },
			{ op: 'rename_list', listId: 'l1', name: 'Otro nombre' },
			{ op: 'remove_list', listId: 'l1' }
		];
		const { batchOps, skipped } = buildBatchFromOps(ops, new Map()); // existing VACÍO
		expect(skipped).toEqual([]);
		expect(batchOps).toHaveLength(6);
		expect(batchOps[0]).toEqual({ type: 'ingest', task: { text: 'nueva tarea' } });
	});

	it('validación local: `update` sin ningún campo a cambiar se descarta ANTES de comprobar existencia', () => {
		const ops: MutateTasksOp[] = [{ op: 'update', taskId: 't1' }];
		// `existing` vacío a propósito: si la validación local no cortara antes,
		// esto fallaría igualmente por "no existe" — pero el mensaje debe ser el
		// de "indica al menos un campo", no el de existencia.
		const { skipped } = buildBatchFromOps(ops, new Map());
		expect(skipped[0].error).toMatch(/al menos un campo/);
	});

	it('validación local: `move_to_list` sin `listId` NI `list` se descarta', () => {
		const existing = new Map([['t1', topLevel('t1')]]);
		const ops: MutateTasksOp[] = [{ op: 'move_to_list', taskId: 't1' }];
		const { skipped, batchOps } = buildBatchFromOps(ops, existing);
		expect(batchOps).toEqual([]);
		expect(skipped[0].error).toMatch(/listId.*list/);
	});

	it('create_list SIN `listId` explícito: genera uno propio (uuid) — distinto en cada llamada', () => {
		const ops: MutateTasksOp[] = [{ op: 'create_list', name: 'A' }];
		const { batchOps: first } = buildBatchFromOps(ops, new Map());
		const { batchOps: second } = buildBatchFromOps(ops, new Map());
		expect(first[0]).toMatchObject({ type: 'mutate', kind: 'createList' });
		expect(second[0]).toMatchObject({ type: 'mutate', kind: 'createList' });
		const firstId = (first[0] as { taskId: string }).taskId;
		const secondId = (second[0] as { taskId: string }).taskId;
		expect(firstId).not.toBe(secondId);
	});

	it('update: traduce priority p1..p4 al nivel numérico (p4 → null quita la prioridad)', () => {
		const existing = new Map([['t1', topLevel('t1')]]);
		const ops: MutateTasksOp[] = [{ op: 'update', taskId: 't1', priority: 'p4' }];
		const { batchOps } = buildBatchFromOps(ops, existing);
		expect(batchOps).toEqual([
			{ type: 'mutate', taskId: 't1', kind: 'update', payload: { priority: null } }
		]);
	});

	/**
	 * Encadenado intra-lote (code-review 🟠 #3b): `create_list` con `listId`
	 * PRE-GENERADO por el llamante (en vez de dejar que el servidor asigne
	 * uno) para que OTRA op del MISMO `mutate_tasks` pueda targetearlo — un
	 * `move_to_list` no comprueba existencia de LISTA (solo de tarea, ver
	 * `TASK_TARGET_ALLOW_SUBTASK`), así que ambas ops del lote viajan sin
	 * depender de ninguna llamada previa.
	 */
	it('create_list con `listId` explícito: lo usa TAL CUAL (no genera uno nuevo) — permite encadenar con move_to_list al MISMO listId en el mismo lote', () => {
		const listId = 'a0b1c2d3-e4f5-4678-9abc-def012345678';
		const existing = new Map([['t1', topLevel('t1')]]);
		const ops: MutateTasksOp[] = [
			{ op: 'create_list', name: 'Proyecto nuevo', listId },
			{ op: 'move_to_list', taskId: 't1', listId }
		];
		const { batchOps, skipped } = buildBatchFromOps(ops, existing);
		expect(skipped).toEqual([]);
		expect(batchOps).toEqual([
			{ type: 'mutate', taskId: listId, kind: 'createList', payload: { name: 'Proyecto nuevo' } },
			{ type: 'mutate', taskId: 't1', kind: 'moveToList', payload: { listId } }
		]);
	});

});

// ── Reparto en dos fases (incidente 071553) — `planBatchPhases` /
// `filterPhase2AfterPhase1` ─────────────────────────────────────────────────

describe('planBatchPhases', () => {
	const LIST_ID = 'a0b1c2d3-e4f5-4678-9abc-def012345678';

	it('sin dependencia (ningún add_task con el listId de un create_list del lote): NO parte', () => {
		const batchOps: BatchOp[] = [
			{ type: 'mutate', taskId: 't1', kind: 'complete', payload: { done: true } },
			{ type: 'ingest', task: { text: 'suelta' } }
		];
		const plan = planBatchPhases(batchOps, [0, 1]);
		expect(plan.split).toBe(false);
		expect(plan.phases).toEqual([{ ops: batchOps, originalIndexes: [0, 1] }]);
		expect(plan.dependents).toEqual([]);
	});

	it('add_task con listId de una lista YA EXISTENTE (sin create_list en el lote): NO parte', () => {
		const batchOps: BatchOp[] = [{ type: 'ingest', task: { text: 'a la lista', listId: LIST_ID } }];
		const plan = planBatchPhases(batchOps, [0]);
		expect(plan.split).toBe(false);
		expect(plan.dependents).toEqual([]);
	});

	it('create_list + N add_task con ese listId: parte en fase mutate y fase ingest', () => {
		const batchOps: BatchOp[] = [
			{ type: 'mutate', taskId: LIST_ID, kind: 'createList', payload: { name: 'X' } },
			{ type: 'ingest', task: { text: 'tarea 1', listId: LIST_ID } },
			{ type: 'ingest', task: { text: 'tarea 2', listId: LIST_ID } }
		];
		const plan = planBatchPhases(batchOps, [0, 1, 2]);
		expect(plan.split).toBe(true);
		expect(plan.phases).toHaveLength(2);
		expect(plan.phases[0]).toEqual({ ops: [batchOps[0]], originalIndexes: [0] });
		expect(plan.phases[1]).toEqual({ ops: [batchOps[1], batchOps[2]], originalIndexes: [1, 2] });
		expect(plan.dependents).toEqual([
			{ index: 1, listId: LIST_ID },
			{ index: 2, listId: LIST_ID }
		]);
	});

	it('con dependencia, un `mutate` AJENO a create_list también va en la fase 1, en su orden original', () => {
		const batchOps: BatchOp[] = [
			{ type: 'mutate', taskId: 't1', kind: 'complete', payload: { done: true } },
			{ type: 'mutate', taskId: LIST_ID, kind: 'createList', payload: { name: 'X' } },
			{ type: 'ingest', task: { text: 'tarea', listId: LIST_ID } }
		];
		const plan = planBatchPhases(batchOps, [0, 1, 2]);
		expect(plan.split).toBe(true);
		expect(plan.phases[0]).toEqual({ ops: [batchOps[0], batchOps[1]], originalIndexes: [0, 1] });
		expect(plan.phases[1]).toEqual({ ops: [batchOps[2]], originalIndexes: [2] });
	});

	it('con dependencia, un add_task SIN listId (o con el de otra lista) viaja igual en la fase 2', () => {
		const batchOps: BatchOp[] = [
			{ type: 'mutate', taskId: LIST_ID, kind: 'createList', payload: { name: 'X' } },
			{ type: 'ingest', task: { text: 'depende', listId: LIST_ID } },
			{ type: 'ingest', task: { text: 'sin lista' } },
			{ type: 'ingest', task: { text: 'lista ajena', listId: 'otra-lista-ya-existente' } }
		];
		const plan = planBatchPhases(batchOps, [0, 1, 2, 3]);
		expect(plan.split).toBe(true);
		expect(plan.phases[1].originalIndexes).toEqual([1, 2, 3]);
		expect(plan.dependents).toEqual([{ index: 1, listId: LIST_ID }]);
	});
});

describe('filterPhase2AfterPhase1', () => {
	const LIST_ID = 'a0b1c2d3-e4f5-4678-9abc-def012345678';

	it('plan sin partir (`split:false`): devuelve todo vacío, no hay fase 2 que filtrar', () => {
		const batchOps: BatchOp[] = [{ type: 'ingest', task: { text: 'x' } }];
		const plan = planBatchPhases(batchOps, [0]);
		const filtered = filterPhase2AfterPhase1(plan, []);
		expect(filtered).toEqual({ ops: [], originalIndexes: [], skipped: [] });
	});

	it('create_list OK: las altas dependientes SÍ se mandan', () => {
		const batchOps: BatchOp[] = [
			{ type: 'mutate', taskId: LIST_ID, kind: 'createList', payload: { name: 'X' } },
			{ type: 'ingest', task: { text: 'tarea', listId: LIST_ID } }
		];
		const plan = planBatchPhases(batchOps, [0, 1]);
		const phase1Results: BatchResultItem[] = [{ index: 0, type: 'mutate', ok: true, id: LIST_ID }];
		const filtered = filterPhase2AfterPhase1(plan, phase1Results);
		expect(filtered.ops).toEqual([batchOps[1]]);
		expect(filtered.originalIndexes).toEqual([1]);
		expect(filtered.skipped).toEqual([]);
	});

	it('create_list FALLA: las altas dependientes NO se mandan y salen como fallo con su índice original', () => {
		const batchOps: BatchOp[] = [
			{ type: 'mutate', taskId: LIST_ID, kind: 'createList', payload: { name: 'X' } },
			{ type: 'ingest', task: { text: 'tarea 1', listId: LIST_ID } },
			{ type: 'ingest', task: { text: 'tarea 2', listId: LIST_ID } }
		];
		const plan = planBatchPhases(batchOps, [0, 1, 2]);
		const phase1Results: BatchResultItem[] = [
			{ index: 0, type: 'mutate', ok: false, error: 'nombre duplicado' }
		];
		const filtered = filterPhase2AfterPhase1(plan, phase1Results);
		expect(filtered.ops).toEqual([]);
		expect(filtered.originalIndexes).toEqual([]);
		expect(filtered.skipped).toEqual([
			{ index: 1, error: expect.stringContaining('op [0]') },
			{ index: 2, error: expect.stringContaining('op [0]') }
		]);
		expect(filtered.skipped[0].error).toMatch(/no se pudo crear en este lote/);
		expect(filtered.skipped[0].error).toMatch(/no se ha creado/);
	});

	it('una alta que NO depende de ningún create_list del lote sobrevive al filtro aunque OTRA sí dependa', () => {
		const batchOps: BatchOp[] = [
			{ type: 'mutate', taskId: LIST_ID, kind: 'createList', payload: { name: 'X' } },
			{ type: 'ingest', task: { text: 'depende', listId: LIST_ID } },
			{ type: 'ingest', task: { text: 'sin lista' } }
		];
		const plan = planBatchPhases(batchOps, [0, 1, 2]);
		const phase1Results: BatchResultItem[] = [
			{ index: 0, type: 'mutate', ok: false, error: 'nombre duplicado' }
		];
		const filtered = filterPhase2AfterPhase1(plan, phase1Results);
		expect(filtered.ops).toEqual([batchOps[2]]);
		expect(filtered.originalIndexes).toEqual([2]);
		expect(filtered.skipped).toEqual([{ index: 1, error: expect.any(String) }]);
	});

	/**
	 * Nit de revisión (🔴, sobre el commit que introdujo esta función): con DOS
	 * `create_list` del mismo lote prometiendo el MISMO `listId`, un `Map`
	 * simple `listId → {index, ok}` se quedaba con el ÚLTIMO — podía citar la
	 * op equivocada, o dar la lista por creada con una hermana rota. La regla:
	 * una promesa de `listId` solo se cumple si TODOS los `create_list` que la
	 * prometen salieron `ok`; el mensaje cita el que falló con el índice
	 * ORIGINAL más bajo.
	 */
	it('DOS create_list con el MISMO listId: si uno falla, la promesa se rompe y se cita el que falló ANTES (por índice original)', () => {
		const batchOps: BatchOp[] = [
			{ type: 'mutate', taskId: LIST_ID, kind: 'createList', payload: { name: 'A' } },
			{ type: 'mutate', taskId: LIST_ID, kind: 'createList', payload: { name: 'B' } },
			{ type: 'ingest', task: { text: 'tarea', listId: LIST_ID } }
		];
		const plan = planBatchPhases(batchOps, [5, 2, 9]); // índices originales fuera de orden a propósito
		const phase1Results: BatchResultItem[] = [
			{ index: 0, type: 'mutate', ok: true, id: LIST_ID },
			{ index: 1, type: 'mutate', ok: false, error: 'nombre duplicado' }
		];
		const filtered = filterPhase2AfterPhase1(plan, phase1Results);
		expect(filtered.ops).toEqual([]);
		// El que falló (índice original 2) es el que se cita, no el que salió
		// bien (índice original 5) ni el orden de llegada al `Map`.
		expect(filtered.skipped).toEqual([{ index: 9, error: expect.stringContaining('op [2]') }]);
	});

	it('DOS create_list con el MISMO listId: si AMBOS salen ok, la alta dependiente viaja', () => {
		const batchOps: BatchOp[] = [
			{ type: 'mutate', taskId: LIST_ID, kind: 'createList', payload: { name: 'A' } },
			{ type: 'mutate', taskId: LIST_ID, kind: 'createList', payload: { name: 'B' } },
			{ type: 'ingest', task: { text: 'tarea', listId: LIST_ID } }
		];
		const plan = planBatchPhases(batchOps, [0, 1, 2]);
		const phase1Results: BatchResultItem[] = [
			{ index: 0, type: 'mutate', ok: true, id: LIST_ID },
			{ index: 1, type: 'mutate', ok: true, id: LIST_ID }
		];
		const filtered = filterPhase2AfterPhase1(plan, phase1Results);
		expect(filtered.ops).toEqual([batchOps[2]]);
		expect(filtered.skipped).toEqual([]);
	});
});

describe('excludeIngestForBrokenListPromises', () => {
	const LIST_ID = 'a0b1c2d3-e4f5-4678-9abc-def012345678';

	it('brokenListIds vacío: no toca nada (mismas referencias)', () => {
		const batchOps: BatchOp[] = [{ type: 'ingest', task: { text: 'x', listId: LIST_ID } }];
		const result = excludeIngestForBrokenListPromises(batchOps, [0], new Map());
		expect(result).toEqual({ batchOps, originalIndexes: [0], skipped: [] });
	});

	/**
	 * El agujero 🔴 que cierra esta función: un `create_list` descartado por
	 * FORMA inválida (p. ej. sin `name`) nunca llega a `batchOps`, así que
	 * `planBatchPhases` (que solo ve `batchOps`) no encuentra ninguna
	 * dependencia y el `add_task` con ese `listId` viajaría SOLO — huérfano,
	 * exactamente el síntoma del incidente 071553. Este filtro corre ANTES de
	 * `planBatchPhases` con el `listId` roto ya conocido (lo construye
	 * `index.ts` a partir de `shapeFailures`/`built.skipped`, ver
	 * `BrokenListPromise`).
	 */
	it('add_task con listId de un create_list ROTO (nunca llegó a batchOps): se excluye y sale como fallo', () => {
		const batchOps: BatchOp[] = [{ type: 'ingest', task: { text: 'tarea', listId: LIST_ID } }];
		const brokenListIds = new Map([[LIST_ID, { index: 0, error: 'create_list: falta `name`' }]]);
		const result = excludeIngestForBrokenListPromises(batchOps, [1], brokenListIds);
		expect(result.batchOps).toEqual([]);
		expect(result.originalIndexes).toEqual([]);
		expect(result.skipped).toEqual([
			{ index: 1, error: expect.stringContaining('op [0]') }
		]);
		expect(result.skipped[0].error).toMatch(/no se pudo crear en este lote/);
		expect(result.skipped[0].error).toMatch(/no se ha creado/);
	});

	it('un add_task independiente (sin listId roto) sobrevive aunque OTRO del lote sí esté excluido', () => {
		const batchOps: BatchOp[] = [
			{ type: 'ingest', task: { text: 'depende', listId: LIST_ID } },
			{ type: 'ingest', task: { text: 'suelta' } },
			{ type: 'mutate', taskId: 't1', kind: 'complete', payload: { done: true } }
		];
		const brokenListIds = new Map([[LIST_ID, { index: 0, error: 'create_list: falta `name`' }]]);
		const result = excludeIngestForBrokenListPromises(batchOps, [1, 2, 3], brokenListIds);
		expect(result.batchOps).toEqual([batchOps[1], batchOps[2]]);
		expect(result.originalIndexes).toEqual([2, 3]);
		expect(result.skipped).toEqual([{ index: 1, error: expect.any(String) }]);
	});
});

// ── uploadAttachment (POST /api/attachments?taskId=) ────────────────────────

describe('uploadAttachment', () => {
	const TASK_ID = '11111111-1111-1111-1111-111111111111';
	const RESPONSE_BODY = {
		id: 'att-1',
		taskId: TASK_ID,
		filename: 'informe año.pdf',
		mime: 'application/pdf',
		size: 9,
		storageKey: 'attachments/att-1',
		createdAt: 1_700_000_000_000
	};

	function mockUploadResponse(body: unknown, status = 200): ReturnType<typeof vi.fn> {
		const fetchSpy = vi.fn().mockResolvedValue(
			new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
		);
		vi.stubGlobal('fetch', fetchSpy);
		return fetchSpy;
	}

	it('camino feliz: PUT del cuerpo binario, mime, nombre URL-encodeado, taskId en la query, Bearer', async () => {
		const fetchSpy = mockUploadResponse(RESPONSE_BODY);
		const bytes = Buffer.from('contenido');

		const got = await uploadAttachment(config, {
			taskId: TASK_ID,
			filename: 'informe año.pdf',
			mime: 'application/pdf',
			bytes
		});

		expect(got).toEqual(RESPONSE_BODY);
		const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(`https://lumbre.test/api/attachments?taskId=${TASK_ID}`);
		expect(init.method).toBe('POST');
		expect(init.body).toBe(bytes);
		const headers = init.headers as Record<string, string>;
		expect(headers.authorization).toBe('Bearer tok-123');
		// `Content-Type` fijo, NUNCA el mime real (ver el JSDoc de
		// `uploadAttachment`) — el mime real viaja en `ATTACHMENT_CONTENT_TYPE_HEADER`.
		expect(headers['content-type']).toBe('application/octet-stream');
		expect(headers[ATTACHMENT_CONTENT_TYPE_HEADER]).toBe('application/pdf');
		// espacio → %20, "ñ" → %C3%B1 (UTF-8) — encodeURIComponent exacto, no una
		// aproximación con solo espacios escapados.
		expect(headers['x-lumbre-filename']).toBe(encodeURIComponent('informe año.pdf'));
		expect(headers['x-lumbre-filename']).toBe('informe%20a%C3%B1o.pdf');
	});

	/**
	 * EL GUARDARRAÍL REAL (movido aquí desde `attachments.test.ts` el
	 * 2026-08-27, ver el JSDoc de `uploadAttachment`): el `Content-Type` que
	 * sale por el cable NUNCA es uno de los cuatro que `is_form_content_type`
	 * de SvelteKit intercepta como formulario (`application/octet-stream` no
	 * está en esa lista, por construcción), pase lo que pase con el mapa de
	 * mimes de `mimeForFilename` — el mime real viaja aparte, en
	 * `x-lumbre-content-type`. Antes esto se comprobaba degradando el mime
	 * ANTES de llegar aquí; ahora `uploadAttachment` lo garantiza siempre, así
	 * que se comprueba para un `.png` (nunca degradaba) Y un `.txt` (sí
	 * degradaba) — los dos tienen que salir con el MISMO `Content-Type` fijo.
	 */
	it('Content-Type SIEMPRE application/octet-stream; el mime real va en x-lumbre-content-type (.png y .txt)', async () => {
		for (const mime of ['image/png', 'text/plain']) {
			const fetchSpy = mockUploadResponse(RESPONSE_BODY);
			await uploadAttachment(config, { taskId: TASK_ID, filename: 'f', mime, bytes: Buffer.from('x') });
			const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
			const headers = init.headers as Record<string, string>;
			expect(headers['content-type']).toBe('application/octet-stream');
			expect(headers[ATTACHMENT_CONTENT_TYPE_HEADER]).toBe(mime);
		}
	});

	it('404: la tarea no existe/borrada/archivada — mensaje del servidor si lo hay', async () => {
		mockUploadResponse({ message: 'La tarea no existe, está borrada o archivada' }, 404);
		await expect(
			uploadAttachment(config, { taskId: TASK_ID, filename: 'a.pdf', mime: 'application/pdf', bytes: Buffer.from('x') })
		).rejects.toThrow(/no existe, está borrada o archivada/);
	});

	it('413: propaga el mensaje EXACTO del servidor (distingue tamaño vs cuota, este cliente no lo adivina)', async () => {
		mockUploadResponse({ message: 'Cuota de adjuntos agotada para esta cuenta' }, 413);
		await expect(
			uploadAttachment(config, { taskId: TASK_ID, filename: 'a.pdf', mime: 'application/pdf', bytes: Buffer.from('x') })
		).rejects.toThrow(/Cuota de adjuntos agotada/);
	});

	it('429: mensaje de rate limit, igual que el resto del cliente', async () => {
		mockUploadResponse({ message: 'rate limited' }, 429);
		await expect(
			uploadAttachment(config, { taskId: TASK_ID, filename: 'a.pdf', mime: 'application/pdf', bytes: Buffer.from('x') })
		).rejects.toThrow(/Demasiadas peticiones/);
	});

	it('401: mensaje de token inválido, igual que el resto del cliente', async () => {
		mockUploadResponse({ message: 'unauthorized' }, 401);
		await expect(
			uploadAttachment(config, { taskId: TASK_ID, filename: 'a.pdf', mime: 'application/pdf', bytes: Buffer.from('x') })
		).rejects.toThrow(/Token inválido/);
	});

	it('respuesta 200 sin `id`: LumbreApiError, no un adjunto a medias', async () => {
		mockUploadResponse({ ok: true });
		await expect(
			uploadAttachment(config, { taskId: TASK_ID, filename: 'a.pdf', mime: 'application/pdf', bytes: Buffer.from('x') })
		).rejects.toThrow(/no confirmó la subida/);
	});
});

// ── deleteAttachment (DELETE /api/attachments/:id) ──────────────────────────

describe('deleteAttachment', () => {
	const ATTACHMENT_ID = '22222222-2222-4222-8222-222222222222';

	function mockDeleteResponse(body: unknown, status = 200): ReturnType<typeof vi.fn> {
		const fetchSpy = vi.fn().mockResolvedValue(
			new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
		);
		vi.stubGlobal('fetch', fetchSpy);
		return fetchSpy;
	}

	it('camino feliz: DELETE exacto por id con Bearer y confirmación {ok:true}', async () => {
		const fetchSpy = mockDeleteResponse({ ok: true });

		await deleteAttachment(config, ATTACHMENT_ID);

		const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(`https://lumbre.test/api/attachments/${ATTACHMENT_ID}`);
		expect(init.method).toBe('DELETE');
		expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok-123');
	});

	it('404 no distingue un id inexistente de uno ajeno (anti-IDOR)', async () => {
		mockDeleteResponse({ message: 'No encontrado' }, 404);
		await expect(deleteAttachment(config, ATTACHMENT_ID)).rejects.toThrow(
			`Adjunto ${ATTACHMENT_ID} no encontrado (o no pertenece al dueño del token).`
		);
	});

	it('401 conserva el error de credencial común del cliente', async () => {
		mockDeleteResponse({ message: 'Token no válido' }, 401);
		await expect(deleteAttachment(config, ATTACHMENT_ID)).rejects.toThrow(/Token inválido/);
	});

	it('429 conserva el error de rate limit común del cliente', async () => {
		mockDeleteResponse({ message: 'Demasiadas peticiones' }, 429);
		await expect(deleteAttachment(config, ATTACHMENT_ID)).rejects.toThrow(/Demasiadas peticiones/);
	});

	it('otros errores propagan status y detalle del servidor', async () => {
		mockDeleteResponse({ message: 'almacenamiento no disponible' }, 503);
		await expect(deleteAttachment(config, ATTACHMENT_ID)).rejects.toThrow(
			/Lumbre respondió 503: almacenamiento no disponible/
		);
	});

	it('200 sin {ok:true}: error de contrato, no falso positivo', async () => {
		mockDeleteResponse({ ok: false });
		await expect(deleteAttachment(config, ATTACHMENT_ID)).rejects.toThrow(/no confirmó el borrado/);
	});
});
