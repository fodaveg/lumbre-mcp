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

1. **Proyecto más adecuado.** Enumera proyectos y áreas (`list_lists`) y elige el que
   mejor encaje por nombre y contenido. Solo uno existente: no crees ni inventes un
   proyecto por inferencia. Si ninguno encaja con claridad, créala sin destino (la app
   la coloca) y dilo. Manda el destino elegido por `listId` (el de `list_lists`), no por
   `list`: un nombre mal escrito crea un proyecto nuevo.
2. **En lote.** Las tareas relacionadas van como una tarea principal que nombra el
   resultado común y el resto como sus subtareas (`add_task` con `subtasks`). Antes de
   crear otra principal, busca en ese proyecto una principal abierta del mismo tema: si
   existe, añade las nuevas como subtareas suyas (`add_subtask`). Una tarea sin
   relación con nada queda en primer nivel, y puede ser la principal de un lote futuro.
3. **Id de lo creado.** Si después necesitas el id (añadir subtareas, citarla o cambiar
   su estado), crea con la op `add_task` de `mutate_tasks`, que lo devuelve; la tool
   `add_task` suelta no.
4. **Subtareas.** Una subtarea nace solo con texto, y los `#tags` escritos en ese texto
   se capturan como tags. Después se edita como una tarea completa: fecha con
   `reschedule`; hora, prioridad, notas y tags con `update`; adjuntos con
   `add_attachment`. Sus límites, y cómo leerlas y completarlas, están en «Preservación
   y orden» de [mcp-safe-operations.md](mcp-safe-operations.md).

Lo que el usuario indique (proyecto, tarea suelta, otra agrupación) manda sobre este
comportamiento. Al terminar, di el proyecto elegido, la principal y sus subtareas.

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

No actives automáticamente `@acked`, `@wip`, `@done` ni `@not-done`. Expresa una
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
