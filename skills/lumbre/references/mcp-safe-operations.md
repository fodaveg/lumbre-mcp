# Operaciones seguras con el MCP

Lee esta referencia antes de escribir. Usa las tools que el cliente exponga; no
inventes operaciones ni supongas capacidades de otra versión del servidor.

## Identidad y lectura íntegra

- Resuelve por id. Si partes de texto, lista y desambigua antes de mutar.
- Enumera listas antes de concluir que una lista no existe.
- Recupera contenido, notas y adjuntos íntegros que puedan afectar la decisión.
- Resuelve referencias por id vivo; una etiqueta incrustada puede estar caducada.

## Preservación y orden

- Una actualización parcial cambia solo los campos enviados. No reconstruyas el
  contenido desde un display con prioridad, fechas, marcadores o previews.
- Prefiere batch para operaciones relacionadas y conserva su orden. Mover de lista
  puede limpiar la sección: mueve primero y reasigna después si debe conservarla.
- Las subtareas son checklist de un nivel, no tareas residentes equivalentes.
- Completar significa «hecha» y cancelar «no se hará»; no confundas los resultados.
- Antes de borrar, conoce los efectos y confirma el objetivo. Si se elimina una
  sección, verifica que sus tareas se conserven cuando ese sea el contrato.

## Consistencia

Una escritura puede aceptarse antes de materializarse. Espera la respuesta, ejecuta el
sync/refresh apropiado cuando esté autorizado y sea necesario, relee por id o filtro
acotado y compara tanto los campos objetivo como los que debían preservarse. Un refresh
que persiste o incorpora cambios es una mutación, no una consulta.

Un dispositivo offline no puede forzarse a enviar cambios que aún no alcanzaron el
servidor. Declara esa limitación en vez de afirmar que el estado quedó aplicado.

## Adjuntos y topología

- Una ruta local solo es legible por un conector que corra en la misma máquina.
- Base64 aumenta el tamaño; resérvalo para artefactos pequeños.
- Respeta límites y nombres exigidos. Descargar metadata no equivale a leer contenido.

## Autorización

Conecta el MCP mediante el flujo OAuth/autorización que ofrezca el cliente. Nunca pongas
un token en una URL ni lo copies a tareas, notas, logs o documentación.

El acceso directo a una API no es el flujo normal de esta skill. Úsalo solo para un
diagnóstico explícitamente autorizado cuando el MCP no permita obtener la evidencia,
después de comprobar la documentación viva. Mantén cualquier secreto en el mecanismo
seguro del entorno o cabecera correspondiente, no lo muestres y no escribas directamente
en el almacenamiento interno de Lumbre.
