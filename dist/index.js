#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { stripToolsListSchema } from './schema-strip.js';
import { z } from 'zod';
import { addTask, assertTaskUsable, buildBatchFromOps, collectExistenceCheckIds, findTaskById, findTasksByIds, getAttachment, listBrlEntries, listLists, listTasks, mutateTask, priorityToLevel, refreshSync, runBatch, taskNotFoundError, uploadAttachment, LumbreApiError } from './lumbre-client.js';
import { formatListSummaries, formatTaskFull, formatTaskList } from './format.js';
import { resolveRefs } from './refs.js';
import { decodeBase64Attachment, readLocalAttachment } from './attachments.js';
import { computeAutoNotesRender, computeNotesSinceRender, DEFAULT_NOTES_RECENT_HOURS, fileNotesSeenStore, hasNotes, parseNotesSince, recordNotesSeen } from './notes.js';
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
 * Fase 2: `complete_task`/`cancel_task`/`update_task`/`reschedule_task`/
 * `delete_task`/`set_section`/`add_subtask`/`complete_subtask`/
 * `remove_section` (mutan una tarea EXISTENTE vía `/api/mutations` — ver
 * PHASE2.md; `remove_section` es la excepción, muta una SECCIÓN). La gestión
 * de listas de "Algún día" (crear/anidar/renombrar/borrar una lista, mover
 * una tarea a otra lista — paridad UI↔MCP, `docs/20-contrato-lista.md`) YA NO
 * tiene tool suelta (podadas el 2026-08-27, medido: 3.506 bytes de
 * `tools/list` por 19 llamadas/mes de uso real): son las ops
 * `create_list`/`nest_list`/`rename_list`/`remove_list`/`move_to_list` de
 * `mutate_tasks`, que ya las cubría entera — `create_list.listId` es incluso
 * un SUPERCONJUNTO (encadenar dentro del mismo lote, cosa que la tool suelta
 * no tenía). `list_lists` (fix b00303b5) lee TODAS las listas vivas con su
 * recuento vía `GET /api/tasks?includeLists=1` — a diferencia de
 * `list_tasks({list})`, SÍ distingue una lista que existe pero está vacía de
 * una que no existe (ambas dan `[]` en `list_tasks`, ver su JSDoc).
 * `list_brl_entries`/`mutate_brl` (BRL, add-on experimental): leen y mutan el
 * REGISTRO del día —entradas `-` (nota) y `=` (pensamiento)—, que NO son
 * tareas y no salen en `list_tasks`; ver el bloque «BRL» más abajo (los tres
 * verbos sueltos, `add`/`update`/`delete_brl_entry`, se podaron el mismo día
 * que las de lista — mismo criterio: `mutate_brl` los cubre entero). Todas
 * usan el token personal de email-to-task de Lumbre (Ajustes → email
 * entrante), NUNCA hardcodeado — ver README.md.
 *
 * Todas las tools de Fase 2 necesitan el `taskId` de antemano: lo normal es
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
 * pensado para reeditar una nota con `update_task` (que la REEMPLAZA entera)
 * sin destruir lo que un marcador/preview no traía.
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
    return { baseUrl, token };
}
function textResult(text) {
    return { content: [{ type: 'text', text }] };
}
function errorResult(err) {
    const message = err instanceof LumbreApiError ? err.message : err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}
/**
 * Comando `claude mcp add` LISTO PARA COPIAR del conector stdio local acotado
 * a adjuntos (`LUMBRE_MCP_TOOLSET=attachments`, ver `CreateServerOptions` y
 * `toolsetFromEnv`): solo registra `add_attachment`/`read_attachment`
 * (2 tools, no 19) para poder tenerlo enchufado A LA VEZ que el conector
 * remoto sin duplicar la superficie de `tools/list` en el contexto de cada
 * sesión. Usado tanto en `remoteFileAccessError` (el error que ve el modelo
 * en el momento en que lo necesita) como en el README.
 */
const LOCAL_ATTACHMENTS_CONNECTOR_COMMAND = 'claude mcp add lumbre-adjuntos --env LUMBRE_TOKEN=tu-token --env LUMBRE_MCP_TOOLSET=attachments ' +
    '-- node /ruta/absoluta/a/lumbre-mcp/dist/index.js';
/**
 * Error de `add_attachment({ file_path })` cuando este servidor NO ve el
 * disco del usuario (`localFilesystem: false`, ver `CreateServerOptions` —
 * hoy, el transporte HTTP remoto de `http.ts`/`mcp.lumbre.pro`). A propósito
 * NO reintenta ni delega en `readLocalAttachment`/`fs.stat`: contra ESTE
 * proceso, cualquier ruta —exista o no en la máquina del usuario— resolvería
 * contra el disco del VPS, así que un "No existe el fichero" ahí sería un
 * error LITERALMENTE CIERTO pero sobre la máquina equivocada — el bug real
 * que motiva esta pieza (medido el 2026-08-27: la captura sí existía en el
 * Mac de David en ese mismo instante). Explica la topología y las dos
 * salidas: `content_base64` para algo pequeño, o el conector local de arriba
 * para algo grande.
 */
function remoteFileAccessError() {
    return ('Este conector corre en mcp.lumbre.pro (transporte HTTP remoto) y no tiene forma de ver ' +
        'el disco de tu ordenador — "file_path" no funciona aquí, y un "no existe el fichero" ' +
        'sería sobre el disco del SERVIDOR, no el tuyo, así que ni se ha intentado leer. Dos ' +
        'alternativas:\n' +
        '  1. Fichero pequeño (unos KB — un .txt, un .log): pásalo con `content_base64` en vez ' +
        'de `file_path` (y `filename`, obligatorio en ese modo).\n' +
        '  2. Fichero grande (una captura, un PDF): añade el conector LOCAL de Lumbre, que sí ' +
        'corre en tu máquina y ve tu disco:\n\n' +
        `     ${LOCAL_ATTACHMENTS_CONNECTOR_COMMAND}\n\n` +
        '     (sustituye "tu-token" por tu token de email-to-task y la ruta por la de tu clon; ' +
        'ver README, "Transporte HTTP remoto"). Con ese conector enchufado, add_attachment ahí ' +
        'sí puede usar file_path.');
}
const recurrenceSchema = z
    .object({
    freq: z.enum(['daily', 'weekly', 'monthly', 'yearly']).describe('Frecuencia de la repetición'),
    interval: z.number().int().positive().optional().describe('Cada cuántas unidades (default 1)')
})
    .describe('Recurrencia simple (freq + interval), como la celda "Repetir" del quick-add de Lumbre');
/**
 * Modo efectivo de `notes` para `list_tasks`: `input.notes` si vino
 * informado, si no `'full'` cuando `fullNotes: true` (alias legado, ver el
 * `.describe()` de ambos campos más arriba), si no `'auto'` (default nuevo).
 * Función PURA — sin red — para poder testear el alias sin mockear `fetch`
 * (mismo patrón que `mutateTasksOpSchema`/`buildBatchFromOps`).
 */
export function effectiveNotesMode(input) {
    return input.notes ?? (input.fullNotes ? 'full' : 'auto');
}
/**
 * Textos del lote que hay que escanear en busca de referencias
 * (`[[task:…]]`/`[[list:…]]`, ver `refs.ts`): SIEMPRE el contenido de cada
 * tarea, y sus notas SOLO si de verdad se van a pintar en esta respuesta —
 * resolver la referencia de una nota que sale como marcador (o que `notes:
 * 'none'` omite) gastaría hueco del `?ids=` para algo que nadie va a leer.
 * Pura, sin red: decide QUÉ pedir, no lo pide. `'preview'` sí se incluye
 * entero aunque el recorte a 240 chars pueda dejar fuera alguna referencia
 * (modo legado, no vale la pena afinar más).
 */
export function refTexts(tasks, notesMode, autoRender) {
    const texts = [];
    for (const t of tasks) {
        texts.push(t.content);
        if (notesMode === 'none')
            continue;
        if (notesMode === 'auto' && autoRender?.perTask.get(t.id)?.kind !== 'full')
            continue;
        texts.push(t.notes);
    }
    return texts;
}
/**
 * Aviso compartido en las tools de Fase 2 y en `mutate_tasks` (15 usos): la
 * app de Lumbre es ASÍNCRONA/eventual (igual que `add_task`) — cada mutación
 * se encola y se aplica la próxima vez que un dispositivo del usuario
 * sincronice, no al instante, y ninguna tool da confirmación inmediata de que
 * se aplicó de verdad (usa `list_tasks` más tarde para comprobarlo). Versión
 * CORTA a propósito: repetida 15 veces en `tools/list`, la redacción larga
 * costaba ~3.3k caracteres solo en esta frase — el detalle completo
 * (por qué es eventual, el rebote del WebSocket, etc.) vive una única vez en
 * `README.md` ("Qué hace — Fase 2").
 */
const ASYNC_NOTE = 'Asíncrono (como add_task): se encola y se aplica al sincronizar, sin confirmación inmediata.';
/**
 * Las cuatro tools de BRL (`list_brl_entries` + los tres verbos) son el espejo,
 * para el REGISTRO, de lo que `list_tasks`/`add_task`/`update_task`/
 * `delete_task` son para las tareas. Dos avisos que valen para las cuatro:
 *
 *  - El registro NO son tareas. Una entrada `-`/`=` es un apunte de diario del
 *    día ("he comprado el pan", "igual conviene madrugar"), no algo que hacer:
 *    no se completa, no se reprograma y no sale en `list_tasks`. Si lo que el
 *    usuario quiere es algo que hacer, la tool es `add_task`.
 *  - El add-on puede estar APAGADO en la cuenta; entonces las cuatro fallan con
 *    un error explícito y no se encola nada.
 *
 * `update_brl_entry`/`delete_brl_entry` necesitan el id de la entrada, y la
 * ÚNICA forma de conseguirlo es `list_brl_entries` (la nota completa en
 * Markdown que sirve el mismo endpoint no lleva ids a propósito).
 */
