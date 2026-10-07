# Flujo opcional de desarrollo

Esta extensión usa Lumbre como backlog operativo de desarrollo. Está apagada por defecto.
Actívalo solo por petición explícita, al crear tareas de trabajo que hará un agente, al
continuar o gestionar el trabajo de una tarea ya adherida al flujo, o por una regla
vigente del repositorio. Leer, resumir o
inspeccionar una tarea sigue en modo lectura aunque ya contenga un estado de desarrollo;
una lectura incidental nunca reconoce tareas ni carga esta extensión.

## Estado de agente

La máquina de estados pública es:

- asumir o aceptar trabajo → `@acked`;
- empezar o delegar implementación → `@wip`;
- parte del agente revisada y verificada → `@done`;
- devolución humana → `@not-done`;
- reabrir una devolución → `@acked` si queda pendiente o `@wip` si se corrige ya;
- cerrar el lote o el turno con trabajo sin terminar → de vuelta a `@acked` con el
  motivo escrito, según «Cierre: ninguna tarea se queda en `@wip`».

`@wip` es un estado de tránsito, no de reposo: solo vale mientras el trabajo está
realmente en curso. Ninguna tarea termina un lote, una entrega o un turno en `@wip`.

**Dónde se escribe el estado:** como marca `@estado` al final del `content` de la
tarea (`… texto de la tarea @wip`), con una op `update` que lleve solo `taskId` y
`content`. Nunca en el campo `tags` de `mutate_tasks`: el MCP rechaza esos tags de
estado con un error (y no son un estado). Parte del `content` íntegro ya leído en este
encargo (`get_task` de la tarea o, para una subtarea, la línea de `get_task` de su
principal), no del texto de `list_tasks`. El `update` envía el `content` final entero y
no toca `tags`, así que un resultado `aplicada` sin aviso deja acreditado el estado (ver
«Consistencia» en [mcp-safe-operations.md](mcp-safe-operations.md)). El mecánico de
esto es `lumbre-tagger`.

Mantén un solo estado de esa familia al transicionar y conserva tags ortogonales de
lote o backlog. El checkbox y la aceptación humana son independientes. El despliegue
también lo es, salvo que las reglas del proyecto lo incluyan expresamente en `@done`.

Toda tarea que el agente crea para trabajo que hará un agente (código, documentación,
investigación, revisión) nace en `@acked`, y en `@wip` si se empieza en el acto: quien la
crea ya tiene conocimiento de ella. Crearla activa esta extensión por sí sola. Una tarea
cotidiana del usuario (un recado, una cita) nace sin estado. El agente puede poner `@acked`, `@wip` y `@done`; `@not-done` es
exclusivamente una señal humana. Al recibirla, lee nota y adjuntos, retírala al reabrir
y no cierres hasta resolver el feedback. El agente nunca completa el checkbox en nombre
del usuario. Sin esta extensión, distingue cancelada, bloqueada, aplazada y backlog
mediante las superficies nativas.

## Lo que ve el usuario: el tablero

La app tiene una vista opcional, el tablero de agentes, que agrupa las tareas por la
marca de estado de su título: `@acked` en Aceptadas, `@wip` en En curso, `@done` en
Hechas y `@not-done` en No hechas (rótulos actuales en castellano; pueden cambiar).

- Una tarea sin marca no aparece en el tablero.
- El usuario ve cada cambio de marca cuando el agente lo escribe, y un `@wip` olvidado
  se le muestra como atascado pasado un tiempo. Por eso rige «Cierre: ninguna tarea se
  queda en `@wip`».
- `@not-done` llega cuando el usuario devuelve una tarea hecha desde el tablero.

El umbral y la interfaz están en el manual de usuario: <https://lumbre.pro/ayuda/>.

## Subtareas

Una subtarea es una tarea de pleno derecho (límites y lectura en «Preservación y orden» de
[mcp-safe-operations.md](mcp-safe-operations.md)): cuando se trabaja, lleva su propio
estado con el mismo mecanismo que una principal (marca al final de su `content`, op
`update` con el `taskId` de la subtarea). El estado de la principal no sustituye al de la
subtarea ni al revés.

La principal refleja a sus subtareas, no las decide por su cuenta:

- Cuando una subtarea pasa a `@wip`, la principal pasa a `@wip` si no tenía estado o
  estaba en `@acked`.
- La principal solo pasa a `@done` cuando todas sus subtareas están en `@done` o
  cerradas (completadas o canceladas) y el trabajo propio de la principal, si lo
  tiene, está verificado. Terminar una subtarea no pone la principal en `@done`.
- Un `@not-done` en una subtarea devuelve la principal a `@acked` (o `@wip` si se
  corrige ya) si estaba en `@done`.

`get_task` de la principal basta para conocer y cambiar el estado de todas sus subtareas:
no hace falta un `get_task` por subtarea para tocar su marca. Si delegas el cambio en
`lumbre-tagger`, pásale el id de la principal y los de las subtareas explícitamente; el
mecánico no las descubre por sí solo.

## Lotes y checkpoints

