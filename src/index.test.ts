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
let organizeOpSchema: z.ZodTypeAny;
let organizeStrictOpSchema: z.ZodTypeAny;
let mutateBrlOpSchema: z.ZodTypeAny;
let mutateBrlStrictOpSchema: z.ZodTypeAny;
let effectiveNotesMode: (input: { notes?: NotesMode; fullNotes?: boolean }) => NotesMode;
let effectiveScopeLabel: (input: { scope?: string; list?: string }) => string;
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
	organizeOpSchema = indexModule.organizeOpSchema;
	organizeStrictOpSchema = indexModule.organizeStrictOpSchema;
	mutateBrlOpSchema = indexModule.mutateBrlOpSchema;
	mutateBrlStrictOpSchema = indexModule.mutateBrlStrictOpSchema;
	effectiveNotesMode = indexModule.effectiveNotesMode;
	effectiveScopeLabel = indexModule.effectiveScopeLabel as typeof effectiveScopeLabel;
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
		'get_list_links',
		'get_list',
		'link_list_note',
		'unlink_list_note',
		'get_task',
		'read_attachment',
		'add_attachment',
		'delete_attachment',
		'mutate_tasks',
		'organize',
		'list_brl_entries',
		'mutate_brl',
		'list_habits'
	];

	it('sigue exponiendo las 17 tools, por nombre (podadas create_list/nest_list/rename_list/' +
		'remove_list/move_to_list y add_brl_entry/update_brl_entry/delete_brl_entry el 2026-08-27; ' +
		'añadida get_list el 2026-09-16, tarea 827a7878; retiradas las nueve sueltas de mutación ' +
		'individual y partido el lote en mutate_tasks/organize el 2026-09-19, tarea 6f62c877; ' +
		'añadida list_habits MC6 el 2026-09-24)', () => {
		expect(tools).toHaveLength(17);
		expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
	});

	it('ninguna tool trae `title` (tarea d: quitados de todas las registraciones)', () => {
		for (const tool of tools) {
			expect(tool).not.toHaveProperty('title');
		}
	});

	it('presenta proyectos y áreas sin renombrar tools ni parámetros list/listId', () => {
		const listLists = tools.find((tool) => tool.name === 'list_lists')!;
		expect(listLists.description).toMatch(/proyectos y áreas/i);
		const addTask = tools.find((tool) => tool.name === 'add_task')!;
		const properties = (addTask.inputSchema as { properties: Record<string, { description?: string }> })
			.properties;
		expect(properties.list.description).toMatch(/proyecto o área/i);
		expect(properties.listId.description).toMatch(/proyecto o área/i);
		expect(properties).toHaveProperty('list');
		expect(properties).toHaveProperty('listId');
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

	it('list_tasks/get_task exponen `includeArchived` como boolean opcional', () => {
		for (const name of ['list_tasks', 'get_task']) {
			const schema = tools.find((t) => t.name === name)!.inputSchema as {
				properties?: Record<string, { type?: string }>;
				required?: string[];
			};
			expect(schema.properties?.includeArchived).toMatchObject({ type: 'boolean' });
			expect(schema.required ?? []).not.toContain('includeArchived');
		}
	});

	it('delete_attachment declara destrucción sin deshacer y una salida estructurada', () => {
		const tool = tools.find((candidate) => candidate.name === 'delete_attachment')!;
		expect(tool.description).toMatch(/DESTRUCTIVA.*sin deshacer/i);
		const output = tool.outputSchema as {
			properties?: Record<string, { type?: string; const?: unknown }>;
			required?: string[];
		};
		expect(output.properties?.deleted).toMatchObject({ const: true });
		expect(output.properties?.attachment_id).toMatchObject({ type: 'string' });
		expect(output.required).toEqual(expect.arrayContaining(['deleted', 'attachment_id']));
	});

	it('techo de bytes de las 16 tools: no crece sin que alguien se entere', () => {
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
		// Re-medido el 2026-09-01 al añadir `delete_attachment` (DELETE
		// autenticado, salida legible + `structuredContent`): 20 tools, 23.715
		// caracteres = +1.517 sobre las 19 anteriores. Es superficie nueva y
		// destructiva, con schema de salida explícito; el techo sube junto al
		// valor medido.
		// Re-medido el 2026-09-08 al añadir `get_list_links`: 21 tools, 24.521
		// caracteres. La nueva tool conserva URL y metadata de vínculos sin leer
		// su destino, incluidos los de Obsidian; el techo mantiene ~4% de holgura.
		// Re-medido el 2026-09-15 al añadir `link_list_note` y
		// `unlink_list_note`: 23 tools, 26.489 caracteres. Ambas comparten el
		// mismo contrato de entrada y escriben de forma síncrona vía
		// `POST /api/list-links`.
		// Re-medido el 2026-09-16 al añadir `get_list` (tarea 827a7878, nota
		// íntegra de un proyecto/área + tipo/padre/estado): 24 tools, 27.110
		// caracteres = +621 sobre las 23 anteriores.
		// Re-medido el 2026-09-17 (poda de texto, sin quitar tools ni capacidad):
		// (1) `ASYNC_NOTE` (13 usos) pierde el inciso "(como add_task)", que no
		// era uno de los tres hechos que promete (se encola/se aplica al
		// sincronizar/sin confirmación inmediata). (2) la `description` de
		// `list_tasks` dejaba de repetir el criterio completo de `notes`, que
		// ya detalla el `.describe()` de ese campo — se queda con un puntero
		// corto y la GARANTÍA "nunca un texto recortado a medias" sigue
		// visible (el puntero dice "en ese campo", no `.describe()`: quien lee
		// el listado es un modelo, no ve el código). 24 tools, 26.757
		// caracteres = -353 sobre los 27.110 de arriba.
		// Re-medido el 2026-09-19 (tarea 6f62c877, la fusión): las nueve tools
		// sueltas de mutación individual se RETIRAN (-6.557 caracteres, medido
		// tool a tool sobre el `tools/list` real) y el lote se parte en dos,
		// `mutate_tasks` (8 ops sobre una tarea) y `organize` (8 ops de
		// borrado/reorganización). `mutate_tasks` baja de 4.873 a 3.518 porque
		// su schema EXPUESTO ya solo declara los campos de SUS ops, y
		// `organize` cuesta 2.509 nuevos: 16 tools, 21.346 caracteres = -5.410
		// sobre los 26.756 medidos por este mismo camino antes del cambio
		// (-20,2%). Techo = medido + ~5% de holgura, no el valor exacto, para
		// no tener que tocar este test por variaciones triviales de formato
		// JSON.
		// Re-medido el 2026-09-23 (lote E del audit de paridad): la regla de
		// repetición pasa de `freq`+`interval` a la forma completa de la app
		// (`mode`, `byWeekday`, `until`, `count`, `streak`, con `null` para
		// quitar en `update`) en `add_task` y `mutate_tasks`, y `ASYNC_NOTE`
		// se sustituye por `OUTCOME_NOTE`. 16 tools, 22.280 caracteres = +934
		// sobre los 21.346 de arriba (`mutate_tasks` 3.518 → 4.059, `add_task`
		// 2.789). Es superficie nueva que la app ya aceptaba y el MCP recortaba
		// en silencio (MC3).
		// Re-medido el 2026-09-24 (MC6, paridad UI↔MCP), en tres commits sobre
		// el HEAD real de esa fecha (dc4bfc9: 16 tools, 22.385 caracteres — ya
		// incluía `restore`, un día después del 22.280 de arriba): (1)
		// `set_waiting`/`clear_waiting`/`register_habit` en `mutate_tasks`,
		// `set_list_kind` + `listKind` de `create_list` en `organize`,
		// `deadline`/`reminders` en `update` → 16 tools, 23.680 (+1.295,
		// +5,8%). (2) tool nueva `list_habits` → 17 tools, 24.253 (+573).
		// (3) topes de `subtasks` y rechazo de tags de desarrollo → 17 tools,
		// 24.594 caracteres = +2.209 sobre los 22.385 de dc4bfc9 (+9,9%).
		// Re-medido el 2026-09-24 (MC7, tarea 8eee8c72, «solo el mínimo»):
		// `archive`/`unarchive`/`skip_occurrence`/`archive_habit`/
		// `unarchive_habit` en `mutate_tasks` y `delete_habit` en `organize` (6
		// ops nuevas, 21→27) → sigue en 17 tools, 25.558 caracteres = +964 sobre
		// los 24.594 de arriba (+3,9%). `literal: true` (tarea cd39f028) no
		// cuenta aquí: no es un campo expuesto al modelo, se fuerza dentro del
		// cliente sin tocar ningún schema.
		// Re-medido el 2026-09-25 (`set_parent` en `mutate_tasks`, campo
		// `parentId` expuesto, 27→28 ops): 17 tools, 26.724 caracteres (+426
		// sobre los 26.298 de fd83faf). Cabe bajo el techo sin subirlo. Tras la
		// revisión de `set_parent` (consejo de `recurrence: null` corregido y
		// descripciones recortadas): 26.706 caracteres (−18).
		// Re-medido el 2026-09-25 (`add_attachment` admite una subtarea, «a una
		// tarea o subtarea» en su description): 26.717 caracteres (+11). Cabe
		// bajo el techo sin subirlo. Con el contrato de subtareas en
		// `mutate_tasks` (recurrence, set_waiting y archive no valen en una
		// subtarea): 26.757 (+40), sigue sin subir el techo.
		// Techo = medido + ~5%.
		const CHAR_CEILING = 26800;
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

	/**
	 * El contrato por-op ya no vive en el tipo expuesto (`op` es un `string`
	 * a propósito, para que una op de la OTRA tool llegue al handler y reciba
	 * el puntero en vez de tumbar la llamada entera — ver el JSDoc de
	 * `src/tools/batch.ts`): vive en la `description` de `ops`. Así que lo que
	 * se vigila aquí es que esa tabla siga NOMBRANDO las ops de cada tool —
	 * si alguien añade una op y no la documenta, el modelo no puede llamarla.
	 */
	it('`mutate_tasks` y `organize` documentan sus ops (18+10, MC7 y set_parent) en la description de `ops`', () => {
		const opsDescription = (name: string) => {
			const tool = tools.find((t) => t.name === name);
			expect(tool).toBeDefined();
			const ops = (tool!.inputSchema as { properties?: Record<string, unknown> }).properties?.ops as
				| { description?: string; items?: { properties?: { op?: { type?: string } } } }
				| undefined;
			expect(ops?.items?.properties?.op?.type).toBe('string');
			return ops?.description ?? '';
		};

		const mutateTasksOps = opsDescription('mutate_tasks');
		for (const op of [
			'add_task',
			'complete',
			'cancel',
			'update',
			'reschedule',
			'set_section',
			'add_subtask',
			'complete_subtask',
			'restore',
			'set_waiting',
			'clear_waiting',
			'register_habit',
			'archive',
			'unarchive',
			'skip_occurrence',
			'archive_habit',
			'unarchive_habit',
			'set_parent'
		]) {
			expect(mutateTasksOps).toContain(`${op}:`);
		}
		// Y NO las de la otra: es la frontera que hace mecánica la prohibición
		// de borrar para un subagente al que solo se le da `mutate_tasks`.
		for (const op of ['delete:', 'remove_list:', 'move_to_list:', 'set_list_kind:', 'delete_habit:']) {
			expect(mutateTasksOps).not.toContain(op);
		}

		const organizeOps = opsDescription('organize');
		for (const op of [
			'delete',
			'remove_section',
			'create_list',
			'nest_list',
			'rename_list',
			'remove_list',
			'set_list_notes',
			'move_to_list',
			'set_list_kind',
			'delete_habit'
		]) {
			expect(organizeOps).toContain(`${op}:`);
		}
		expect(tools.find((t) => t.name === 'organize')!.description).toMatch(/^Reorganiza y borra:/);
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

describe('includeArchived — wiring de las tools al contrato HTTP', () => {
	const TASK_ID = '11111111-1111-1111-1111-111111111111';
	const REFERENCED_ID = '22222222-2222-2222-2222-222222222222';

	function jsonResponse(body: unknown): Response {
		return new Response(JSON.stringify(body), {
			status: 200,
			headers: { 'content-type': 'application/json' }
		});
	}

	async function buildClient() {
		const indexModule = await import('./index.js');
		const server = indexModule.createServer(TEST_CONFIG);
		const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
		const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		indexModule.stripToolsListSchema(serverTransport);
		await server.connect(serverTransport);
		const client = new Client({ name: 'include-archived-test-client', version: '0.0.0' });
		await client.connect(clientTransport);
		return client;
	}

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('list_tasks reenvía includeArchived=true en un listado normal', async () => {
		const fetchSpy = vi.fn().mockResolvedValue(jsonResponse([]));
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();

		const result = await client.callTool({
			name: 'list_tasks',
			arguments: { scope: 'all', includeDone: true, includeArchived: true, notes: 'none' }
		});

		expect(result.isError).not.toBe(true);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(fetchSpy.mock.calls[0][0]).toBe(
			'https://lumbre.test/api/tasks?scope=all&includeDone=true&includeArchived=true&notes=none'
		);
	});

	it('get_task reenvía includeArchived=true junto al id', async () => {
		const task = {
			id: TASK_ID,
			content: 'tarea archivada',
			notes: null,
			done: true,
			priority: null,
			date: null,
			deadline: null,
			list: null,
			createdAt: '2026-08-27T00:00:00.000Z',
			archivedAt: '2026-08-27T10:15:00.000Z',
			parentId: null
		};
		const fetchSpy = vi.fn().mockResolvedValue(jsonResponse([task]));
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();

		const result = await client.callTool({
			name: 'get_task',
			arguments: { taskId: TASK_ID, includeArchived: true }
		});

		expect(result.isError).not.toBe(true);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(fetchSpy.mock.calls[0][0]).toBe(
			`https://lumbre.test/api/tasks?id=${TASK_ID}&includeArchived=true`
		);
		const first = (result as { content: { type: string; text?: string }[] }).content[0];
		expect(first.type === 'text' ? first.text : '').toContain(
			'- archivada: 2026-08-27T10:15:00.000Z'
		);
	});

	it('CX6: parche parcial desde una ocurrencia lee su semilla ARCHIVADA y fusiona contra su regla', async () => {
		const base = {
			notes: null,
			priority: null,
			date: null,
			deadline: null,
			list: null,
			createdAt: '2026-08-27T00:00:00.000Z',
			parentId: null
		};
		const occurrence = {
			...base,
			id: TASK_ID,
			content: 'ocurrencia cerrada',
			done: true,
			seriesId: REFERENCED_ID,
			recurrence: { freq: 'weekly', interval: 1, byWeekday: [0] }
		};
		const seed = {
			...base,
			id: REFERENCED_ID,
			content: 'semilla',
			done: true,
			archivedAt: '2026-09-20T10:00:00.000Z',
			seriesId: REFERENCED_ID,
			recurrence: { freq: 'weekly', interval: 1, byWeekday: [3] }
		};
		const fetchSpy = vi.fn(async (url: string | URL) => {
			const value = String(url);
			if (value.includes(`ids=${REFERENCED_ID}&includeArchived=true`)) return jsonResponse([seed]);
			if (value.includes(`ids=${TASK_ID}`)) return jsonResponse([occurrence]);
			if (value.endsWith('/api/batch')) {
				return jsonResponse({ ok: true, results: [{ index: 0, type: 'mutate', ok: true }] });
			}
			throw new Error(`fetch no mockeado: ${value}`);
		});
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();

		await client.callTool({
			name: 'mutate_tasks',
			arguments: { ops: [{ op: 'update', taskId: TASK_ID, recurrence: { interval: 2 } }] }
		});

		const batch = fetchSpy.mock.calls.find((call) => String(call[0]).endsWith('/api/batch'));
		expect(batch).toBeDefined();
		const init = (batch as unknown as [string, RequestInit])[1];
		expect(JSON.parse(String(init.body)).ops).toEqual([
			{
				type: 'mutate',
				taskId: TASK_ID,
				kind: 'update',
				payload: { recurrence: { freq: 'weekly', interval: 2, byWeekday: [3] } }
			}
		]);
	});

	it('leer una archivada no la cuela en la caché que autoriza mutaciones', async () => {
		const archivedTask = {
			id: TASK_ID,
			content: 'tarea archivada',
			notes: null,
			done: true,
			priority: null,
			date: null,
			deadline: null,
			list: null,
			createdAt: '2026-08-27T00:00:00.000Z',
			archivedAt: '2026-08-27T10:15:00.000Z',
			parentId: null
		};
		const fetchSpy = vi.fn(async (url: string | URL) => {
			const value = String(url);
			if (value.includes('includeArchived=true')) return jsonResponse([archivedTask]);
			if (value.includes('/api/tasks?ids=')) return jsonResponse([]);
			if (value.includes('/api/batch')) throw new Error('no debe mutar una archivada por caché');
			throw new Error(`fetch no mockeado: ${value}`);
		});
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();

		await client.callTool({
			name: 'get_task',
			arguments: { taskId: TASK_ID, includeArchived: true }
		});
		// La mutación va por `mutate_tasks` desde que `complete_task` no existe
		// (2026-09-19): resuelve la existencia con `?ids=` contra el servidor —
		// que NO devuelve la archivada — y la op entra en el informe de éxito
		// parcial sin llegar a `/api/batch`.
		const mutation = await client.callTool({
			name: 'mutate_tasks',
			arguments: { ops: [{ op: 'complete', taskId: TASK_ID }] }
		});

		const mutationText = (mutation as { content: { type: string; text?: string }[] }).content[0];
		expect(mutationText.type === 'text' ? mutationText.text : '').toContain(
			'0/1 operación(es) encoladas.'
		);
		expect(fetchSpy.mock.calls.map((call) => String(call[0]))).toEqual([
			`https://lumbre.test/api/tasks?id=${TASK_ID}&includeArchived=true`,
			`https://lumbre.test/api/tasks?ids=${TASK_ID}`
		]);
	});

	it('una archivada que referencia otra archivada resuelve la referencia viva, no como ROTA', async () => {
		const source = {
			id: TASK_ID,
			content: `Depende de [[task:${REFERENCED_ID}|Etiqueta vieja]]`,
			notes: null,
			done: true,
			priority: null,
			date: null,
			deadline: null,
			list: null,
			createdAt: '2026-08-27T00:00:00.000Z',
			archivedAt: '2026-08-27T10:15:00.000Z',
			parentId: null
		};
		const referenced = {
			...source,
			id: REFERENCED_ID,
			content: 'Dependencia archivada ACTUAL'
		};
		const fetchSpy = vi.fn(async (url: string | URL) => {
			const value = String(url);
			if (value.includes(`/api/tasks?id=${TASK_ID}`)) return jsonResponse([source]);
			if (value.includes(`/api/tasks?ids=${REFERENCED_ID}`)) return jsonResponse([referenced]);
			throw new Error(`fetch no mockeado: ${value}`);
		});
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();

		const result = await client.callTool({
			name: 'get_task',
			arguments: { taskId: TASK_ID, includeArchived: true }
		});
		const first = (result as { content: { type: string; text?: string }[] }).content[0];
		const text = first.type === 'text' ? first.text ?? '' : '';

		expect(result.isError).not.toBe(true);
		expect(fetchSpy.mock.calls.map((call) => String(call[0]))).toEqual([
			`https://lumbre.test/api/tasks?id=${TASK_ID}&includeArchived=true`,
			`https://lumbre.test/api/tasks?ids=${REFERENCED_ID}&includeArchived=true`
		]);
		expect(text).toContain(`→tarea[hecha] "Dependencia archivada ACTUAL" id:${REFERENCED_ID}`);
		expect(text).not.toContain('→tarea[ROTA]');
	});

	// Regresión del bug medido el 2026-09-17 en producción: la cabecera
	// rotulaba "scope=today" para una llamada con `list` sin `scope`, cuyo
	// contenido real era el de scope=all (el servidor amplía su propio
	// default cuando hay `list`, ver `effectiveScopeLabel`).
	it('list_tasks({ list, section }, sin scope) rotula la cabecera "scope=all", no "scope=today"', async () => {
		const tasks = [
			{
				id: TASK_ID,
				content: 'una tarea de addons',
				notes: null,
				done: false,
				priority: null,
				date: null,
				deadline: null,
				list: 'addons',
				section: 'MCP',
				createdAt: '2026-09-17T00:00:00.000Z',
				parentId: null
			}
		];
		const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(tasks));
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();

		const result = await client.callTool({
			name: 'list_tasks',
			arguments: { list: 'addons', section: 'MCP' }
		});
		const first = (result as { content: { type: string; text?: string }[] }).content[0];
		const text = first.type === 'text' ? first.text ?? '' : '';

		expect(result.isError).not.toBe(true);
		expect(text).toContain('(scope=all):');
		expect(text).not.toContain('scope=today');
	});
});

describe('list_lists / get_list — nota de proyecto/área (tarea 827a7878)', () => {
	const LIST_ID = '33333333-3333-4333-8333-333333333333';

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	async function buildClient() {
		const indexModule = await import('./index.js');
		const server = indexModule.createServer(TEST_CONFIG);
		const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
		const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		indexModule.stripToolsListSchema(serverTransport);
		await server.connect(serverTransport);
		const client = new Client({ name: 'list-notes-test-client', version: '0.0.0' });
		await client.connect(clientTransport);
		return client;
	}

	function jsonResponse(body: unknown): Response {
		return new Response(JSON.stringify(body), {
			status: 200,
			headers: { 'content-type': 'application/json' }
		});
	}

	it('list_lists pinta el marcador ✎N ↻fecha cuando la lista tiene nota, y nada cuando no', async () => {
		const fetchSpy = vi.fn().mockResolvedValue(
			jsonResponse({
				lists: [
					{
						id: LIST_ID,
						name: 'Con nota',
						taskCount: 2,
						notes: 'Una nota de proyecto con algo de sustancia.',
						notesUpdatedAt: Date.parse('2026-09-10T12:00:00.000Z')
					},
					{
						id: '44444444-4444-4444-8444-444444444444',
						name: 'Sin nota',
						taskCount: 0,
						notes: null,
						notesUpdatedAt: null
					}
				]
			})
		);
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();

		const result = await client.callTool({ name: 'list_lists', arguments: {} });
		expect(result.isError).not.toBe(true);
		const text = ((result as { content: { text: string }[] }).content[0]).text;

		expect(text).toContain(`Con nota — 2 tareas (listId: ${LIST_ID}) ✎43 ↻10sep`);
		expect(text).toContain('Sin nota — 0 tareas (listId: 44444444-4444-4444-8444-444444444444)');
		expect(text).not.toMatch(/Sin nota.*✎/);
	});

	it('list_lists no revienta ni pinta marcador contra un servidor SIN los campos de nota (compatibilidad)', async () => {
		const fetchSpy = vi.fn().mockResolvedValue(
			jsonResponse({ lists: [{ id: LIST_ID, name: 'Lista vieja', taskCount: 1 }] })
		);
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();

		const result = await client.callTool({ name: 'list_lists', arguments: {} });
		expect(result.isError).not.toBe(true);
		const text = ((result as { content: { text: string }[] }).content[0]).text;
		expect(text).toBe(`Proyectos y áreas (1):\n· Lista vieja — 1 tarea (listId: ${LIST_ID})`);
	});

	it('get_list devuelve nombre, tipo, padre, estado, recuento y la nota ÍNTEGRA y verbatim', async () => {
		const fetchSpy = vi.fn().mockResolvedValue(
			jsonResponse({
				lists: [
					{
						id: LIST_ID,
						name: 'Proyecto con nota',
						taskCount: 3,
						kind: 'project',
						parentListId: null,
						closure: null,
						someday: true,
						date: null,
						notes: 'Línea uno.\nLínea dos con más detalle.',
						notesUpdatedAt: Date.parse('2026-09-10T12:00:00.000Z')
					}
				]
			})
		);
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();

		const result = await client.callTool({ name: 'get_list', arguments: { listId: LIST_ID } });
		expect(result.isError).not.toBe(true);
		const text = ((result as { content: { text: string }[] }).content[0]).text;

		expect(text).toContain(`Proyecto o área ${LIST_ID}`);
		expect(text).toContain('- nombre: Proyecto con nota');
		expect(text).toContain('- tipo: proyecto');
		expect(text).toContain('- padre: (ninguno, de primer nivel)');
		expect(text).toContain('- estado: aparcado');
		expect(text).toContain('- tareas: 3');
		expect(text).toContain('- notas:\nLínea uno.\nLínea dos con más detalle.');
	});

	it('get_list da error claro si el listId no existe', async () => {
		const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ lists: [] }));
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();

		const result = await client.callTool({ name: 'get_list', arguments: { listId: LIST_ID } });
		expect(result.isError).toBe(true);
		const text = ((result as { content: { text: string }[] }).content[0]).text;
		expect(text).toContain(LIST_ID);
		expect(text).toMatch(/no está entre los proyectos\/áreas/);
	});
});

describe('get_list_links — registro y contrato HTTP', () => {
	const LIST_ID = '11111111-1111-4111-8111-111111111111';

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('registra el UUID, conserva un obsidian:// y devuelve una lista vacía legible', async () => {
		const indexModule = await import('./index.js');
		const server = indexModule.createServer(TEST_CONFIG);
		const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
		const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		indexModule.stripToolsListSchema(serverTransport);
		await server.connect(serverTransport);
		const client = new Client({ name: 'list-links-test-client', version: '0.0.0' });
		await client.connect(clientTransport);

		const fetchSpy = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						links: [
							{
								id: '22222222-2222-4222-8222-222222222222',
								listId: LIST_ID,
								kind: 'obsidian-note',
								targetKey: 'projects/lumbre.md',
								url: 'obsidian://open?vault=fodaveg&file=projects%2Flumbre.md',
								label: 'Proyecto Lumbre',
								updatedAt: '2026-09-08T09:00:00.000Z'
							}
						]
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } }
				)
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ links: [] }), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				})
			);
		vi.stubGlobal('fetch', fetchSpy);

		const linked = await client.callTool({ name: 'get_list_links', arguments: { listId: LIST_ID } });
		expect(linked.isError).not.toBe(true);
		const linkedText = ((linked as { content: { text: string }[] }).content[0]).text;
		expect(linkedText).toContain('obsidian://open?vault=fodaveg');
		for (const value of [
			'Proyecto Lumbre',
			'22222222-2222-4222-8222-222222222222',
			LIST_ID,
			'obsidian-note',
			'projects/lumbre.md',
			'2026-09-08T09:00:00.000Z'
		]) {
			expect(linkedText).toContain(value);
		}
		expect(fetchSpy.mock.calls[0][0]).toBe(`https://lumbre.test/api/list-links?listId=${LIST_ID}`);

		const empty = await client.callTool({ name: 'get_list_links', arguments: { listId: LIST_ID } });
		expect(empty.isError).not.toBe(true);
		const emptyText = ((empty as { content: { text: string }[] }).content[0]).text;
		expect(emptyText).toBe(`Sin vínculos para el proyecto o área ${LIST_ID}.`);
	});

	it('devuelve el error de auth y rechaza un listId inválido antes de consultar la API', async () => {
		const indexModule = await import('./index.js');
		const server = indexModule.createServer(TEST_CONFIG);
		const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
		const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		indexModule.stripToolsListSchema(serverTransport);
		await server.connect(serverTransport);
		const client = new Client({ name: 'list-links-error-test-client', version: '0.0.0' });
		await client.connect(clientTransport);

		const fetchSpy = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ message: 'unauthorized' }), {
				status: 401,
				headers: { 'content-type': 'application/json' }
			})
		);
		vi.stubGlobal('fetch', fetchSpy);

		const auth = await client.callTool({ name: 'get_list_links', arguments: { listId: LIST_ID } });
		expect(auth.isError).toBe(true);
		expect(((auth as { content: { text: string }[] }).content[0]).text).toMatch(/Token inválido/);

		const invalid = await client.callTool({ name: 'get_list_links', arguments: { listId: 'no-es-uuid' } });
		expect(invalid.isError).toBe(true);
		// Mensaje de zod 4 para `.guid()` (chore/zod4-vitest5): "Invalid GUID",
		// no "Invalid uuid" (zod 3) — validación IDÉNTICA (`.guid()` es el
		// permisivo de zod 4, mismo patrón que el `.uuid()` de zod 3, ver
		// `tools/lists.ts`), solo cambia el texto del mensaje.
		expect(((invalid as { content: { text: string }[] }).content[0]).text).toMatch(/Invalid GUID/);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});
});

