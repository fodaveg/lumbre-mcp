import { describe, expect, it } from 'vitest';
import {
	clearMutationPending,
	isMutationPending,
	markMutationPending,
	resetSyncFlushRegistryForTests
} from './sync-flush.js';

/**
 * Marca PURA (sin red, `now` inyectable) que respalda `autoFlushSyncIfPending`
 * en `index.ts` — el comportamiento de extremo a extremo (que sobreviva entre
 * peticiones HTTP DISTINTAS, que el flush automático de verdad dispare
 * `refresh_sync`) se testea ahí y en `http.test.ts`; aquí solo la lógica del
 * registro en sí, aislada, mismo criterio que `existence-cache.test.ts`.
 */

/** Reloj inyectable de mentira: empieza en un instante fijo y solo avanza
 *  cuando el test se lo pide — sin `setTimeout`/temporizadores falsos. Mismo
 *  patrón que `existence-cache.test.ts`, aunque aquí ningún test lo mueve
 *  todavía (la marca no tiene TTL, ver el JSDoc de `sync-flush.ts`): se deja
 *  igual para no divergir del resto de tests de registro por token. */
function fakeClock(startAt = 1_000_000) {
	let now = startAt;
	return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe('marca "mutación pendiente de flush" por token', () => {
	it('un token nunca marcado no tiene mutación pendiente', () => {
		resetSyncFlushRegistryForTests();
		expect(isMutationPending('tok-a')).toBe(false);
	});

	it('markMutationPending pone la marca; clearMutationPending la limpia', () => {
		resetSyncFlushRegistryForTests();
		markMutationPending('tok-b');
		expect(isMutationPending('tok-b')).toBe(true);
		clearMutationPending('tok-b');
		expect(isMutationPending('tok-b')).toBe(false);
	});

	it('dos tokens no comparten marca: marcar uno no marca el otro', () => {
		resetSyncFlushRegistryForTests();
		markMutationPending('tok-c');
		expect(isMutationPending('tok-c')).toBe(true);
		expect(isMutationPending('tok-d')).toBe(false);
	});

	it('clearMutationPending sobre un token nunca marcado no revienta — no-op', () => {
		resetSyncFlushRegistryForTests();
		expect(() => clearMutationPending('tok-nunca-marcado')).not.toThrow();
		expect(isMutationPending('tok-nunca-marcado')).toBe(false);
	});

	it('marcar dos veces seguidas sigue dejando la marca puesta (idempotente)', () => {
		resetSyncFlushRegistryForTests();
		const clock = fakeClock();
		markMutationPending('tok-e', clock.now);
		markMutationPending('tok-e', clock.now);
		expect(isMutationPending('tok-e', clock.now)).toBe(true);
	});

	it('resetSyncFlushRegistryForTests limpia TODOS los tokens, no solo uno', () => {
		markMutationPending('tok-f');
		markMutationPending('tok-g');
		resetSyncFlushRegistryForTests();
		expect(isMutationPending('tok-f')).toBe(false);
		expect(isMutationPending('tok-g')).toBe(false);
	});
});
