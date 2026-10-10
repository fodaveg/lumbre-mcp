# Deriva de contratos entre tools, documentación y API de la app (10 oct 2026)

Alcance: contraste de solo lectura de tres capas que deben coincidir: (A) los
schemas reales de las tools registradas en `src/tools/*.ts` y `src/index.ts`;
(B) `README.md`, `docs/instalar.md` y la skill pública `skills/lumbre/`; (C) los
handlers de la API de la app Lumbre que el relé consume
(`src/routes/api/**/+server.ts` del repo `lumbre`). Árboles inspeccionados:
`lumbre-mcp` main `3540a7e` y `lumbre` main `be9411daf`. Los resultados
describen esos árboles; una rama o una versión desplegada puede diferir.

Lo hizo un agente de solo lectura; la sesión coordinadora comprobó las citas de
la tabla de discrepancias contra el repo (`git log -- src/tools`, las líneas
citadas de `README.md` y `src/tools/batch.ts`) y rebajó una prioridad, como se
indica. No se probó nada contra un servidor vivo.

## Discrepancias priorizadas

Criterio: Alta = rompe una operación o engaña sobre un borrado; Media =
documentación desfasada que confunde; Baja = cosmética. Ninguna discrepancia
alcanza Alta: ninguna tool u op falta, sobra o cambia de nombre entre código,
README y skill.

| Prioridad | Discrepancia | Dónde | Corrección propuesta |
| --- | --- | --- | --- |
| Media (el agente la marcó Alta; se rebaja porque no rompe ninguna operación) | `docs/instalar.md` dice que el último cambio de superficie fue el 2026-09-24 (MC7). Hay tres posteriores sin citar: cuatro ops de ciclo de vida de proyecto en `organize` (`8467e30`, 8 oct), `list_habits` deja de caer a `/api/export` (`6452fca`, 8 oct) y `get_list` devuelve el nombre del padre (`290c7b4`, 7 oct). Un cliente con `tools/list` cacheado antes del 8 oct no ve esas ops. | `docs/instalar.md:22-27` frente a `git log -- src/tools` | Actualizar el párrafo: último cambio 2026-10-08 (cierre, reapertura y fechas de proyecto; `list_habits` por `GET /api/habits`). |
| Media | `README.md` presenta `close_project`, `reopen_project`, `set_project_when` y `set_project_deadline` como ops de `organize` sin decir desde cuándo, en un bloque cuyas fechas acaban en «Desde el 2026-09-25: `set_parent`». Son del 2026-10-08. | `README.md:385-389` y `README.md:663-669` frente al commit `8467e30` | Añadir «desde el 2026-10-08» a esas cuatro ops. |
| Media | `README.md:50` sigue describiendo que `list_habits` cae a `/api/export`; desde `6452fca` llama a `GET /api/habits`. | `README.md:50` y `README.md:730-742` frente a `src/tools/habits.ts` | Reescribir la frase de la línea 50 y citar la fecha del cambio. |
| Baja | El comentario de `batch.ts` dice «las 10 ops de `organize`»; el schema tiene 14 (`delete`, `remove_section`, `create_list`, `nest_list`, `rename_list`, `remove_list`, `set_list_notes`, `move_to_list`, `set_list_kind`, `close_project`, `reopen_project`, `set_project_when`, `set_project_deadline`, `delete_habit`). `README.md:880` también dice 10 en la tabla y luego lista 14. | `src/tools/batch.ts:279`, `README.md:880` | Cambiar ambos a 14 o dejar de contar en el texto. |

## 1. Censo de tools registradas

17 `registerTool` en el código. Las 17 aparecen con el mismo nombre en
`README.md`, en `skills/lumbre/SKILL.md` y en al menos una referencia de la
skill. Sin discrepancias de nombre.

| Tool | Fichero | Tipo | README | Skill |
| --- | --- | --- | --- | --- |
| `add_task` | `src/tools/tasks.ts:88` | escritura | sí (l. 42) | `daily.md` |
| `list_tasks` | `src/tools/tasks.ts:175` | lectura | sí (l. 78) | `read.md`, `daily.md` |
| `get_task` | `src/tools/tasks.ts:481` | lectura | sí (l. 231) | `read.md`, `daily.md` |
| `mutate_tasks` | `src/tools/batch.ts:755` | escritura, 18 ops | sí (l. 380) | `daily.md`, `backlog.md`, `development.md` |
| `organize` | `src/tools/batch.ts:811` | escritura destructiva, 14 ops | sí (l. 391) | `backlog.md`, `development.md` |
| `list_lists` | `src/tools/lists.ts:27` | lectura | sí (l. 160) | `read.md`, `backlog.md` |
| `get_list_links` | `src/tools/lists.ts:48` | lectura | sí (l. 199) | `destinations.md` |
| `get_list` | `src/tools/lists.ts:69` | lectura | sí (l. 184) | `read.md` |
| `link_list_note` | `src/tools/lists.ts:103` | escritura idempotente | sí (l. 212) | `destinations.md` |
| `unlink_list_note` | `src/tools/lists.ts:125` | escritura idempotente | sí (l. 224) | `destinations.md` |
| `read_attachment` | `src/tools/attachments.ts:80` | lectura | sí (l. 246) | `read.md` |
| `add_attachment` | `src/tools/attachments.ts:127` | escritura | sí (l. 254) | `attachments-and-connection.md` |
| `delete_attachment` | `src/tools/attachments.ts:226` | escritura destructiva | sí (l. 290) | `attachments-and-connection.md` |
| `list_brl_entries` | `src/tools/brl.ts:136` | lectura | sí (l. 691) | `read.md` |
| `mutate_brl` | `src/tools/brl.ts:179` | escritura, 3 ops | sí (l. 697) | `development.md` |
| `list_habits` | `src/tools/habits.ts:16` | lectura | sí (l. 730) | `read.md` |
| `refresh_sync` | `src/tools/sync.ts:56` | lectura | sí (l. 297) | `read.md` |

