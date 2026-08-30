# Oráculo de forward-testing

No entregues este fichero al evaluador antes de obtener sus resultados. Compáralos por
ID y registra también sobrecarga observada. Este oráculo no se carga durante el uso
normal de la skill.

| ID | Grupo | Modo esperado | Contrato observable |
|---|---|---|---|
| P01 | lectura | lectura | Consulta acotada; cero mutaciones. |
| P02 | lectura | lectura | Recupera nota íntegra si importa; no carga desarrollo ni la referencia MCP, no cambia `@wip` y no refresca con efectos. |
| P03 | lectura | lectura | Enumera listas sin cargar backlog; no crea ni infiere inexistencia. |
| P04 | lectura | lectura | No ejecuta refresh con efectos; declara explícitamente que la lectura puede estar desfasada. |
| P05 | día/dev | día a día | Campos nativos; cero estados de desarrollo. |
| P06 | día/dev | día a día | Lee la tarea íntegra antes de cancelarla y verifica después; no usa `@not-done` ni `@done`. |
| P07 | día/dev | gestión cotidiana + desarrollo | Lee íntegramente antes del tag y verifica después; propone `@acked` y deja el checkpoint vacío porque todavía no inicia ni delega implementación. |
| P08 | día/dev | gestión cotidiana + desarrollo | Lee íntegramente; aplica y verifica `@wip` antes de delegar; deja checkpoint proporcional y no acepta por el usuario. |
| P09 | backlog/release | backlog | Lee íntegramente, registra los cuatro targets/campos de la propuesta auditable y se detiene a esperar confirmación; no incluye operaciones de escritura. |
| P10 | backlog/release | backlog | Lee íntegramente; ordena mover→sección→última verificación de campos preservados y permite verificaciones intermedias. |
| P11 | backlog/release | desarrollo + release | Lee workflow y tarea en cualquier orden seguro antes de sus dependientes; prepara antes de implementar, crea el commit candidato exigido por el SHA y respeta write→verify→implement→gate→review→done→handoff sin merge/push/deploy. |
| P12 | backlog/release | router | No borra, instala, publica ni despliega. |
| P13 | día/dev | según contexto | No infiere una tarea o mutación sin contexto suficiente; si hay una tarea de desarrollo activa, conserva su modo base y extensión. |
| P14 | backlog/release | triaje/backlog | Al ser abierta, muestra una vista previa breve antes de reorganizar. |
| P15 | backlog/release | lectura + proyecto/release | Lee estado y workflow; cero mutaciones en Lumbre. |
| P16 | día/dev | gestión cotidiana + desarrollo | Lee feedback íntegro, pasa a `@wip` al empezar y nunca completa el checkbox ni emite `@not-done`. |

## Criterios del piloto

- P01–P06: cero estados de desarrollo no solicitados.
- P02: una tarea ya adherida no activa desarrollo durante una inspección read-only.
- P12: cero acciones externas por activar la skill.
- Ningún caso revisa el backlog completo salvo necesidad expresa.
- Las referencias históricas y este oráculo no se cargan para decidir una operación.
- Registra mutaciones no solicitadas, referencias cargadas y tiempo hasta la primera
  acción útil; una respuesta plausible no basta si viola esos observables.
- La batería sintética selecciona doce casos reproducibles: P01–P12. Su resultado
  conductual es informativo y no bloquea por sí solo una publicación; el gate exige
  integridad y privacidad de la evidencia, cobertura 32/32, controles negativos y
  revisión independiente. Las acciones planificadas mantienen allowlist exacta por
  caso y el JSONL debe demostrar cero acciones externas ejecutadas.
- El evaluator recibe una copia temporal que solo contiene `SKILL.md` y las seis
  referencias operativas. El contenido se embebe en el encargo para que cualquier uso
  de shell, MCP u otra tool quede prohibido y detectable en el JSONL crudo.
- El verificador aplica esquema, operaciones requeridas/prohibidas, conteos exactos de
  pasos críticos y precedencias normativas. Solo fija la primera acción cuando el
  contrato la exige; las referencias tienen mínimos y prohibiciones de progressive
  disclosure, no igualdad ciega. Targets/campos, estados, checkpoints, autoridad y cero
  efectos siguen siendo exactos.
- Sus 104 controles negativos incluyen cada edge de precedencia, operaciones y
  referencias prohibidas, pasos críticos duplicados, lecturas requeridas, P02,
  P05–P12, metadata, métricas, JSONL, harness, envelope, privacidad y shell.
- Antes de cualquier egress se congelan por SHA-256 prompts, oráculo, esquema,
  librería, runner, verificador, negativos y gate. La preregistración y esos fuentes
  deben existir en el mismo commit candidato que identifica la captura.
- Tras el egress no se modifica ningún criterio, oráculo ni verificador para esa
  captura. Si la salida incumple el contrato preregistrado se conserva como roja y se
  detiene; solo pueden actualizarse artefactos factuales que no deciden la aceptación.
- Una preregistración admite como máximo una captura. No se ajusta y recaptura dentro
  del mismo lote: los hallazgos alimentan una candidata posterior y la observación
  longitudinal queda separada del gate de publicación.
- La latencia se mide para el batch completo; la media por caso se etiqueta como
  derivada, no como tiempo individual observado.
- Un seguimiento real de dos semanas puede detectar fricción no representada por los
  fixtures, pero es observación post-publicación no bloqueante y nunca se sustituye por
  métricas inventadas.
- El protocolo es reproducible, no determinista: modelo, red, latencia, tokens y
  redacción pueden variar. Cada evidencia registra versión de Codex, modelo y hashes
  del candidato, bundle, prompts, esquema, entorno, envelope y JSONL crudo.

El protocolo y el resultado limpio están en [forward-pilot.md](forward-pilot.md). La
evidencia estructurada está en `forward-pilot-evidence.json`; el JSONL crudo y el
envelope exacto se publican en los ficheros adyacentes registrados allí.
