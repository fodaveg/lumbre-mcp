/**
 * Respuestas GRABADAS con la forma exacta del servidor de Lumbre que el conector
 * contrasta en C5-g: `release/fase3-cand3` en `6dc35f62c` (30 oct 2026), lo que va
 * a producción con `LUMBRE_SPACES` apagado. Leídas campo a campo de:
 *
 * - `src/routes/api/tasks/serialize.ts` (`serializeTask`, `ApiSubtask`);
 * - `src/routes/api/tasks/store-fields.ts` (`taskStoreFields`: `storeId`, `spaceId`,
 *   `spaceName`, `inViewerToday`, `crossStoreDuplicate`; los tres primeros `null` en
 *   el personal; `spacesCatalog`: `{spaceId, name, role, members:[{accountId, name}]}`);
 * - `src/routes/api/tasks/include-lists.ts` (cada lista gana `isInbox` y la
 *   procedencia; la respuesta gana `spaces[]`, vacío en una cuenta sin espacios);
 * - `src/routes/api/tasks/+server.ts` (`?listId=` exacto con 404 «Lista no
 *   encontrada»; `?assignee=` NO existe: se ignora);
 * - `src/lib/server/route-helpers.ts` (`storeNotFound`: 404
 *   `{code:'not_found', message:'No encontrado'}` de las rutas con `?store=`);
 * - `src/lib/server/stores/resolve-target-store.ts` (`ASSIGNEE_REJECTED_ERROR`);
 * - `src/routes/api/batch/+server.ts` (resultado por op) y
 *   `src/lib/server/repos/mutations.ts` (`setAssignee` no admitido = `not_found`).
 *
 * Lo que ese servidor NO manda, y por eso falta aquí a propósito: `assigneeId` y
 * `assignedToMe` por tarea (el punto de extensión de `store-fields.ts` sigue sin
 * implementar), y `storeId`/`agentAccess` dentro de `spaces[]`.
 *
 * Sin imports: lo carga tal cual también un script de Node para comparar con el
 * `dist/` de una versión anterior.
 */

export const SERVER_SHA = '6dc35f62c79af17a401617fa8bd0ef79d95e4c52';

export const PERSONAL_LIST = '22222222-2222-4222-8222-222222222222';
export const PERSONAL_AREA = '66666666-6666-4666-8666-666666666666';
export const PERSONAL_INBOX = '77777777-7777-4777-8777-777777777777';
export const SHARED_LIST = '88888888-8888-4888-8888-888888888888';
export const SPACE_ID = '33333333-3333-4333-8333-333333333333';
export const MEMBER_ME = 'a1'.repeat(32);
export const MEMBER_OTHER = 'b2'.repeat(32);

/** Una tarea de `GET /api/tasks` ANTERIOR a C5 (sin campos de procedencia). */
export function preC5Task(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id,
		content: `Tarea ${id.slice(0, 4)}`,
		tags: [],
		effectiveTags: [],
		notes: null,
		notesUpdatedAt: null,
		updatedAt: '2026-10-30T10:00:00.000Z',
		done: false,
		cancelledAt: null,
		archivedAt: null,
		withdrawn: false,
		waitingUntil: null,
		waitingFor: null,
		priority: null,
		date: '2026-10-30',
		someday: false,
		time: null,
		deadline: null,
		list: null,
		somedayListId: null,
		section: null,
		sectionId: null,
		parentId: null,
		parentContent: null,
		recurrence: null,
		seriesId: null,
		createdAt: '2026-10-29T10:00:00.000Z',
		rolloverCount: 0,
		attachments: [],
		...over
	};
}

/** La misma tarea servida por `6dc35f62c` en el store PERSONAL (`taskStoreFields`). */
export function personalTask(
	pre: Record<string, unknown>,
	inViewerToday = true
): Record<string, unknown> {
	return {
		...pre,
		storeId: null,
		spaceId: null,
		spaceName: null,
		inViewerToday,
		crossStoreDuplicate: false
	};
}

/** Una tarea de un espacio compartido: `storeId` y `spaceId` son el mismo uuid. */
export function sharedTask(
	pre: Record<string, unknown>,
	over: Record<string, unknown> = {}
): Record<string, unknown> {
	return {
		...pre,
		storeId: SPACE_ID,
		spaceId: SPACE_ID,
		spaceName: 'Socios',
		inViewerToday: false,
		crossStoreDuplicate: false,
		...over
	};
}

/** Tareas personales de muestra: sin lista, con lista y sección, y con lista sin sección. */
export const PRE_C5_TASKS = [
	preC5Task('aaaa1111-0000-4000-8000-000000000001', {
		list: 'Trabajo',
		somedayListId: PERSONAL_LIST,
		section: 'S1',
		sectionId: '99999999-9999-4999-8999-000000000001',
		priority: 2
	}),
	preC5Task('bbbb1111-0000-4000-8000-000000000002'),
	preC5Task('cccc1111-0000-4000-8000-000000000003', {
		list: 'Trabajo',
		somedayListId: PERSONAL_LIST,
		tags: ['casa'],
		effectiveTags: ['casa']
	})
];

