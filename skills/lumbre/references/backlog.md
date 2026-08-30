# Triaje y backlog

Activa este modo cuando el objetivo sea clasificar, montar o reorganizar un backlog,
no para una lectura incidental.

## Taxonomía conservada

- **Tema = lista/proyecto.** Una lista contiene trabajo con una identidad común.
- **Sección = bloque conceptual.** Agrupa dentro de una lista, por ejemplo backlog,
  documentación, ideas o rediseño.
- **Punto = tarea real.** Conserva id, notas, prioridad, fecha, adjuntos y referencias.
- **Lote = `#tag` libre.** Un lote cruza secciones si hace falta; no lo conviertas en
  sección solo por ser un lote de ejecución.
- **`@contexto` = valor de un diccionario controlado; `#tag` = marcador libre.** No
  uses `@` para lotes o categorías arbitrarias.

No rebajes una tarea real a subtarea para simplificar la estructura: una subtarea es
solo checklist. Si un bloque necesita identidad, prosa o propiedades propias, una lista
o tarea independiente es la válvula apropiada.

Antes de crear o asignar una sección durante un lote, comprueba si su nombre replica el
lote o si se está creando una sección por cada lote. Si ocurre, detén la operación: el
límite del lote pertenece al `#tag`; duplicarlo como sección crea dos ejes para el mismo
concepto. Una iniciativa puede compartir una sola sección conceptual entre varios lotes.

Una lista raíz puede actuar como hub de listas hijas y sus métricas pueden no agregar el
contenido de las hijas. No borres ni reestructures un hub configurado sin autorización.

## Procedimiento de triaje

1. Enumera listas y secciones existentes; una lista de tareas vacía no prueba que la
   lista no exista.
2. Lee íntegramente las tareas que vas a reclasificar, incluidas notas y adjuntos que
   afecten la decisión.
3. Si la petición es abierta o cambia taxonomía o navegación, muestra primero una vista
   previa breve y espera confirmación: esa respuesta no incluye todavía operaciones de
   escritura. Si enumera movimientos exactos, aplícalos directamente. Conserva ids,
   contenido y propiedades.
4. Ordena las operaciones: mover de lista antes de reasignar sección si el movimiento
   limpia esa relación.
5. Verifica el lote completo y los elementos que debían quedar intactos.

Crear una lista nueva, borrar una existente o anidarla de forma que cambie la navegación
requiere que la petición autorice esa transformación. No busques una lista «parecida» ni
la crees por inferencia cuando el usuario nombró una que no existe.