const BRL_DATE = 'Día del registro, YYYY-MM-DD';
/**
 * `mutate_tasks` usa DOS schemas de las mismas 15 formas por-op, no uno
 * (medido: aplanar `ops.items` bajó su JSON Schema EXPUESTO de 7.638 a ~3.1k
 * caracteres — el 27% de toda la superficie de `tools/list` — ver la tarea
 * que lo motivó, 2026-07-25):
 *
 * - `mutateTasksOpSchema` (EXPUESTO, más abajo): UN objeto plano con los 21
 *   campos que usan las 15 ops, TODOS opcionales, cada uno con su
 *   `.describe()` UNA sola vez. Antes esto era un `z.discriminatedUnion` de
 *   15 ramas casi idénticas → `anyOf` con los mismos campos y las mismas
 *   descripciones repetidas 15 veces en el JSON Schema que ve el modelo. El
 *   contrato real por-op (qué campo es obligatorio/ajeno a cada `op`) YA NO
 *   vive en el tipo expuesto: vive en la `description` de `ops` (tabla
 *   compacta, `*` = obligatorio) y en el README ("Ejecutar varias
 *   operaciones a la vez").
 * - `mutateTasksStrictOpSchema` (INTERNO — NO forma parte de `inputSchema`,
 *   nunca se serializa): las MISMAS 15 formas por-op de siempre, con los
 *   MISMOS tipos y la MISMA obligatoriedad que tenía cada rama del
 *   `discriminatedUnion` de antes, cada una `.strict()` (rechaza cualquier
 *   campo ajeno a esa op). El handler de `mutate_tasks`, más abajo, la usa
 *   para re-validar cada elemento de `ops` ANTES de tocar red — así
 *   `{op:'complete', date:'2026-01-01'}` (campo `date` ajeno a `complete`)
 *   SIGUE fallando exactamente igual que antes. La diferencia es DÓNDE: con
 *   el `discriminatedUnion` expuesto, una op mal formada tumbaba el
 *   `mutate_tasks` ENTERO en el framework (`validateToolInput`), antes de
 *   que el handler viera nada; ahora entra en el mismo informe de "éxito
 *   parcial" que ya existía para un `taskId` inexistente — se reporta esa
 *   op concreta y las demás, si son válidas, se encolan igual. Mejora de
 *   comportamiento, no solo de tamaño.
 *
 * `create_list.listId` (encadenar dentro del MISMO lote, sin depender de la
 * respuesta): dale tú mismo un uuid v4 al crearla y úsalo en el
 * `move_to_list`/`nest_list` que la targetee en OTRA op del mismo lote —
 * detalle completo (antes en la `.describe()` de esa variante, 335
 * caracteres que solo importan una vez, no repetidos por tool call) movido
 * al README.
 */
export const mutateTasksStrictOpSchema = z.discriminatedUnion('op', [
    z
        .object({
        op: z.literal('add_task'),
        text: z.string().min(1).max(2000),
        list: z.string().max(200).optional(),
        listId: z.string().uuid().optional(),
        section: z.string().max(200).optional(),
        priority: z.enum(['p1', 'p2', 'p3', 'p4']).optional(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
        recurrence: recurrenceSchema.optional(),
        subtasks: z.array(z.string()).optional(),
        notes: z.string().max(10000).optional()
    })
        .strict(),
    z
        .object({
        op: z.literal('complete'),
        taskId: z.string().uuid(),
        done: z.boolean().optional()
    })
        .strict(),
    z
        .object({
        op: z.literal('cancel'),
        taskId: z.string().uuid(),
        cancelled: z.boolean().optional()
    })
        .strict(),
    z
        .object({
        op: z.literal('update'),
        taskId: z.string().uuid(),
        content: z.string().min(1).max(2000).optional(),
        notes: z.string().max(10000).optional(),
        priority: z.enum(['p1', 'p2', 'p3', 'p4']).optional(),
        time: z.union([z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), z.null()]).optional()
    })
        .strict(),
    z
        .object({
        op: z.literal('reschedule'),
        taskId: z.string().uuid(),
        date: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.null()])
    })
        .strict(),
    z
        .object({
        op: z.literal('delete'),
        taskId: z.string().uuid()
    })
        .strict(),
    z
        .object({
        op: z.literal('set_section'),
        taskId: z.string().uuid(),
        section: z.string().max(200).nullable()
    })
        .strict(),
    z
        .object({
        op: z.literal('move_to_list'),
        taskId: z.string().uuid(),
        listId: z.union([z.string().uuid(), z.null()]).optional(),
        list: z.string().max(200).optional()
    })
        .strict(),
    z
        .object({
        op: z.literal('add_subtask'),
        taskId: z.string().uuid(),
        subtasks: z.array(z.string()).min(1).max(50)
    })
        .strict(),
    z
        .object({
        op: z.literal('complete_subtask'),
        subtaskId: z.string().uuid(),
        done: z.boolean().optional()
    })
        .strict(),
    z
        .object({
        op: z.literal('remove_section'),
        sectionId: z.string().uuid()
    })
        .strict(),
    z
        .object({
        op: z.literal('create_list'),
        name: z.string().min(1).max(200),
        color: z.string().max(20).optional(),
        icon: z.string().max(16).optional(),
        listId: z.string().uuid().optional()
    })
        .strict(),
    z
        .object({
        op: z.literal('nest_list'),
        listId: z.string().uuid(),
        parentId: z.union([z.string().uuid(), z.null()])
    })
        .strict(),
    z
        .object({
        op: z.literal('rename_list'),
        listId: z.string().uuid(),
        name: z.string().min(1).max(200)
    })
        .strict(),
    z
        .object({
        op: z.literal('remove_list'),
        listId: z.string().uuid()
    })
        .strict()
]);
/**
 * Schema EXPUESTO de un elemento de `ops` (ver el JSDoc de
 * `mutateTasksStrictOpSchema` de arriba para el porqué de tenerlos
 * separados): plano, los 21 campos que usan las 15 ops TODOS opcionales
 * (salvo `op`). Poda de superficie (2026-08-25, medido: bajó el JSON Schema
 * EXPUESTO de este objeto de 3.994 a 3.683 caracteres — ver el test de
 * superficie en `index.test.ts`): cada campo tiene `.describe()` SOLO si
 * aporta algo que el nombre del campo + su
 * tipo/patrón no dicen ya (semántica de `null`, default al omitir, o el
 * comportamiento no obvio de un campo como `list`/`notes`) — `text`,
 * `content`, `name`, `deadline`, `icon` y `recurrence` se quedan sin
 * `.describe()` propio porque esa info ya vive en el nombre del campo, en
 * `recurrenceSchema`, o en la tool individual (`create_list` para `icon`).
 * `.strict()` aquí solo pilla un nombre de campo que no es NINGUNO de los 21
 * conocidos (typo); que un campo válido en general no aplique a la `op`
 * concreta de ESE elemento lo pilla `mutateTasksStrictOpSchema` en el
 * handler, no este schema.
 */
export const mutateTasksOpSchema = z
    .object({
    op: z
        .enum([
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
    ])
        .describe('Operación a ejecutar — contrato por-op en la description de `ops`'),
    taskId: z.string().uuid().optional().describe('Id de la tarea — ver list_tasks/get_task'),
    subtaskId: z.string().uuid().optional().describe('Id de la subtarea — ver get_task de su tarea padre'),
    sectionId: z.string().uuid().optional().describe('Id de la sección — ver list_tasks/get_task'),
    listId: z
        .union([z.string().uuid(), z.null()])
        .optional()
        .describe('Id de lista: destino, padre, o uno que tú generes para encadenar con create_list'),
    // `text`/`content`/`name`/`deadline`: sin describe propio — el nombre
    // del campo ya lo dice todo (texto de la tarea nueva o su nuevo
    // texto/título, nombre de la lista, fecha límite) y no hay semántica
    // extra (null, default, autocreación…) que documentar; qué op usa cuál
    // ya está en la description de `ops`.
    text: z.string().min(1).max(2000).optional(),
    content: z.string().min(1).max(2000).optional(),
    name: z.string().min(1).max(200).optional(),
    list: z.string().max(200).optional().describe('Nombre de la lista destino (se crea si no existe)'),
    section: z.string().max(200).nullable().optional().describe('Nombre de la sección, o null para quitarla'),
    notes: z.string().max(10000).optional().describe('Notas (reemplaza las anteriores enteras)'),
    priority: z.enum(['p1', 'p2', 'p3', 'p4']).optional().describe('p1 = más urgente … p4 = ninguna'),
    date: z
        .union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.null()])
        .optional()
        .describe('YYYY-MM-DD, o null para "Algún día"/Bandeja de entrada'),
    deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    time: z
        .union([z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), z.null()])
        .optional()
        .describe('24h; null la quita'),
    // `recurrence`: sin describe propio — `recurrenceSchema` ya documenta
    // `freq`/`interval` campo a campo (compartido con `add_task`).
    recurrence: recurrenceSchema.optional(),
    subtasks: z.array(z.string()).optional().describe('Textos de las subtareas, en orden'),
    done: z.boolean().optional().describe('true = completar (default); false = desmarcar'),
    cancelled: z.boolean().optional().describe('true = cancelar (default); false = restaurar'),
    color: z.string().max(20).optional().describe('red|amber|green|blue|violet|pink, o un hex libre "#rrggbb"'),
    // `icon`: sin describe propio — mismo criterio que `text`/`name`; su
    // semántica (emoji/icono de la lista) ya la dice el nombre del campo.
    icon: z.string().max(16).optional(),
    parentId: z.union([z.string().uuid(), z.null()]).optional().describe('Id de la lista padre, o null para desanidar')
})
    .strict();
