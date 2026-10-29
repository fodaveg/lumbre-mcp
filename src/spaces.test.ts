import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, stripToolsListSchema } from './index.js';
import { resetExistenceCacheRegistryForTests } from './existence-cache.js';
import {
	buildBatchFromOps, collectExistenceCheckIds, getListById, getListCatalog,
	listTasks, type LumbreTask, type LumbreSpace
} from './lumbre-client.js';
import { formatTaskFull, formatTaskList, formatListDetail, formatListSummaries } from './format.js';
import { mutateTasksStrictOpSchema } from './tools/batch.js';
import { emptyRefResolution, resolveRefs, renderRefs } from './refs.js';

const CONFIG = { baseUrl: 'https://lumbre.test', token: 'c5g-test-token' };
const TASK = '11111111-1111-4111-8111-111111111111';
const LIST = '22222222-2222-4222-8222-222222222222';
const SPACE = '33333333-3333-4333-8333-333333333333';
const MEMBER = 'a1'.repeat(32);
const OTHER = 'b2'.repeat(32);
const space: LumbreSpace = { spaceId: SPACE, name: 'Equipo', members: [{ accountId: MEMBER, name: 'Ana' }] };
const task: LumbreTask = {
	id: TASK, content: 'Preparar informe', notes: null, createdAt: '2026-10-29T10:00:00Z',
	done: false, priority: null, date: null, deadline: null, list: 'Trabajo', somedayListId: LIST,
	parentId: null, storeId: SPACE, spaceId: SPACE, assigneeId: MEMBER, assignedToMe: true,
	inViewerToday: false, crossStoreDuplicate: true
};
const list = { id: LIST, name: 'Trabajo', taskCount: 1, storeId: SPACE, spaceId: SPACE, spaceName: 'Equipo' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
	status, headers: { 'content-type': 'application/json' }
});
const clients: Client[] = [];
const servers: ReturnType<typeof createServer>[] = [];
async function client() {
	const server = createServer(CONFIG, { localFilesystem: false });
	const [a, b] = InMemoryTransport.createLinkedPair();
	stripToolsListSchema(b);
	await server.connect(b);
	const client = new Client({ name: 'c5g-contract-test', version: '1' });
	await client.connect(a);
	clients.push(client); servers.push(server);
	return client;
}
function text(result: unknown): string {
	return (result as { content: { text?: string }[] }).content.map((c) => c.text ?? '').join('\n');
}

beforeEach(() => resetExistenceCacheRegistryForTests());
afterEach(async () => {
	await Promise.all([...clients.splice(0).map((c) => c.close()), ...servers.splice(0).map((s) => s.close())]);
	vi.unstubAllGlobals();
});

