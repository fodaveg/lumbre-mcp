import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, stripToolsListSchema } from './index.js';
import { resetExistenceCacheRegistryForTests } from './existence-cache.js';
import {
	getListCatalog,
	getOrganizationsDirectory,
	listTasks,
	type LumbreSpace,
	type LumbreTask
} from './lumbre-client.js';
import { renderRefs, resolveRefs } from './refs.js';

/**
 * Lectura por espacio con organizaciones (`docs/81` §4.7 y `docs/80` §8g.3 del
 * repo principal): sin `spaceId` un agente solo ve Personal; con él, el servidor
 * lee ese espacio y el MCP falla cerrado si una fila es de otro destino. Más
 * `list_organizations`, el directorio de solo lectura, contra un doble de la forma
 * acordada de `GET /api/organizations/directory`.
 */

const CONFIG = { baseUrl: 'https://lumbre.test', token: 'org-test-token' };
const SPACE_A = '33333333-3333-4333-8333-333333333333';
const SPACE_B = '44444444-4444-4444-8444-444444444444';
const LIST_A = '22222222-2222-4222-8222-222222222222';
const LIST_B = '55555555-5555-4555-8555-555555555555';
const TASK_A = '11111111-1111-4111-8111-111111111111';
const ME_IN_A = 'a1'.repeat(32);
const ME_IN_B = 'c3'.repeat(32);
const OTHER = 'b2'.repeat(32);

const spaceA: LumbreSpace = { spaceId: SPACE_A, name: 'Socios', members: [{ accountId: ME_IN_A, name: 'Ana' }] };
const spaceB: LumbreSpace = { spaceId: SPACE_B, name: 'Casa', members: [{ accountId: ME_IN_B, name: 'Ana' }] };

