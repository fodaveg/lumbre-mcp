# Fase 2 — mutar tareas existentes

> **YA IMPLEMENTADA** (rama `feat/mcp-fase2`): `inbound_mutations` (schema +
> migración `0023`), `src/lib/server/repos/mutations.ts`,
> `POST /api/mutations` + `GET /api/inbound-mutations`, drenaje en
> `+page.svelte` (`drainInboundMutations`, `facade.byId`), y las 4 tools
> (`complete_task`/`update_task`/`reschedule_task`/`delete_task`) en
> `mcp/src/index.ts`/`lumbre-client.ts`. El diseño de abajo se conserva TAL
> CUAL (documenta el porqué); las decisiones de implementación reales:
> `update` valida `priority` como `PriorityLevel|null` (nivel numérico, no
> `'p1'..'p4'` — la tool traduce), y `reschedule` con `date: null` manda la
> tarea a la Bandeja de entrada (`facade.resolveInboxListId()` +
> `moveToList`), no a un `move(id, null, …)` suelto (eso la dejaría sin lista
> hasta el próximo `ensureSomedayLists`).
>
> **Añadida después una 5ª tool, `set_section`** (`kind: 'setSection'`,
> payload `{ section: string | null }`): mueve una tarea EXISTENTE a una
> sección/heading dentro de SU PROPIA lista (resuelta client-side vía
> `t.somedayListId`, no viaja en el payload), creándola si no existe
> (`facade.ensureSectionByName`); `section: null` la saca de su sección
> (`facade.setTaskSection(id, null)`). Se ignora en silencio si la tarea no
> pertenece a ninguna lista — una sección solo existe dentro de una lista. Es
> el espejo, para tareas existentes, del `section` que ya admitía `add_task`
> al crear.
>
> **Añadida después una 6ª tool, `move_to_list`** (`kind: 'moveToList'`,
> payload `{ listId?: string | null } | { list?: string }`, lote 2 —
> identidad de listas): mueve una tarea EXISTENTE a otra lista de "Algún
> día", por `listId` ESTABLE (preferente, inmune a renames) o por `list`
> (nombre, se crea si no existe — mismo criterio que `list` en `add_task`);
> `listId: null` explícito la desvincula de su lista actual. Conserva la
> fecha de la tarea y limpia su sección (una sección solo existe dentro de
> su lista de origen). `list_tasks` expone el `listId` de cada lista en una
> leyenda al principio de su salida (ver `format.ts`), para que el modelo no
> tenga que inspeccionar tarea por tarea.
>
> **Añadida después una 7ª tool, `cancel_task`** (`kind: 'cancel'`, payload
> `{ cancelled: boolean }`): cancela una tarea EXISTENTE — "se cerró, pero no
> se hizo ni se hará" (`TasksFacade.cancel`, next-batch B), distinto de
> `complete_task` (que sí significa que se hizo). `cancelled: false` (default
> `true`) la restaura (`TasksFacade.uncancel`). Espejo exacto de
> `complete_task`/`kind: 'complete'`; la invariante de mutua exclusión con
> `completedAt` la aplica la propia fachada al drenar, el payload solo viaja
> el booleano.
>
> **Añadida después una 8ª tool, `add_subtask`** (`kind: 'addSubtask'`,
> payload `{ subtasks: string[] }`, saneado con `normalizeSubtasks` — mismo
> tope `MAX_SUBTASKS`/`MAX_SUBTASK_LEN` que `add_task.subtasks`): añade
> subtareas a una tarea EXISTENTE, reutilizando `task-ops.addSubtask` (misma
> función que ya usa la creación con `subtasks` en el payload). Anidamiento de
> UN nivel (docs/18-que-es-una-tarea.md §2.2/§6.2 — una subtarea no puede
> tener subtareas): si `taskId` ya es una subtarea (`parentId` definido), o si
> no está viva (archivada/borrada), el materializador (ambos gemelos,
> `inbound-materialize.ts`/`apply-inbound-mutation.ts`) descarta la mutación
> EN SILENCIO — mismo criterio tolerante que `set_section` sin lista. Espejo,
> para tareas existentes, del `subtasks` que ya admitía `add_task` al crear.
>
> **Fix 2026-07-18 (code-review bloqueante — idempotencia de creación):**
> `addSubtask` es ADITIVO (crea una subtarea nueva por texto), a diferencia
> del resto de `kind`s (asignaciones LWW) — reabrir-en-fallo (`docs/22-
> contrato-sync.md` §4: el batch se reabre si el flush/persist falla DESPUÉS
> de materializar en memoria) podía duplicar cada subtarea al reintentar,
> porque `task-ops.addSubtask` llamaba `crypto.randomUUID()` de nuevo por
> texto. Resuelto derivando un id ESTABLE por subtarea a partir del `id` de la
> propia fila de `inbound_mutations` (siempre estable entre reintentos) + su
> índice en el array (`deterministicUuid`, `$lib/deterministic-id.ts`) — mismo
> mecanismo que `clientTaskId` resuelve para la creación de una tarea entera.
> `task-ops.addSubtask` acepta ahora un `id` opcional y no-opea si ya existe
> (viva o tombstoned).
>
> **Fix 2026-07-17 (bug real, audit del uso del MCP):** las 7 tools de arriba
> encolaban una mutación sobre un `taskId` que NO existía (typo de UUID) y
> respondían "Encolado…" igual — la mutación se perdía en SILENCIO al drenar
> (ver la nota anti-IDOR arriba: el drenaje descarta cualquier `taskId` que no
> encuentre). `index.ts` ahora valida con `findTaskById` (`lumbre-client.ts`)
> ANTES de encolar, y da error si no existe — la EXISTENCIA sí se puede
> comprobar en el acto, a diferencia de si la mutación llegó a APLICARSE (eso
> sigue siendo asíncrono). Misma sesión: `list_tasks` exponía `notes`
> truncadas a ~240 caracteres sin forma de leerlas íntegras (rompía editarlas
> con `update_task`, que las REEMPLAZA enteras) y no exponía `createdAt` (útil
> para desempatar duplicados) — se añadió `fullNotes: true` a `list_tasks`
> (notas íntegras y verbatim para todo el lote) y una tool nueva,
> `get_task(taskId)` (la tarea entera, sin recortes), además de `createdAt`
> recortado a minuto en cada línea de `list_tasks`. Ver
> `format.ts`/`lumbre-client.ts`/`index.ts`.
>
> **Añadida después: lectura y completado de SUBTAREAS (esta tarea).**
> `add_subtask` ya podía CREARLAS, pero no había forma de LEERLAS ni
> marcarlas hechas — `list_tasks`/`GET /api/tasks` las excluye siempre (mismo
> criterio que las tareas de primer nivel exigen), así que su id era
> inalcanzable. Dos piezas:
>
> 1. **Lectura, extendiendo `get_task` (no un endpoint nuevo):** `GET /api/tasks`
>    gana un parámetro `?id=<uuid>` — lookup DIRECTO por id (ignora
>    scope/list/section/includeDone/limit), que busca entre TODAS las tareas
>    vivas del usuario, de primer nivel Y SUBTAREAS. Si la tarea resuelta es de
>    primer nivel, la respuesta trae un campo `subtasks: {id, content, done}[]`
>    (en orden) con su checklist — `get_task`/`formatTaskFull` lo vuelca como
>    una línea `[x]`/`[ ]` por subtarea, con su id. Se eligió extender
>    `get_task` en vez de un endpoint `GET /api/tasks/:id/subtasks` dedicado
>    porque el mismo lookup por `id` YA resuelve dos problemas a la vez: exponer
>    la checklist del padre Y encontrar el id de una subtarea suelta (necesario
>    para el punto 2) — un solo camino, no dos. `list_tasks`/scope-listado
>    SIGUE excluyendo subtareas exactamente igual que antes (no cambia nada
>    ahí); `findTaskById` (`lumbre-client.ts`) ahora pega directo a `?id=` en
>    vez de barrer `scope=all&limit=500` y filtrar en el cliente MCP — más
>    barato Y sin el tope de 500 tareas de primer nivel de antes.
> 2. **Completar, reutilizando `kind: 'complete'` (sin kind nuevo):** a nivel
>    de datos, `toggleTaskDone`/`task-ops.ts` YA funcionaba sobre el id de una
>    subtarea (no discrimina por `parentId` — solo `addSubtask`/
>    `setTaskRecurrence` sí lo hacen, por la regla de anidamiento de UN nivel).
>    El único bloqueo era `requireTaskExists` (MCP), que validaba contra
>    `findTaskById`, ciego a subtareas. Al resolverlo en el punto 1, la
>    comprobación de existencia ya alcanza subtareas SIN relajar nada (misma
>    autoridad: el store del usuario del token). Tool nueva, `complete_subtask
>    ({ subtaskId, done? })`, espejo exacto de `complete_task` pero encolando
>    sobre `subtaskId` — NO cascada nada sobre el padre (cada subtarea se
>    completa de forma independiente, igual que en la UI).
>
> **Añadida después una 10ª tool, `remove_section`** (`kind: 'removeSection'`,
> payload `{ sectionId: string }`, épico paridad UI↔MCP): borra una SECCIÓN de
> lista existente — la única tool/`kind` cuyo objetivo NO es una tarea. Como
> `{ taskId, kind, payload }` sigue siendo la forma fija del cuerpo (`taskId`
> validado como uuid ANTES de mirar `kind`), `remove_section` manda el
> `sectionId` en AMBOS sitios: en `taskId` (target genérico de la fila, ver el
> JSDoc de `inboundMutations` en `db/schema.ts`) y repetido en el payload por
> forma; el materializador usa SIEMPRE `payload.sectionId` como autoritativo.
> Espeja EXACTAMENTE `TasksFacade.removeSection` (`tasks.svelte.ts`, la
> operación que ya usa la UI para borrar una sección): sus tareas NUNCA se
> borran, solo pierden `sectionId` (quedan sueltas, "sin sección", DENTRO de
> la MISMA lista) y se les quita el marcador auto-tag (`#tag`/`@contexto`) de
> esa sección, si tenían. Ambos materializadores (`inbound-materialize.ts`/
> `apply-inbound-mutation.ts`) tratan este `kind` ANTES del guard "la tarea
> existe" (igual que `restore`), porque `item.taskId` nunca resuelve a una
> tarea aquí. Sin `list_sections` todavía (backlog: extensión MCP gestión de
> listas): el modelo resuelve el `sectionId` a partir del campo `sectionId` de
> una tarea que ya viva en esa sección (`list_tasks`/`get_task`).