describe('C5-g — contrato de lectura y presentación', () => {
	it('conserva campos de tarea y reenvía listId y assignee=me al servidor', async () => {
		const fetch = vi.fn(async (_url: string, _init?: RequestInit) => json([task])); vi.stubGlobal('fetch', fetch);
		expect(await listTasks(CONFIG, { listId: LIST, assignee: 'me', scope: 'all' })).toEqual([task]);
		const url = new URL(fetch.mock.calls[0]![0] as string);
		expect(url.searchParams.get('assignee')).toBe('me');
		expect(url.searchParams.get('listId')).toBe(LIST);
	});

	it('lee la forma mínima de spaces y metadata opcional, sin filtrar agentAccess localmente', async () => {
		const full = { ...space, storeId: SPACE, role: 'editor', agentAccess: false };
		vi.stubGlobal('fetch', vi.fn(async () => json({ lists: [list], spaces: [full] })));
		const catalog = await getListCatalog(CONFIG);
		expect(catalog.spaces).toEqual([full]);
		expect(catalog.lists[0]?.space).toEqual(full);
		const output = formatListSummaries(catalog.lists, catalog.spaces);
		expect(output).toContain('Ana'); expect(output).toContain(MEMBER);
		expect(output).toContain('rol: editor'); expect(output).toContain('agentAccess: false');
		expect(output).not.toContain('@');
		expect((await getListById(CONFIG, LIST))?.space).toEqual(full);
	});

	it.each(['none', 'auto', 'preview', 'full'])('list_tasks notes=%s presenta espacio, asignación, Hoy y duplicado', async (notes) => {
		const fetch = vi.fn(async (url: string) => new URL(url).searchParams.has('includeLists')
			? json({ lists: [list], spaces: [space] }) : json([task]));
		vi.stubGlobal('fetch', fetch);
		const result = await (await client()).callTool({ name: 'list_tasks', arguments: { listId: LIST, assignee: 'me', notes } });
		expect(result.isError).not.toBe(true);
		const output = text(result);
		for (const expected of ['scope=all', 'Equipo', SPACE, 'Ana', MEMBER, 'asignada a mí: sí', 'en mi Hoy: no', 'crossStoreDuplicate']) expect(output).toContain(expected);
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(new URL(fetch.mock.calls[0]![0]).searchParams.get('assignee')).toBe('me');
	});

	it('notesSince conserva filtros y metadata compartida en su rama de lectura', async () => {
		const fetch = vi.fn(async (url: string) => new URL(url).searchParams.has('includeLists')
			? json({ lists: [list], spaces: [space] }) : json([task]));
		vi.stubGlobal('fetch', fetch);
		const result = await (await client()).callTool({ name: 'list_tasks', arguments: { assignee: 'me', notesSince: '2026-10-01' } });
		expect(text(result)).toContain('Equipo'); expect(text(result)).toContain(MEMBER);
		expect(new URL(fetch.mock.calls[0]![0]).searchParams.get('assignee')).toBe('me');
	});

	it('subtareas muestran asignado propio sin heredar el de la madre', () => {
		const output = formatTaskFull({ ...task, space, subtasks: [
			{ id: 'child-a', content: 'Sin asignado', done: false, assigneeId: null },
			{ id: 'child-b', content: 'Otra persona', done: false, assigneeId: OTHER }
		] });
		expect(output).toContain('Sin asignado (sin asignar)');
		expect(output).toContain(`Otra persona (asignado: ${OTHER})`);
		expect(output).not.toContain('Sin asignado (asignado: Ana');
	});

	it('get_task, list_lists y get_list exponen espacio y miembros en herramientas reales', async () => {
		vi.stubGlobal('fetch', vi.fn(async (url: string) => new URL(url).searchParams.has('includeLists')
			? json({ lists: [list], spaces: [space] }) : json([task])));
		const c = await client();
		for (const [name, args] of [['get_task', { taskId: TASK }], ['list_lists', {}], ['get_list', { listId: LIST }]] as const) {
			const output = text(await c.callTool({ name, arguments: args }));
			for (const value of ['Equipo', SPACE, 'Ana', MEMBER]) expect(output).toContain(value);
		}
	});

	it('muestra miembros de espacios aunque el catálogo no tenga listas', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => json({ lists: [], spaces: [space] })));
		const output = text(await (await client()).callTool({ name: 'list_lists', arguments: {} }));
		expect(output).toContain('Sin proyectos ni áreas'); expect(output).toContain(MEMBER);
	});

	it('personal sin campos conserva formato y no consulta catálogo extra', async () => {
		const { storeId, spaceId, assigneeId, assignedToMe, inViewerToday, crossStoreDuplicate, ...personal } = task;
		const fetch = vi.fn(async () => json([personal])); vi.stubGlobal('fetch', fetch);
		const output = text(await (await client()).callTool({ name: 'list_tasks', arguments: { notes: 'none' } }));
		expect(output).toBe(formatTaskList([personal], 'today', { notesMode: 'none' }));
		expect(output).not.toMatch(/espacio:|asignad|crossStore/); expect(fetch).toHaveBeenCalledTimes(1);
		expect(formatTaskFull(personal)).not.toContain('espacio:');
		expect(formatListDetail({ id: LIST, name: 'Personal', taskCount: 0 })).not.toContain('espacio:');
		vi.stubGlobal('fetch', vi.fn(async () => json({ lists: [] })));
		expect(await getListCatalog(CONFIG)).toEqual({ lists: [], spaces: undefined });
	});

	it('personal C5 con campos nulos conserva exactamente el formato anterior', () => {
		const personal = { ...task, storeId: undefined, spaceId: undefined, assigneeId: undefined,
			assignedToMe: undefined, inViewerToday: undefined, crossStoreDuplicate: undefined };
		const upgraded = { ...personal, storeId: 'personal-store', spaceId: null, assigneeId: null,
			assignedToMe: false, inViewerToday: false, crossStoreDuplicate: false };
		expect(formatTaskFull(upgraded)).toBe(formatTaskFull(personal));
		expect(formatTaskList([upgraded], 'today')).toBe(formatTaskList([personal], 'today'));
		const oldList = { id: LIST, name: 'Personal', taskCount: 0 };
		const newList = { ...oldList, storeId: 'personal-store', spaceId: null, spaceName: null };
		expect(formatListDetail(newList)).toBe(formatListDetail(oldList));
		expect(formatListSummaries([newList])).toBe(formatListSummaries([oldList]));
	});

	it('referencias personales con metadata nula conservan el render anterior', () => {
		const old = emptyRefResolution();
		old.checkedTasks.add(TASK); old.checkedLists.add(LIST);
		old.tasks.set(TASK, { ...task, spaceId: undefined }); old.lists.set(LIST, 'Trabajo');
		const current = emptyRefResolution();
		current.checkedTasks.add(TASK); current.checkedLists.add(LIST);
		current.tasks.set(TASK, { ...task, spaceId: null }); current.lists.set(LIST, 'Trabajo');
		current.listStores!.set(LIST, { storeId: 'personal-store', spaceId: null, spaceName: null });
		const value = `[[list:${LIST}|Viejo]] [[task:${TASK}|Viejo]]`;
		expect(renderRefs(value, current)).toBe(renderRefs(value, old));
	});

	it.each(['listId', 'assignee'])('servidor viejo que ignora %s da error y no lista tareas como filtradas', async (filter) => {
		const fetch = vi.fn(async (_url: string) => json([{ ...task, spaceId: undefined, assignedToMe: undefined }]));
		vi.stubGlobal('fetch', fetch);
		const result = await (await client()).callTool({ name: 'list_tasks', arguments: { notes: 'none', ...(filter === 'listId' ? { listId: LIST, list: 'Nombre obsoleto' } : { assignee: 'me' }) } });
		expect(result.isError).toBe(true); expect(text(result)).toContain('La API no confirmó');
		expect(text(result)).not.toContain(task.content); expect(fetch).toHaveBeenCalledTimes(1);
		if (filter === 'listId') {
			const url = new URL(fetch.mock.calls[0]![0]);
			expect(url.searchParams.get('scope')).toBe('all'); expect(url.searchParams.has('list')).toBe(false);
		}
	});

	it.each([undefined, []])('vacío con filtro nuevo distingue soporte spaces=%s', async (spaces) => {
		vi.stubGlobal('fetch', vi.fn(async (url: string) => new URL(url).searchParams.has('includeLists')
			? json({ lists: [], ...(spaces ? { spaces } : {}) }) : json([])));
		const result = await (await client()).callTool({ name: 'list_tasks', arguments: { assignee: 'me', notes: 'none' } });
		if (spaces) { expect(result.isError).not.toBe(true); expect(text(result)).toContain('Sin tareas'); }
		else { expect(result.isError).toBe(true); expect(text(result)).toContain('sin catálogo spaces'); }
	});

	it('no fusiona secciones homónimas de listas de distintos espacios', () => {
		const output = formatTaskList([{ ...task, section: 'Bugs', space },
			{ ...task, id: 'other', somedayListId: 'other-list', spaceId: 'other-space', spaceName: 'Otro', section: 'Bugs' }], 'all');
		expect(output).toContain('## Trabajo · Equipo · Bugs'); expect(output).toContain('## Trabajo · Otro · Bugs');
	});

	it('referencias vivas conservan la procedencia compartida sin cambiar su identidad', async () => {
		vi.stubGlobal('fetch', vi.fn(async (url: string) => new URL(url).searchParams.has('includeLists')
			? json({ lists: [list], spaces: [space] }) : json([task])));
		const value = `[[list:${LIST}|Viejo]] [[task:${TASK}|Viejo]]`;
		const output = renderRefs(value, await resolveRefs(CONFIG, [value]));
		expect(output).toContain('espacio:"Equipo"'); expect(output).toContain(`spaceId:${SPACE}`);
		expect(output).toContain(`id:${TASK}`); expect(output).toContain(`id:${LIST}`);
	});

	it('404 not_found de get_list es inexistente sin otra credencial ni fallback', async () => {
		const fetch = vi.fn(async (_url: string, _init?: RequestInit) => json({ code: 'not_found', message: 'No encontrado' }, 404));
		vi.stubGlobal('fetch', fetch);
		expect(await getListById(CONFIG, LIST)).toBeNull(); expect(fetch).toHaveBeenCalledTimes(1);
	});
});

