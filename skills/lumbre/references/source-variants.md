# Evidencia histórica de las copias de origen

Esta referencia conserva procedencia y divergencias para auditar la consolidación. **No es
normativa y no debe cargarse durante una operación normal.** Las decisiones vigentes están
en `SKILL.md` y en las referencias de modo; este fichero no es una segunda skill, un perfil
ni una fuente alternativa de instrucciones.

## Resoluciones de la optimización

- Lectura y día a día no mutan estados de desarrollo; `@acked` se aplica solo al asumir o
  triar dentro del perfil de desarrollo activado.
- El fallback público permite gate y revisión en paralelo sobre un candidato único; las
  reglas vivas del repo pueden exigir revisión final u otra secuencia.
- Límites de dos tareas/seis horas, lotes de tres a seis, herramientas privadas y papeleo
  externo quedan como perfiles opcionales.
- `@not-done` solo opera si el repo o perfil lo define; fuera de él se distinguen
  cancelación, bloqueo, aplazamiento y backlog mediante superficies nativas.
- El gate se descubre en el repo. Esta skill conserva invariantes de evidencia, no una
  lista fija de comandos de una aplicación.
- OAuth/autorización del cliente es el camino normal. La API directa queda limitada a
  diagnóstico explícitamente autorizado, sin secretos en URLs ni salida.
- La retirada de copias antiguas es responsabilidad de un instalador autorizado después
  de demostrar que la fuente canónica es alcanzable; activar la skill nunca la ejecuta.

Las secciones V1–V11 siguientes describen únicamente lo que contenían las fuentes y por
qué una cláusula existe. Ante cualquier diferencia, prevalecen las resoluciones anteriores
y las referencias operativas.

## Identificadores de origen

- **CX-live**: copia activa del runtime Codex.
- **AG-live**: copia activa del runtime Agents.
- **CX-repo**: copia versionada para Codex en el repositorio de configuración.
- **AG-repo**: copia versionada para Agents en el repositorio de configuración.
- **CL-live**: copia activa histórica del runtime Claude.
- **CL-backup**: backup no descubrible del runtime Claude, tratado como fuente potencial.

Los hashes y tamaños exactos están en `docs/lumbre-skill-consolidation.md` del repositorio
canónico. Los datos personales, rutas de usuario y snapshots fechados se generalizaron; la
semántica operativa se mantiene aquí y en las referencias por modo.

La copia distribuible conserva un inventario autocontenido en
[consolidation-manifest.md](consolidation-manifest.md), para que `scripts/validate.sh` no
dependa de instalar también la documentación del repositorio.

## V1 — activación y alcance

- CX describía un flujo más compacto de tareas, backlog y cierre.
- AG enumeraba en el frontmatter taxonomía, herramientas y gate, y activaba la skill para
  cualquier tarea procedente de Lumbre.
- CL-live reducía duplicación y remitía al workflow del repositorio como norma única.
- CL-backup conservaba la versión más extensa, incidencias y reglas operativas eliminadas
  después; se incluyó para no perder información única.
- Las seis fuentes asumían un planificador y repositorio personales concretos.
- La skill pública conserva la suma como tres modos base y dos extensiones, y evita que
  una consulta cotidiana active por defecto el flujo de desarrollo.

## V2 — reconocimiento de estado

- Las seis fuentes exigían `@acked` al leer toda tarea sin estado, incluso durante una
  revisión de lista.
- CL-live y CL-backup añaden que las tareas creadas por el agente nacen reconocidas y que
  `@not-done` es una devolución humana con procedimiento de reapertura.
- El diseño público solicitado exige lectura sin mutación y desarrollo opcional.
- La baseline conservó ambas reglas; la optimización eligió la variante acotada pública y
  mantuvo la estricta únicamente como procedencia histórica.

## V3 — gate y revisión

- AG-live y AG-repo: revisión de código como último paso, después del gate.
- CX-repo: la misma variante de revisión final.
- CX-live, CL-live y CL-backup: gate y revisión en paralelo sobre el mismo SHA candidato; un must-fix crea un SHA
  nuevo y exige nueva evidencia.
- CX-live y las fuentes CL además remiten a la secuencia normativa del repositorio; las
  fuentes AG y CX-repo presentan
  la receta embebida como orden fijo.
- La optimización usa como fallback el paralelismo sobre el mismo candidato; el contrato
  del repo prevalece y puede ordenar una revisión final.

## V4 — captura y delegación

- CX-live y AG-live añaden lectura completa del adjunto y un mapeo estructurado de captura
  antes de editar o delegar.
