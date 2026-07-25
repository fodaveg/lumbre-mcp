# lumbre-mcp

Conector [MCP](https://modelcontextprotocol.io) de **Lumbre** — deja que
Claude Code (u otro cliente MCP) añada, consulte y mute tareas de tu
planificador semanal desde una conversación.

Paquete Node/TS **autónomo**: no comparte dependencias ni build con la app
SvelteKit de Lumbre; habla con ella solo por HTTP (`app.lumbre.pro`) usando el
token de email-to-task.

Vivía como `mcp/` dentro del repo de la app y se extrajo a este repo propio el
2026-07-25 con `git subtree split --prefix=mcp`, así que **conserva su
historia** (los primeros 23 commits llevan mensajes del monorepo, con `feat(mcp):`
y también de otros ámbitos que tocaron esta carpeta de paso).

## Qué hace (Fase 1 — crear/leer)

- `add_task` — añade una tarea nueva a Lumbre (vía `POST /api/ingest`, el
  mismo endpoint que usa email-to-task/Atajos de iOS). Se encola y se
  materializa en el planificador la próxima vez que un dispositivo tuyo
  sincronice; no es instantáneo si no hay ningún dispositivo online. Acepta
  `list` (nombre, se crea si no existe) o `listId` (id ESTABLE de la lista,
  preferente sobre `list`, inmune a renames — sácalo de `list_tasks`).
- `list_tasks` — lee tus tareas (vía `GET /api/tasks`, solo lectura). Acota
  por `scope`: `today` (default), `week`, `inbox`/`someday` (sin fecha),
  `overdue` o `all`; puede incluir completadas con `includeDone`. `list`
  filtra además por el nombre (case-insensitive) de una lista de "Algún
  día"/proyecto — sin `scope` explícito junto con `list`, el alcance temporal
  por defecto pasa a `all` (la mayoría de las tareas de una lista no tienen
  fecha). Un `list` que no existe (aún) devuelve una lista vacía, no un error.
  Si alguna tarea del lote tiene lista, la respuesta empieza con una leyenda
  (`· lista "Nombre" — listId: <uuid>`), una línea por lista distinta, para
  que puedas usar ese `listId` en `add_task`/`move_to_list` sin ambigüedad.
  Cada tarea muestra su `createdAt` (recortado a minuto) para desempatar
  duplicados. `notes` controla las notas de cada tarea, default `'auto'`
  (2026-07-25, sustituye al viejo truncado fijo a 240 chars): GARANTÍA — una
  nota sale ÍNTEGRA (si `content` lleva `@done`/`#done`, si `notesUpdatedAt`
  —la marca de última edición de la nota que expone la API, derivada del HLC
  de su celda CRDT— es POSTERIOR a la última vez que este MCP la mostró
  —huella local best-effort en
  `${XDG_STATE_HOME:-~/.local/state}/lumbre-mcp/notes-seen.json`, comparación
  EXACTA, sin ventana—, o si se tocó dentro de `notesRecentHours`, default 24h,
  cuando aún no hay huella —bootstrap, solo la 1ª vez que el MCP ve esa
  tarea—) o como marcador `✎N ↻DDmmm` con su tamaño en chars Y la fecha de la
  última edición (p. ej. `✎573 ↻24jul`) — NUNCA un texto recortado a medias
  (motivo: el preview de 240 truncaba justo la cola, que es donde David deja
  su feedback, y el resultado se leía como una nota completa; la fecha del
  marcador es lo que hace honesto el hueco que queda del bootstrap — permite
  juzgar si la nota se tocó DESPUÉS de cerrar la tarea incluso sin el texto).
  La cabecera del listado declara el criterio aplicado y los recuentos
  (`N íntegras (@done · cambiadas · tocadas <24h) · M con marcador`) y remite
  a `get_task` para las que quedaron sin leer. `'none'` omite las notas,
  `'preview'` es el recorte legado a ~240 chars colapsado a una línea, `'full'`
  las deja íntegras y sin colapsar saltos de línea para TODO el lote
  (`fullNotes: true` sigue siendo su alias) — útil si vas a reeditar una nota
  con `update_task` (que la REEMPLAZA entera) y el lote ya está acotado. Para
  una sola tarea concreta, mejor `get_task` (también íntegra siempre, y
  también registra la huella). `notesSince` (`"YYYY-MM-DD"` o ISO completo)
  es una consulta de precisión APARTE, SIN estado y con exclusividad de
  criterio: ignora `notes`/`fullNotes`, `@done`/`#done` y la huella local por
  completo — íntegra SOLO si `notesUpdatedAt` es igual o posterior a esa
  fecha, marcador el resto (incluida una tarea `@done` con nota vieja); la
  cabecera lo declara (`tocadas desde 2026-07-20`). Úsalo para "qué ha
  cambiado desde X", no para lectura normal (para eso, el default `'auto'`).
- `list_lists()` — enumera TODAS tus listas de "Algún día", con su recuento de
  tareas (vía `GET /api/tasks?includeLists=1`) — INCLUIDAS las que todavía no
  tienen ninguna tarea. A diferencia de `list_tasks({ list })`, que responde
  `[]` tanto si la lista no existe como si existe pero está vacía, `list_lists`
  distingue ambos casos: úsala para comprobar si una lista existe (p. ej. el
  usuario dice que la acaba de crear) o para resolver su `listId` sin
  depender de que ya tenga tareas. Sin parámetros.
- `get_task({ taskId })` — devuelve UNA tarea completa y sin recortar (notas
  íntegras y verbatim, `createdAt` sin recortar, lista/sección con sus ids). Si
  tiene subtareas (checklist, #17), las incluye con su id y su estado hecha/
  pendiente — es la ÚNICA forma de obtener el id de una subtarea (`list_tasks`
  nunca las lista), necesario para `complete_subtask`. Da error si el `taskId`
  no existe entre las tareas visibles del usuario.
- `refresh_sync()` — fuerza el flush del sync ANTES de leer (vía
  `POST /api/sync/flush`), para evitar que `list_tasks` devuelva un estado
  ligeramente rancio (el servidor guarda los cambios recibidos por WebSocket
  con un pequeño rebote/debounce). Útil justo antes de `list_tasks` cuando
  importa ver lo más reciente. **Límite**: solo garantiza lo que YA llegó al
  servidor por WebSocket — los cambios de un dispositivo offline que aún no
  los mandó no se pueden recuperar desde aquí.

## Qué hace (Fase 2 — mutar una tarea existente)

Igual de asíncrono/eventual que `add_task`: cada tool encola una mutación
(`POST /api/mutations`) que se aplica la próxima vez que un dispositivo tuyo
sincronice; **ninguna da confirmación inmediata** de que se aplicó de verdad
(usa `list_tasks` después para comprobarlo). Todas necesitan el `taskId` de la
tarea — resuélvelo antes con `list_tasks`. Diseño completo en `PHASE2.md`
(ya implementado; el documento se conserva como referencia del porqué).

Todas VALIDAN antes de encolar que el `taskId` EXISTE entre las tareas
visibles del usuario (una llamada extra a `GET /api/tasks`) y dan error si no
— la EXISTENCIA sí se puede comprobar en el acto, a diferencia de si la
mutación llegó a APLICARSE de verdad, que sigue siendo asíncrono. Antes de
este chequeo, un `taskId` mal transcrito se encolaba igual y la mutación se
perdía en silencio al drenar (`/api/mutations` no valida pertenencia
server-side, ver ese endpoint).

- `complete_task({ taskId, done? })` — marca hecha (`done` default `true`) o
  la desmarca (`done: false`).
- `cancel_task({ taskId, cancelled? })` — cancela la tarea (`cancelled`
  default `true`): equivalente a completarla, pero marcada como "no se hizo
  ni se hará" (distinto de `complete_task`). `cancelled: false` la restaura.
- `update_task({ taskId, content?, notes?, priority? })` — edita texto/notas/
  prioridad; solo toca los campos que envíes. `priority` es `'p1'..'p4'`
  (`p4` = quitar la prioridad).
- `reschedule_task({ taskId, date })` — mueve la tarea a otro día
  (`YYYY-MM-DD`), o a "Algún día"/Bandeja de entrada con `date: null`.
- `delete_task({ taskId })` — borra (soft-delete) la tarea. **Acción
  delicada**: sin confirmación inmediata ni deshacer desde la tool; confírmalo
  con el usuario antes de llamarla.
- `move_to_list({ taskId, listId?, list? })` — mueve la tarea a otra lista de
  "Algún día"/proyecto. `listId` (id ESTABLE, ver la leyenda de listas al
  principio de `list_tasks`) es preferente sobre `list` (nombre, se crea si
  no existe); `listId: null` desvincula la tarea de su lista actual. Conserva
  la fecha de la tarea y limpia su sección.
- `add_subtask({ taskId, subtasks })` — añade una o más subtareas (checklist,
  #17) a `taskId`. Anidamiento de UN nivel: si `taskId` ya es una subtarea, se
  descarta en silencio (no hay forma de confirmarlo desde la tool; comprueba
  con `list_tasks`). Para crear una tarea CON subtareas de una vez, usa
  `add_task` con `subtasks` en el payload.
- `complete_subtask({ subtaskId, done? })` — marca hecha (`done` default
  `true`) o desmarca (`done: false`) una SUBTAREA existente, por su id (ver
  `get_task` de su tarea padre). Mismo mecanismo que `complete_task`: no
  cascada nada sobre la tarea padre.
- `remove_section({ sectionId })` — borra (tombstone) una sección/heading
  dentro de una lista de "Algún día"/proyecto. Sus tareas NUNCA se borran:
  solo pierden la sección (quedan sueltas, "sin sección", dentro de la MISMA
  lista). Sin `list_sections` todavía: resuelve el `sectionId` desde el campo
  `sectionId` de una tarea que ya viva ahí (`list_tasks`/`get_task`).

### Gestión de listas de "Algún día" (paridad UI↔MCP)

Mismo criterio async/eventual que el resto de Fase 2. Sin una tool
`list_lists` todavía: resuelve un `listId` existente con el que devolvió
`create_list`, o con el campo `somedayListId` de una tarea que ya viva en esa
lista (`list_tasks`/`get_task`).

- `create_list({ name, color?, icon? })` — crea una lista/proyecto nueva;
  devuelve su `listId` (úsalo luego en `add_task`, `move_to_list` o
  `nest_list`). `color` acepta uno de `red|amber|green|blue|violet|pink` o un
  hex `#rrggbb`; sin color/icono por defecto.
- `nest_list({ listId, parentId })` — fija el padre de una lista EXISTENTE (la
  anida), o la deja de primer nivel con `parentId: null` (desanidar). Un
  anidado rechazado (ciclo, auto-anidado, o la Bandeja de entrada, que nunca
  es anidable) se descarta en silencio.
- `rename_list({ listId, name })` — renombra una lista EXISTENTE; su identidad
  y sus tareas no cambian.
- `remove_list({ listId })` — borra una lista EXISTENTE. Sus tareas NUNCA se
  pierden (las sin fecha se reasignan a otra lista viva; las "prestadas" con
  fecha quedan como tarea de día normal); sus listas hijas pasan a primer
  nivel. No aplica a la última lista viva ni a la Bandeja de entrada canónica
  (se ignora en silencio en ambos casos).

### Ejecutar varias operaciones a la vez (`mutate_tasks`)

Vía PREFERENTE en cuanto haya más de una operación seguida (crear y/o
mutar): resuelve TODAS las existencias de tarea del lote en una sola
comprobación y las encola en una sola petición (`ops`, máx. 200), en vez de
una tool call por operación. Las tools individuales de arriba SIGUEN
existiendo para una operación suelta. Éxito PARCIAL: una op inválida
(`taskId` inexistente, subtarea donde no aplica, forma equivocada para esa
`op`) no impide las demás — el resultado detalla, por posición 0-indexada en
`ops`, qué falló y por qué, y el `id` de cada una que sí se encoló (el de un
`create_list` es su `listId`; el de un `add_task`, su `taskId` nuevo).

Cada elemento de `ops` es `{ op: "<nombre>", ...campos }`, con el mismo
significado que la tool individual equivalente: `op:"add_task"` = `add_task`,
`op:"complete"` = `complete_task`, `op:"cancel"` = `cancel_task`,
`op:"update"` = `update_task`, `op:"reschedule"` = `reschedule_task`,
`op:"delete"` = `delete_task`, `op:"set_section"` = `set_section`,
`op:"move_to_list"` = `move_to_list`, `op:"add_subtask"` = `add_subtask`,
`op:"complete_subtask"` = `complete_subtask`, `op:"remove_section"` =
`remove_section`, `op:"create_list"` = `create_list`, `op:"nest_list"` =
`nest_list`, `op:"rename_list"` = `rename_list`, `op:"remove_list"` =
`remove_list`. El schema que expone la tool es deliberadamente laxo (los 21
campos que usan las 15 ops, todos opcionales); el contrato real por-op
(`*` = obligatorio) es:

```
add_task: text* [list|listId, section, priority, date, deadline, time, recurrence, subtasks, notes]
complete: taskId* [done]
cancel: taskId* [cancelled]
update: taskId*, ≥1 de [content, notes, priority, time]
reschedule: taskId*, date*
delete: taskId*
set_section: taskId*, section*
move_to_list: taskId*, uno de [listId, list]
add_subtask: taskId*, subtasks*
complete_subtask: subtaskId* [done]
remove_section: sectionId*
create_list: name* [color, icon, listId]
nest_list: listId*, parentId*
rename_list: listId*, name*
remove_list: listId*
```

Un elemento que no encaja en la forma de SU `op` (campo obligatorio ausente,
o un campo válido en general pero ajeno a esa op — p. ej.
`{ op: "complete", date: "2026-01-01" }`) se rechaza igual que antes, solo
que ahora entra en el mismo informe de éxito parcial que un `taskId`
inexistente, en vez de tumbar la llamada entera.

**Encadenar dentro del MISMO lote**: la única op que crea algo cuyo id
puedas necesitar referenciar EN OTRA op del mismo `mutate_tasks` es
`create_list` — dale tú mismo un `listId` (uuid v4) al crearla y úsalo en el
`move_to_list`/`nest_list` que la targetee, en vez de esperar a la respuesta
(el id de un `add_task` lo asigna el servidor y solo se conoce DESPUÉS, no se
puede referenciar dentro de la misma llamada).

## Compilar

```bash
git clone git@github.com:fodaveg/lumbre-mcp.git
cd lumbre-mcp
npm install   # o pnpm install / yarn — es un paquete independiente
npm run build # → dist/index.js
```

Requiere **Node ≥ 22**. Con Node 24 el toolchain revienta
(`ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`); si tienes varias versiones,
apunta el `command` de la config al binario de Node 22 en vez de al `node`
del PATH (ver más abajo).

## Configurar en Claude Code

Necesitas tu **token de email-to-task**: en la app de Lumbre, Ajustes →
sección de email entrante (el mismo token que usa `task+<token>@…` y
`/api/ingest`; si aún no lo tienes, la app lo genera la primera vez que
entras a esa sección).

Añade el servidor a tu configuración de MCP de Claude Code (por ejemplo
`~/.claude.json` o la config de proyecto, según cómo gestiones tus MCP
servers), apuntando `command`/`args` al `dist/index.js` compilado arriba:

```json
{
	"mcpServers": {
		"lumbre": {
			"command": "node",
			"args": ["/ruta/absoluta/a/lumbre-mcp/dist/index.js"],
			"env": {
				"LUMBRE_TOKEN": "tu-token-de-email-to-task",
				"LUMBRE_BASE_URL": "https://app.lumbre.pro"
			}
		}
	}
}
```

- `LUMBRE_TOKEN` es **obligatorio** — sin él, el proceso falla al arrancar con
  un error explicativo (nunca lo pidas al modelo ni lo hardcodees en el
  código: va en tu config LOCAL, fuera de cualquier repo).
- `LUMBRE_BASE_URL` es opcional (default `https://app.lumbre.pro`). **No lo
  apuntes al viejo `lumbre.pro`**: desde la fase (c) del renombrado ese host
  responde 302 al nuevo, y `fetch` **descarta la cabecera `Authorization` al
  seguir una redirección cross-origin** — daría un 401 sin pista de la causa.
  Cámbialo solo si
  usas un self-host distinto (p. ej. `http://localhost:5173` en dev, aunque
  ahí necesitarás que `/api/ingest`/`/api/tasks` sean alcanzables sin TLS).

También puedes probarlo suelto por stdio para depurar:

```bash
LUMBRE_TOKEN=tu-token node dist/index.js
```

(no imprime nada por stdout salvo el protocolo MCP; los errores de arranque
van a stderr).
