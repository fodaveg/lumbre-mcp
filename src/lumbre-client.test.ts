import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	assertTaskUsable,
	ATTACHMENT_CONTENT_TYPE_HEADER,
	buildBatchFromOps,
	collectExistenceCheckIds,
	deleteAttachment,
	findTaskById,
	findTasksByIds,
	listLists,
	listTasks,
	runBatch,
	subtaskNotAllowedError,
	taskNotFoundError,
	uploadAttachment,
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
