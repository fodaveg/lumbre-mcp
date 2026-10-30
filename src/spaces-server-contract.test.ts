import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, stripToolsListSchema } from './index.js';
import { resetExistenceCacheRegistryForTests } from './existence-cache.js';
import {
	ASSIGNEE_REJECTED_ERROR,
	fakeLumbre,
	MEMBER_OTHER,
	PERSONAL_AREA,
	PERSONAL_LIST,
	personalList,
	personalTask,
	PRE_C5_LISTS,
	PRE_C5_TASKS,
	preC5Task,
	SHARED_LIST,
	SHARED_LIST_SUMMARY,
	sharedTask,
	SPACE_ID,
	SPACES_CATALOG,
	STORE_NOT_FOUND_BODY,
	type FakeCall
} from './test-support/c5-server-shapes.js';

/**
 * Contrato del conector con el servidor C5 REAL, no con el de la spec: las respuestas
 * de `./test-support/c5-server-shapes.ts` copian la forma de `release/fase3-cand3`
 * (`6dc35f62c`), leída campo a campo. Dos bloques:
 *
 * 1. **Cuenta personal con `LUMBRE_SPACES` apagado** (producción el 30 oct 2026): el
 *    texto de cada herramienta es el MISMO que con las respuestas anteriores a C5 y el
 *    mismo que daba `origin/main` `d13e8a7` (los literales de abajo se capturaron
 *    ejecutando ese `dist/` con estas mismas respuestas).
 * 2. **Espacio compartido**: lo que el servidor sí da (procedencia, catálogo con
 *    miembros, `?listId=`, `setAssignee`, `?store=` de adjuntos) y lo que todavía no
 *    (`assigneeId`/`assignedToMe` y `?assignee=me`, que ignora).
 */

const CONFIG = { baseUrl: 'https://lumbre.test', token: 'c5-contract-token' };
const TASK = PRE_C5_TASKS[0]!.id as string;
const clients: Client[] = [];
const servers: ReturnType<typeof createServer>[] = [];

async function call(name: string, args: Record<string, unknown>, fake: ReturnType<typeof fakeLumbre>) {
	vi.stubGlobal('fetch', fake.fetch);
	const server = createServer(CONFIG, { localFilesystem: false });
	const [a, b] = InMemoryTransport.createLinkedPair();
	stripToolsListSchema(b);
	await server.connect(b);
	const client = new Client({ name: 'c5-server-contract', version: '1' });
	await client.connect(a);
	clients.push(client);
	servers.push(server);
	const result = await client.callTool({ name, arguments: args });
	const text = (result as { content: { text?: string }[] }).content.map((c) => c.text ?? '').join('\n');
	return { text, isError: result.isError === true };
}
const requests = (calls: FakeCall[]) => calls.map((c) => `${c.method} ${c.path}?${c.params}`);

beforeEach(() => resetExistenceCacheRegistryForTests());
afterEach(async () => {
	await Promise.all([...clients.splice(0).map((c) => c.close()), ...servers.splice(0).map((s) => s.close())]);
	vi.unstubAllGlobals();
});

const preC5 = () => ({ tasks: PRE_C5_TASKS, lists: PRE_C5_LISTS });
const flagOff = () => ({
	tasks: PRE_C5_TASKS.map((t, i) => personalTask(t, i % 2 === 0)),
	lists: PRE_C5_LISTS.map(personalList),
	spaces: []
});
const batchOk = (c: FakeCall) =>
	c.path === '/api/batch'
		? {
				status: 200,
				body: {
					ok: true,
					results: (c.body as { ops: { type: string; taskId?: string }[] }).ops.map((op, index) => ({
						index,
						type: op.type,
						ok: true,
						id: op.taskId ?? 'eeee0000-0000-4000-8000-000000000001',
						materialization: 'applied'
					}))
				}
			}
		: { status: 200, body: { ok: true } };