describe('link_list_note / unlink_list_note — registro, validación y contrato HTTP', () => {
	const LIST_ID = '11111111-1111-4111-8111-111111111111';
	const URL = 'obsidian://open?vault=fodaveg&file=projects%2Flumbre.md';
	const LINK = {
		id: '22222222-2222-4222-8222-222222222222',
		listId: LIST_ID,
		kind: 'obsidian',
		targetKey: URL,
		url: URL,
		label: 'Proyecto Lumbre',
		updatedAt: '2026-09-15T09:00:00.000Z'
	};

	async function buildClient() {
		const indexModule = await import('./index.js');
		const server = indexModule.createServer(TEST_CONFIG);
		const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
		const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		indexModule.stripToolsListSchema(serverTransport);
		await server.connect(serverTransport);
		const client = new Client({ name: 'write-list-links-test-client', version: '0.0.0' });
		await client.connect(clientTransport);
		return client;
	}

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('link y unlink mandan el POST exacto, recortan una vez y muestran tombstone/removed=false', async () => {
		const fetchSpy = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({ ok: true, type: 'link', listId: LIST_ID, deleted: true, link: LINK }),
					{ status: 200, headers: { 'content-type': 'application/json' } }
				)
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({ ok: true, type: 'unlink', listId: LIST_ID, deleted: false, removed: false }),
					{ status: 200, headers: { 'content-type': 'application/json' } }
				)
			);
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();

		const linked = await client.callTool({
			name: 'link_list_note',
			arguments: { listId: LIST_ID, url: `  ${URL}  `, label: '  Proyecto Lumbre  ' }
		});
		expect(linked.isError).not.toBe(true);
		expect(((linked as { content: { text: string }[] }).content[0]).text).toMatch(/deleted=true/);

		const unlinked = await client.callTool({
			name: 'unlink_list_note',
			arguments: { listId: LIST_ID, url: URL, label: 'Proyecto Lumbre' }
		});
		expect(unlinked.isError).not.toBe(true);
		expect(((unlinked as { content: { text: string }[] }).content[0]).text).toMatch(
			/removed=false; deleted=false/
		);

		expect(fetchSpy).toHaveBeenCalledTimes(2);
		for (const [index, type] of ['link', 'unlink'].entries()) {
			const [requestUrl, init] = fetchSpy.mock.calls[index] as [string, RequestInit];
			expect(requestUrl).toBe('https://lumbre.test/api/list-links');
			expect(init.method).toBe('POST');
			expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TEST_CONFIG.token}`);
			expect(JSON.parse(String(init.body))).toEqual({
				type,
				listId: LIST_ID,
				target: { kind: 'obsidian', url: URL, label: 'Proyecto Lumbre' }
			});
		}
	});

	it.each([
		['uuid', { listId: 'no-es-uuid', url: URL, label: 'Nota' }],
		['protocolo', { listId: LIST_ID, url: 'https://example.com/nota', label: 'Nota' }],
		['vacía tras trim', { listId: LIST_ID, url: '   ', label: 'Nota' }],
		['sin destino', { listId: LIST_ID, url: 'obsidian://', label: 'Nota' }],
		['credenciales', { listId: LIST_ID, url: 'obsidian://user:pass@open?file=nota', label: 'Nota' }],
		['más de 2048 caracteres', { listId: LIST_ID, url: `obsidian://open?file=${'a'.repeat(2_048)}`, label: 'Nota' }],
		['más de 2048 bytes UTF-8', { listId: LIST_ID, url: `obsidian://open?file=${'á'.repeat(1_020)}`, label: 'Nota' }],
		['label vacío tras trim', { listId: LIST_ID, url: URL, label: '   ' }],
		['label mayor de 300', { listId: LIST_ID, url: URL, label: 'a'.repeat(301) }]
	])('rechaza %s antes de tocar red', async (_name, args) => {
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();
		const result = await client.callTool({ name: 'link_list_note', arguments: args });
		expect(result.isError).toBe(true);
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe('mutate_tasks/organize — las 21 `op` siguen aceptándose (esquemas estrictos internos)', () => {
	/** Un caso por op: el payload VÁLIDO mínimo/representativo, y variantes
	 *  INVÁLIDAS por campo que falta y por campo que sobra (ajeno a esa op,
	 *  pero válido en general — p. ej. `date` en `complete`) — mismo criterio
	 *  que exige la tarea: el rechazo de campos ajenos DEBE seguir pasando,
	 *  solo que vive en el schema ESTRICTO (interno) de la tool a la que
	 *  pertenece esa op, no en el EXPUESTO (deliberadamente laxo). Desde el
	 *  reparto en dos tools (2026-09-19) cada caso se valida contra el par de
	 *  schemas de SU tool — ver `ORGANIZE_OPS` debajo del array. */
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
			op: 'restore',
			valid: { op: 'restore', taskId: '11111111-1111-1111-1111-111111111111' },
			missingField: 'taskId',
			extraField: { op: 'restore', taskId: '11111111-1111-1111-1111-111111111111', done: true }
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
		},
		{
			op: 'set_list_notes',
			valid: { op: 'set_list_notes', listId: '11111111-1111-1111-1111-111111111111', notes: null, revive: true },
			missingField: 'notes',
			extraField: {
				op: 'set_list_notes',
				listId: '11111111-1111-1111-1111-111111111111',
				notes: 'nota',
				name: 'ajeno'
			}
		},
		// MC6 (2026-09-24, paridad UI↔MCP): las 4 ops nuevas.
		{
			op: 'set_waiting',
			valid: { op: 'set_waiting', taskId: '11111111-1111-1111-1111-111111111111', until: '2099-01-01' },
			missingField: 'until',
			extraField: {
				op: 'set_waiting',
				taskId: '11111111-1111-1111-1111-111111111111',
				until: '2099-01-01',
				done: true
			}
		},
		{
			op: 'clear_waiting',
			valid: { op: 'clear_waiting', taskId: '11111111-1111-1111-1111-111111111111' },
			missingField: 'taskId',
			extraField: {
				op: 'clear_waiting',
				taskId: '11111111-1111-1111-1111-111111111111',
				until: '2099-01-01'
			}
		},
		{
			// `date` opcional a propósito (ver el JSDoc de
			// `RegisterHabitMutationPayload`): el caso VÁLIDO no la manda.
			op: 'register_habit',
			valid: { op: 'register_habit', habitId: '11111111-1111-1111-1111-111111111111' },
			missingField: 'habitId',
			extraField: {
				op: 'register_habit',
				habitId: '11111111-1111-1111-1111-111111111111',
				taskId: '22222222-2222-2222-2222-222222222222'
			}
		},
		{
			op: 'set_list_kind',
			valid: { op: 'set_list_kind', listId: '11111111-1111-1111-1111-111111111111', listKind: 'area' },
			missingField: 'listKind',
			extraField: {
				op: 'set_list_kind',
				listId: '11111111-1111-1111-1111-111111111111',
				listKind: 'area',
				name: 'x'
			}
		},
		// MC7 (2026-09-24, tarea 8eee8c72): las 6 ops nuevas.
		{
			op: 'archive',
			valid: { op: 'archive', taskId: '11111111-1111-1111-1111-111111111111' },
			missingField: 'taskId',
			extraField: { op: 'archive', taskId: '11111111-1111-1111-1111-111111111111', done: true }
		},
		{
			op: 'unarchive',
			valid: { op: 'unarchive', taskId: '11111111-1111-1111-1111-111111111111' },
			missingField: 'taskId',
			extraField: { op: 'unarchive', taskId: '11111111-1111-1111-1111-111111111111', done: true }
		},
		{
			op: 'skip_occurrence',
			valid: {
				op: 'skip_occurrence',
				seriesId: '11111111-1111-1111-1111-111111111111',
				date: '2026-10-01'
			},
			missingField: 'date',
			extraField: {
				op: 'skip_occurrence',
				seriesId: '11111111-1111-1111-1111-111111111111',
				date: '2026-10-01',
				taskId: '22222222-2222-2222-2222-222222222222'
			}
		},
		{
			op: 'archive_habit',
			valid: { op: 'archive_habit', habitId: '11111111-1111-1111-1111-111111111111' },
			missingField: 'habitId',
			extraField: {
				op: 'archive_habit',
				habitId: '11111111-1111-1111-1111-111111111111',
				taskId: '22222222-2222-2222-2222-222222222222'
			}
		},
		{
			op: 'unarchive_habit',
			valid: { op: 'unarchive_habit', habitId: '11111111-1111-1111-1111-111111111111' },
			missingField: 'habitId',
			extraField: {
				op: 'unarchive_habit',
				habitId: '11111111-1111-1111-1111-111111111111',
				taskId: '22222222-2222-2222-2222-222222222222'
			}
		},
		{
			op: 'delete_habit',
			valid: { op: 'delete_habit', habitId: '11111111-1111-1111-1111-111111111111' },
			missingField: 'habitId',
			extraField: {
				op: 'delete_habit',
				habitId: '11111111-1111-1111-1111-111111111111',
				taskId: '22222222-2222-2222-2222-222222222222'
			}
		},
		// 2026-09-25: anidar/desanidar. `parentId` es obligatorio (null desanida),
		// así que omitirlo es forma inválida, no «desanidar por defecto».
		{
			op: 'set_parent',
			valid: {
				op: 'set_parent',
				taskId: '11111111-1111-1111-1111-111111111111',
				parentId: '22222222-2222-2222-2222-222222222222'
			},
			missingField: 'parentId',
			extraField: {
				op: 'set_parent',
				taskId: '11111111-1111-1111-1111-111111111111',
				parentId: null,
				section: 'x'
			}
		}
	];

	/** Las 10 ops que viven en `organize` (MC6 añade `set_list_kind`, MC7 añade
	 *  `delete_habit`); el resto, en `mutate_tasks` (mapa `TASK_OP_TOOL` de
	 *  `tools/shared.ts` — aquí se repite a propósito: si el reparto cambia en
	 *  el código sin que nadie lo decida, estos tests caen). */
	const ORGANIZE_OPS = new Set([
		'delete',
		'remove_section',
		'create_list',
		'nest_list',
		'rename_list',
		'remove_list',
		'set_list_notes',
		'move_to_list',
		'set_list_kind',
		'delete_habit'
	]);
	const strictSchemaFor = (op: string) => (ORGANIZE_OPS.has(op) ? organizeStrictOpSchema : mutateTasksStrictOpSchema);
	const exposedSchemaFor = (op: string) => (ORGANIZE_OPS.has(op) ? organizeOpSchema : mutateTasksOpSchema);

	it('cubre las 28 operaciones (guardarraíl del propio test; MC7 y set_parent desde el 2026-09-25)', () => {
		expect(cases.map((c) => c.op).sort()).toEqual(
			[
				'add_task',
				'complete',
				'cancel',
				'restore',
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
				'remove_list',
				'set_list_notes',
				'set_waiting',
				'clear_waiting',
				'register_habit',
				'set_list_kind',
				'archive',
				'unarchive',
				'skip_occurrence',
				'archive_habit',
				'unarchive_habit',
				'delete_habit',
				'set_parent'
			].sort()
		);
	});

	for (const { op, valid, missingField, extraField } of cases) {
		describe(`op: ${op} (${ORGANIZE_OPS.has(op) ? 'organize' : 'mutate_tasks'})`, () => {
			it('caso VÁLIDO: pasa el schema EXPUESTO (tools/list) y el ESTRICTO (handler)', () => {
				expect(exposedSchemaFor(op).safeParse(valid).success).toBe(true);
				expect(strictSchemaFor(op).safeParse(valid).success).toBe(true);
			});

			it(`caso INVÁLIDO (falta \`${missingField}\`): el schema ESTRICTO lo rechaza`, () => {
				const { [missingField]: _omitted, ...withoutField } = valid;
				const result = strictSchemaFor(op).safeParse(withoutField);
				expect(result.success).toBe(false);
			});

			it('caso INVÁLIDO (campo ajeno a esta op): el schema ESTRICTO lo rechaza', () => {
				const result = strictSchemaFor(op).safeParse(extraField);
				expect(result.success).toBe(false);
			});

			it('op mandada a la OTRA tool: su schema ESTRICTO la rechaza (discriminador inválido)', () => {
				const otherSchema = ORGANIZE_OPS.has(op) ? mutateTasksStrictOpSchema : organizeStrictOpSchema;
				expect(otherSchema.safeParse(valid).success).toBe(false);
			});
		});
	}

	it('update con notes:null: lo rechazan LOS DOS schemas de mutate_tasks', () => {
		// Desde el reparto, `notes` en `mutate_tasks` ya no es nullable en el
		// schema EXPUESTO (solo `organize`/`set_list_notes` borra notas con
		// null), así que este caso se corta antes incluso que en el estricto.
		const invalidUpdate = {
			op: 'update',
			taskId: '11111111-1111-1111-1111-111111111111',
			notes: null
		};
		expect(mutateTasksOpSchema.safeParse(invalidUpdate).success).toBe(false);
		expect(mutateTasksStrictOpSchema.safeParse(invalidUpdate).success).toBe(false);
	});

	it('op desconocida: el EXPUESTO la deja pasar (`op` es string) y el ESTRICTO la rechaza', () => {
		// `op` expuesto es `string` a propósito: así una op desconocida —o de la
		// otra tool— llega al handler y sale en el informe de éxito parcial con
		// un motivo concreto, en vez de tumbar la llamada entera en el framework.
		const bogus = { op: 'not_a_real_op', taskId: '11111111-1111-1111-1111-111111111111' };
		expect(mutateTasksOpSchema.safeParse(bogus).success).toBe(true);
		expect(mutateTasksStrictOpSchema.safeParse(bogus).success).toBe(false);
		expect(organizeOpSchema.safeParse(bogus).success).toBe(true);
		expect(organizeStrictOpSchema.safeParse(bogus).success).toBe(false);
	});

	it('campo con nombre desconocido (typo): lo caza el ESTRICTO, por-op, sin tumbar el lote', () => {
		const element = {
			op: 'complete',
			taskId: '11111111-1111-1111-1111-111111111111',
			// `donee` no es ninguno de los campos conocidos — typo real de
			// `done`. El EXPUESTO es `.passthrough()` desde 2026-09-19 (antes
			// `.strict()`): deja pasar el campo para que el ESTRICTO lo reporte
			// como fallo de ESA op, en vez de que el framework rechace la
			// llamada entera.
			donee: true
		};
		expect(mutateTasksOpSchema.safeParse(element).success).toBe(true);
		expect(mutateTasksStrictOpSchema.safeParse(element).success).toBe(false);
	});

	it('add_task/update aceptan tags válidos y conservan `[]` como valor explícito', () => {
		expect(
			mutateTasksStrictOpSchema.safeParse({ op: 'add_task', text: 'Nueva', tags: ['casa_2'] })
				.success
		).toBe(true);
		expect(
			mutateTasksStrictOpSchema.safeParse({
				op: 'update',
				taskId: '11111111-1111-1111-1111-111111111111',
				tags: []
			}).success
		).toBe(true);
		expect(
			mutateTasksStrictOpSchema.safeParse({ op: 'add_task', text: 'Nueva', tags: ['#inválido'] })
				.success
		).toBe(false);
	});

	it('add_task/add_subtask: `subtasks` respeta los topes de la app (MAX_SUBTASKS=50, MAX_SUBTASK_LEN=500) — la app hoy los recorta en silencio', () => {
		const ok50 = Array.from({ length: 50 }, (_, i) => `sub ${i}`);
		const over51 = [...ok50, 'una de más'];
		const okLen500 = 'a'.repeat(500);
		const overLen501 = 'a'.repeat(501);

		expect(mutateTasksStrictOpSchema.safeParse({ op: 'add_task', text: 'x', subtasks: ok50 }).success).toBe(
			true
		);
		expect(mutateTasksStrictOpSchema.safeParse({ op: 'add_task', text: 'x', subtasks: over51 }).success).toBe(
			false
		);
		expect(
			mutateTasksStrictOpSchema.safeParse({ op: 'add_task', text: 'x', subtasks: [okLen500] }).success
		).toBe(true);
		expect(
			mutateTasksStrictOpSchema.safeParse({ op: 'add_task', text: 'x', subtasks: [overLen501] }).success
		).toBe(false);

		const taskId = '11111111-1111-1111-1111-111111111111';
		expect(
			mutateTasksStrictOpSchema.safeParse({ op: 'add_subtask', taskId, subtasks: [okLen500] }).success
		).toBe(true);
		expect(
			mutateTasksStrictOpSchema.safeParse({ op: 'add_subtask', taskId, subtasks: [overLen501] }).success
		).toBe(false);
	});
});

