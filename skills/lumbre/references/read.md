# Lectura

Este modo es estrictamente no mutante. Sirve para «qué tengo hoy», buscar una tarea,
resumir una lista o leer feedback.

- No añadas estados, completes tareas ni reorganices datos por el mero hecho de
  leerlos.
- No cargues `development.md` solo porque la tarea leída ya tenga `@acked`, `@wip` o
  `@done`; resumir o inspeccionar sigue siendo lectura pura.
- No cargues `mcp-safe-operations.md` para una lectura ordinaria sin escritura,
  configuración ni diagnóstico de conexión.
- Preguntar si una lista existe, incluso vacía, sigue siendo lectura: no cargues
  `backlog.md` salvo que haya que clasificar o reorganizar.
- Acota por fecha, alcance, lista o ids. No revises el backlog completo salvo que la
  petición lo necesite.
- `refresh_sync` solo fuerza el flush de cambios que ya llegaron al servidor: es una
  operación de lectura. Úsala antes de releer cuando importa la frescura y el cambio
  pudo hacerse fuera de este MCP, por ejemplo desde la app o el móvil. No hace falta
  tras una escritura de este mismo MCP. Si no puede ejecutarse, o el dispositivo que
  hizo el cambio sigue offline, indica que la lectura puede estar desfasada.
- Distingue el checkbox o cancelación nativos de un estado de trabajo de agente.
- Si una nota aparece como marcador o preview y puede cambiar la respuesta, recupera
  su versión íntegra antes de concluir.