/** Una lista de `?includeLists=1` ANTERIOR a C5. */
export function preC5List(over: Record<string, unknown>): Record<string, unknown> {
	return {
		id: PERSONAL_LIST,
		name: 'Trabajo',
		tags: [],
		effectiveTags: [],
		icon: null,
		color: null,
		parentListId: null,
		pinned: false,
		kind: 'project',
		date: null,
		someday: false,
		deadline: null,
		closure: null,
		notes: null,
		taskCount: 2,
		...over
	};
}

export const PRE_C5_LISTS = [
	preC5List({}),
	preC5List({ id: PERSONAL_AREA, name: 'Casa', kind: 'area', parentListId: PERSONAL_LIST, taskCount: 0 }),
	preC5List({ id: PERSONAL_INBOX, name: 'Bandeja', taskCount: 1 })
];

/** La misma lista servida por `6dc35f62c` (`includeListsBody`, store personal). */
export function personalList(pre: Record<string, unknown>): Record<string, unknown> {
	return {
		...pre,
		isInbox: pre.id === PERSONAL_INBOX,
		storeId: null,
		spaceId: null,
		spaceName: null
	};
}

/** `spaces[]` de `spacesCatalog` para un agente con `agentAccess` en «Socios». */
export const SPACES_CATALOG = [
	{
		spaceId: SPACE_ID,
		name: 'Socios',
		role: 'editor',
		members: [
			{ accountId: MEMBER_ME, name: 'David' },
			{ accountId: MEMBER_OTHER, name: 'Lucía' }
		]
	}
];

export const SHARED_LIST_SUMMARY = {
	...preC5List({ id: SHARED_LIST, name: 'Compras', taskCount: 1 }),
	isInbox: false,
	storeId: SPACE_ID,
	spaceId: SPACE_ID,
	spaceName: 'Socios'
};

/** `ASSIGNEE_REJECTED_ERROR` de `resolve-target-store.ts`. */
export const ASSIGNEE_REJECTED_ERROR =
	'assigneeId no válido: tiene que ser un miembro activo del espacio de la lista';

/** `storeNotFound()` de `route-helpers.ts`: rutas con `?store=` ajeno o sin acceso. */
export const STORE_NOT_FOUND_BODY = { code: 'not_found', message: 'No encontrado' };

/** Cuerpo del 404 de `?listId=` (SvelteKit `error(404, …)` negociado como JSON). */
export const LIST_NOT_FOUND_BODY = { message: 'Lista no encontrada' };

/** Una petición que recibió el servidor falso. */
export interface FakeCall {
	method: string;
	path: string;
	params: URLSearchParams;
	body: unknown;
}

/**
 * Servidor falso de `GET /api/tasks` con la semántica de `6dc35f62c` sobre unos datos
 * fijos: `?notes=` (`none`/`length`/`full`), `?id=`/`?ids=`, `?list=` por nombre exacto,
 * `?listId=` exacto con 404, `?includeLists=1` (con `?listId=`) y `?assignee=`
 * IGNORADO. Las escrituras responden lo que diga `write`. Sirve igual para las formas
 * anteriores a C5 (sin `spaces`): basta con pasarle tareas y listas de antes.
 */
export function fakeLumbre(data: {
	tasks: Record<string, unknown>[];
	lists: Record<string, unknown>[];
	spaces?: unknown[];
	write?: (call: FakeCall) => { status: number; body: unknown };
}) {
	const calls: FakeCall[] = [];
	const reply = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
	const withNotes = (row: Record<string, unknown>, mode: string | null) => {
		if (mode === 'none') return { ...row, notes: null };
		if (mode !== 'length') return row;
		const text = typeof row.notes === 'string' ? row.notes.trim() : null;
		return { ...row, notes: null, notesLength: text ? text.length : null };
	};
	const fetch = async (input: string | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		const method = init?.method ?? 'GET';
		const body = typeof init?.body === 'string' ? JSON.parse(init.body) : (init?.body ?? null);
		const call = { method, path: url.pathname, params: url.searchParams, body };
		calls.push(call);
		if (method !== 'GET' || url.pathname !== '/api/tasks') {
			const out = data.write?.(call) ?? { status: 200, body: { ok: true } };
			return reply(out.body, out.status);
		}
		const p = url.searchParams;
		const notes = p.get('notes');
		const listId = p.get('listId');
		if (p.get('includeLists') === '1') {
			const lists = listId ? data.lists.filter((l) => l.id === listId) : data.lists;
			if (listId && !lists.length) return reply(LIST_NOT_FOUND_BODY, 404);
			return reply({
				lists: lists.map((l) => withNotes(l, notes)),
				...(data.spaces ? { spaces: data.spaces } : {})
			});
		}
		const id = p.get('id');
		const ids = p.get('ids')?.split(',');
		let rows = data.tasks;
		if (id) rows = rows.filter((t) => t.id === id);
		else if (ids) rows = rows.filter((t) => ids.includes(t.id as string));
		else if (listId) {
			if (!data.lists.some((l) => l.id === listId)) return reply(LIST_NOT_FOUND_BODY, 404);
			rows = rows.filter((t) => t.somedayListId === listId);
		} else if (p.get('list')) {
			const wanted = p.get('list')!.trim().toLowerCase();
			const match = data.lists.filter((l) => String(l.name).trim().toLowerCase() === wanted);
			if (match.length !== 1) return reply([]);
			rows = rows.filter((t) => t.somedayListId === match[0]!.id);
		}
		return reply(rows.map((t) => withNotes(t, notes)));
	};
	return { fetch, calls };
}