## 2. Parámetros del schema frente a la skill

Todos los parámetros que la skill nombra existen en el schema zod de su tool, y
todos los campos que afectan a la seguridad de una operación están nombrados en
la referencia correspondiente.

| Tool | Parámetros del schema | Observación de seguridad |
| --- | --- | --- |
| `add_task` | `text`*, `list`, `listId`, `section`, `priority`, `date`, `deadline`, `time`, `recurrence`, `subtasks`, `notes`, `tags` | `daily.md` manda `listId` sobre `list` porque un nombre mal escrito crea un proyecto. |
| `list_tasks` | `scope`, `days`, `list`, `section`, `includeDone`, `includeArchived`, `notes`, `notesRecentHours`, `notesSince` | ninguna |
| `get_task` | `taskId`*, `includeArchived` | ninguna |
| `mutate_tasks` | `op`* más campos por op (`.strict()`) | `op` es `z.string()`, no `enum`, para que una op desconocida falle solo en su fila. |
| `organize` | `op`* más campos por op (`.strict()`) | Frontera de destrucción: los subagentes de la skill no reciben `organize`. |
| `list_lists` | sin parámetros | ninguna |
| `get_list_links`, `get_list` | `listId`* | ninguna |
| `link_list_note`, `unlink_list_note` | `listId`*, `url`*, `label`* | ninguna |
| `read_attachment` | `attachment_id`* | ninguna |
| `add_attachment` | `taskId`*, `file_path` o `content_base64` (excluyentes), `filename` | Dos vías excluyentes; el acceso a disco es inyectable. |
| `delete_attachment` | `attachment_id`* | Destructiva sin deshacer; la skill exige confirmación. |
| `list_brl_entries` | `date`* | ninguna |
| `mutate_brl` | `ops`* (máx. 200) | `delete` es destructiva; `daily.md` lo dice. |
| `list_habits` | `includeArchived` | ninguna |
| `refresh_sync` | sin parámetros | ninguna |

## 3. Ops internas

35 ops en total: 18 de `mutate_tasks`, 14 de `organize`, 3 de `mutate_brl`.
Todas están en `README.md` (desde la línea 759) y en la skill. Las únicas sin
fecha de alta en la documentación son las cuatro de proyecto del 2026-10-08
(`close_project`, `reopen_project`, `set_project_when`, `set_project_deadline`),
que la skill sí describe en `backlog.md` y `mcp-safe-operations.md`.

| Op | Tool | Campos obligatorios | Fecha documentada |
| --- | --- | --- | --- |
| `add_task` | `mutate_tasks` | `text` | inicio |
| `complete`, `cancel`, `restore`, `update`, `archive`, `unarchive`, `clear_waiting` | `mutate_tasks` | `taskId` | `restore`, `archive`, `unarchive` 2026-09-24 |
| `reschedule` | `mutate_tasks` | `taskId`, `date` | inicio |
| `set_section` | `mutate_tasks` | `taskId`, `section` | inicio |
| `set_waiting` | `mutate_tasks` | `taskId`, `until` | MC6, 2026-09-24 |
| `register_habit`, `archive_habit`, `unarchive_habit` | `mutate_tasks` | `habitId` | 2026-09-24 |
| `skip_occurrence` | `mutate_tasks` | `seriesId`, `date` | MC7, 2026-09-24 |
| `add_subtask` | `mutate_tasks` | `taskId`, `subtasks` | inicio |
| `complete_subtask` | `mutate_tasks` | `subtaskId` | inicio |
| `set_parent` | `mutate_tasks` | `taskId`, `parentId` | 2026-09-25 |
| `delete` | `organize` | `taskId` | inicio |
| `remove_section` | `organize` | `sectionId` | inicio |
| `create_list` | `organize` | `name` | inicio |
| `nest_list` | `organize` | `listId`, `parentId` | inicio |
| `rename_list` | `organize` | `listId`, `name` | inicio |
| `remove_list` | `organize` | `listId` | inicio |
| `set_list_notes` | `organize` | `listId`, `notes` | inicio |
| `move_to_list` | `organize` | `taskId`, `listId` o `list` | inicio |
| `set_list_kind` | `organize` | `listId`, `listKind` | MC6, 2026-09-24 |
| `close_project` | `organize` | `listId`, `as` | sin fecha en la doc (commit `8467e30`, 2026-10-08) |
| `reopen_project` | `organize` | `listId` | sin fecha en la doc (2026-10-08) |
| `set_project_when` | `organize` | `listId`, `when` | sin fecha en la doc (2026-10-08) |
| `set_project_deadline` | `organize` | `listId`, `deadline` | sin fecha en la doc (2026-10-08) |
| `delete_habit` | `organize` | `habitId` | MC7, 2026-09-24 |
| `add` | `mutate_brl` | `date`, `text` | inicio |
| `update` | `mutate_brl` | `date`, `entryId`, `text` | inicio |
| `delete` | `mutate_brl` | `date`, `entryId` | inicio |

