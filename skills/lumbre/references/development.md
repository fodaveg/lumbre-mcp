# Flujo opcional de desarrollo

Este modo convierte Lumbre en backlog operativo de un trabajo de desarrollo. No se
aplica a tareas del día a día. Actívalo por petición explícita, por continuidad de una
tarea que ya usa estos contextos o por una regla vigente del repositorio.

## Estado de agente

El flujo conservado es `@acked` → `@wip` → `@done`:

- `@acked`: la tarea fue leída y entendida dentro del flujo activado.
- `@wip`: el agente empezó a trabajar o delegó la implementación.
- `@done`: la parte del agente está implementada, revisada y correcta; normalmente
  también integrada/desplegada si así lo exige el proyecto. No sustituye el checkbox de
  aceptación del usuario.

Mantén un solo contexto de esa familia: elimina el anterior al transicionar y conserva
marcadores ortogonales como lote, siguiente lote o backlog. Si algo no es verificable,
no lo presentes como verificado; la variante heredada permite `@done` con una nota
explícita solo cuando el contrato del proyecto lo autoriza.

La baseline conserva dos políticas incompatibles para `@acked`:

- **Variante estricta heredada**: toda tarea sin estado se marca `@acked` al leer una
  lista dentro de una sesión de desarrollo.
- **Variante acotada pública**: solo se marca `@acked` al asumir o triar explícitamente
  una tarea; una lectura incidental nunca muta.

Las reglas del repositorio o una preferencia configurada seleccionan la variante. Sin
esa señal usa la acotada y registra la contradicción para la futura optimización.

En la variante estricta, una tarea creada por el agente nace `@acked`, salvo que su estado
real ya sea `@wip` o `@done`. El checkbox puede estar reservado a la aceptación humana por
el perfil del proyecto; no lo marques si esa reserva existe.

### Trabajo devuelto

Una fuente adicional introduce `@not-done` como señal humana de devolución, no como estado
que el agente deba inventar. Cuando ese perfil esté activo:

1. retira `@not-done` y cualquier `@done` incompatible;
2. pasa a `@wip` si se corrige ya o a `@acked` si queda pendiente;
3. lee la nota y todos los adjuntos antes de tocar código;
4. si no hay feedback, contrasta título, aceptación y resultado en vez de adivinar;
5. no vuelvas a `@done` hasta resolver la devolución.

Esta regla convive con la decisión pública de no usar un `@not-done` genérico en tareas
cotidianas: solo pertenece al perfil de desarrollo que lo defina.

## Lotes y checkpoints

- Agrupa tareas por causa y superficie compartida. Un lote normal reúne varias tareas
  compatibles y paga un único gate combinado.
- Antes de despachar un lote, enumera ids, alcance y superficie/archivos compartidos.
- Una sola tarea no se presenta como lote salvo que el usuario la haya delimitado o no
  exista una segunda tarea compatible.
- La variante heredada propone de tres a seis tareas por lote; se conserva como perfil,
  no como requisito universal.
- No encadenes trabajo indefinidamente bajo una instrucción abierta. La variante heredada
  detiene la apertura de trabajo nuevo tras dos tareas cerradas o seis horas, termina solo
  el gate ya en curso y deja un checkpoint limpio. Un presupuesto explícito la sustituye.

## Evidencia y adjuntos

Antes de editar o delegar una tarea con adjuntos, léelos completos y relaciona cada uno
con el elemento señalado, la superficie de runtime y el objetivo de código. Si el proyecto
usa el guardarraíl heredado, publícalo en el canal de estado o commentary que ese contrato
indique —nunca en una tarea, nota o sistema externo sin autorización— con este formato:

`MAPEO_CAPTURA task=<uuid> attachment=<uuid> element="<elemento>" surface=<web|native-ios|native-macos|native-linux|native-shared> target="<fichero/componente>"`

La superficie describe dónde se renderiza el elemento, no el sistema operativo nombrado
en la conversación. La exploración de solo lectura puede continuar aunque falte el mapeo;
la edición o delegación espera a contar con él cuando la regla del proyecto lo exige.

Una tarea `@done` que se revisa incluye código, notas y adjuntos. El feedback en un adjunto
no desaparece porque el título ya lleve un estado de cierre.

Si la tarea describe algo visual —aspecto, posición, tamaño, animación o ausencia—, una
prueba de código no verifica el síntoma. Captura o inspecciona la superficie real y el
estado concreto; si no es posible, declara el QA pendiente. La misma regla exige ejecutar
el gesto real cuando el fallo es interactivo: presencia de UI y comportamiento no son la
misma evidencia.

## División de responsabilidades

La implementación, depuración y tests no triviales pueden delegarse a especialistas cuando
el entorno lo permita. La sesión coordinadora conserva intención, decisiones, verificación,
integración y veredicto. Los cambios de estado puntuales y el papeleo pueden delegarse a
roles específicos si existen, pero la skill no presupone nombres de agentes concretos.

Una fuente heredada añade ejecución por fases para trabajos no acotados: cada fase conserva
objetivo, autoridad/worktree, hechos, primera acción, árbol de decisión, parada y formato de
respuesta. Para un diagnóstico focal proponía como perfil diez minutos, una construcción y
dos corridas; al obtener el dato binario, entrega `HECHO`, `NO_REPRO` o
`BLOQUEADO_POR_DATO`. Se conserva como variante configurable, no como límite universal.

No impongas un máximo fijo de agentes desde la skill. Sí evita dos procesos pesados de gate,
build, navegador e2e o suite completa a la vez cuando compitan por CPU o estado compartido.
Mientras el código cambia, llama a la evidencia dirigida «prueba focal», nunca gate global.
