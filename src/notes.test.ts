import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatTaskList } from './format.js';
import type { LumbreTask } from './lumbre-client.js';
import {
	computeAutoNotesRender,
	computeNotesSinceRender,
	decideAutoNoteRender,
	decideNotesSinceRender,
	DEFAULT_NOTES_RECENT_HOURS,
	hasDoneTag,
	loadNotesSeenState,
	parseNotesSince,
	recordNotesSeen,
	saveNotesSeenState,
	touchNotesSeen,
	type NotesSeenState
} from './notes.js';

/**
 * Tarea de la feature "notas de David sin recortar" (2026-07-25): el preview
 * a 240 chars de `list_tasks` truncaba el 90% de sus notas reales — cortaba
 * justo la cola, que es donde escribe su feedback — y el resultado se veía
 * como una nota completa, así que el agente seguía adelante convencido de
 * haberla leído entera. `notes: 'auto'` (nuevo default) es la GARANTÍA de que
 * eso no puede volver a pasar: una nota sale ÍNTEGRA o sale como marcador
 * `✎N ↻fecha`, nunca a medias.
 *
 * Capa 2 (misma fecha, ampliación posterior): la API expone `notesUpdatedAt`
 * (marca ISO de la última edición de la NOTA, derivada del HLC de su celda
 * CRDT) — la huella local dejó de comparar un HASH del texto y pasó a
 * comparar esa marca, que es EXACTA (sin ventana) en cuanto hay una huella
 * previa; la ventana de `notesRecentHours` solo aplica al BOOTSTRAP (nunca
 * vista, o máquina nueva sin fichero de huellas).
 *
 * Cada test que toca el fichero de huellas usa su PROPIO directorio temporal
 * vía `XDG_STATE_HOME` (`beforeEach`/`afterEach`) — nunca el
 * `~/.local/state/lumbre-mcp/notes-seen.json` real, que además puede tener
 * 4+ procesos MCP escribiéndolo a la vez en una sesión de verdad.
 */

let stateDir: string;

beforeEach(async () => {
	stateDir = await mkdtemp(join(tmpdir(), 'lumbre-mcp-notes-test-'));
	process.env.XDG_STATE_HOME = stateDir;
});

afterEach(async () => {
	delete process.env.XDG_STATE_HOME;
	await rm(stateDir, { recursive: true, force: true });
});

function task(overrides: Partial<LumbreTask> = {}): LumbreTask {
	return {
		id: '11111111-1111-1111-1111-111111111111',
		content: 'Tarea de prueba',
		notes: null,
		notesUpdatedAt: null,
		done: false,
		priority: null,
		date: null,
		deadline: null,
		list: null,
		createdAt: new Date().toISOString(),
		...overrides
	};
}

/** Nota larga (bastante por encima de los 240 chars del preview legado), para
 *  que la garantía se comprueba de verdad contra el caso que la motivó. */
const LONG_NOTE = `Contexto inicial de la tarea. ${'Detalle relevante de seguimiento. '.repeat(15)}Feedback final de David: esto es lo importante, lo que se corta con el preview de 240.`;

/** Reloj fijo para los tests de ventana de bootstrap — nunca `Date.now()`
 *  real, para que "dentro"/"fuera de la ventana" no dependa de CUÁNDO corre
 *  el test. */
const NOW = new Date('2026-07-25T12:00:00.000Z');

describe('hasDoneTag — capa 1 (sin estado)', () => {
	it('matchea @done', () => {
		expect(hasDoneTag('Arreglar el bug @done')).toBe(true);
	});

	it('matchea #done (la convención migró de @tag a #tag en julio 2026)', () => {
		expect(hasDoneTag('Arreglar el bug #done')).toBe(true);
	});

	it('es case-insensitive', () => {
		expect(hasDoneTag('Arreglar el bug @DONE')).toBe(true);
	});

	it('NO matchea un tag distinto (@acked)', () => {
		expect(hasDoneTag('Arreglar el bug @acked')).toBe(false);
	});

	it('NO matchea una palabra que solo CONTIENE "done" (falso positivo de substring)', () => {
		expect(hasDoneTag('Revisar el @doneish o el notdone')).toBe(false);
	});

	it('sin ningún tag da false', () => {
		expect(hasDoneTag('Tarea normal sin tags')).toBe(false);
	});
});

