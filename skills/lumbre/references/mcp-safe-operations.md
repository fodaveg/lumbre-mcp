# Operaciones seguras con el MCP

Lee esta referencia antes de escribir. Usa las tools que el cliente exponga; no
inventes operaciones ni supongas capacidades de otra versión del servidor.
Antes de concluir que una capacidad no existe, comprueba el esquema de las tools de
lote: una operación puede estar expuesta como `op` de una tool de batch y no como tool
independiente. Para adjuntos o para configurar la conexión, lee además
[attachments-and-connection.md](attachments-and-connection.md).

## Identidad y lectura íntegra

- Resuelve por id. Si partes de texto, lista y desambigua antes de mutar.
- Enumera proyectos y áreas antes de concluir que uno no existe.
- Recupera la tarea íntegra por id antes de reeditar su `content` o sus `notes` (se
  reemplazan enteros), antes de delegar trabajo sobre ella o cuando la decisión dependa
  de un campo que no has leído; la resolución contextual o un preview no sustituyen esa
  lectura. `reschedule`, `complete`, `cancel`, prioridad, sección y similares, con el id
  ya resuelto, no la necesitan.
- Recupera contenido, notas y adjuntos íntegros que puedan afectar la decisión.
- Una lectura íntegra vale para todo el encargo: reutilízala en vez de pedirla otra vez
  por rutina. Relee solo si pudo cambiar por otra vía (lo editó el usuario u otra
  sesión, un `refresh_sync` trajo cambios), si una op tuya no salió «aplicada» o si lo
  que tienes es un preview o un marcador de nota.
- Resuelve referencias por id vivo; una etiqueta incrustada puede estar caducada.

## Preservación y orden

- Una actualización parcial cambia solo los campos enviados. No reconstruyas el
  contenido desde un display con prioridad, fechas, marcadores o previews.
- Prefiere batch para operaciones relacionadas. El servidor conserva el orden de
  envío, pero cada operación reporta su propio resultado y el lote puede quedar
  aplicado a medias: no asumas atomicidad ni éxito global. Cambiar de proyecto o área limpia la
  sección; mueve primero y reasigna después si debe conservarla.
- **Subtareas** (definición única). Un solo nivel: viven dentro de su principal, sin
  lista ni sección propias, y su archivado lo hereda. Son tareas completas (id, notas,
  adjuntos, tags, prioridad y fecha), pero no admiten deadline, recordatorios,
  repetición ni «esperando»: la tarea que los necesite queda en primer nivel.
  `set_parent` anida o saca una tarea existente, y la app lo rechaza si tiene deadline,
  recordatorios, «esperando», repetición o subtareas propias.
- Leerlas: `list_tasks` no las lista, ni siquiera con fecha. `get_task` de la principal
  trae de cada una su id, su `content`, si está hecha y sus tags (basta para conocer y
  cambiar el `content` de todas), pero no su fecha, prioridad, notas ni adjuntos. Abre
  `get_task` de una subtarea solo cuando necesites uno de esos campos o cuando su línea
  muestre una referencia renderizada (`→tarea…`, `→proyecto/área…`) en vez del texto
  crudo.
- Completarlas: completar o cancelar la principal cierra sus subtareas pendientes, y
  descompletarla no las reabre; completar la última subtarea no completa la principal.
  Antes de completar una principal con subtareas abiertas, dilo o pregunta.
- Completar significa «hecha» y cancelar «no se hará»; no confundas los resultados.
  Una cancelada se lee `[-]`/«cancelada», nunca como hecha.
- Un cambio de `recurrence` en `update` es parcial: conserva lo no enviado. Para quitar
  un campo, `null` (`byWeekday`, `until`, `count`) o `streak: false`. Una serie se
  apaga o se cambia en su SEMILLA (`semilla` en el listado; una ocurrencia muestra
  `serie:<id de la semilla>`).
- Antes de borrar, conoce los efectos y confirma el objetivo. Si se elimina una
  sección, verifica que sus tareas se conserven cuando ese sea el contrato.
- `close_project` (en `organize`) cierra también los subproyectos y las tareas abiertas del
  proyecto, y `reopen_project` solo reabre el proyecto nombrado. Confirma con el usuario
  inmediatamente antes de cerrar, como con un borrado, salvo autorización inequívoca para
  ese proyecto concreto.

## Consistencia

`mutate_tasks`, `organize` y `mutate_brl` informan cuántas operaciones fueron
aceptadas («N/N operación(es) aceptadas») y, por cada una, qué hizo la app
con ella: aplicada, sin efecto, sin objetivo, fallida al aplicar, en cuarentena o sin
confirmar. Aceptada no es aplicada: solo «aplicada» cuenta como hecho; cualquier otra es
un resultado que se informa, no un éxito. Lee también los `avisos de la app`: dicen
cuándo una tarea acabó en otro sitio del pedido.
Espera la respuesta y lee el resultado de cada operación. Ese informe dice qué pasó
con cada op, pero no devuelve los campos finales de la tarea. Una op `aplicada`, sin
«aplicadas con aviso» ni `avisos de la app` que la afecten, acredita los campos que
enviaste con su valor final completo (un `update` de `content` o `notes` enteros, una
`priority`, un `reschedule`, un `complete`) y preserva los que no enviaste: no releas
para confirmarlos.

Relee por id o filtro acotado, comparando los campos objetivo y los que debían
preservarse, solo cuando el informe no basta:

- la op no salió `aplicada` (sin confirmar, pendiente de aplicar, sin efecto, sin
  objetivo, fallida o en cuarentena), o llega con aviso;
- el valor final lo decide la app y no lo enviaste tú (un `update` parcial de
  `recurrence`, un cambio de lista que limpia la sección, `set_parent`, un `add_task`
  sin destino);
- el siguiente paso depende de un campo que no enviaste y no tienes leído.

Para varias subtareas de una misma principal basta releer la principal. Una relectura
que solo confirma no bloquea el trabajo que no depende de ella: hazla junto a ese
trabajo o al cerrar el lote. Si aún aparece el estado anterior, ejecuta `refresh_sync`
y relee una segunda vez; solo después declara la limitación. Ese refresh fuerza el
flush de cambios ya recibidos y no autoriza nuevas escrituras.

Un dispositivo offline no puede forzarse a enviar cambios que aún no alcanzaron el
servidor. Declara esa limitación en vez de afirmar que el estado quedó aplicado.