describe('C5-g — nombres nulos o vacíos y list ambiguo', () => {
	const unnamed: LumbreSpace = { spaceId: SPACE, name: '', members: [{ accountId: MEMBER, name: null }] };

	it('miembro con name null se pinta (sin nombre) en catálogo y asignación', () => {
		const out = formatTaskFull({ ...task, space: unnamed });
		expect(out).toContain(`asignado: (sin nombre) (${MEMBER})`);
		expect(out).not.toContain('null');
	});

	it('espacio con name vacío pinta (sin nombre) y conserva el spaceId', () => {
		expect(formatTaskFull({ ...task, space: unnamed })).toContain(`espacio: (sin nombre) (spaceId: ${SPACE})`);
		expect(formatTaskFull({ ...task, spaceName: '' })).toContain(`espacio: (sin nombre) (spaceId: ${SPACE})`);
		expect(formatTaskFull({ ...task, spaceName: undefined })).toContain(`espacio: ${SPACE} (spaceId: ${SPACE})`);
	});

	const OTHER_LIST = '44444444-4444-4444-8444-444444444444';
	const PERSONAL_LIST = '55555555-5555-4555-8555-555555555555';
	const shared2 = { ...list, id: OTHER_LIST, name: 'trabajo', storeId: OTHER, spaceId: OTHER, spaceName: '' };
	const personalList = { id: PERSONAL_LIST, name: 'Trabajo', taskCount: 0, storeId: null, spaceId: null, spaceName: null };
	const emptyWith = (lists: unknown[]) => {
		const fetch = vi.fn(async (url: string) => json(url.includes('includeLists') ? { lists, spaces: [space] } : []));
		vi.stubGlobal('fetch', fetch);
		return fetch;
	};

	it('dos compartidas homónimas sin personal con respuesta vacía lanzan error con ids', async () => {
		emptyWith([{ ...list, name: 'Trabajo' }, shared2]);
		const err = await listTasks(CONFIG, { list: 'TRABAJO' }).catch((e: Error) => e);
		expect(err).toBeInstanceOf(Error);
		const message = (err as Error).message;
		expect(message).toContain('ambiguo'); expect(message).toContain('listId');
		expect(message).toContain(LIST); expect(message).toContain(OTHER_LIST);
		expect(message).toContain('(sin nombre)'); expect(message).toContain('Equipo');
	});

	it('personal vacía más una compartida homónima no es ambiguo', async () => {
		emptyWith([personalList, { ...list, name: 'Trabajo' }]);
		expect(await listTasks(CONFIG, { list: 'Trabajo' })).toEqual([]);
	});

	it('una personal más dos compartidas homónimas no es ambiguo (gana la personal)', async () => {
		emptyWith([personalList, { ...list, name: 'Trabajo' }, shared2]);
		expect(await listTasks(CONFIG, { list: 'Trabajo' })).toEqual([]);
	});

	it('list vacío con una sola lista homónima no lanza error', async () => {
		vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url.includes('includeLists') ? { lists: [list] } : [])));
		expect(await listTasks(CONFIG, { list: 'Trabajo' })).toEqual([]);
	});

	it('el camino normal no consulta el catálogo', async () => {
		const fetch = vi.fn(async () => json([task])); vi.stubGlobal('fetch', fetch);
		expect(await listTasks(CONFIG, { list: 'Trabajo' })).toEqual([task]);
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});

