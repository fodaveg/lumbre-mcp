import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import type { NotesMode } from './notes.js';

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
let mutateBrlOpSchema: z.ZodTypeAny;
let mutateBrlStrictOpSchema: z.ZodTypeAny;
let effectiveNotesMode: (input: { notes?: NotesMode; fullNotes?: boolean }) => NotesMode;
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
	mutateBrlOpSchema = indexModule.mutateBrlOpSchema;
	mutateBrlStrictOpSchema = indexModule.mutateBrlStrictOpSchema;
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

// El registro de `taskCache`/`brlCache` (`existence-cache.ts`) es de MÓDULO,
// indexado por token (M2) — y TODOS los tests de este fichero comparten
// `TEST_CONFIG.token`. Sin este reset, un `taskId` reciclado entre tests (o
// el bundle entero, con su `now` congelado) se colaría de un test al
// siguiente en vez de partir de una caché limpia, como pasaba antes de M2
// (una `taskCache` nueva por cada `createServer`).
beforeEach(async () => {
	const { resetExistenceCacheRegistryForTests } = await import('./existence-cache.js');
	resetExistenceCacheRegistryForTests();
});

describe('tools/list — superficie completa', () => {
	const EXPECTED_TOOL_NAMES = [
		'add_task',
		'refresh_sync',
		'list_tasks',
		'list_lists',
		'get_task',
		'read_attachment',
		'add_attachment',
		'complete_task',
		'cancel_task',
		'update_task',
		'reschedule_task',
		'delete_task',
		'set_section',
		'remove_section',
		'add_subtask',
		'complete_subtask',
		'mutate_tasks',
		'list_brl_entries',
		'mutate_brl'
	];

	it('sigue exponiendo las 19 tools, por nombre (podadas create_list/nest_list/rename_list/' +
		'remove_list/move_to_list y add_brl_entry/update_brl_entry/delete_brl_entry el 2026-08-27)', () => {
		expect(tools).toHaveLength(19);
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

	it('techo de bytes de las 19 tools: no crece sin que alguien se entere', () => {
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
		// Re-medido el 2026-08-26 tras integrar refs+upcoming/days en
		// `list_tasks` (merge de e6534ee) y añadir `add_attachment` (sube un
		// fichero LOCAL, ver `attachments.ts`): 25.399 sobre transporte
		// in-memory (26 tools). Techo subido junto con el número medido.
		// Re-medido el 2026-08-27 tras ampliar `add_attachment` a DOS vías
		// (`file_path`/`content_base64`, ver `remoteFileAccessError` en
		// index.ts): 26.578 = +1.179 sobre los 25.399 de arriba (el segundo
		// campo, su `filename` ahora condicional, y la description ampliada
		// para explicar cuándo usar cada vía). Sigue siendo 26 tools —
		// ninguna tool nueva, solo más superficie en la existente. Techo
		// subido junto con el número medido.
		// Re-medido el mismo día (lote "bajar el coste de tools/list", 2
		// cambios independientes): (1) las 5 tools sueltas de lista
		// (`create_list`/`nest_list`/`rename_list`/`remove_list`/
		// `move_to_list`) se BORRAN — `mutate_tasks` ya cubría exactamente las
		// mismas ops, con el mismo shape (`translateOp` en `lumbre-client.ts`).
		// (2) `add_brl_entry`/`update_brl_entry`/`delete_brl_entry` se
		// SUSTITUYEN por `mutate_brl` (mismo patrón que `mutate_tasks`, pero
		// SIN `runBatch` — no hay `/api/batch` para el BRL, así que es un
		// `mutateTask` por op, en el orden pedido). `list_brl_entries` se
		// queda tal cual. Resultado: 19 tools, 22.198 caracteres — -4.380
		// sobre los 26.578 de arriba (-16,5%). `mutate_brl` completo (nombre +
		// description + inputSchema) pesa 1.684 — medido aparte porque el
		// riesgo conocido de agrupar ops bajo un discriminante es que arrastre
		// los campos de todas las variantes y no compre nada; 1.684 sigue
		// bajo el resto de tools de escritura). Techo bajado junto con el
		// número medido, para que la ganancia quede bloqueada.
		// Techo = medido + ~5% de holgura, no el valor exacto, para no tener
		// que tocar este test por variaciones triviales de formato JSON.
		const CHAR_CEILING = 23300;
		const size = JSON.stringify(tools).length;
		expect(size).toBeLessThan(CHAR_CEILING);
	});

	// David, 9 ago 2026: apunta el BRL en una libreta de papel CON su hora y
	// luego lo vuelca a Lumbre — sin `time`, la API solo sabía sellar la hora
	// del reloj al llamar a la tool. Migrado a `mutate_brl` el 2026-08-27
	// (`add_brl_entry` ya no existe): `time` sigue opcional (Zod
	// `.optional()`), así que NO puede aparecer en `required` — mismo criterio
	// que `date`/`deadline` en `add_task`, que tampoco están.
	it('`mutate_brl` expone `ops[].time` "HH:MM" (24h) OPCIONAL, con el mismo patrón que `add_task`', () => {
		const mutateBrl = tools.find((t) => t.name === 'mutate_brl');
		expect(mutateBrl).toBeDefined();
		const opsSchema = (mutateBrl!.inputSchema as { properties?: Record<string, unknown> }).properties?.ops as
			| { items?: { properties?: Record<string, { type?: string; pattern?: string }>; required?: string[] } }
			| undefined;
		expect(opsSchema?.items?.properties?.time).toMatchObject({
			type: 'string',
			pattern: '^([01]\\d|2[0-3]):[0-5]\\d$'
		});
		expect(opsSchema?.items?.required ?? []).not.toContain('time');

		const addTask = tools.find((t) => t.name === 'add_task');
		const addTaskSchema = addTask!.inputSchema as {
			properties?: Record<string, { pattern?: string }>;
		};
		expect(opsSchema?.items?.properties?.time?.pattern).toBe(addTaskSchema.properties?.time?.pattern);
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

	it('`mutate_brl` expone las 3 ops (add/update/delete)', () => {
		const mutateBrl = tools.find((t) => t.name === 'mutate_brl');
		expect(mutateBrl).toBeDefined();
		const opsSchema = (mutateBrl!.inputSchema as { properties?: Record<string, unknown> }).properties?.ops as
			| { items?: { properties?: { op?: { enum?: string[] } } } }
			| undefined;
		expect(opsSchema?.items?.properties?.op?.enum?.sort()).toEqual(['add', 'delete', 'update']);
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

describe('mutate_brl — las 3 `op` siguen aceptándose (esquema estricto interno)', () => {
	/** Mismo criterio que las de `mutate_tasks` arriba: un caso por op, con
	 *  variantes INVÁLIDAS por campo que falta y por campo que sobra (ajeno a
	 *  esa op, pero válido en general) — el rechazo de campos ajenos vive en
	 *  `mutateBrlStrictOpSchema` (interno), no en el schema EXPUESTO
	 *  (`mutateBrlOpSchema`, deliberadamente laxo, igual que el de tareas). */
	const cases: {
		op: string;
		valid: Record<string, unknown>;
		missingField: string;
		extraField: Record<string, unknown>;
	}[] = [
		{
			op: 'add',
			valid: { op: 'add', date: '2026-08-27', text: 'Comprado el pan' },
			missingField: 'text',
			extraField: { op: 'add', date: '2026-08-27', text: 'x', entryId: '11111111-1111-1111-1111-111111111111' }
		},
		{
			op: 'update',
			valid: {
				op: 'update',
				date: '2026-08-27',
				entryId: '11111111-1111-1111-1111-111111111111',
				text: 'Texto nuevo'
			},
			missingField: 'text',
			extraField: {
				op: 'update',
				date: '2026-08-27',
				entryId: '11111111-1111-1111-1111-111111111111',
				text: 'x',
				time: '09:00'
			}
		},
		{
			op: 'delete',
			valid: { op: 'delete', date: '2026-08-27', entryId: '11111111-1111-1111-1111-111111111111' },
			missingField: 'entryId',
			extraField: {
				op: 'delete',
				date: '2026-08-27',
				entryId: '11111111-1111-1111-1111-111111111111',
				text: 'x'
			}
		}
	];

	it('cubre las 3 operaciones (guardarraíl del propio test)', () => {
		expect(cases.map((c) => c.op).sort()).toEqual(['add', 'delete', 'update']);
	});

	for (const { op, valid, missingField, extraField } of cases) {
		describe(`op: ${op}`, () => {
			it('caso VÁLIDO: pasa el schema EXPUESTO (tools/list) y el ESTRICTO (handler)', () => {
				expect(mutateBrlOpSchema.safeParse(valid).success).toBe(true);
				expect(mutateBrlStrictOpSchema.safeParse(valid).success).toBe(true);
			});

			it(`caso INVÁLIDO (falta \`${missingField}\`): el schema ESTRICTO lo rechaza`, () => {
				const { [missingField]: _omitted, ...withoutField } = valid;
				expect(mutateBrlStrictOpSchema.safeParse(withoutField).success).toBe(false);
			});

			it('caso INVÁLIDO (campo ajeno a esta op): el schema ESTRICTO lo rechaza', () => {
				expect(mutateBrlStrictOpSchema.safeParse(extraField).success).toBe(false);
			});
		});
	}

	it('op desconocida: ambos schemas la rechazan', () => {
		const bogus = { op: 'not_a_real_op', date: '2026-08-27' };
		expect(mutateBrlOpSchema.safeParse(bogus).success).toBe(false);
		expect(mutateBrlStrictOpSchema.safeParse(bogus).success).toBe(false);
	});

	it('campo con nombre desconocido (typo): el schema EXPUESTO ya lo rechaza (`.strict()`)', () => {
		const result = mutateBrlOpSchema.safeParse({
			op: 'add',
			date: '2026-08-27',
			text: 'x',
			// `kindd` no es ninguno de los 5 campos conocidos — typo de `kind`.
			kindd: 'note'
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
		// La propiedad que importa no es el TEXTO del mensaje (eso se reescribe),
		// es que sea un error y que nombre el taskId pedido: es lo que lo hace accionable.
		expect(firstResultText(result as { content: { type: string; text?: string }[] })).toContain(TASK_ID);
	});
});

describe('add_attachment — sube un fichero LOCAL y lo enlaza a una tarea (SÍNCRONO)', () => {
	const TASK_ID = '22222222-2222-2222-2222-222222222222';
	const SUB_ID = '33333333-3333-3333-3333-333333333333';

	function lumbreTask(overrides: Record<string, unknown> = {}) {
		return {
			id: TASK_ID,
			content: 'tarea con adjunto',
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

	function firstResultText(result: { content: { type: string; text?: string }[] }): string {
		const first = result.content[0];
		return first && first.type === 'text' && typeof first.text === 'string' ? first.text : '';
	}

	async function buildClient(opts: { localFilesystem?: boolean } = {}) {
		const indexModule = await import('./index.js');
		const server = indexModule.createServer(TEST_CONFIG, opts);
		const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
		const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		indexModule.stripToolsListSchema(serverTransport);
		await server.connect(serverTransport);
		const client = new Client({ name: 'add-attachment-test-client', version: '0.0.0' });
		await client.connect(clientTransport);
		return client;
	}

	let tmpDir: string;
	let filePath: string;

	beforeEach(async () => {
		const { mkdtemp, writeFile } = await import('node:fs/promises');
		const { tmpdir } = await import('node:os');
		const { join } = await import('node:path');
		tmpDir = await mkdtemp(join(tmpdir(), 'lumbre-mcp-add-attachment-test-'));
		filePath = join(tmpDir, 'informe.pdf');
		await writeFile(filePath, Buffer.from('%PDF-1.4 contenido de prueba'));
	});

	afterEach(async () => {
		const { rm } = await import('node:fs/promises');
		await rm(tmpDir, { recursive: true, force: true });
		vi.unstubAllGlobals();
	});

	it('camino feliz: comprueba la tarea, sube los bytes, y NUNCA menciona "sincronizar" (es SÍNCRONO)', async () => {
		const fetchSpy = vi.fn(async (url: string | URL, init?: RequestInit) => {
			const u = String(url);
			if (u.includes('/api/tasks?id=')) return jsonResponse([lumbreTask()]);
			if (u.includes('/api/attachments?taskId=')) {
				expect(init?.method).toBe('POST');
				const headers = init?.headers as Record<string, string>;
				expect(headers.authorization).toBe('Bearer test-token-para-index-test');
				expect(headers['content-type']).toBe('application/octet-stream');
				expect(headers['x-lumbre-content-type']).toBe('application/pdf');
				return jsonResponse({
					id: 'att-1',
					taskId: TASK_ID,
					filename: 'informe.pdf',
					mime: 'application/pdf',
					size: 28,
					storageKey: 'attachments/att-1',
					createdAt: 1_700_000_000_000
				});
			}
			throw new Error(`fetch no mockeado en este test: ${u}`);
		});
		vi.stubGlobal('fetch', fetchSpy);

		const client = await buildClient();
		const result = await client.callTool({
			name: 'add_attachment',
			arguments: { taskId: TASK_ID, file_path: filePath }
		});
		expect(result.isError).not.toBe(true);
		const text = firstResultText(result as { content: { type: string; text?: string }[] });
		expect(text).toContain('att-1');
		expect(text).not.toMatch(/sincroniz/i);
	});

	it('taskId inexistente: error claro, y NINGUNA llamada a /api/attachments', async () => {
		const fetchSpy = vi.fn(async (url: string | URL) => {
			const u = String(url);
			if (u.includes('/api/tasks?id=')) return jsonResponse([]);
			throw new Error(`fetch no mockeado en este test: ${u}`);
		});
		vi.stubGlobal('fetch', fetchSpy);

		const client = await buildClient();
		const result = await client.callTool({
			name: 'add_attachment',
			arguments: { taskId: TASK_ID, file_path: filePath }
		});
		expect(result.isError).toBe(true);
		// La propiedad que importa no es el TEXTO del mensaje (eso se reescribe),
		// es que sea un error y que nombre el taskId pedido: es lo que lo hace accionable.
		expect(firstResultText(result as { content: { type: string; text?: string }[] })).toContain(TASK_ID);
		expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes('/api/attachments'))).toBe(false);
	});

	it('taskId de una SUBTAREA: rechazada, igual que update_task/move_to_list', async () => {
		const fetchSpy = vi.fn(async (url: string | URL) => {
			const u = String(url);
			if (u.includes('/api/tasks?id=')) return jsonResponse([lumbreTask({ id: SUB_ID, parentId: TASK_ID })]);
			throw new Error(`fetch no mockeado en este test: ${u}`);
		});
		vi.stubGlobal('fetch', fetchSpy);

		const client = await buildClient();
		const result = await client.callTool({
			name: 'add_attachment',
			arguments: { taskId: SUB_ID, file_path: filePath }
		});
		expect(result.isError).toBe(true);
		expect(firstResultText(result as { content: { type: string; text?: string }[] })).toMatch(/subtarea/i);
		expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes('/api/attachments'))).toBe(false);
	});

	it('fichero local inexistente: error legible y NINGUNA llamada a /api/attachments', async () => {
		const fetchSpy = vi.fn(async (url: string | URL) => {
			const u = String(url);
			if (u.includes('/api/tasks?id=')) return jsonResponse([lumbreTask()]);
			throw new Error(`fetch no mockeado en este test: ${u}`);
		});
		vi.stubGlobal('fetch', fetchSpy);

		const client = await buildClient();
		const { join } = await import('node:path');
		const result = await client.callTool({
			name: 'add_attachment',
			arguments: { taskId: TASK_ID, file_path: join(tmpDir, 'no-existe.pdf') }
		});
		expect(result.isError).toBe(true);
		expect(firstResultText(result as { content: { type: string; text?: string }[] })).toMatch(/No existe/);
		expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes('/api/attachments'))).toBe(false);
	});

	it('ruta relativa: rechazada, y NUNCA llega a /api/attachments (la tarea sí existe)', async () => {
		const fetchSpy = vi.fn(async (url: string | URL) => {
			const u = String(url);
			if (u.includes('/api/tasks?id=')) return jsonResponse([lumbreTask()]);
			throw new Error(`fetch no mockeado en este test: ${u}`);
		});
		vi.stubGlobal('fetch', fetchSpy);

		const client = await buildClient();
		const result = await client.callTool({
			name: 'add_attachment',
			arguments: { taskId: TASK_ID, file_path: 'informe.pdf' }
		});
		expect(result.isError).toBe(true);
		expect(firstResultText(result as { content: { type: string; text?: string }[] })).toMatch(/absoluta/);
		expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes('/api/attachments'))).toBe(false);
	});

	it('404 del servidor al subir (tarea borrada entre medias): mensaje legible', async () => {
		const fetchSpy = vi.fn(async (url: string | URL) => {
			const u = String(url);
			if (u.includes('/api/tasks?id=')) return jsonResponse([lumbreTask()]);
			if (u.includes('/api/attachments?taskId=')) {
				return jsonResponse({ message: 'La tarea no existe, está borrada o archivada' }, 404);
			}
			throw new Error(`fetch no mockeado en este test: ${u}`);
		});
		vi.stubGlobal('fetch', fetchSpy);

		const client = await buildClient();
		const result = await client.callTool({
			name: 'add_attachment',
			arguments: { taskId: TASK_ID, file_path: filePath }
		});
		expect(result.isError).toBe(true);
		expect(firstResultText(result as { content: { type: string; text?: string }[] })).toMatch(
			/no existe, está borrada o archivada/
		);
	});

	it('413 del servidor: propaga el mensaje EXACTO (tamaño vs cuota)', async () => {
		const fetchSpy = vi.fn(async (url: string | URL) => {
			const u = String(url);
			if (u.includes('/api/tasks?id=')) return jsonResponse([lumbreTask()]);
			if (u.includes('/api/attachments?taskId=')) {
				return jsonResponse({ message: 'Cuota de adjuntos agotada para esta cuenta' }, 413);
			}
			throw new Error(`fetch no mockeado en este test: ${u}`);
		});
		vi.stubGlobal('fetch', fetchSpy);

		const client = await buildClient();
		const result = await client.callTool({
			name: 'add_attachment',
			arguments: { taskId: TASK_ID, file_path: filePath }
		});
		expect(result.isError).toBe(true);
		expect(firstResultText(result as { content: { type: string; text?: string }[] })).toMatch(
			/Cuota de adjuntos agotada/
		);
	});

	it('429 del servidor: mensaje de rate limit', async () => {
		const fetchSpy = vi.fn(async (url: string | URL) => {
			const u = String(url);
			if (u.includes('/api/tasks?id=')) return jsonResponse([lumbreTask()]);
			if (u.includes('/api/attachments?taskId=')) return jsonResponse({ message: 'rate limited' }, 429);
			throw new Error(`fetch no mockeado en este test: ${u}`);
		});
		vi.stubGlobal('fetch', fetchSpy);

		const client = await buildClient();
		const result = await client.callTool({
			name: 'add_attachment',
			arguments: { taskId: TASK_ID, file_path: filePath }
		});
		expect(result.isError).toBe(true);
		expect(firstResultText(result as { content: { type: string; text?: string }[] })).toMatch(/Demasiadas peticiones/);
	});

	it('`filename` explícito gana sobre el basename de `file_path`', async () => {
		const fetchSpy = vi.fn(async (url: string | URL, init?: RequestInit) => {
			const u = String(url);
			if (u.includes('/api/tasks?id=')) return jsonResponse([lumbreTask()]);
			if (u.includes('/api/attachments?taskId=')) {
				const headers = init?.headers as Record<string, string>;
				expect(headers['x-lumbre-filename']).toBe(encodeURIComponent('informe año.pdf'));
				return jsonResponse({
					id: 'att-2',
					taskId: TASK_ID,
					filename: 'informe año.pdf',
					mime: 'application/pdf',
					size: 28,
					storageKey: 'attachments/att-2',
					createdAt: 1_700_000_000_000
				});
			}
			throw new Error(`fetch no mockeado en este test: ${u}`);
		});
		vi.stubGlobal('fetch', fetchSpy);

		const client = await buildClient();
		const result = await client.callTool({
			name: 'add_attachment',
			arguments: { taskId: TASK_ID, file_path: filePath, filename: 'informe año.pdf' }
		});
		expect(result.isError).not.toBe(true);
	});

	it('ni file_path ni content_base64: error claro, SIN tocar red', async () => {
		const fetchSpy = vi.fn(async (url: string | URL) => {
			throw new Error(`fetch no mockeado en este test: ${String(url)}`);
		});
		vi.stubGlobal('fetch', fetchSpy);

		const client = await buildClient();
		const result = await client.callTool({ name: 'add_attachment', arguments: { taskId: TASK_ID } });
		expect(result.isError).toBe(true);
		expect(firstResultText(result as { content: { type: string; text?: string }[] })).toMatch(/file_path|content_base64/);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('file_path Y content_base64 a la vez: error claro, SIN tocar red', async () => {
		const fetchSpy = vi.fn(async (url: string | URL) => {
			throw new Error(`fetch no mockeado en este test: ${String(url)}`);
		});
		vi.stubGlobal('fetch', fetchSpy);

		const client = await buildClient();
		const result = await client.callTool({
			name: 'add_attachment',
			arguments: { taskId: TASK_ID, file_path: filePath, content_base64: Buffer.from('x').toString('base64') }
		});
		expect(result.isError).toBe(true);
		expect(firstResultText(result as { content: { type: string; text?: string }[] })).toMatch(/una sola vía/i);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	describe('content_base64 — vía SIN disco (funciona con y sin acceso al filesystem)', () => {
		it('camino feliz (con disco): sube los bytes decodificados, con `filename` obligatorio', async () => {
			const fetchSpy = vi.fn(async (url: string | URL, init?: RequestInit) => {
				const u = String(url);
				if (u.includes('/api/tasks?id=')) return jsonResponse([lumbreTask()]);
				if (u.includes('/api/attachments?taskId=')) {
					const headers = init?.headers as Record<string, string>;
					expect(headers['content-type']).toBe('application/octet-stream');
					expect(headers['x-lumbre-content-type']).toBe('text/plain');
					return jsonResponse({
						id: 'att-b64',
						taskId: TASK_ID,
						filename: 'nota.txt',
						mime: 'text/plain',
						size: 5,
						storageKey: 'attachments/att-b64',
						createdAt: 1_700_000_000_000
					});
				}
				throw new Error(`fetch no mockeado en este test: ${u}`);
			});
			vi.stubGlobal('fetch', fetchSpy);

			const client = await buildClient();
			const result = await client.callTool({
				name: 'add_attachment',
				arguments: { taskId: TASK_ID, content_base64: Buffer.from('hola!').toString('base64'), filename: 'nota.txt' }
			});
			expect(result.isError).not.toBe(true);
			expect(firstResultText(result as { content: { type: string; text?: string }[] })).toContain('att-b64');
		});

		it('sin `filename`: error claro, y NINGUNA llamada de red', async () => {
			const fetchSpy = vi.fn(async (url: string | URL) => {
				throw new Error(`fetch no mockeado en este test: ${String(url)}`);
			});
			vi.stubGlobal('fetch', fetchSpy);

			const client = await buildClient();
			const result = await client.callTool({
				name: 'add_attachment',
				arguments: { taskId: TASK_ID, content_base64: Buffer.from('x').toString('base64') }
			});
			expect(result.isError).toBe(true);
			expect(firstResultText(result as { content: { type: string; text?: string }[] })).toMatch(/filename/);
			expect(fetchSpy).not.toHaveBeenCalled();
		});

		it('base64 por encima de 1 MiB decodificado: error con el tamaño REAL, SIN llamar a requireTaskExists ni a /api/attachments', async () => {
			const fetchSpy = vi.fn(async (url: string | URL) => {
				throw new Error(`fetch no mockeado en este test: ${String(url)}`);
			});
			vi.stubGlobal('fetch', fetchSpy);

			const oversized = Buffer.alloc(1024 * 1024 + 1).toString('base64');
			const client = await buildClient();
			const result = await client.callTool({
				name: 'add_attachment',
				arguments: { taskId: TASK_ID, content_base64: oversized, filename: 'grande.bin' }
			});
			expect(result.isError).toBe(true);
			expect(firstResultText(result as { content: { type: string; text?: string }[] })).toMatch(/1\.0 MB/);
			expect(fetchSpy).not.toHaveBeenCalled();
		});

		it('funciona IGUAL en un servidor SIN acceso al disco (localFilesystem: false)', async () => {
			const fetchSpy = vi.fn(async (url: string | URL) => {
				const u = String(url);
				if (u.includes('/api/tasks?id=')) return jsonResponse([lumbreTask()]);
				if (u.includes('/api/attachments?taskId=')) {
					return jsonResponse({
						id: 'att-remote-b64',
						taskId: TASK_ID,
						filename: 'nota.txt',
						mime: 'text/plain',
						size: 5,
						storageKey: 'attachments/att-remote-b64',
						createdAt: 1_700_000_000_000
					});
				}
				throw new Error(`fetch no mockeado en este test: ${u}`);
			});
			vi.stubGlobal('fetch', fetchSpy);

			const client = await buildClient({ localFilesystem: false });
			const result = await client.callTool({
				name: 'add_attachment',
				arguments: { taskId: TASK_ID, content_base64: Buffer.from('hola!').toString('base64'), filename: 'nota.txt' }
			});
			expect(result.isError).not.toBe(true);
			expect(firstResultText(result as { content: { type: string; text?: string }[] })).toContain('att-remote-b64');
		});
	});

	describe('file_path — servidor SIN acceso al disco del usuario (localFilesystem: false, ej. mcp.lumbre.pro)', () => {
		it('file_path da un error EXPLICATIVO (no "no existe el fichero") y NO toca red en absoluto', async () => {
			const fetchSpy = vi.fn(async (url: string | URL) => {
				throw new Error(`fetch no mockeado en este test: ${String(url)}`);
			});
			vi.stubGlobal('fetch', fetchSpy);

			const client = await buildClient({ localFilesystem: false });
			const result = await client.callTool({
				name: 'add_attachment',
				arguments: { taskId: TASK_ID, file_path: filePath }
			});
			expect(result.isError).toBe(true);
			const text = firstResultText(result as { content: { type: string; text?: string }[] });
			expect(text).toMatch(/mcp\.lumbre\.pro/);
			expect(text).toMatch(/content_base64/);
			expect(text).toMatch(/claude mcp add/);
			// El mensaje VIEJO era literalmente `No existe el fichero "<ruta>".` —
			// ese formato exacto (con la ruta entre comillas) ya no debe salir:
			// sonaría a error del usuario, cuando la causa real es de topología.
			expect(text).not.toMatch(/No existe el fichero "/);
			expect(fetchSpy).not.toHaveBeenCalled();
		});
	});
});

describe('CreateServerOptions.toolset — modo acotado a adjuntos (LUMBRE_MCP_TOOLSET=attachments)', () => {
	async function toolNamesOf(opts: { toolset?: 'all' | 'attachments' } = {}) {
		const indexModule = await import('./index.js');
		const server = indexModule.createServer(TEST_CONFIG, opts);
		const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
		const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		indexModule.stripToolsListSchema(serverTransport);
		await server.connect(serverTransport);
		const client = new Client({ name: 'toolset-test-client', version: '0.0.0' });
		await client.connect(clientTransport);
		const result = await client.listTools();
		return result.tools.map((t) => t.name).sort();
	}

	it('sin `toolset` (default): las 19 tools de siempre', async () => {
		expect(await toolNamesOf()).toHaveLength(19);
	});

	it('`toolset: "attachments"`: SOLO add_attachment/read_attachment', async () => {
		expect(await toolNamesOf({ toolset: 'attachments' })).toEqual(['add_attachment', 'read_attachment']);
	});

	it('`toolset: "all"` (explícito): las 19, igual que el default', async () => {
		expect(await toolNamesOf({ toolset: 'all' })).toHaveLength(19);
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