describe('mutate_tasks/organize — lote, encadenado intra-lote y frontera entre las dos tools', () => {
	const LIST_ID = 'a0b1c2d3-e4f5-4678-9abc-def012345678';
	const EXISTING_LIST_ID = 'b1c2d3e4-f5a6-4789-9abc-def012345678';

	function jsonResponse(body: unknown): Response {
		return new Response(JSON.stringify(body), {
			status: 200,
			headers: { 'content-type': 'application/json' }
		});
	}

	async function buildClient() {
		const indexModule = await import('./index.js');
		const server = indexModule.createServer(TEST_CONFIG);
		const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
		const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		indexModule.stripToolsListSchema(serverTransport);
		await server.connect(serverTransport);
		const client = new Client({ name: 'batch-phases-test-client', version: '0.0.0' });
		await client.connect(clientTransport);
		return client;
	}

	function batchCalls(fetchSpy: ReturnType<typeof vi.fn>) {
		return fetchSpy.mock.calls.filter((call) => String(call[0]).endsWith('/api/batch'));
	}

	function resultText(result: unknown): string {
		const first = (result as { content: { type: string; text?: string }[] }).content[0];
		return first.type === 'text' ? (first.text ?? '') : '';
	}

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('sin dependencia (add_task sin listId de un create_list del lote): UNA sola petición a /api/batch', async () => {
		const fetchSpy = vi.fn().mockResolvedValue(
			jsonResponse({
				ok: true,
				results: [
					{ index: 0, type: 'ingest', ok: true, id: 't1' },
					{ index: 1, type: 'ingest', ok: true, id: 't2' }
				]
			})
		);
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();

		const result = await client.callTool({
			name: 'mutate_tasks',
			arguments: {
				ops: [
					{ op: 'add_task', text: 'a' },
					{ op: 'add_task', text: 'b' }
				]
			}
		});

		expect(result.isError).not.toBe(true);
		expect(batchCalls(fetchSpy)).toHaveLength(1);
		expect(resultText(result)).toContain('2/2 operación(es) encoladas.');
	});

	it('update con recurrence:null viaja tal cual a /api/batch (apaga la regla, también de una semilla archivada)', async () => {
		const taskId = '11111111-1111-1111-1111-111111111111';
		// La semilla está ARCHIVADA: la búsqueda normal no la ve y la segunda,
		// con `includeArchived`, sí.
		const fetchSpy = vi.fn().mockImplementation(async (url: unknown) => {
			const u = String(url);
			if (u.includes('/api/tasks?') && u.includes('includeArchived=true')) {
				return jsonResponse([{ id: taskId, content: 'Ducha', archivedAt: '2026-09-09T18:19:11.922Z' }]);
			}
			if (u.includes('/api/tasks?')) return jsonResponse([]);
			return jsonResponse({ ok: true, results: [{ index: 0, type: 'mutate', ok: true, id: taskId }] });
		});
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();

		const result = await client.callTool({
			name: 'mutate_tasks',
			arguments: { ops: [{ op: 'update', taskId, recurrence: null }] }
		});

		expect(result.isError).not.toBe(true);
		const calls = batchCalls(fetchSpy);
		expect(calls).toHaveLength(1);
		const body = JSON.parse(String((calls[0][1] as RequestInit).body)) as {
			ops: { taskId: string; kind: string; payload: Record<string, unknown> }[];
		};
		expect(body.ops[0]).toMatchObject({ taskId, kind: 'update', payload: { recurrence: null } });
	});

	it('restore sobre una tarea BORRADA: no la rechaza el cliente, viaja como kind:restore y lo decide el servidor', async () => {
		const taskId = '33333333-3333-4333-8333-333333333333';
		// La tarea está en la Papelera: ninguna búsqueda de tareas la devuelve.
		// Si el cliente comprobara existencia, la op moriría aquí sin viajar.
		const fetchSpy = vi.fn().mockImplementation(async (url: unknown) => {
			if (String(url).includes('/api/tasks')) return jsonResponse([]);
			return jsonResponse({
				ok: true,
				results: [{ index: 0, type: 'mutate', ok: true, id: taskId, materialization: 'applied' }]
			});
		});
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();

		const result = await client.callTool({
			name: 'mutate_tasks',
			arguments: { ops: [{ op: 'restore', taskId }] }
		});

		expect(result.isError).not.toBe(true);
		const calls = batchCalls(fetchSpy);
		expect(calls).toHaveLength(1);
		const body = JSON.parse(String((calls[0][1] as RequestInit).body)) as {
			ops: { type: string; taskId: string; kind: string; payload: Record<string, unknown> }[];
		};
		expect(body.ops).toEqual([{ type: 'mutate', taskId, kind: 'restore', payload: {} }]);
		const text = resultText(result);
		expect(text).toContain('1/1 operación(es) encoladas.');
		expect(text).not.toMatch(/fallaron/);
	});

	it('restore de una tarea ya PURGADA: el informe dice «sin efecto» y reenvía el aviso restore-purged', async () => {
		const taskId = '44444444-4444-4444-8444-444444444444';
		const purged = 'Esa tarea ya no se podía restaurar: se había purgado definitivamente.';
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				jsonResponse({
					ok: true,
					results: [{ index: 0, type: 'mutate', ok: true, id: taskId, materialization: 'noop' }],
					notices: [purged]
				})
			)
		);
		const client = await buildClient();

		const text = resultText(
			await client.callTool({ name: 'mutate_tasks', arguments: { ops: [{ op: 'restore', taskId }] } })
		);

		expect(text).toMatch(/\[0\] restore: sin efecto/);
		expect(text).toContain(`avisos de la app:\n  - ${purged}`);
	});

	it('restore NO existe en organize: puntero a mutate_tasks, sin tocar red', async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();

		const text = resultText(
			await client.callTool({
				name: 'organize',
				arguments: { ops: [{ op: 'restore', taskId: '33333333-3333-4333-8333-333333333333' }] }
			})
		);

		expect(text).toContain('la op "restore" no existe en organize; está en mutate_tasks');
		expect(batchCalls(fetchSpy)).toHaveLength(0);
	});

	// MC7 (2026-09-24, tarea 8eee8c72): visibilidad de tarea, salto de
	// ocurrencia y ciclo de vida de hábito.
	it('unarchive sobre una tarea ARCHIVADA: la búsqueda normal no la ve, la segunda con includeArchived sí, y viaja kind:unarchive', async () => {
		const taskId = '11111111-1111-1111-1111-111111111111';
		const fetchSpy = vi.fn().mockImplementation(async (url: unknown) => {
			const u = String(url);
			if (u.includes('/api/tasks?') && u.includes('includeArchived=true')) {
				return jsonResponse([{ id: taskId, content: 'Ducha', archivedAt: '2026-09-09T18:19:11.922Z' }]);
			}
			if (u.includes('/api/tasks?')) return jsonResponse([]);
			return jsonResponse({
				ok: true,
				results: [{ index: 0, type: 'mutate', ok: true, id: taskId, materialization: 'applied' }]
			});
		});
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();

		const result = await client.callTool({
			name: 'mutate_tasks',
			arguments: { ops: [{ op: 'unarchive', taskId }] }
		});

		expect(result.isError).not.toBe(true);
		const calls = batchCalls(fetchSpy);
		expect(calls).toHaveLength(1);
		const body = JSON.parse(String((calls[0][1] as RequestInit).body)) as {
			ops: { taskId: string; kind: string; payload: Record<string, unknown> }[];
		};
		expect(body.ops[0]).toEqual({ type: 'mutate', taskId, kind: 'unarchive', payload: {} });
		expect(resultText(result)).toContain('1/1 operación(es) encoladas.');
	});

	it('delete sobre una tarea ARCHIVADA: la comprobación de existencia también la encuentra con includeArchived', async () => {
		const taskId = '22222222-2222-2222-2222-222222222222';
		const fetchSpy = vi.fn().mockImplementation(async (url: unknown) => {
			const u = String(url);
			if (u.includes('/api/tasks?') && u.includes('includeArchived=true')) {
				return jsonResponse([{ id: taskId, content: 'Vieja', archivedAt: '2026-09-09T18:19:11.922Z' }]);
			}
			if (u.includes('/api/tasks?')) return jsonResponse([]);
			return jsonResponse({ ok: true, results: [{ index: 0, type: 'mutate', ok: true, id: taskId }] });
		});
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();

		const result = await client.callTool({ name: 'organize', arguments: { ops: [{ op: 'delete', taskId }] } });

		expect(result.isError).not.toBe(true);
		expect(resultText(result)).toContain('1/1 operación(es) encoladas.');
		expect(resultText(result)).not.toMatch(/fallaron/);
	});

	// La app responde `noop` SIN aviso a archivar una archivada
	// (`materializeLifecycleMutation`, `lifecycle-inbound.ts` de 4eda45d); sin
	// el reintento con includeArchived, el conector la rechazaba antes de
	// encolar como si no existiera.
	it('archive sobre una tarea YA archivada: UNA segunda búsqueda agrupada con includeArchived (junto a unarchive) y el informe dice sin efecto', async () => {
		const archivedId = '77777777-7777-4777-8777-777777777777';
		const otherArchivedId = '88888888-8888-4888-8888-888888888888';
		const fetchSpy = vi.fn().mockImplementation(async (url: unknown) => {
			const u = String(url);
			if (u.includes('/api/tasks?') && u.includes('includeArchived=true')) {
				return jsonResponse([
					{ id: archivedId, content: 'Vieja', archivedAt: '2026-09-09T18:19:11.922Z' },
					{ id: otherArchivedId, content: 'Otra', archivedAt: '2026-09-09T18:19:11.922Z' }
				]);
			}
			if (u.includes('/api/tasks?')) return jsonResponse([]);
			return jsonResponse({
				ok: true,
				results: [
					{ index: 0, type: 'mutate', ok: true, id: archivedId, materialization: 'noop' },
					{ index: 1, type: 'mutate', ok: true, id: otherArchivedId, materialization: 'applied' }
				]
			});
		});
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();

		const result = await client.callTool({
			name: 'mutate_tasks',
			arguments: {
				ops: [
					{ op: 'archive', taskId: archivedId },
					{ op: 'unarchive', taskId: otherArchivedId }
				]
			}
		});

		expect(result.isError).not.toBe(true);
		const archivedLookups = fetchSpy.mock.calls.filter(
			(c) => String(c[0]).includes('/api/tasks?') && String(c[0]).includes('includeArchived=true')
		);
		expect(archivedLookups).toHaveLength(1);
		expect(String(archivedLookups[0][0])).toContain(archivedId);
		expect(String(archivedLookups[0][0])).toContain(otherArchivedId);
		const calls = batchCalls(fetchSpy);
		expect(calls).toHaveLength(1);
		const body = JSON.parse(String((calls[0][1] as RequestInit).body)) as {
			ops: { taskId: string; kind: string; payload: Record<string, unknown> }[];
		};
		expect(body.ops[0]).toEqual({ type: 'mutate', taskId: archivedId, kind: 'archive', payload: {} });
		const text = resultText(result);
		expect(text).toMatch(/\[0\] archive: sin efecto/);
		expect(text).not.toMatch(/fallaron/);
	});

	it('archive_habit sobre un habitId INEXISTENTE: el informe trae el notice target-missing de la app, igual que restore-purged', async () => {
		// `archive_habit` NO comprueba existencia (su objetivo es un hábito, ver
		// `TASK_TARGET_ALLOW_SUBTASK`): el id inexistente viaja tal cual y el
		// `noop`+aviso lo decide el servidor, no el cliente — a diferencia de
		// `archive`/`unarchive` (tareas), que SÍ lo comprueban antes de encolar.
		const habitId = '33333333-3333-4333-8333-333333333333';
		const notice = `«archiveHabit» no se aplicó: no existe nada con el id ${habitId} (o ya estaba borrado).`;
		const fetchSpy = vi.fn().mockResolvedValue(
			jsonResponse({
				ok: true,
				results: [{ index: 0, type: 'mutate', ok: true, id: habitId, materialization: 'noop' }],
				notices: [notice]
			})
		);
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();

		const text = resultText(
			await client.callTool({ name: 'mutate_tasks', arguments: { ops: [{ op: 'archive_habit', habitId }] } })
		);

		expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes('/api/tasks'))).toBe(false);
		expect(text).toMatch(/\[0\] archive_habit: sin efecto/);
		expect(text).toContain(`avisos de la app:\n  - ${notice}`);
	});

	it('skip_occurrence SIN occurrenceId manda taskId=seriesId al envelope, sin comprobar existencia (sin llamada a /api/tasks)', async () => {
		const seriesId = '44444444-4444-4444-8444-444444444444';
		const fetchSpy = vi.fn().mockResolvedValue(
			jsonResponse({ ok: true, results: [{ index: 0, type: 'mutate', ok: true, id: seriesId, materialization: 'applied' }] })
		);
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();

		const result = await client.callTool({
			name: 'mutate_tasks',
			arguments: { ops: [{ op: 'skip_occurrence', seriesId, date: '2026-10-01' }] }
		});

		expect(result.isError).not.toBe(true);
		// Ninguna llamada a `/api/tasks`: `skip_occurrence` no comprueba
		// existencia (el servidor decide si `seriesId` es una semilla válida).
		expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes('/api/tasks'))).toBe(false);
		const calls = batchCalls(fetchSpy);
		expect(calls).toHaveLength(1);
		const body = JSON.parse(String((calls[0][1] as RequestInit).body)) as {
			ops: { taskId: string; kind: string; payload: Record<string, unknown> }[];
		};
		expect(body.ops[0]).toEqual({
			type: 'mutate',
			taskId: seriesId,
			kind: 'skipOccurrence',
			payload: { seriesId, date: '2026-10-01' }
		});
	});

	// La app toma `taskId` como la fila de la ocurrencia (`occurrenceId` de
	// `skipOccurrence`): con una ocurrencia MOVIDA de día, mandar `seriesId`
	// excluye la fecha pedida y deja la fila movida abierta, así que el id de
	// la fila tiene que llegar tal cual al envelope.
	it('skip_occurrence CON occurrenceId manda taskId=occurrenceId al envelope y seriesId/date en el payload', async () => {
		const seriesId = '44444444-4444-4444-8444-444444444444';
		const occurrenceId = '66666666-6666-4666-8666-666666666666';
		const fetchSpy = vi.fn().mockResolvedValue(
			jsonResponse({
				ok: true,
				results: [{ index: 0, type: 'mutate', ok: true, id: occurrenceId, materialization: 'applied' }]
			})
		);
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();

		const result = await client.callTool({
			name: 'mutate_tasks',
			arguments: { ops: [{ op: 'skip_occurrence', seriesId, date: '2026-10-01', occurrenceId }] }
		});

		expect(result.isError).not.toBe(true);
		expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes('/api/tasks'))).toBe(false);
		const calls = batchCalls(fetchSpy);
		expect(calls).toHaveLength(1);
		const body = JSON.parse(String((calls[0][1] as RequestInit).body)) as {
			ops: { taskId: string; kind: string; payload: Record<string, unknown> }[];
		};
		expect(body.ops[0]).toEqual({
			type: 'mutate',
			taskId: occurrenceId,
			kind: 'skipOccurrence',
			payload: { seriesId, date: '2026-10-01' }
		});
	});

	it('skip_occurrence con un occurrenceId que no es uuid falla por forma, sin encolar', async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();

		const text = resultText(
			await client.callTool({
				name: 'mutate_tasks',
				arguments: {
					ops: [
						{
							op: 'skip_occurrence',
							seriesId: '44444444-4444-4444-8444-444444444444',
							date: '2026-10-01',
							occurrenceId: 'recur:44444444-4444-4444-8444-444444444444:2026-10-01'
						}
					]
				}
			})
		);

		expect(text).toMatch(/occurrenceId/);
		expect(batchCalls(fetchSpy)).toHaveLength(0);
	});

	it('skip_occurrence sobre un seriesId que NO es semilla: el informe trae el notice target-missing', async () => {
		const seriesId = '55555555-5555-4555-8555-555555555555';
		const notice = `«skipOccurrence» no se aplicó: no existe nada con el id ${seriesId} (o ya estaba borrado).`;
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				jsonResponse({
					ok: true,
					results: [{ index: 0, type: 'mutate', ok: true, id: seriesId, materialization: 'noop' }],
					notices: [notice]
				})
			)
		);
		const client = await buildClient();

		const text = resultText(
			await client.callTool({
				name: 'mutate_tasks',
				arguments: { ops: [{ op: 'skip_occurrence', seriesId, date: '2026-10-01' }] }
			})
		);

		expect(text).toMatch(/\[0\] skip_occurrence: sin efecto/);
		expect(text).toContain(`avisos de la app:\n  - ${notice}`);
	});

	it.each([
		['archive_habit', 'archiveHabit'],
		['unarchive_habit', 'unarchiveHabit']
	])('%s (mutate_tasks): sin comprobación de existencia, viaja kind:%s con habitId como taskId', async (op, kind) => {
		const habitId = '66666666-6666-4666-8666-666666666666';
		const fetchSpy = vi.fn().mockResolvedValue(
			jsonResponse({ ok: true, results: [{ index: 0, type: 'mutate', ok: true, id: habitId, materialization: 'applied' }] })
		);
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();

		const result = await client.callTool({ name: 'mutate_tasks', arguments: { ops: [{ op, habitId }] } });

		expect(result.isError).not.toBe(true);
		expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes('/api/tasks'))).toBe(false);
		const calls = batchCalls(fetchSpy);
		const body = JSON.parse(String((calls[0][1] as RequestInit).body)) as {
			ops: { taskId: string; kind: string; payload: Record<string, unknown> }[];
		};
		expect(body.ops[0]).toEqual({ type: 'mutate', taskId: habitId, kind, payload: {} });
	});

	it('delete_habit (organize): sin comprobación de existencia, viaja kind:deleteHabit', async () => {
		const habitId = '77777777-7777-4777-8777-777777777777';
		const fetchSpy = vi.fn().mockResolvedValue(
			jsonResponse({ ok: true, results: [{ index: 0, type: 'mutate', ok: true, id: habitId, materialization: 'applied' }] })
		);
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();

		const result = await client.callTool({ name: 'organize', arguments: { ops: [{ op: 'delete_habit', habitId }] } });

		expect(result.isError).not.toBe(true);
		expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes('/api/tasks'))).toBe(false);
		const calls = batchCalls(fetchSpy);
		const body = JSON.parse(String((calls[0][1] as RequestInit).body)) as {
			ops: { taskId: string; kind: string; payload: Record<string, unknown> }[];
		};
		expect(body.ops[0]).toEqual({ type: 'mutate', taskId: habitId, kind: 'deleteHabit', payload: {} });
	});

	it('archive_habit NO existe en organize / delete_habit NO existe en mutate_tasks: puntero cruzado, sin tocar red', async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();

		const habitId = '88888888-8888-4888-8888-888888888888';
		const textOrganize = resultText(
			await client.callTool({ name: 'organize', arguments: { ops: [{ op: 'archive_habit', habitId }] } })
		);
		const textMutate = resultText(
			await client.callTool({ name: 'mutate_tasks', arguments: { ops: [{ op: 'delete_habit', habitId }] } })
		);

		expect(textOrganize).toContain('la op "archive_habit" no existe en organize; está en mutate_tasks');
		expect(textMutate).toContain('la op "delete_habit" no existe en mutate_tasks; está en organize');
		expect(batchCalls(fetchSpy)).toHaveLength(0);
	});

	it('add_task con listId de una lista YA EXISTENTE (sin create_list en el lote): NO parte el lote', async () => {
		const fetchSpy = vi.fn().mockResolvedValue(
			jsonResponse({ ok: true, results: [{ index: 0, type: 'ingest', ok: true, id: 't1' }] })
		);
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();

		const result = await client.callTool({
			name: 'mutate_tasks',
			arguments: { ops: [{ op: 'add_task', text: 'a', listId: EXISTING_LIST_ID }] }
		});

		expect(result.isError).not.toBe(true);
		expect(batchCalls(fetchSpy)).toHaveLength(1);
	});

	/**
	 * El encadenado intra-lote que SÍ sigue cabiendo en una llamada desde el
	 * reparto en dos tools (2026-09-19): `create_list` + una op que targetee
	 * ESA lista por el `listId` que le diste tú (uuid v4), las dos en
	 * `organize`. El cruce `create_list` + `add_task` (el del incidente
	 * 071553) ya no es expresable en una sola llamada — `add_task` vive en
	 * `mutate_tasks` —, así que son dos llamadas o un `add_task` con `list`
	 * por NOMBRE (que crea la lista si no existe); el reparto en fases que lo
	 * resolvía sigue probado, unidad a unidad, en `lumbre-client.test.ts`
	 * (`planBatchPhases`/`filterPhase2AfterPhase1`/
	 * `excludeIngestForBrokenListPromises`).
	 */
	it('organize: create_list + move_to_list con el listId prometido viajan juntos, en UNA petición', async () => {
		const TASK_ID = 'c2d3e4f5-a6b7-4890-9abc-def012345678';
		const fetchSpy = vi.fn(async (url: string | URL, init?: RequestInit) => {
			const value = String(url);
			if (value.includes('/api/tasks?ids=')) {
				return jsonResponse([
					{
						id: TASK_ID,
						content: 'tarea a mover',
						notes: null,
						done: false,
						priority: null,
						date: null,
						deadline: null,
						list: null,
						createdAt: '2026-09-19T00:00:00.000Z',
						parentId: null
					}
				]);
			}
			if (!value.endsWith('/api/batch')) throw new Error(`fetch no mockeado: ${value}`);
			const body = JSON.parse(String(init?.body)) as { ops: unknown[] };
			expect(body.ops).toEqual([
				{ type: 'mutate', taskId: LIST_ID, kind: 'createList', payload: { name: 'Trabajo' } },
				{ type: 'mutate', taskId: TASK_ID, kind: 'moveToList', payload: { listId: LIST_ID } }
			]);
			return jsonResponse({
				ok: true,
				results: [
					{ index: 0, type: 'mutate', ok: true, id: LIST_ID },
					{ index: 1, type: 'mutate', ok: true }
				]
			});
		});
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();

		const result = await client.callTool({
			name: 'organize',
			arguments: {
				ops: [
					{ op: 'create_list', name: 'Trabajo', listId: LIST_ID },
					{ op: 'move_to_list', taskId: TASK_ID, listId: LIST_ID }
				]
			}
		});

		expect(result.isError).not.toBe(true);
		expect(batchCalls(fetchSpy)).toHaveLength(1);
		const text = resultText(result);
		expect(text).toContain('2/2 operación(es) encoladas.');
		expect(text).toContain(`[0] create_list: id ${LIST_ID}`);
	});

	it('una op de la OTRA tool se rechaza por posición, con el puntero a su tool (y el resto del lote viaja)', async () => {
		const fetchSpy = vi.fn().mockResolvedValue(
			jsonResponse({ ok: true, results: [{ index: 0, type: 'ingest', ok: true, id: 't1' }] })
		);
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();

		const enMutateTasks = await client.callTool({
			name: 'mutate_tasks',
			arguments: {
				ops: [
					{ op: 'add_task', text: 'sí viaja' },
					{ op: 'delete', taskId: 'd4e5f6a7-b8c9-4012-9abc-def012345678' }
				]
			}
		});
		const mutateText = resultText(enMutateTasks);
		expect(mutateText).toContain('1/2 operación(es) encoladas.');
		expect(mutateText).toContain(
			'[1] delete: la op "delete" no existe en mutate_tasks; está en organize'
		);

		const enOrganize = await client.callTool({
			name: 'organize',
			arguments: { ops: [{ op: 'complete', taskId: 'd4e5f6a7-b8c9-4012-9abc-def012345678' }] }
		});
		expect(resultText(enOrganize)).toContain(
			'[0] complete: la op "complete" no existe en organize; está en mutate_tasks'
		);
	});

	// Regresión zod 4 (chore/zod4-vitest5): `formatOpShapeError` lee
	// `issue.code === 'unrecognized_keys'` e `issue.keys` de un `ZodError` —
	// zod 4 sigue emitiendo esa forma para `.strict()` (comprobado aparte),
	// pero este test cierra el camino END-TO-END: una op con un campo QUE NO
	// LE APLICA (pasa el schema EXPUESTO, que es `.passthrough()`, y la
	// rechaza el ESTRICTO por campo ajeno) debe seguir dando el mensaje
	// legible de siempre, no un volcado crudo de Zod.
	it('una op con un campo ajeno a ESA op (no de otra tool): mensaje "campo(s) que no aplican a"', async () => {
		const fetchSpy = vi.fn().mockResolvedValue(
			jsonResponse({ ok: true, results: [{ index: 0, type: 'ingest', ok: true, id: 't1' }] })
		);
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();

		const result = await client.callTool({
			name: 'mutate_tasks',
			arguments: {
				ops: [
					{ op: 'add_task', text: 'sí viaja' },
					// `complete` no tiene `bogusField` — campo ajeno a ESTA op, no una
					// op de la otra tool (ese caso ya lo cubre el test de arriba).
					{ op: 'complete', taskId: '11111111-1111-1111-1111-111111111111', bogusField: 'x' }
				]
			}
		});

		const text = resultText(result);
		expect(text).toContain('1/2 operación(es) encoladas.');
		expect(text).toContain('[1] complete: complete: campo(s) que no aplican a "complete": bogusField');
		// Solo la op válida llega a /api/batch — la de forma inválida nunca toca red.
		expect(batchCalls(fetchSpy)).toHaveLength(1);
	});

	it('organize: create_list + set_list_notes viajan juntos; un servidor aún sin ese kind lo informa como fallo parcial', async () => {
		// Backend simulado: este test acredita el cableado MCP y que una respuesta
		// de error no se presenta como éxito; no acredita la materialización CRDT.
		const fetchSpy = vi.fn(async (url: string | URL, init?: RequestInit) => {
			expect(String(url)).toBe('https://lumbre.test/api/batch');
			const body = JSON.parse(String(init?.body)) as { ops: unknown[] };
			expect(body.ops).toEqual([
				{ type: 'mutate', taskId: LIST_ID, kind: 'createList', payload: { name: 'Trabajo' } },
				{
					type: 'mutate',
					taskId: LIST_ID,
					kind: 'setListNotes',
					payload: { notes: 'Contexto restaurado', revive: true }
				}
			]);
			return jsonResponse({
				ok: true,
				results: [
					{ index: 0, type: 'mutate', ok: true, id: LIST_ID },
					{ index: 1, type: 'mutate', ok: false, error: 'kind de mutación desconocido: setListNotes' }
				]
			});
		});
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();

		const result = await client.callTool({
			name: 'organize',
			arguments: {
				ops: [
					{ op: 'create_list', name: 'Trabajo', listId: LIST_ID },
					{ op: 'set_list_notes', listId: LIST_ID, notes: 'Contexto restaurado', revive: true }
				]
			}
		});

		expect(batchCalls(fetchSpy)).toHaveLength(1);
		const text = resultText(result);
		expect(text).toContain('1/2 operación(es) encoladas.');
		expect(text).toContain(`[0] create_list: id ${LIST_ID}`);
		expect(text).toContain('[1] set_list_notes: kind de mutación desconocido: setListNotes');
	});

	it('organize: un create_list con FORMA inválida no tumba el lote, sale por posición', async () => {
		// Antes este caso probaba además que el `add_task` que dependía de ese
		// `create_list` no viajaba huérfano (incidente 071553). Ese cruce ya no
		// cabe en una llamada —`add_task` está en `mutate_tasks`—, así que aquí
		// se conserva lo que SÍ sigue siendo observable desde la tool: el
		// rechazo por forma, por posición, sin tocar red.
		const fetchSpy = vi.fn(async (url: string | URL) => {
			const value = String(url);
			if (!value.endsWith('/api/batch')) throw new Error(`fetch no mockeado: ${value}`);
			return jsonResponse({ ok: true, results: [] });
		});
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();

		const result = await client.callTool({
			name: 'organize',
			arguments: { ops: [{ op: 'create_list', listId: LIST_ID }] } // sin `name`
		});

		expect(result.isError).not.toBe(true);
		expect(batchCalls(fetchSpy)).toHaveLength(0);
		const text = resultText(result);
		expect(text).toContain('0/1 operación(es) encoladas.');
		expect(text).toContain('[0] create_list:');
	});
});