describe('C5-g — asignación, altas y éxito parcial', () => {
	it.each([MEMBER, ''])('set_assignee traduce accountId=%s incluso en subtarea', (assigneeId) => {
		const op = { op: 'set_assignee' as const, taskId: TASK, assigneeId };
		expect(mutateTasksStrictOpSchema.safeParse(op).success).toBe(true);
		expect(collectExistenceCheckIds([op])).toEqual([TASK]);
		const result = buildBatchFromOps([op], new Map([[TASK, { ...task, parentId: LIST }]]));
		expect(result.skipped).toEqual([]);
		expect(result.batchOps).toEqual([{ type: 'mutate', taskId: TASK, kind: 'setAssignee', payload: { assigneeId } }]);
	});

	it.each([null, 'Ana', 'ana@example.test', TASK, MEMBER.toUpperCase(), 'a'.repeat(63)])('rechaza forma inválida de assigneeId=%s', (assigneeId) => {
		expect(mutateTasksStrictOpSchema.safeParse({ op: 'set_assignee', taskId: TASK, assigneeId }).success).toBe(false);
	});

	it('invalidez, op ajena y miembro desconocido conservan éxito parcial y autoridad del servidor', async () => {
		let sent: unknown;
		const fetch = vi.fn(async (url: string, init?: RequestInit) => {
			if (url.includes('/api/tasks')) return json([{ ...task, parentId: LIST }]);
			sent = JSON.parse(String(init?.body));
			return json({ ok: true, results: [{ index: 0, ok: true, id: TASK }, { index: 1, ok: false, error: 'not_found' }], materialization: [{ id: TASK, status: 'applied' }] });
		}); vi.stubGlobal('fetch', fetch);
		const result = await (await client()).callTool({ name: 'mutate_tasks', arguments: { ops: [
			{ op: 'set_assignee', taskId: TASK, assigneeId: MEMBER },
			{ op: 'set_assignee', taskId: TASK, assigneeId: null },
			{ op: 'delete', taskId: TASK },
			{ op: 'set_assignee', taskId: TASK, assigneeId: OTHER }
		] } });
		expect(text(result)).toContain('organize'); expect(text(result)).toContain('not_found');
		expect(sent).toEqual({ ops: [
			{ type: 'mutate', taskId: TASK, kind: 'setAssignee', payload: { assigneeId: MEMBER } },
			{ type: 'mutate', taskId: TASK, kind: 'setAssignee', payload: { assigneeId: OTHER } }
		] });
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it.each(['add_task', 'mutate_tasks'])('%s transporta assigneeId sin email ni veto local y conserva aviso', async (name) => {
		let body: unknown;
		vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
			body = JSON.parse(String(init?.body));
			return json(name === 'add_task' ? { ok: true, notices: ['asignado ignorado'] }
				: { ok: true, results: [{ index: 0, ok: true, id: TASK }], notices: ['asignado ignorado'] });
		}));
		const input = { text: 'Alta', listId: LIST, assigneeId: MEMBER };
		const result = await (await client()).callTool({ name, arguments: name === 'add_task' ? input : { ops: [{ op: 'add_task', ...input }] } });
		expect(result.isError).not.toBe(true); expect(text(result)).toContain('asignado ignorado');
		expect(body).toEqual(name === 'add_task' ? { ...input, literal: true } : { ops: [{ type: 'ingest', task: { ...input, literal: true } }] });
	});

	it('organize señala mutate_tasks para set_assignee ajena y no escribe', async () => {
		const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
		const result = await (await client()).callTool({ name: 'organize', arguments: { ops: [{ op: 'set_assignee', taskId: TASK, assigneeId: MEMBER }] } });
		expect(text(result)).toContain('mutate_tasks'); expect(fetch).not.toHaveBeenCalled();
	});
});

