# Lectura

Este modo es estrictamente no mutante. Sirve para «qué tengo hoy», buscar una tarea,
resumir un proyecto o área, o leer feedback.

- No añadas estados, completes tareas ni reorganices datos por el mero hecho de
  leerlos.
- No cargues `development.md` solo porque la tarea leída ya tenga `@acked`, `@wip` o
  `@done`; resumir o inspeccionar sigue siendo lectura pura.
- No cargues `mcp-safe-operations.md` para una lectura ordinaria sin escritura,
  configuración ni diagnóstico de conexión.
- Preguntar si un proyecto o área existe, incluso vacío, sigue siendo lectura: no cargues
  `backlog.md` salvo que haya que clasificar o reorganizar.
- Acota `list_tasks` por `scope`, `listId` (preferente), `list` y `section`; por id se lee con `get_task`. Para un
  lote marcado con `#tag`, lista el proyecto (o `scope:"all"` si cruza proyectos) y
  filtra por el tag en el resultado. No revises el backlog completo salvo que la
  petición lo necesite.
- Otras lecturas: `list_habits` (hábitos), `get_list` (nota íntegra de un proyecto o
  área), `get_list_links` (sus vínculos, sin abrir el destino), `get_task_links`
  (`taskId` o `noteId`, uno solo) y `list_brl_entries` (registro del día; no son tareas).
  `get_task_links` por nota no distingue vacío de sin permiso; por `taskId`, con token
  personal (stdio) una tarea fuera de alcance también sale vacía (con OAuth da 404).
- `get_agenda({days?, week?})` da eventos, tareas y bloques de Horario por día: ve 14
  días como mucho y bloques solo de hoy que no han terminado. No acepta `spaceId`. De un
  espacio solo trae las tareas asignadas a ti y en tu Hoy, siempre en la columna de hoy:
  una con fecha futura no sale en su día y una cerrada desaparece. Los bloques son solo de
  Personal. Para ver un espacio entero, `list_tasks` con `spaceId`.
- `refresh_sync` solo fuerza el flush de cambios que ya llegaron al servidor: es una
  operación de lectura. Úsala antes de releer cuando importa la frescura y el cambio
  pudo hacerse fuera de este MCP, por ejemplo desde la app o el móvil. No hace falta
  tras una escritura de este mismo MCP. Si no puede ejecutarse, o el dispositivo que
  hizo el cambio sigue offline, indica que la lectura puede estar desfasada.
- Distingue el checkbox o cancelación nativos de un estado de trabajo de agente.
- Si una nota aparece como marcador o preview y puede cambiar la respuesta, recupera
  su versión íntegra antes de concluir.

Los espacios y miembros disponibles llegan en el catálogo de `list_lists`/`get_list`.
Respeta la procedencia mostrada de tareas y listas; no confundas listas homónimas.
Para «asignadas a mí», usa `{scope: "all", assignee: "me"}`; si pide solo hoy,
combina `scope: "today"`. Hoy y ese filtro los decide el servidor; si es una versión
que no lo aplica, `list_tasks` da error: dilo y no lo simules filtrando tú. Una subtarea
asignada va dentro de su madre si esta también sale; si no, suelta con `subtarea de <id>`.
`refresh_sync` fuerza solo el store personal; no promete refrescar los compartidos.
BRL y hábitos son personales. Un espacio oculto se trata como inexistente, sin
consultar `/api/spaces` ni probar otra credencial.

Leer por espacio. Sin `spaceId`, `list_tasks` y `list_lists` solo ven Personal: no hay
espacio activo y cada llamada dice su destino. Para leer un espacio, pasa su `spaceId` en
las dos herramientas; un nombre de lista o `assignee: "me"` se resuelven dentro de ese
espacio, y las referencias a listas de otro espacio se muestran con el suyo. Si una tarea
o lista devuelta no es de ese espacio, la herramienta da error en vez de mostrarla. Para
saber qué espacios existen, usa `list_organizations`: solo lectura, con organizaciones,
miembros y espacios, y `granted` indica si la persona encendió el permiso de agente de ese
espacio. Sin `granted` solo se ve el nombre; no leas ni escribas su contenido. Si
`list_organizations` da error de ruta no encontrada, las organizaciones están apagadas en
ese servidor: trabaja con Personal y los espacios de `list_lists`.