Fase 1 (`add_task`/`list_tasks`) solo añade y lee. Fase 2 añadiría
`complete_task`, `update_task`, `reschedule_task` y `delete_task`: todas
requieren **mutar** una tarea que ya existe, identificada por `taskId`.

## Por qué no puede ir directo a Postgres

`tasks` en Postgres es una **proyección de solo lectura** del CRDT
(`MergeableStore` de TinyBase que vive en el cliente y se sincroniza por
WebSocket — ver `src/lib/server/sync/`). El servidor **nunca** escribe ahí
directamente fuera del persister del propio sync: si un endpoint hiciera
`UPDATE tasks SET done = true` a mano, esa escritura se perdería en cuanto
cualquier dispositivo con la app abierta volviera a sincronizar (el CRDT del
cliente seguiría creyendo que la tarea no está completada, y su próximo
`push` pisaría el cambio). Es exactamente el mismo motivo por el que
`/api/ingest` (Fase 1) NO inserta en `tasks`: encola en `inbound_tasks` y
deja que el cliente, que es la autoridad del CRDT, la materialice.

## Diseño: cola de mutaciones entrantes (análoga a `inbound_tasks`)

**Tabla nueva** `inbound_mutations` (nombre provisional), con el mismo patrón
de `inbound_tasks` (ver `src/lib/server/db/schema.ts` e
`src/lib/server/repos/inbound.ts`):

