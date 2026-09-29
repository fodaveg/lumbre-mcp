# Operaciones seguras con el MCP

Lee esta referencia antes de escribir. Usa las tools que el cliente exponga; no
inventes operaciones ni supongas capacidades de otra versión del servidor.
Antes de concluir que una capacidad no existe, comprueba el esquema de las tools de
lote: una operación puede estar expuesta como `op` de una tool de batch y no como tool
independiente.

## Identidad y lectura íntegra

- Resuelve por id. Si partes de texto, lista y desambigua antes de mutar.
- Enumera proyectos y áreas antes de concluir que uno no existe.
- Antes de mutar una tarea existente o delegar trabajo sobre ella, recupérala
  íntegramente por id; la resolución contextual o un preview no sustituyen esa lectura.
- Recupera contenido, notas y adjuntos íntegros que puedan afectar la decisión.
- Una lectura íntegra vale para todo el encargo en curso: reutiliza el contenido y las
  notas ya leídos en vez de pedirlos otra vez por rutina, y parte de ellos, más lo
  que tus propias escrituras aplicadas cambiaron, para la siguiente escritura. Relee
  solo si pudo cambiar por otra vía (lo editó el usuario u otra sesión, un
  `refresh_sync` trajo cambios, una op tuya no salió `aplicada`) o si lo que tienes es
  un preview o un marcador de nota.
- Resuelve referencias por id vivo; una etiqueta incrustada puede estar caducada.

## Preservación y orden

- Una actualización parcial cambia solo los campos enviados. No reconstruyas el
  contenido desde un display con prioridad, fechas, marcadores o previews.
- Prefiere batch para operaciones relacionadas. El servidor conserva el orden de
  envío, pero cada operación reporta su propio resultado y el lote puede quedar
  aplicado a medias: no asumas atomicidad ni éxito global. Cambiar de proyecto o área limpia la
  sección; mueve primero y reasigna después si debe conservarla.
- Las subtareas tienen un solo nivel y viven dentro de su principal, sin lista ni
  sección propias: `list_tasks` no las lista sueltas y se leen con `get_task` de la
  principal. `set_parent` anida o saca una tarea existente.
- `get_task` de la principal trae de cada subtarea su id, su `content`, si está hecha
  y sus tags, pero no su fecha, prioridad, notas ni adjuntos. Con esa sola lectura
  basta para conocer y cambiar el `content` de todas; abre `get_task` de una subtarea
  solo cuando necesites uno de los campos que faltan (vas a trabajarla y puede tener
  nota o adjuntos, o vas a editar esos campos) o cuando su línea muestre una
  referencia renderizada (`→tarea…`, `→proyecto/área…`) en vez del texto crudo.
- Completar significa «hecha» y cancelar «no se hará»; no confundas los resultados.
  Una cancelada se lee `[-]`/«cancelada», nunca como hecha.
- Un cambio de `recurrence` en `update` es parcial: conserva lo no enviado. Para quitar
  un campo, `null` (`byWeekday`, `until`, `count`) o `streak: false`. Una serie se
  apaga o se cambia en su SEMILLA (`semilla` en el listado; una ocurrencia muestra
  `serie:<id de la semilla>`).
- Antes de borrar, conoce los efectos y confirma el objetivo. Si se elimina una
  sección, verifica que sus tareas se conserven cuando ese sea el contrato.

## Consistencia

Salvo la subida de adjuntos, una escritura puede aceptarse antes de materializarse.
`mutate_tasks`, `organize` y `mutate_brl` distinguen «encoladas» (aceptadas) de lo que
la app hizo con cada una: aplicada, sin efecto, sin objetivo, fallida al aplicar, en
cuarentena o sin confirmar. Solo «aplicada» cuenta como hecho; cualquier otra es un
resultado que se informa, no un éxito. Lee también los `avisos de la app`: dicen cuándo
una tarea acabó en otro sitio del pedido.
Espera la respuesta y lee el resultado de cada operación. Ese informe dice qué pasó
con cada op, pero no devuelve los campos finales de la tarea. Una op `aplicada`, sin
«aplicadas con aviso» ni `avisos de la app` que la afecten, acredita los campos que
enviaste con su valor final completo (un `update` de `content` o `notes` enteros, una
`priority`, un `reschedule`, un `complete`) y preserva los que no enviaste: no releas
para confirmarlos. Encolada no es aplicada.

Relee por id o filtro acotado, comparando los campos objetivo y los que debían
preservarse, solo cuando el informe no basta:

- la op no salió `aplicada` (sin confirmar, pendiente de aplicar, sin efecto, sin
  objetivo, fallida o en cuarentena), o llega con aviso;
- el valor final lo decide la app y no lo enviaste tú (un `update` parcial de
  `recurrence`, un cambio de lista que limpia la sección, `set_parent`, un `add_task`
  sin destino);
- el siguiente paso depende de un campo que no enviaste y no tienes leído.

Para varias subtareas de una misma principal basta releer la principal. Una relectura
que solo confirma no bloquea el trabajo que no depende de ella: hazla junto a ese
trabajo o al cerrar el lote. Si aún aparece el estado anterior, ejecuta `refresh_sync`
y relee una segunda vez; solo después declara la limitación. Ese refresh fuerza el
flush de cambios ya recibidos y no autoriza nuevas escrituras.

Un dispositivo offline no puede forzarse a enviar cambios que aún no alcanzaron el
servidor. Declara esa limitación en vez de afirmar que el estado quedó aplicado.

## Adjuntos y topología

- Una ruta local solo es legible por un conector que corra en la misma máquina.
- Base64 aumenta el tamaño; resérvalo para artefactos pequeños.
- Respeta límites y nombres exigidos. Descargar metadata no equivale a leer contenido.
- `add_attachment` es síncrona: cuando responde, el adjunto ya está enlazado. El resto
  de escrituras se encola y exige el bucle de consistencia anterior.
- `delete_attachment` es destructiva y no ofrece deshacer desde el MCP. Resuelve el id
  desde la tarea íntegra, confirma con el usuario el adjunto exacto antes de llamarla y,
  tras el éxito, relee la tarea para comprobar que ese id ya no aparece. Un 404 no
  demuestra si el id era inexistente o pertenecía a otra cuenta.

## Autorización

Conecta el MCP mediante el flujo OAuth/autorización que ofrezca el cliente. Nunca pongas
un token en una URL ni lo copies a tareas, notas, logs o documentación.

El acceso directo a una API no es el flujo normal de esta skill. Úsalo solo para un
diagnóstico explícitamente autorizado cuando el MCP no permita obtener la evidencia,
después de comprobar la documentación viva. Mantén cualquier secreto en el mecanismo
seguro del entorno o cabecera correspondiente, no lo muestres y no escribas directamente
en el almacenamiento interno de Lumbre.
