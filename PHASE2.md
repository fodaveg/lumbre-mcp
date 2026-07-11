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
