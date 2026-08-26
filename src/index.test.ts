import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';

/**
 * Test de regresión de la superficie de tools del MCP (tarea "bajar el coste
 * en tokens de `tools/list` sin tocar `dist/`", 2026-07-25): guardarraíl
 * contra que alguien vuelva a inflarla sin darse cuenta (el techo de bytes de
 * abajo) y contra que el aplanado de `mutate_tasks` haya dejado colar/
 * bloqueado algo que no debía.
 *
 * Desde M1 (portabilidad, ver `createServer`/`CreateServerOptions` en
 * `index.ts`): importar `./index.js` ya no hace NADA por sí solo (ni
 * `loadConfig()`, que puede `process.exit(1)`, ni conectar ningún
 * transporte) — el setup de abajo construye el servidor a mano con
 * `createServer(config)` y lo conecta a un `InMemoryTransport` de test, sobre
 * el que se aplica la MISMA `stripToolsListSchema` que usa `main()` en
 * producción (no una réplica de su lógica), para poder comprobar el
 * `tools/list` REAL que vería un cliente, incluida la limpieza de `$schema`.
 */

let tools: Tool[];
let mutateTasksOpSchema: z.ZodTypeAny;
let mutateTasksStrictOpSchema: z.ZodTypeAny;
let effectiveNotesMode: (input: { notes?: string; fullNotes?: boolean }) => string;
let refTexts: (
	tasks: { id: string; content: string; notes: string | null }[],
	notesMode: string,
	autoRender?: { perTask: Map<string, { kind: string }> }
) => (string | null | undefined)[];

/** Config de prueba — ningún test de este fichero toca red de verdad sin
 *  mockear `fetch` antes (ver el describe de la caché, más abajo). */
const TEST_CONFIG = { baseUrl: 'https://lumbre.test', token: 'test-token-para-index-test' };

beforeAll(async () => {
	const indexModule = await import('./index.js');
	mutateTasksOpSchema = indexModule.mutateTasksOpSchema;
	mutateTasksStrictOpSchema = indexModule.mutateTasksStrictOpSchema;
	effectiveNotesMode = indexModule.effectiveNotesMode;
	refTexts = indexModule.refTexts as typeof refTexts;

	const server = indexModule.createServer(TEST_CONFIG);

	const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
	const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');

	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	indexModule.stripToolsListSchema(serverTransport);
	await server.connect(serverTransport);

	const client = new Client({ name: 'index-test-client', version: '0.0.0' });
	await client.connect(clientTransport);
	const result = await client.listTools();
	// `InMemoryTransport` (a diferencia de `StdioServerTransport`, ver
	// `stdio.js`) NO serializa a JSON — pasa el objeto JS tal cual por
	// referencia. Un `title: undefined` (la key SIGUE ahí, `tool.title` sin
	// asignar, solo su VALOR es `undefined`) sobrevive así al viaje in-memory,
	// pero jamás cruzaría stdio de verdad: `JSON.stringify` omite las keys con
	// valor `undefined`. Este roundtrip replica ESA serialización para que lo
	// que miden los tests de abajo (presencia de `title`, bytes totales) sea
	// lo que un cliente MCP real recibiría por stdio, no un artefacto del
	// transporte de test.
	tools = JSON.parse(JSON.stringify(result.tools));
}, 20000);

