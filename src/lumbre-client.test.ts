import { describe, expect, it } from 'vitest';
import { assertTaskUsable, subtaskNotAllowedError, taskNotFoundError, type LumbreTask } from './lumbre-client.js';

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
		expect(() => assertTaskUsable(undefined, 'no-existe')).toThrow(/no existe/i);
		expect(() => assertTaskUsable(undefined, 'no-existe', { allowSubtask: true })).toThrow(/no existe/i);
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
});