describe('decideAutoNoteRender — matriz de decisión pura (capa 2 por MARCA, no por hash)', () => {
	const opts = { now: NOW, windowHours: DEFAULT_NOTES_RECENT_HOURS };

	it('@done → íntegra, aunque nunca se haya visto antes ni traiga marca', () => {
		const d = decideAutoNoteRender('Tarea @done', 'una nota cualquiera', undefined, undefined, opts);
		expect(d.kind).toBe('full');
	});

	it('#done → íntegra', () => {
		const d = decideAutoNoteRender('Tarea #done', 'una nota cualquiera', undefined, undefined, opts);
		expect(d.kind).toBe('full');
	});

	describe('CON registro local (huella previa)', () => {
		it('marca POSTERIOR a la huella → íntegra', () => {
			const previous = { u: '2026-07-20T00:00:00.000Z', n: 10 };
			const d = decideAutoNoteRender(
				'Tarea sin tag',
				'nota nueva',
				'2026-07-24T00:00:00.000Z',
				previous,
				opts
			);
			expect(d.kind).toBe('full');
		});

		it('marca IGUAL a la huella → marcador', () => {
			const previous = { u: '2026-07-20T00:00:00.000Z', n: 10 };
			const d = decideAutoNoteRender(
				'Tarea sin tag',
				'nota sin cambios',
				'2026-07-20T00:00:00.000Z',
				previous,
				opts
			);
			expect(d.kind).toBe('marker');
		});

		it('marca ANTERIOR a la huella (reloj raro/rollback) → marcador', () => {
			const previous = { u: '2026-07-20T00:00:00.000Z', n: 10 };
			const d = decideAutoNoteRender(
				'Tarea sin tag',
				'nota',
				'2026-07-19T00:00:00.000Z',
				previous,
				opts
			);
			expect(d.kind).toBe('marker');
		});

		it('sin marca actual (null) con huella previa → marcador (desconocido, no se arriesga)', () => {
			const previous = { u: '2026-07-20T00:00:00.000Z', n: 10 };
			const d = decideAutoNoteRender('Tarea sin tag', 'nota', null, previous, opts);
			expect(d.kind).toBe('marker');
		});
	});

	describe('SIN registro local (bootstrap — solo aplica la ventana)', () => {
		it('marca DENTRO de la ventana (hace 2h) → íntegra', () => {
			const d = decideAutoNoteRender(
				'Tarea sin tag',
				'nota',
				'2026-07-25T10:00:00.000Z',
				undefined,
				opts
			);
			expect(d.kind).toBe('full');
		});

		it('marca justo en el borde de la ventana (hace exactamente 24h) → íntegra', () => {
			const d = decideAutoNoteRender(
				'Tarea sin tag',
				'nota',
				'2026-07-24T12:00:00.000Z',
				undefined,
				opts
			);
			expect(d.kind).toBe('full');
		});

		it('marca FUERA de la ventana (hace 3 días) → marcador', () => {
			const d = decideAutoNoteRender(
				'Tarea sin tag',
				'nota',
				'2026-07-22T12:00:00.000Z',
				undefined,
				opts
			);
			expect(d.kind).toBe('marker');
		});

		it('ventana más corta (6h) excluye una marca de hace 10h', () => {
			const d = decideAutoNoteRender(
				'Tarea sin tag',
				'nota',
				'2026-07-25T02:00:00.000Z',
				undefined,
				{ now: NOW, windowHours: 6 }
			);
			expect(d.kind).toBe('marker');
		});

		it('sin marca (null) → marcador (desconocido)', () => {
			const d = decideAutoNoteRender('Tarea sin tag', 'nota', null, undefined, opts);
			expect(d.kind).toBe('marker');
		});

		it('marca mal formada (no parsea a fecha) → marcador, sin lanzar', () => {
			const d = decideAutoNoteRender('Tarea sin tag', 'nota', 'no-es-una-fecha', undefined, opts);
			expect(d.kind).toBe('marker');
		});
	});

	it('el marcador lleva la longitud REAL (trim, no capada a 240) y la marca usada', () => {
		const d = decideAutoNoteRender('Tarea sin tag', LONG_NOTE, '2026-07-01T00:00:00.000Z', undefined, opts);
		expect(d.kind).toBe('marker');
		expect(d.length).toBe(LONG_NOTE.trim().length);
		expect(d.length).toBeGreaterThan(240);
		expect(d.updatedAt).toBe('2026-07-01T00:00:00.000Z');
	});
});