describe('tools/list — superficie completa', () => {
	const EXPECTED_TOOL_NAMES = [
		'add_task',
		'refresh_sync',
		'list_tasks',
		'list_lists',
		'get_task',
		'read_attachment',
		'complete_task',
		'cancel_task',
		'update_task',
		'reschedule_task',
		'delete_task',
		'set_section',
		'remove_section',
		'create_list',
		'nest_list',
		'rename_list',
		'remove_list',
		'move_to_list',
		'add_subtask',
		'complete_subtask',
		'mutate_tasks',
		'list_brl_entries',
		'add_brl_entry',
		'update_brl_entry',
		'delete_brl_entry'
	];

	it('sigue exponiendo las 25 tools, por nombre', () => {
		expect(tools).toHaveLength(25);
		expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
	});

	it('ninguna tool trae `title` (tarea d: quitados de las 21 registraciones)', () => {
		for (const tool of tools) {
			expect(tool).not.toHaveProperty('title');
		}
	});

	it('ningún `inputSchema` (a ningún nivel de anidación) trae `$schema` (tarea c)', () => {
		const hasSchemaKey = (value: unknown): boolean => {
			if (Array.isArray(value)) return value.some(hasSchemaKey);
			if (value && typeof value === 'object') {
				if ('$schema' in value) return true;
				return Object.values(value).some(hasSchemaKey);
			}
			return false;
		};
		for (const tool of tools) {
			expect(hasSchemaKey(tool.inputSchema)).toBe(false);
		}
	});

	it('techo de bytes de las 25 tools: no crece sin que alguien se entere', () => {
		// Medido 2026-07-25, tras (a)+(c)+(d)+(e) — (e) = comprimir las 21
		// `description` (prosa/historia movida a JSDoc/README, ver la cabecera de
		// este fichero y `ASYNC_NOTE` en index.ts): `JSON.stringify` de las 21
		// tools de `tools/list` (ya sin `$schema` ni `title`) da 20.049
		// caracteres — verificado DOS veces con el mismo resultado: aquí
		// (transporte in-memory) y compilando a un dir temporal fuera de
		// `dist/` y hablando MCP de verdad por stdio con él (mismo
		// procedimiento que (a)+(c)+(d)). Antes de (e): 29.307. Antes de
		// (a)+(c)+(d): 36.495. Re-medido el mismo día tras añadir `list_tasks
		// ({ notes: 'auto'|'none'|'preview'|'full' })` (garantía de notas
		// íntegras-o-marcador — ver `notes.ts`): 20.611 (el enum nuevo + su
		// `.describe()` + el aviso de `fullNotes` deprecated suman ~560 chars).
		// Re-medido el mismo día tras exponer `notesUpdatedAt`/el cierre del
		// hueco de la capa 2 (marca en vez de hash) + `notesRecentHours` +
		// `notesSince` (consulta de precisión) en `list_tasks`: 21.596 (~985
		// chars más que los 20.611 de arriba, sobre todo la `.describe()` de
		// `notesSince` y el criterio ampliado de `notes`).
		// Re-medido el 2026-07-26 tras añadir `scope: 'upcoming'` + `days` (ventana
		// rodante, paridad con `GET /api/tasks?scope=upcoming`): 21.863 (+267).
		// La resolución EN VIVO de referencias (`refs.ts`) NO suma nada aquí: no
		// añade ningún parámetro ni tool, solo cambia lo que se PINTA en la salida.
		// Re-medido el 2026-08-09 tras las CUATRO tools de BRL (`list_brl_entries`
		// + los tres verbos): 24.339 = +2.743 sobre los 21.596 de arriba
		// (462+778+862+637 de las cuatro, más sus 4 comas). Que ese crecimiento
		// sea superficie NUEVA —un dominio que el MCP no cubría— y no prosa
		// recolada en las de siempre está MEDIDO, no razonado: serializando solo
		// las 21 anteriores por este mismo camino in-memory salen 21.596 clavados,
		// el mismo número que antes de este lote.
		// Re-medido el mismo día tras `add_brl_entry({ time })` (David: volcar la
		// libreta de papel con su hora, en vez de la hora del reloj al llamar a
		// la tool): 24.669 = +330 sobre los 24.339 de arriba, solo el campo
		// nuevo y su `.describe()`.
		// Re-medido el 2026-08-25 tras podar `mutateTasksOpSchema` (ver su
		// JSDoc en index.ts): 24.358 = -311 sobre los 24.669 de arriba (el
		// `inputSchema` de `mutate_tasks`, medido aparte, bajó de 3.994 a
		// 3.683 caracteres). Techo bajado junto con el número medido, para
		// que la ganancia quede bloqueada.
		// Re-medido tras integrar refs+upcoming/days en `list_tasks` (merge del
		// 26 ago): el número real se comprueba abajo, ver CHAR_CEILING.
		// Techo = medido + ~5% de holgura, no el valor exacto, para no tener
		// que tocar este test por variaciones triviales de formato JSON.
		const CHAR_CEILING = 25600;
		const size = JSON.stringify(tools).length;
		expect(size).toBeLessThan(CHAR_CEILING);
	});

	// David, 9 ago 2026: apunta el BRL en una libreta de papel CON su hora y
	// luego lo vuelca a Lumbre — sin `time` en `add_brl_entry`, la API solo
	// sabía sellar la hora del reloj al llamar a la tool. `time` es opcional
	// (Zod `.optional()`), así que NO puede aparecer en `required` — mismo
	// criterio que `date`/`deadline` en `add_task`, que tampoco están.
	it('`add_brl_entry` expone `time` "HH:MM" (24h) OPCIONAL, con el mismo patrón que `add_task`', () => {
		const addBrlEntry = tools.find((t) => t.name === 'add_brl_entry');
		expect(addBrlEntry).toBeDefined();
		const schema = addBrlEntry!.inputSchema as {
			properties?: Record<string, { type?: string; pattern?: string }>;
			required?: string[];
		};
		expect(schema.properties?.time).toMatchObject({
			type: 'string',
			pattern: '^([01]\\d|2[0-3]):[0-5]\\d$'
		});
		expect(schema.required ?? []).not.toContain('time');

		const addTask = tools.find((t) => t.name === 'add_task');
		const addTaskSchema = addTask!.inputSchema as {
			properties?: Record<string, { pattern?: string }>;
		};
		expect(schema.properties?.time?.pattern).toBe(addTaskSchema.properties?.time?.pattern);
	});

	it('`mutate_tasks` sigue siendo, con diferencia, la tool con más superficie', () => {
		const mutateTasks = tools.find((t) => t.name === 'mutate_tasks');
		expect(mutateTasks).toBeDefined();
		// No es una aserción de tamaño exacto (ver el test de arriba para el
		// techo global) — solo confirma que `ops` sigue siendo un array con un
		// `op` enum de las 15 operaciones (el aplanado no perdió ninguna).
		const opsSchema = (mutateTasks!.inputSchema as { properties?: Record<string, unknown> }).properties?.ops as
			| { items?: { properties?: { op?: { enum?: string[] } } } }
			| undefined;
		expect(opsSchema?.items?.properties?.op?.enum).toHaveLength(15);
	});
});

