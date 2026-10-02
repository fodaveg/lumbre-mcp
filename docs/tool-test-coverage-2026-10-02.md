# Inventario de tests de las 17 tools MCP

Base inspeccionada: `b311bbafc9603bec93c90d9b76ce538e9eb6f94c`. La superficie se
contrastó con los 17 `registerTool` de `src/tools/` y el censo de
`src/index.test.ts`. Este informe clasifica pruebas observables; no afirma un
porcentaje de cobertura de ramas instrumentado. Las 28 operaciones de
`mutate_tasks`/`organize` y las tres de `mutate_brl` pasan una matriz de schema,
pero esa matriz no ejecuta el comportamiento de cada operación.

Actualización del candidato combinado: incorpora el lote BRL revisado `0a7be82`
y el cierre de logs HTTP `6a598a8`, además de los cuatro tests de handlers
descritos abajo. La fila BRL refleja sus pruebas adicionales.

| Tool | Comportamiento probado | Límite material pendiente |
| --- | --- | --- |
| `add_task` | Alta literal, recurrencia, avisos, tags reservados, subtareas al límite y errores de regla (`src/index.test.ts`) | No se prueba la decisión de destino sin `listId` contra la app real. |
| `refresh_sync` | **Añadido aquí:** POST sin cuerpo, confirmación y respuesta `ok:false` (`src/index.test.ts`) | No puede demostrar que un dispositivo offline haya enviado cambios. |
| `list_tasks` | Scopes, `includeArchived`, `limit=500` y aviso, notas en dos fases, fallos de fase 2, referencias y formato (`src/index.test.ts`, `src/notes.test.ts`) | La completitud con más de 500 tareas depende de la API y el aviso; no hay prueba de paginación porque la tool no la ofrece. |
| `list_lists` | Lista vacía, notas marcador y compatibilidad sin campos de nota (`src/index.test.ts`) | Sin contrato vivo de jerarquías profundas. |
| `get_list_links` | Enlaces Obsidian/Hebra, vacío, auth e id inválido (`src/index.test.ts`) | No se abre ni verifica el destino de un vínculo. |
| `get_list` | Nota íntegra, metadatos y lista inexistente (`src/index.test.ts`) | Sin prueba de lectura concurrente con cambio de nota. |
| `link_list_note` | POST, URL nativa Hebra, `target`, sustitución y resultado (`src/index.test.ts`, `src/lumbre-client.test.ts`) | La convergencia con otras sesiones no se mide en esta suite. |
| `unlink_list_note` | POST, retirada y `removed=false` (`src/index.test.ts`) | No hay test de respuesta malformada específica del handler. |
| `get_task` | Id, archivo, subtareas, notas, referencias y error de no encontrado (`src/index.test.ts`, `src/format.test.ts`) | La frescura entre dispositivos no se puede inferir de un mock. |
| `read_attachment` | Imagen dentro y fuera del tope y no imagen sin descargar cuerpo (`src/index.test.ts`) | No prueba almacenamiento remoto real. |
| `add_attachment` | Ruta local/base64, tope, modo sin disco, 404/413/429 y mime (`src/index.test.ts`, `src/attachments.test.ts`) | No prueba una subida de red real al servidor. |
| `delete_attachment` | DELETE y 404 ajeno/inexistente (`src/index.test.ts`, `src/lumbre-client.test.ts`) | No hay prueba integrada de relectura tras borrar. |
| `mutate_tasks` | Schema de sus 18 ops, lote parcial, resultados, existencia, recurrencia y subtareas (`src/index.test.ts`) | Varias ops solo tienen prueba de forma; el materializado real y la convergencia tras una op parcial son del servidor. |
| `organize` | Schema de sus 10 ops, `create_list` encadenado, `set_list_notes`, `set_parent` y resultados parciales (`src/index.test.ts`) | Varias ops carecen de caso feliz del handler; no equivale a 10 flujos semánticos completos. |
| `list_brl_entries` | **Añadido aquí:** fecha/GET/ids/hora, vacío y respuesta inválida (`src/index.test.ts`) | Sin lectura desde un BRL real de la app. |
| `mutate_brl` | Schema de 3 ops, aislamiento de op inválida, add/update/delete en un batch, ids/orden, existencia y éxito parcial; `noop` sin atribuir `not-found` (`src/index.test.ts`) | Las pruebas usan respuestas simuladas: no acreditan materialización ni convergencia en la cuenta real. |
| `list_habits` | Vivos/archivados, historial ausente, vacío y respuesta inesperada (`src/index.test.ts`, `src/format.test.ts`) | El límite remoto de 10/min y la consistencia del export no se prueban por comportamiento. |

Prioridad de cobertura restante: (1) convertir las operaciones de `mutate_tasks` y `organize` con solo validación de
schema en casos de comportamiento cuando se modifiquen o fallen; (2) usar pruebas de
integración autorizadas para las garantías que dependen del servidor o del sync.
Los tests locales mockean `fetch`; acreditan el contrato del conector, no la versión
servida en `mcp.lumbre.pro` ni la API de `app.lumbre.pro`.