describe('decideNotesSinceRender — exclusividad: SOLO la marca decide', () => {
	const since = new Date('2026-07-20T00:00:00.000Z');

	it('marca posterior o igual a `since` → íntegra', () => {
		expect(decideNotesSinceRender('nota', '2026-07-20T00:00:00.000Z', since).kind).toBe('full');
		expect(decideNotesSinceRender('nota', '2026-07-21T00:00:00.000Z', since).kind).toBe('full');
	});

	it('marca anterior a `since` → marcador, AUNQUE la tarea sea @done (capa 1 no aplica aquí)', () => {
		// `decideNotesSinceRender` ni siquiera recibe `content`: la exclusividad
		// es estructural, no una comprobación que se pueda saltar por error.
		const d = decideNotesSinceRender('nota vieja de una tarea @done', '2026-07-01T00:00:00.000Z', since);
		expect(d.kind).toBe('marker');
	});

	it('sin marca (null) → marcador', () => {
		expect(decideNotesSinceRender('nota', null, since).kind).toBe('marker');
	});
});

describe('parseNotesSince', () => {
	it('"YYYY-MM-DD" se interpreta como el inicio de ese día en UTC', () => {
		const d = parseNotesSince('2026-07-20');
		expect(d?.toISOString()).toBe('2026-07-20T00:00:00.000Z');
	});

	it('ISO completo se respeta tal cual', () => {
		const d = parseNotesSince('2026-07-20T15:30:00.000Z');
		expect(d?.toISOString()).toBe('2026-07-20T15:30:00.000Z');
	});

	it('fecha inválida → undefined, sin lanzar', () => {
		expect(parseNotesSince('no-es-una-fecha')).toBeUndefined();
	});
});

describe('touchNotesSeen — huella por MARCA + poda LRU', () => {
	it('inserta una entrada nueva con la marca + longitud tras trim', () => {
		const state = touchNotesSeen({}, 'task-1', '  hola  ', '2026-07-20T00:00:00.000Z');
		expect(state['task-1']).toEqual({ u: '2026-07-20T00:00:00.000Z', n: 4 });
	});

	it('sin marca válida (null/ausente) NO inserta entrada — nada útil que registrar', () => {
		const state = touchNotesSeen({}, 'task-1', 'hola', null);
		expect(state['task-1']).toBeUndefined();
	});

	it('sin marca válida BORRA una entrada previa (propia o legado) en vez de dejarla mintiendo', () => {
		let state: NotesSeenState = touchNotesSeen({}, 'task-1', 'hola', '2026-07-20T00:00:00.000Z');
		state = touchNotesSeen(state, 'task-1', 'hola', null);
		expect(state['task-1']).toBeUndefined();
	});

	it('reinsertar una entrada existente la mueve al final (más reciente)', () => {
		let state: NotesSeenState = {};
		state = touchNotesSeen(state, 'a', 'nota a', '2026-07-01T00:00:00.000Z');
		state = touchNotesSeen(state, 'b', 'nota b', '2026-07-01T00:00:00.000Z');
		state = touchNotesSeen(state, 'a', 'nota a editada', '2026-07-02T00:00:00.000Z');
		expect(Object.keys(state)).toEqual(['b', 'a']);
	});

	it('poda la entrada MENOS reciente al superar el cap', () => {
		let state: NotesSeenState = {};
		state = touchNotesSeen(state, 'a', 'nota a', '2026-07-01T00:00:00.000Z', 2);
		state = touchNotesSeen(state, 'b', 'nota b', '2026-07-01T00:00:00.000Z', 2);
		state = touchNotesSeen(state, 'c', 'nota c', '2026-07-01T00:00:00.000Z', 2);
		expect(Object.keys(state)).toEqual(['b', 'c']);
		expect(state['a']).toBeUndefined();
	});
});

