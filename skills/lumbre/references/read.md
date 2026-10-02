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
- Acota `list_tasks` por `scope`, `list` y `section`; por id se lee con `get_task`. Para un
  lote marcado con `#tag`, lista el proyecto (o `scope:"all"` si cruza proyectos) y
  filtra por el tag en el resultado. No revises el backlog completo salvo que la
  petición lo necesite.
- Otras lecturas: `list_habits` (hábitos), `get_list` (nota íntegra de un proyecto o
  área), `get_list_links` (sus vínculos, sin abrir el destino) y `list_brl_entries`
  (registro del día; no son tareas).
- `refresh_sync` solo fuerza el flush de cambios que ya llegaron al servidor: es una
  operación de lectura. Úsala antes de releer cuando importa la frescura y el cambio
  pudo hacerse fuera de este MCP, por ejemplo desde la app o el móvil. No hace falta
  tras una escritura de este mismo MCP. Si no puede ejecutarse, o el dispositivo que
  hizo el cambio sigue offline, indica que la lectura puede estar desfasada.
- Distingue el checkbox o cancelación nativos de un estado de trabajo de agente.
- Si una nota aparece como marcador o preview y puede cambiar la respuesta, recupera
  su versión íntegra antes de concluir.
