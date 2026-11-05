import { describe, expect, it } from 'vitest';
import type { LumbreHabit, LumbreHabitLogEntry, LumbreListSummary, LumbreTask } from './lumbre-client.js';
import { formatHabitList, formatListDetail, formatListSummaries, formatTaskFull, formatTaskList } from './format.js';

/**
 * `creada:<timestamp>` en `formatTask` (tarea de perf, 2026-08-25): antes iba
 * en TODAS las líneas aunque su único uso real es desempatar cuál es la más
 * nueva entre DOS tareas con el mismo título — ver el JSDoc de
 * `duplicateTitleKeys` en `format.ts`. Estos tests cubren el caso normal
 * (título único → sin el tag) y el caso que sí lo necesita (título repetido
 * en el lote → ambas lo llevan).
 */

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
		createdAt: '2026-08-01T10:00:00.000Z',
		...overrides
	};
}

describe('formatTaskList — `creada:` solo cuando hay títulos duplicados en el lote', () => {
	it('título único en el lote → SIN `creada:` en su línea', () => {
		const tasks = [task({ id: 'a', content: 'Comprar leche' })];
		const output = formatTaskList(tasks, 'today', { notesMode: 'none' });
		expect(output).not.toContain('creada:');
	});

	it('dos tareas con el MISMO título (case-insensitive, con espacios de más) → AMBAS llevan `creada:`', () => {
		const tasks = [
			task({ id: 'a', content: 'Comprar leche', createdAt: '2026-08-01T10:00:00.000Z' }),
			task({ id: 'b', content: '  COMPRAR LECHE  ', createdAt: '2026-08-02T09:30:00.000Z' })
		];
		const output = formatTaskList(tasks, 'today', { notesMode: 'none' });
		const lines = output.split('\n').filter((l) => l.startsWith('- '));
		expect(lines).toHaveLength(2);
		for (const line of lines) {
			expect(line).toContain('creada:');
		}
		expect(output).toContain('creada:2026-08-01T10:00');
		expect(output).toContain('creada:2026-08-02T09:30');
	});

	it('tres títulos, solo dos duplicados → SOLO esas dos llevan `creada:`, la tercera no', () => {
		const tasks = [
			task({ id: 'a', content: 'Pagar factura' }),
			task({ id: 'b', content: 'Pagar factura' }),
			task({ id: 'c', content: 'Revisar informe' })
		];
		const output = formatTaskList(tasks, 'today', { notesMode: 'none' });
		const lines = output.split('\n').filter((l) => l.startsWith('- '));
		expect(lines).toHaveLength(3);
		const facturaLines = lines.filter((l) => l.includes('Pagar factura'));
		const informeLine = lines.find((l) => l.includes('Revisar informe'));
		expect(facturaLines).toHaveLength(2);
		for (const line of facturaLines) expect(line).toContain('creada:');
		expect(informeLine).toBeDefined();
		expect(informeLine).not.toContain('creada:');
	});

	it('mismo título repartido en DOS secciones distintas también cuenta como duplicado', () => {
		const tasks = [
			task({ id: 'a', content: 'Enviar reporte', section: 'Hoy', list: 'Trabajo' }),
			task({ id: 'b', content: 'Enviar reporte', section: 'Mañana', list: 'Trabajo' })
		];
		const output = formatTaskList(tasks, 'today', { notesMode: 'none' });
		const lines = output.split('\n').filter((l) => l.startsWith('- '));
		expect(lines).toHaveLength(2);
		for (const line of lines) expect(line).toContain('creada:');
	});

	it('`@done`/`#done` en el título NO se considera igual al título sin la marca (decisión documentada en `duplicateTitleKeys`)', () => {
		const tasks = [task({ id: 'a', content: 'Cerrar caja' }), task({ id: 'b', content: 'Cerrar caja @done' })];
		const output = formatTaskList(tasks, 'today', { notesMode: 'none' });
		expect(output).not.toContain('creada:');
	});

	it('una tarea sin ninguna tag (título único, sin prioridad/fecha/deadline) no deja paréntesis vacío', () => {
		const tasks = [task({ id: 'a', content: 'Tarea suelta' })];
		const output = formatTaskList(tasks, 'today', { notesMode: 'none' });
		expect(output).not.toContain('()');
	});
});

