import { describe, expect, it } from 'vitest';
import { BrlExistenceCache, EXISTENCE_CACHE_TTL_MS, TaskExistenceCache } from './existence-cache.js';
import type { LumbreBrlEntry, LumbreTask } from './lumbre-client.js';

/**
 * Cachés PURAS (sin red, `now` inyectable) que respaldan `requireTaskExists`/
 * `requireBrlEntryExists` en `index.ts` — el comportamiento de extremo a
 * extremo (evitar el segundo `fetch`, invalidar tras una mutación real) se
 * testea ahí, vía `createServer` + un cliente MCP in-memory; aquí solo la
 * lógica de hit/expiración/invalidación de la caché en sí, aislada.
 */

function task(overrides: Partial<LumbreTask> = {}): LumbreTask {
	return {
		id: 'task-1',
		content: 'tarea de prueba',
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

/** Reloj inyectable de mentira: empieza en un instante fijo y solo avanza
 *  cuando el test se lo pide (`advance`) — sin `setTimeout`/fake timers. */
function fakeClock(startAt = 1_000_000) {
	let now = startAt;
	return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe('TaskExistenceCache', () => {
	it('nunca vista → undefined', () => {
		const cache = new TaskExistenceCache();
		expect(cache.get('x')).toBeUndefined();
	});

	it('hit dentro del TTL: devuelve la tarea cacheada', () => {
		const clock = fakeClock();
		const cache = new TaskExistenceCache(EXISTENCE_CACHE_TTL_MS, clock.now);
		cache.set(task({ id: 'a' }));
		clock.advance(EXISTENCE_CACHE_TTL_MS - 1);
		expect(cache.get('a')?.id).toBe('a');
	});

	it('expira justo al llegar al TTL (y se poda de la caché, no solo se ignora)', () => {
		const clock = fakeClock();
		const cache = new TaskExistenceCache(EXISTENCE_CACHE_TTL_MS, clock.now);
		cache.set(task({ id: 'a' }));
		clock.advance(EXISTENCE_CACHE_TTL_MS);
		expect(cache.get('a')).toBeUndefined();
	});

	it('setAll puebla varias tareas de golpe (listTasks/findTasksByIds)', () => {
		const cache = new TaskExistenceCache();
		cache.setAll([task({ id: 'a' }), task({ id: 'b' })]);
		expect(cache.get('a')?.id).toBe('a');
		expect(cache.get('b')?.id).toBe('b');
	});

	it('invalidate borra la entrada — una mutación local sobre ese id no debe servir el valor viejo', () => {
		const cache = new TaskExistenceCache();
		cache.set(task({ id: 'a' }));
		cache.invalidate('a');
		expect(cache.get('a')).toBeUndefined();
	});

	it('invalidate sobre un id nunca cacheado (listId/sectionId) no revienta — no-op', () => {
		const cache = new TaskExistenceCache();
		expect(() => cache.invalidate('nunca-estuvo')).not.toThrow();
	});

	it('set refresca el TTL (no se queda pegado a la primera vez que se vio)', () => {
		const clock = fakeClock();
		const cache = new TaskExistenceCache(EXISTENCE_CACHE_TTL_MS, clock.now);
		cache.set(task({ id: 'a' }));
		clock.advance(EXISTENCE_CACHE_TTL_MS - 1);
		cache.set(task({ id: 'a' })); // refresca
		clock.advance(EXISTENCE_CACHE_TTL_MS - 1);
		expect(cache.get('a')).toBeDefined();
	});
});

describe('BrlExistenceCache', () => {
	const entry = (id: string): LumbreBrlEntry => ({ id, time: '09:00', entry: `- ${id}` });

	it('nunca vista → false', () => {
		const cache = new BrlExistenceCache();
		expect(cache.has('2026-08-25', 'x')).toBe(false);
	});

	it('hit dentro del TTL tras setAll', () => {
		const clock = fakeClock();
		const cache = new BrlExistenceCache(EXISTENCE_CACHE_TTL_MS, clock.now);
		cache.setAll('2026-08-25', [entry('e1'), entry('e2')]);
		clock.advance(EXISTENCE_CACHE_TTL_MS - 1);
		expect(cache.has('2026-08-25', 'e1')).toBe(true);
		expect(cache.has('2026-08-25', 'e2')).toBe(true);
	});

	it('expira al llegar al TTL', () => {
		const clock = fakeClock();
		const cache = new BrlExistenceCache(EXISTENCE_CACHE_TTL_MS, clock.now);
		cache.setAll('2026-08-25', [entry('e1')]);
		clock.advance(EXISTENCE_CACHE_TTL_MS);
		expect(cache.has('2026-08-25', 'e1')).toBe(false);
	});

	it('la clave es por (date, entryId): el MISMO id en otro día no cuenta como visto', () => {
		const cache = new BrlExistenceCache();
		cache.setAll('2026-08-25', [entry('e1')]);
		expect(cache.has('2026-08-26', 'e1')).toBe(false);
	});

	it('invalidate borra la pareja (date, entryId) — update/delete la deja sin caché', () => {
		const cache = new BrlExistenceCache();
		cache.setAll('2026-08-25', [entry('e1')]);
		cache.invalidate('2026-08-25', 'e1');
		expect(cache.has('2026-08-25', 'e1')).toBe(false);
	});
});
