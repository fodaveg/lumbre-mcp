#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { stripToolsListSchema } from './schema-strip.js';
import { registerSyncTools } from './tools/sync.js';
import { registerAttachmentTools } from './tools/attachments.js';
import { registerListTools } from './tools/lists.js';
import { registerBrlTools } from './tools/brl.js';
import { registerTaskTools } from './tools/tasks.js';
import { registerBatchTool } from './tools/batch.js';
// Reexportadas tal cual: `index.test.ts` las importa directamente de
// `index.js` (guardarraíl de superficie expuesta, ver su JSDoc).
export { mutateBrlOpSchema, mutateBrlStrictOpSchema } from './tools/brl.js';
export { effectiveNotesMode, effectiveScopeLabel, refTexts } from './tools/tasks.js';
export { mutateTasksOpSchema, mutateTasksStrictOpSchema, organizeOpSchema, organizeStrictOpSchema } from './tools/batch.js';
import { fileNotesSeenStore } from './notes.js';
import { EXISTENCE_CACHE_TTL_MS, getExistenceCachesForToken } from './existence-cache.js';
/**
 * Conector MCP de Lumbre (transporte stdio, pensado para Claude Code). Fase 1:
 * `add_task` (escribe vía `/api/ingest`) y `list_tasks` (lee vía
 * `GET /api/tasks`, incluye los adjuntos de cada tarea). `read_attachment` lee
 * los BYTES de un adjunto (vía `GET /api/attachments/:id`, mismo token
 * ampliado para servirlos por `Authorization: Bearer` además de por sesión).
 * `add_attachment` es la vía inversa: sube un fichero LOCAL (por ruta, ver
 * `attachments.ts`) y lo enlaza a una tarea vía `POST /api/attachments` —a
 * diferencia de TODO lo demás en esta lista, es SÍNCRONA: no se encola, el
 * adjunto ya está enlazado cuando la tool responde (ver su JSDoc, más abajo).
 * `delete_attachment` retira un adjunto existente por id mediante
 * `DELETE /api/attachments/:id`; es destructiva y no ofrece deshacer.
 * Fase 2 (mutar una tarea EXISTENTE vía `/api/mutations`, ver PHASE2.md): ya
 * NO tiene tool suelta por operación — las nueve (`complete_task`/
 * `cancel_task`/`update_task`/`reschedule_task`/`delete_task`/`set_section`/
 * `add_subtask`/`complete_subtask`/`remove_section`) se retiraron el
 * 2026-09-19 (tarea 6f62c877) y son ops de las DOS tools de lote:
 * `mutate_tasks` (opera sobre UNA tarea: `complete`, `cancel`, `update`,
 * `reschedule`, `set_section`, `add_subtask`, `complete_subtask`, más el alta
 * `add_task`) y `organize` (reorganiza y BORRA: `delete`, `remove_section`,
 * `create_list`, `nest_list`, `rename_list`, `remove_list`,
 * `set_list_notes`, `move_to_list`). La gestión de listas de "Algún día"
 * (crear/anidar/renombrar/borrar una lista, mover una tarea a otra lista —
 * paridad UI↔MCP, `docs/20-contrato-lista.md`) perdió su tool suelta antes,
 * el 2026-08-27 (medido: 3.506 bytes de `tools/list` por 19 llamadas/mes de
 * uso real), y hoy vive en `organize` — `create_list.listId` es incluso un
 * SUPERCONJUNTO (encadenar dentro del mismo lote, cosa que la tool suelta
 * no tenía). `list_lists` (fix b00303b5) lee TODAS las listas vivas con su
 * recuento vía `GET /api/tasks?includeLists=1` — a diferencia de
 * `list_tasks({list})`, SÍ distingue una lista que existe pero está vacía de
 * una que no existe (ambas dan `[]` en `list_tasks`, ver su JSDoc); si trae
 * nota, la línea termina con el marcador `✎N ↻fecha` (tarea 827a7878, ver
 * `notes.ts`), nunca la nota entera. `get_list({ listId })` devuelve el
 * detalle de UN proyecto/área (tipo, padre, estado, recuento) con su nota
 * ÍNTEGRA y verbatim — pensada para leerla antes de reescribirla con
 * `organize({op:"set_list_notes"})`, que la REEMPLAZA entera.
 * `list_brl_entries`/`mutate_brl` (BRL, add-on experimental): leen y mutan el
 * REGISTRO del día —entradas `-` (nota) y `=` (pensamiento)—, que NO son
 * tareas y no salen en `list_tasks`; ver el bloque «BRL» más abajo (los tres
 * verbos sueltos, `add`/`update`/`delete_brl_entry`, se podaron el mismo día
 * que las de lista — mismo criterio: `mutate_brl` los cubre entero). Todas
 * usan el token personal de email-to-task de Lumbre (Ajustes → email
 * entrante), NUNCA hardcodeado — ver README.md.
 *
 * Todas las ops de Fase 2 necesitan el `taskId` de antemano: lo normal es
 * llamar primero a `list_tasks` para resolverlo por contenido/fecha. Igual
 * `read_attachment` necesita el `attachment_id` que trae `list_tasks` en el
 * campo `attachments` de cada tarea. TODAS validan que el `taskId` EXISTE
 * antes de encolar (ver `requireTaskExists` más abajo) — bug real hasta
 * 2026-07-17: un id mal transcrito se encolaba igual y se perdía en silencio.
 *
 * `list_tasks({ notes })` decide qué notas mostrar (default `'auto'`, ver
 * `src/notes.ts`): GARANTÍA — en `auto` una nota sale ÍNTEGRA (si lleva
 * `@done`/`#done`, si `notesUpdatedAt` es POSTERIOR a la última vez que este
 * MCP la mostró — huella local en disco por marca, ya no por hash, desde
 * 2026-07-25 — o si se tocó dentro de `notesRecentHours` cuando aún no hay
 * huella) o como marcador `✎N ↻fecha` con su tamaño y la fecha de la última
 * edición, NUNCA truncada a medias (un truncado se confunde con "ya la leí
 * completa", que es justo el bug que motivó esta feature — David escribe su
 * feedback al final de la nota, y el preview de 240 chars se lo comía el 90%
 * de las veces). `notesSince` es una consulta de precisión aparte, SIN
 * estado: solo la marca decide, ignorando @done/huella — "qué cambió desde
 * X". `'none'` omite las notas, `'preview'` es el recorte legado a ~240
 * chars (ya no es el default), `'full'` las deja íntegras para TODO el lote
 * (`fullNotes: true` sigue siendo su alias). `get_task(taskId)` devuelve una
 * única tarea completa (notas verbatim + `createdAt` + lista/sección) —
 * pensado para reeditar una nota con `mutate_tasks({op:"update"})` (que la
 * REEMPLAZA entera) sin destruir lo que un marcador/preview no traía.
 *
 * `list_tasks`/`get_task` resuelven además, EN VIVO, las referencias
 * `[[task:ID|Etiqueta]]`/`[[list:ID|Etiqueta]]` que traiga el texto o las notas
 * del lote (`refs.ts`): título ACTUAL + estado + id + marcador `✎N` si la tarea
 * referenciada tiene nota, y ROTA declarada si el destino ya no existe. Antes
 * se reenviaba la etiqueta congelada del enlace, así que una referencia rota
 * era indistinguible de una viva. Cuesta como mucho DOS peticiones extra por
 * lote (una `?ids=` con todos los ids de tarea de golpe + una `?includeLists=1`
 * solo si hay referencias a listas) y CERO si el lote no tiene referencias.
 */
