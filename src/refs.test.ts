import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	collectRefIds,
	emptyRefResolution,
	MAX_REF_IDS,
	refCounts,
	renderRefs,
	resolveRefs,
	type RefResolution
} from './refs.js';
import { formatTaskFull, formatTaskList } from './format.js';
import type { LumbreConfig, LumbreTask } from './lumbre-client.js';

/**
 * Referencias EN VIVO (`refs.ts`): el MCP reenviaba la etiqueta CONGELADA de
 * `[[task:ID|Etiqueta]]`, así que una tarea renombrada, completada o borrada
 * seguía leyéndose con su texto viejo — y una referencia rota era
 * indistinguible de una viva. Estos tests fijan las tres promesas: gana el
 * título ACTUAL, una rota se DECLARA rota con su id, y el coste en peticiones
 * (una `?ids=` para todas las tareas, una `?includeLists=1` solo si hay
 * referencias a listas, CERO si no hay ninguna referencia).
 */

const config: LumbreConfig = { baseUrl: 'https://lumbre.test', token: 'tok-123' };

const ID_A = '11111111-1111-1111-1111-111111111111';
const ID_B = '22222222-2222-2222-2222-222222222222';
const ID_C = '33333333-3333-3333-3333-333333333333';
const LIST_ID = 'aaaaaaaa-1111-2222-3333-444444444444';

function task(overrides: Partial<LumbreTask> = {}): LumbreTask {
	return {
		id: ID_A,
		content: 'Título ACTUAL',
		notes: null,
		done: false,
		priority: null,
		date: null,
		deadline: null,
		list: null,
		createdAt: '2026-07-20T09:00:00.000Z',
		parentId: null,
		...overrides
	};
}

/** Resolución ya hecha (sin red), para los tests de render puro. */
function resolutionOf(
	tasks: LumbreTask[],
	opts: { lists?: { id: string; name: string }[]; refTaskIds?: string[]; refListIds?: string[] } = {}
): RefResolution {
	const resolution = emptyRefResolution();
	for (const t of tasks) {
		resolution.tasks.set(t.id, t);
		resolution.checkedTasks.add(t.id);
	}
	for (const l of opts.lists ?? []) {
		resolution.lists.set(l.id, l.name);
		resolution.checkedLists.add(l.id);
	}
	resolution.refTaskIds = opts.refTaskIds ?? tasks.map((t) => t.id);
	resolution.refListIds = opts.refListIds ?? (opts.lists ?? []).map((l) => l.id);
	return resolution;
}

