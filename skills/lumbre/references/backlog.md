# Triaje y backlog

Activa este modo cuando el objetivo sea clasificar, montar o reorganizar un backlog,
no para una lectura incidental.

## Taxonomía conservada

- **Área = ámbito estable.** Vive en la raíz y puede contener proyectos y tareas sueltas.
- **Proyecto = resultado acotado.** Puede vivir en la raíz, dentro de un área o dentro de otro proyecto.
- **Sección = bloque conceptual.** Agrupa dentro de un proyecto o área, por ejemplo backlog,
  documentación, ideas o rediseño.
- **Punto = tarea real.** Conserva id, notas, prioridad, fecha, adjuntos y referencias.
- **Lote = `#tag` libre.** Un lote cruza secciones si hace falta; no lo conviertas en
  sección solo por ser un lote de ejecución.
- **`@contexto` = valor de un diccionario controlado; `#tag` = marcador libre.** No
  uses `@` para lotes o categorías arbitrarias.

No rebajes una tarea real a subtarea para simplificar la estructura: una subtarea es
solo checklist. Si un bloque necesita identidad, prosa o propiedades propias, un proyecto,
un área o una tarea independiente es la válvula apropiada.

Antes de crear o asignar una sección durante un lote, comprueba si su nombre replica el
lote o si se está creando una sección por cada lote. Si ocurre, detén la operación: el
límite del lote pertenece al `#tag`; duplicarlo como sección crea dos ejes para el mismo
concepto. Una iniciativa puede compartir una sola sección conceptual entre varios lotes.

Un área puede actuar como ámbito de proyectos y tareas directas; no tiene progreso ni cierre.
Los proyectos se pueden anidar entre sí; cada tarea conserva su residencia directa. No anides un área
ni reestructures un contenedor configurado sin autorización.

## Procedimiento de triaje

1. Enumera proyectos, áreas y secciones existentes; una consulta de tareas vacía no prueba que el
   proyecto o área no exista.
2. Lee íntegramente las tareas que vas a reclasificar, incluidas notas y adjuntos que
   afecten la decisión.
3. Si la petición es abierta o cambia taxonomía o navegación, muestra primero una vista
   previa breve y espera confirmación: esa respuesta no incluye todavía operaciones de
   escritura. Si enumera movimientos exactos, aplícalos directamente. Conserva ids,
   contenido y propiedades.
4. Ordena las operaciones: cambiar de proyecto o área antes de reasignar sección si el movimiento
   limpia esa relación.
5. Verifica el lote completo y los elementos que debían quedar intactos.

Crear un proyecto nuevo, borrar un proyecto o área existente, o anidar un proyecto de forma que
cambie la navegación requiere que la petición autorice esa transformación. `create_list` crea un
proyecto; esta versión del MCP no crea ni convierte áreas. No busques un contenedor «parecido» ni
lo crees por inferencia cuando el usuario nombró uno que no existe.
