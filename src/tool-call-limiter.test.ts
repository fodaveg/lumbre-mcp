import { describe, expect, it, vi } from 'vitest';
import {
	DEFAULT_MAX_TOOL_CALLS_IN_FLIGHT,
	DEFAULT_MAX_TOOL_CALLS_PER_BEARER,
	ToolCallLimiter,
	toolCallLimitsFromEnv
} from './tool-call-limiter.js';

describe('ToolCallLimiter — semáforo sin cola, global y por credencial', () => {
	it('acota por credencial y en global, y libera al soltar', () => {
		const limiter = new ToolCallLimiter({ global: 3, perBearer: 2 });
		const a1 = limiter.tryAcquire('tok-a');
		const a2 = limiter.tryAcquire('tok-a');
		expect(a1).toBeDefined();
		expect(a2).toBeDefined();
		// Tercera de la misma credencial: su tope (2), aunque quede hueco global.
		expect(limiter.tryAcquire('tok-a')).toBeUndefined();
		const b1 = limiter.tryAcquire('tok-b');
		expect(b1).toBeDefined();
		// Global lleno (3): otra credencial distinta tampoco entra.
		expect(limiter.tryAcquire('tok-c')).toBeUndefined();
		expect(limiter.inFlight).toBe(3);

		a1!();
		expect(limiter.inFlight).toBe(2);
		expect(limiter.tryAcquire('tok-c')).toBeDefined();
	});

	it('soltar dos veces no descuenta dos', () => {
		const limiter = new ToolCallLimiter({ global: 2, perBearer: 1 });
		const release = limiter.tryAcquire('tok')!;
		const other = limiter.tryAcquire('otro')!;
		release();
		release();
		expect(limiter.inFlight).toBe(1);
		// Y el cupo de `tok` vuelve a ser exactamente 1.
		expect(limiter.tryAcquire('tok')).toBeDefined();
		expect(limiter.tryAcquire('tok')).toBeUndefined();
		other();
	});

	it('no guarda la credencial en claro', () => {
		const limiter = new ToolCallLimiter({ global: 2, perBearer: 2 });
		limiter.tryAcquire('lm_at_secreto-que-no-debe-quedarse');
		const keys = [...(limiter as unknown as { perKey: Map<string, number> }).perKey.keys()];
		expect(keys).toHaveLength(1);
		expect(keys[0]).toMatch(/^[0-9a-f]{32}$/);
		expect(keys[0]).not.toContain('secreto');
	});
});

describe('toolCallLimitsFromEnv', () => {
	it('sin variables: los defectos documentados (32 global, 8 por credencial)', () => {
		expect(toolCallLimitsFromEnv({})).toEqual({
			global: DEFAULT_MAX_TOOL_CALLS_IN_FLIGHT,
			perBearer: DEFAULT_MAX_TOOL_CALLS_PER_BEARER
		});
		expect(DEFAULT_MAX_TOOL_CALLS_IN_FLIGHT).toBe(32);
		expect(DEFAULT_MAX_TOOL_CALLS_PER_BEARER).toBe(8);
	});

	it('lee enteros válidos y nunca deja el tope por credencial por encima del global', () => {
		expect(toolCallLimitsFromEnv({ LUMBRE_MCP_MAX_TOOL_CALLS: '64', LUMBRE_MCP_MAX_TOOL_CALLS_PER_BEARER: '16' })).toEqual({
			global: 64,
			perBearer: 16
		});
		expect(toolCallLimitsFromEnv({ LUMBRE_MCP_MAX_TOOL_CALLS: '4', LUMBRE_MCP_MAX_TOOL_CALLS_PER_BEARER: '16' })).toEqual({
			global: 4,
			perBearer: 4
		});
	});

	it('un valor mal puesto cae al defecto (nunca a "sin tope") y lo dice sin copiar el valor', () => {
		const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			for (const bad of ['0', '-1', 'abc', '1e3', '12.5', '999999', 'Infinity']) {
				expect(toolCallLimitsFromEnv({ LUMBRE_MCP_MAX_TOOL_CALLS: bad }).global, bad).toBe(32);
			}
			const lines = errorLog.mock.calls.map((args) => args.join(' ')).join('\n');
			expect(lines).toContain('LUMBRE_MCP_MAX_TOOL_CALLS no es un entero');
			expect(lines).not.toContain('abc');
		} finally {
			errorLog.mockRestore();
		}
	});
});