```
id           uuid PK
user_id      uuid FK → users
task_id      uuid            -- la tarea objetivo, SIN FK dura (mismo motivo
                              -- que time_reminder_sends/attachments: la tarea
                              -- vive en el CRDT, su proyección puede ir por
                              -- detrás de la mutación que la referencia)
kind         text            -- 'complete' | 'update' | 'reschedule' | 'delete'
payload      text            -- JSON con los campos según `kind` (ver abajo)
created_at   timestamptz
consumed_at  timestamptz null
```

Validación de propiedad (anti-IDOR) al ENCOLAR: antes de aceptar la mutación,
comprobar que `task_id` pertenece a `user_id` consultando la proyección
`tasks` (best-effort — puede ir desfasada, ver más abajo) O, más simple y
más correcto: no validar en el servidor en absoluto y dejar que el
**cliente** rechace silenciosamente cualquier `task_id` que no encuentre o
que no sea suyo al drenar (igual de seguro: el cliente ya solo puede tocar
SU store, filtrado por sesión/usuario — un `task_id` ajeno simplemente no
existirá en su CRDT y el drenaje lo ignora). Se recomienda esta segunda vía
por consistencia con `inbound_tasks` (que tampoco valida `list` contra nada
al escribir) y porque evita depender de una proyección que puede ir
desfasada respecto al CRDT real.