describe('mutate_tasks — las 15 `op` siguen aceptándose (esquema estricto interno)', () => {
	/** Un caso por op: el payload VÁLIDO mínimo/representativo, y variantes
	 *  INVÁLIDAS por campo que falta y por campo que sobra (ajeno a esa op,
	 *  pero válido en general — p. ej. `date` en `complete`) — mismo criterio
	 *  que exige la tarea: el rechazo de campos ajenos DEBE seguir pasando,
	 *  solo que ahora vive en `mutateTasksStrictOpSchema` (interno), no en el
	 *  schema EXPUESTO (`mutateTasksOpSchema`, deliberadamente laxo). */
	const cases: {
		op: string;
		valid: Record<string, unknown>;
		missingField: string;
		extraField: Record<string, unknown>;
	}[] = [
		{
			op: 'add_task',
			valid: { op: 'add_task', text: 'Comprar leche' },
			missingField: 'text',
			extraField: { op: 'add_task', text: 'x', taskId: '11111111-1111-1111-1111-111111111111' }
		},
		{
			op: 'complete',
			valid: { op: 'complete', taskId: '11111111-1111-1111-1111-111111111111' },
			missingField: 'taskId',
			extraField: { op: 'complete', taskId: '11111111-1111-1111-1111-111111111111', date: '2026-01-01' }
		},
		{
			op: 'cancel',
			valid: { op: 'cancel', taskId: '11111111-1111-1111-1111-111111111111' },
			missingField: 'taskId',
			extraField: { op: 'cancel', taskId: '11111111-1111-1111-1111-111111111111', done: true }
		},
		{
			op: 'update',
			valid: { op: 'update', taskId: '11111111-1111-1111-1111-111111111111', content: 'Nuevo texto' },
			missingField: 'taskId',
			extraField: {
				op: 'update',
				taskId: '11111111-1111-1111-1111-111111111111',
				content: 'x',
				subtasks: ['a']
			}
		},
		{
			op: 'reschedule',
			valid: { op: 'reschedule', taskId: '11111111-1111-1111-1111-111111111111', date: '2026-01-01' },
			missingField: 'date',
			extraField: {
				op: 'reschedule',
				taskId: '11111111-1111-1111-1111-111111111111',
				date: null,
				done: true
			}
		},
		{
			op: 'delete',
			valid: { op: 'delete', taskId: '11111111-1111-1111-1111-111111111111' },
			missingField: 'taskId',
			extraField: { op: 'delete', taskId: '11111111-1111-1111-1111-111111111111', name: 'x' }
		},
		{
			op: 'set_section',
			valid: { op: 'set_section', taskId: '11111111-1111-1111-1111-111111111111', section: 'Bugs' },
			missingField: 'section',
			extraField: {
				op: 'set_section',
				taskId: '11111111-1111-1111-1111-111111111111',
				section: null,
				list: 'x'
			}
		},
		{
			op: 'move_to_list',
			valid: { op: 'move_to_list', taskId: '11111111-1111-1111-1111-111111111111', list: 'Proyecto X' },
			missingField: 'taskId',
			extraField: {
				op: 'move_to_list',
				taskId: '11111111-1111-1111-1111-111111111111',
				list: 'x',
				section: 'y'
			}
		},
		{
			op: 'add_subtask',
			valid: { op: 'add_subtask', taskId: '11111111-1111-1111-1111-111111111111', subtasks: ['a', 'b'] },
			missingField: 'subtasks',
			extraField: {
				op: 'add_subtask',
				taskId: '11111111-1111-1111-1111-111111111111',
				subtasks: ['a'],
				done: true
			}
		},
		{
			op: 'complete_subtask',
			valid: { op: 'complete_subtask', subtaskId: '11111111-1111-1111-1111-111111111111' },
			missingField: 'subtaskId',
			extraField: {
				op: 'complete_subtask',
				subtaskId: '11111111-1111-1111-1111-111111111111',
				taskId: '11111111-1111-1111-1111-111111111111'
			}
		},
		{
			op: 'remove_section',
			valid: { op: 'remove_section', sectionId: '11111111-1111-1111-1111-111111111111' },
			missingField: 'sectionId',
			extraField: { op: 'remove_section', sectionId: '11111111-1111-1111-1111-111111111111', name: 'x' }
		},
		{
			op: 'create_list',
			valid: { op: 'create_list', name: 'Viajes' },
			missingField: 'name',
			extraField: { op: 'create_list', name: 'x', taskId: '11111111-1111-1111-1111-111111111111' }
		},
		{
			op: 'nest_list',
			valid: {
				op: 'nest_list',
				listId: '11111111-1111-1111-1111-111111111111',
				parentId: '22222222-2222-2222-2222-222222222222'
			},
			missingField: 'parentId',
			extraField: {
				op: 'nest_list',
				listId: '11111111-1111-1111-1111-111111111111',
				parentId: null,
				name: 'x'
			}
		},
		{
			op: 'rename_list',
			valid: { op: 'rename_list', listId: '11111111-1111-1111-1111-111111111111', name: 'Nuevo nombre' },
			missingField: 'name',
			extraField: {
				op: 'rename_list',
				listId: '11111111-1111-1111-1111-111111111111',
				name: 'x',
				color: 'red'
			}
		},
		{
			op: 'remove_list',
			valid: { op: 'remove_list', listId: '11111111-1111-1111-1111-111111111111' },
			missingField: 'listId',
			extraField: { op: 'remove_list', listId: '11111111-1111-1111-1111-111111111111', icon: '🎯' }
		}
	];

	it('cubre las 15 operaciones (guardarraíl del propio test)', () => {
		expect(cases.map((c) => c.op).sort()).toEqual(
			[
				'add_task',
				'complete',
				'cancel',
				'update',
				'reschedule',
				'delete',
				'set_section',
				'move_to_list',
				'add_subtask',
				'complete_subtask',
				'remove_section',
				'create_list',
				'nest_list',
				'rename_list',
				'remove_list'
			].sort()
		);
	});

	for (const { op, valid, missingField, extraField } of cases) {
		describe(`op: ${op}`, () => {
			it('caso VÁLIDO: pasa el schema EXPUESTO (tools/list) y el ESTRICTO (handler)', () => {
				expect(mutateTasksOpSchema.safeParse(valid).success).toBe(true);
				expect(mutateTasksStrictOpSchema.safeParse(valid).success).toBe(true);
			});

			it(`caso INVÁLIDO (falta \`${missingField}\`): el schema ESTRICTO lo rechaza`, () => {
				const { [missingField]: _omitted, ...withoutField } = valid;
				const result = mutateTasksStrictOpSchema.safeParse(withoutField);
				expect(result.success).toBe(false);
			});

			it('caso INVÁLIDO (campo ajeno a esta op): el schema ESTRICTO lo rechaza', () => {
				const result = mutateTasksStrictOpSchema.safeParse(extraField);
				expect(result.success).toBe(false);
			});
		});
	}

	it('op desconocida: ambos schemas la rechazan', () => {
		const bogus = { op: 'not_a_real_op', taskId: '11111111-1111-1111-1111-111111111111' };
		expect(mutateTasksOpSchema.safeParse(bogus).success).toBe(false);
		expect(mutateTasksStrictOpSchema.safeParse(bogus).success).toBe(false);
	});

	it('campo con nombre desconocido (typo): el schema EXPUESTO ya lo rechaza (`.strict()`)', () => {
		const result = mutateTasksOpSchema.safeParse({
			op: 'complete',
			taskId: '11111111-1111-1111-1111-111111111111',
			// `donee` no es ninguno de los 21 campos conocidos — typo real de
			// `done`, no un campo válido en otra op (ver el test de arriba para
			// ESE caso, que el schema EXPUESTO SÍ deja pasar a propósito).
			donee: true
		});
		expect(result.success).toBe(false);
	});
});

