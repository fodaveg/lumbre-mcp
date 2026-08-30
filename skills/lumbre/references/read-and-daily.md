# Lectura y gestión del día a día

## Lectura/consulta

Este modo es estrictamente no mutante. Sirve para «qué tengo hoy», buscar una tarea,
resumir una lista o leer feedback.

- No añadas estados, completes tareas, refresques con efectos ni reorganices datos por
  el mero hecho de leerlos.
- Acota por fecha, alcance, lista o ids. No revises el backlog completo salvo que la
  petición lo necesite.
- Si la frescura exige una operación de sync o refresh que pueda persistir cambios,
  trátala como mutación y obtén la autorización correspondiente. Si no se ejecuta,
  indica explícitamente en la respuesta que la lectura puede estar desfasada respecto
  de cambios aún no sincronizados.
- Distingue el checkbox o cancelación nativos de un estado de trabajo de agente.
- Si una nota aparece como marcador o preview y puede cambiar la respuesta, recupera
  su versión íntegra antes de concluir.

## Día a día

Usa las propiedades nativas de Lumbre para tareas personales u operativas:

- fecha y hora para cuándo ocurre o vence;
- recurrencia para hábitos u obligaciones repetidas;
- prioridad para importancia relativa;
- lista y sección para residencia y agrupación;
- subtareas para una checklist breve;
- completar para trabajo realizado y cancelar para trabajo que no se hará.

No actives automáticamente `@acked`, `@wip`, `@done` ni `@not-done`. Expresa una
tarea bloqueada, aplazada, devuelta a pendiente o enviada al backlog mediante los
campos nativos disponibles y, cuando haga falta, una nota explícita; no inventes un
estado de desarrollo.

Después de crear o editar, verifica solo los campos pedidos y comunica qué cambió y
cualquier limitación de sincronización.