describe('C5-g — adjuntos y denegaciones de servidor', () => {
	it.each(['add_attachment', 'prepare_attachment_upload'])('%s envía store explícito para tarea compartida y conserva credencial', async (name) => {
		const fetch = vi.fn(async (url: string, init?: RequestInit) => {
			expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${CONFIG.token}`);
			if (url.includes('/api/tasks')) return json([task]);
			expect(new URL(url).searchParams.get('store')).toBe(SPACE);
			return name === 'add_attachment' ? json({ id: 'attachment', taskId: TASK, filename: 'a.txt', mime: 'text/plain', size: 1 })
				: json({ permit: 'test-permit', uploadUrl: `https://lumbre.test/api/attachments?store=${SPACE}`, expiresAt: '2026-10-29T11:00:00Z', maxBytes: 100 });
		}); vi.stubGlobal('fetch', fetch);
		const result = await (await client()).callTool({ name, arguments: { taskId: TASK, filename: 'a.txt', ...(name === 'add_attachment' ? { content_base64: 'eA==' } : {}) } });
		expect(result.isError).not.toBe(true); expect(fetch).toHaveBeenCalledTimes(2);
	});

	it('un lookup reciente en caché conserva el destino compartido del permiso', async () => {
		const fetch = vi.fn(async (url: string) => {
			if (new URL(url).searchParams.has('includeLists')) return json({ lists: [list], spaces: [space] });
			if (url.includes('/api/tasks')) return json([task]);
			expect(new URL(url).searchParams.get('store')).toBe(SPACE);
			return json({ permit: 'test-permit', uploadUrl: `https://lumbre.test/api/attachments?store=${SPACE}`, expiresAt: '2026-10-29T11:00:00Z', maxBytes: 100 });
		});
		vi.stubGlobal('fetch', fetch);
		const c = await client();
		await c.callTool({ name: 'get_task', arguments: { taskId: TASK } });
		const result = await c.callTool({ name: 'prepare_attachment_upload', arguments: { taskId: TASK, filename: 'a.txt' } });
		expect(result.isError).not.toBe(true); expect(fetch).toHaveBeenCalledTimes(3);
		expect(fetch.mock.calls.filter(([url]) => new URL(url).searchParams.has('id'))).toHaveLength(1);
	});

	it.each(['add_attachment', 'prepare_attachment_upload'])('%s propaga revocación al escribir, sin reintentar en personal', async (name) => {
		const fetch = vi.fn(async (url: string) => url.includes('/api/tasks') ? json([task])
			: json({ code: 'not_found', message: 'No encontrado' }, 404));
		vi.stubGlobal('fetch', fetch);
		const result = await (await client()).callTool({ name, arguments: { taskId: TASK, filename: 'a.txt', ...(name === 'add_attachment' ? { content_base64: 'eA==' } : {}) } });
		expect(result.isError).toBe(true); expect(fetch).toHaveBeenCalledTimes(2);
		expect(new URL(fetch.mock.calls[1]![0]).searchParams.get('store')).toBe(SPACE);
	});

	it.each(['list_tasks', 'list_lists', 'get_task', 'get_list', 'add_task'])('%s devuelve denegación sin reintento ni ampliación de credenciales', async (name) => {
		const fetch = vi.fn(async (_url: string, _init?: RequestInit) => json({ code: 'not_found', message: 'No encontrado' }, 404)); vi.stubGlobal('fetch', fetch);
		const args = name === 'get_task' ? { taskId: TASK } : name === 'get_list' ? { listId: LIST } : name === 'add_task' ? { text: 'Alta', listId: LIST } : {};
		const result = await (await client()).callTool({ name, arguments: args });
		expect(result.isError).toBe(true); expect(fetch).toHaveBeenCalledTimes(1);
		expect(String(fetch.mock.calls[0]![0])).not.toContain('/api/spaces');
		expect((fetch.mock.calls[0]![1]?.headers as Record<string, string>).authorization).toBe(`Bearer ${CONFIG.token}`);
	});
});
