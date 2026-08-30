# Lectura

Este modo es estrictamente no mutante. Sirve para «qué tengo hoy», buscar una tarea,
resumir una lista o leer feedback.

- No añadas estados, completes tareas, refresques con efectos ni reorganices datos por
  el mero hecho de leerlos.
- No cargues `development.md` solo porque la tarea leída ya tenga `@acked`, `@wip` o
  `@done`; resumir o inspeccionar sigue siendo lectura pura.
- No cargues `mcp-safe-operations.md` para una lectura ordinaria sin escritura,
  configuración ni diagnóstico de conexión.
- Preguntar si una lista existe, incluso vacía, sigue siendo lectura: no cargues
  `backlog.md` salvo que haya que clasificar o reorganizar.
- Acota por fecha, alcance, lista o ids. No revises el backlog completo salvo que la
  petición lo necesite.
- Si la frescura exige una operación de sync o refresh que pueda persistir cambios,
  trátala como mutación y obtén la autorización correspondiente. Si no se ejecuta,
  indica explícitamente que la lectura puede estar desfasada respecto de cambios aún
  no sincronizados.
- Distingue el checkbox o cancelación nativos de un estado de trabajo de agente.
- Si una nota aparece como marcador o preview y puede cambiar la respuesta, recupera
  su versión íntegra antes de concluir.