describe('formato de la hora (`time`) — se pega a la fecha, no ocupa tag ni línea propia', () => {
	it('fecha + hora → la línea compacta lleva "fecha hora" en el mismo tag', () => {
		const output = formatTaskList(
			[task({ id: 'a', content: 'Reunión', date: '2026-09-04', time: '17:45' })],
			'today',
			{ notesMode: 'none' }
		);
		expect(output).toContain('Reunión (2026-09-04 17:45)  · id: a');
	});

	it('fecha + hora → el detalle (`get_task`) muestra "- fecha: fecha hora"', () => {
		const output = formatTaskFull(task({ date: '2026-09-04', time: '17:45' }));
		expect(output).toContain('- fecha: 2026-09-04 17:45');
	});

	it('fecha SIN hora → salida idéntica a antes de este cambio (protege el coste: ni un carácter de más)', () => {
		const compact = formatTaskList([task({ id: 'a', content: 'Comprar leche', date: '2026-09-04' })], 'today', {
			notesMode: 'none'
		});
		expect(compact).toBe('1 tarea (scope=today):\n- [ ] Comprar leche (2026-09-04)  · id: a');
		const full = formatTaskFull(task({ date: '2026-09-04' }));
		expect(full).toContain('- fecha: 2026-09-04');
		expect(full).not.toContain('- fecha: 2026-09-04 ');
	});

	it('hora SIN fecha → aparece igualmente (tag suelto en la línea compacta, marcada explícita en el detalle)', () => {
		const compact = formatTaskList([task({ id: 'a', content: 'Llamar', time: '09:00' })], 'today', {
			notesMode: 'none'
		});
		expect(compact).toContain('Llamar (09:00)  · id: a');
		const full = formatTaskFull(task({ time: '09:00' }));
		expect(full).toContain('- fecha: (sin fecha) 09:00');
	});

	it('`time: null` y `time` ausente (servidor viejo) se comportan igual: como "sin hora"', () => {
		const withNull = formatTaskList([task({ id: 'a', content: 'X', date: '2026-09-04', time: null })], 'today', {
			notesMode: 'none'
		});
		const withUndefined = formatTaskList(
			[task({ id: 'a', content: 'X', date: '2026-09-04', time: undefined })],
			'today',
			{ notesMode: 'none' }
		);
		expect(withNull).toBe(withUndefined);
		expect(withNull).toBe('1 tarea (scope=today):\n- [ ] X (2026-09-04)  · id: a');
	});
});

describe('nomenclatura de proyectos y áreas', () => {
	it('el detalle conserva listId pero presenta la residencia como proyecto o área', () => {
		const output = formatTaskFull(
			task({ list: 'Casa', somedayListId: '11111111-1111-1111-1111-111111111111' })
		);
		expect(output).toContain(
			'- proyecto/área: "Casa" (listId: 11111111-1111-1111-1111-111111111111)'
		);
		expect(output).not.toContain('- lista:');
	});

	it('el inventario nombra proyectos y áreas sin cambiar listId', () => {
		const [header, ...lines] = formatListSummaries([
			{ id: '11111111-1111-1111-1111-111111111111', name: 'Casa', taskCount: 0 }
		]).split('\n');
		expect(header).toMatch(/^Proyectos y áreas \(1\):.*\[área\].*\[cerrado\].*\[cancelado\]/);
		expect(lines).toEqual(['· Casa — 0 tareas (listId: 11111111-1111-1111-1111-111111111111)']);
		expect(formatListSummaries([])).toBe('Sin proyectos ni áreas.');
	});

	it('distingue tags propios de los heredados en tareas y proyectos', () => {
		const tasks = [
			task({ id: 'a', content: 'Preparar cierre', tags: ['finanzas'], effectiveTags: ['casa', 'finanzas'] })
		];
		expect(formatTaskList(tasks, 'today', { notesMode: 'none' })).toContain(
			'(#finanzas, heredados:#casa)'
		);
		expect(
			formatListSummaries([
				{
					id: '11111111-1111-1111-1111-111111111111',
					name: 'Casa',
					taskCount: 1,
					tags: ['hogar'],
					effectiveTags: ['familia', 'hogar']
				}
			])
		).toContain('· #hogar, heredados:#familia');
	});
});

describe('formato de tareas archivadas', () => {
	it('el listado distingue una archivada de una viva con la fecha de archivo', () => {
		const output = formatTaskList(
			[
				task({ id: 'viva', content: 'Viva', archivedAt: null }),
				task({
					id: 'archivada',
					content: 'Archivada',
					archivedAt: '2026-08-27T10:15:00.000Z'
				})
			],
			'all',
			{ notesMode: 'none' }
		);
		expect(output).toContain('Archivada (archivada:2026-08-27)');
		expect(output).not.toContain('Viva (archivada:');
	});

	it('get_task informa explícitamente si la tarea está archivada', () => {
		expect(formatTaskFull(task({ archivedAt: '2026-08-27T10:15:00.000Z' }))).toContain(
			'- archivada: 2026-08-27T10:15:00.000Z'
		);
		expect(formatTaskFull(task({ archivedAt: null }))).toContain('- archivada: no');
	});
});