/**
 * `set_parent` (2026-09-25, encargo de David): convertir una tarea en subtarea
 * de otra y sacarla, con el cableado real de `mutate_tasks`. El contrato del
 * lado app (kind `setParent`, payload `{ parentId: uuid | null }`) lo describe
 * su sesión y aún no está en `main` de lumbre: las respuestas de rechazo de
 * aquí son SUPUESTAS con las dos formas que ya usa `/api/batch` (`ok:false`
 * con `error`, o `materialization:'noop'` con un aviso).
 */
describe('set_parent — anidar y desanidar una tarea', () => {
	const TASK_ID = '11111111-1111-4111-8111-111111111111';
	const PARENT_ID = '22222222-2222-4222-8222-222222222222';
	const OTHER_PARENT_ID = '33333333-3333-4333-8333-333333333333';

	function jsonResponse(body: unknown): Response {
		return new Response(JSON.stringify(body), {
			status: 200,
			headers: { 'content-type': 'application/json' }
		});
	}

	function task(overrides: Record<string, unknown> = {}) {
		return {
			id: TASK_ID,
			content: 'tarea',
			notes: null,
			done: false,
			priority: null,
			date: null,
			deadline: null,
			list: null,
			createdAt: '2026-09-25T00:00:00.000Z',
			parentId: null,
			...overrides
		};
	}

	async function buildClient() {
		const indexModule = await import('./index.js');
		const server = indexModule.createServer(TEST_CONFIG);
		const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
		const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		indexModule.stripToolsListSchema(serverTransport);
		await server.connect(serverTransport);
		const client = new Client({ name: 'set-parent-test-client', version: '0.0.0' });
		await client.connect(clientTransport);
		return client;
	}

	function batchCalls(fetchSpy: ReturnType<typeof vi.fn>) {
		return fetchSpy.mock.calls.filter((call) => String(call[0]).endsWith('/api/batch'));
	}

	function taskLookups(fetchSpy: ReturnType<typeof vi.fn>) {
		return fetchSpy.mock.calls.filter((call) => String(call[0]).includes('/api/tasks?'));
	}

	function batchOps(fetchSpy: ReturnType<typeof vi.fn>) {
		const calls = batchCalls(fetchSpy);
		expect(calls).toHaveLength(1);
		return (JSON.parse(String((calls[0][1] as RequestInit).body)) as { ops: unknown[] }).ops;
	}

	function resultText(result: unknown): string {
		const first = (result as { content: { type: string; text?: string }[] }).content[0];
		return first.type === 'text' ? (first.text ?? '') : '';
	}

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('con parentId uuid: resuelve tarea y madre en UNA petición agrupada y viaja kind:setParent', async () => {
		const fetchSpy = vi.fn().mockImplementation(async (url: unknown) => {
			if (String(url).includes('/api/tasks?')) {
				return jsonResponse([task(), task({ id: PARENT_ID, content: 'madre' })]);
			}
			return jsonResponse({
				ok: true,
				results: [{ index: 0, type: 'mutate', ok: true, id: TASK_ID, materialization: 'applied' }]
			});
		});
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();

		const result = await client.callTool({
			name: 'mutate_tasks',
			arguments: { ops: [{ op: 'set_parent', taskId: TASK_ID, parentId: PARENT_ID }] }
		});

		expect(result.isError).not.toBe(true);
		const lookups = taskLookups(fetchSpy);
		expect(lookups).toHaveLength(1);
		expect(String(lookups[0][0])).toContain(TASK_ID);
		expect(String(lookups[0][0])).toContain(PARENT_ID);
		expect(batchOps(fetchSpy)).toEqual([
			{ type: 'mutate', taskId: TASK_ID, kind: 'setParent', payload: { parentId: PARENT_ID } }
		]);
		const text = resultText(result);
		expect(text).toContain('1/1 operación(es) encoladas.');
		expect(text).toContain('Resultado en la app: 1 aplicadas.');
	});

	it('con parentId null sobre una SUBTAREA: la acepta como objetivo y viaja payload {parentId:null}', async () => {
		const fetchSpy = vi.fn().mockImplementation(async (url: unknown) => {
			if (String(url).includes('/api/tasks?')) return jsonResponse([task({ parentId: PARENT_ID })]);
			return jsonResponse({
				ok: true,
				results: [{ index: 0, type: 'mutate', ok: true, id: TASK_ID, materialization: 'applied' }]
			});
		});
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();

		const result = await client.callTool({
			name: 'mutate_tasks',
			arguments: { ops: [{ op: 'set_parent', taskId: TASK_ID, parentId: null }] }
		});

		expect(result.isError).not.toBe(true);
		const lookups = taskLookups(fetchSpy);
		expect(lookups).toHaveLength(1);
		expect(String(lookups[0][0])).not.toContain(PARENT_ID);
		expect(batchOps(fetchSpy)).toEqual([
			{ type: 'mutate', taskId: TASK_ID, kind: 'setParent', payload: { parentId: null } }
		]);
		expect(resultText(result)).not.toMatch(/fallaron/);
	});

	it('varias ops con madres distintas: una sola petición de existencia para todos los ids', async () => {
		const secondTask = '44444444-4444-4444-8444-444444444444';
		const fetchSpy = vi.fn().mockImplementation(async (url: unknown) => {
			if (String(url).includes('/api/tasks?')) {
				return jsonResponse([
					task(),
					task({ id: secondTask }),
					task({ id: PARENT_ID }),
					task({ id: OTHER_PARENT_ID })
				]);
			}
			return jsonResponse({
				ok: true,
				results: [
					{ index: 0, type: 'mutate', ok: true, id: TASK_ID, materialization: 'applied' },
					{ index: 1, type: 'mutate', ok: true, id: secondTask, materialization: 'applied' }
				]
			});
		});
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();

		await client.callTool({
			name: 'mutate_tasks',
			arguments: {
				ops: [
					{ op: 'set_parent', taskId: TASK_ID, parentId: PARENT_ID },
					{ op: 'set_parent', taskId: secondTask, parentId: OTHER_PARENT_ID }
				]
			}
		});

		expect(taskLookups(fetchSpy)).toHaveLength(1);
		expect(batchCalls(fetchSpy)).toHaveLength(1);
	});

	it('parentId que no es uuid: rechazo por forma, sin encolar', async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();

		const result = await client.callTool({
			name: 'mutate_tasks',
			arguments: { ops: [{ op: 'set_parent', taskId: TASK_ID, parentId: 'tarea-madre' }] }
		});

		expect(resultText(result)).toMatch(/parentId/);
		expect(batchCalls(fetchSpy)).toHaveLength(0);
	});

	it('sin parentId: rechazo por forma (null desanida, omitirlo no), sin encolar', async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();

		const text = resultText(
			await client.callTool({
				name: 'mutate_tasks',
				arguments: { ops: [{ op: 'set_parent', taskId: TASK_ID }] }
			})
		);

		expect(text).toContain('0/1 operación(es) encoladas.');
		expect(text).toMatch(/\[0\] set_parent: .*parentId/);
		expect(batchCalls(fetchSpy)).toHaveLength(0);
	});

	it('parentId inexistente (ni viva ni archivada): rechazada antes de encolar, las demás ops siguen', async () => {
		const fetchSpy = vi.fn().mockImplementation(async (url: unknown) => {
			const u = String(url);
			if (u.includes('/api/tasks?') && u.includes('includeArchived=true')) return jsonResponse([]);
			if (u.includes('/api/tasks?')) return jsonResponse([task()]);
			return jsonResponse({
				ok: true,
				results: [{ index: 0, type: 'mutate', ok: true, id: TASK_ID, materialization: 'applied' }]
			});
		});
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();

		const text = resultText(
			await client.callTool({
				name: 'mutate_tasks',
				arguments: {
					ops: [
						{ op: 'set_parent', taskId: TASK_ID, parentId: PARENT_ID },
						{ op: 'complete', taskId: TASK_ID }
					]
				}
			})
		);

		expect(text).toContain('1/2 operación(es) encoladas.');
		expect(text).toContain(`[0] set_parent: set_parent: la tarea madre ${PARENT_ID} no está entre las tareas`);
		expect(batchOps(fetchSpy)).toEqual([{ type: 'mutate', taskId: TASK_ID, kind: 'complete', payload: { done: true } }]);
	});

	it('madre ARCHIVADA: el cliente la encuentra con includeArchived y deja que decida el servidor', async () => {
		const fetchSpy = vi.fn().mockImplementation(async (url: unknown) => {
			const u = String(url);
			if (u.includes('/api/tasks?') && u.includes('includeArchived=true')) {
				return jsonResponse([task({ id: PARENT_ID, archivedAt: '2026-09-20T10:00:00.000Z' })]);
			}
			if (u.includes('/api/tasks?')) return jsonResponse([task()]);
			return jsonResponse({
				ok: true,
				results: [{ index: 0, type: 'mutate', ok: false, id: TASK_ID, error: 'La tarea madre está archivada' }]
			});
		});
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();

		const text = resultText(
			await client.callTool({
				name: 'mutate_tasks',
				arguments: { ops: [{ op: 'set_parent', taskId: TASK_ID, parentId: PARENT_ID }] }
			})
		);

		expect(batchCalls(fetchSpy)).toHaveLength(1);
		expect(text).toContain('[0] set_parent: La tarea madre está archivada');
	});

	it('rechazo del servidor al encolar (ok:false): el informe muestra su motivo literal', async () => {
		const reason = 'La tarea tiene fecha límite: quítala antes de convertirla en subtarea (deadline)';
		vi.stubGlobal(
			'fetch',
			vi.fn().mockImplementation(async (url: unknown) => {
				if (String(url).includes('/api/tasks?')) return jsonResponse([task(), task({ id: PARENT_ID })]);
				return jsonResponse({ ok: true, results: [{ index: 0, type: 'mutate', ok: false, id: TASK_ID, error: reason }] });
			})
		);
		const client = await buildClient();

		const text = resultText(
			await client.callTool({
				name: 'mutate_tasks',
				arguments: { ops: [{ op: 'set_parent', taskId: TASK_ID, parentId: PARENT_ID }] }
			})
		);

		expect(text).toContain('0/1 operación(es) encoladas.');
		expect(text).toContain(`1 fallaron:\n  [0] set_parent: ${reason}`);
	});

	it('rechazo del servidor al aplicar (noop + aviso): el informe dice sin efecto y reenvía el aviso', async () => {
		const notice = '«setParent» no se aplicó: la tarea tiene subtareas propias (un solo nivel).';
		vi.stubGlobal(
			'fetch',
			vi.fn().mockImplementation(async (url: unknown) => {
				if (String(url).includes('/api/tasks?')) return jsonResponse([task(), task({ id: PARENT_ID })]);
				return jsonResponse({
					ok: true,
					results: [{ index: 0, type: 'mutate', ok: true, id: TASK_ID, materialization: 'noop' }],
					notices: [notice]
				});
			})
		);
		const client = await buildClient();

		const text = resultText(
			await client.callTool({
				name: 'mutate_tasks',
				arguments: { ops: [{ op: 'set_parent', taskId: TASK_ID, parentId: PARENT_ID }] }
			})
		);

		expect(text).toMatch(/\[0\] set_parent: sin efecto/);
		expect(text).toContain(`avisos de la app:\n  - ${notice}`);
	});

	it('set_parent NO existe en organize: puntero a mutate_tasks, sin tocar red', async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();

		const text = resultText(
			await client.callTool({
				name: 'organize',
				arguments: { ops: [{ op: 'set_parent', taskId: TASK_ID, parentId: null }] }
			})
		);

		expect(text).toContain('la op "set_parent" no existe en organize; está en mutate_tasks');
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('get_task de una SUBTAREA pinta el id de su madre (parentId)', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([task({ parentId: PARENT_ID })])));
		const client = await buildClient();

		const text = resultText(await client.callTool({ name: 'get_task', arguments: { taskId: TASK_ID } }));

		expect(text).toContain(`- subtarea de: ${PARENT_ID} (parentId)`);
	});

	it('get_task de una tarea de primer nivel no pinta ninguna madre', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([task()])));
		const client = await buildClient();

		const text = resultText(await client.callTool({ name: 'get_task', arguments: { taskId: TASK_ID } }));

		expect(text).not.toContain('subtarea de:');
	});

	// Las subtareas no salen del listado: lo filtra la app en el modo listado
	// de `GET /api/tasks` (`parentId === undefined`), no el conector. Lo que
	// fija este test es que `list_tasks` pide SIEMPRE ese modo, con cualquier
	// combinación de filtros, y nunca `id=`/`ids=`/`updatedSince=`, que sí
	// devuelven subtareas.
	it.each(['today', 'week', 'upcoming', 'inbox', 'someday', 'overdue', 'all'])(
		'list_tasks scope %s pide el modo listado, que excluye subtareas sueltas',
		async (scope) => {
			const fetchSpy = vi.fn().mockResolvedValue(jsonResponse([]));
			vi.stubGlobal('fetch', fetchSpy);
			const client = await buildClient();

			await client.callTool({
				name: 'list_tasks',
				arguments: { scope, includeDone: true, includeArchived: true, notes: 'none' }
			});

			expect(fetchSpy).toHaveBeenCalledTimes(1);
			const url = new URL(String(fetchSpy.mock.calls[0][0]));
			expect(url.pathname).toBe('/api/tasks');
			for (const param of ['id', 'ids', 'updatedSince']) expect(url.searchParams.has(param)).toBe(false);
		}
	);
});