function loadConfig() {
    const token = process.env.LUMBRE_TOKEN?.trim();
    if (!token) {
        console.error('[lumbre-mcp] Falta LUMBRE_TOKEN. Configúralo en el bloque `env` de tu ' +
            'mcpServers (Ajustes → email entrante en Lumbre para conseguirlo). ' +
            'Sin él, ninguna tool puede autenticarse — ver mcp/README.md.');
        process.exit(1);
    }
    const baseUrl = process.env.LUMBRE_BASE_URL?.trim() || 'https://app.lumbre.pro';
    // `authMode: 'token'` — este proceso stdio SIEMPRE lee una credencial
    // estática de env (ver el JSDoc de `LumbreConfig.authMode`); un 401 de la
    // API sí puede resolverse configurando `LUMBRE_TOKEN` de nuevo.
    return { baseUrl, token, authMode: 'token' };
}
/**
 * Factory del servidor MCP de Lumbre: registra las tools con `config`
 * INYECTADO (nada de estado de módulo, ver el histórico de este fichero) y
 * devuelve el `McpServer` ya construido, sin conectar a ningún transporte —
 * eso es cosa del llamante (`main`, más abajo, para stdio; `http.ts` para el
 * transporte remoto). Registra las 16 de siempre salvo que
 * `opts.toolset === 'attachments'` (ver su JSDoc arriba), en cuyo caso solo
 * quedan `add_attachment`/`read_attachment`/`delete_attachment` — las demás
 * se registran igual
 * (para no bifurcar cada una de las 13 llamadas a `registerTool` con un
 * `if`) y se retiran acto seguido con `.remove()`, ANTES de que este
 * `McpServer` se conecte a ningún transporte: ningún cliente llega a ver el
 * estado intermedio de "16 registradas".
 *
 * `taskCache`/`brlCache` (cachés cortas de existencia, ver
 * `existence-cache.ts`) salen del registro de MÓDULO indexado por
 * `config.token` — no de una instancia nueva por llamada: en el transporte
 * HTTP remoto (`http.ts`) esta factory se invoca DENTRO de cada petición, así
 * que una caché de instancia nacía y moría con ella sin llegar a acertar
 * nunca (medido: 0 aciertos en remoto). El registro sí sobrevive entre
 * llamadas — vive mientras viva el proceso — y aísla por token (ver el
 * JSDoc de `getExistenceCachesForToken`), así que dos credenciales
 * distintas nunca comparten caché.
 */