/** `fetch` que responde, en orden, los cuerpos JSON que se le den. */
function mockFetchSequence(bodies: unknown[]) {
	const spy = vi.fn();
	for (const body of bodies) {
		spy.mockResolvedValueOnce(
			new Response(JSON.stringify(body), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
		);
	}
	vi.stubGlobal('fetch', spy);
	return spy;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('collectRefIds', () => {
	it('texto sin referencias (ni null/vacíos): no aporta ningún id', () => {
		expect(collectRefIds(['nada que ver', null, undefined, ''])).toEqual({
			taskIds: [],
			listIds: []
		});
	});

	it('VARIAS referencias en la MISMA nota, de los dos tipos, deduplicadas', () => {
		const nota = `Depende de [[task:${ID_A}|Vieja]] y de [[task:${ID_B}|Otra]].\n` +
			`Repetida: [[task:${ID_A}|Vieja]]. Contexto en [[list:${LIST_ID}|Proyecto]].`;
		expect(collectRefIds([nota])).toEqual({ taskIds: [ID_A, ID_B], listIds: [LIST_ID] });
	});

	it('un id no es una referencia si el token está mal formado (sin `|`, con salto de línea)', () => {
		expect(collectRefIds([`[[task:${ID_A}]] [[task:${ID_B}|salto\nde línea]]`])).toEqual({
			taskIds: [],
			listIds: []
		});
	});
});

describe('resolveRefs — coste en peticiones', () => {
	it('SIN referencias: cero llamadas extra', async () => {
		const spy = vi.fn();
		vi.stubGlobal('fetch', spy);
		const resolution = await resolveRefs(config, ['tarea normal', 'otra nota sin enlaces']);
		expect(spy).not.toHaveBeenCalled();
		expect(refCounts(resolution).total).toBe(0);
	});

	it('N referencias a TAREAS: UNA sola `?ids=` con todos los ids de golpe', async () => {
		const spy = mockFetchSequence([[task({ id: ID_A }), task({ id: ID_B, content: 'B' })]]);
		await resolveRefs(config, [`[[task:${ID_A}|x]] [[task:${ID_B}|y]] [[task:${ID_A}|x]]`]);
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0][0]).toBe(`https://lumbre.test/api/tasks?ids=${ID_A}%2C${ID_B}`);
	});

	it('includeArchived se propaga a `?ids=` para no declarar rota una referencia archivada', async () => {
		const archived = task({
			id: ID_B,
			content: 'Dependencia archivada ACTUAL',
			archivedAt: '2026-08-27T10:00:00.000Z'
		});
		const spy = mockFetchSequence([[archived]]);
		const resolution = await resolveRefs(config, [`[[task:${ID_B}|Etiqueta vieja]]`], {
			includeArchived: true
		});

		expect(spy.mock.calls[0][0]).toBe(
			`https://lumbre.test/api/tasks?ids=${ID_B}&includeArchived=true`
		);
		expect(renderRefs(`[[task:${ID_B}|Etiqueta vieja]]`, resolution)).toBe(
			`→tarea[pendiente] "Dependencia archivada ACTUAL" id:${ID_B}`
		);
	});

	it('referencias a LISTAS: una `?includeLists=1` (peor caso del lote = 2 llamadas)', async () => {
		const spy = mockFetchSequence([
			[task({ id: ID_A })],
			{ lists: [{ id: LIST_ID, name: 'Proyecto ACTUAL', taskCount: 3 }] }
		]);
		const resolution = await resolveRefs(config, [
			`[[task:${ID_A}|x]] y [[list:${LIST_ID}|Nombre viejo]]`
		]);
		expect(spy).toHaveBeenCalledTimes(2);
		expect(spy.mock.calls[1][0]).toBe('https://lumbre.test/api/tasks?includeLists=1');
		expect(resolution.lists.get(LIST_ID)).toBe('Proyecto ACTUAL');
	});

	it('solo referencias a listas: NO se pide `?ids=`', async () => {
		const spy = mockFetchSequence([{ lists: [] }]);
		await resolveRefs(config, [`[[list:${LIST_ID}|x]]`]);
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0][0]).toBe('https://lumbre.test/api/tasks?includeLists=1');
	});

	it('TOPE de ids: pide como mucho MAX_REF_IDS y los que sobran quedan SIN RESOLVER (nunca "rotos")', async () => {
		const ids = Array.from(
			{ length: MAX_REF_IDS + 3 },
			(_, i) => `${String(i).padStart(8, '0')}-1111-2222-3333-444444444444`
		);
		const spy = mockFetchSequence([[]]);
		const nota = ids.map((id) => `[[task:${id}|etiqueta]]`).join(' ');
		const resolution = await resolveRefs(config, [nota]);

		expect(spy).toHaveBeenCalledTimes(1);
		const askedIds = new URL(spy.mock.calls[0][0] as string).searchParams.get('ids')!.split(',');
		expect(askedIds).toHaveLength(MAX_REF_IDS);

		const sobrante = ids[MAX_REF_IDS + 1];
		expect(renderRefs(`[[task:${sobrante}|etiqueta]]`, resolution)).toBe(
			`→tarea[sin resolver] id:${sobrante}`
		);
		// El que SÍ se preguntó y no vino en la respuesta sí está roto de verdad.
		expect(renderRefs(`[[task:${ids[0]}|etiqueta]]`, resolution)).toBe(`→tarea[ROTA] id:${ids[0]}`);
	});

	it('un id que no es uuid no se manda (un solo elemento inválido daría 400 para TODO el lote)', async () => {
		const spy = mockFetchSequence([[task({ id: ID_A })]]);
		const resolution = await resolveRefs(config, [`[[task:${ID_A}|ok]] [[task:no-es-uuid|raro]]`]);
		expect(spy.mock.calls[0][0]).toBe(`https://lumbre.test/api/tasks?ids=${ID_A}`);
		expect(renderRefs(`[[task:no-es-uuid|raro]]`, resolution)).toBe('→tarea[sin resolver] id:no-es-uuid');
	});

	it('si la petición falla, NO se propaga el error: todo queda "sin resolver", nunca "roto"', async () => {
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('red caída')));
		const resolution = await resolveRefs(config, [`[[task:${ID_A}|Etiqueta vieja]]`]);
		expect(renderRefs(`[[task:${ID_A}|Etiqueta vieja]]`, resolution)).toBe(
			`→tarea[sin resolver] id:${ID_A}`
		);
	});
});

