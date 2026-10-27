# Adjuntos y conexión

Lee esta referencia solo si vas a subir, leer o borrar un adjunto, o a configurar la
conexión del MCP. Las reglas de escritura en general viven en
[mcp-safe-operations.md](mcp-safe-operations.md).

## Adjuntos y topología

- Una ruta local solo es legible por un conector que corra en la misma máquina.
- Base64 aumenta el tamaño; resérvalo para artefactos pequeños.
- Respeta límites y nombres exigidos. Descargar metadata no equivale a leer contenido.
- `add_attachment` es síncrona: cuando responde, el adjunto ya está enlazado. Las demás
  escrituras se dan por hechas solo si el informe de cada op dice «aplicada» (ver
  «Consistencia» en mcp-safe-operations.md).
- Fichero local o grande con el conector remoto: `prepare_attachment_upload({ taskId, filename })`
  en vez de `add_attachment` con base64. Devuelve un permiso de un solo uso (10 min) y un `curl`
  que ejecutas tú en la terminal sustituyendo `<ruta local>`; los bytes no pasan por el modelo.
  Flujo: prepare, curl y `get_task` para comprobar el adjunto. 401/413/404 de la subida: pide otro
  permiso; 429: reintenta con el mismo. El permiso es un secreto: no lo copies a tareas ni notas.
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
