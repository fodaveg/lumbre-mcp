import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	assertTaskUsable,
	buildBatchFromOps,
	collectExistenceCheckIds,
	findTasksByIds,
	runBatch,
	subtaskNotAllowedError,
	taskNotFoundError,
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
		expect(() => assertTaskUsable(undefined, 'no-existe')).toThrow(/no existe/i);
		expect(() => assertTaskUsable(undefined, 'no-existe', { allowSubtask: true })).toThrow(/no existe/i);
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
	const ACCEPT_SUBTASK = ['complete_task', 'cancel_task', 'delete_task', 'complete_subtask', 'add_subtask'];
	const REJECT_SUBTASK = ['update_task', 'reschedule_task', 'set_section', 'move_to_list'];

	it.each(ACCEPT_SUBTASK)('%s: acepta un subtaskId (residencia/agenda intactas)', () => {
		expect(() => assertTaskUsable(subtask(), 'sub-1', { allowSubtask: true })).not.toThrow();
	});

	it.each(REJECT_SUBTASK)('%s: RECHAZA un subtaskId (evita corromper residencia/agenda)', () => {
		expect(() => assertTaskUsable(subtask(), 'sub-1', { allowSubtask: false })).toThrow(subtaskNotAllowedError('sub-1').message);
	});

	it('los mensajes de error mencionan explícitamente cómo seguir (list_tasks/get_task/complete_subtask)', () => {
		expect(taskNotFoundError('x').message).toMatch(/list_tasks/);
		expect(subtaskNotAllowedError('x').message).toMatch(/complete_subtask/);
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
		expect(skipped).toEqual([{ index: 0, error: expect.stringMatching(/no existe/i) }]);
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

	it('subtarea SIN allowSubtask (update/reschedule/set_section/move_to_list): se descarta', () => {
		const sub = topLevel('s1', { parentId: 't1' });
		const ops: MutateTasksOp[] = [{ op: 'update', taskId: 's1', content: 'x' }];
		const { batchOps, skipped } = buildBatchFromOps(ops, new Map([['s1', sub]]));
		expect(batchOps).toEqual([]);
		expect(skipped[0].error).toMatch(/SUBTAREA/);
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
