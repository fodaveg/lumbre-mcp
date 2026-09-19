import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/**
 * Extraído de `index.ts` (tarea M2, transporte HTTP remoto) para que
 * `http.ts` pueda aplicar la MISMA limpieza de `$schema` sin importar el
 * módulo stdio entero (que exige `LUMBRE_TOKEN` en el arranque y conecta un
 * `StdioServerTransport` a `process.stdin`/`stdout` como efecto secundario
 * de importarlo). `index.ts` reexporta ambas funciones para no romper a
 * quien ya las importaba de ahí (`index.test.ts`).
 */

/**
 * Límite que zod 4 (`zod/v4-mini`, ver más abajo) mete SOLO por ser
 * `z.number().int()`, sin que nadie haya pedido un tope — `Number.MAX_SAFE_INTEGER`.
 * Ninguna tool de este repo pone un `maximum` de negocio que coincida con este
 * valor exacto (el único entero con tope explícito es `days`, ≤14), así que
 * borrarlo siempre que aparezca es seguro.
 */
const ZOD4_DEFAULT_INT_MAXIMUM = Number.MAX_SAFE_INTEGER;

/**
 * Borra de `value`, recursivamente (arrays y objetos anidados), tres cosas
 * que mete la conversión zod→JSON Schema del SDK pero que ni la API de
 * Anthropic ni ningún cliente MCP necesitan — normaliza el `tools/list` que
 * sale por el wire para que no dependa de qué versión de zod lo generó (tarea
 * `chore/zod4-vitest5`, subida de zod 3→4):
 *
 * 1. `$schema` — `"http://json-schema.org/draft-07/schema#"` en el
 *    `inputSchema` de CADA tool (una vez por tool, no una vez global): 1.071
 *    chars en las 21 tools de julio de 2026. Es metadata de qué DIALECTO usar
 *    para validar el documento; aquí lo fija el propio SDK al generar, no
 *    hace falta que viaje.
 * 2. El `pattern` que acompaña a `format: "uuid"` — zod 4 usa su
 *    `toJSONSchema` nativo (`zod/v4-mini`, ver `zod-json-schema-compat.js`
 *    del SDK) para las tools en vez de la `zod-to-json-schema` de zod 3, y
 *    ese conversor añade el `pattern` completo de la validación aunque el
 *    campo ya declare `format: "uuid"` (redundante: el `format` ya dice qué
 *    es). zod 3 nunca lo emitía.
 * 3. `maximum: Number.MAX_SAFE_INTEGER` en un entero (`ZOD4_DEFAULT_INT_MAXIMUM`,
 *    arriba) — mismo conversor nativo, mismo motivo: un tope que nadie pidió.
 *
 * Además RECONSTRUYE dos cosas que el conversor nativo de zod 4 omite o
 * representa distinto frente al de zod 3, para que el `inputSchema` publicado
 * no cambie de forma por la subida de versión:
 *
 * 4. `additionalProperties: false` en cualquier objeto (`type: "object"` con
 *    `properties`) que no lo traiga ya — es el default con el que zod 3
 *    publicaba un `z.object()` normal (ni `.strict()` ni `.passthrough()`);
 *    zod 4 simplemente no pone la clave, que en JSON Schema equivale a
 *    permitir cualquier propiedad extra — un contrato más laxo que el que
 *    veía el modelo antes de esta subida.
 * 5. `additionalProperties: {}` (el `.passthrough()` de zod 4: "cualquier
 *    valor vale") se reescribe a `additionalProperties: true` — MISMO
 *    significado en JSON Schema, pero es la forma que emitía zod 3 para
 *    `.passthrough()` (`mutate_tasks`/`organize`).
 *
 * Muta `value` in-place (no clona) — el llamante ya tiene una copia efímera
 * del mensaje JSON-RPC que va a mandar, no hay nada más que la referencie.
 */
export function stripSchemaRecursively(value: unknown): void {
	if (Array.isArray(value)) {
		for (const item of value) stripSchemaRecursively(item);
		return;
	}
	if (value && typeof value === 'object') {
		const obj = value as Record<string, unknown>;
		delete obj.$schema;
		if (obj.format === 'uuid') delete obj.pattern;
		if (obj.maximum === ZOD4_DEFAULT_INT_MAXIMUM) delete obj.maximum;
		const properties = obj.properties;
		const hasNonEmptyProperties =
			properties !== null && typeof properties === 'object' && Object.keys(properties).length > 0;
		if (obj.type === 'object' && hasNonEmptyProperties) {
			// Un `inputSchema: {}` SIN campos (`list_lists`/`refresh_sync`) no pasa
			// por el conversor de zod — el SDK lo sirve directo desde su propia
			// constante `EMPTY_OBJECT_JSON_SCHEMA`, IGUAL en zod 3 y zod 4, y esa
			// constante nunca trajo `additionalProperties`; solo se reconstruye
			// aquí para un objeto con campos de verdad.
			if (!('additionalProperties' in obj)) {
				obj.additionalProperties = false;
			} else if (
				typeof obj.additionalProperties === 'object' &&
				obj.additionalProperties !== null &&
				Object.keys(obj.additionalProperties as Record<string, unknown>).length === 0
			) {
				obj.additionalProperties = true;
			}
		}
		for (const v of Object.values(obj)) stripSchemaRecursively(v);
	}
}

/**
 * Envuelve `transport.send` para interceptar la respuesta de `tools/list`
 * (un mensaje JSON-RPC `result` con un array `tools`) y borrarle `$schema` a
 * cada `inputSchema` ANTES de que salga por el wire — ver `stripSchemaRecursively`.
 *
 * POR QUÉ AQUÍ Y NO sustituyendo el handler de `tools/list`: `McpServer`
 * registra ESE handler internamente (`setToolRequestHandlers`, ver
 * `node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js`) con la
 * lógica real de listar/filtrar/convertir cada tool registrada — pisarlo
 * significaría reimplementar esa lógica a mano y que se desincronice en
 * cuanto el SDK cambie de versión. Envolver `send` es un parche NO invasivo
 * (no toca la lógica de negocio del SDK, solo el mensaje ya serializado justo
 * antes de mandarlo) y a prueba de que el SDK cambie CÓMO genera `$schema`
 * (mientras siga siendo un campo llamado igual en `inputSchema`, esto lo pilla).
 *
 * Recibe y devuelve un `Transport` genérico (no específicamente
 * `StdioServerTransport` ni `StreamableHTTPServerTransport`) para poder
 * aplicar la MISMA lógica sobre un transporte in-memory en tests
 * (`index.test.ts`) o sobre el transporte HTTP (`http.ts`) sin duplicar
 * código; en stdio se aplica sobre el `StdioServerTransport` real.
 *
 * ALERTA para quien lea esto dentro de un año: NO es evidente por qué existe
 * (parece un parche raro sobre un objeto ajeno) — el motivo es puramente de
 * coste en tokens de la superficie de tools (ver la tarea que lo introdujo,
 * 2026-07-25); si el SDK algún día deja de emitir `$schema`, esto se puede
 * borrar sin más.
 */
export function stripToolsListSchema(transport: Transport): Transport {
	const originalSend = transport.send.bind(transport);
	transport.send = async (message: JSONRPCMessage, options?: TransportSendOptions) => {
		const result = (message as { result?: unknown }).result;
		if (result && typeof result === 'object' && Array.isArray((result as { tools?: unknown }).tools)) {
			stripSchemaRecursively((result as { tools: unknown }).tools);
		}
		return originalSend(message, options);
	};
	return transport;
}
