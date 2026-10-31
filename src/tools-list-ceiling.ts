/**
 * Techo de caracteres de `JSON.stringify(tools)` en `tools/list`. Es la fuente
 * ÚNICA: lo importan `index.test.ts`, `http.test.ts` y (desde `dist/`)
 * `scripts/smoke-remote.mjs`, para que el tope que se mide en producción sea el
 * mismo que el de los tests. El tope existe por el coste de contexto de los
 * clientes: no se sube para encajar una descripción nueva, se recorta texto.
 */
export const CHAR_CEILING = 27800;
