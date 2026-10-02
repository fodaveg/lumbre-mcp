# Optimización de la skill global de Lumbre

Estado: candidata optimizada sobre la baseline congelada `e6dff13`. La integridad
semántica está validada 32/32, el gate comprueba integridad y privacidad de la evidencia
y 109 controles negativos. El piloto conductual y la observación longitudinal son
evidencia informativa post-publicación, no gates de release.

**La recaptura de la skill actual existe y quedó roja: 8/12 contratos.** El piloto
anterior sigue siendo histórico: se capturó sobre un router de 95 líneas y un commit
(`0957116`) ausente. La captura nueva está anclada a `f36f345` y su integridad pasa;
`tests/skill-lumbre/validate.sh --require-pilot` distingue esa integridad del resultado
conductual, que se conserva rechazado en el recibo de evidencia. El piloto es
informativo, no un gate de release.

## Método

1. Se tomó como única entrada la unión de seis cuerpos divergentes ya inventariada.
2. Se resolvieron contradicciones mediante las decisiones de producto, sin partir de una
   copia preferida.
3. Se separó el router corto de seis referencias operativas por modo y una referencia
   de seguridad para escrituras (desde octubre de 2026, ocho: se añaden subagentes y
   adjuntos/conexión, de lectura bajo demanda).
4. `tests/skill-lumbre/evidence/consolidation-manifest.md` y `source-variants.md`
   permanecen como evidencia repo-only. Ninguna cláusula se eliminó solo por parecer
   redundante.

Ante duda se conservó duplicación. La reducción afecta instrucciones repetidas,
recetas locales y contradicciones ya resueltas, no la cobertura.

## Disposición de las 32 cláusulas

| ID | Disposición final |
|---|---|
| S01 | Tres modos base y dos extensiones en `SKILL.md`; desarrollo queda apagado por defecto. |
| S02 | Las reglas vivas del repo prevalecen y se descubren antes de operar. |
| S03 | Lista vacía frente a inexistente se conserva en router, seguridad y backlog. |
| S04 | Separación de tareas/documentación vive en release; variantes externas son perfil. |
| S05 | Tema/lista, sección/bloque, punto/tarea y lote/tag permanecen en backlog. |
| S06 | Sección-por-lote sigue prohibida; lote es `#tag`. |
| S07 | Hub configurado y métricas sin hijas permanecen protegidos. |
| S08 | Una tarea real no se degrada a subtarea; residencia se preserva. |
| S09 | `@contexto` controlado y `#tag` libre siguen diferenciados. |
| S10 | Contenido crudo obligatorio antes de reeditar; no se usa display enriquecido. |
| S11 | Updates parciales, batch y orden mover→sección permanecen en seguridad. |
| S12 | Escritura eventual se relee; `refresh_sync` fuerza el flush de cambios ya recibidos y se clasifica como lectura. |
| S13 | OAuth es normal; API directa queda solo para diagnóstico autorizado y seguro. |
| S14 | `@acked`→`@wip`→`@done`, un solo estado y tags ortogonales, solo en desarrollo. |
| S15 | Una creación nace `@acked` únicamente dentro del flujo dev ya activado. |
| S16 | `@not-done` queda como señal exclusivamente humana; fallback usa estados nativos. |
| S17 | Estado de agente, checkbox, aceptación y deploy se separan. |
| S18 | Notas y adjuntos se leen antes de editar, delegar o revisar cierre. |
| S19 | `MAPEO_CAPTURA` exacto se conserva cuando el repo exige el guardarraíl. |
| S20 | QA visual/interactivo mide el síntoma real y declara lo pendiente. |
| S21 | Dos tareas/seis horas queda como perfil opcional, nunca límite público. |
| S22 | Agrupar por causa, checkpoint y cifras 3–6 quedan proporcionales/opcionales. |
| S23 | Delegación y fases se conservan; presupuestos rígidos quedan como perfil. |
| S24 | Suite pesada aislada, prueba focal ≠ gate y categorías de gate se conservan. |
| S25 | Gate se descubre en el repo; no se incrusta una receta de la app. |
| S26 | Fallback paralelo sobre candidato único; el repo puede exigir revisión final. |
| S27 | QA por estado/superficie y modo de prueba se descubren en el repo. |
| S28 | Rol, ownership, aislamiento, worktree y candidato común permanecen. |
| S29 | Push no demuestra deploy; se verifica canal y artefacto solicitado. |
| S30 | Cierre actualiza solo superficies declaradas y comunica evidencia honesta. |
| S31 | Landmines locales no se universalizan; se descubren sus equivalentes vivos. |
| S32 | Metadata UI única permanece; runtime y firma los decide el entorno. |