describe('estado en disco — best-effort, nunca rompe una lectura', () => {
	it('round-trip: lo que guarda saveNotesSeenState lo devuelve loadNotesSeenState', async () => {
		const state = touchNotesSeen({}, 'task-1', 'una nota', '2026-07-20T00:00:00.000Z');
		await saveNotesSeenState(state);
		const loaded = await loadNotesSeenState();
		expect(loaded).toEqual(state);
	});

	it('fichero AUSENTE → estado vacío, sin lanzar', async () => {
		const loaded = await loadNotesSeenState();
		expect(loaded).toEqual({});
	});

	it('fichero CORRUPTO (JSON inválido) → estado vacío, sin lanzar', async () => {
		// Escribe directamente donde escribiría `saveNotesSeenState` (mismo
		// layout: `<XDG_STATE_HOME>/lumbre-mcp/notes-seen.json`), simulando un
		// fichero a medio escribir / corrompido por otro proceso.
		const dir = join(stateDir, 'lumbre-mcp');
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, 'notes-seen.json'), '{ esto no es JSON válido');
		const loaded = await loadNotesSeenState();
		expect(loaded).toEqual({});
	});

	it('estado ilegible NO rompe computeAutoNotesRender: la capa del tag SIGUE aplicando', async () => {
		const dir = join(stateDir, 'lumbre-mcp');
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, 'notes-seen.json'), 'esto tampoco es JSON');
		const tasks = [
			task({ id: 'a', content: 'Tarea @done', notes: 'nota de una tarea hecha', notesUpdatedAt: null })
		];
		const result = await computeAutoNotesRender(tasks, { now: NOW });
		expect(result.perTask.get('a')?.kind).toBe('full');
		expect(result.fullCount).toBe(1);
	});

	it('estado en formato VIEJO `{h,n}` (huella por hash, retirada) NO rompe y se migra al formato nuevo', async () => {
		const dir = join(stateDir, 'lumbre-mcp');
		await mkdir(dir, { recursive: true });
		// Forma exacta del fichero legado (antes de `notesUpdatedAt`).
		await writeFile(
			join(dir, 'notes-seen.json'),
			JSON.stringify({ 'legacy-1': { h: '0123456789', n: 42 } })
		);
		const tasks = [
			task({
				id: 'legacy-1',
				content: 'Tarea sin tag',
				notes: 'nota',
				notesUpdatedAt: '2026-07-25T11:00:00.000Z' // dentro de la ventana de bootstrap
			})
		];
		// La entrada vieja se trata como "nunca vista" → bootstrap (dentro de la
		// ventana de 24h respecto de NOW) → íntegra, no revienta con el `{h,n}`.
		const result = await computeAutoNotesRender(tasks, { now: NOW });
		expect(result.perTask.get('legacy-1')?.kind).toBe('full');

		// Y queda REESCRITA en el formato nuevo tras esta pasada.
		const migrated = await loadNotesSeenState();
		expect(migrated['legacy-1']).toEqual({ u: '2026-07-25T11:00:00.000Z', n: 4 });
	});
});

