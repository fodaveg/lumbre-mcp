# Optimización de la skill global de Lumbre

Estado: candidata optimizada sobre la baseline congelada `e6dff13`. La integridad
semántica está validada 32/32; el piloto real de dos semanas queda pendiente y por eso
este documento no declara terminada la optimización de producto.

## Método

1. Se tomó como única entrada la unión de seis cuerpos divergentes ya inventariada.
2. Se resolvieron contradicciones mediante las decisiones de producto, sin partir de una
   copia preferida.
3. Se separó el router corto de cuatro referencias operativas por modo y una referencia
   de seguridad para escrituras.
4. `consolidation-manifest.md` y `source-variants.md` permanecen como evidencia no cargada
   normalmente. Ninguna cláusula se eliminó solo por parecer redundante.

Ante duda se conservó duplicación. La reducción afecta instrucciones repetidas,
recetas locales y contradicciones ya resueltas, no la cobertura.

## Disposición de las 32 cláusulas

| ID | Disposición final |
|---|---|
| S01 | Cinco modos discriminados en `SKILL.md`; desarrollo queda apagado por defecto. |
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
| S12 | Escritura eventual se relee; refresh con efectos se clasifica como mutación. |
| S13 | OAuth es normal; API directa queda solo para diagnóstico autorizado y seguro. |
| S14 | `@acked`→`@wip`→`@done`, un solo estado y tags ortogonales, solo en desarrollo. |
| S15 | Una creación nace `@acked` únicamente dentro del flujo dev ya activado. |
| S16 | `@not-done` queda como perfil explícito; fallback usa estados nativos. |
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
| Router pequeño y progressive disclosure | Aceptada | El router pasa de 76 a 58 líneas y solo enruta referencias pertinentes. |
| Referencias por modo | Aceptada | Lectura/día, backlog, desarrollo y release están separados; seguridad se carga al escribir. |
| Cero mutaciones en lectura | Aceptada | Incluye estados y refresh con efectos. |
| No revisar toda la lista por sesión | Aceptada | La lectura se acota por fecha, lista o ids salvo necesidad explícita. |
| Checkpoints útiles para TDAH/TEA sin ceremonia universal | Aceptada | Se exigen en proporción a riesgo, concurrencia o reanudación. |
| Perfil dev apagado por defecto | Aceptada | Solo petición, continuidad de tarea o regla viva del repo lo activan. |
| Límites personales como perfil | Aceptada | Dos tareas/seis horas y tamaños de lote no son universales. |
| Medir doce escenarios | Aceptada parcialmente | La batería y criterios quedan definidos y revisados estáticamente; falta piloto real. |
| Piloto real durante dos semanas | Diferida | Requiere uso longitudinal; no puede simularse con validación local. |

No se rechazó ninguna recomendación. La parte diferida no bloquea probar la candidata,
pero sí impide declarar terminada la optimización de producto.

## Batería de doce escenarios

El arnés separa físicamente entradas y resultados:

- `skills/lumbre/references/forward-prompts.md` contiene solo ID y petición. Es el
  único fichero de evaluación que recibe el agente antes de responder.
- `skills/lumbre/references/forward-expectations.md` contiene modos, contratos y
  negativos. El coordinador lo abre únicamente después de recoger los resultados.

La batería mantiene doce casos: cuatro de lectura, cuatro combinados de día a día y
desarrollo, y cuatro combinados de backlog y release. P02 prueba de forma explícita que
resumir una tarea ya marcada `@wip` sigue siendo lectura, no carga desarrollo y no muta.
El validador comprueba que prompts y oráculo tienen los mismos 12 IDs y que ningún
contrato observable aparece en el fichero ciego.

Métricas del piloto: tiempo hasta la primera acción útil, referencias/líneas cargadas,
mutaciones no solicitadas y sobrecarga percibida. Umbrales propuestos: cero mutaciones
incidentales en P01–P06, cero acciones externas por activación en P12 y ausencia de
revisión completa del backlog salvo petición. El tiempo y la sobrecarga no se inventan:
se anotarán durante el piloto.

## Reducción de contexto estructural

| Ruta de modo | Baseline | Candidata | Cambio |
|---|---:|---:|---:|
| Router | 76 líneas | 58 líneas | −23,7% |
| Lectura/día (router + referencia) | 109 | 95 | −12,8% |
| Backlog con seguridad de escritura | 193 | 149 | −22,8% |
| Desarrollo con seguridad de escritura | 251 | 174 | −30,7% |
| Release con seguridad de escritura | 247 | 151 | −38,9% |
| Núcleo operativo completo | 422 | 297 | −29,6% |

La baseline pedía además cargar `source-variants.md` en desarrollo/release; la candidata
lo retira del camino operativo, pero conserva el fichero y el manifiesto como evidencia.
Estas son líneas, no tokens ni tiempo medido.

## Retirada de copias antiguas

La retirada sigue siendo obligatoria para evitar falsas ejecuciones, pero pertenece al
instalador autorizado. Solo procede cuando la candidata esté integrada en una ubicación
duradera, pase validación y ambos runtimes demuestren que resuelven exactamente la fuente
canónica. Activar un modo o la propia skill no autoriza esa operación destructiva.