/**
 * Lote E del audit de paridad del MCP (23 sep 2026), con el cableado real de
 * las tools: MC1 (el informe cuenta lo que la app HIZO, no solo lo que
 * encoló, y reenvía sus avisos) y MC3 (la regla de repetición viaja entera y
 * un cambio parcial no borra lo no enviado).
 */
describe('resultado real por op (MC1) y recurrencia completa (MC3)', () => {
	const TASK_ID = '22222222-2222-4222-8222-222222222222';

	function jsonResponse(body: unknown): Response {
		return new Response(JSON.stringify(body), {
			status: 200,
			headers: { 'content-type': 'application/json' }
		});
	}

	async function buildClient() {
		const indexModule = await import('./index.js');
		const server = indexModule.createServer(TEST_CONFIG);
		const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
		const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		indexModule.stripToolsListSchema(serverTransport);
		await server.connect(serverTransport);
		const client = new Client({ name: 'outcome-test-client', version: '0.0.0' });
		await client.connect(clientTransport);
		return client;
	}

	function resultText(result: unknown): string {
		const first = (result as { content: { type: string; text?: string }[] }).content[0];
		return first.type === 'text' ? (first.text ?? '') : '';
	}

	function bodyOf(fetchSpy: ReturnType<typeof vi.fn>, suffix: string): Record<string, unknown> {
		const call = fetchSpy.mock.calls.find((c) => String(c[0]).endsWith(suffix));
		if (!call) throw new Error(`no hubo petición a ${suffix}`);
		return JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>;
	}

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('mutate_tasks: cuenta aplicadas / sin efecto / fallidas por op y reenvía los notices', async () => {
		const fetchSpy = vi.fn().mockResolvedValue(
			jsonResponse({
				ok: true,
				results: [
					{ index: 0, type: 'ingest', ok: true, id: 't1', materialization: 'applied' },
					{ index: 1, type: 'ingest', ok: true, id: 't2', materialization: 'noop' },
					{ index: 2, type: 'ingest', ok: true, id: 't3', materialization: 'failed' }
				],
				notices: ['La lista «Viejo» estaba borrada; la tarea fue a la Bandeja.']
			})
		);
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();

		const text = resultText(
			await client.callTool({
				name: 'mutate_tasks',
				arguments: {
					ops: [
						{ op: 'add_task', text: 'a' },
						{ op: 'add_task', text: 'b' },
						{ op: 'add_task', text: 'c' }
					]
				}
			})
		);

		expect(text).toContain('Resultado en la app: 1 aplicadas, 1 sin efecto, 1 fallidas al aplicar.');
		expect(text).toMatch(/\[1\] add_task: sin efecto/);
		expect(text).toMatch(/\[2\] add_task: falló al aplicarse/);
		expect(text).toContain('avisos de la app:\n  - La lista «Viejo» estaba borrada; la tarea fue a la Bandeja.');
		// La frase vieja prometía lo contrario de lo que ahora hace el informe.
		expect(text).not.toMatch(/sin confirmación inmediata/);
	});

	it('mutate_tasks: un servidor sin `materialization` deja la op «sin confirmar», nunca «aplicada»', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(jsonResponse({ ok: true, results: [{ index: 0, type: 'ingest', ok: true, id: 't1' }] }))
		);
		const client = await buildClient();
		const text = resultText(
			await client.callTool({ name: 'mutate_tasks', arguments: { ops: [{ op: 'add_task', text: 'a' }] } })
		);
		expect(text).toContain('Resultado en la app: 0 aplicadas, 1 sin confirmar.');
	});

	it('organize: una op en cuarentena se informa como tal, citando la causa y dónde se libera (SY6)', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string | URL) => {
				if (String(url).includes('/api/tasks?')) return jsonResponse([{ id: TASK_ID, content: 'x', done: false }]);
				return jsonResponse({
					ok: true,
					results: [{ index: 0, type: 'mutate', ok: true, id: TASK_ID, materialization: 'quarantined' }]
				});
			})
		);
		const client = await buildClient();
		const text = resultText(
			await client.callTool({ name: 'organize', arguments: { ops: [{ op: 'delete', taskId: TASK_ID }] } })
		);
		expect(text).toContain('en cuarentena');
		expect(text).toMatch(/\[0\] delete: retenido por seguridad \(cuarentena por borrado masivo\); se libera en \/admin/);
	});

	/**
	 * MC2 del audit de paridad (23 sep 2026), cableado real de la tool: el
	 * rechazo local (`buildBatchFromOps`) corta ANTES de llegar a
	 * `POST /api/batch` — la comprobación de existencia (`/api/tasks?ids=`) es
	 * la ÚNICA petición del lote.
	 */
	it('mutate_tasks: add_subtask sobre una SUBTAREA se rechaza ANTES de encolar', async () => {
		const fetchSpy = vi.fn(async (url: string | URL) => {
			if (String(url).includes('/api/tasks?')) {
				return jsonResponse([{ id: TASK_ID, content: 'subtarea', done: false, parentId: 'padre-1' }]);
			}
			throw new Error(`fetch inesperado en este test: ${url}`);
		});
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();
		const text = resultText(
			await client.callTool({
				name: 'mutate_tasks',
				arguments: { ops: [{ op: 'add_subtask', taskId: TASK_ID, subtasks: ['x'] }] }
			})
		);
		expect(text).toMatch(/anidamiento es de UN solo nivel/);
		expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes('/api/batch'))).toBe(false);
	});

	it('mutate_tasks: set_section sobre una tarea SIN lista se rechaza ANTES de encolar', async () => {
		const fetchSpy = vi.fn(async (url: string | URL) => {
			if (String(url).includes('/api/tasks?')) return jsonResponse([{ id: TASK_ID, content: 'x', done: false }]);
			throw new Error(`fetch inesperado en este test: ${url}`);
		});
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();
		const text = resultText(
			await client.callTool({
				name: 'mutate_tasks',
				arguments: { ops: [{ op: 'set_section', taskId: TASK_ID, section: 'Bugs' }] }
			})
		);
		expect(text).toMatch(/no pertenece a ningún proyecto o área/);
		expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes('/api/batch'))).toBe(false);
	});

	/**
	 * MC8 del audit de paridad (23 sep 2026): sobre una nota YA BORRADA la app
	 * escribe la celda (por eso `materialization: 'applied'`) pero la lectura
	 * la sigue ocultando. El MCP no puede saber de antemano si ESTA tarea
	 * estaba en ese caso (la API nunca expone `notesDeletedAt`), así que avisa
	 * SIEMPRE que `update` escribe texto de notas no vacío.
	 */
	it('mutate_tasks update.notes: el informe avisa siempre del posible borrado invisible (MC8)', async () => {
		const fetchSpy = vi.fn(async (url: string | URL) => {
			if (String(url).includes('/api/tasks?')) return jsonResponse([{ id: TASK_ID, content: 'x', done: false }]);
			return jsonResponse({
				ok: true,
				results: [{ index: 0, type: 'mutate', ok: true, id: TASK_ID, materialization: 'applied' }]
			});
		});
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();
		const text = resultText(
			await client.callTool({
				name: 'mutate_tasks',
				arguments: { ops: [{ op: 'update', taskId: TASK_ID, notes: 'nueva nota' }] }
			})
		);
		expect(text).toContain('aplicadas con aviso:');
		expect(text).toMatch(/\[0\] update: aplicada; si la nota de esa tarea estaba borrada/);
	});

	it('mutate_tasks update.notes vacío (borrado explícito): NO dispara el aviso de MC8', async () => {
		const fetchSpy = vi.fn(async (url: string | URL) => {
			if (String(url).includes('/api/tasks?')) return jsonResponse([{ id: TASK_ID, content: 'x', done: false }]);
			return jsonResponse({
				ok: true,
				results: [{ index: 0, type: 'mutate', ok: true, id: TASK_ID, materialization: 'applied' }]
			});
		});
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();
		const text = resultText(
			await client.callTool({
				name: 'mutate_tasks',
				arguments: { ops: [{ op: 'update', taskId: TASK_ID, notes: '' }] }
			})
		);
		expect(text).not.toContain('aplicadas con aviso');
	});

	it('add_task (tool): reenvía los notices de /api/ingest', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ok: true, notices: ['Fue a la Bandeja'] })));
		const client = await buildClient();
		const text = resultText(await client.callTool({ name: 'add_task', arguments: { text: 'a', list: 'X' } }));
		expect(text).toContain('Tarea añadida a Lumbre');
		expect(text).toContain('avisos de la app:\n  - Fue a la Bandeja');
	});

	it('add_task (tool): manda SIEMPRE `literal: true` a /api/ingest (tarea cd39f028) — el modelo no lo controla', async () => {
		const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();
		const result = await client.callTool({ name: 'add_task', arguments: { text: 'Comprar leche' } });
		expect(result.isError).not.toBe(true);
		expect(bodyOf(fetchSpy, '/api/ingest')).toMatchObject({ text: 'Comprar leche', literal: true });
	});

	it('mutate_tasks op add_task: manda SIEMPRE `literal: true` a /api/batch, misma tarea cd39f028', async () => {
		const fetchSpy = vi.fn().mockResolvedValue(
			jsonResponse({ ok: true, results: [{ index: 0, type: 'ingest', ok: true, id: 't1' }] })
		);
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();
		const result = await client.callTool({
			name: 'mutate_tasks',
			arguments: { ops: [{ op: 'add_task', text: 'Comprar leche' }] }
		});
		expect(result.isError).not.toBe(true);
		const body = bodyOf(fetchSpy, '/api/batch') as { ops: { task: Record<string, unknown> }[] };
		expect(body.ops[0].task).toMatchObject({ text: 'Comprar leche', literal: true });
	});

	it('add_task (tool): la regla completa llega entera a /api/ingest (antes Zod borraba byWeekday/streak…)', async () => {
		const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();
		const recurrence = {
			mode: 'calendar',
			freq: 'weekly',
			interval: 1,
			byWeekday: [0, 3],
			until: '2026-12-31',
			count: 20,
			streak: true
		};
		const result = await client.callTool({ name: 'add_task', arguments: { text: 'Correr', recurrence } });
		expect(result.isError).not.toBe(true);
		expect(bodyOf(fetchSpy, '/api/ingest').recurrence).toEqual(recurrence);
	});

	it('add_task (tool): un campo de regla desconocido falla en voz alta en vez de desaparecer', async () => {
		const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();
		const result = await client.callTool({
			name: 'add_task',
			arguments: { text: 'x', recurrence: { freq: 'weekly', weekdays: [0] } }
		});
		expect(result.isError).toBe(true);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('add_task (tool): un tag reservado (case-insensitive) se rechaza SIN llamar a la red — el estado va como @marca', async () => {
		const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();
		const result = await client.callTool({
			name: 'add_task',
			arguments: { text: 'x', tags: ['casa', 'WIP'] }
		});
		expect(result.isError).toBe(true);
		expect(resultText(result)).toMatch(/@marca/);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('add_task (tool): más de 50 subtareas se rechaza SIN llamar a la red (tope MAX_SUBTASKS de la app)', async () => {
		const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();
		const result = await client.callTool({
			name: 'add_task',
			arguments: { text: 'x', subtasks: Array.from({ length: 51 }, (_, i) => `sub ${i}`) }
		});
		expect(result.isError).toBe(true);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('mutate_tasks update: cambiar el intervalo de un HÁBITO conserva streak y byWeekday', async () => {
		const fetchSpy = vi.fn(async (url: string | URL) => {
			if (String(url).includes('/api/tasks?')) {
				return jsonResponse([
					{
						id: TASK_ID,
						content: 'Correr',
						done: false,
						recurrence: { freq: 'weekly', interval: 1, byWeekday: [0, 3], streak: true },
						seriesId: TASK_ID
					}
				]);
			}
			return jsonResponse({
				ok: true,
				results: [{ index: 0, type: 'mutate', ok: true, id: TASK_ID, materialization: 'applied' }]
			});
		});
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();
		const text = resultText(
			await client.callTool({
				name: 'mutate_tasks',
				arguments: { ops: [{ op: 'update', taskId: TASK_ID, recurrence: { interval: 2 } }] }
			})
		);
		expect(text).toContain('Resultado en la app: 1 aplicadas.');
		const ops = bodyOf(fetchSpy, '/api/batch').ops as { payload: Record<string, unknown> }[];
		expect(ops[0].payload).toEqual({
			recurrence: { freq: 'weekly', interval: 2, byWeekday: [0, 3], streak: true }
		});
	});

	it('mutate_tasks update: un campo de regla desconocido se rechaza en ESA op, sin tumbar el lote', async () => {
		const fetchSpy = vi.fn(async (url: string | URL) => {
			if (String(url).includes('/api/tasks?')) return jsonResponse([{ id: TASK_ID, content: 'x', done: false }]);
			return jsonResponse({ ok: true, results: [{ index: 0, type: 'mutate', ok: true, id: TASK_ID }] });
		});
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();
		const result = await client.callTool({
			name: 'mutate_tasks',
			arguments: {
				ops: [
					{ op: 'update', taskId: TASK_ID, recurrence: { habit: true } },
					{ op: 'complete', taskId: TASK_ID }
				]
			}
		});
		const text = resultText(result);
		expect(result.isError).not.toBe(true);
		expect(text).toContain('1/2 operación(es) encoladas.');
		expect(text).toMatch(/\[0\] update: .*habit/);
	});

	it('mutate_brl: un outcome not-found se informa, no se cuenta como aplicado', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string | URL) => {
				if (String(url).includes('/api/mutations')) {
					return jsonResponse({ ok: true, outcome: 'not-found', outcomes: ['not-found'] });
				}
				throw new Error(`fetch no mockeado: ${String(url)}`);
			})
		);
		const client = await buildClient();
		const text = resultText(
			await client.callTool({
				name: 'mutate_brl',
				arguments: { ops: [{ op: 'add', date: '2026-09-23', text: 'Apunte' }] }
			})
		);
		expect(text).toContain('Resultado en la app: 0 aplicadas, 1 sin objetivo.');
		expect(text).toMatch(/\[0\] add: sin efecto: la app no encontró el objetivo/);
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

/** `list_habits` (MC6, 2026-09-24): lectura vía `GET /api/export` — ver
 *  `tools/habits.ts`/`listHabitsExport` en `lumbre-client.ts`. */
describe('list_habits — lectura vía GET /api/export (MC6)', () => {
	function jsonResponse(body: unknown): Response {
		return new Response(JSON.stringify(body), {
			status: 200,
			headers: { 'content-type': 'application/json' }
		});
	}

	async function buildClient() {
		const indexModule = await import('./index.js');
		const server = indexModule.createServer(TEST_CONFIG);
		const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
		const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		indexModule.stripToolsListSchema(serverTransport);
		await server.connect(serverTransport);
		const client = new Client({ name: 'list-habits-test-client', version: '0.0.0' });
		await client.connect(clientTransport);
		return client;
	}

	function resultText(result: unknown): string {
		return (result as { content: { type: string; text: string }[] }).content
			.map((c) => c.text)
			.join('\n');
	}

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const EXPORT_BODY = {
		habits: [
			{ id: 'h1', nombre: 'Ejercicio', clase: 'cadencia' },
			{ id: 'h2', nombre: 'Leer', clase: 'registro', archivedAt: 1_700_000_000_000 }
		],
		habitLog: [
			{ id: 'l1', habitId: 'h1', date: '2026-09-22' },
			{ id: 'l2', habitId: 'h1', date: '2026-09-23' },
			// tareas/otras claves del export NO relacionadas: se ignoran tal cual
		],
		tasks: []
	};

	it('pide GET /api/export con el mismo Bearer que list_tasks, y solo los vivos por defecto', async () => {
		const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(EXPORT_BODY));
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();

		const result = await client.callTool({ name: 'list_habits', arguments: {} });

		expect(result.isError).not.toBe(true);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(fetchSpy.mock.calls[0][0]).toBe('https://lumbre.test/api/export');
		expect(fetchSpy.mock.calls[0][1]).toMatchObject({
			headers: { authorization: `Bearer ${TEST_CONFIG.token}` }
		});
		const text = resultText(result);
		expect(text).toContain('Ejercicio (cadencia)');
		expect(text).toContain('últimas ocurrencias: 2026-09-23, 2026-09-22');
		expect(text).not.toContain('Leer'); // archivado, omitido por defecto
		expect(text).toContain('1 archivado');
	});

	it('includeArchived:true los incluye, con la fecha de archivado', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(EXPORT_BODY)));
		const client = await buildClient();

		const result = await client.callTool({ name: 'list_habits', arguments: { includeArchived: true } });

		const text = resultText(result);
		expect(text).toContain('Leer (registro)');
		expect(text).toContain('[archivado 2023-11-14]');
	});

	it('sin hábitos: no falla, lo dice', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ habits: [], habitLog: [] })));
		const client = await buildClient();

		const result = await client.callTool({ name: 'list_habits', arguments: {} });
		expect(result.isError).not.toBe(true);
		expect(resultText(result)).toContain('0 hábitos');
	});

	it('servidor sin `habitLog` en la respuesta: no rompe, solo sin últimas ocurrencias', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(jsonResponse({ habits: [{ id: 'h1', nombre: 'Ejercicio', clase: 'cadencia' }] }))
		);
		const client = await buildClient();

		const result = await client.callTool({ name: 'list_habits', arguments: {} });
		expect(result.isError).not.toBe(true);
		expect(resultText(result)).not.toContain('últimas ocurrencias');
	});

	it('respuesta inesperada (sin `habits`): error explícito', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ok: true })));
		const client = await buildClient();

		const result = await client.callTool({ name: 'list_habits', arguments: {} });
		expect(result.isError).toBe(true);
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