describe('recordNotesSeen', () => {
	it('registra la huella (marca + longitud) de una tarea con nota (get_task/notes:"full")', async () => {
		await recordNotesSeen([
			{ taskId: 'x', notes: '  contenido de la nota  ', notesUpdatedAt: '2026-07-20T00:00:00.000Z' }
		]);
		const state = await loadNotesSeenState();
		expect(state['x']).toEqual({ u: '2026-07-20T00:00:00.000Z', n: 'contenido de la nota'.length });
	});

	it('con un array vacío no toca el fichero (sigue ausente)', async () => {
		await recordNotesSeen([]);
		const state = await loadNotesSeenState();
		expect(state).toEqual({});
	});

	it('notesUpdatedAt: null → no registra huella útil (nada roto, solo no hay nada que comparar después)', async () => {
		await recordNotesSeen([{ taskId: 'x', notes: 'nota', notesUpdatedAt: null }]);
		const state = await loadNotesSeenState();
		expect(state['x']).toBeUndefined();
	});
});

describe('computeAutoNotesRender — huella real, dos pasadas consecutivas', () => {
	it('1ª pasada (dentro de ventana) → íntegra; 2ª SIN cambios (misma marca) → marcador; 3ª con marca POSTERIOR → íntegra', async () => {
		const t = task({
			id: 'seq-1',
			content: 'Tarea sin tag',
			notes: 'nota original',
			notesUpdatedAt: '2026-07-25T10:00:00.000Z' // dentro de la ventana de bootstrap respecto de NOW
		});

		const first = await computeAutoNotesRender([t], { now: NOW });
		expect(first.perTask.get('seq-1')?.kind).toBe('full');

		const second = await computeAutoNotesRender([t], { now: NOW });
		expect(second.perTask.get('seq-1')?.kind).toBe('marker');

		const changed = { ...t, notes: 'nota YA cambiada de verdad', notesUpdatedAt: '2026-07-25T11:00:00.000Z' };
		const third = await computeAutoNotesRender([changed], { now: NOW });
		expect(third.perTask.get('seq-1')?.kind).toBe('full');
	});

	it('recuentos fullCount/markerCount correctos sobre un lote mixto', async () => {
		const tasks = [
			task({ id: '1', content: 'A @done', notes: 'nota A', notesUpdatedAt: null }),
			task({ id: '2', content: 'B #done', notes: 'nota B', notesUpdatedAt: null }),
			task({
				id: '3',
				content: 'C @acked',
				notes: 'nota C, fuera de la ventana',
				notesUpdatedAt: '2026-07-01T00:00:00.000Z'
			}),
			task({ id: '4', content: 'D sin tag', notes: null })
		];
		const result = await computeAutoNotesRender(tasks, { now: NOW });
		expect(result.fullCount).toBe(2);
		expect(result.markerCount).toBe(1);
		expect(result.perTask.has('4')).toBe(false); // sin nota, no entra
	});
});