/**
 * Mensaje legible para un elemento de `ops` que no encaja en la forma
 * ESTRICTA de su `op` (`mutateTasksStrictOpSchema`/`mutateBrlStrictOpSchema`,
 * más abajo): identifica la op y, campo a campo, qué falta o qué sobra —
 * para que el modelo pueda corregir ESE elemento concreto sin adivinar cuál
 * campo venía mal. Compartida por `mutate_tasks` y `mutate_brl`: la forma del
 * mensaje no depende de qué dominio mutan.
 */
function formatOpShapeError(op, error) {
    const parts = error.issues.map((issue) => {
        if (issue.code === 'unrecognized_keys') {
            return `campo(s) que no aplican a "${op}": ${issue.keys.join(', ')}`;
        }
        const field = issue.path.length > 0 ? issue.path.join('.') : '(op)';
        return `${field}: ${issue.message}`;
    });
    return `${op}: ${parts.join('; ')}`;
}
/**
 * Mismo par de schemas que `mutateTasksOpSchema`/`mutateTasksStrictOpSchema`
 * (ver su JSDoc arriba para el porqué de tenerlos separados), pero para las
 * 3 ops del BRL (`add`/`update`/`delete`, podadas de `add_brl_entry`/
 * `update_brl_entry`/`delete_brl_entry` el 2026-08-27 — ver el bloque «BRL»
 * en `createServer`). `mutateBrlStrictOpSchema` (INTERNO, nunca se
 * serializa): las 3 formas por-op EXACTAS que tenían las tres tools sueltas,
 * `.strict()` cada una — el handler de `mutate_brl` la usa para re-validar
 * cada elemento de `ops` antes de tocar red, igual que `mutate_tasks` con la
 * suya. `mutateBrlOpSchema` (EXPUESTO, más abajo): un objeto plano con los 5
 * campos que usan las 3 ops, todos opcionales salvo `op`/`date` (`date` es
 * obligatorio en las 3, así que no gana nada quedando opcional). A
 * diferencia de `mutateTasksOpSchema` (15 ops, 21 campos), aquí el ahorro de
 * aplanar es pequeño — 3 ops con casi los mismos 2-3 campos cada una— así que
 * el peso real de este schema sale de medirlo (ver el test de superficie en
 * `index.test.ts`), no se asume solo por copiar el patrón.
 */
export const mutateBrlStrictOpSchema = z.discriminatedUnion('op', [
    z
        .object({
        op: z.literal('add'),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        text: z.string().min(1).max(2000),
        kind: z.enum(['note', 'thought']).optional(),
        time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional()
    })
        .strict(),
    z
        .object({
        op: z.literal('update'),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        entryId: z.string().uuid(),
        text: z.string().min(1).max(2000),
        kind: z.enum(['note', 'thought']).optional()
    })
        .strict(),
    z
        .object({
        op: z.literal('delete'),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        entryId: z.string().uuid()
    })
        .strict()
]);
export const mutateBrlOpSchema = z
    .object({
    op: z
        .enum(['add', 'update', 'delete'])
        .describe('Operación a ejecutar — contrato por-op en la description de `ops`'),
    date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe(BRL_DATE),
    entryId: z.string().uuid().optional().describe('Id de la entrada (ver list_brl_entries)'),
    // `text`: sin describe propio — mismo criterio que `mutateTasksOpSchema`,
    // el contrato por-op (obligatorio en add/update, ajeno a delete) ya vive
    // en la description de `ops`.
    text: z.string().min(1).max(2000).optional(),
    kind: z.enum(['note', 'thought']).optional().describe('note = nota `-` (default); thought = pensamiento `=`'),
    time: z
        .string()
        .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
        .optional()
        .describe('Hora "HH:MM" (24h) — solo add; sin ella, hora del reloj si `date` es hoy')
})
    .strict();