describe('effectiveNotesMode — resuelve el modo de notas de list_tasks (con el alias legado)', () => {
	it('sin `notes` ni `fullNotes` → "auto" (nuevo default)', () => {
		expect(effectiveNotesMode({})).toBe('auto');
	});

	it('`notes` explícito manda, sea cual sea', () => {
		expect(effectiveNotesMode({ notes: 'none' })).toBe('none');
		expect(effectiveNotesMode({ notes: 'preview' })).toBe('preview');
		expect(effectiveNotesMode({ notes: 'full' })).toBe('full');
		expect(effectiveNotesMode({ notes: 'auto' })).toBe('auto');
	});

	it('`fullNotes: true` sigue equivaliendo a "full" (back-compat, sin `notes`)', () => {
		expect(effectiveNotesMode({ fullNotes: true })).toBe('full');
	});

	it('`fullNotes: false` no cambia el default ("auto")', () => {
		expect(effectiveNotesMode({ fullNotes: false })).toBe('auto');
	});

	it('`notes` explícito GANA a `fullNotes` si ambos vienen', () => {
		expect(effectiveNotesMode({ notes: 'none', fullNotes: true })).toBe('none');
	});
});

describe('caché corta de existencia (M1: requireTaskExists / taskCache)', () => {
	/**
	 * Prueba de extremo a extremo (servidor real vía `createServer` + un
	 * cliente MCP in-memory + `fetch` mockeado): la caché en sí ya se testea
	 * aislada en `existence-cache.test.ts` (hit/expiración/invalidación,
	 * `now` inyectado directo); aquí lo que importa es que `requireTaskExists`
	 * REALMENTE evita/repite el `GET /api/tasks?id=` en el flujo completo de
	 * una tool call, y que una mutación real la invalida.
	 */
	const TASK_ID = '11111111-1111-1111-1111-111111111111';

	function lumbreTask(overrides: Record<string, unknown> = {}) {
		return {
			id: TASK_ID,
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

	function jsonResponse(body: unknown, status = 200): Response {
		return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
	}

	/** Cuenta las llamadas a `GET /api/tasks?id=` (el chequeo de existencia
	 *  de `findTaskById` dentro de `requireTaskExists`) — separado de
	 *  cualquier otra llamada a `/api/tasks` (list_tasks, mutate_tasks). */
	function countExistenceGets(fetchSpy: ReturnType<typeof vi.fn>): number {
		return fetchSpy.mock.calls.filter((call) => String(call[0]).includes('/api/tasks?id=')).length;
	}

	function firstResultText(result: { content: { type: string; text?: string }[] }): string {
		const first = result.content[0];
		return first && first.type === 'text' && typeof first.text === 'string' ? first.text : '';
	}

	async function buildClient(opts: { now?: () => number } = {}) {
		const indexModule = await import('./index.js');
		const server = indexModule.createServer(TEST_CONFIG, opts);
		const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
		const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		indexModule.stripToolsListSchema(serverTransport);
		await server.connect(serverTransport);
		const client = new Client({ name: 'cache-test-client', version: '0.0.0' });
		await client.connect(clientTransport);
		return client;
	}

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('un hit dentro del TTL evita el segundo GET de existencia', async () => {
		const fetchSpy = vi.fn(async (url: string | URL) => {
			const u = String(url);
			if (u.includes('/api/tasks?id=')) return jsonResponse([lumbreTask()]);
			if (u.includes('/api/mutations')) return jsonResponse({ ok: true });
			throw new Error(`fetch no mockeado en este test: ${u}`);
		});
		vi.stubGlobal('fetch', fetchSpy);

		const client = await buildClient();
		// get_task puebla `taskCache` (no consulta la caché, siempre trae fresco).
		await client.callTool({ name: 'get_task', arguments: { taskId: TASK_ID } });
		expect(countExistenceGets(fetchSpy)).toBe(1);

		// complete_task → requireTaskExists reutiliza el hit: SIN GET nuevo.
		const result = await client.callTool({ name: 'complete_task', arguments: { taskId: TASK_ID } });
		expect(result.isError).not.toBe(true);
		expect(countExistenceGets(fetchSpy)).toBe(1);
	});

	it('tras expirar el TTL, requireTaskExists vuelve a pedir', async () => {
		const { EXISTENCE_CACHE_TTL_MS } = await import('./existence-cache.js');
		let now = 1_000_000;
		const fetchSpy = vi.fn(async (url: string | URL) => {
			const u = String(url);
			if (u.includes('/api/tasks?id=')) return jsonResponse([lumbreTask()]);
			if (u.includes('/api/mutations')) return jsonResponse({ ok: true });
			throw new Error(`fetch no mockeado en este test: ${u}`);
		});
		vi.stubGlobal('fetch', fetchSpy);

		const client = await buildClient({ now: () => now });
		await client.callTool({ name: 'get_task', arguments: { taskId: TASK_ID } });
		expect(countExistenceGets(fetchSpy)).toBe(1);

		now += EXISTENCE_CACHE_TTL_MS; // justo al TTL: ya expiró (ver TaskExistenceCache.get)
		await client.callTool({ name: 'complete_task', arguments: { taskId: TASK_ID } });
		expect(countExistenceGets(fetchSpy)).toBe(2);
	});

	it('una mutación LOCAL sobre el id invalida la caché — la siguiente vuelve a pedir', async () => {
		const fetchSpy = vi.fn(async (url: string | URL) => {
			const u = String(url);
			if (u.includes('/api/tasks?id=')) return jsonResponse([lumbreTask()]);
			if (u.includes('/api/mutations')) return jsonResponse({ ok: true });
			throw new Error(`fetch no mockeado en este test: ${u}`);
		});
		vi.stubGlobal('fetch', fetchSpy);

		const client = await buildClient();
		await client.callTool({ name: 'get_task', arguments: { taskId: TASK_ID } });
		expect(countExistenceGets(fetchSpy)).toBe(1);

		await client.callTool({ name: 'complete_task', arguments: { taskId: TASK_ID } });
		expect(countExistenceGets(fetchSpy)).toBe(1); // hit — sin GET nuevo

		// complete_task mutó localmente el mismo id → invalida `taskCache`.
		await client.callTool({ name: 'cancel_task', arguments: { taskId: TASK_ID } });
		expect(countExistenceGets(fetchSpy)).toBe(2);
	});

	it('un id inexistente sigue dando el error claro de siempre (sin caché de por medio)', async () => {
		const fetchSpy = vi.fn(async (url: string | URL) => {
			const u = String(url);
			if (u.includes('/api/tasks?id=')) return jsonResponse([]); // no existe
			throw new Error(`fetch no mockeado en este test: ${u}`);
		});
		vi.stubGlobal('fetch', fetchSpy);

		const client = await buildClient();
		const result = await client.callTool({ name: 'complete_task', arguments: { taskId: TASK_ID } });
		expect(result.isError).toBe(true);
		expect(firstResultText(result as { content: { type: string; text?: string }[] })).toMatch(/no existe/i);
	});
});

describe('list_tasks({notes:"auto"}) — notas en dos fases (perf, 2026-08-25)', () => {
	/**
	 * `notesSeenStore` en memoria por test (no toca disco): las tareas de este
	 * describe deciden íntegra/marcador SOLO por capa 1 (`@done`) o por
	 * bootstrap con una `notesUpdatedAt` bien vieja (fuera de cualquier
	 * ventana razonable) — a propósito, para que el resultado no dependa del
	 * reloj real ni de una huella previa.
	 */
	function memoryNotesSeenStore() {
		let state: Record<string, unknown> = {};
		return {
			async load() {
				return state;
			},
			async save(next: Record<string, unknown>) {
				state = next;
			}
		};
	}

	function jsonResponse(body: unknown, status = 200): Response {
		return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
	}

	function textOf(result: { content: { type: string; text?: string }[] }): string {
		const first = result.content[0];
		return first && first.type === 'text' && typeof first.text === 'string' ? first.text : '';
	}

	async function buildClient(fetchSpy: ReturnType<typeof vi.fn>) {
		vi.stubGlobal('fetch', fetchSpy);
		const indexModule = await import('./index.js');
		const server = indexModule.createServer(TEST_CONFIG, { notesSeenStore: memoryNotesSeenStore() });
		const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
		const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		indexModule.stripToolsListSchema(serverTransport);
		await server.connect(serverTransport);
		const client = new Client({ name: 'two-phase-test-client', version: '0.0.0' });
		await client.connect(clientTransport);
		return client;
	}

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const DONE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
	const MARKER_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
	const FULL_TEXT = `${'Contexto largo de seguimiento. '.repeat(10)}Fin.`;
	const MARKER_NOTE_LEN = 55;

	/** Tarea `@done` — decide SIEMPRE íntegra (capa 1, sin depender de huella
	 *  ni reloj — ver `decideAutoNoteRender`). */
	function doneTask(overrides: Record<string, unknown> = {}) {
		return {
			id: DONE_ID,
			content: 'Cerrar informe @done',
			notes: null,
			notesUpdatedAt: '2020-01-01T00:00:00.000Z',
			done: false,
			priority: null,
			date: null,
			deadline: null,
			list: null,
			createdAt: new Date().toISOString(),
			...overrides
		};
	}

	/** Tarea sin tag y con `notesUpdatedAt` bien vieja — decide SIEMPRE
	 *  marcador (fuera de cualquier ventana de bootstrap razonable). */
	function markerTask(overrides: Record<string, unknown> = {}) {
		return {
			id: MARKER_ID,
			content: 'Revisar borrador',
			notes: null,
			notesUpdatedAt: '2020-01-01T00:00:00.000Z',
			done: false,
			priority: null,
			date: null,
			deadline: null,
			list: null,
			createdAt: new Date().toISOString(),
			...overrides
		};
	}

	it('servidor NUEVO: fase 1 con notes=length + fase 2 SOLO con los ids que salieron íntegros', async () => {
		const fetchSpy = vi.fn(async (url: string | URL) => {
			const u = String(url);
			if (u.includes('/api/tasks?ids=')) return jsonResponse([doneTask({ notes: FULL_TEXT })]);
			if (u.includes('/api/tasks?')) {
				return jsonResponse([
					doneTask({ notesLength: FULL_TEXT.trim().length }),
					markerTask({ notesLength: MARKER_NOTE_LEN })
				]);
			}
			throw new Error(`fetch no mockeado en este test: ${u}`);
		});
		const client = await buildClient(fetchSpy);

		const result = await client.callTool({ name: 'list_tasks', arguments: {} });
		const text = textOf(result as { content: { type: string; text?: string }[] });

		expect(fetchSpy).toHaveBeenCalledTimes(2);
		const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
		const phase1Url = urls.find((u) => !u.includes('ids='))!;
		const phase2Url = urls.find((u) => u.includes('ids='))!;
		expect(phase1Url).toContain('notes=length');
		expect(phase2Url).toContain(`ids=${DONE_ID}`);
		expect(phase2Url).not.toContain(MARKER_ID); // solo el id íntegro, NO el del marcador
		expect(phase2Url).toContain('notes=full');

		expect(text).toContain(FULL_TEXT.trim());
		expect(text).toContain(`✎${MARKER_NOTE_LEN}`);
	});

	it('servidor VIEJO (sin `notesLength` en la respuesta): UNA sola petición — mismo resultado que sin esta feature', async () => {
		const fetchSpy = vi.fn(async (url: string | URL) => {
			const u = String(url);
			if (u.includes('/api/tasks?')) {
				// Ignora `notes=length` (versión previa del servidor) y da las
				// notas enteras igual — SIN el campo `notesLength`.
				return jsonResponse([
					doneTask({ notes: FULL_TEXT }),
					markerTask({ notes: 'nota corta del todo' })
				]);
			}
			throw new Error(`fetch no mockeado en este test: ${u}`);
		});
		const client = await buildClient(fetchSpy);

		const result = await client.callTool({ name: 'list_tasks', arguments: {} });
		const text = textOf(result as { content: { type: string; text?: string }[] });

		// La aserción más importante del lote: CERO peticiones extra.
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(text).toContain(FULL_TEXT.trim());
		expect(text).toContain(`✎${'nota corta del todo'.length}`);
	});

	it('servidor NUEVO, ninguna decisión íntegra: la fase 2 NO se manda (conjunto vacío)', async () => {
		const fetchSpy = vi.fn(async (url: string | URL) => {
			const u = String(url);
			if (u.includes('/api/tasks?')) return jsonResponse([markerTask({ notesLength: MARKER_NOTE_LEN })]);
			throw new Error(`fetch no mockeado en este test: ${u}`);
		});
		const client = await buildClient(fetchSpy);

		const result = await client.callTool({ name: 'list_tasks', arguments: {} });
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const text = textOf(result as { content: { type: string; text?: string }[] });
		expect(text).toContain(`✎${MARKER_NOTE_LEN}`);
	});

	it('fase 2 no trae la tarea (borrada entre medias): repliegue a MARCADOR, nunca a medias ni vacía', async () => {
		const fetchSpy = vi.fn(async (url: string | URL) => {
			const u = String(url);
			if (u.includes('/api/tasks?ids=')) return jsonResponse([]); // ya no existe
			if (u.includes('/api/tasks?')) return jsonResponse([doneTask({ notesLength: FULL_TEXT.trim().length })]);
			throw new Error(`fetch no mockeado en este test: ${u}`);
		});
		const client = await buildClient(fetchSpy);

		const result = await client.callTool({ name: 'list_tasks', arguments: {} });
		expect(result.isError).not.toBe(true);
		const text = textOf(result as { content: { type: string; text?: string }[] });

		expect(text).not.toContain(FULL_TEXT.trim().slice(0, 50));
		expect(text).toContain(`✎${FULL_TEXT.trim().length}`);
	});

	it('fase 2 falla del todo (500): repliegue a MARCADOR sin romper el listado entero', async () => {
		const fetchSpy = vi.fn(async (url: string | URL) => {
			const u = String(url);
			if (u.includes('/api/tasks?ids=')) return jsonResponse({ message: 'boom' }, 500);
			if (u.includes('/api/tasks?')) return jsonResponse([doneTask({ notesLength: FULL_TEXT.trim().length })]);
			throw new Error(`fetch no mockeado en este test: ${u}`);
		});
		const client = await buildClient(fetchSpy);

		const result = await client.callTool({ name: 'list_tasks', arguments: {} });
		expect(result.isError).not.toBe(true);
		const text = textOf(result as { content: { type: string; text?: string }[] });

		expect(text).not.toContain(FULL_TEXT.trim().slice(0, 50));
		expect(text).toContain(`✎${FULL_TEXT.trim().length}`);
	});
});

describe('list_tasks — scope "upcoming" (ventana rodante) y su `days`', () => {
	function listTasksSchema() {
		return (
			tools.find((t) => t.name === 'list_tasks')!.inputSchema as {
				properties: Record<string, { enum?: string[]; type?: string; minimum?: number; maximum?: number }>;
			}
		).properties;
	}

	it('el enum de `scope` incluye "upcoming" junto a los seis de siempre', () => {
		expect(listTasksSchema().scope.enum).toEqual([
			'today',
			'week',
			'upcoming',
			'inbox',
			'someday',
			'overdue',
			'all'
		]);
	});

	it('`days` existe y está topado a 1..14 (el mismo techo que la app)', () => {
		const days = listTasksSchema().days;
		expect(days).toBeDefined();
		expect(days.minimum).toBe(1);
		expect(days.maximum).toBe(14);
	});
});

describe('refTexts — qué textos se escanean buscando referencias', () => {
	const conNota = { id: 'a', content: 'tarea A', notes: 'nota de A' };
	const sinNota = { id: 'b', content: 'tarea B', notes: null };

	it('siempre el contenido; las notas solo si se van a pintar', () => {
		expect(refTexts([conNota, sinNota], 'full')).toEqual([
			'tarea A',
			'nota de A',
			'tarea B',
			null
		]);
	});

	it('`notes: "none"` no escanea ninguna nota (no se va a mostrar)', () => {
		expect(refTexts([conNota], 'none')).toEqual(['tarea A']);
	});

	it('`auto`: solo las notas que salen ÍNTEGRAS, no las que salen como marcador', () => {
		const autoRender = { perTask: new Map([['a', { kind: 'marker' }]]) };
		expect(refTexts([conNota], 'auto', autoRender)).toEqual(['tarea A']);
		const full = { perTask: new Map([['a', { kind: 'full' }]]) };
		expect(refTexts([conNota], 'auto', full)).toEqual(['tarea A', 'nota de A']);
	});
});