describe('GARANTÍA — en auto, ninguna nota renderizada sale truncada', () => {
	it('la nota con @done sale VERBATIM completa; la que no, sale como marcador ✎N — nunca un recorte con "…"', async () => {
		const pendingNote = `Nota distinta y sin relación con la anterior, pero igual de larga: ${'palabra '.repeat(40)}fin.`;
		const doneTask = task({
			id: 'done-1',
			content: 'Cerrar informe @done',
			notes: LONG_NOTE,
			notesUpdatedAt: null
		});
		const pendingTask = task({
			id: 'pending-1',
			content: 'Revisar borrador',
			notes: pendingNote,
			notesUpdatedAt: '2026-07-01T00:00:00.000Z' // fuera de la ventana → marcador
		});
		const tasks = [doneTask, pendingTask];

		const autoRender = await computeAutoNotesRender(tasks, { now: NOW });
		const output = formatTaskList(tasks, 'today', { notesMode: 'auto', autoRender });

		// La íntegra: el texto completo, verbatim, tiene que estar presente tal cual.
		expect(output).toContain(LONG_NOTE.trim());

		// La otra: NUNCA el texto (ni un fragmento largo) — solo el marcador con
		// el tamaño real.
		expect(output).toContain(`✎${pendingNote.trim().length}`);
		expect(output).not.toContain(pendingNote.trim().slice(0, 100));

		// Ningún recorte "a medias" (el marcador del preview legado, "…") se ha
		// colado en la salida.
		expect(output).not.toContain('…');
	});

	it('propiedad general: la longitud declarada (`length`) es SIEMPRE la real, sea íntegra o marcador', async () => {
		const notesById: Record<string, string> = {
			a: 'nota corta',
			b: 'B'.repeat(500),
			c: 'nota @done '.repeat(3),
			d: 'C'.repeat(1000)
		};
		const tasks = [
			task({ id: 'a', content: 'Sin tag', notes: notesById.a, notesUpdatedAt: null }),
			task({ id: 'b', content: 'Sin tag', notes: notesById.b, notesUpdatedAt: null }),
			task({ id: 'c', content: 'Marcada @done', notes: notesById.c, notesUpdatedAt: null }),
			task({ id: 'd', content: 'Sin tag', notes: notesById.d, notesUpdatedAt: null })
		];
		const autoRender = await computeAutoNotesRender(tasks, { now: NOW });

		expect(autoRender.perTask.get('c')?.kind).toBe('full');
		expect(autoRender.perTask.get('a')?.kind).toBe('marker');
		for (const t of tasks) {
			const decision = autoRender.perTask.get(t.id)!;
			expect(decision.length).toBe(notesById[t.id].trim().length);
		}
	});
});

describe('marcador — tamaño Y fecha de la última edición', () => {
	it('el marcador (vía formatTaskList) contiene el tamaño Y la fecha de `notesUpdatedAt`', async () => {
		const t = task({
			id: 'm-1',
			content: 'Sin tag',
			notes: 'una nota cualquiera, sin @done',
			notesUpdatedAt: '2026-07-24T09:00:00.000Z' // fuera de la ventana relativa a NOW
		});
		const autoRender = await computeAutoNotesRender([t], { now: NOW, windowHours: 1 });
		expect(autoRender.perTask.get('m-1')?.kind).toBe('marker');

		const output = formatTaskList([t], 'today', { notesMode: 'auto', autoRender });
		expect(output).toContain(`✎${'una nota cualquiera, sin @done'.length}`);
		expect(output).toContain('24jul');
	});

	it('sin `notesUpdatedAt` conocida, el marcador se queda solo con el tamaño (sin fecha)', async () => {
		const t = task({ id: 'm-2', content: 'Sin tag', notes: 'nota sin marca', notesUpdatedAt: null });
		const autoRender = await computeAutoNotesRender([t], { now: NOW });
		const output = formatTaskList([t], 'today', { notesMode: 'auto', autoRender });
		expect(output).toContain(`✎${'nota sin marca'.length}`);
		expect(output).not.toContain('↻');
	});
});