describe('renderRefs — una referencia resuelta enseña el estado REAL', () => {
	it('VIVA y pendiente: título actual + estado + id', () => {
		const resolution = resolutionOf([task({ content: 'Comprar leche' })]);
		expect(renderRefs(`Ver [[task:${ID_A}|Comprar leche]].`, resolution)).toBe(
			`Ver →tarea[pendiente] "Comprar leche" id:${ID_A}.`
		);
	});

	it('RENOMBRADA (la etiqueta guardada difiere): gana el título ACTUAL, la etiqueta no se pinta', () => {
		const resolution = resolutionOf([task({ content: 'Título NUEVO' })]);
		const out = renderRefs(`[[task:${ID_A}|Título VIEJO]]`, resolution);
		expect(out).toBe(`→tarea[pendiente] "Título NUEVO" id:${ID_A}`);
		expect(out).not.toContain('VIEJO');
	});

	it('HECHA: se lee "hecha", no como una tarea pendiente cualquiera', () => {
		const resolution = resolutionOf([task({ done: true })]);
		expect(renderRefs(`[[task:${ID_A}|x]]`, resolution)).toBe(
			`→tarea[hecha] "Título ACTUAL" id:${ID_A}`
		);
	});

	it('CANCELADA: se distingue de "hecha" (en cuanto la API exponga `cancelled`)', () => {
		const resolution = resolutionOf([task({ done: true, cancelled: true })]);
		expect(renderRefs(`[[task:${ID_A}|x]]`, resolution)).toBe(
			`→tarea[cancelada] "Título ACTUAL" id:${ID_A}`
		);
	});

	it('ROTA: se DECLARA rota con su id, sin la etiqueta caducada (el caso peligroso)', () => {
		const resolution = emptyRefResolution();
		resolution.checkedTasks.add(ID_A);
		resolution.refTaskIds = [ID_A];
		const out = renderRefs(`Depende de [[task:${ID_A}|Tarea que ya no existe]].`, resolution);
		expect(out).toBe(`Depende de →tarea[ROTA] id:${ID_A}.`);
		expect(out).not.toContain('ya no existe');
	});

	it('con NOTA: anuncia el marcador ✎N ↻fecha (hay contexto que traerse con get_task)', () => {
		const resolution = resolutionOf([
			task({ notes: 'x'.repeat(573), notesUpdatedAt: '2026-07-24T10:00:00.000Z' })
		]);
		expect(renderRefs(`[[task:${ID_A}|x]]`, resolution)).toBe(
			`→tarea[pendiente] "Título ACTUAL" ✎573 ↻24jul id:${ID_A}`
		);
	});

	it('sin nota: NINGÚN marcador (el título ya lo dice todo)', () => {
		const resolution = resolutionOf([task({ notes: '   ' })]);
		expect(renderRefs(`[[task:${ID_A}|x]]`, resolution)).not.toContain('✎');
	});

	it('NUNCA vuelca la nota de la tarea referenciada (sería recursivo y hay ciclos posibles)', () => {
		const a = task({ id: ID_A, content: 'A', notes: `secreto de A, apunta a [[task:${ID_B}|B]]` });
		const b = task({ id: ID_B, content: 'B', notes: `secreto de B, apunta a [[task:${ID_A}|A]]` });
		const resolution = resolutionOf([a, b]);
		const out = renderRefs(`[[task:${ID_A}|x]]`, resolution);
		expect(out).not.toContain('secreto');
		expect(out).toContain('✎');
	});

	it('VARIAS referencias en la misma nota, cada una con su estado', () => {
		const resolution = resolutionOf(
			[task({ id: ID_A, content: 'Viva' }), task({ id: ID_B, content: 'Cerrada', done: true })],
			{ lists: [{ id: LIST_ID, name: 'Proyecto ACTUAL' }], refTaskIds: [ID_A, ID_B, ID_C] }
		);
		resolution.checkedTasks.add(ID_C); // comprobada y ausente = rota
		const nota =
			`1) [[task:${ID_A}|a]] 2) [[task:${ID_B}|b]] 3) [[task:${ID_C}|c]] 4) [[list:${LIST_ID}|l]]`;
		expect(renderRefs(nota, resolution)).toBe(
			`1) →tarea[pendiente] "Viva" id:${ID_A} ` +
				`2) →tarea[hecha] "Cerrada" id:${ID_B} ` +
				`3) →tarea[ROTA] id:${ID_C} ` +
				`4) →lista "Proyecto ACTUAL" id:${LIST_ID}`
		);
	});

	it('LISTA rota: mismo trato que una tarea rota', () => {
		const resolution = emptyRefResolution();
		resolution.checkedLists.add(LIST_ID);
		resolution.refListIds = [LIST_ID];
		expect(renderRefs(`[[list:${LIST_ID}|Nombre viejo]]`, resolution)).toBe(
			`→lista[ROTA] id:${LIST_ID}`
		);
	});

	it('el título de la tarea resuelta se aplana si a su vez lleva una referencia (nada recursivo)', () => {
		const resolution = resolutionOf([task({ content: `Sigue a [[task:${ID_B}|Otra]]` })]);
		expect(renderRefs(`[[task:${ID_A}|x]]`, resolution)).toBe(
			`→tarea[pendiente] "Sigue a Otra" id:${ID_A}`
		);
	});

	it('sin resolución (llamante que no la pasa): el texto sale tal cual, sin romperlo', () => {
		const nota = `[[task:${ID_A}|Etiqueta]]`;
		expect(renderRefs(nota, undefined)).toBe(nota);
	});
});