/**
 * MC4 del audit de paridad (23 sep 2026): la API manda `cancelledAt`,
 * `recurrence` y `seriesId` desde el 26 jul y el MCP no los pintaba — una
 * cancelada salía `[x]` como hecha y no había forma de distinguir una semilla
 * de sus ocurrencias.
 */
describe('cancelada, regla y serie (MC4)', () => {
	const SEED = '33333333-3333-4333-8333-333333333333';

	it('una cancelada (done:true + cancelledAt) sale `[-]` y «cancelada», no `[x]`', () => {
		const output = formatTaskList(
			[task({ id: 'c', content: 'Cancelada', done: true, cancelledAt: '2026-09-20T10:00:00.000Z' })],
			'all',
			{ notesMode: 'none' }
		);
		expect(output).toContain('- [-] Cancelada (cancelada)');
		expect(output).not.toContain('[x] Cancelada');
	});

	it('una hecha de verdad sigue saliendo `[x]` (control)', () => {
		const output = formatTaskList([task({ id: 'h', content: 'Hecha', done: true, cancelledAt: null })], 'all', {
			notesMode: 'none'
		});
		expect(output).toContain('- [x] Hecha');
	});

	it('el listado pinta la regla y marca la semilla; una ocurrencia cita el seriesId de su semilla', () => {
		const rule = { freq: 'weekly' as const, interval: 1, byWeekday: [0, 3], streak: true };
		const output = formatTaskList(
			[
				task({ id: SEED, content: 'Correr', recurrence: rule, seriesId: SEED }),
				task({ id: 'occ', content: 'Correr hoy', recurrence: rule, seriesId: SEED })
			],
			'all',
			{ notesMode: 'none' }
		);
		expect(output).toContain('Correr (↻semanal L,J, hábito, semilla)');
		expect(output).toContain(`Correr hoy (↻semanal L,J, hábito, serie:${SEED})`);
	});

	it('una tarea sin serie no gasta ni un carácter más en su línea', () => {
		const output = formatTaskList([task({ id: 'n', content: 'Normal', recurrence: null, seriesId: null })], 'all', {
			notesMode: 'none'
		});
		expect(output).toContain('- [ ] Normal  · id: n');
	});

	it('get_task: estado cancelada con fecha, regla completa y papel en la serie', () => {
		const full = formatTaskFull(
			task({
				id: 'occ',
				done: true,
				cancelledAt: '2026-09-20T10:00:00.000Z',
				recurrence: {
					freq: 'monthly',
					interval: 2,
					mode: 'afterCompletion',
					until: '2026-12-31',
					count: 5
				},
				seriesId: SEED
			})
		);
		expect(full).toContain('- estado: cancelada (2026-09-20T10:00:00.000Z)');
		expect(full).toContain('- repetición: cada 2 meses tras completar hasta 2026-12-31 5 veces');
		expect(full).toContain(`- serie: ocurrencia; semilla ${SEED}`);
	});

	it('get_task: «no repite» solo si la API dice null; sin la clave no afirma nada', () => {
		expect(formatTaskFull(task({ recurrence: null }))).toContain('- repetición: (no repite)');
		expect(formatTaskFull(task())).not.toContain('- repetición:');
		expect(formatTaskFull(task({ id: SEED, seriesId: SEED }))).toContain('- serie: semilla de su serie');
	});
});

describe('bloque «- subtareas:» de get_task', () => {
	it('pinta cada subtarea con su id y cierra con la línea que manda a get_task de la subtarea', () => {
		const full = formatTaskFull(
			task({
				subtasks: [
					{ id: '22222222-2222-2222-2222-222222222222', content: 'hija', done: false, tags: [], effectiveTags: [] }
				]
			})
		);
		const block = full.slice(full.indexOf('- subtareas:'));
		expect(block).toContain('[ ] hija  · id: 22222222-2222-2222-2222-222222222222');
		expect(block).toMatch(/fecha, prioridad, notas y adjuntos de una subtarea: get_task con su id/);
		// La API no trae notas ni adjuntos por subtarea: nada de marcadores inventados.
		expect(block).not.toMatch(/✎|📎/);
	});

	it('sin subtareas no hay bloque ni línea de get_task', () => {
		expect(formatTaskFull(task())).not.toContain('get_task con su id');
	});
});

