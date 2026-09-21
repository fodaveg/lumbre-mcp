# Flujo opcional de desarrollo

Esta extensión usa Lumbre como backlog operativo de desarrollo. Está apagada por defecto.
Actívalo solo por petición explícita, al continuar o gestionar el trabajo de una tarea
ya adherida al flujo, o por una regla vigente del repositorio. Leer, resumir o
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
`content`. Nunca en el campo `tags` de `mutate_tasks`: eso crea una etiqueta `#wip`,
que no es un estado. Parte del `content` íntegro de `get_task`, no del texto de
`list_tasks`, y después verifica con `get_task` que el contenido acaba en la marca y que
`tags propios` no la lleva. El mecánico de esto es `lumbre-tagger`.

Mantén un solo estado de esa familia al transicionar y conserva tags ortogonales de
lote o backlog. El checkbox y la aceptación humana son independientes. El despliegue
también lo es, salvo que las reglas del proyecto lo incluyan expresamente en `@done`.

Una tarea creada durante un flujo de desarrollo activo puede nacer `@acked`; una tarea
cotidiana no. El agente puede poner `@acked`, `@wip` y `@done`; `@not-done` es
exclusivamente una señal humana. Al recibirla, lee nota y adjuntos, retírala al reabrir
y no cierres hasta resolver el feedback. El agente nunca completa el checkbox en nombre
del usuario. Sin esta extensión, distingue cancelada, bloqueada, aplazada y backlog
mediante las superficies nativas.

## Lotes y checkpoints

- Agrupa por causa y superficie compartida. El lote es un `#tag`, nunca una sección.
- Antes de delegar, registra ids, alcance, ownership y superficies compartidas cuando
  el riesgo o la concurrencia lo justifique.
- Una sola tarea no se presenta como lote salvo delimitación explícita.
- Checkpoints reproducibles incluyen candidato/branch, árbol, validaciones, bloqueos y
  siguiente acción en proporción al riesgo. Ayudan a reanudar sin imponer ceremonia a
  todo trabajo.
- Al iniciar y delegar trabajo, deja en la conversación un checkpoint proporcional con
  estado, ownership y siguiente paso. En una tarea trivial basta una línea. Escríbelo
  también en las notas solo si lo pide el usuario o el contrato vigente del repositorio.
- Si el inicio escribe `@wip`, verifica esa escritura antes de delegar.
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
enséñalo: lista las tareas del lote por su `#tag`, comprueba su estado real en Lumbre
(no de memoria ni del plan) y confirma que ninguna sigue en `@wip`. Mientras quede
una sin resolver, no anuncies el lote cerrado, no lo des por entregado y no pases al
siguiente.

Matices:

- Si el trabajo sigue vivo y lo continúas en el mismo turno, no hay cierre: mantén
  `@wip` y termínalo. Parar el turno con la tarea en `@wip` sí es un cierre.
- Una tarea bloqueada por un tercero, por una decisión del usuario o por falta de
  datos también vuelve a `@acked`, con el bloqueo nombrado como motivo.
- La tarea devuelta conserva su `#tag` de lote, su nota y su evidencia. No se borra
  el trabajo hecho ni se reescribe para que parezca no empezada.
- Terminar en `@done` exige la verificación que pida el criterio vigente. Ante la
  duda entre `@done` sin verificar y `@acked` con motivo, es `@acked`.

## Evidencia

Lee notas y adjuntos relevantes antes de editar, delegar o revisar una tarea cerrada.
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
