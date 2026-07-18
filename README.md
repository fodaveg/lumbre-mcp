# lumbre-mcp

Conector [MCP](https://modelcontextprotocol.io) de **Lumbre** — deja que
Claude Code (u otro cliente MCP) añada, consulte y mute tareas de tu
planificador semanal desde una conversación.

Paquete Node/TS **independiente** del resto del repo (su propio
`package.json`/`tsconfig.json`); no comparte dependencias con la app SvelteKit.

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
  duplicados. Las notas salen truncadas a ~240 caracteres por defecto (para no
  inflar el contexto en listados largos); `fullNotes: true` las deja íntegras
  y sin colapsar saltos de línea para TODO el lote — útil si vas a reeditar
  una nota con `update_task` (que la REEMPLAZA entera) y el lote ya está
  acotado. Para una sola tarea concreta, mejor `get_task`.
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

## Compilar

```bash
cd mcp
npm install   # o pnpm install / yarn — es un paquete independiente
npm run build # → dist/index.js
```

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
			"args": ["/ruta/absoluta/a/lumbre/mcp/dist/index.js"],
			"env": {
				"LUMBRE_TOKEN": "tu-token-de-email-to-task",
				"LUMBRE_BASE_URL": "https://lumbre.pro"
			}
		}
	}
}
```

- `LUMBRE_TOKEN` es **obligatorio** — sin él, el proceso falla al arrancar con
  un error explicativo (nunca lo pidas al modelo ni lo hardcodees en el
  código: va en tu config LOCAL, fuera de cualquier repo).
- `LUMBRE_BASE_URL` es opcional (default `https://lumbre.pro`); cámbialo si
  usas un self-host distinto (p. ej. `http://localhost:5173` en dev, aunque
  ahí necesitarás que `/api/ingest`/`/api/tasks` sean alcanzables sin TLS).

También puedes probarlo suelto por stdio para depurar:

```bash
LUMBRE_TOKEN=tu-token node dist/index.js
```

(no imprime nada por stdout salvo el protocolo MCP; los errores de arranque
van a stderr).