export function createServer(config, opts = {}) {
    const notesSeenStore = opts.notesSeenStore ?? fileNotesSeenStore;
    const { taskCache, brlCache } = getExistenceCachesForToken(config.token, EXISTENCE_CACHE_TTL_MS, opts.now ?? Date.now);
    const localFilesystem = opts.localFilesystem ?? true;
    const toolset = opts.toolset ?? 'all';
    const server = new McpServer({ name: 'lumbre-mcp', version: '0.1.0' });
    // Contexto explícito para las familias YA migradas a `src/tools/` (ver el
    // JSDoc de `ToolCtx`) — crece según avanza la partición de este fichero.
    const ctx = { config, taskCache, brlCache, notesSeenStore, localFilesystem };
    // Orden de REGISTRO por familia (decisión de David, 2026-09-17): no es el
    // orden de MIGRACIÓN (sync→adjuntos→listas→BRL→tareas→lote, de menor a
    // mayor riesgo — ver los commits de la tarea 3) ni depende de qué módulo
    // necesita a cuál (`requireTaskExists`/`mutateTaskInvalidating` viven en
    // `tools/task-existence.ts`, no en `tools/tasks.ts`, precisamente para que
    // `tools/attachments.ts` pueda usarlas sin importar de `tools/tasks.ts`).
    // Es el orden en que un cliente MCP VE las 16 tools en `tools/list`, y eso
    // influye en cuál prueba antes un modelo: tareas individuales encabeza
    // (ya empieza por alta/listado/lectura, lo más usado), luego el lote,
    // listas y proyectos, adjuntos, BRL, y `sync` AL FINAL — `refresh_sync`
    // casi nunca hace falta tras una escritura de este MCP (ver su JSDoc en
    // `tools/sync.ts`), así que no debe encabezar el listado. El orden
    // expuesto en `tools/list` no está bajo test en ningún sitio de este repo
    // (el test de nombres compara por conjunto, con `.sort()`), así que este
    // comentario es la única fuente de verdad de POR QUÉ es este orden y no
    // otro.
    // Familia «tareas individuales» (`src/tools/tasks.ts`): add_task/
    // list_tasks/get_task (las nueve de Fase 2 son ops del lote desde el
    // 2026-09-19 — ver `src/tools/batch.ts`).
    const { addTaskTool, listTasksTool, getTaskTool } = registerTaskTools(server, ctx);
    // Familia «lote de tareas» (`src/tools/batch.ts`, `plan-batch.md`): N
    // operaciones de golpe — planifica fases y valida por-op. `mutate_tasks`
    // opera sobre UNA tarea; `organize` reorganiza y borra.
    const { mutateTasksTool, organizeTool } = registerBatchTool(server, ctx);
    // Familia «listas y proyectos» (`src/tools/lists.ts`, paridad UI↔MCP,
    // `docs/20-contrato-lista.md`).
    const { listListsTool, getListLinksTool, getListTool, linkListNoteTool, unlinkListNoteTool } = registerListTools(server, ctx);
    // Familia «adjuntos» (`src/tools/attachments.ts`): las tres tools que
    // quedan solas en `toolset: 'attachments'`, ver `CreateServerOptions`. Sus
    // tres handles no se usan aquí (no entran en el filtro de abajo — son las
    // que SE QUEDAN cuando `toolset` acota), así que no se desestructuran.
    registerAttachmentTools(server, ctx);
    // Familia «BRL» (`src/tools/brl.ts`, add-on experimental de registro del
    // día).
    const { listBrlEntriesTool, mutateBrlTool } = registerBrlTools(server, ctx);
    // Familia «sync» (`src/tools/sync.ts`, ver su JSDoc: por qué `refresh_sync`
    // casi nunca hace falta tras una escritura de ESTE MCP) — AL FINAL a
    // propósito, ver el comentario de arriba.
    const { refreshSyncTool } = registerSyncTools(server, ctx);
    // Modo acotado (`toolset === 'attachments'`, ver `CreateServerOptions`):
    // retira las 13 tools que NO son `add_attachment`/`read_attachment`/
    // `delete_attachment` — TODAS se registraron arriba igual (para no bifurcar
    // cada una de las 13 llamadas a `registerTool` con un `if`), así que aquí
    // solo se deshace lo
    // que sobra, ANTES de que `server` se conecte a ningún transporte: ningún
    // cliente llega a ver el `tools/list` de 16 en el intermedio.
    if (toolset === 'attachments') {
        for (const tool of [
            addTaskTool,
            refreshSyncTool,
            listTasksTool,
            listListsTool,
            getListLinksTool,
            getListTool,
            linkListNoteTool,
            unlinkListNoteTool,
            getTaskTool,
            listBrlEntriesTool,
            mutateBrlTool,
            mutateTasksTool,
            organizeTool
        ]) {
            tool.remove();
        }
    }
    return server;
}
// Extraído a `schema-strip.ts` (tarea M2, transporte HTTP remoto) para que
// `http.ts` pueda reutilizar la MISMA limpieza de `$schema` sin importar
// este módulo entero (exige `LUMBRE_TOKEN` y conecta stdio al importarse).
// Reexportado aquí para no romper a `index.test.ts`, que ya las importaba
// de `index.js`.
export { stripSchemaRecursively, stripToolsListSchema } from './schema-strip.js';
/**
 * Modo acotado del arranque stdio (ver `CreateServerOptions.toolset`):
 * `LUMBRE_MCP_TOOLSET=attachments` registra solo `add_attachment`/
 * `read_attachment`/`delete_attachment`, pensado para un SEGUNDO conector
 * stdio local dedicado (David enchufa a la vez el remoto de las 16 tools y
 * este, sin duplicar superficie — ver README). Cualquier otro valor (incluido
 * no ponerla) cae
 * al default `'all'` de `createServer` — nunca falla por un valor raro, un
 * typo en la env simplemente no acota nada.
 */
