# Triaje y backlog

Activa este modo cuando el objetivo sea clasificar, montar o reorganizar un backlog,
no para una lectura incidental.

## Taxonomía conservada

- **Área = ámbito estable.** Vive en la raíz y puede contener proyectos y tareas sueltas.
- **Proyecto = resultado acotado.** Puede vivir en la raíz, dentro de un área o dentro de otro proyecto.
- **Sección = bloque conceptual.** Agrupa dentro de un proyecto o área, por ejemplo backlog,
  documentación, ideas o rediseño.
- **Punto = tarea real.** Conserva id, notas, prioridad, fecha, adjuntos y referencias.
- **Lote = tarea principal con subtareas.** Es la forma por defecto de agrupar trabajo
  relacionado dentro de un proyecto o área. Un `#tag` libre marca el lote solo cuando
  cruza secciones, proyectos o áreas (por ejemplo, un lote de desarrollo); no lo
  conviertas en sección solo por ser un lote de ejecución.
- **`@contexto` = valor de un diccionario controlado; `#tag` = marcador libre.** No
  uses `@` para lotes o categorías arbitrarias.

Una subtarea es una tarea de pleno derecho dentro de su principal, sin lista ni sección
propias; sus límites y `set_parent` están en «Preservación y orden» de
[mcp-safe-operations.md](mcp-safe-operations.md). Si un bloque necesita identidad propia
por encima de un lote, la válvula es un proyecto o un área.

Antes de crear o asignar una sección durante un lote, comprueba si su nombre replica el
lote o si se está creando una sección por cada lote. Si ocurre, detén la operación: el
límite del lote pertenece a su principal (o al `#tag` si cruza contenedores); duplicarlo
como sección crea dos ejes para el mismo concepto. Una sección nombra un encargo o
iniciativa y la comparten sus lotes; es la que crea `daily.md` para un encargo no gordo.

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

Crear un proyecto o un área, convertir uno en otro, borrar un proyecto o área existente, o
anidar un proyecto de forma que cambie la navegación requiere que la petición autorice
esa transformación. La excepción es el proyecto nuevo de un encargo gordo al crear sus
tareas, que [daily.md](daily.md) crea y anida en su principal por defecto. `organize` crea con `create_list` (`listKind`: `"area"` o
`"project"`) y convierte un contenedor existente con `set_list_kind`. No busques un
contenedor «parecido» ni lo crees por inferencia cuando el usuario nombró uno que no
existe.

Ciclo de vida de un proyecto, con `organize`: `close_project` (`as`: `"done"` o
`"cancelled"`), `reopen_project`, `set_project_when` (fecha, `"someday"` o `null`) y
`set_project_deadline` (fecha o `null`). Cerrar arrastra todo el subárbol abierto: sus
subproyectos abiertos y todas sus tareas abiertas quedan hechos o cancelados con él, y
`reopen_project` reabre solo el proyecto nombrado, no los subproyectos ni las tareas. Por eso
cerrar es difícil de deshacer: confirma con el usuario inmediatamente antes, igual que un
borrado, salvo autorización inequívoca para ese proyecto concreto. Sigue siendo `aplicada` lo
único que cuenta como hecho; un `sin efecto` trae su motivo en los `avisos de la app`.

Los vínculos de un proyecto o área con una nota de Hebra (`link_list_note`,
`unlink_list_note`) siguen [destinations.md](destinations.md).
