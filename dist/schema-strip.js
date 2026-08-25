/**
 * Extraído de `index.ts` (tarea M2, transporte HTTP remoto) para que
 * `http.ts` pueda aplicar la MISMA limpieza de `$schema` sin importar el
 * módulo stdio entero (que exige `LUMBRE_TOKEN` en el arranque y conecta un
 * `StdioServerTransport` a `process.stdin`/`stdout` como efecto secundario
 * de importarlo). `index.ts` reexporta ambas funciones para no romper a
 * quien ya las importaba de ahí (`index.test.ts`).
 */
/**
 * Borra `$schema` de `value`, recursivamente (arrays y objetos anidados) — la
 * conversión zod→JSON Schema del SDK mete
 * `"$schema":"http://json-schema.org/draft-07/schema#"` en el `inputSchema`
 * de CADA tool (una vez por tool, no una vez global): 1.071 chars en las 21
 * tools de hoy, que ni la API de Anthropic ni ningún cliente MCP leen (el
 * `$schema` de JSON Schema es metadata de qué DIALECTO usar para validar el
 * documento; aquí lo fija el propio SDK al generar, no hace falta que viaje).
 * Muta `value` in-place (no clona) — el llamante ya tiene una copia efímera
 * del mensaje JSON-RPC que va a mandar, no hay nada más que la referencie.
 */
export function stripSchemaRecursively(value) {
    if (Array.isArray(value)) {
        for (const item of value)
            stripSchemaRecursively(item);
        return;
    }
    if (value && typeof value === 'object') {
        delete value.$schema;
        for (const v of Object.values(value))
            stripSchemaRecursively(v);
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
export function stripToolsListSchema(transport) {
    const originalSend = transport.send.bind(transport);
    transport.send = async (message, options) => {
        const result = message.result;
        if (result && typeof result === 'object' && Array.isArray(result.tools)) {
            stripSchemaRecursively(result.tools);
        }
        return originalSend(message, options);
    };
    return transport;
}
//# sourceMappingURL=schema-strip.js.map