# Gestión cotidiana

Usa las propiedades nativas de Lumbre para tareas personales u operativas:

- fecha y hora para cuándo ocurre o vence;
- recurrencia para hábitos u obligaciones repetidas;
- prioridad para importancia relativa;
- proyecto o área para residencia, y sección para agrupación;
- subtareas para las piezas de un lote, bajo una tarea principal (también sirven de
  checklist breve);
- completar para trabajo realizado y cancelar para trabajo que no se hará.

## Crear tareas sin destino ni estructura indicados

Si la petición no dice dónde ni cómo agrupar, el comportamiento por defecto es este:

1. **Proyecto principal.** Enumera proyectos y áreas (`list_lists`) y elige el que
   mejor encaje por nombre y contenido: es la lista principal del trabajo. Si ninguno
   encaja con claridad, crea las tareas sin destino (la app las coloca) y dilo. Manda
   cada destino por `listId` (el de `list_lists` o el que generaste), no por `list`:
   un nombre mal escrito crea un proyecto nuevo.
2. **Tamaño del encargo.** Es **gordo** si suma tres o más lotes, o si el usuario lo
   trata como un proyecto propio (lo llama proyecto o trae su propia nota o spec). Lo
   demás no es gordo. Ante la duda, trátalo como no gordo: una sección se promueve
   después a proyecto sin perder nada.
   - **Gordo → proyecto nuevo** dentro del principal. Antes, comprueba en `list_lists`
     que no exista ya uno del mismo encargo; si existe, úsalo. Nómbralo
     `<proyecto principal> · <resultado>` y créalo con `organize`: `create_list`
     (`listKind: "project"`) con un `listId` que generes tú y, en la misma llamada,
     `nest_list` hacia el principal.
   - **No gordo → sección nueva** dentro del principal, que nombra el encargo o la
     iniciativa. Si ya existe una sección de ese mismo encargo, úsala. La sección se
     crea al pasar `section` en el alta de la primera principal.
3. **Siempre en lotes.** Cada tarea principal es un lote: una unidad que una persona o
   un agente puede hacer de principio a fin sin esperar a otra principal en curso, de
   modo que repartir el trabajo en paralelo sea asignar principales. Su `content`
   nombra el resultado, sin la palabra «lote»: tener subtareas ya la marca como lote.
   Las piezas van como subtareas (`add_task` con `subtasks`). Si un lote depende de
   otro, dilo en su nota. La sección, el deadline,
   los recordatorios y la repetición van en la principal, porque las subtareas no los
   admiten. Antes de crear otra principal, busca en ese destino una principal abierta
   del mismo lote: si existe, añade las piezas nuevas como subtareas suyas
   (`add_subtask`). Una tarea sin piezas ni relación con nada queda como principal
   sin subtareas, y puede ser la principal de un lote futuro.
4. **Vincular la nota de origen.** Si se crea un proyecto o se añaden tareas que salen
   de un audit, la nota del audit, la spec o el plan se guarda y se vincula al destino
   de las tareas según [destinations.md](destinations.md), que fija la mecánica.
5. **Id de lo creado.** Si después necesitas el id (añadir subtareas, citarla o cambiar
   su estado), crea con la op `add_task` de `mutate_tasks`, que lo devuelve; la tool
   `add_task` suelta no.
6. **Subtareas.** Una subtarea nace solo con texto, y los `#tags` escritos en ese texto
   se capturan como tags. Después se edita como una tarea completa: fecha con
   `reschedule`; hora, prioridad, notas y tags con `update`; adjuntos con
   `add_attachment`. Sus límites, y cómo leerlas y completarlas, están en «Preservación
   y orden» de [mcp-safe-operations.md](mcp-safe-operations.md).

Lo que el usuario indique (proyecto, sección, tarea suelta, otra agrupación) manda sobre
este comportamiento. Al terminar, di si el encargo contó como gordo y por qué, el
proyecto o la sección de destino, la nota vinculada si la hay, y cada principal con sus
subtareas.

## Tareas que el agente crea por su cuenta

Lo que decide el destino es quién pidió la tarea, no de qué trabajo cuelga. Si el usuario
pide las tareas («haz X», «crea las tareas de este audit»), van al proyecto del trabajo
según la sección anterior. Si nacen por iniciativa del agente mientras trabaja (al hacer
X descubre que la sincronización falla por Y), van sin preguntar al proyecto que el
usuario dedica al trabajo de los agentes (por ejemplo, «Agentes Lumbre»), en su propia
sección por tema, para no mezclarlas con las del usuario. Usa la sección de ese tema si
ya existe. Si el usuario no tiene ese proyecto, van al proyecto del trabajo en una
sección propia de hallazgos del agente, y dilo. Al terminar, nombra cada tarea creada
así y dónde quedó.

## Otras operaciones de tarea

Ops de `mutate_tasks` salvo donde se indica; el esquema de cada tool detalla sus campos.

- `restore` saca de la Papelera una tarea borrada; `archive` y `unarchive` cambian su
  visibilidad (no su ciclo de vida).
- `set_waiting` y `clear_waiting` ponen y quitan el estado «esperando» (con fecha
  futura); no existe en subtareas.
- Hábitos: `register_habit`, `skip_occurrence`, `archive_habit` y `unarchive_habit`
  actúan sobre `habitId` o `seriesId`, no sobre una tarea (para leerlos, `list_habits`).
  Borrar un hábito (`delete_habit`, en `organize`) exige confirmación como cualquier
  borrado.
- El registro del día (BRL) se escribe con `mutate_brl`; `delete` es destructiva.

No actives automáticamente `@acked`, `@wip`, `@done` ni `@not-done`, salvo en las
tareas que creas para trabajo que hará un agente: esas nacen en `@acked` según
[development.md](development.md), que se carga al crearlas. Expresa una
tarea bloqueada, aplazada, devuelta a pendiente o enviada al backlog mediante los
campos nativos disponibles y, cuando haga falta, una nota explícita; no inventes un
estado de desarrollo.

No inventes fechas ni prioridades. Cuando ayude, formula una siguiente acción concreta;
si falta una decisión material, ofrece como máximo dos o tres opciones claras. No
conviertas esta skill en una implementación completa de GTD: su objetivo es operar
Lumbre con baja fricción.

Después de crear o editar, confirma solo los campos pedidos con el resultado por op
(relee solo en los casos de «Consistencia» de
[mcp-safe-operations.md](mcp-safe-operations.md)) y comunica qué cambió y cualquier
limitación de sincronización.