- Agrupa por causa y superficie compartida. El lote por defecto es una tarea principal
  con sus subtareas; añade un `#tag` libre solo cuando cruza secciones, proyectos o
  áreas. No lo conviertas en sección por ser un lote de ejecución.
- Antes de delegar, registra ids, alcance, ownership y superficies compartidas cuando
  el riesgo o la concurrencia lo justifique.
- Una sola tarea no se presenta como lote salvo delimitación explícita.
- Checkpoints reproducibles incluyen candidato/branch, árbol, validaciones, bloqueos y
  siguiente acción en proporción al riesgo. Ayudan a reanudar sin imponer ceremonia a
  todo trabajo.
- Al iniciar y delegar trabajo, deja en la conversación un checkpoint proporcional con
  estado, ownership y siguiente paso. En una tarea trivial basta una línea. Escríbelo
  también en las notas solo si lo pide el usuario o el contrato vigente del repositorio.
- Si el inicio escribe `@wip`, confirma esa escritura antes de delegar con el resultado
  de la op (ver «Consistencia»).
- Límites como dos tareas, seis horas o lotes de tres a seis son perfiles opcionales.
  Un presupuesto explícito del usuario prevalece.

## Cierre: ninguna tarea se queda en `@wip`

Al cerrar un lote, al entregar y al terminar el turno, toda tarea en `@wip` sale de
`@wip` por una de estas dos vías, y no hay una tercera:

- **`@done`**: el trabajo del agente está terminado y verificado según el criterio
  vigente.
- **`@acked`**: no se terminó. Devuélvela a `@acked` y escribe el motivo: qué queda
  pendiente, por qué se paró y cuál es el siguiente paso concreto.

El motivo va en la entrega y también en la nota de la tarea. Es la excepción expresa
a la regla de checkpoints de arriba: un `@wip` que no se cierra deja constancia en
Lumbre, porque el usuario lee la tarea, no el historial de la conversación. Detectar
el trabajo a medias es obligación de quien lo dejó, nunca del usuario.

Antes de declarar cerrado un lote o de anunciar una entrega, haz el barrido y
enséñalo: tarea por tarea del lote (principal y subtareas), su marca final y de dónde
consta, contra las lecturas y los resultados «aplicada» de este encargo, no de memoria
ni del plan. Relee solo la tarea cuyo estado no consta por una escritura propia
aplicada, o que pudo cambiar por otra vía: para un lote principal + subtareas,
`get_task` de la principal trae el `content` y la marca de cada una; para un lote
marcado con `#tag` por cruzar proyectos, lista el proyecto (o `scope:"all"`) y filtra
por el tag en el resultado. Confirma que ninguna, principal o subtarea, sigue en
`@wip`. Mientras quede una sin resolver, no anuncies el lote cerrado, no lo des por
entregado y no pases al siguiente.

Matices:

- Si el trabajo sigue vivo y lo continúas en el mismo turno, no hay cierre: mantén
  `@wip` y termínalo. Parar el turno con la tarea en `@wip` sí es un cierre.
- Una tarea bloqueada por un tercero, por una decisión del usuario o por falta de
  datos también vuelve a `@acked`, con el bloqueo nombrado como motivo.
- La tarea devuelta conserva su `#tag` de lote, su nota y su evidencia. No se borra
  el trabajo hecho ni se reescribe para que parezca no empezada.
- Terminar en `@done` exige la verificación que pida el criterio vigente. Ante la
  duda entre `@done` sin verificar y `@acked` con motivo, es `@acked`.
- Una principal que queda con subtareas sin terminar sale de `@wip` a `@acked` con un
  motivo que nombra qué subtareas faltan, no un motivo genérico.

## Evidencia

Lee notas y adjuntos relevantes antes de editar, delegar o revisar una tarea cerrada.
Una vez leídos en el encargo, reutilízalos; se vuelven a leer solo si pudieron cambiar
(ver «Identidad y lectura íntegra» en [mcp-safe-operations.md](mcp-safe-operations.md)).
Si el proyecto exige mapear una captura antes de escribir, conserva este formato en el
canal autorizado:

`MAPEO_CAPTURA task=<uuid> attachment=<uuid> element="<elemento>" surface=<web|native-ios|native-macos|native-linux|native-shared> target="<fichero/componente>"`

La superficie es donde se renderiza el elemento. Explorar en lectura puede continuar;
editar o delegar espera al mapeo solo cuando el contrato del repo lo exige. No publiques
el mapeo en una tarea u otra superficie externa sin autorización.

Una prueba debe medir el síntoma: para aspecto o layout inspecciona la superficie y el
estado reales; para interacción ejecuta el gesto. Si no es posible, declara el QA
pendiente. No presentes una prueba focal como gate global.

## Delegación y ejecución

Delegar no transfiere la intención, integración ni el veredicto de la sesión
coordinadora. Respeta ownership y aislamiento; no impongas un máximo universal de
agentes. Evita suites, builds o navegadores pesados simultáneos cuando compitan por CPU,
puertos o estado compartido.

Los protocolos de fases, diagnósticos con parada `HECHO`/`NO_REPRO`/
`BLOQUEADO_POR_DATO` y presupuestos rígidos son perfiles opcionales, no el flujo público.