Payload por `kind`:

- `complete`: `{ done: boolean }`
- `update`: `{ content?: string; notes?: string; priority?: PriorityLevel|null }`
  (subconjunto acotado — NO todo lo que admite la fachada, para no reabrir
  aquí toda la superficie de edición)
- `reschedule`: `{ date: string | null }` (mover de día / a "Algún día")
- `delete`: `{}` (soft-delete, mismo criterio que `softDeleteTask`)
- `setSection`: `{ section: string | null }` (mover a una sección DENTRO de su
  propia lista, o `null` para quitarla de sección — añadida después, ver nota
  de cabecera)

## Endpoint de escritura

`POST /api/mutations` (o `/api/tasks/:id/mutations`), MISMA auth que
`/api/ingest`/`/api/tasks` (token de email-to-task). Cuerpo
`{ taskId, kind, payload }`. Solo inserta en `inbound_mutations`; responde
`{ ok: true }`. Rate-limit igual que los otros dos (`rateLimit('mutations:<token>', …)`).

## Cómo lo drenaría el cliente

Mismo mecanismo que `drainInboundTasks` en `src/routes/+page.svelte`
(`GET /api/inbound-tasks` al arrancar + al volver a foco, con el flag
`inboundDrainReady` para no correr antes de que las listas canónicas
asienten). Se añadiría un endpoint gemelo `GET /api/inbound-mutations` que
marca-y-devuelve (mismo patrón atómico que `drainInboundTasks` en
`src/lib/server/repos/inbound.ts`: `UPDATE … WHERE consumed_at IS NULL
RETURNING …`, idempotente bajo concurrencia). El cliente, al drenar, por
cada mutación pendiente:

1. Busca `taskId` en su CRDT (`facade.byId(taskId)` o equivalente). Si no
   existe (aún no ha sincronizado esa tarea, o no es del usuario, o fue
   borrada) → la descarta en silencio (ya se marcó consumida al drenarla,
   así que no se reintenta indefinidamente; se pierde esa mutación concreta,
   aceptable para Fase 2 igual que una tarea entrante sin lista resuelta hoy).
2. Si existe, aplica según `kind` vía la fachada (`facade.setDone`/
   `facade.updateContent`/`facade.setPriority`/`facade.move`/
   `facade.remove`, los mismos métodos que usa la UI).
3. El cambio se propaga por el WS de sync como cualquier otra mutación local.

## Las 4 tools que faltan

- `complete_task({ taskId, done? })` → encola `kind: 'complete'`.
- `update_task({ taskId, content?, notes?, priority? })` → encola `kind: 'update'`.
- `reschedule_task({ taskId, date })` → encola `kind: 'reschedule'` (`date:
  null` = mandar a "Algún día"/Bandeja).
- `delete_task({ taskId })` → encola `kind: 'delete'`.

Todas necesitan que el modelo conozca el `taskId` de antemano — lo normal es
que primero llame a `list_tasks` para resolverlo por contenido/fecha (no hay
búsqueda por texto en Fase 1; sería una quinta tool candidata,
`find_task({ query })`, fuera de alcance por ahora).

## Por qué no se implementa ya

No es instantáneo (depende de que un dispositivo sincronice, igual que
`add_task` hoy) y el usuario no tendría confirmación inmediata de que la
mutación se aplicó — para completar/borrar, que son ACCIONES DESTRUCTIVAS o
al menos con más consecuencia que "añadir", ese delay sin confirmación es
más delicado que en `add_task` (donde perder una tarea nueva en el peor caso
es solo "vuelve a pedirla"). Merece su propio diseño de UX (¿cómo confirma
el modelo que se aplicó? ¿se expone un estado "pendiente de sincronizar" vía
`list_tasks`?) antes de implementarlo — de ahí que Fase 1 se quede solo en
lectura + alta.