/** Salida de `origin/main` `d13e8a7` para estas respuestas, capturada de su `dist/`. */
const GOLDEN_ORIGIN_MAIN: [string, Record<string, unknown>, string][] = [
	[
		'list_tasks',
		{},
		[
			`· proyecto/área "Trabajo" — listId: ${PERSONAL_LIST}`,
			'',
			'3 tareas (scope=today):',
			'## S1',
			'- [ ] Tarea aaaa (p2, 2026-10-30)  · id: aaaa1111-0000-4000-8000-000000000001',
			'## (sin sección)',
			'- [ ] Tarea bbbb (2026-10-30)  · id: bbbb1111-0000-4000-8000-000000000002',
			'- [ ] Tarea cccc (#casa, 2026-10-30)  · id: cccc1111-0000-4000-8000-000000000003'
		].join('\n')
	],
	[
		'get_task',
		{ taskId: TASK },
		[
			`Tarea ${TASK}`,
			'- contenido: Tarea aaaa',
			'- tags propios: (ninguno)',
			'- tags efectivos: (ninguno)',
			'- estado: pendiente',
			'- archivada: no',
			'- prioridad: p2',
			'- fecha: 2026-10-30',
			'- deadline: (sin deadline)',
			`- proyecto/área: "Trabajo" (listId: ${PERSONAL_LIST})`,
			'- sección: "S1" (sectionId: 99999999-9999-4999-8999-000000000001)',
			'- creada: 2026-10-29T10:00:00.000Z',
			'- repetición: (no repite)',
			'- notas: (sin notas)'
		].join('\n')
	],
	[
		'list_lists',
		{},
		[
			'Proyectos y áreas (3): la sangría indica el padre; marcas [área], [cerrado] (hecho), [cancelado].',
			`· Trabajo — 2 tareas (listId: ${PERSONAL_LIST})`,
			`  · Casa [área] — 0 tareas (listId: ${PERSONAL_AREA})`,
			'· Bandeja — 1 tarea (listId: 77777777-7777-4777-8777-777777777777)'
		].join('\n')
	],
	[
		'get_list',
		{ listId: PERSONAL_AREA },
		[
			`Proyecto o área ${PERSONAL_AREA}`,
			'- nombre: Casa',
			'- tipo: área',
			`- padre: Trabajo (${PERSONAL_LIST})`,
			'- estado: activo',
			'- tareas: 0',
			'- notas: (sin notas)'
		].join('\n')
	]
];

describe('C5 contra 6dc35f62c — cuenta personal con LUMBRE_SPACES apagado', () => {
	it.each(GOLDEN_ORIGIN_MAIN)('%s %j: mismo texto que origin/main y que con un servidor anterior', async (name, args, golden) => {
		const now = fakeLumbre(flagOff());
		const before = fakeLumbre(preC5());
		const current = await call(name, args, now);
		resetExistenceCacheRegistryForTests();
		const old = await call(name, args, before);
		expect(current).toEqual({ text: golden, isError: false });
		expect(old).toEqual(current);
		expect(requests(now.calls)).toEqual(requests(before.calls));
		expect(now.calls.some((c) => c.path.startsWith('/api/spaces'))).toBe(false);
	});

	it.each([
		['list_tasks', { notes: 'none' }],
		['list_tasks', { scope: 'all', notes: 'full' }],
		['list_tasks', { list: 'Trabajo' }],
		['add_task', { text: 'Alta', listId: PERSONAL_LIST }],
		['mutate_tasks', { ops: [{ op: 'complete', taskId: TASK }] }]
	])('%s %j: mismo texto y mismas peticiones que con un servidor anterior', async (name, args) => {
		const now = fakeLumbre({ ...flagOff(), write: batchOk });
		const before = fakeLumbre({ ...preC5(), write: batchOk });
		const current = await call(name, args, now);
		resetExistenceCacheRegistryForTests();
		expect(await call(name, args, before)).toEqual(current);
		expect(current.isError).toBe(false);
		expect(requests(now.calls)).toEqual(requests(before.calls));
	});

	it('list por nombre sin coincidencias: mismo «Sin tareas» con UNA lectura más del catálogo', async () => {
		const fake = fakeLumbre(flagOff());
		expect(await call('list_tasks', { list: 'Inexistente', notes: 'none' }, fake)).toEqual({
			text: 'Sin tareas (scope=all).',
			isError: false
		});
		// Única diferencia de red medida frente a `d13e8a7`: el diagnóstico de nombre
		// ambiguo entre espacios lee el catálogo cuando el filtro por nombre sale vacío.
		expect(requests(fake.calls)).toEqual([
			'GET /api/tasks?list=Inexistente&limit=500&notes=none',
			'GET /api/tasks?includeLists=1&notes=length'
		]);
	});

	it('si ese catálogo auxiliar falla, la lectura vacía sigue siendo «Sin tareas», no un error', async () => {
		const fake = fakeLumbre(flagOff());
		const fetch = vi.fn(async (url: string, init?: RequestInit) =>
			url.includes('includeLists') ? new Response('boom', { status: 500 }) : fake.fetch(url, init)
		);
		vi.stubGlobal('fetch', fetch);
		const { listTasks } = await import('./lumbre-client.js');
		expect(await listTasks(CONFIG, { list: 'Inexistente' })).toEqual([]);
		expect(fetch).toHaveBeenCalledTimes(2);
	});
});