/**
 * Factory del servidor MCP de Lumbre: registra las tools con `config`
 * INYECTADO (nada de estado de módulo, ver el histórico de este fichero) y
 * devuelve el `McpServer` ya construido, sin conectar a ningún transporte —
 * eso es cosa del llamante (`main`, más abajo, para stdio; `http.ts` para el
 * transporte remoto). Registra las 19 de siempre salvo que
 * `opts.toolset === 'attachments'` (ver su JSDoc arriba), en cuyo caso solo
 * quedan `add_attachment`/`read_attachment` — las demás se registran igual
 * (para no bifurcar cada una de las 17 llamadas a `registerTool` con un
 * `if`) y se retiran acto seguido con `.remove()`, ANTES de que este
 * `McpServer` se conecte a ningún transporte: ningún cliente llega a ver el
 * estado intermedio de "19 registradas".
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
    const addTaskTool = server.registerTool('add_task', {
        description: 'Añade una tarea nueva a Lumbre (planificador semanal). Dispara con "apúntame", ' +
            '"recuérdame", "añade a mi lista/tarea". Se encola y se materializa al sincronizar. ' +
            '`section` coloca la tarea DENTRO de `list` (se crea si no existe); se ignora sin `list`.',
        inputSchema: {
            text: z.string().min(1).max(2000).describe('Texto de la tarea (obligatorio)'),
            list: z
                .string()
                .max(200)
                .optional()
                .describe('Nombre de la lista de "Algún día" destino (se crea si no existe). Sin lista y sin ' +
                'date, el cliente la coloca en "hoy" al materializarla.'),
            listId: z
                .string()
                .uuid()
                .optional()
                .describe('Id ESTABLE de la lista destino, PREFERENTE sobre `list` (inmune a renames); sácalo ' +
                'de list_tasks. Si se omite, se usa `list` por nombre (se crea si no existe).'),
            section: z
                .string()
                .max(200)
                .optional()
                .describe('Nombre de la sección/heading dentro de `list` donde colocar la tarea (se crea si ' +
                'no existe). Se ignora si no se indica `list`.'),
            priority: z.enum(['p1', 'p2', 'p3', 'p4']).optional().describe('p1 = más urgente; p4 = ninguna'),
            date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Día programado, YYYY-MM-DD'),
            deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Fecha límite ⚑, YYYY-MM-DD'),
            time: z
                .string()
                .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
                .optional()
                .describe('Hora "HH:MM" (24h); sin `date`, la tarea se agenda hoy'),
            recurrence: recurrenceSchema.optional(),
            subtasks: z.array(z.string()).optional().describe('Subtareas a crear junto con la tarea'),
            notes: z.string().max(10000).optional().describe('Notas/descripción larga')
        }
    }, async (input) => {
        try {
            await addTask(config, input);
            return textResult(`Tarea añadida a Lumbre: “${input.text}”.`);
        }
        catch (err) {
            return errorResult(err);
        }
    });
    /**
     * MEDIDO el 2026-08-27, y cambia lo que hay que contarle al modelo: una
     * lectura hecha justo DESPUÉS de una mutación de este mismo MCP ya sale
     * fresca SIN ningún flush por medio. Cinco corridas contra el servidor
     * real con el binario ANTERIOR a esta descripción (o sea, sin nada que
     * refrescara solo), por los DOS caminos de escritura que existen
     * (`add_task` → `POST /api/ingest` y `mutate_tasks` → `POST /api/batch`):
     * en las cinco, la tarea recién creada aparecía en el `list_tasks`
     * inmediatamente siguiente.
     *
     * DE QUÉ DEPENDE ESA FRESCURA, que no es lo que parece. NO es «las
     * escrituras van por REST y el rebote solo afecta al WebSocket». Es que
     * los tres handlers de escritura del repo principal
     * (`/api/ingest:289`, `/api/batch:253` — uno solo para todo el lote — y
     * `/api/mutations:148`) llaman a `runHeadlessDrain`
     * (`src/lib/server/sync/drain.ts:96-107`) ANTES de responder, y ese
     * drenaje persiste en sus dos ramas: con la app del usuario abierta
     * fuerza el guardado en vez de esperar al rebote de 250 ms, y sin ella
     * hidrata un store efímero del blob, materializa y vuelve a persistir a
     * mano. Dato de la sesión que mantiene ese repo, 2026-08-27.
     *
     * O sea que la propiedad se apoya en un drenaje SÍNCRONO al final del
     * handler ajeno. Si alguien lo mueve a segundo plano para bajar la
     * latencia (y hay motivo: la mutación tarda ~4,4 s en responder, que es
     * justo ese drenaje), esta descripción pasa a mentir y NINGÚN test de
     * este repo se entera. Si la app empieza a leer viejo justo después de
     * escribir, mira ahí antes que aquí.
     *
     * Lo que esta tool SÍ sigue arreglando es el otro caso, que no se puede
     * medir desde aquí y por eso no se toca: el rancio que arregla no lo
     * produce este MCP, lo produce un cliente conectado cuyos cambios están
     * en la room y aún no han bajado al blob. Las lecturas del MCP van por
     * REST y leen lo persistido, así que ese cambio no se ve hasta que
     * alguien fuerza el flush. Por eso NO se convierte en no-op cuando «no
     * hay nada que este MCP haya mutado»: este MCP no se entera de esos
     * cambios.
     *
     * Y no es gratis saltárselo mal: `flushPersister` llama a `save()`
     * incondicionalmente y acaba en un SELECT más un `insert … on conflict`
     * con el blob ENTERO, haya cambiado algo o no. Con la app del usuario
     * CERRADA sí es barato de verdad, porque `flushSyncRoom` corta en la
     * primera línea al no haber room. Se midieron 506 llamadas en 2.056
     * transcripts.
     */
    const refreshSyncTool = server.registerTool('refresh_sync', {
        description: 'Fuerza el flush de sync de Lumbre. NO hace falta llamarla por una mutación hecha con ' +
            'ESTE MCP: cuando la tool de escritura responde, el servidor ya la ha aplicado y la ' +
            'siguiente lectura la ve (medido). SÍ hace falta cuando el cambio viene de FUERA de ' +
            'este MCP (la app o el móvil del usuario) y quieres que se vea ya, porque de esos ' +
            'cambios este MCP no se entera solo. Solo garantiza lo que YA llegó al servidor por ' +
            'WebSocket — si el dispositivo del usuario está offline, sus cambios sin enviar no se ' +
            'pueden recuperar. Sin parámetros.',
        inputSchema: {}
    }, async () => {
        try {
            await refreshSync(config);
            return textResult('Sync de Lumbre refrescado: el servidor ya tiene persistido todo lo que le había llegado.');
        }
        catch (err) {
            return errorResult(err);
        }
    });
    const listTasksTool = server.registerTool('list_tasks', {
        description: 'Lee tareas de Lumbre. `scope`: today (default), week, upcoming, inbox/someday, overdue, ' +
            'all (auto "all" si usas `list` sin `scope`). `list` filtra por nombre; si no existe da ' +
            'vacío igual que una lista vacía existente — usa list_lists para distinguir. `section` ' +
            'agrupa por sección dentro de `list`; `includeArchived` permite consultar archivadas. ' +
            '`notes` controla las notas de cada tarea (default ' +
            '"auto": íntegra si @done/#done, si cambió desde la última vez que la viste, o si se tocó ' +
            'hace poco (`notesRecentHours`), si no un marcador ✎N con su tamaño y fecha — NUNCA un ' +
            'texto recortado a medias; la cabecera del listado detalla el criterio y te avisa de ' +
            'cuáles no has leído). `notesSince` es una consulta de precisión aparte: solo lo tocado ' +
            'desde esa fecha.',
        inputSchema: {
            scope: z
                .enum(['today', 'week', 'upcoming', 'inbox', 'someday', 'overdue', 'all'])
                .optional()
                .describe('Alcance temporal; default "today" ("all" si se usa `list` sin `scope`). "week" es la ' +
                'semana de CALENDARIO; "upcoming" es una ventana rodante que siempre empieza hoy'),
            days: z
                .number()
                .int()
                .min(1)
                .max(14)
                .optional()
                .describe('Solo con scope "upcoming": días de la ventana contando hoy (default 7, máx 14)'),
            list: z
                .string()
                .optional()
                .describe('Nombre (case-insensitive) de una lista de "Algún día"/proyecto a filtrar'),
            section: z
                .string()
                .optional()
                .describe('Nombre (case-insensitive) de una sección dentro de `list` a filtrar (Fase B, ' +
                'listas=proyectos); combinado con `list`, solo casa una sección de ESA lista'),
            includeDone: z.boolean().optional().describe('Incluir tareas ya completadas; default false'),
            includeArchived: z
                .boolean()
                .optional()
                .describe('Incluir tareas archivadas; default false. En listados sigue combinándose con ' +
                'includeDone y el resto de filtros'),
            notes: z
                .enum(['auto', 'none', 'preview', 'full'])
                .optional()
                .describe('"auto" (default): íntegra si @done/#done, si cambió desde la última vez que este MCP ' +
                'la mostró (huella local por `notesUpdatedAt`), o si se tocó dentro de ' +
                '`notesRecentHours` (solo la 1ª vez que se ve esa tarea) — si no, un marcador ' +
                '"✎N ↻fecha" con su tamaño y la fecha de la última edición — GARANTÍA: nunca un ' +
                'recorte a medias. "none": sin notas. "preview": recorte legado a ~240 chars, ' +
                'colapsado a una línea. "full": todas íntegras y verbatim para TODO el lote ' +
                '(equivale a fullNotes:true) — útil si vas a reeditar con update_task (que ' +
                'REEMPLAZA la nota entera). Para una sola tarea concreta, mejor get_task. Se ignora ' +
                'si mandas `notesSince`.'),
            fullNotes: z
                .boolean()
                .optional()
                .describe('DEPRECATED, alias de notes:"full" (se ignora si `notes` viene informado).'),
            notesRecentHours: z
                .number()
                .positive()
                .optional()
                .describe(`Solo con "auto": ventana (horas, default ${DEFAULT_NOTES_RECENT_HOURS}) para dar por ` +
                'íntegra la nota de una tarea que el MCP ve por 1ª vez (sin huella local aún) — ' +
                'más ventana = más notas íntegras de golpe, más chars en la respuesta.'),
            notesSince: z
                .string()
                .min(10)
                .optional()
                .describe('Consulta de precisión, SIN estado: "YYYY-MM-DD" o ISO completo — íntegra SOLO si la ' +
                'nota se editó desde esa fecha (`notesUpdatedAt`), marcador el resto. Ignora `notes`/' +
                '`fullNotes`, @done/#done y la huella local por completo (mezclar criterios haría ' +
                'la consulta impredecible): úsalo para "qué ha cambiado desde X", no para lectura ' +
                'normal.')
        }
    }, async (input) => {
        try {
            if (input.notesSince !== undefined) {
                const since = parseNotesSince(input.notesSince);
                if (!since) {
                    return errorResult(new Error(`notesSince inválido: "${input.notesSince}" (usa "YYYY-MM-DD" o ISO 8601 completo).`));
                }
                // Consulta de precisión, siempre con las notas ENTERAS (sin
                // `notesQuery`, ver el JSDoc de `computeNotesSinceRender`): no es el
                // camino que optimiza esta feature, así que se queda con el
                // comportamiento de siempre.
                const tasks = await listTasks(config, input);
                taskCache.setAll(tasks);
                const autoRender = computeNotesSinceRender(tasks, since);
                const refs = await resolveRefs(config, refTexts(tasks, 'auto', autoRender), {
                    includeArchived: input.includeArchived
                });
                return textResult(formatTaskList(tasks, input.scope ?? 'today', {
                    notesMode: 'auto',
                    autoRender,
                    notesSinceLabel: input.notesSince,
                    refs
                }));
            }
            const notesMode = effectiveNotesMode(input);
            if (notesMode === 'none') {
                // El texto no se usa para nada: una sola petición, ahorro máximo —
                // un servidor VIEJO ignora `notes=none` y todo sigue funcionando
                // igual, solo que sin ahorrar.
                const tasks = await listTasks(config, { ...input, notesQuery: 'none' });
                taskCache.setAll(tasks);
                const refs = await resolveRefs(config, refTexts(tasks, notesMode), {
                    includeArchived: input.includeArchived
                });
                return textResult(formatTaskList(tasks, input.scope ?? 'today', { notesMode, refs }));
            }
            if (notesMode === 'auto') {
                const { list, autoRender } = await listTasksAutoTwoPhase(input);
                const refs = await resolveRefs(config, refTexts(list, notesMode, autoRender), {
                    includeArchived: input.includeArchived
                });
                return textResult(formatTaskList(list, input.scope ?? 'today', {
                    notesMode,
                    autoRender,
                    notesWindowHours: input.notesRecentHours,
                    refs
                }));
            }
            // 'preview'/'full': notas enteras de siempre, sin optimizar ('full'
            // las necesita TODAS íntegras, 'preview' las trunca aquí mismo a
            // partir del texto completo).
            const tasks = await listTasks(config, input);
            taskCache.setAll(tasks);
            if (notesMode === 'full') {
                // Íntegra en 'full' también cuenta como SURFACEADA — misma huella
                // que 'auto' registra, para que una vuelta con `notes: 'full'` no
                // haga que la siguiente en 'auto' vuelva a marcar "cambió" sin
                // haber cambiado — ver el JSDoc de `recordNotesSeen`.
                await recordNotesSeen(tasks
                    .filter(hasNotes)
                    .map((t) => ({ taskId: t.id, notes: t.notes, notesUpdatedAt: t.notesUpdatedAt })), notesSeenStore);
            }
            const refs = await resolveRefs(config, refTexts(tasks, notesMode), {
                includeArchived: input.includeArchived
            });
            return textResult(formatTaskList(tasks, input.scope ?? 'today', { notesMode, refs }));
        }
        catch (err) {
            return errorResult(err);
        }
    });
    /**
     * `list_tasks({notes:'auto'})` (default) en DOS FASES — perf, 2026-08-25:
     * antes, `listTasks` traía el texto de TODAS las notas siempre, aunque la
     * mayoría (las que la decisión manda a marcador) se tiran en local (medido
     * contra datos reales: de un `scope=all` de 542 KB, 307 KB — 56,6% — eran
     * texto de notas, ver el encargo de esta feature).
     *
     * 1. Fase 1: `GET /api/tasks?notes=length` — cada tarea trae `notesLength`
     *    en vez del texto (ver `ListTasksInput.notesQuery`).
     * 2. Detección de servidor VIEJO (aún no conoce `notes=length`, ver el
     *    JSDoc de `LumbreTask.notesLength`): NINGUNA tarea trae la PROPIEDAD
     *    `notesLength` (con `in`, no comprobando si vale `null` — un servidor
     *    NUEVO también puede mandar `notesLength: null` en una tarea sin nota)
     *    → ya nos ha dado las notas enteras igual (ignoró el parámetro), así
     *    que seguimos con ESE mismo lote: repliegue a coste CERO, sin 2ª
     *    petición.
     * 3. Servidor NUEVO: decide íntegra/marcador por tarea con lo que ya
     *    sabemos (`computeAutoNotesRender`, que ahora sabe leer `notesLength`
     *    sin necesitar el texto — ver `notes.ts`).
     * 4. Fase 2: SOLO para las que la decisión marcó íntegras, `GET
     *    /api/tasks?ids=<esos ids>&notes=full` (una petición; trocea >200 ids
     *    — `findTasksByIds`) para traer su texto. Conjunto vacío → ninguna
     *    petición extra.
     * 5. GARANTÍA (README): si la fase 2 falla, o devuelve MENOS tareas de las
     *    pedidas (p. ej. una tarea borrada entre medias) o con la nota vacía,
     *    esa nota se REPLIEGA a marcador — con la longitud/fecha YA conocidas
     *    de la fase 1 — en vez de colar un texto a medias o una nota vacía
     *    disfrazada de "sin nota".
     */
    async function listTasksAutoTwoPhase(input) {
        const phase1 = await listTasks(config, { ...input, notesQuery: 'length' });
        const isNewServer = phase1.some((t) => 'notesLength' in t);
        if (!isNewServer) {
            taskCache.setAll(phase1);
            const autoRender = await computeAutoNotesRender(phase1, { windowHours: input.notesRecentHours }, notesSeenStore);
            return { list: phase1, autoRender };
        }
        const autoRender = await computeAutoNotesRender(phase1, { windowHours: input.notesRecentHours }, notesSeenStore);
        const fullIds = phase1
            .filter((t) => autoRender.perTask.get(t.id)?.kind === 'full')
            .map((t) => t.id);
        let fullTasksById = new Map();
        if (fullIds.length > 0) {
            try {
                fullTasksById = await findTasksByIds(config, fullIds, {
                    notesQuery: 'full',
                    includeArchived: input.includeArchived
                });
            }
            catch {
                // La fase 2 falló DEL TODO (red, 5xx…): `fullTasksById` se queda
                // vacío y cada tarea "íntegra" cae al mismo repliegue de abajo
                // (tarea ausente del Map) — GARANTÍA, nunca a medias ni rompe el
                // listado entero por un fallo que solo afecta al TEXTO de la nota.
            }
        }
        const list = phase1.map((t) => {
            const decision = autoRender.perTask.get(t.id);
            if (decision?.kind !== 'full')
                return t;
            const full = fullTasksById.get(t.id);
            if (!full || !hasNotes(full)) {
                // Repliegue a marcador (garantía de arriba): la fase 2 no trajo esta
                // tarea (borrada entre medias, p. ej.), falló del todo, o su nota ya
                // no está — NUNCA texto a medias ni una nota vacía disfrazada de "sin
                // nota".
                autoRender.perTask.set(t.id, { ...decision, kind: 'marker' });
                autoRender.fullCount--;
                autoRender.markerCount++;
                return t;
            }
            return { ...t, notes: full.notes };
        });
        taskCache.setAll(list);
        return { list, autoRender };
    }
    const listListsTool = server.registerTool('list_lists', {
        description: 'Enumera TODAS las listas de "Algún día" con su recuento de tareas, incluidas las ' +
            'vacías (recuento 0) — a diferencia de list_tasks({list}), que no distingue vacía de ' +
            'inexistente. Sin parámetros.',
        inputSchema: {}
    }, async () => {
        try {
            const lists = await listLists(config);
            return textResult(formatListSummaries(lists));
        }
        catch (err) {
            return errorResult(err);
        }
    });
    const getTaskTool = server.registerTool('get_task', {
        description: 'Devuelve UNA tarea entera y sin recortar (notas íntegras, fecha de creación, ' +
            'lista/sección). Si tiene subtareas, las incluye con su id y estado — única forma de ' +
            'obtener el id de una subtarea. `includeArchived` permite recuperarla si está archivada. ' +
            'Error si el taskId no existe.',
        inputSchema: {
            taskId: z.string().uuid().describe('Id de la tarea (ver list_tasks)'),
            includeArchived: z
                .boolean()
                .optional()
                .describe('Permitir recuperar la tarea por id aunque esté archivada; default false')
        }
    }, async (input) => {
        try {
            const task = await findTaskById(config, input.taskId, {
                includeArchived: input.includeArchived
            });
            if (!task)
                return errorResult(taskNotFoundError(input.taskId));
            taskCache.set(task);
            // La nota (si la hay) sale SIEMPRE íntegra aquí (`formatTaskFull`) — se
            // registra como vista, misma huella que `list_tasks({notes:'auto'})`
            // consulta (ver `notes.ts`); best-effort, nunca puede romper esta
            // lectura.
            if (hasNotes(task)) {
                await recordNotesSeen([{ taskId: task.id, notes: task.notes, notesUpdatedAt: task.notesUpdatedAt }], notesSeenStore);
            }
            // Referencias EN VIVO del texto, la nota (que aquí sale siempre íntegra)
            // y las subtareas — ver `refs.ts`. Cero peticiones extra si no hay
            // ninguna referencia, que es el caso normal.
            const refs = await resolveRefs(config, [task.content, task.notes, ...(task.subtasks ?? []).map((s) => s.content)], { includeArchived: input.includeArchived });
            return textResult(formatTaskFull(task, refs));
        }
        catch (err) {
            return errorResult(err);
        }
    });
    server.registerTool('read_attachment', {
        description: 'Descarga un adjunto de una tarea de Lumbre por su id (ver el campo `attachments` de ' +
            'list_tasks). Si es una imagen, la devuelve para verla directamente; si no (PDF, etc.), ' +
            'devuelve solo su metadata — no hay forma de leer su contenido con esta tool.',
        inputSchema: {
            attachment_id: z
                .string()
                .uuid()
                .describe('Id del adjunto (ver el campo `attachments` de list_tasks)')
        }
    }, async (input) => {
        try {
            const { contentType, bytes } = await getAttachment(config, input.attachment_id);
            if (contentType.startsWith('image/')) {
                return {
                    content: [
                        { type: 'image', data: bytes.toString('base64'), mimeType: contentType }
                    ]
                };
            }
            return textResult(`Adjunto ${input.attachment_id}: tipo "${contentType}", ${bytes.length} bytes. No es una ` +
                'imagen, así que esta tool no puede mostrar su contenido (solo lo descarga en el ' +
                'servidor MCP; no hay forma de mostrártelo a partir de aquí).');
        }
        catch (err) {
            return errorResult(err);
        }
    });
    server.registerTool('add_attachment', {
        description: 'Sube un fichero y lo deja adjunto a una tarea (SÍNCRONA, a diferencia de add_task/' +
            'mutate_tasks: ya está enlazado al responder). Acepta EXACTAMENTE una de dos vías — ' +
            '`file_path` (ruta LOCAL, absoluta o "~/…", tope 25 MB) SOLO funciona si este conector ' +
            'corre en tu propia máquina (stdio local); contra el conector remoto de mcp.lumbre.pro ' +
            'devuelve un error explicativo, nunca intenta leer tu disco. `content_base64` funciona ' +
            'siempre, pero es SOLO para ficheros de unos KB (un .txt, un .log): el argumento lo emites ' +
            'TÚ como modelo, y una imagen de unos cientos de KB son ~100-200k tokens en base64 — tope ' +
            '1 MB decodificado. `filename` es obligatorio con `content_base64` (no hay ruta de la que ' +
            'sacar un nombre). Ver README para el detalle de mimes/límites y el conector local dedicado.',
        inputSchema: {
            taskId: z.string().uuid().describe('Id de la tarea a la que adjuntar (ver list_tasks)'),
            file_path: z
                .string()
                .min(1)
                .optional()
                .describe('Ruta LOCAL del fichero, absoluta o "~/…" (una relativa se rechaza). Exactamente uno ' +
                'de file_path/content_base64. Solo funciona si ESTE conector corre en tu máquina ' +
                '(stdio local) — contra el conector remoto da un error explicativo con la alternativa.'),
            content_base64: z
                .string()
                .min(1)
                .optional()
                .describe('Bytes del fichero en base64, para cuando no hay file_path posible (conector remoto) ' +
                'o el fichero es pequeño. SOLO para unos KB (un .txt/.log corto) — tope 1 MB ' +
                'decodificado; para algo más grande usa file_path con el conector local. Exactamente ' +
                'uno de file_path/content_base64. Requiere `filename`.'),
            filename: z
                .string()
                .min(1)
                .optional()
                .describe('Nombre con el que se guarda. Con file_path, opcional (por defecto su basename); con ' +
                'content_base64, OBLIGATORIO (no hay ruta de la que sacarlo).')
        }
    }, async (input) => {
        try {
            const hasFilePath = input.file_path !== undefined;
            const hasBase64 = input.content_base64 !== undefined;
            if (hasFilePath === hasBase64) {
                return errorResult(new Error(hasFilePath
                    ? 'Indica UNA sola vía: file_path o content_base64, no las dos a la vez.'
                    : 'Indica una vía para el fichero: file_path (conector local) o content_base64 ' +
                        '(cualquier conector, ficheros pequeños).'));
            }
            let file;
            if (hasBase64) {
                if (!input.filename?.trim()) {
                    return errorResult(new Error('filename es obligatorio con content_base64 (no hay ruta de la que sacarlo).'));
                }
                // Decodifica/valida ANTES de tocar red (`requireTaskExists` incluida)
                // — un base64 inválido o por encima del tope no debe gastar la
                // llamada de existencia.
                file = decodeBase64Attachment(input.content_base64, input.filename);
                await requireTaskExists(input.taskId, { allowSubtask: false });
            }
            else if (!localFilesystem) {
                // Ni requireTaskExists ni uploadAttachment: contra este disco NO
                // existe una ruta correcta que probar (ver `remoteFileAccessError`),
                // así que ni se toca la red.
                return errorResult(new Error(remoteFileAccessError()));
            }
            else {
                await requireTaskExists(input.taskId, { allowSubtask: false });
                file = await readLocalAttachment(input.file_path, input.filename);
            }
            const attachment = await uploadAttachment(config, {
                taskId: input.taskId,
                filename: file.filename,
                mime: file.mime,
                bytes: file.bytes
            });
            return textResult(`Adjunto subido a Lumbre: "${attachment.filename}" (${attachment.mime}, ${attachment.size} ` +
                `bytes, id ${attachment.id}) en la tarea ${input.taskId}. Ya está enlazado (esta vía es ` +
                'SÍNCRONA): léelo con read_attachment cuando quieras, sin esperar a ningún sync.');
        }
        catch (err) {
            return errorResult(err);
        }
    });
    // ── Fase 2: mutar una tarea existente (ver PHASE2.md) ──────────────────────
    /**
     * Comprueba que `taskId` EXISTE antes de encolar cualquier mutación sobre él,
     * y (SELECTIVAMENTE, ver `allowSubtask`) que no sea una subtarea si la tool
     * no admite una ahí. `/api/mutations` NO valida esto server-side (deliberado
     * — ver el JSDoc de ese endpoint: `tasks` es una proyección que puede ir
     * desfasada del CRDT real, así que el drenaje del CLIENTE descarta en
     * silencio cualquier `taskId` que no encuentre). Sin el chequeo de
     * EXISTENCIA aquí, un id mal transcrito (typo real que mordió a David el
     * 2026-07-17: `9c184fe4-2103-…` en vez de `9c184fe4-ddb2-4103-…`) se
     * encolaba igual y el MCP contestaba "Encolado…" tan tranquilo, perdiendo la
     * mutación sin avisar. La EXISTENCIA sí se puede comprobar en el acto (a
     * diferencia de si la mutación llegó a APLICARSE, que sigue siendo asíncrono
     * — ver `ASYNC_NOTE`), así que sí merece la pena gastar la llamada extra a
     * `GET /api/tasks?id=` (vía `findTaskById`) antes de encolar.
     *
     * Fino wrapper de red sobre `assertTaskUsable` (`lumbre-client.ts`, función
     * PURA que hace la comprobación en sí — allí vive el JSDoc completo del
     * criterio `allowSubtask` por tool, y sus tests). Lanza si no existe, o si
     * existe pero es una subtarea y `allowSubtask` es `false`; el llamante ya
     * está dentro de un `try/catch` que lo convierte en `errorResult`.
     */
    async function requireTaskExists(taskId, opts = {}) {
        // Caché corta (`taskCache`, ver `existence-cache.ts`): si `taskId` se
        // acaba de resolver con un listado en esta MISMA sesión (list_tasks,
        // get_task, mutate_tasks), no repetimos el `GET /api/tasks?id=` — el TTL
        // es de pocos segundos justo para no confiar en un "existe" viejo.
        const cached = taskCache.get(taskId);
        if (cached !== undefined) {
            assertTaskUsable(cached, taskId, opts);
            return;
        }
        const task = await findTaskById(config, taskId);
        if (task)
            taskCache.set(task);
        assertTaskUsable(task, taskId, opts);
    }
    /**
     * Fino wrapper de `mutateTask` que invalida `taskCache` DESPUÉS de encolar —
     * cualquier mutación LOCAL (encolada desde ESTE proceso) sobre `input.taskId`
     * la saca de la caché de existencia, para no servir un "existe" de antes de
     * esa mutación en la próxima `requireTaskExists` sobre el mismo id. `delete`
     * sobre un id que nunca estuvo cacheado (p. ej. un `listId`/`sectionId`, que
     * viaja en el mismo campo `taskId` de `MutateTaskInput` — ver su JSDoc en
     * `lumbre-client.ts`) es un no-op inofensivo, así que este wrapper reemplaza
     * TODAS las llamadas a `mutateTask` de las tools de tarea/lista/sección de
     * aquí abajo, no solo las que de verdad tocan una tarea cacheada.
     */
    async function mutateTaskInvalidating(input) {
        await mutateTask(config, input);
        taskCache.invalidate(input.taskId);
    }
    const completeTaskTool = server.registerTool('complete_task', {
        description: `Marca una tarea (o SUBTAREA, aunque para eso es más claro complete_subtask) como hecha, o ` +
            `la desmarca con done:false. ${ASYNC_NOTE}`,
        inputSchema: {
            taskId: z.string().uuid().describe('Id de la tarea (ver list_tasks)'),
            done: z.boolean().optional().describe('true = completar (default); false = desmarcar')
        }
    }, async (input) => {
        try {
            await requireTaskExists(input.taskId, { allowSubtask: true });
            await mutateTaskInvalidating({
                taskId: input.taskId,
                kind: 'complete',
                payload: { done: input.done ?? true }
            });
            return textResult(`Encolado en Lumbre: ${input.done === false ? 'desmarcar' : 'completar'} la tarea ${input.taskId} ` +
                '(se aplicará al sincronizar).');
        }
        catch (err) {
            return errorResult(err);
        }
    });
    const cancelTaskTool = server.registerTool('cancel_task', {
        description: `Cancela una tarea existente ("no se hizo ni se hará", distinto de completarla); sale ` +
            `igual de pendientes/rollover. Dispara con "cancela"/"descarta" (sin borrarla). ` +
            `cancelled:false la restaura. ${ASYNC_NOTE}`,
        inputSchema: {
            taskId: z.string().uuid().describe('Id de la tarea (ver list_tasks)'),
            cancelled: z.boolean().optional().describe('true = cancelar (default); false = restaurar')
        }
    }, async (input) => {
        try {
            await requireTaskExists(input.taskId, { allowSubtask: true });
            await mutateTaskInvalidating({
                taskId: input.taskId,
                kind: 'cancel',
                payload: { cancelled: input.cancelled ?? true }
            });
            return textResult(`Encolado en Lumbre: ${input.cancelled === false ? 'restaurar' : 'cancelar'} la tarea ${input.taskId} ` +
                '(se aplicará al sincronizar).');
        }
        catch (err) {
            return errorResult(err);
        }
    });
    const updateTaskTool = server.registerTool('update_task', {
        description: `Edita texto, notas, prioridad u hora de una tarea existente (NO subtareas: rechaza su id ` +
            `con error). Los campos que omitas no cambian; \`notes\` REEMPLAZA las anteriores enteras. ` +
            `${ASYNC_NOTE}`,
        inputSchema: {
            taskId: z.string().uuid().describe('Id de la tarea (ver list_tasks)'),
            content: z.string().min(1).max(2000).optional().describe('Nuevo texto/título de la tarea'),
            notes: z
                .string()
                .max(10000)
                .optional()
                .describe('Nuevas notas/descripción (reemplaza las anteriores por completo)'),
            priority: z
                .enum(['p1', 'p2', 'p3', 'p4'])
                .optional()
                .describe('p1 = más urgente … p3; p4 = quitar la prioridad'),
            time: z
                .union([z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), z.null()])
                .optional()
                .describe('Hora "HH:MM" (24h); si la tarea no tiene día se agenda hoy. null la quita')
        }
    }, async (input) => {
        if (input.content === undefined &&
            input.notes === undefined &&
            input.priority === undefined &&
            input.time === undefined) {
            return errorResult(new Error('Indica al menos un campo a cambiar (content, notes, priority o time).'));
        }
        try {
            await requireTaskExists(input.taskId, { allowSubtask: false });
            await mutateTaskInvalidating({
                taskId: input.taskId,
                kind: 'update',
                payload: {
                    ...(input.content !== undefined ? { content: input.content } : {}),
                    ...(input.notes !== undefined ? { notes: input.notes } : {}),
                    ...(input.priority !== undefined ? { priority: priorityToLevel(input.priority) } : {}),
                    ...(input.time !== undefined ? { time: input.time } : {})
                }
            });
            return textResult(`Encolada en Lumbre la edición de la tarea ${input.taskId} (se aplicará al sincronizar).`);
        }
        catch (err) {
            return errorResult(err);
        }
    });
    const rescheduleTaskTool = server.registerTool('reschedule_task', {
        description: `Mueve una tarea existente a otro día, o a "Algún día"/Bandeja de entrada con date:null. ` +
            `NO aplica a una SUBTAREA (rechaza su id con error). ${ASYNC_NOTE}`,
        inputSchema: {
            taskId: z.string().uuid().describe('Id de la tarea (ver list_tasks)'),
            date: z
                .union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.null()])
                .describe('Día destino, YYYY-MM-DD, o null para mandarla a "Algún día"/Bandeja de entrada')
        }
    }, async (input) => {
        try {
            await requireTaskExists(input.taskId, { allowSubtask: false });
            await mutateTaskInvalidating({
                taskId: input.taskId,
                kind: 'reschedule',
                payload: { date: input.date }
            });
            return textResult(`Encolado en Lumbre el cambio de fecha de la tarea ${input.taskId} a ` +
                `${input.date ?? '"Algún día"'} (se aplicará al sincronizar).`);
        }
        catch (err) {
            return errorResult(err);
        }
    });
    const deleteTaskTool = server.registerTool('delete_task', {
        description: `Borra (soft-delete) una tarea existente, o una SUBTAREA suya (borra solo esa). ACCIÓN ` +
            `DELICADA: sin confirmación inmediata ni deshacer — confírmalo con el usuario antes de ` +
            `llamarla. ${ASYNC_NOTE}`,
        inputSchema: {
            taskId: z.string().uuid().describe('Id de la tarea (o subtarea) a borrar (ver list_tasks/get_task)')
        }
    }, async (input) => {
        try {
            await requireTaskExists(input.taskId, { allowSubtask: true });
            await mutateTaskInvalidating({ taskId: input.taskId, kind: 'delete', payload: {} });
            return textResult(`Encolado en Lumbre el borrado de la tarea ${input.taskId} (se aplicará al sincronizar).`);
        }
        catch (err) {
            return errorResult(err);
        }
    });
    const setSectionTool = server.registerTool('set_section', {
        description: 'Mueve una tarea existente a una sección dentro de SU lista (se crea si no existe), o ' +
            'la saca con section:null. Se ignora si la tarea no tiene lista propia. NO aplica a ' +
            'subtareas. ' + ASYNC_NOTE,
        inputSchema: {
            taskId: z.string().uuid().describe('Id de la tarea (ver list_tasks)'),
            section: z
                .string()
                .max(200)
                .nullable()
                .describe('Nombre de la sección destino dentro de la lista de la tarea (se crea si no existe). ' +
                'null = quitarla de su sección actual.')
        }
    }, async (input) => {
        try {
            await requireTaskExists(input.taskId, { allowSubtask: false });
            await mutateTaskInvalidating({
                taskId: input.taskId,
                kind: 'setSection',
                payload: { section: input.section }
            });
            return textResult(`Encolado en Lumbre: mover la tarea ${input.taskId} a la sección ` +
                `${input.section === null ? '(ninguna)' : `"${input.section}"`} (se aplicará al sincronizar).`);
        }
        catch (err) {
            return errorResult(err);
        }
    });
    const removeSectionTool = server.registerTool('remove_section', {
        description: 'Borra una sección dentro de una lista; sus tareas no se borran, solo quedan sueltas ' +
            'en la MISMA lista. Resuelve `sectionId` desde una tarea que viva ahí ' +
            '(list_tasks/get_task); si no existe, se ignora. ' + ASYNC_NOTE,
        inputSchema: {
            sectionId: z
                .string()
                .uuid()
                .describe('Id de la sección a borrar (ver el campo `sectionId` de una tarea que viva en ella, en list_tasks/get_task)')
        }
    }, async (input) => {
        try {
            await mutateTaskInvalidating({
                taskId: input.sectionId,
                kind: 'removeSection',
                payload: { sectionId: input.sectionId }
            });
            return textResult(`Encolado en Lumbre el borrado de la sección ${input.sectionId} (se aplicará al sincronizar).`);
        }
        catch (err) {
            return errorResult(err);
        }
    });
    // ── Gestión de listas de "Algún día" (paridad UI↔MCP, docs/20-contrato-lista.md) ──
    //
    // `create_list`/`nest_list`/`rename_list`/`remove_list`/`move_to_list` NO
    // tienen tool suelta desde el 2026-08-27 (podadas: 3.506 bytes de
    // `tools/list`, 5 tools por 19 llamadas/mes de uso real medido sobre un
    // mes de transcripts): son las ops del mismo nombre en `mutate_tasks`
    // (`mutateTasksOpSchema`/`mutateTasksStrictOpSchema`/`translateOp`), que ya
    // las implementaba entero — `create_list.listId` es incluso un
    // SUPERCONJUNTO (encadenar dentro del mismo lote, cosa que la tool suelta
    // no tenía). Identidad = el id, no el nombre (`rename_list` no la
    // cambia). `remove_list` nunca pierde tareas (se reasignan) ni permite
    // borrar la última lista viva ni la Bandeja de entrada canónica (§5
    // "Prohibidos" del contrato). Detalle completo del contrato de lista en
    // `docs/20-contrato-lista.md`.
    const addSubtaskTool = server.registerTool('add_subtask', {
        description: `Añade subtareas (checklist) a una tarea existente. Un solo nivel: si \`taskId\` ya ` +
            `es subtarea, se descarta en silencio. Para crearlas junto con la tarea, usa add_task ` +
            `con \`subtasks\`. ${ASYNC_NOTE}`,
        inputSchema: {
            taskId: z.string().uuid().describe('Id de la tarea PADRE (ver list_tasks)'),
            subtasks: z
                .array(z.string())
                .min(1)
                .max(50)
                .describe('Textos de las subtareas a añadir, en orden (cada uno se recorta a 500 caracteres)')
        }
    }, async (input) => {
        try {
            // `allowSubtask: true` (no relaja nada nuevo): si `taskId` YA es una
            // subtarea, esto solo evita adelantar el rechazo aquí — el
            // materializador (`task-ops`/`inbound-materialize.ts`) descarta la
            // mutación en silencio de todas formas, comportamiento YA documentado
            // arriba y sin cambios por este fix.
            await requireTaskExists(input.taskId, { allowSubtask: true });
            await mutateTaskInvalidating({
                taskId: input.taskId,
                kind: 'addSubtask',
                payload: { subtasks: input.subtasks }
            });
            return textResult(`Encolado en Lumbre: ${input.subtasks.length} subtarea(s) para la tarea ${input.taskId} ` +
                '(se aplicará al sincronizar).');
        }
        catch (err) {
            return errorResult(err);
        }
    });
    const completeSubtaskTool = server.registerTool('complete_subtask', {
        description: `Marca hecha (o desmarca con done:false) una SUBTAREA por su id — mismo mecanismo que ` +
            `complete_task, sin cascada sobre la tarea padre. Resuelve \`subtaskId\` con ` +
            `get_task(taskId) de su padre. ${ASYNC_NOTE}`,
        inputSchema: {
            subtaskId: z.string().uuid().describe('Id de la subtarea (ver get_task de su tarea padre)'),
            done: z.boolean().optional().describe('true = completar (default); false = desmarcar')
        }
    }, async (input) => {
        try {
            await requireTaskExists(input.subtaskId, { allowSubtask: true });
            await mutateTaskInvalidating({
                taskId: input.subtaskId,
                kind: 'complete',
                payload: { done: input.done ?? true }
            });
            return textResult(`Encolado en Lumbre: ${input.done === false ? 'desmarcar' : 'completar'} la subtarea ` +
                `${input.subtaskId} (se aplicará al sincronizar).`);
        }
        catch (err) {
            return errorResult(err);
        }
    });
    // ── BRL (add-on experimental): registro del día ────────────────────────────
    /**
     * Comprueba que `entryId` EXISTE en el registro de `date` antes de encolar una
     * edición o un borrado — gemelo de `requireTaskExists` para el BRL, y por el
     * MISMO motivo (el typo real de 2026-07-17): `/api/mutations` no valida el
     * target server-side, así que un id mal transcrito se encolaba igual, el
     * materializador lo descartaba en silencio y esta tool contestaba «Encolado…»
     * tan tranquila. Medido en local el 2026-08-09 sobre la 1ª versión de estas
     * tools: `delete_brl_entry` con un uuid inventado respondía «Encolado el
     * borrado» sin borrar nada.
     *
     * De aquí sale la razón de que `update_brl_entry`/`delete_brl_entry` pidan
     * `date` además del id: una entrada solo se puede buscar POR DÍA
     * (`GET /api/brl/:date`), no hay lookup por id suelto como el de las tareas
     * (`GET /api/tasks?id=`). El dato no le cuesta nada al modelo: viene en la
     * misma llamada a `list_brl_entries` de la que sacó el id.
     */
    async function requireBrlEntryExists(date, entryId) {
        // Caché corta (`brlCache`, ver `existence-cache.ts`), gemela de la de
        // `requireTaskExists`: si `entryId` ya se vio en un `list_brl_entries` de
        // ESE `date` dentro del TTL, no repetimos el `GET /api/brl/:date`.
        if (brlCache.has(date, entryId))
            return;
        const entries = await listBrlEntries(config, date);
        brlCache.setAll(date, entries);
        if (entries.some((entry) => entry.id === entryId))
            return;
        throw new Error(`El registro del ${date} no tiene ninguna entrada con id ${entryId} (¿se transcribió mal, o ` +
            'es de otro día?). Resuélvelo de nuevo con list_brl_entries. No se ha encolado nada.');
    }
    const listBrlEntriesTool = server.registerTool('list_brl_entries', {
        description: 'Lee el registro (BRL) de un día: entradas `-` (nota) y `=` (pensamiento), con id y hora. ' +
            'Única forma de obtener el id que pide mutate_brl (ops update/delete). No son tareas.',
        inputSchema: {
            date: z
                .string()
                .regex(/^\d{4}-\d{2}-\d{2}$/)
                .describe(BRL_DATE)
        }
    }, async (input) => {
        try {
            const entries = await listBrlEntries(config, input.date);
            brlCache.setAll(input.date, entries);
            if (entries.length === 0)
                return textResult(`El registro del ${input.date} está vacío.`);
            return textResult([
                `Registro del ${input.date} (${entries.length} entrada(s)):`,
                ...entries.map((e) => `${e.id}  ${e.time || '--:--'}  ${e.entry}`)
            ].join('\n'));
        }
        catch (err) {
            return errorResult(err);
        }
    });
    /**
     * Sustituye a `add_brl_entry`/`update_brl_entry`/`delete_brl_entry`
     * (podadas el 2026-08-27, cero llamadas medidas en un mes para las tres —
     * el BRL en sí NO se toca, David lo usa desde el móvil/web, fuera de esa
     * medición): mismo criterio de agrupar que `mutate_tasks`, pero SIN
     * `runBatch` — no hay `POST /api/batch` para el BRL (ese endpoint es solo
     * tareas, ver `BatchOp` en `lumbre-client.ts`), así que esto es un
     * `mutateTask`/`requireBrlEntryExists` por op, en el ORDEN pedido,
     * exactamente lo que hacía cada tool suelta — solo que en UNA tool call.
     * Éxito PARCIAL igual que `mutate_tasks`: una op que falla (forma
     * inválida o `entryId` inexistente) no aborta las siguientes.
     */
    const mutateBrlTool = server.registerTool('mutate_brl', {
        description: `Vía PREFERENTE (y desde el 2026-08-27, ÚNICA — sustituye a add/update/delete_brl_entry) ` +
            `para VARIAS entradas del registro (BRL) de golpe: añade, reescribe o borra en una sola ` +
            `llamada. Contrato por-op en la description de \`ops\`. Éxito PARCIAL: una op inválida no ` +
            `bloquea las demás — el resultado detalla qué falló por posición y el \`id\` de cada \`add\` ` +
            `encolado. La op \`delete\` es DELICADA: sin deshacer — confírmala con el usuario antes. ` +
            `${ASYNC_NOTE}`,
        inputSchema: {
            ops: z
                .array(mutateBrlOpSchema)
                .min(1)
                .max(200)
                .describe('Operaciones a ejecutar, en el orden indicado (máx. 200 por llamada). Contrato por-op ' +
                '(`*` = obligatorio, el resto opcional): add: date*, text* [kind, time] · update: ' +
                'date*, entryId*, text* [kind] · delete: date*, entryId*')
        }
    }, async (input) => {
        const rawOps = input.ops;
        const results = [];
        for (let i = 0; i < rawOps.length; i++) {
            const raw = rawOps[i];
            const parsed = mutateBrlStrictOpSchema.safeParse(raw);
            if (!parsed.success) {
                results.push({ index: i, ok: false, error: formatOpShapeError(String(raw.op), parsed.error) });
                continue;
            }
            const op = parsed.data;
            try {
                if (op.op === 'add') {
                    // Id PRE-GENERADO aquí, igual que `add_brl_entry` (idempotencia de
                    // creación si el lote se reabre tras un fallo, ver `createBrlEntry`
                    // en el repo principal).
                    const entryId = randomUUID();
                    await mutateTask(config, {
                        taskId: entryId,
                        kind: 'createBrlEntry',
                        payload: {
                            date: op.date,
                            entry: `${op.kind === 'thought' ? '=' : '-'} ${op.text}`,
                            ...(op.time !== undefined ? { time: op.time } : {})
                        }
                    });
                    results.push({ index: i, ok: true, id: entryId });
                }
                else if (op.op === 'update') {
                    await requireBrlEntryExists(op.date, op.entryId);
                    await mutateTask(config, {
                        taskId: op.entryId,
                        kind: 'updateBrlEntry',
                        payload: { entry: `${op.kind === 'thought' ? '=' : '-'} ${op.text}` }
                    });
                    brlCache.invalidate(op.date, op.entryId);
                    results.push({ index: i, ok: true, id: op.entryId });
                }
                else {
                    await requireBrlEntryExists(op.date, op.entryId);
                    await mutateTask(config, { taskId: op.entryId, kind: 'removeBrlEntry', payload: {} });
                    brlCache.invalidate(op.date, op.entryId);
                    results.push({ index: i, ok: true, id: op.entryId });
                }
            }
            catch (err) {
                results.push({
                    index: i,
                    ok: false,
                    error: err instanceof LumbreApiError ? err.message : err instanceof Error ? err.message : String(err)
                });
            }
        }
        const okCount = results.filter((r) => r.ok).length;
        const idLines = results
            .filter((r) => r.ok)
            .map((r) => `  [${r.index}] ${String(rawOps[r.index].op)}: id ${r.id}`);
        const failureLines = results
            .filter((r) => !r.ok)
            .map((r) => `  [${r.index}] ${String(rawOps[r.index].op)}: ${r.error}`);
        let summary = `Lumbre: ${okCount}/${rawOps.length} operación(es) encoladas.`;
        if (idLines.length > 0)
            summary += `\nids asignados:\n${idLines.join('\n')}`;
        if (failureLines.length > 0)
            summary += `\n${failureLines.length} fallaron:\n${failureLines.join('\n')}`;
        summary += `\n\n${ASYNC_NOTE}`;
        return textResult(summary);
    });
    // ── Feature batch (`plan-batch.md`): N operaciones en UNA sola tool call ───
    const mutateTasksTool = server.registerTool('mutate_tasks', {
        description: `Vía PREFERENTE para VARIAS operaciones de golpe (crear y/o mutar): resuelve existencias y ` +
            `encola en UNA sola llamada, en vez de una tool call por operación. Cada elemento de \`ops\` ` +
            `equivale a su tool individual (mapeo op↔tool en el README) — salvo las ops de LISTA, sin ` +
            `tool suelta desde el 2026-08-27: mutate_tasks es su ÚNICA vía. Contrato por-op en la ` +
            `description de \`ops\`. Éxito PARCIAL: una op inválida no bloquea las ` +
            `demás — el resultado detalla qué falló por posición y el \`id\` de cada una encolada ` +
            `(create_list→listId, add_task→taskId). Encadenar un create_list con otra op del MISMO lote: ` +
            `dale tú el \`listId\` (uuid v4) al crearla. ${ASYNC_NOTE}`,
        inputSchema: {
            ops: z
                .array(mutateTasksOpSchema)
                .min(1)
                .max(200)
                .describe('Operaciones a ejecutar, en el orden indicado (máx. 200 por llamada). Contrato por-op ' +
                '(`*` = obligatorio, el resto opcional): add_task: text* [list|listId, section, ' +
                'priority, date, deadline, time, recurrence, subtasks, notes] · complete: taskId* ' +
                '[done] · cancel: taskId* [cancelled] · update: taskId*, ≥1 de [content, notes, ' +
                'priority, time] · reschedule: taskId*, date* · delete: taskId* · set_section: ' +
                'taskId*, section* · move_to_list: taskId*, uno de [listId, list] · add_subtask: ' +
                'taskId*, subtasks* · complete_subtask: subtaskId* [done] · remove_section: sectionId* ' +
                '· create_list: name* [color, icon, listId] · nest_list: listId*, parentId* · ' +
                'rename_list: listId*, name* · remove_list: listId*')
        }
    }, async (input) => {
        try {
            // Re-validación ESTRICTA por-op ANTES de tocar red: `mutateTasksOpSchema`
            // (el schema EXPUESTO) es deliberadamente laxo, así que un elemento cuya
            // forma no encaje con SU `op` (campo obligatorio ausente, o un campo
            // válido en general pero ajeno a esa op) todavía no se ha rechazado en
            // este punto — ver el JSDoc de `mutateTasksStrictOpSchema`. Se reporta
            // como un fallo MÁS del informe de éxito parcial (mismo array que
            // `taskId` inexistente), no tumba el `mutate_tasks` entero.
            const rawOps = input.ops;
            const validated = [];
            // Índice, dentro de `validated` (compactado, sin los descartados por
            // forma), de la posición ORIGINAL en `input.ops` — mismo patrón de
            // indirección que ya usa `buildBatchFromOps` para `batchOps` vs `ops`,
            // aplicado un nivel más arriba.
            const validatedOriginalIndexes = [];
            const shapeFailures = [];
            rawOps.forEach((raw, index) => {
                const result = mutateTasksStrictOpSchema.safeParse(raw);
                if (!result.success) {
                    shapeFailures.push({ index, error: formatOpShapeError(String(raw.op), result.error) });
                    return;
                }
                validated.push(result.data);
                validatedOriginalIndexes.push(index);
            });
            const idsToCheck = collectExistenceCheckIds(validated);
            const existing = idsToCheck.length > 0 ? await findTasksByIds(config, idsToCheck) : new Map();
            taskCache.setAll(existing.values());
            const built = buildBatchFromOps(validated, existing);
            const batchOps = built.batchOps;
            const originalIndexes = built.originalIndexes.map((i) => validatedOriginalIndexes[i]);
            const results = batchOps.length > 0 ? await runBatch(config, batchOps) : [];
            // Cualquier op 'mutate' del lote pudo tocar una tarea que ya estuviera
            // en `taskCache` (poblada arriba) — se invalida sin mirar el resultado
            // individual: barato, y evita servir un "existe" rancio si otra op del
            // MISMO lote la borró justo antes. No-op para las ops de lista/sección
            // (su `taskId` nunca estuvo cacheado aquí).
            for (const op of batchOps) {
                if (op.type === 'mutate')
                    taskCache.invalidate(op.taskId);
            }
            // Tres fuentes de fallo ahora (forma inválida, descartadas ANTES de
            // mandar el batch por `buildBatchFromOps`, y las que el servidor
            // rechazó al validar/encolar) se combinan en un único informe,
            // ordenado por posición ORIGINAL en `ops` — el modelo ve exactamente
            // qué operación falló y por qué, sin tener que distinguir entre las
            // tres fases. Las EXITOSAS con `id` (code-review 🟠 #3a: antes se
            // perdían — el modelo no podía enterarse del `listId` de un
            // `create_list` sin una `list_tasks` de más) también se recogen, para
            // poder encadenarlas en un turno posterior (o confirmar el id que ya
            // se auto-generó, si la op no traía uno propio — ver `create_list`).
            const failures = [
                ...shapeFailures,
                ...built.skipped.map((s) => ({ index: validatedOriginalIndexes[s.index], error: s.error }))
            ];
            const succeededWithId = [];
            results.forEach((r, i) => {
                const index = originalIndexes[i];
                if (r.ok) {
                    if (r.id !== undefined)
                        succeededWithId.push({ index, id: r.id });
                }
                else {
                    failures.push({ index, error: r.error ?? 'error desconocido' });
                }
            });
            const okCount = results.filter((r) => r.ok).length;
            failures.sort((a, b) => a.index - b.index);
            succeededWithId.sort((a, b) => a.index - b.index);
            // `op` se lee del elemento CRUDO (`rawOps`), no de `validated` (que no
            // tiene entrada para los descartados por forma) — el schema EXPUESTO
            // ya garantiza que es uno de los 15 nombres válidos.
            const opNameAt = (index) => String(rawOps[index].op);
            const failureLines = failures.map((f) => `  [${f.index}] ${opNameAt(f.index)}: ${f.error}`);
            const idLines = succeededWithId.map((s) => `  [${s.index}] ${opNameAt(s.index)}: id ${s.id}`);
            let summary = `Lumbre: ${okCount}/${rawOps.length} operación(es) encoladas.`;
            if (idLines.length > 0)
                summary += `\nids asignados:\n${idLines.join('\n')}`;
            if (failureLines.length > 0) {
                summary += `\n${failureLines.length} fallaron:\n${failureLines.join('\n')}`;
            }
            summary += `\n\n${ASYNC_NOTE}`;
            return textResult(summary);
        }
        catch (err) {
            return errorResult(err);
        }
    });
    // Modo acotado (`toolset === 'attachments'`, ver `CreateServerOptions`):
    // retira las 17 tools que NO son `add_attachment`/`read_attachment` —
    // TODAS se registraron arriba igual (para no bifurcar cada una de las 17
    // llamadas a `registerTool` con un `if`), así que aquí solo se deshace lo
    // que sobra, ANTES de que `server` se conecte a ningún transporte: ningún
    // cliente llega a ver el `tools/list` de 19 en el intermedio.
    if (toolset === 'attachments') {
        for (const tool of [
            addTaskTool,
            refreshSyncTool,
            listTasksTool,
            listListsTool,
            getTaskTool,
            completeTaskTool,
            cancelTaskTool,
            updateTaskTool,
            rescheduleTaskTool,
            deleteTaskTool,
            setSectionTool,
            removeSectionTool,
            addSubtaskTool,
            completeSubtaskTool,
            listBrlEntriesTool,
            mutateBrlTool,
            mutateTasksTool
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
 * `read_attachment`, pensado para un SEGUNDO conector stdio local dedicado
 * (David enchufa a la vez el remoto de las 19 tools y este, sin duplicar
 * superficie — ver README). Cualquier otro valor (incluido no ponerla) cae
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