import { beforeAll, describe, expect, it } from 'vitest';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';

/**
 * Test de regresión de la superficie de tools del MCP (tarea "bajar el coste
 * en tokens de `tools/list` sin tocar `dist/`", 2026-07-25): guardarraíl
 * contra que alguien vuelva a inflarla sin darse cuenta (el techo de bytes de
 * abajo) y contra que el aplanado de `mutate_tasks` haya dejado colar/
 * bloqueado algo que no debía.
 *
 * `LUMBRE_TOKEN` tiene que existir ANTES de importar `./index.js`
 * (`loadConfig` hace `process.exit(1)` sin él) — de ahí el `import()`
 * dinámico dentro de `beforeAll` en vez de un `import` estático de nivel de
 * módulo (que se resolvería antes de que este fichero tenga ocasión de fijar
 * la env var). Importar el módulo real conecta, como en producción, un
 * `StdioServerTransport` de verdad a `process.stdin`/`stdout` — inofensivo en
 * test (nadie escribe en `stdin`, así que nunca procesa ningún mensaje), pero
 * hay que `server.close()` esa conexión antes de poder reconectar `server` a
 * un transporte in-memory de test (`Protocol.connect` lanza si ya está
 * conectado a algo). Sobre ESE transporte de test se aplica la MISMA
 * `stripToolsListSchema` que usa producción (no una réplica de su lógica),
 * para poder comprobar el `tools/list` REAL que vería un cliente, incluida la
 * limpieza de `$schema`.
 */

let tools: Tool[];
let mutateTasksOpSchema: z.ZodTypeAny;
let mutateTasksStrictOpSchema: z.ZodTypeAny;
let effectiveNotesMode: (input: { notes?: string; fullNotes?: boolean }) => string;

beforeAll(async () => {
	process.env.LUMBRE_TOKEN = 'test-token-para-index-test';

	const indexModule = await import('./index.js');
	mutateTasksOpSchema = indexModule.mutateTasksOpSchema;
	mutateTasksStrictOpSchema = indexModule.mutateTasksStrictOpSchema;
	effectiveNotesMode = indexModule.effectiveNotesMode;

	await indexModule.server.close();

	const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
	const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');

	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	indexModule.stripToolsListSchema(serverTransport);
	await indexModule.server.connect(serverTransport);

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
		'mutate_tasks'
	];

	it('sigue exponiendo las 21 tools, por nombre', () => {
		expect(tools).toHaveLength(21);
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

	it('techo de bytes de las 21 tools: no crece sin que alguien se entere', () => {
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
		// Techo = medido + ~5% de holgura, no el valor exacto, para no tener
		// que tocar este test por variaciones triviales de formato JSON.
		const CHAR_CEILING = 22700;
		const size = JSON.stringify(tools).length;
		expect(size).toBeLessThan(CHAR_CEILING);
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
