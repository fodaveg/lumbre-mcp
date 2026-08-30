# Operaciones seguras con el MCP

Lee esta referencia antes de mutaciones no triviales. Los nombres exactos de las
tools dependen de la versión publicada del servidor; usa las tools que el cliente
exponga y no inventes una operación ausente.

## Identidad y lectura íntegra

- Resuelve tareas por id cuando sea posible. Si partes de texto o título, lista y
  desambigua antes de mutar.
- Enumera listas antes de concluir que una lista no existe. Una consulta de tareas
  vacía puede significar tanto «lista vacía» como «nombre inexistente».
- Para una tarea concreta, usa la lectura individual e íntegra. Para lotes que se
  vayan a reeditar, solicita notas completas o recupera cada tarea necesaria.
- Las referencias a tareas o listas deben resolverse por id vivo. Una etiqueta
  incrustada puede estar caducada; distingue destino vivo, cancelado/hecho y roto.
- Lee los adjuntos relevantes antes de interpretar feedback o cerrar una revisión.
  Un adjunto no leído no es evidencia revisada.

## Mutaciones y preservación

- Una actualización parcial cambia solo los campos enviados. Omite notas, prioridad,
  fecha o residencia cuando no deban cambiar.
- No reconstruyas el título desde texto de display que añada prioridad, fecha de
  creación, marcadores o previews. Usa el contenido crudo.
- Prefiere una mutación batch para varias operaciones relacionadas y conserva el
  orden cuando una operación invalide datos de otra.
- Mover una tarea de lista puede limpiar su sección. Si debe conservar agrupación,
  mueve primero y asigna después la sección en el mismo lote ordenado.
- Las subtareas son checklist de un nivel, no tareas residentes equivalentes. No las
  muevas, reprogrames o conviertas implícitamente en tareas completas; usa la operación
  específica de subtarea.
- Completar y cancelar expresan resultados distintos. Usa completar para «hecha» y
  cancelar para «no se hará»; no simules cancelación con una etiqueta genérica.
- Borrar tareas, listas o secciones exige conocer sus efectos. Al borrar una sección,
  verifica que las tareas se conserven sin sección si ese es el contrato del servidor.

## Consistencia y verificación

Las escrituras de Lumbre pueden encolarse o materializarse de forma eventual. Después
de una mutación:

1. espera la respuesta de la tool;
2. solicita el refresh/sync apropiado si el cambio puede venir de otro dispositivo o
   la versión del servidor lo requiere;
3. relee por id o con un filtro acotado;
4. compara los campos objetivo y los que debían preservarse.

No llames «aplicado» a un cambio solo porque la petición fue aceptada. Un dispositivo
offline tampoco puede forzarse a enviar cambios que aún no llegaron al servidor.

## Adjuntos y topología

- Una ruta local solo es legible por un conector que corra en la misma máquina. En un
  conector remoto, usa una vía de bytes soportada o cambia explícitamente a un conector
  local; no culpes al fichero por una limitación de topología.
- Base64 sirve para artefactos pequeños y aumenta el tamaño. No lo uses para capturas o
  documentos grandes si la llamada consumiría un contexto desproporcionado.
- Respeta los límites de tamaño y proporciona un nombre de fichero cuando los bytes no
  procedan de una ruta.
- Descargar metadata de un formato no implica haber leído su contenido. Declara esa
  limitación si la tool no puede extraerlo.

## Autorización y fallback

Prefiere el flujo de autorización del cliente MCP. Nunca pongas un token en una URL. Un
fallback por API con un secreto configurado en el entorno solo es válido si el usuario
lo ha autorizado, el secreto no aparece en la salida y la escritura pasa por la API
oficial; no escribas directamente en el almacenamiento interno de la aplicación.

La fuente heredada más reciente fija la API en `https://app.lumbre.pro`, no en el sitio
web estático. Su fallback de lectura usa la colección `/api/tasks` con filtros y límite,
y el de escritura `/api/mutations`; no presupone un `GET /api/tasks/<id>` individual.
Comprueba la documentación viva antes de usar esta vía porque es un fallback, no el
contrato primario de la skill.
