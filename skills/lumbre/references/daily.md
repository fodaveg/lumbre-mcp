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
   la coloca) y dilo.
2. **En lote.** Las tareas relacionadas van como una tarea principal que nombra el
   resultado común y el resto como sus subtareas (`add_task` con `subtasks`). Antes de
   crear otra principal, busca en ese proyecto una principal abierta del mismo tema: si
   existe, añade las nuevas como subtareas suyas (`add_subtask`). Una tarea sin
   relación con nada queda en primer nivel, y puede ser la principal de un lote futuro.
3. **Límites de la app.** Hay un solo nivel. Una subtarea nace solo con texto, y los
   `#tags` escritos en ese texto se capturan como tags. Pero es una tarea completa:
   después admite fecha con `reschedule`; hora, prioridad, notas y tags con `update`;
   y adjuntos con `add_attachment`, igual que una principal. Deadline,
   recordatorios, repetición y «esperando» no existen en una subtarea: la tarea que
   los necesite queda en primer nivel.

Lo que el usuario indique (proyecto, tarea suelta, otra agrupación) manda sobre este
comportamiento. Al terminar, di el proyecto elegido, la principal y sus subtareas.

## Subtareas: leer y completar

- **Leer.** `list_tasks` no muestra subtareas, ni siquiera las que tienen fecha. Se
  ven con `get_task` de la principal, y el detalle de cada una (fecha, prioridad,
  notas, adjuntos) con `get_task` de la subtarea.
- **Completar.** Completar o cancelar la principal cierra todas sus subtareas
  pendientes, y descompletarla no las reabre. Completar la última subtarea no
  completa la principal. Antes de completar una principal con subtareas abiertas,
  dilo o pregunta.

No actives automáticamente `@acked`, `@wip`, `@done` ni `@not-done`. Expresa una
tarea bloqueada, aplazada, devuelta a pendiente o enviada al backlog mediante los
campos nativos disponibles y, cuando haga falta, una nota explícita; no inventes un
estado de desarrollo.

No inventes fechas ni prioridades. Cuando ayude, formula una siguiente acción concreta;
si falta una decisión material, ofrece como máximo dos o tres opciones claras. No
conviertas esta skill en una implementación completa de GTD: su objetivo es operar
Lumbre con baja fricción.

Después de crear o editar, verifica solo los campos pedidos y comunica qué cambió y
cualquier limitación de sincronización.
