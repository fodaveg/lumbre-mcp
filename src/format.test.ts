import { describe, expect, it } from 'vitest';
import type { LumbreTask } from './lumbre-client.js';
import { formatTaskFull, formatTaskList } from './format.js';

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