describe('notesSince — recorrido completo con formatTaskList', () => {
	it('solo las tocadas desde `since` salen íntegras; una @done con nota vieja sale con marcador (exclusividad)', () => {
		const since = new Date('2026-07-20T00:00:00.000Z');
		const recent = task({
			id: 'recent-1',
			content: 'Sin tag ni done',
			notes: 'nota tocada ayer',
			notesUpdatedAt: '2026-07-24T00:00:00.000Z'
		});
		const oldDone = task({
			id: 'old-done-1',
			content: 'Tarea @done',
			notes: 'nota vieja, de antes de `since`',
			notesUpdatedAt: '2026-07-01T00:00:00.000Z'
		});
		const tasks = [recent, oldDone];

		const sinceRender = computeNotesSinceRender(tasks, since);
		expect(sinceRender.perTask.get('recent-1')?.kind).toBe('full');
		expect(sinceRender.perTask.get('old-done-1')?.kind).toBe('marker');

		const output = formatTaskList(tasks, 'today', {
			notesMode: 'auto',
			autoRender: sinceRender,
			notesSinceLabel: '2026-07-20'
		});
		expect(output).toContain('nota tocada ayer');
		expect(output).not.toContain('nota vieja, de antes de');
		expect(output).toMatch(/tocadas desde 2026-07-20/);
	});

	it('no toca el fichero de huellas (consulta SIN estado)', async () => {
		const since = new Date('2026-07-20T00:00:00.000Z');
		const tasks = [
			task({ id: 's-1', content: 'X', notes: 'nota', notesUpdatedAt: '2026-07-24T00:00:00.000Z' })
		];
		computeNotesSinceRender(tasks, since);
		const state = await loadNotesSeenState();
		expect(state).toEqual({});
	});
});

describe('cabecera del listado — declara criterio + recuentos + instrucción "sin leer"', () => {
	it('modo auto normal: incluye los recuentos, el criterio y remite a get_task', async () => {
		const tasks = [
			task({ id: '1', content: 'A @done', notes: 'nota A', notesUpdatedAt: null }),
			task({
				id: '2',
				content: 'B sin tag',
				notes: 'nota B, nunca vista y fuera de ventana',
				notesUpdatedAt: '2026-01-01T00:00:00.000Z'
			})
		];
		const autoRender = await computeAutoNotesRender(tasks, { now: NOW });
		const output = formatTaskList(tasks, 'today', { notesMode: 'auto', autoRender });

		expect(output).toMatch(/notas: 1 íntegra/);
		expect(output).toMatch(/1 con marcador/);
		expect(output).toMatch(/SIN LEER/);
		expect(output).toContain('get_task');
		expect(output).toMatch(/tocadas <24h/);
	});

	it('respeta `notesWindowHours` distinto del default en el texto del criterio', async () => {
		const tasks = [task({ id: '1', content: 'Sin tag', notes: 'nota', notesUpdatedAt: null })];
		const autoRender = await computeAutoNotesRender(tasks, { now: NOW, windowHours: 6 });
		const output = formatTaskList(tasks, 'today', {
			notesMode: 'auto',
			autoRender,
			notesWindowHours: 6
		});
		expect(output).toMatch(/tocadas <6h/);
	});

	it('sin ninguna nota en el lote, no añade línea de cabecera de notas', async () => {
		const tasks = [task({ id: '1', content: 'Sin notas', notes: null })];
		const autoRender = await computeAutoNotesRender(tasks, { now: NOW });
		const output = formatTaskList(tasks, 'today', { notesMode: 'auto', autoRender });
		expect(output).not.toContain('notas:');
	});
});

describe("notesMode: 'none'/'preview'/'full' — comportamiento explícito, sin tocar el fichero de huellas", () => {
	it("'none' no muestra ninguna línea de notas", () => {
		const tasks = [task({ id: '1', content: 'X', notes: 'una nota cualquiera' })];
		const output = formatTaskList(tasks, 'today', { notesMode: 'none' });
		expect(output).not.toContain('notas:');
	});

	it("'preview' trunca a ~240 con '…' (comportamiento legado, ya NO es el default)", () => {
		const tasks = [task({ id: '1', content: 'X', notes: LONG_NOTE })];
		const output = formatTaskList(tasks, 'today', { notesMode: 'preview' });
		expect(output).toContain('…');
		expect(output).not.toContain(LONG_NOTE.trim());
	});

	it("'full' muestra la nota íntegra verbatim para TODO el lote", () => {
		const tasks = [task({ id: '1', content: 'X', notes: LONG_NOTE })];
		const output = formatTaskList(tasks, 'today', { notesMode: 'full' });
		expect(output).toContain(LONG_NOTE.trim());
		expect(output).not.toContain('…');
	});
});