describe('C5 contra 6dc35f62c — espacio compartido con agentAccess', () => {
	const SHARED = sharedTask(preC5Task('dddd1111-0000-4000-8000-000000000004', { list: 'Compras', somedayListId: SHARED_LIST, date: null }), {
		inViewerToday: false
	});
	const shared = (write?: (c: FakeCall) => { status: number; body: unknown }) =>
		fakeLumbre({
			tasks: [...flagOff().tasks, SHARED],
			lists: [...flagOff().lists, SHARED_LIST_SUMMARY],
			spaces: SPACES_CATALOG,
			write
		});

	it('list_tasks enseña el espacio y sus miembros del catálogo, sin inventar asignado', async () => {
		const fake = shared();
		const { text, isError } = await call('list_tasks', { scope: 'all', notes: 'none' }, fake);
		expect(isError).toBe(false);
		for (const value of [`espacio: Socios (spaceId: ${SPACE_ID})`, 'en mi Hoy: no', 'miembro: Lucía', MEMBER_OTHER]) {
			expect(text).toContain(value);
		}
		// El servidor no manda assigneeId ni assignedToMe: el conector no los deduce.
		expect(text).not.toMatch(/asignad|sin asignar/);
		// La tarea personal no gana etiquetas de espacio ni de Hoy.
		expect(text).toContain('- [ ] Tarea bbbb (2026-10-30)  · id: bbbb1111-0000-4000-8000-000000000002');
		expect(requests(fake.calls)).toEqual([
			'GET /api/tasks?scope=all&limit=500&notes=none',
			'GET /api/tasks?includeLists=1&notes=length'
		]);
	});

	it('listId exacto de una lista compartida va al servidor con scope=all y sin list', async () => {
		const fake = shared();
		const { text, isError } = await call('list_tasks', { listId: SHARED_LIST, list: 'Nombre viejo', notes: 'none' }, fake);
		expect(isError).toBe(false);
		expect(text).toContain('Tarea dddd');
		expect(text).not.toContain('Tarea aaaa');
		const params = fake.calls[0]!.params;
		expect(params.get('listId')).toBe(SHARED_LIST);
		expect(params.get('scope')).toBe('all');
		expect(params.has('list')).toBe(false);
	});

	it('listId de una lista personal: la procedencia null del servidor confirma el filtro', async () => {
		const fake = shared();
		const { text, isError } = await call('list_tasks', { listId: PERSONAL_LIST, notes: 'none' }, fake);
		expect(isError).toBe(false);
		expect(text).toContain('2 tareas (scope=all)');
	});

	it('listId que el servidor no deja ver (404 «Lista no encontrada») es «no existe», sin listado general', async () => {
		const fake = shared();
		const hidden = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
		const { text, isError } = await call('list_tasks', { listId: hidden, notes: 'none' }, fake);
		expect(isError).toBe(true);
		expect(text).toContain(`El listId ${hidden} no está entre los proyectos/áreas`);
		expect(text).not.toContain('Tarea');
		expect(fake.calls).toHaveLength(1);
	});

	it('assignee=me: el servidor lo ignora y el conector da error en vez de presentar el listado', async () => {
		const fake = shared();
		const { text, isError } = await call('list_tasks', { scope: 'all', assignee: 'me', notes: 'none' }, fake);
		expect(isError).toBe(true);
		expect(text).toContain('no confirmó el filtro assignee=me');
		expect(text).not.toContain('Tarea dddd');
		expect(fake.calls[0]!.params.get('assignee')).toBe('me');
		expect(fake.calls).toHaveLength(1);
	});

	it('add_task con assigneeId no admitido: el 400 del servidor llega tal cual, sin alta', async () => {
		const fake = shared(() => ({ status: 400, body: { message: ASSIGNEE_REJECTED_ERROR } }));
		const { text, isError } = await call('add_task', { text: 'Alta', listId: PERSONAL_LIST, assigneeId: MEMBER_OTHER }, fake);
		expect(isError).toBe(true);
		expect(text).toContain(ASSIGNEE_REJECTED_ERROR);
		expect(fake.calls.map((c) => [c.path, c.body])).toEqual([
			['/api/ingest', { text: 'Alta', listId: PERSONAL_LIST, assigneeId: MEMBER_OTHER, literal: true }]
		]);
	});

	it('mutate_tasks: alta y set_assignee rechazados por op conservan el éxito parcial', async () => {
		const fake = shared((c) =>
			c.path === '/api/batch'
				? {
						status: 200,
						body: {
							ok: true,
							results: [
								{ index: 0, type: 'ingest', ok: false, error: ASSIGNEE_REJECTED_ERROR },
								{ index: 1, type: 'mutate', ok: false, error: 'not_found', id: SHARED.id },
								{ index: 2, type: 'mutate', ok: true, id: SHARED.id, materialization: 'applied' }
							]
						}
					}
				: { status: 200, body: { ok: true } }
		);
		const { text } = await call(
			'mutate_tasks',
			{
				ops: [
					{ op: 'add_task', text: 'Alta', listId: SHARED_LIST, assigneeId: MEMBER_OTHER },
					{ op: 'set_assignee', taskId: SHARED.id, assigneeId: MEMBER_OTHER },
					{ op: 'set_assignee', taskId: SHARED.id, assigneeId: '' }
				]
			},
			fake
		);
		expect(text).toContain(ASSIGNEE_REJECTED_ERROR);
		expect(text).toContain('not_found');
		const batch = fake.calls.find((c) => c.path === '/api/batch')!;
		expect(batch.body).toEqual({
			ops: [
				{ type: 'ingest', task: { text: 'Alta', listId: SHARED_LIST, assigneeId: MEMBER_OTHER, literal: true } },
				{ type: 'mutate', taskId: SHARED.id, kind: 'setAssignee', payload: { assigneeId: MEMBER_OTHER } },
				{ type: 'mutate', taskId: SHARED.id, kind: 'setAssignee', payload: { assigneeId: '' } }
			]
		});
	});

	it('permiso de subida: ?store= del espacio para la compartida y sin store para la personal', async () => {
		const permit = (c: FakeCall) => ({
			status: 200,
			body: {
				permit: 'test-permit',
				uploadUrl: `https://lumbre.test/api/attachments?taskId=${(c.body as { taskId: string }).taskId}${c.params.get('store') ? `&store=${c.params.get('store')}` : ''}`,
				method: 'POST',
				expiresAt: '2026-10-30T11:00:00.000Z',
				maxBytes: 26214400
			}
		});
		const fake = shared(permit);
		expect((await call('prepare_attachment_upload', { taskId: SHARED.id, filename: 'a.txt' }, fake)).isError).toBe(false);
		resetExistenceCacheRegistryForTests();
		expect((await call('prepare_attachment_upload', { taskId: TASK, filename: 'a.txt' }, fake)).isError).toBe(false);
		const writes = fake.calls.filter((c) => c.method === 'POST');
		expect(writes.map((c) => `${c.path}?${c.params}`)).toEqual([
			`/api/attachments/upload-permits?store=${SPACE_ID}`,
			'/api/attachments/upload-permits?'
		]);
	});

	it('subida a un espacio revocado entre lectura y escritura: el 404 del servidor sin reintento en personal', async () => {
		const fake = shared(() => ({ status: 404, body: STORE_NOT_FOUND_BODY }));
		const { isError } = await call('add_attachment', { taskId: SHARED.id, filename: 'a.txt', content_base64: 'eA==' }, fake);
		expect(isError).toBe(true);
		const writes = fake.calls.filter((c) => c.method === 'POST');
		expect(writes).toHaveLength(1);
		expect(writes[0]!.params.get('store')).toBe(SPACE_ID);
		expect(fake.calls.some((c) => c.path.startsWith('/api/spaces'))).toBe(false);
	});
});