function toolsetFromEnv() {
    return process.env.LUMBRE_MCP_TOOLSET?.trim() === 'attachments' ? 'attachments' : 'all';
}
/**
 * Arranque real por stdio (el único transporte que corre en la máquina del
 * usuario): resuelve `config` desde el entorno (`loadConfig`, que SÍ puede
 * `process.exit(1)` si falta `LUMBRE_TOKEN` — ver su JSDoc), crea el servidor
 * con `createServer` y lo conecta a `StdioServerTransport`. Pasa
 * `localFilesystem: true` EXPLÍCITO (aunque hoy coincide con el default, ver
 * `CreateServerOptions`): este proceso corre en la máquina del usuario, así
 * que `add_attachment({ file_path })` sí puede leer su disco — a diferencia
 * de `http.ts`, que pasa `false`. `toolset` sale de `LUMBRE_MCP_TOOLSET`
 * (`toolsetFromEnv`).
 *
 * Separado de la carga del módulo (antes `loadConfig()`/`new McpServer()`
 * corrían como efecto secundario del propio `import`, lo que obligaba a
 * `index.test.ts` a fijar `LUMBRE_TOKEN` en el entorno y a cerrar una
 * conexión stdio real antes de poder testear nada) — importar este fichero ya
 * no hace NADA por sí solo; solo `main()` (o el guard de más abajo) arranca
 * de verdad.
 */
export async function main() {
    const config = loadConfig();
    const server = createServer(config, { localFilesystem: true, toolset: toolsetFromEnv() });
    const transport = stripToolsListSchema(new StdioServerTransport());
    await server.connect(transport);
}
// Solo arranca stdio si este fichero se ejecuta DIRECTAMENTE (`node
// dist/index.js`), no cuando otro módulo lo importa (tests, un futuro
// entrypoint HTTP): `process.argv[1]` es el script que Node lanzó, y se
// compara por URL de fichero (no por string a pelo) para que funcione igual
// en Windows, donde las rutas no son comparables tal cual.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main();
}
//# sourceMappingURL=index.js.map