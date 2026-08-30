# Flujo opcional de desarrollo

Este perfil usa Lumbre como backlog operativo de desarrollo. Está apagado por defecto.
Actívalo solo por petición explícita, al continuar o gestionar el trabajo de una tarea
ya adherida al flujo, o por una regla vigente del repositorio. Leer, resumir o
inspeccionar una tarea sigue en modo lectura aunque ya contenga un estado de desarrollo;
una lectura incidental nunca reconoce tareas ni carga este perfil.

## Estado de agente

El flujo público es `@acked` → `@wip` → `@done`:

- `@acked`: la tarea fue asumida o triada conscientemente dentro del perfil activo;
- `@wip`: empezó el trabajo o se delegó una parte de la implementación;
- `@done`: la parte del agente está implementada, revisada y verificada según el
  contrato del proyecto.

Mantén un solo estado de esa familia al transicionar y conserva tags ortogonales de
lote o backlog. El checkbox y la aceptación humana son independientes. El despliegue
también lo es, salvo que las reglas del proyecto lo incluyan expresamente en `@done`.

Una tarea creada durante un flujo de desarrollo activo puede nacer `@acked`; una tarea
cotidiana no. `@not-done` solo existe cuando el repositorio o perfil lo define como señal
humana de devolución. En ese caso, lee nota y adjuntos, retíralo al reabrir, pasa a
`@wip` si la corrección empieza o a `@acked` si queda pendiente, y no cierres hasta
resolver el feedback. Sin ese perfil, distingue cancelada, bloqueada, aplazada y backlog
mediante las superficies nativas.

## Lotes y checkpoints

- Agrupa por causa y superficie compartida. El lote es un `#tag`, nunca una sección.
- Antes de delegar, registra ids, alcance, ownership y superficies compartidas cuando
  el riesgo o la concurrencia lo justifique.
- Una sola tarea no se presenta como lote salvo delimitación explícita.
- Checkpoints reproducibles incluyen candidato/branch, árbol, validaciones, bloqueos y
  siguiente acción en proporción al riesgo. Ayudan a reanudar sin imponer ceremonia a
  todo trabajo.
- Al iniciar y delegar trabajo, deja visible un checkpoint proporcional con estado,
  ownership y siguiente paso. En una tarea trivial basta una línea; no exige un dossier.
- Límites como dos tareas, seis horas o lotes de tres a seis son perfiles opcionales.
  Un presupuesto explícito del usuario prevalece.

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