describe('refCounts — recuentos de la cabecera', () => {
	it('separa vivas, con nota, rotas y sin resolver', () => {
		const resolution = resolutionOf(
			[task({ id: ID_A }), task({ id: ID_B, notes: 'con sustancia' })],
			{
				lists: [{ id: LIST_ID, name: 'Proyecto' }],
				refTaskIds: [ID_A, ID_B, ID_C, 'no-es-uuid']
			}
		);
		resolution.checkedTasks.add(ID_C); // comprobada y ausente = rota
		expect(refCounts(resolution)).toEqual({
			live: 3,
			broken: 1,
			unresolved: 1,
			withNotes: 1,
			total: 5
		});
	});
});

describe('integración con los pintores (format.ts)', () => {
	it('formatTaskList resuelve las referencias del texto Y de la nota, y lo declara en la cabecera', () => {
		const referenced = task({ id: ID_B, content: 'Migrar el sync', notes: 'x'.repeat(120), notesUpdatedAt: '2026-07-24T08:00:00.000Z' });
		const listed = task({
			id: ID_A,
			content: `Preparar release (bloquea [[task:${ID_B}|Migrar sincro]])`,
			date: '2026-07-26'
		});
		const resolution = resolutionOf([referenced], { refTaskIds: [ID_B] });
		const out = formatTaskList([listed], 'today', { notesMode: 'none', refs: resolution });
		expect(out).toContain(`→tarea[pendiente] "Migrar el sync" ✎120 ↻24jul id:${ID_B}`);
		expect(out).toContain('refs: 1 viva · 1 con nota ✎ → léela con get_task, ahí está el contexto');
		expect(out).not.toContain('Migrar sincro');
	});

	it('formatTaskList declara las ROTAS en la cabecera (borrada o archivada, no "ya no existe" a secas)', () => {
		const resolution = emptyRefResolution();
		resolution.checkedTasks.add(ID_B);
		resolution.refTaskIds = [ID_B];
		const listed = task({ content: `Depende de [[task:${ID_B}|Etiqueta vieja]]` });
		const out = formatTaskList([listed], 'today', { notesMode: 'none', refs: resolution });
		expect(out).toContain('refs: 0 vivas · 1 ROTA (ese id ya no resuelve: borrada o archivada)');
		expect(out).toContain(`→tarea[ROTA] id:${ID_B}`);
	});

	it('formatTaskList SIN referencias no añade ninguna línea de cabecera de refs', () => {
		const out = formatTaskList([task()], 'today', { notesMode: 'none', refs: emptyRefResolution() });
		expect(out).not.toContain('refs:');
	});

	it('formatTaskFull resuelve las referencias del contenido, de la nota y de las subtareas', () => {
		const detail = task({
			id: ID_A,
			content: 'Release',
			notes: `Ojo con [[task:${ID_B}|nombre viejo]]`,
			subtasks: [{ id: ID_C, content: `Cerrar [[list:${LIST_ID}|lista vieja]]`, done: false }]
		});
		const resolution = resolutionOf([task({ id: ID_B, content: 'Migrar el sync' })], {
			lists: [{ id: LIST_ID, name: 'Proyecto ACTUAL' }],
			refTaskIds: [ID_B]
		});
		const out = formatTaskFull(detail, resolution);
		expect(out).toContain(`→tarea[pendiente] "Migrar el sync" id:${ID_B}`);
		expect(out).toContain(`→lista "Proyecto ACTUAL" id:${LIST_ID}`);
		expect(out).not.toContain('nombre viejo');
		expect(out).not.toContain('lista vieja');
	});
});