- CX-repo, AG-repo y CL-live no contienen ese formato; CL-backup contiene una regla visual
  más amplia basada en observar el síntoma real.
- La unión conserva el mapeo y lo condiciona a que el proyecto use ese guardarraíl.

## V5 — batching y checkpoint

- CX-live y AG-live añaden agrupación por causa/superficie, checkpoint con ids y objetivo de
  tres a seis tareas compatibles; una sola no se llama lote salvo excepción explícita.
- CX-repo conserva parte de la agrupación pero no el checkpoint detallado.
- AG-repo carece de ambos párrafos y salta directamente al gate.
- CL-live añade fases, límites de diagnóstico y una única suite pesada simultánea.
- La skill final conserva esas cifras solo como perfiles opcionales.

## V6 — diferencias de plataforma

- Las descripciones CX, AG y CL tienen distinto nivel de detalle y distintos disparadores.
- Un ejemplo de nombre de proyecto y la capitalización de una carpeta difieren; son ruido
  local y se sustituyen por descubrimiento del repositorio.
- La metadata de firma nombraba un runtime distinto en C y A; la baseline dice que se use
  la metadata que el entorno solicite.
- Los dos `agents/openai.yaml` eran byte a byte idénticos; su intención se conserva con una
  descripción pública multimodo.

## V7 — superficies de tareas y documentación

- CX/AG: las tareas del proyecto viven en Lumbre; un gestor externo solo conserva bloqueos
  ajenos al proyecto.
- CL-live y CL-backup: todas las tareas viven en Lumbre y el gestor externo está retirado.
- Todas separan tareas, documentación humana y documentación de máquina. La baseline conserva
  esa separación y deja la elección del gestor al perfil, sin imponer datos personales.

## V8 — fallback API

- Las fuentes CX/AG antiguas nombran el dominio web como base de API.
- CL-live y CL-backup corrigen la base a `https://app.lumbre.pro`, añaden límite de lectura,
  estado dentro de `content` y ausencia de endpoint individual por id.
- La baseline conservó la variante CL; la skill final prefiere OAuth y restringe cualquier
  acceso API directo a diagnóstico autorizado con contrato vivo.

Las fuentes también difieren en el refresh previo: CL-live lo exige antes de toda lectura;
las demás lo presentan como verificación de mutaciones y frescura eventual. La baseline usa
refresh previo cuando importa la frescura y conserva aquí la variante estricta.

## V9 — despliegue

- CX/AG antiguas afirman despliegue por push y observación posterior de CI.
- CL-backup afirma que el push no despliega y que el despliegue web es manual; distingue
  además canales nativos.
- CL-live evita fijar la mecánica y remite al workflow. La optimización no infiere
  despliegue de push y hace prevalecer la norma viva.

## V10 — reglas únicas de CL-backup y CL-live

- Guardarraíl contra sección-por-lote además del `#tag`.
- Evidencia visual o interactiva que mida el síntoma, no solo presencia de código.
- Propiedad, worktrees aislados, misma evidencia sobre el mismo SHA y prueba del artefacto
  servido.
- Fases con parada `HECHO`/`NO_REPRO`/`BLOQUEADO_POR_DATO`, presupuesto diagnóstico de
  perfil, ausencia de tope fijo de agentes y una sola suite pesada simultánea.
- Etiquetas de gate base/UI/docs/rojo para no sobregeneralizar un verde parcial.

## V11 — reglas presentes en las fuentes principales

Sin divergencia material: lista vacía frente a inexistente; separación de superficies de
tareas/documentación; taxonomía tema/lista, sección/bloque y tarea/punto; lote como `#tag`;
`@contexto` frente a `#tag`; no degradar tareas a subtareas; no reconstruir contenido desde
display; batch y verificación async; mover antes de reasignar sección; estado único de agente;
marcadores ortogonales; lectura de notas/adjuntos al revisar; límite de autonomía; gate completo;
QA visual; confirmación de CI/deploy; árbol combinado; documentación honesta; y landmines del
repositorio principal.

## Condición para retirar copias antiguas

No se deben eliminar o desconectar CX-live, AG-live, CX-repo, AG-repo, CL-live ni los
backups descubribles hasta que esta fuente
canónica sea instalable/alcanzable, pase `scripts/validate.sh` y el instalador compruebe que
ambos runtimes resuelven esta misma skill. Después de esa prueba, retirar las otras skills es
obligatorio para evitar selección ambigua o ejecuciones desde contenido obsoleto.

La skill no ejecuta esa retirada. El instalador/migrador debe resolver rutas vivas, mostrar
los objetivos, contar con autorización para la operación destructiva y comprobar después que
solo queda alcanzable la fuente canónica.