Resultado: **32/32 cláusulas cubiertas**. El manifiesto distribuible mantiene la misma
matriz para poder comprobar una instalación aislada.

## Recomendaciones del experto de productividad

| Recomendación | Decisión | Motivo |
|---|---|---|
| Router pequeño y progressive disclosure | Aceptada | El router queda bajo 120 líneas y lectura enlaza solo su referencia pertinente. |
| Referencias por modo | Aceptada | Lectura/día, backlog, desarrollo y release están separados; seguridad se carga al escribir. |
| Cero mutaciones en lectura | Aceptada | Excluye estados y permite el flush no mutante de cambios ya recibidos. |
| No revisar toda la lista por sesión | Aceptada | La lectura se acota por fecha, lista o ids salvo necesidad explícita. |
| Checkpoints útiles para TDAH/TEA sin ceremonia universal | Aceptada | Se exigen en proporción a riesgo, concurrencia o reanudación. |
| Perfil dev apagado por defecto | Aceptada | Solo petición, continuidad de tarea o regla viva del repo lo activan. |
| Límites personales como perfil | Aceptada | Dos tareas/seis horas y tamaños de lote no son universales. |
| Medir dieciséis escenarios | Aceptada | La batería conserva 16 escenarios; el arnés selecciona P01–P12 y registra el resultado sin convertirlo en gate. |
| Piloto real durante dos semanas | Diferida, no bloqueante | Requiere uso longitudinal; no puede simularse con validación local. |

No se rechazó ninguna recomendación. La parte longitudinal diferida no bloquea la
publicación ni impide declarar terminada la consolidación y optimización estructural.

## Batería de dieciséis escenarios

El arnés separa físicamente entradas y resultados:

- `tests/skill-lumbre/evidence/forward-prompts.md` contiene solo ID y petición. Es el
  único fichero de evaluación que recibe el agente antes de responder.
- `tests/skill-lumbre/evidence/forward-expectations.md` contiene modos, contratos y
  negativos. El coordinador lo abre únicamente después de recoger los resultados.

La batería mantiene dieciséis casos: cuatro de lectura, seis combinados de día a día y
desarrollo, y seis combinados de backlog y release. P02 prueba de forma explícita que
resumir una tarea ya marcada `@wip` sigue siendo lectura, no carga desarrollo y no muta.
P13–P16 añaden ambigüedad, reorganización abierta, release sin mutación y reapertura de
`@not-done`. El validador comprueba que prompts y oráculo tienen los mismos 16 IDs y que ningún
contrato observable aparece en el fichero ciego.

Cada preregistración permite una sola captura. Una salida roja se conserva como
evidencia y detiene ese piloto; no se encadenan ajustes y recapturas en el mismo lote.

Métricas del piloto: tiempo hasta la primera acción útil, referencias/líneas cargadas,
mutaciones no solicitadas y sobrecarga percibida. Umbrales propuestos: cero mutaciones
incidentales en P01–P06, cero acciones externas por activación en P12 y ausencia de
revisión completa del backlog salvo petición. El tiempo y la sobrecarga no se inventan:
se anotarán durante el piloto.

## Reducción de contexto estructural

| Ruta de modo | Baseline | Candidata | Cambio |
|---|---:|---:|---:|
| Router | 76 líneas | 95 líneas | +25,0% |
| Lectura (router + referencia) | 109 | 118 | +8,3% |
| Backlog con seguridad de escritura | 193 | 200 | +3,6% |
| Desarrollo con gestión cotidiana y seguridad | 251 | 248 | −1,2% |
| Release con seguridad de escritura | 247 | 206 | −16,6% |
| Núcleo operativo completo | 422 | 367 | −13,0% |

La baseline pedía además cargar `source-variants.md` en desarrollo/release; la candidata
lo retira del camino operativo, pero conserva el fichero y el manifiesto como evidencia.
Estas son líneas, no tokens ni tiempo medido.

## Auditoría de octubre de 2026

Cambios sobre la candidata, medidos en bytes (`wc -c`), no en tokens:

| Fichero | Antes | Después |
|---|---:|---:|
| `SKILL.md` | 6 404 | 5 806 |
| `references/read.md` | 1 413 | 1 786 |
| `references/daily.md` | 3 275 | 3 758 |
| `references/backlog.md` | 3 358 | 3 337 |
| `references/development.md` | 8 821 | 8 815 |
| `references/mcp-safe-operations.md` | 6 572 | 5 872 |
| `references/project-release.md` | 2 774 | 2 774 |
| `references/attachments-and-connection.md` (nueva) | 0 | 1 606 |
| `references/subagents.md` (nueva) | 0 | 1 472 |
| `assets/subagents/contracts.json` | 10 550 | 11 094 |

| Flujo | Antes | Después |
|---|---:|---:|
| «apúntame X» (router + daily + seguridad) | 16 251 | 15 436 |
| Estado de desarrollo (router + development + seguridad) | 21 797 | 20 493 |

Qué cambió:

- Los adjuntos y la autorización, y el bloque de subagentes, salen de la ruta de toda
  escritura a dos referencias que solo se leen bajo demanda; las referencias públicas
  pasan de seis a ocho.
- La skill ya no dice que las escrituras «se encolan»: el informe de cada op dice si se
  aplicó, y solo «aplicada» cuenta como hecho.
- La lectura íntegra se exige antes de reeditar `content` o `notes`, de delegar o cuando la
  decisión dependa de un campo no leído; no antes de cualquier mutación.
- La regla de no releer una op aplicada y la de subtareas tienen una sola definición
  (`mcp-safe-operations.md`); el resto remite. `contracts.json` no puede remitir y las
  acorta.
- Se retiran las menciones a `ids` y `#tag` como parámetros de `list_tasks`, la afirmación
  de que no hay áreas creables y el límite «solo admite» de `mutate_tasks` (ahora es el
  límite del encargo). Se añaden hábitos, `restore`, archivado, «esperando», vínculos de
  nota y registro BRL.
- Claude recibe por defecto los tres prefijos reales del conector.
- `tests/skill-lumbre/validate-tool-names.mjs` comprueba contra `src/tools/` que las tools,
  ops y parámetros citados por la skill existen.

## Recaptura conductual del 2 oct 2026

Se congelaron 13 ficheros de criterio antes de una única invocación de Codex CLI
0.160.0 con `gpt-6.1-sol`. El candidato `f36f345a619be19a3e91adcd80219b84f97c0564`
incluye el router y las ocho referencias actuales. El runner aisló ese bundle con
sandbox de solo lectura y sin configuración de MCP ni acceso a herramientas del
evaluador. Los bytes del envelope y del JSONL están en
`tests/skill-lumbre/evidence/forward-pilot-current.*`.

Resultado preregistrado: **8/12, captura rechazada**. P02 volvió a copiar `@wip`
preexistente a `devState` durante una lectura pura, aunque no propuso mutaciones:
ese campo puede representar el estado observado y el fallo no demuestra una
transición de desarrollo. P03 omitió `list_tasks` tras
`list_lists`; P09 empezó por `list_lists` y marcó que la propuesta abierta requiere
confirmación; P10 ejecutó mover y reasignar sección para cada una de las dos tareas
en lugar de representar un único par de operaciones en batch, con verificaciones
intermedias que pueden ser redundantes. Los cuatro cuentan
como fallos del oráculo congelado. En P03/P09/P10 hay tensión entre ese oráculo y la
redacción vigente de la skill; no se cambió el criterio después de ver la salida ni
se recapturó para reinterpretar el resultado.

La integridad dio verde: 4 eventos, cero llamadas a tools, shell o MCP, cero
mutaciones de fichero y cero rutas privadas. Tiempo observado del batch: 54.985 ms;
40.377 tokens de entrada y 1.690 de salida según `turn.completed`. La media por
caso sería derivada, no tiempo individual. Los 109 controles negativos del
verificador y `validate.sh --require-pilot` pasaron. Su exit 0 certifica que la
captura es auténtica y que el rechazo conductual está registrado, no que los doce
casos hayan acertado.

## Retirada de copias antiguas

La retirada sigue siendo obligatoria para evitar falsas ejecuciones, pero pertenece al
instalador autorizado. Solo procede cuando la candidata esté integrada en una ubicación
duradera, pase validación y ambos runtimes demuestren que resuelven exactamente la fuente
canónica. Activar un modo o la propia skill no autoriza esa operación destructiva.