// Bug real medido el 2026-09-17: `list_tasks({ list: "addons", section: "MCP" })`,
// sin `scope`, rotuló la cabecera "scope=today" con el CONTENIDO de scope=all
// (el servidor amplía su propio default a "all" cuando hay `list` sin `scope`
// — ver el JSDoc de `ListTasksInput.list` en lumbre-client.ts — pero la
// cabecera pintaba el default LOCAL de esta tool, "today", sin mirar `list`).
describe('effectiveScopeLabel — la cabecera de list_tasks etiqueta lo que el servidor de verdad aplica', () => {
	it('sin `scope` ni `list` → "today" (default de siempre)', () => {
		expect(effectiveScopeLabel({})).toBe('today');
	});

	it('sin `scope`, con `list` → "all" (el servidor amplía el alcance; la cabecera debe seguirlo)', () => {
		expect(effectiveScopeLabel({ list: 'addons' })).toBe('all');
	});

	it('`scope` explícito manda, tenga o no `list`', () => {
		expect(effectiveScopeLabel({ scope: 'today', list: 'addons' })).toBe('today');
		expect(effectiveScopeLabel({ scope: 'all', list: 'addons' })).toBe('all');
		expect(effectiveScopeLabel({ scope: 'week' })).toBe('week');
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
	 *
	 * Quién la consulta cambió el 2026-09-19: las nueve tools sueltas de
	 * mutación eran las llamantes naturales de `requireTaskExists` y ya no
	 * existen, así que la tool que lo ejercita aquí es `add_attachment`
	 * (`content_base64`, sin tocar disco). La INVALIDACIÓN por mutación local
	 * la hace ahora `mutate_tasks` al final del lote (`runOpsBatch` en
	 * `tools/batch.ts`), y es lo que comprueba el tercer test.
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

	/** `add_attachment` por la vía `content_base64`: pasa por
	 *  `requireTaskExists` y sube por `POST /api/attachments`, sin tocar
	 *  disco. */
	function attachArgs() {
		return {
			taskId: TASK_ID,
			content_base64: Buffer.from('hola').toString('base64'),
			filename: 'nota.txt'
		};
	}

	/** Mock compartido: existencia por `?id=`, alta de adjunto, y el
	 *  `?ids=` + `/api/batch` que usa `mutate_tasks`. */
	function taskFetch() {
		return vi.fn(async (url: string | URL) => {
			const u = String(url);
			if (u.includes('/api/tasks?id=')) return jsonResponse([lumbreTask()]);
			if (u.includes('/api/tasks?ids=')) return jsonResponse([lumbreTask()]);
			if (u.includes('/api/attachments')) {
				return jsonResponse({ id: 'att-1', filename: 'nota.txt', mime: 'text/plain', size: 4 });
			}
			if (u.includes('/api/batch')) {
				return jsonResponse({ ok: true, results: [{ index: 0, type: 'mutate', ok: true }] });
			}
			throw new Error(`fetch no mockeado en este test: ${u}`);
		});
	}

	it('un hit dentro del TTL evita el segundo GET de existencia', async () => {
		const fetchSpy = taskFetch();
		vi.stubGlobal('fetch', fetchSpy);

		const client = await buildClient();
		// get_task puebla `taskCache` (no consulta la caché, siempre trae fresco).
		await client.callTool({ name: 'get_task', arguments: { taskId: TASK_ID } });
		expect(countExistenceGets(fetchSpy)).toBe(1);

		// add_attachment → requireTaskExists reutiliza el hit: SIN GET nuevo.
		const result = await client.callTool({ name: 'add_attachment', arguments: attachArgs() });
		expect(result.isError).not.toBe(true);
		expect(countExistenceGets(fetchSpy)).toBe(1);
	});

	it('tras expirar el TTL, requireTaskExists vuelve a pedir', async () => {
		const { EXISTENCE_CACHE_TTL_MS } = await import('./existence-cache.js');
		let now = 1_000_000;
		const fetchSpy = taskFetch();
		vi.stubGlobal('fetch', fetchSpy);

		const client = await buildClient({ now: () => now });
		await client.callTool({ name: 'get_task', arguments: { taskId: TASK_ID } });
		expect(countExistenceGets(fetchSpy)).toBe(1);

		now += EXISTENCE_CACHE_TTL_MS; // justo al TTL: ya expiró (ver TaskExistenceCache.get)
		await client.callTool({ name: 'add_attachment', arguments: attachArgs() });
		expect(countExistenceGets(fetchSpy)).toBe(2);
	});

	it('una mutación LOCAL sobre el id invalida la caché — la siguiente vuelve a pedir', async () => {
		const fetchSpy = taskFetch();
		vi.stubGlobal('fetch', fetchSpy);

		const client = await buildClient();
		await client.callTool({ name: 'get_task', arguments: { taskId: TASK_ID } });
		expect(countExistenceGets(fetchSpy)).toBe(1);

		await client.callTool({ name: 'add_attachment', arguments: attachArgs() });
		expect(countExistenceGets(fetchSpy)).toBe(1); // hit — sin GET nuevo

		// El lote mutó localmente el mismo id → invalida `taskCache` (su
		// existencia la resolvió por `?ids=`, que no cuenta como GET de
		// existencia individual).
		await client.callTool({
			name: 'mutate_tasks',
			arguments: { ops: [{ op: 'complete', taskId: TASK_ID }] }
		});
		await client.callTool({ name: 'add_attachment', arguments: attachArgs() });
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
		const result = await client.callTool({ name: 'add_attachment', arguments: attachArgs() });
		expect(result.isError).toBe(true);
		// La propiedad que importa no es el TEXTO del mensaje (eso se reescribe),
		// es que sea un error y que nombre el taskId pedido: es lo que lo hace accionable.
		expect(firstResultText(result as { content: { type: string; text?: string }[] })).toContain(TASK_ID);
	});
});

/**
 * CABLEADO de la op `reschedule` sobre una SUBTAREA — el `assertTaskUsable`
 * puro ya se prueba en `lumbre-client.test.ts`, pero esa prueba no ve con qué
 * `allowSubtask` la llama el servidor, que es justo donde vivía la
 * restricción retirada el 2026-09-04. Aquí se llama la tool DE VERDAD
 * (servidor real + `fetch` mockeado) y se comprueba que la mutación llega al
 * servidor.
 *
 * Qué se retiró: `reschedule` aceptaba un `subtaskId` solo CON fecha porque
 * el `task-ops.unscheduleTask` de la app no tenía guard de `parentId`. Lo
 * tiene desde `a745235a` (desplegado), así que `date: null` sobre una
 * subtarea ya es legal y solo le limpia fecha y hora.
 *
 * Desde el 2026-09-19 la vía es `mutate_tasks({ops:[{op:'reschedule'…}]})`:
 * la tool suelta ya no existe, así que la existencia se resuelve con `?ids=`
 * y la mutación viaja en `POST /api/batch`.
 */
describe('op reschedule sobre una SUBTAREA (cableado real de la tool)', () => {
	const SUB_ID = '44444444-4444-4444-4444-444444444444';
	const PARENT_ID = '55555555-5555-5555-5555-555555555555';

	function subtaskRow(overrides: Record<string, unknown> = {}) {
		return {
			id: SUB_ID,
			content: 'subtarea de prueba',
			notes: null,
			done: false,
			priority: null,
			date: null,
			deadline: null,
			list: null,
			createdAt: new Date().toISOString(),
			parentId: PARENT_ID,
			...overrides
		};
	}

	function jsonResponse(body: unknown, status = 200): Response {
		return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
	}

	/** Ops de los `POST /api/batch` que llegaron al servidor, aplanadas: es
	 *  donde viaja hoy lo que antes iba una a una por `/api/mutations`. */
	function mutationBodies(fetchSpy: ReturnType<typeof vi.fn>): Record<string, unknown>[] {
		return fetchSpy.mock.calls
			.filter((call) => String(call[0]).includes('/api/batch'))
			.flatMap((call) => {
				const body = JSON.parse(String((call[1] as RequestInit).body)) as { ops: Record<string, unknown>[] };
				return body.ops;
			});
	}

	async function buildClientWith(fetchSpy: ReturnType<typeof vi.fn>) {
		vi.stubGlobal('fetch', fetchSpy);
		const indexModule = await import('./index.js');
		const server = indexModule.createServer(TEST_CONFIG);
		const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
		const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		indexModule.stripToolsListSchema(serverTransport);
		await server.connect(serverTransport);
		const client = new Client({ name: 'reschedule-subtask-client', version: '0.0.0' });
		await client.connect(clientTransport);
		return client;
	}

	function subtaskFetch() {
		return vi.fn(async (url: string | URL) => {
			const u = String(url);
			if (u.includes('/api/tasks?ids=')) return jsonResponse([subtaskRow()]);
			if (u.includes('/api/batch')) {
				return jsonResponse({ ok: true, results: [{ index: 0, type: 'mutate', ok: true }] });
			}
			throw new Error(`fetch no mockeado en este test: ${u}`);
		});
	}

	function resultText(result: unknown): string {
		const first = (result as { content: { type: string; text?: string }[] }).content[0];
		return first.type === 'text' ? (first.text ?? '') : '';
	}

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('con fecha: la encola (date es un accidental permitido en subtarea, docs/18 §2.5)', async () => {
		const fetchSpy = subtaskFetch();
		const client = await buildClientWith(fetchSpy);
		const result = await client.callTool({
			name: 'mutate_tasks',
			arguments: { ops: [{ op: 'reschedule', taskId: SUB_ID, date: '2026-01-01' }] }
		});
		expect(resultText(result)).toContain('1/1 operación(es) encoladas.');
		expect(mutationBodies(fetchSpy)).toEqual([
			{ type: 'mutate', taskId: SUB_ID, kind: 'reschedule', payload: { date: '2026-01-01' } }
		]);
	});

	it('con date:null: TAMBIÉN la encola — ya no se rechaza (guard de parentId en la app, a745235a)', async () => {
		const fetchSpy = subtaskFetch();
		const client = await buildClientWith(fetchSpy);
		const result = await client.callTool({
			name: 'mutate_tasks',
			arguments: { ops: [{ op: 'reschedule', taskId: SUB_ID, date: null }] }
		});
		expect(resultText(result)).toContain('1/1 operación(es) encoladas.');
		// La propiedad que importa: la mutación VIAJA. Antes se cortaba aquí y
		// nunca se mandaba.
		expect(mutationBodies(fetchSpy)).toEqual([
			{ type: 'mutate', taskId: SUB_ID, kind: 'reschedule', payload: { date: null } }
		]);
	});

	it('CONTROL — move_to_list sobre la MISMA subtarea sigue rechazándose (residencia, §2.5)', async () => {
		// Que `reschedule` se abriera no puede haber abierto las otras dos: si
		// este control cae, la apertura fue más ancha de lo pedido. Vive en
		// `organize` desde el reparto, así que se pide por ahí.
		const fetchSpy = subtaskFetch();
		const client = await buildClientWith(fetchSpy);
		const result = await client.callTool({
			name: 'organize',
			arguments: { ops: [{ op: 'move_to_list', taskId: SUB_ID, listId: PARENT_ID }] }
		});
		expect(resultText(result)).toContain('0/1 operación(es) encoladas.');
		expect(resultText(result)).toContain('SUBTAREA');
		expect(mutationBodies(fetchSpy)).toEqual([]);
	});

	it('25 sep 2026: set_waiting, archive y update.recurrence se cortan; clear_waiting y unarchive viajan', async () => {
		const fetchSpy = vi.fn(async (url: string | URL, init?: RequestInit) => {
			const u = String(url);
			if (u.includes('/api/tasks?ids=')) return jsonResponse([subtaskRow()]);
			if (u.includes('/api/batch')) {
				const { ops } = JSON.parse(String(init?.body)) as { ops: unknown[] };
				return jsonResponse({ ok: true, results: ops.map((_, index) => ({ index, type: 'mutate', ok: true })) });
			}
			throw new Error(`fetch no mockeado en este test: ${u}`);
		});
		const client = await buildClientWith(fetchSpy);
		const result = await client.callTool({
			name: 'mutate_tasks',
			arguments: {
				ops: [
					{ op: 'set_waiting', taskId: SUB_ID, until: '2099-01-01' },
					{ op: 'archive', taskId: SUB_ID },
					{ op: 'update', taskId: SUB_ID, recurrence: { freq: 'daily' } },
					{ op: 'clear_waiting', taskId: SUB_ID },
					{ op: 'unarchive', taskId: SUB_ID }
				]
			}
		});
		const text = resultText(result);
		expect(text).toContain('2/5 operación(es) encoladas.');
		expect(text).toMatch(/«esperando» no existe en una subtarea/);
		expect(text).toMatch(/archiva su tarea madre/);
		expect(text).toMatch(/recurrence no aplica/);
		expect(mutationBodies(fetchSpy).map((op) => op.kind)).toEqual(['clearWaiting', 'unarchive']);
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

	/**
	 * Una subtarea es una tarea de pleno derecho (25 sep 2026): el adjunto se
	 * sube con el `taskId` de la SUBTAREA, sin más campos, porque la app solo
	 * lee `taskId` y lo acepta si la fila está viva (ver `SUBTASK_ATTACHMENTS`).
	 * Las dos vías pasan por su propio `requireTaskExists`, así que se cubren
	 * las dos.
	 */
	it.each([
		['file_path', () => ({ file_path: filePath })],
		['content_base64', () => ({ content_base64: Buffer.from('hola').toString('base64'), filename: 'nota.txt' })]
	] as const)('taskId de una SUBTAREA por %s: sube con ese taskId a /api/attachments', async (_via, fileArgs) => {
		const uploadUrls: string[] = [];
		const fetchSpy = vi.fn(async (url: string | URL) => {
			const u = String(url);
			if (u.includes('/api/tasks?id=')) return jsonResponse([lumbreTask({ id: SUB_ID, parentId: TASK_ID })]);
			if (u.includes('/api/attachments?taskId=')) {
				uploadUrls.push(u);
				return jsonResponse({
					id: 'att-sub',
					taskId: SUB_ID,
					filename: 'adjunto',
					mime: 'application/octet-stream',
					size: 4,
					storageKey: 'attachments/att-sub',
					createdAt: 1_700_000_000_000
				});
			}
			throw new Error(`fetch no mockeado en este test: ${u}`);
		});
		vi.stubGlobal('fetch', fetchSpy);

		const client = await buildClient();
		const result = await client.callTool({
			name: 'add_attachment',
			arguments: { taskId: SUB_ID, ...fileArgs() }
		});
		expect(result.isError).not.toBe(true);
		expect(uploadUrls).toHaveLength(1);
		const uploadUrl = new URL(uploadUrls[0]!);
		expect(uploadUrl.searchParams.get('taskId')).toBe(SUB_ID);
		expect([...uploadUrl.searchParams.keys()]).toEqual(['taskId']);
		expect(firstResultText(result as { content: { type: string; text?: string }[] })).toContain(SUB_ID);
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

describe('delete_attachment — elimina un adjunto existente (DESTRUCTIVO)', () => {
	const ATTACHMENT_ID = '44444444-4444-4444-8444-444444444444';

	function jsonResponse(body: unknown, status = 200): Response {
		return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
	}

	async function buildClient() {
		const indexModule = await import('./index.js');
		const server = indexModule.createServer(TEST_CONFIG);
		const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
		const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		indexModule.stripToolsListSchema(serverTransport);
		await server.connect(serverTransport);
		const client = new Client({ name: 'delete-attachment-test-client', version: '0.0.0' });
		await client.connect(clientTransport);
		return client;
	}

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('camino feliz: llama DELETE con Bearer y devuelve texto más structuredContent', async () => {
		const fetchSpy = vi.fn(async (url: string | URL, init?: RequestInit) => {
			expect(String(url)).toBe(`https://lumbre.test/api/attachments/${ATTACHMENT_ID}`);
			expect(init?.method).toBe('DELETE');
			expect((init?.headers as Record<string, string>).authorization).toBe(
				'Bearer test-token-para-index-test'
			);
			return jsonResponse({ ok: true });
		});
		vi.stubGlobal('fetch', fetchSpy);

		const client = await buildClient();
		const result = await client.callTool({
			name: 'delete_attachment',
			arguments: { attachment_id: ATTACHMENT_ID }
		});

		expect(result.isError).not.toBe(true);
		expect(result.structuredContent).toEqual({ deleted: true, attachment_id: ATTACHMENT_ID });
		const first = (result.content as { type: string; text?: string }[])[0];
		expect(first?.type === 'text' ? first.text : '').toMatch(/eliminado.*no se puede deshacer/i);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it('404 ajeno/inexistente: error legible sin filtrar ownership', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ message: 'No encontrado' }, 404)));

		const client = await buildClient();
		const result = await client.callTool({
			name: 'delete_attachment',
			arguments: { attachment_id: ATTACHMENT_ID }
		});

		expect(result.isError).toBe(true);
		const first = (result.content as { type: string; text?: string }[])[0];
		const text = first?.type === 'text' ? first.text : '';
		expect(text).toContain(ATTACHMENT_ID);
		expect(text).toMatch(/no encontrado.*no pertenece/i);
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

	it('sin `toolset` (default): las 17 tools de siempre', async () => {
		expect(await toolNamesOf()).toHaveLength(17);
	});

	it('`toolset: "attachments"`: SOLO las tres tools de adjuntos', async () => {
		expect(await toolNamesOf({ toolset: 'attachments' })).toEqual([
			'add_attachment',
			'delete_attachment',
			'read_attachment'
		]);
	});

	it('`toolset: "all"` (explícito): las 17, igual que el default', async () => {
		expect(await toolNamesOf({ toolset: 'all' })).toHaveLength(17);
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

		const result = await client.callTool({
			name: 'list_tasks',
			arguments: { includeArchived: true }
		});
		const text = textOf(result as { content: { type: string; text?: string }[] });

		expect(fetchSpy).toHaveBeenCalledTimes(2);
		const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
		const phase1Url = urls.find((u) => !u.includes('ids='))!;
		const phase2Url = urls.find((u) => u.includes('ids='))!;
		expect(phase1Url).toContain('notes=length');
		expect(phase1Url).toContain('includeArchived=true');
		expect(phase2Url).toContain(`ids=${DONE_ID}`);
		expect(phase2Url).not.toContain(MARKER_ID); // solo el id íntegro, NO el del marcador
		expect(phase2Url).toContain('notes=full');
		expect(phase2Url).toContain('includeArchived=true');

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
