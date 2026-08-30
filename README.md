# lumbre-mcp

Conector [MCP](https://modelcontextprotocol.io) de **Lumbre** — deja que
Codex, Claude y otros clientes MCP añadan, consulten y muten tareas desde una
conversación.

Paquete Node/TS **autónomo**: no comparte dependencias ni build con la app
SvelteKit de Lumbre. El servicio remoto usa OAuth 2.1 y consentimiento en la
sesión web de `app.lumbre.pro`; no hay que pegar un token en la URL.

Vivía como `mcp/` dentro del repo de la app y se extrajo a este repo propio el
2026-07-25 con `git subtree split --prefix=mcp`, así que **conserva su
historia** (los primeros 23 commits llevan mensajes del monorepo, con `feat(mcp):`
y también de otros ámbitos que tocaron esta carpeta de paso).

## Conectar el MCP remoto

La URL pública es `https://mcp.lumbre.pro/mcp`. El cliente abre el navegador y
redirige a Lumbre para iniciar sesión y autorizar la conexión.

En Codex:

```bash
codex mcp add lumbre --url https://mcp.lumbre.pro/mcp
codex mcp login lumbre
```

En claude.ai web o móvil, añade un conector personalizado con esa misma URL. No
añadas un bearer ni un token en el path.

## Instalar la skill opcional

La skill pública multimodo vive en `skills/lumbre/`. No es necesaria para usar
el MCP, pero añade reglas seguras de lectura, gestión cotidiana, backlog y el
flujo opcional de desarrollo/release. Se instala desde este repositorio con
[`skills`](https://skills.sh), que mantiene una única instalación global y la
hace visible para los clientes seleccionados:

`npx` viene incluido con `npm`, que se instala junto con Node.js. Si todavía no
lo tienes, instala Node.js con el gestor de paquetes de tu sistema:

```bash
# macOS
brew install node

# Fedora
sudo dnf install nodejs
```

Comprueba el requisito antes de instalar la skill:

```bash
node --version
npm --version
npx --version
```

```bash
npx --yes skills add fodaveg/lumbre-mcp -g -y \
  --skill lumbre \
  --agent codex claude-code
```

Verifica primero la copia global gestionada y el enlace de Claude Code:

```bash
test -f ~/.agents/skills/lumbre/SKILL.md
test -f ~/.claude/skills/lumbre/SKILL.md
```

Codex actual resuelve la copia global de `~/.agents/skills`; no hace falta crear
otra copia en `~/.codex/skills`. El lockfile de `skills` acredita qué se instaló,
pero no demuestra que cada runtime la haya descubierto: abre una conversación
nueva y pide explícitamente usar `lumbre` en Codex y Claude Code. Si uno no la
resuelve, actualiza ese runtime y repite la instalación. Como último recurso para un
Codex antiguo, crea un enlace a la copia canónica, nunca una segunda copia:

```bash
mkdir -p "$HOME/.codex/skills"
if [ -e "$HOME/.codex/skills/lumbre" ] && [ ! -L "$HOME/.codex/skills/lumbre" ]; then
  echo "No se reemplaza una instalación real de lumbre" >&2
  exit 1
fi
ln -sfn ../../.agents/skills/lumbre "$HOME/.codex/skills/lumbre"
test -f "$HOME/.codex/skills/lumbre/SKILL.md"
```

Codex actual no necesita ese enlace. El guardado previo evita sobreescribir una
instalación real y el comando es idempotente si ya existe el enlace.

Para traer versiones posteriores:

```bash
npx --yes skills update lumbre -g -y
```

La distribución soportada sigue la rama `main` de este repositorio; no se
publican tags de versión de la skill. `skills` registra el origen y el hash
instalado en su lockfile para poder actualizar esa única copia gestionada.

La skill y el MCP se instalan por separado: este paso aporta las instrucciones
de trabajo al agente, pero no conecta Lumbre. Para autorizar el MCP remoto,
completa antes los pasos de [Conectar el MCP remoto](#conectar-el-mcp-remoto).

La instalación pública es ligera: incluye el router, seis referencias operativas,
metadata y una validación estructural pequeña. El historial, los bundles y el
oráculo del piloto permanecen en `tests/skill-lumbre/` dentro del repositorio y no
se copian a los runtimes. No se ha medido que Claude cargara accidentalmente esos
artefactos; separarlos elimina el riesgo de enrutamiento y reduce el paquete sin
presentar esa hipótesis como un fallo observado.

## Qué hace (Fase 1 — crear/leer)

- `add_task` — añade una tarea nueva a Lumbre (vía `POST /api/ingest`, el
  mismo endpoint que usa email-to-task/Atajos de iOS). Se encola y se
  materializa en el planificador la próxima vez que un dispositivo tuyo
  sincronice; no es instantáneo si no hay ningún dispositivo online. Acepta
  `list` (nombre, se crea si no existe) o `listId` (id ESTABLE de la lista,
  preferente sobre `list`, inmune a renames — sácalo de `list_tasks`).
- `list_tasks` — lee tus tareas (vía `GET /api/tasks`, solo lectura). Acota
  por `scope`: `today` (default), `week`, `upcoming`, `inbox`/`someday` (sin
  fecha), `overdue` o `all`; puede incluir completadas con `includeDone`.
  `includeArchived: true` amplía el mismo filtro a tareas archivadas — se
  combina con `includeDone` y el resto de parámetros, y cada archivada se
  identifica con su fecha de archivo. El servidor exige el literal booleano
  `true`; el MCP lo serializa como `includeArchived=true`.
  `upcoming` es la ventana RODANTE de `days` días **contando hoy** (default 7,
  máximo 14) y existe porque `week` es la semana de CALENDARIO: un domingo
  —o un viernes— `week` apenas tiene nada por delante, así que responde a
  «qué queda de esta semana», no a «qué viene». `days` con cualquier otro
  scope es un error del servidor (400), no un parámetro que se ignora. (Ojo:
  `upcoming` lo sirve la APP; hasta que la versión con ese scope esté
  desplegada, pedirlo responde `scope inválido` — comprobado contra prod el
  2026-07-26.) `list`
  filtra además por el nombre (case-insensitive) de una lista de "Algún
  día"/proyecto — sin `scope` explícito junto con `list`, el alcance temporal
  por defecto pasa a `all` (la mayoría de las tareas de una lista no tienen
  fecha). Un `list` que no existe (aún) devuelve una lista vacía, no un error.
  Si alguna tarea del lote tiene lista, la respuesta empieza con una leyenda
  (`· lista "Nombre" — listId: <uuid>`), una línea por lista distinta, para
  que puedas usar ese `listId` en `add_task` o en `mutate_tasks` (`op:
  "move_to_list"`) sin ambigüedad.
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
  Internamente, `'auto'` pide las notas EN DOS FASES (perf, 2026-08-25 —
  medido contra datos reales: de un `scope=all` de 542 KB, 307 KB —56,6%—
  eran texto de notas que la mayoría de las veces se tiraban en local): fase 1,
  `GET /api/tasks?notes=length` (cada tarea trae `notesLength` en vez del
  texto); fase 2, SOLO para las que la decisión marca íntegras, `GET
  /api/tasks?ids=<esos ids>&notes=full` para traer su texto (trocea en lotes
  de 200 ids si hace falta). Un servidor que aún no conozca `notes=`/
  `notesLength` (versión previa a esta feature) ignora el parámetro y devuelve
  las notas enteras en la fase 1 — el MCP lo detecta (ninguna tarea trae la
  propiedad `notesLength`) y NO manda la fase 2: mismo resultado, sin el
  ahorro, coste CERO peticiones extra. Si la fase 2 falla (red, 5xx) o
  devuelve menos tareas de las pedidas (p. ej. una se borró entre medias), esa
  nota se repliega a marcador — nunca a medias ni vacía haciéndose pasar por
  "sin nota" (misma garantía de arriba). El resultado observable es idéntico
  al de una sola petición; solo cambia cuántos bytes viajan.
- `list_lists()` — enumera TODAS tus listas de "Algún día", con su recuento de
  tareas (vía `GET /api/tasks?includeLists=1`) — INCLUIDAS las que todavía no
  tienen ninguna tarea. A diferencia de `list_tasks({ list })`, que responde
  `[]` tanto si la lista no existe como si existe pero está vacía, `list_lists`
  distingue ambos casos: úsala para comprobar si una lista existe (p. ej. el
  usuario dice que la acaba de crear) o para resolver su `listId` sin
  depender de que ya tenga tareas. Sin parámetros.
- `get_task({ taskId, includeArchived? })` — devuelve UNA tarea completa y sin
  recortar (notas íntegras y verbatim, `createdAt` sin recortar, lista/sección
  con sus ids). `includeArchived: true` permite recuperarla aunque esté
  archivada. Si
  tiene subtareas (checklist, #17), las incluye con su id y su estado hecha/
  pendiente — es la ÚNICA forma de obtener el id de una subtarea (`list_tasks`
  nunca las lista), necesario para `complete_subtask`. Da error si el `taskId`
  no existe entre las tareas visibles del usuario para ese alcance.
- `read_attachment({ attachment_id })` — descarga los BYTES de un adjunto de
  una tarea (vía `GET /api/attachments/:id`, sácalo del campo `attachments`
  de `list_tasks`/`get_task`). Si es una imagen, se devuelve para verla
  directamente; para cualquier otro tipo (PDF, etc.) solo trae su metadata —
  no hay forma de leer su contenido con esta tool.
- `add_attachment({ taskId, file_path?, content_base64?, filename? })` — sube
  un fichero y lo deja adjunto y **enlazado** a una tarea (vía
  `POST /api/attachments?taskId=`). Acepta **exactamente una** de dos vías,
  según DÓNDE corre este conector:
  - `file_path` — ruta LOCAL, absoluta o `~/…` (una relativa se rechaza), tope
    **25 MB**. Solo funciona si el conector corre en TU máquina (stdio local,
    ver "Configurar en Claude Code" más abajo): `resolveLocalPath`/`fs.stat`
    se resuelven contra el disco de quien ejecuta el proceso. Contra el
    **conector remoto** (`mcp.lumbre.pro`, ver más abajo) esta vía no funciona
    — el proceso corre en el VPS de Lumbre, no en tu Mac — y la tool lo dice
    con un error explícito (nunca un "no existe el fichero", que sonaría a
    error tuyo cuando el problema es de topología) que incluye el comando
    para enchufar el conector local dedicado a adjuntos.
  - `content_base64` — los bytes en base64, funciona en CUALQUIER conector
    (local o remoto). Pensado **solo para ficheros de unos KB** (un `.txt`
    corto, un `.log`): ese argumento lo emite el MODELO dentro de la tool
    call, y base64 infla ~33% — 480 KB de captura real son ~640 KB en base64,
    ~160k tokens, inviable. Tope **1 MB** decodificado (mucho más bajo que
    los 25 MB de `file_path`, a propósito). `filename` es OBLIGATORIO con
    esta vía (no hay ruta de la que sacar un basename).

  `filename` es opcional con `file_path` (por defecto su basename) y
  obligatorio con `content_base64`. Tope de tamaño comprobado en el cliente
  (mensaje con el tamaño real) y de forma AUTORITATIVA en el servidor. No
  admite subtareas. A diferencia de TODO lo demás en Fase 1/Fase 2 (que se
  encola), **esta vía es SÍNCRONA**: el servidor escribe la metadata al CRDT
  antes de responder 200, así que el adjunto ya está enlazado y visible
  cuando la tool contesta — no hace falta esperar a ningún sync.

  El `Content-Type` que sale por el cable es SIEMPRE `application/octet-stream`
  (el mime real viaja aparte, en `x-lumbre-content-type`) — así que un
  `.txt`/`.log` conserva su mime real de cara al servidor sin arriesgarse al
  **403 mudo** que dispara `is_form_content_type` de SvelteKit cuando una
  petición sin `Origin` (el caso de este MCP, que corre fuera del navegador)
  trae uno de sus cuatro Content-Type de formulario.
- `refresh_sync()` — fuerza el flush del sync (vía `POST /api/sync/flush`),
  para que el servidor persista los cambios que recibió por WebSocket y que
  aún tiene en un pequeño rebote/debounce. Las lecturas del MCP van por la API
  REST, que lee lo ya persistido, así que sin ese flush un cambio recién
  llegado por WebSocket no se ve.
  **Cuándo hace falta y cuándo NO** (medido el 27 ago 2026, ver el JSDoc de la
  tool en `src/index.ts`): NO hace falta detrás de una mutación hecha con este
  mismo MCP. Cinco corridas contra el servidor real, por los dos caminos de
  escritura (`add_task` → `POST /api/ingest` y `mutate_tasks` →
  `POST /api/batch`), y en las cinco la tarea recién creada salía ya en el
  `list_tasks` inmediatamente siguiente sin ningún flush por medio. SÍ hace
  falta cuando el cambio lo hizo el usuario FUERA del MCP (su app, su móvil).
  **De qué depende eso**, que no es lo que parece: no de que las escrituras
  vayan por REST, sino de que los handlers de escritura del repo principal
  llamen a `runHeadlessDrain` de forma SÍNCRONA antes de responder. Si eso se
  mueve a segundo plano, esta sección pasa a mentir y ningún test de este repo
  se entera.
  **Límite**: solo garantiza lo que YA llegó al servidor por WebSocket — los
  cambios de un dispositivo offline que aún no los mandó no se pueden
  recuperar desde aquí.

### Referencias a otras tareas/listas, resueltas EN VIVO

Una nota (o el texto de una tarea) puede llevar referencias
`[[task:ID|Etiqueta]]` / `[[list:ID|Etiqueta]]`, que la app pinta como chips
resolviéndolas contra el estado real en cada render. El MCP hacía lo contrario:
reenviaba la **etiqueta congelada** del momento en que se creó el enlace, así
que una tarea renombrada, completada o borrada seguía leyéndose con su texto
viejo — y una referencia rota era **indistinguible** de una viva. Desde
2026-07-26, `list_tasks` y `get_task` las resuelven:

```
→tarea[pendiente] "Título ACTUAL" ✎573 ↻24jul id:<uuid>
→tarea[hecha] "Título ACTUAL" id:<uuid>
→tarea[ROTA] id:<uuid>
→lista "Nombre ACTUAL" id:<uuid>
```

- Manda el **id**, no la etiqueta: si el título cambió, se enseña el ACTUAL (la
  etiqueta guardada es una copia caducada y no se pinta nunca).
- Una referencia cuyo destino ya no resuelve se **declara ROTA** con su id
  (borrada o archivada), en vez de enseñar un texto que ya no corresponde a
  nada. El id sigue visible siempre, para poder actuar sobre esa tarea sin una
  segunda llamada.
- El marcador `✎N ↻fecha` (el mismo de las notas sin leer) dice si la tarea
  referenciada **tiene nota** y de qué tamaño/fecha: una referencia es contexto
  que conviene ir a buscar, y así se decide con datos si toca un `get_task`. La
  nota referenciada **no** se vuelca en el listado (sería recursivo, dispara el
  tamaño de la respuesta y hay ciclos posibles: A→B y B→A).
- Coste: **cero** peticiones extra si el lote no tiene referencias; UNA
  (`GET /api/tasks?ids=`, con todos los ids de golpe, tope 200) si las tiene; y
  una segunda (`?includeLists=1`) solo si además hay referencias a listas. Nunca
  una petición por referencia. Si esa llamada falla, la referencia sale como
  `sin resolver` (nunca como rota) y el listado se devuelve igual.
- La cabecera del listado resume lo que hay (`refs: 2 vivas · 1 con nota ✎ …`).
- Límite conocido: la API no expone `cancelledAt`, así que una tarea CANCELADA
  llega como `done: true` y se lee «hecha». El render ya sabe pintar
  `→tarea[cancelada]` en cuanto `GET /api/tasks` exponga ese campo.

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

Sin tool suelta desde el 2026-08-27 (podadas `create_list`/`nest_list`/
`rename_list`/`remove_list`/`move_to_list`: cero o casi cero uso real medido
—19 llamadas/mes en total, 12 de ellas `move_to_list`— y `mutate_tasks` ya
las cubría entero, ver "Ejecutar varias operaciones a la vez" más abajo).
Mueve una tarea a otra lista, crea/anida/renombra/borra una lista con
`mutate_tasks({ ops: [{ op: "move_to_list"|"create_list"|"nest_list"|
"rename_list"|"remove_list", ... }] })` — un solo elemento en `ops` para una
operación suelta. Mismo criterio async/eventual que el resto de Fase 2.

- `move_to_list`: `taskId*`, uno de [`listId`, `list`]. `listId` (id ESTABLE,
  ver la leyenda de listas al principio de `list_tasks`) es preferente sobre
  `list` (nombre, se crea si no existe); `listId: null` desvincula la tarea
  de su lista actual. Conserva la fecha de la tarea y limpia su sección.
- `create_list`: `name*` [`color`, `icon`, `listId`] — crea una lista/proyecto
  nueva; el resultado trae el `listId` generado (o el que tú le hayas dado,
  ver "Encadenar dentro del MISMO lote" más abajo). `color` acepta uno de
  `red|amber|green|blue|violet|pink` o un hex `#rrggbb`; sin color/icono por
  defecto.
- `nest_list`: `listId*`, `parentId*` — fija el padre de una lista EXISTENTE
  (la anida), o la deja de primer nivel con `parentId: null` (desanidar). Un
  anidado rechazado (ciclo, auto-anidado, o la Bandeja de entrada, que nunca
  es anidable) se descarta en silencio.
- `rename_list`: `listId*`, `name*` — renombra una lista EXISTENTE; su
  identidad y sus tareas no cambian.
- `remove_list`: `listId*` — borra una lista EXISTENTE. Sus tareas NUNCA se
  pierden (las sin fecha se reasignan a otra lista viva; las "prestadas" con
  fecha quedan como tarea de día normal); sus listas hijas pasan a primer
  nivel. No aplica a la última lista viva ni a la Bandeja de entrada canónica
  (se ignora en silencio en ambos casos).

### Registro del día (BRL — add-on experimental)

El BRL es el diario del día, y **no son tareas**: una entrada es un apunte de lo
que pasó (`-` nota) o una reflexión (`=` pensamiento). No se completan, no se
reprograman y no salen en `list_tasks`. Requiere que el add-on esté encendido en
la cuenta (Ajustes de Lumbre); apagado, las dos tools fallan con un error
explícito y no se encola nada. Mismo criterio async/eventual que el resto de la
Fase 2.

- `list_brl_entries({ date })` — entradas de ese día con su **id** y su hora
  (`--:--` = sin hora: una entrada nace sin hora si se apunta en un día que no
  es hoy). Es la única forma de conseguir el id que pide `mutate_brl` (ops
  `update`/`delete`): la nota completa en Markdown que sirve
  `GET /api/brl/:date` NO lleva ids a propósito (es la nota que lee el
  usuario, no un formato de máquina).
- `mutate_brl({ ops })` — añade, reescribe o borra una o varias entradas de
  golpe (`ops`, máx. 200; sustituye a `add_brl_entry`/`update_brl_entry`/
  `delete_brl_entry`, podadas el 2026-08-27, cero llamadas medidas en un mes).
  Cada elemento es `{ op: "add"|"update"|"delete", date, ... }`:
  - `add`: `date*`, `text*` [`kind`, `time`] — apunta una entrada nueva.
    `kind: "thought"` la marca como pensamiento (`=`); por defecto es nota
    (`-`). El `text` va SIN el marcador. `time` ("HH:MM", 24h) es para volcar
    apuntes tomados en papel a la hora que de verdad marcaban; sin ella, la
    pone el servidor.
  - `update`: `date*`, `entryId*`, `text*` [`kind`] — REEMPLAZA el texto
    entero de una entrada; `kind` cambia además su tipo (nota ↔ pensamiento).
  - `delete`: `date*`, `entryId*` — borra una entrada.

  `update`/`delete` piden `date` **además** del id, y no es redundante: una
  entrada solo se puede buscar por día (no hay lookup por id suelto como el
  `GET /api/tasks?id=` de las tareas), y con la fecha delante `mutate_brl`
  comprueba que la entrada EXISTE antes de encolar nada. Sin eso, un id mal
  transcrito se encola igual y se pierde en silencio mientras la tool
  contesta «Encolado…» — el mismo fallo que ya mordió con las tareas y que
  `requireTaskExists` cierra para ellas. La fecha viene en la misma llamada a
  `list_brl_entries` de la que sale el id. Éxito PARCIAL igual que
  `mutate_tasks`: una op inválida no bloquea las demás.

### Ejecutar varias operaciones a la vez (`mutate_tasks`)

Vía PREFERENTE en cuanto haya más de una operación seguida (crear y/o
mutar): resuelve TODAS las existencias de tarea del lote en una sola
comprobación y las encola en una sola petición (`ops`, máx. 200), en vez de
una tool call por operación. La mayoría de las tools individuales de arriba
SIGUEN existiendo para una operación suelta — excepto las 5 ops de LISTA
(`create_list`/`nest_list`/`rename_list`/`remove_list`/`move_to_list`), sin
tool suelta desde el 2026-08-27: `mutate_tasks` es su ÚNICA vía. Éxito
PARCIAL: una op inválida (`taskId` inexistente, subtarea donde no aplica,
forma equivocada para esa `op`) no impide las demás — el resultado detalla,
por posición 0-indexada en `ops`, qué falló y por qué, y el `id` de cada una
que sí se encoló (el de un `create_list` es su `listId`; el de un `add_task`,
su `taskId` nuevo).

Cada elemento de `ops` es `{ op: "<nombre>", ...campos }`, con el mismo
significado que la tool individual equivalente cuando existe: `op:"add_task"`
= `add_task`, `op:"complete"` = `complete_task`, `op:"cancel"` =
`cancel_task`, `op:"update"` = `update_task`, `op:"reschedule"` =
`reschedule_task`, `op:"delete"` = `delete_task`, `op:"set_section"` =
`set_section`, `op:"add_subtask"` = `add_subtask`, `op:"complete_subtask"` =
`complete_subtask`, `op:"remove_section"` = `remove_section`. Las 5 restantes
(`op:"move_to_list"`, `op:"create_list"`, `op:"nest_list"`,
`op:"rename_list"`, `op:"remove_list"`) son gestión de listas de "Algún día"
(paridad UI↔MCP) y ya NO tienen tool suelta equivalente — ver esa sección más
arriba para el detalle campo a campo de cada una. El schema que expone la
tool es deliberadamente laxo (los 21 campos que usan las 15 ops, todos
opcionales); el contrato real por-op (`*` = obligatorio) es:

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

### Actualizar sin toolchain

Desde este commit `dist/` va versionado en el repo, así que en una máquina
que ya tiene el clon (y ya apunta su config MCP a `dist/index.js`) actualizar
es solo:

```bash
git pull
```

sin `npm install` ni `npm run build` de por medio. Si en vez de apuntar la
config al `dist/` del clon lo instalaste global, actualiza con `npm i -g .`
después del `git pull` para que se recoja el `dist/` nuevo. Aviso: quien
toque `src/` tiene que recompilar (`npm run build`) y commitear `dist/` en
el MISMO commit, porque de momento nada lo vigila automáticamente.

## Conector stdio local (compatibilidad y adjuntos)

Esta vía local es opcional. Úsala para desarrollo, compatibilidad o para adjuntar
ficheros grandes desde el disco local. Necesitas tu **token de email-to-task**:
en la app de Lumbre, Ajustes →
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

## Transporte HTTP remoto (`mcp.lumbre.pro`)

Además del stdio de arriba (un proceso local por cliente, token fijo por
`env`), este repo también sirve un transporte Streamable HTTP compartido en
`https://mcp.lumbre.pro/mcp` (`src/http.ts`, desplegado — ver
`deploy/README-deploy.md`). El transporte MCP es **stateless** (un servidor y
un transporte nuevos por petición), pero la autorización OAuth sí conserva
los grants necesarios en el volumen de estado. El bearer OAuth nunca se manda
a Lumbre: el relé lo resuelve localmente al token upstream cifrado.

### Autenticación — OAuth 2.1 con consentimiento en Lumbre

El navegador no recibe ni solicita ningún token. Tras validar OAuth/CIMD/PKCE,
el relé abre por backchannel una autorización en `app.lumbre.pro`; Lumbre usa
la sesión web de la persona para login y consentimiento. El callback público
solo devuelve `request` y `decision`. La credencial dedicada se canjea de
servidor a servidor, se cifra antes de persistir y nunca aparece en HTML,
`Location`, query ni logs.

| Forma | Cómo | Para qué cliente |
|---|---|---|
| OAuth 2.1 | Añadir solo `https://mcp.lumbre.pro/mcp`; Authorization Code + PKCE S256 | Codex y claude.ai web/móvil |
| Bearer directo (compatibilidad temporal) | `Authorization: Bearer <token-de-Lumbre>` contra `POST /mcp` | Clientes heredados |
| Path (compatibilidad temporal) | `POST /mcp/<token-de-Lumbre>` | Conectores antiguos de claude.ai; no usar en configuraciones nuevas |

En Codex y claude.ai se configura solo `https://mcp.lumbre.pro/mcp`. El relé cifra la
credencial upstream con AES-256-GCM y la asocia a access/refresh tokens opacos.
Antes de emitir o rotar refresh consulta `introspect`; revocación, replay y
límites de tombstones eliminan la familia local y dejan una revocación cifrada
en un outbox durable hasta que Lumbre confirma el ACK idempotente. Los access
tokens duran una hora. Cada familia refresh tiene una vigencia absoluta de 30
días: rota en cada uso sin prolongar esa fecha; reutilizar uno antiguo revoca la
familia incluso tras reinicio. Si una familia o el store alcanza el límite de
tombstones, la rotación revoca fail-safe esa familia en vez de bloquearse.

El recurso y permiso son exactos: `https://mcp.lumbre.pro/mcp` y
`lumbre:mcp`. Los callbacks se validan contra la identidad del cliente: el
callback oficial de claude.ai y el loopback efímero issuer-bound de Codex. El
servidor usa documentos de metadata de cliente (CIMD); no inventa un
`client_id` ni anuncia registro dinámico. La caché CIMD respeta
`Cache-Control: no-store` y `no-cache` y no reutiliza esas respuestas.

El callback Lumbre es one-shot: se consume durablemente antes de `/exchange`,
de modo que dos callbacks concurrentes nunca canjean dos veces. Si la respuesta
del canje se pierde por un timeout ambiguo, no se reintenta a ciegas porque el
contrato de Lumbre no ofrece una respuesta idempotente recuperable; la persona
debe iniciar otra autorización y puede revocar desde Lumbre cualquier
credencial huérfana. Los tests fijan esta única llamada aun tras repetir el
callback.

Si una petición trae **las dos** (cabecera Y path), **gana la cabecera**: es
la forma menos expuesta de las dos (no queda guardada en ningún sitio salvo
la config del cliente), así que ante ambigüedad se prefiere la buena en vez
de fallar o mezclar. El token del path se valida de FORMA antes de usarse
(32 caracteres hexadecimales, la forma del token de email-to-task): un
segmento que no case — vacío, con más de un tramo, con caracteres fuera de
`[0-9a-f]` — se trata exactamente como "sin credencial" y responde 401, sin
recortes ni normalizaciones.

**El coste de la forma heredada del path**: el token queda guardado en la
configuración del conector del lado de Anthropic (claude.ai) y visible en
cualquier registro intermedio que guarde URLs (proxies, logs de acceso de
terceros por los que pase la conexión). Rotar el token de email-to-task
obliga a **volver a pegar la URL entera** en la config del conector. Se
conserva para migrar conectores existentes; las configuraciones nuevas de
claude.ai deben usar OAuth con la URL limpia.

Los stores provisionales v1/v2 contenían tokens personales sin identidad de
credencial del broker. El servicio los rechaza en readiness, no los modifica y
no hace `introspect`/`revoke` con ellos. Para migrar: detener el servicio,
archivar juntos `oauth-store.json` y `oauth.key`, retirarlos del volumen y
volver a autorizar desde la sesión web de Lumbre.

### Adjuntos GRANDES con el conector remoto: un SEGUNDO conector stdio local

El conector remoto (`mcp.lumbre.pro`) corre en el VPS de Lumbre, no en tu
máquina — así que `add_attachment({ file_path })` no puede leer tu disco
desde ahí (ver la tool en "Qué hace" más arriba). Para un fichero grande
(una captura, un PDF) con el conector remoto ya enchufado, la vía es tener
**los dos a la vez**: el remoto para todo lo demás, y un segundo conector
stdio **acotado a adjuntos** para `file_path`.

`LUMBRE_MCP_TOOLSET=attachments` (env) hace que este segundo conector
registre SOLO `add_attachment`/`read_attachment` en vez de las 19 tools de
siempre — así no duplicas la superficie de `tools/list` en el contexto de
cada sesión (pesa ~22 KB de JSON; dos copias son el doble, y el modelo
encima tendría que acertar cuál `add_task`/`list_tasks` de los dos usar).
Cualquier otro valor (o no ponerla) registra las 19, igual que siempre.

```bash
claude mcp add lumbre-adjuntos --env LUMBRE_TOKEN=tu-token --env LUMBRE_MCP_TOOLSET=attachments -- node /ruta/absoluta/a/lumbre-mcp/dist/index.js
```

Sustituye `tu-token` por tu token de email-to-task (el mismo de siempre) y la
ruta por la de tu clon compilado (ver "Compilar" más arriba). Con este
conector enchufado, `add_attachment` en `lumbre-adjuntos` acepta `file_path`
con normalidad — el error explicativo de arriba solo sale al llamarla desde
el conector `mcp.lumbre.pro` sin este segundo conector a mano.

## Licencia

[MIT](LICENSE) © 2026 David Velasco.