## 4. Prefijos de tool para Claude

Los tres prefijos por defecto (`mcp__lumbre__`, `mcp__claude_ai_Lumbre__`,
`mcp__claude_ai_lumbre__`) coinciden entre `docs/instalar.md:79`,
`skills/lumbre/scripts/manage-subagents.mjs` y las definiciones de
`skills/lumbre/agents/`. El cuarto, `mcp__<uuid>__`, solo está en
`docs/instalar.md:167-179` como caso medido en la app de escritorio de Windows;
no es un valor por defecto del gestor, que lo recibe por `--claude-tool-prefix`.
Sin discrepancias.

## 5. API de la app

Todas las rutas que llaman `src/lumbre-client.ts` y
`src/lumbre-oauth-backchannel.ts` tienen handler en `lumbre` `be9411daf`.

| Método | Ruta | Parámetros | Función del relé | Handler en la app |
| --- | --- | --- | --- | --- |
| POST | `/api/ingest` | `text`, `list`, `listId`, … | `addTask` | existe |
| GET | `/api/tasks` | `scope`, `list`, `section`, `includeDone`, `includeArchived`, `notes`, `limit`, `ids`, `includeLists`, `listId`, `notesSince` | `listTasks`, `findTasksByIds`, `listListsWithNotes`, `getList` | existe; `notes=length`, `notes=full`, `includeLists=1` y `listId` atendidos |
| GET | `/api/tasks?id=` | `id`, `notes` | `findTaskById` | existe |
| POST | `/api/batch` | `ops[]` con `type` `ingest`, `mutate` o `mutate_brl` | `runBatch` | existe |
| GET | `/api/list-links` | `listId` | `getListLinks` | existe |
| POST | `/api/list-links` | `listId`, `url`, `label` | `linkListNote`, `unlinkListNote` | existe |
| GET | `/api/attachments/:id` | | `readAttachment` | existe |
| POST | `/api/attachments?taskId=` | multipart o base64 | `uploadAttachment` | existe |
| DELETE | `/api/attachments/:id` | | `deleteAttachment` | existe |
| GET | `/api/brl/:date?format=json` | | `listBrlEntries` | existe |
| GET | `/api/habits` | | `listHabits` | existe |
| POST | `/api/sync/flush` | | `flushSync` | existe |
| POST | `/api/integrations/lumbre-mcp/{requests,authorize,exchange,introspect,revoke}` | ver `lumbre-oauth-backchannel.ts` | relé OAuth | existen |

`/api/mutations` sigue existiendo en la app como ruta heredada; el relé ya no
la llama.

Contratos que `audit-api-dependencies-20261002.md` dejó pendientes: R6
(`notes=length` y `listId` en `includeLists=1`), R8 (BRL por `/api/batch`) y R9
(`GET /api/habits`) están implementados en los dos lados (`8ae003a` en el relé;
`6452fca` retira la caída a `/api/export`). Ninguno sigue pendiente.

## 6. Cambios de superficie posteriores a los que cita `instalar.md`

`git log -- src/tools src/index.ts` desde el 2026-09-24:

| Commit | Fecha | Cambio de superficie visible para el cliente |
| --- | --- | --- |
| `8ae003a` | 2026-10-02 | sin cambio de schema (compatibilidad hacia atrás) |
| `e8cf331` | 2026-10-07 | campo `instructions` en `initialize` |
| `290c7b4` | 2026-10-07 | `get_list` devuelve el nombre del padre |
| `8467e30` | 2026-10-08 | cuatro ops nuevas en `organize` |
| `89b4372` | 2026-10-08 | textos de aviso de esas ops |
| `6452fca` | 2026-10-08 | `list_habits` deja de caer a `/api/export` |

## Lo que cubre `tests/skill-lumbre/validate-tool-names.mjs`

Comprueba que los nombres de tool y de op que cita la skill existen en el
código y están en snake_case, y que los parámetros nombrados existen en los
schemas. No comprueba fechas, recuentos («10 ops») ni la coincidencia con la
API de la app.

## Fuera de alcance / no medido

- Nada se probó contra un servidor vivo; es lectura de código.
- Los límites que cita el README (500 tareas, 200 ops por lote, 25 MiB por
  adjunto) no se contrastaron con la app.
- Los textos de aviso que las descripciones de las tools atribuyen a la app no
  se verificaron contra los handlers actuales.
- El relé OAuth tiene su propio audit (`audit-seguridad-relay-oauth-20261010.md`).