function task(overrides: Partial<LumbreTask> = {}): LumbreTask {
	return {
		id: TASK_A,
		content: 'Preparar informe',
		notes: null,
		createdAt: '2026-11-04T10:00:00Z',
		done: false,
		priority: null,
		date: null,
		deadline: null,
		list: 'Compras',
		somedayListId: LIST_A,
		parentId: null,
		storeId: SPACE_A,
		spaceId: SPACE_A,
		assigneeId: ME_IN_A,
		assignedToMe: true,
		...overrides
	};
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Un doble de `fetch` que enruta por ruta y devuelve lo que `handler` decida. */
function stubFetch(handler: (url: URL) => Response) {
	const spy = vi.fn(async (url: string) => handler(new URL(url)));
	vi.stubGlobal('fetch', spy);
	return spy;
}

const clients: Client[] = [];
const servers: ReturnType<typeof createServer>[] = [];
async function client() {
	const server = createServer(CONFIG, { localFilesystem: false });
	const [a, b] = InMemoryTransport.createLinkedPair();
	stripToolsListSchema(b);
	await server.connect(b);
	const c = new Client({ name: 'org-test', version: '1' });
	await c.connect(a);
	clients.push(c);
	servers.push(server);
	return c;
}
function text(result: unknown): string {
	return (result as { content: { text?: string }[] }).content.map((c) => c.text ?? '').join('\n');
}

beforeEach(() => resetExistenceCacheRegistryForTests());
afterEach(async () => {
	await Promise.all([...clients.splice(0).map((c) => c.close()), ...servers.splice(0).map((s) => s.close())]);
	vi.unstubAllGlobals();
});

describe('list_tasks con spaceId', () => {
	it('reenvía spaceId al servidor; sin él no manda ninguno (Personal)', async () => {
		const spy = stubFetch(() => json([task()]));
		await listTasks(CONFIG, { spaceId: SPACE_A, scope: 'all' });
		expect(new URL(spy.mock.calls[0]![0]).searchParams.get('spaceId')).toBe(SPACE_A);

		const personal = stubFetch(() => json([task({ spaceId: null, storeId: undefined })]));
		await listTasks(CONFIG, { scope: 'all' });
		expect(new URL(personal.mock.calls[0]![0]).searchParams.has('spaceId')).toBe(false);
	});

	it('la herramienta acepta spaceId y lo manda en la petición', async () => {
		const spy = stubFetch((url) => (url.searchParams.has('includeLists') ? json({ lists: [], spaces: [spaceA] }) : json([task()])));
		const result = await (await client()).callTool({ name: 'list_tasks', arguments: { spaceId: SPACE_A, notes: 'none' } });
		expect(result.isError).not.toBe(true);
		expect(text(result)).toContain('Preparar informe');
		expect(new URL(spy.mock.calls[0]![0]).searchParams.get('spaceId')).toBe(SPACE_A);
	});

	it('rechaza un spaceId que no es uuid antes de llamar al servidor', async () => {
		const spy = stubFetch(() => json([]));
		const result = await (await client()).callTool({ name: 'list_tasks', arguments: { spaceId: 'socios' } });
		expect(result.isError).toBe(true);
		expect(spy).not.toHaveBeenCalled();
	});

	it('falla cerrado si una fila es de otro espacio', async () => {
		stubFetch(() => json([task(), task({ id: 'x2', spaceId: SPACE_B, storeId: SPACE_B })]));
		await expect(listTasks(CONFIG, { spaceId: SPACE_A })).rejects.toThrow(/1 de 2 tareas que no son del espacio/);
	});

	it('falla cerrado si una fila es de Personal o no trae procedencia (servidor que ignoró spaceId)', async () => {
		stubFetch(() => json([task({ spaceId: null })]));
		await expect(listTasks(CONFIG, { spaceId: SPACE_A })).rejects.toThrow(/no son del espacio/);
		stubFetch(() => json([task({ spaceId: undefined })]));
		await expect(listTasks(CONFIG, { spaceId: SPACE_A })).rejects.toThrow(/no son del espacio/);
	});

	it('vacío: se acepta solo si el catálogo autorizado confirma el espacio', async () => {
		const spy = stubFetch((url) => (url.searchParams.has('includeLists') ? json({ lists: [], spaces: [spaceA] }) : json([])));
		await expect(listTasks(CONFIG, { spaceId: SPACE_A })).resolves.toEqual([]);
		expect(spy.mock.calls.some((c) => new URL(c[0]).searchParams.get('spaceId') === SPACE_A && new URL(c[0]).searchParams.has('includeLists'))).toBe(true);

		stubFetch((url) => (url.searchParams.has('includeLists') ? json({ lists: [] }) : json([])));
		await expect(listTasks(CONFIG, { spaceId: SPACE_A })).rejects.toThrow(/no confirmó el espacio/);
		stubFetch((url) => (url.searchParams.has('includeLists') ? json({ lists: [], spaces: [spaceB] }) : json([])));
		await expect(listTasks(CONFIG, { spaceId: SPACE_A })).rejects.toThrow(/no confirmó el espacio/);
	});

	it('un 404 «espacio no accesible» se traduce a un error claro con el siguiente paso', async () => {
		stubFetch(() => json({ message: 'espacio no accesible' }, 404));
		const error = await listTasks(CONFIG, { spaceId: SPACE_A }).catch((e: Error) => e);
		expect((error as Error).message).toMatch(/no es legible para esta credencial/);
		expect((error as Error).message).toContain('list_organizations');
	});

	it('con spaceId el nombre de lista se resuelve en ese espacio: no hay diagnóstico de ambigüedad', async () => {
		const spy = stubFetch((url) =>
			url.searchParams.has('includeLists') ? json({ lists: [], spaces: [spaceA] }) : json([])
		);
		await expect(listTasks(CONFIG, { spaceId: SPACE_A, list: 'Compras' })).resolves.toEqual([]);
		// Solo la confirmación del espacio vacío, no el catálogo de nombres sin destino.
		for (const call of spy.mock.calls) {
			const url = new URL(call[0]);
			if (url.searchParams.has('includeLists')) expect(url.searchParams.get('spaceId')).toBe(SPACE_A);
		}
	});
});

describe('assignee="me" por espacio', () => {
	it('cada espacio usa el accountId de la persona en ESE espacio, sin uno global', async () => {
		for (const [space, me] of [[spaceA, ME_IN_A], [spaceB, ME_IN_B]] as const) {
			const spy = stubFetch((url) =>
				url.searchParams.has('includeLists')
					? json({ lists: [], spaces: [spaceA, spaceB] })
					: json([task({ spaceId: space.spaceId, storeId: space.spaceId, assigneeId: me })])
			);
			const rows = await listTasks(CONFIG, { spaceId: space.spaceId, assignee: 'me' });
			expect(rows).toHaveLength(1);
			const params = new URL(spy.mock.calls[0]![0]).searchParams;
			expect(params.get('assignee')).toBe('me');
			expect(params.get('spaceId')).toBe(space.spaceId);
		}
	});

	it('la cuenta de otro espacio no vale como «yo» en este', async () => {
		stubFetch((url) =>
			url.searchParams.has('includeLists')
				? json({ lists: [], spaces: [spaceA, spaceB] })
				: json([task({ assigneeId: ME_IN_B })])
		);
		await expect(listTasks(CONFIG, { spaceId: SPACE_A, assignee: 'me' })).rejects.toThrow(/no es miembro del espacio/);
	});

	it('una tarea sin asignado no se presenta como asignada a mí', async () => {
		stubFetch((url) =>
			url.searchParams.has('includeLists')
				? json({ lists: [], spaces: [spaceA] })
				: json([task({ assigneeId: null, assignedToMe: true })])
		);
		await expect(listTasks(CONFIG, { spaceId: SPACE_A, assignee: 'me' })).rejects.toThrow(/no es miembro/);
	});

	it('un asignado que no es miembro del catálogo falla aunque venga assignedToMe', async () => {
		stubFetch((url) =>
			url.searchParams.has('includeLists')
				? json({ lists: [], spaces: [spaceA] })
				: json([task({ assigneeId: OTHER })])
		);
		await expect(listTasks(CONFIG, { spaceId: SPACE_A, assignee: 'me' })).rejects.toThrow(/no es miembro/);
	});
});

describe('list_lists con spaceId', () => {
	const listIn = (id: string, spaceId: string | null, name = 'Compras') => ({
		id, name, taskCount: 1, ...(spaceId ? { spaceId, storeId: spaceId } : {})
	});

	it('manda spaceId al catálogo y pinta solo las listas de ese espacio', async () => {
		const spy = stubFetch(() => json({ lists: [listIn(LIST_A, SPACE_A)], spaces: [spaceA] }));
		const result = await (await client()).callTool({ name: 'list_lists', arguments: { spaceId: SPACE_A } });
		expect(result.isError).not.toBe(true);
		expect(text(result)).toContain(LIST_A);
		const params = new URL(spy.mock.calls[0]![0]).searchParams;
		expect(params.get('spaceId')).toBe(SPACE_A);
		expect(params.get('includeLists')).toBe('1');
	});

	it('sin spaceId no manda ninguno', async () => {
		const spy = stubFetch(() => json({ lists: [listIn(LIST_A, null)] }));
		await (await client()).callTool({ name: 'list_lists', arguments: {} });
		expect(new URL(spy.mock.calls[0]![0]).searchParams.has('spaceId')).toBe(false);
	});

	it('falla cerrado si una lista es de otro destino', async () => {
		stubFetch(() => json({ lists: [listIn(LIST_A, SPACE_A), listIn(LIST_B, SPACE_B)], spaces: [spaceA, spaceB] }));
		const result = await (await client()).callTool({ name: 'list_lists', arguments: { spaceId: SPACE_A } });
		expect(result.isError).toBe(true);
		expect(text(result)).toMatch(/no son del espacio/);
		expect(text(result)).not.toContain(LIST_B);
	});

	it('dos espacios con una lista del mismo nombre no se confunden: cada lectura trae solo la suya', async () => {
		stubFetch((url) =>
			url.searchParams.get('spaceId') === SPACE_A
				? json({ lists: [listIn(LIST_A, SPACE_A)], spaces: [spaceA] })
				: json({ lists: [listIn(LIST_B, SPACE_B)], spaces: [spaceB] })
		);
		const a = await getListCatalog(CONFIG, { spaceId: SPACE_A });
		const b = await getListCatalog(CONFIG, { spaceId: SPACE_B });
		expect(a.lists.map((l) => l.id)).toEqual([LIST_A]);
		expect(b.lists.map((l) => l.id)).toEqual([LIST_B]);
	});
});

describe('referencias con destino por espacio', () => {
	const ref = (id: string) => `[[list:${id}|Compras]]`;

	it('el catálogo se pide con el spaceId de la lectura', async () => {
		const spy = stubFetch(() =>
			json({ lists: [{ id: LIST_A, name: 'Compras', taskCount: 1, spaceId: SPACE_A, storeId: SPACE_A }], spaces: [spaceA] })
		);
		const resolution = await resolveRefs(CONFIG, [ref(LIST_A)], { spaceId: SPACE_A });
		expect(new URL(spy.mock.calls[0]![0]).searchParams.get('spaceId')).toBe(SPACE_A);
		expect(spy).toHaveBeenCalledTimes(1);
		expect(renderRefs(ref(LIST_A), resolution)).toContain(`id:${LIST_A}`);
	});

	it('una referencia a una lista de OTRO espacio no se da por rota: se resuelve por su id y conserva su procedencia', async () => {
		const spy = stubFetch((url) => {
			if (url.searchParams.get('listId') === LIST_B) {
				return json({
					lists: [{ id: LIST_B, name: 'Compras', taskCount: 2, spaceId: SPACE_B, storeId: SPACE_B }],
					spaces: [spaceB]
				});
			}
			return json({ lists: [{ id: LIST_A, name: 'Compras', taskCount: 1, spaceId: SPACE_A, storeId: SPACE_A }], spaces: [spaceA] });
		});
		const text2 = `${ref(LIST_A)} ${ref(LIST_B)}`;
		const resolution = await resolveRefs(CONFIG, [text2], { spaceId: SPACE_A });
		expect(spy).toHaveBeenCalledTimes(2);
		const out = renderRefs(text2, resolution);
		// Mismo nombre, dos destinos: cada id lleva el suyo.
		expect(out).toContain(`espacio:"Socios" (spaceId:${SPACE_A}) id:${LIST_A}`);
		expect(out).toContain(`espacio:"Casa" (spaceId:${SPACE_B}) id:${LIST_B}`);
		expect(out).not.toContain('ROTO');
	});

	it('si la consulta por id falla, la referencia queda sin resolver, nunca rota', async () => {
		stubFetch((url) => (url.searchParams.has('listId') ? new Response('boom', { status: 500 }) : json({ lists: [] })));
		const resolution = await resolveRefs(CONFIG, [ref(LIST_B)], { spaceId: SPACE_A });
		expect(renderRefs(ref(LIST_B), resolution)).toBe(`→proyecto/área[sin resolver] id:${LIST_B}`);
	});
});

describe('list_organizations', () => {
	const directory = {
		organizations: [
			{
				orgId: 'org-1',
				name: 'Sumego SL',
				members: [
					{ accountId: ME_IN_A, role: 'owner', name: 'Ana' },
					{ accountId: OTHER, role: 'member', name: null }
				],
				spaces: [
					{ spaceId: SPACE_A, name: 'Socios', granted: true },
					{ spaceId: SPACE_B, name: null, granted: false }
				]
			}
		],
		spaces: [{ spaceId: LIST_B, name: null, granted: false }]
	};

	it('llama a GET /api/organizations/directory y pinta organizaciones, miembros y espacios con granted', async () => {
		const spy = stubFetch(() => json(directory));
		const result = await (await client()).callTool({ name: 'list_organizations', arguments: {} });
		expect(result.isError).not.toBe(true);
		expect(new URL(spy.mock.calls[0]![0]).pathname).toBe('/api/organizations/directory');
		const out = text(result);
		for (const expected of [
			'Sumego SL', 'org-1', 'Ana', 'owner', ME_IN_A, '(sin nombre)',
			`Socios (spaceId: ${SPACE_A}) — contenido legible`,
			'sin permiso para agentes',
			'Espacios sin organización (1)',
			'Sin spaceId, list_tasks y list_lists solo leen Personal.'
		]) expect(out).toContain(expected);
	});

	it('sin organizaciones ni espacios lo dice', async () => {
		stubFetch(() => json({ organizations: [], spaces: [] }));
		expect(text(await (await client()).callTool({ name: 'list_organizations', arguments: {} }))).toContain('Solo hay Personal');
	});

	it('404 = función apagada o servidor anterior, con mensaje claro', async () => {
		stubFetch(() => new Response('<html>404</html>', { status: 404, headers: { 'content-type': 'text/html' } }));
		const result = await (await client()).callTool({ name: 'list_organizations', arguments: {} });
		expect(result.isError).toBe(true);
		expect(text(result)).toMatch(/no ofrece el directorio de organizaciones/);
		expect(text(result)).toMatch(/apagadas|versión anterior/);
	});

	it('503 = Sumego no responde, con mensaje claro y sin copia local', async () => {
		stubFetch(() => json({ error: 'relay_unavailable' }, 503));
		const result = await (await client()).callTool({ name: 'list_organizations', arguments: {} });
		expect(result.isError).toBe(true);
		expect(text(result)).toMatch(/no está disponible ahora/);
	});

	it('una respuesta fuera de contrato falla cerrado', async () => {
		stubFetch(() => json({ organizations: [{ orgId: 'x' }], spaces: [] }));
		await expect(getOrganizationsDirectory(CONFIG)).rejects.toThrow(/respuesta inesperada/);
		stubFetch(() => json({ organizations: [], spaces: [{ spaceId: SPACE_A, name: 'x', granted: 'sí' }] }));
		await expect(getOrganizationsDirectory(CONFIG)).rejects.toThrow(/respuesta inesperada/);
	});

	it('es de solo lectura y no recibe parámetros', async () => {
		const c = await client();
		const tool = (await c.listTools()).tools.find((t) => t.name === 'list_organizations')!;
		expect(tool.annotations?.readOnlyHint).toBe(true);
		expect(Object.keys((tool.inputSchema as { properties?: object }).properties ?? {})).toEqual([]);
	});
});
