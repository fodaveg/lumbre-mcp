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