describe('«esperando» (MC6, waitingUntil/waitingFor) — solo se pinta si el servidor la manda', () => {
	it('list_tasks: tag `esperando:<fecha> (for)` en la línea compacta', () => {
		const output = formatTaskList(
			[task({ waitingUntil: '2026-10-01', waitingFor: 'María' })],
			'all',
			{ notesMode: 'none' }
		);
		expect(output).toContain('esperando:2026-10-01 (María)');
	});

	it('list_tasks: sin `waitingFor`, el tag no lleva paréntesis', () => {
		const output = formatTaskList([task({ waitingUntil: '2026-10-01' })], 'all', { notesMode: 'none' });
		expect(output).toContain('esperando:2026-10-01)');
		expect(output).not.toContain('esperando:2026-10-01 (');
	});

	it('list_tasks: sin `waitingUntil` (servidor viejo, o no está esperando), no se pinta nada', () => {
		const output = formatTaskList([task()], 'all', { notesMode: 'none' });
		expect(output).not.toContain('esperando:');
	});

	it('get_task: línea `- esperando: hasta <fecha> (for)`', () => {
		const full = formatTaskFull(task({ waitingUntil: '2026-10-01', waitingFor: 'María' }));
		expect(full).toContain('- esperando: hasta 2026-10-01 (María)');
	});

	it('get_task: `waitingUntil` ausente — sin línea, nunca "no está esperando"', () => {
		expect(formatTaskFull(task())).not.toContain('esperando');
	});
});

describe('formatHabitList (MC6, list_habits)', () => {
	function habit(overrides: Partial<LumbreHabit> = {}): LumbreHabit {
		return { id: 'h1', nombre: 'Ejercicio', clase: 'cadencia', ...overrides };
	}

	it('por defecto omite los archivados y lo cuenta en la cabecera', () => {
		const habits = [habit(), habit({ id: 'h2', nombre: 'Leer', clase: 'registro', archivedAt: 0 })];
		const output = formatHabitList(habits, [], false);
		expect(output).toContain('1 hábito(s) (1 archivado omitido):');
		expect(output).toContain('Ejercicio (cadencia)');
		expect(output).not.toContain('Leer');
	});

	it('includeArchived:true los incluye, con la fecha de archivado', () => {
		const habits = [habit({ id: 'h2', nombre: 'Leer', clase: 'registro', archivedAt: 1_700_000_000_000 })];
		const output = formatHabitList(habits, [], true);
		expect(output).toContain('Leer (registro) [archivado 2023-11-14]');
	});

	it('muestra las últimas ocurrencias, más recientes primero, tope 3', () => {
		const log: LumbreHabitLogEntry[] = [
			{ id: 'l1', habitId: 'h1', date: '2026-09-20' },
			{ id: 'l2', habitId: 'h1', date: '2026-09-23' },
			{ id: 'l3', habitId: 'h1', date: '2026-09-22' },
			{ id: 'l4', habitId: 'h1', date: '2026-09-21' } // 4ª: se queda fuera (tope 3)
		];
		const output = formatHabitList([habit()], log, false);
		expect(output).toContain('últimas ocurrencias: 2026-09-23, 2026-09-22, 2026-09-21');
	});

	it('sin ocurrencias para ese hábito: sin línea de "últimas ocurrencias"', () => {
		const output = formatHabitList([habit()], [{ id: 'l1', habitId: 'otro', date: '2026-09-20' }], false);
		expect(output).not.toContain('últimas ocurrencias');
	});

	it('0 hábitos: lo dice sin fallar', () => {
		expect(formatHabitList([], [], false)).toContain('0 hábitos');
	});

	it('0 vivos pero hay archivados omitidos: lo dice y sugiere includeArchived', () => {
		const output = formatHabitList([habit({ archivedAt: 0 })], [], false);
		expect(output).toContain('0 hábitos (1 archivado omitido)');
		expect(output).toContain('includeArchived:true');
	});
});

// ── Lote 1 del audit de endpoints (5 nov 2026) ────────────────────────────

describe('formatTaskFull — algún día y Más tarde', () => {
	it('someday:true se enseña; false o ausente no pintan nada', () => {
		expect(formatTaskFull(task({ someday: true }))).toContain('- algún día: sí');
		expect(formatTaskFull(task({ someday: false }))).not.toContain('algún día');
		expect(formatTaskFull(task())).not.toContain('algún día');
	});

	it('daypart "later" se enseña; null o ausente no', () => {
		expect(formatTaskFull(task({ daypart: 'later' }))).toContain('Más tarde');
		expect(formatTaskFull(task({ daypart: null }))).not.toContain('Más tarde');
		expect(formatTaskFull(task())).not.toContain('Más tarde');
	});
});

