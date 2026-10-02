# Seguimiento del audit de lumbre-mcp (2 oct 2026)

Alcance: las tareas `bab4ece7-6ca3-4607-bb97-625fbb42aff3` y
`eab403ce-c636-4e6f-a8c7-6505ceb75bf9`. Candidato de partida `b311bba`;
las mediciones de producción de este documento corresponden a ese candidato,
no certifican los cambios posteriores. Fedora y Windows quedan fuera del
encargo por instrucción explícita de David en esta sesión.

## Revisión de las tres superficies pendientes

Se inventarió el rango `7883f76..b311bba` para `src/http.ts`,
`src/existence-cache.ts` y `src/tools/shared.ts`: ninguno cambió en ese
rango. Se leyeron completos los tres ficheros vigentes (564, 256 y 316
líneas respectivamente), sus consumidores y las pruebas pertinentes.

- HTTP: se contrastaron autorización por petición, aislamiento de notas,
  precedencia de cabecera, rechazo de Host/Origin, límite del cuerpo, rutas
  OAuth y cierre del transporte. Una sonda local con un método JSON-RPC
  ficticio reprodujo que `describeMethod` volcaba literalmente ese texto al
  log (`logLeaksFakeSecret:true`). El candidato `6a598a8` lo corrige con una
  lista cerrada de métodos y texto fijo para errores internos. La prueba
  negativa falló antes; 38 pruebas HTTP y la sonda compilada pasaron después
  (`logLeaksFakeSecret:false`). La revisión de ese diff no detectó otros
  defectos en el alcance comprobado.
- Cachés: se comprobó el TTL de cinco segundos, exclusión de archivadas,
  invalidación local, claves por día/id en BRL, separación por token,
  expulsión por inactividad y límite LRU de 200 tokens. No se detectó otro
  defecto de corrección en ese alcance. No se midió crecimiento de heap ni
  comportamiento con réplicas del servicio.
- Shared: se contrastaron informes parciales, advertencia de notas ocultas,
  enrutado de operaciones entre tools, recurrencia parcial y esquemas
  estrictos/laxos. No se detectó otro defecto de corrección en ese alcance.

Los tests focales y la validación del candidato combinado se consignan en
el commit de entrega. Esta revisión no sustituye una auditoría completa de
OAuth o de la app.

## Decisiones de compatibilidad

Se conserva `notes:"preview"` en este cambio. Es una opción explícita
heredada que descarga notas completas y las recorta; retirarla rompería
llamadas existentes sin una migración de contrato. El modo recomendado
sigue siendo `auto`, y `none` sirve cuando no hace falta texto. Una retirada
futura requiere decidir su migración y comunicarla antes de cambiar el
enum. Es una decisión técnica de este encargo, no una cita de David.

Se conservan `attachment_id`, `file_path` y `content_base64`, conforme a la
decisión ya documentada del audit: renombrarlos rompe clientes existentes
sin mejorar el comportamiento del adjunto. Este seguimiento no introduce
un cambio rompedor ni aliases que aumenten `tools/list`.

## Medición con datos reales

David autorizó expresamente medir con su cuenta en `app.lumbre.pro` y
`mcp.lumbre.pro`, guardando solo recuentos y tamaños. Se usó el cliente MCP
real (`createServer`, SDK e implementación de tools) de `b311bba`, Node
22.22.3, con caché de existencia reiniciada y huella de notas aislada en
memoria. `fetch` registró tamaño de respuestas, ruta, parámetros de
proyección y status; nunca contenido de tareas ni credenciales.

Los bytes son UTF-8 del cuerpo JSON después de descompresión: excluyen
cabeceras HTTP, TLS y compresión. Las lecturas son sucesivas, no una
instantánea transaccional. Cada `scope=all` pidió `limit=500` y devolvió 237
tareas; este caso real no prueba el aviso de corte a 500.

| Tool / modo | Bytes descargados de la app | Bytes del resultado MCP |
| --- | ---: | ---: |
| `list_tasks`, `full` | 283786 | 149459 |
| `list_tasks`, `none` | 175116 | 39650 |
| `list_tasks`, `auto`, huella fría | 220559 | 66450 |
| `list_tasks`, `auto`, huella caliente | 182068 | 43218 |

La descarga incluye las consultas de resolución de referencias cuando
existen. `full` hizo una lectura adicional de referencia (718 bytes).
`auto` pidió `notes=length` y recuperó solo las notas seleccionadas.

Una llamada real de `mutate_tasks` sobre la subtarea de medición usó
`GET /api/tasks?ids=...&notes=none`: 831 bytes en la primera captura, más
133 bytes de respuesta batch, 964 bytes en total. La operación fue aplicada
y solo añadió su marca `@wip`. La segunda captura mantuvo ese mismo valor
y reportó correctamente un no-op: 833 + 133 = 966 bytes. No se escribieron
otras tareas durante la medición.

`tools/list` remoto y local coincidieron: 17 tools, 26441 caracteres del
array; 26739 bytes del objeto `result` y 26773 bytes del sobre JSON-RPC.
Tiktoken 0.14.0 contó el JSON de `result` (sin sobre): **6914 tokens con
`o200k_base` y 7079 con `cl100k_base`**. Son conteos de esas codificaciones,
no el coste completo de una sesión ni una equivalencia universal entre
proveedores.

La evidencia temporal está en
`/private/tmp/lumbre-mcp-root-evidence-20261002/`: `measure.mjs`,
`measurements.json`, `token-counts.json` y la sonda `probe-http-log.mjs`.
Es local y otra máquina puede no conservarla. Los valores y el método
necesarios para evaluar el resultado quedan versionados aquí.

## Permiso ejecutable del despliegue

`deploy/publicar.sh` pasa de modo Git 100644 a 100755. `bash -n` pasó;
la invocación directa con `LUMBRE_MCP_HOST=-invalid` arrancó y terminó con
exit 1 y el rechazo esperado del host, antes de compilar o conectar. Esa
prueba demuestra que el fallo de permiso se corrigió sin desplegar nada.
