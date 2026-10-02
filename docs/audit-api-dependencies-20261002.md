# Dependencias de API del audit R6/R8/R9 (2 oct 2026)

Alcance: tarea Lumbre `bab4ece7-6ca3-4607-bb97-625fbb42aff3` y petición a la
app `4aaea9ab-a914-4d41-b6ac-c6d1a38bd27a`. Contraste de solo lectura con
`lumbre` main `d8f73504421b4e667a943992f841104f750c6543` y
`lumbre-mcp` main `b311bba`. Los resultados describen esos árboles; una rama
de la app o una versión desplegada puede diferir.

## R6 · Listas

`GET /api/tasks?includeLists=1` devuelve todas las listas vivas con `notes`
íntegra (`lumbre/src/routes/api/tasks/+server.ts`, rama `includeLists`).
Aunque el handler analiza `notes` para tareas, esa rama no aplica el modo a
listas ni filtra por `listId`. En el MCP, `listLists` pide siempre ese recurso;
`list_lists` solo muestra un marcador de nota y `get_list` busca un `listId`
en el array completo (`src/lumbre-client.ts`, `src/tools/lists.ts`).

Contrato pendiente en la app: `notes=length` para la enumeración de listas,
con longitud sin texto íntegro, y selección por `listId` para leer solo una
lista con su nota íntegra. Debe conservar la semántica actual de nota borrada
(`notesDeletedAt` implica `notes: null`), el recuento y el error inequívoco
para un id no visible. La proyección actual no tiene `notesUpdatedAt` para
listas, según el comentario del handler; el MCP no debe inventar esa marca.
Cuando esté disponible, adaptar `listLists` y `get_list` y probar que el
listado no recibe texto de notas mientras el detalle conserva el verbatim.

## R8 · Lote BRL

La premisa de que `/api/batch` no admite BRL está desfasada en el árbol
inspeccionado. Su operación `{type:'mutate', taskId, kind, payload}` llama a
`validateAndEnqueueMutation`, que acepta `createBrlEntry`, `updateBrlEntry`
y `removeBrlEntry`, aplica el gate del add-on y comparte un drenaje
(`lumbre/src/routes/api/batch/+server.ts`,
`lumbre/src/lib/server/repos/mutations.ts`).

El consumidor de este candidato envía en un único batch las operaciones BRL
válidas, en orden, con ids preasignados para las altas y comprobación previa
de existencia para editar/borrar. La respuesta batch conserva éxito parcial,
`materialization` por posición y avisos del drenaje. `materialization:'noop'`
no separa «objetivo desaparecido» de «sin cambio»: el informe dice solo
«sin efecto». Una respuesta antigua sin `materialization` queda «sin
confirmar». No hace falta otro endpoint para cumplir R8 tal como está
formulada; si en el futuro se exige distinguir `not-found`, el contrato del
batch deberá añadir ese detalle antes de atribuirle esa causa al usuario.

## R9 · Hábitos

En la app solo existe `POST /api/habits/register`; no hay `GET /api/habits`.
`listHabitsExport` usa `GET /api/export` y descarta todo salvo `habits` y
`habitLog` (`src/lumbre-client.ts`, `src/tools/habits.ts`). El export tiene
límite propio de 10/min y envía también tareas, listas y otros datos.

Contrato pendiente en la app: lectura autenticada con la credencial de
máquina de `GET /api/tasks` que entregue `{habits, habitLog}` sin el resto del
export. Conservar ids, `nombre`, `clase`, `archivedAt` y las ocurrencias con
`habitId`/`date`; la tool decide `includeArchived` y muestra las tres fechas
más recientes. Una vez exista, cambiar el cliente y las pruebas de la tool,
y actualizar la descripción del límite real.

No se ha probado ningún endpoint remoto ni se ha modificado el repo de la app.