describe('formatListSummaries / formatListDetail — Bandeja de un espacio compartido', () => {
	const SPACE = '99999999-9999-4999-8999-999999999999';
	const inbox = (over: Partial<LumbreListSummary> = {}): LumbreListSummary => ({
		id: 'inbox-1',
		name: 'Bandeja',
		taskCount: 0,
		kind: 'project',
		isInbox: true,
		spaceId: SPACE,
		...over
	});

	it('compartida con 0 tareas: no sale en list_lists', () => {
		const out = formatListSummaries([inbox(), { id: 'p', name: 'Proyecto', taskCount: 2 }]);
		expect(out).not.toContain('Bandeja');
		expect(out).toContain('Proyecto');
		expect(out).toContain('Proyectos y áreas (1)');
	});

	it('compartida con tareas: sale marcada [bandeja, no es destino]', () => {
		const out = formatListSummaries([inbox({ taskCount: 3 })]);
		expect(out).toContain('Bandeja [bandeja, no es destino] — 3 tareas');
	});

	it('personal (spaceId null o ausente): se pinta exactamente como antes, con 0 tareas incluida', () => {
		for (const spaceId of [null, undefined]) {
			const out = formatListSummaries([inbox({ spaceId })]);
			expect(out).toContain('· Bandeja — 0 tareas (listId: inbox-1)');
			expect(out).not.toContain('no es destino');
		}
	});

	it('servidor sin isInbox: nada cambia', () => {
		const { isInbox: _drop, ...legacy } = inbox();
		expect(formatListSummaries([legacy])).toContain('· Bandeja — 0 tareas');
	});

	it('get_list lleva la misma marca en la compartida y ninguna en la personal', () => {
		expect(formatListDetail(inbox())).toContain('- nombre: Bandeja [bandeja, no es destino]');
		expect(formatListDetail(inbox({ spaceId: null }))).toContain('- nombre: Bandeja\n');
	});
});

describe('formatListDetail — secciones', () => {
	const list: LumbreListSummary = { id: 'l1', name: 'Proyecto', taskCount: 3, kind: 'project' };

	it('sin pedirlas (undefined): no pinta nada', () => {
		expect(formatListDetail(list)).not.toContain('secciones');
	});

	it('con secciones: nombre, recuento (incluido 0) y sectionId', () => {
		const out = formatListDetail(list, null, [
			{ id: 's1', name: 'Fase 1', taskCount: 2 },
			{ id: 's2', name: 'Vacía', taskCount: 0 },
			{ id: 's3', name: 'Una', taskCount: 1 }
		]);
		expect(out).toContain('- secciones (3):');
		expect(out).toContain('· Fase 1 — 2 tareas (sectionId: s1)');
		expect(out).toContain('· Vacía — 0 tareas (sectionId: s2)');
		expect(out).toContain('· Una — 1 tarea (sectionId: s3)');
	});

	it('lista con 0 secciones: el texto es idéntico al de antes (contrato de cuentas sin espacios)', () => {
		expect(formatListDetail(list, null, [])).toBe(formatListDetail(list, null));
	});

	it('un string = no se pudieron leer: una línea con la causa', () => {
		expect(formatListDetail(list, null, 'Lumbre respondió 500')).toContain(
			'- secciones: no disponibles (Lumbre respondió 500)'
		);
	});
});

describe('formatHabitList — objetivos', () => {
	const h = (over: Partial<LumbreHabit>): LumbreHabit => ({ id: 'h1', nombre: 'Correr', clase: 'cadencia', ...over });

	it('cadencia en clase cadencia: objetivo por semana', () => {
		expect(formatHabitList([h({ cadencia: 3 })], [], false)).toContain('(cadencia) · objetivo: 3 por semana  · id: h1');
	});

	it('dailyGoal en contador: objetivo diario', () => {
		expect(formatHabitList([h({ clase: 'contador', dailyGoal: 8 })], [], false)).toContain('objetivo diario: 8');
	});

	it('dailyGoal 0, ausente, o cadencia huérfana en otra clase: nada', () => {
		const out = formatHabitList(
			[h({ clase: 'contador', dailyGoal: 0 }), h({ id: 'h2', clase: 'registro', cadencia: 4 })],
			[],
			false
		);
		expect(out).not.toContain('objetivo');
	});
});
