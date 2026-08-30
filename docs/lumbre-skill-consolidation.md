# Consolidación de la skill global de Lumbre

Estado: baseline canónica por **unión**, previa a optimización. Este documento demuestra
procedencia y cobertura; no declara que la redacción final esté optimizada.

## Inventario cerrado

La búsqueda dirigida cubrió `$HOME/.claude/skills`, `$HOME/.codex/skills`,
`$HOME/.agents/skills`, `$HOME/code/codex-dotfiles` y `$HOME/code/lumbre-mcp`, incluyendo
`SKILL.md`, sufijos de backup y ficheros bajo cada directorio `lumbre/`. Se encontraron seis
cuerpos y dos metadatas; no aparecieron más copias o backups en esos roots.

| ID | Fuente | Líneas | Bytes | SHA-256 | Papel |
|---|---|---:|---:|---|---|
| CX-live | `$HOME/.codex/skills/lumbre/SKILL.md` | 211 | 13 563 | `36df439032d1dc211fdb76d9c0db271447ffad96441191f315cf658f98039b3f` | activa Codex |
| AG-live | `$HOME/.agents/skills/lumbre/SKILL.md` | 216 | 13 912 | `9b4620748c4b570e616c2f021d428d2c39672d0fb6b25813656cc9f6fe4b07e6` | activa Agents |
| CX-repo | `$HOME/code/codex-dotfiles/codex/skills/lumbre/SKILL.md` | 191 | 12 055 | `2c25ffc6958c6733748a90451dbd0e8ce4b4d1fe1977b9148f0fe32d2fbef100` | versionada Codex |
| AG-repo | `$HOME/code/codex-dotfiles/agents/skills/lumbre/SKILL.md` | 191 | 12 302 | `b0b64b58e664cb1f441b30554aabef48c20d840ba9639e36d3ac02494e5538db` | versionada Agents |
| CL-live | `$HOME/.claude/skills/lumbre/SKILL.md` | 153 | 7 967 | `d620a2b9bf319f29499fe6b35d1f27964066d6d715f68a47b144302335acf574` | activa histórica Claude |
| CL-backup | `$HOME/.claude/skills/lumbre/SKILL.md.bak-2026-08-10` | 230 | 15 600 | `a8d66ee7a0bf3701ab501dd1192ed1d873fbfcc90daf41b2561b590a55645d20` | backup no descubrible, fuente potencial |
| CX-yaml-live | `$HOME/.codex/skills/lumbre/agents/openai.yaml` | 4 | 195 | `82441cb68af4298cd0f0d00f0d452f0f446a6df853192a06402449dff048c5dd` | metadata activa |
| CX-yaml-repo | `$HOME/code/codex-dotfiles/codex/skills/lumbre/agents/openai.yaml` | 4 | 195 | `82441cb68af4298cd0f0d00f0d452f0f446a6df853192a06402449dff048c5dd` | metadata versionada |

Los dos YAML son idénticos. Los seis cuerpos difieren entre sí. Todos se leyeron completos,
incluido el backup, antes de cerrar la matriz.

## Método y criterio de cobertura

Cada cuerpo se segmentó en cláusulas semánticas: frontmatter/activación, ubicación y
autoridad, backlog, herramientas, estado, ejecución, gate, git/deploy, cierre y landmines.
Una cláusula cuenta como cubierta si:

1. aparece operativamente en el destino canónico; o
2. su forma pública generalizada conserva la decisión que alteraba; o
3. si contradice otra fuente, ambas variantes constan en `source-variants.md` y en la
   referencia de modo correspondiente, sin elegir una por omisión.

Datos personales, rutas absolutas de usuario y snapshots fechados no se copian al cuerpo
público. Su forma se conserva mediante configuración o descubrimiento del repo. No se ha
eliminado una regla por parecer redundante.

**Cobertura de cláusulas: 100% (32/32 bloques semánticos mapeados).**

## Matriz cláusula → origen → destino

| ID | Cláusula o bloque | Origen | Destino canónico | Disposición en esta fase |
|---|---|---|---|---|
| S01 | Activación, disparadores y exclusiones | las seis; más detalle en AG | `SKILL.md` | Unión en cinco modos; sin optimizar frontmatter |
| S02 | Workflow del repo como norma prevalente | CX-live, CL-live, CL-backup | `SKILL.md`, `project-release.md` | Conservada por descubrimiento, no duplicada como verdad universal |
| S03 | Lista vacía no prueba inexistencia | las seis | `SKILL.md`, `mcp-safe-operations.md`, `backlog.md` | Conservada con duplicación deliberada |
| S04 | Separar tareas, doc humana y doc de máquina | las seis | `project-release.md`, `source-variants.md` | Generalizada; contradicción sobre gestor externo preservada |
| S05 | Tema/lista, sección/bloque, punto/tarea, lote/tag | las seis | `backlog.md` | Conservada completa |
| S06 | No crear sección-por-lote | CL-backup | `backlog.md`, `source-variants.md` | Regla única recuperada del backup |
| S07 | Hub no borrable y métricas sin hijas | las seis | `backlog.md` | Generalizada a hub configurado |
| S08 | Tarea real no se degrada a subtarea; residencia | las seis | `backlog.md`, `mcp-safe-operations.md` | Conservada |
| S09 | `@contexto` controlado frente a `#tag` libre | las seis | `backlog.md` | Conservada |
| S10 | Contenido crudo; no reescribir desde display | las seis | `SKILL.md`, `mcp-safe-operations.md` | Conservada con redundancia de seguridad |
| S11 | Tools, batch, campos parciales, mover y sección | las seis | `mcp-safe-operations.md` | Generalizada a capacidades publicadas; semántica completa |
| S12 | Mutación async, refresh y relectura | las seis | `SKILL.md`, `mcp-safe-operations.md` | Conservada; lectura previa queda dependiente de frescura |
| S13 | Fallback API y dominio correcto | CX/AG y CL en conflicto | `mcp-safe-operations.md`, `source-variants.md` | Conservada la corrección CL y registrada la divergencia |
| S14 | Ciclo `@acked/@wip/@done`, uno solo y ortogonales | las seis | `development.md` | Conservado como modo opt-in |
| S15 | Tareas creadas por agente nacen reconocidas | CL-live, CL-backup | `development.md` | Conservada dentro de variante estricta |
| S16 | Devolución `@not-done` y reapertura | CL-live, CL-backup | `development.md`, `source-variants.md` | Conservada solo para perfil dev que la defina |
| S17 | Checkbox como aceptación humana separada | las seis; más fuerte en CL | `development.md` | Conservada como perfil de proyecto |
| S18 | Revisar notas y adjuntos de tareas cerradas | las seis | `mcp-safe-operations.md`, `development.md` | Conservada |
| S19 | Mapeo estructurado de capturas antes de escribir | CX-live, AG-live | `development.md`, `source-variants.md` | Formato exacto preservado, condicionado al guardarraíl |
| S20 | Evidencia visual/interactiva mide el síntoma | CL-backup | `development.md` | Regla única recuperada y generalizada |
| S21 | Autonomía: dos cierres o seis horas | CX/AG | `development.md` | Conservada como variante configurable, no universal |
| S22 | Agrupar por causa, checkpoint, lote de 3–6 | CX-live, AG-live; parcial CX-repo | `development.md`, `source-variants.md` | Suma completa conservada |
| S23 | Delegación, fases, parada y presupuesto diagnóstico | CL-live; delegación parcial CX/AG | `development.md` | Conservada como variante; nombres privados eliminados |
| S24 | Una suite pesada, focal ≠ gate, etiquetas de gate | CL-live | `development.md`, `project-release.md` | Reglas únicas conservadas |
| S25 | Gate embebido frente a script normativo | CX/AG frente a CL | `project-release.md`, `source-variants.md` | Ambas formulaciones preservadas |
| S26 | Reviewer final frente a paralelo mismo SHA | AG-live, AG-repo, CX-repo frente a CX-live/CL | `project-release.md`, `source-variants.md` | Contradicción abierta, sin borrar variantes |
| S27 | QA visual por estado y modo demo/local | las seis; demo en CL-backup | `project-release.md`, `development.md` | Resultado conservado; mecanismo local se descubre |
| S28 | Autoridad, worktrees, cambios ajenos y SHA | CL-live; git parcial resto | `project-release.md` | Conservada como regla de seguridad |
| S29 | Push despliega frente a deploy manual/CI/canales | fuentes históricas en conflicto | `project-release.md`, `source-variants.md` | Tres variantes registradas; workflow vivo decide |
| S30 | Estado/changelog/doc humana/cierre honesto | las seis | `project-release.md` | Generalizada a superficies declaradas por repo |
| S31 | Node, env/bundle, Svelte, z-index, popover, sync | CX/AG y CL-backup | `project-release.md` | Forma preservada; valores efímeros no copiados |
| S32 | Metadata UI y firma específica de runtime | YAML, CX frente a AG/CL | `agents/openai.yaml`, `source-variants.md` | UI pública unificada; firma delegada al entorno |

## Diferencias y contradicciones pendientes

Estas preguntas pertenecen a la optimización posterior; la baseline no las resuelve
eliminando texto:

1. Dentro del modo desarrollo, ¿`@acked` se aplica a toda tarea leída o solo a la tarea
   asumida/triada? El modo lectura seguirá siendo no mutante en ambos casos.
2. ¿La revisión de código va al final o en paralelo con el gate? El workflow del repo ya
   puede decidirlo, pero hace falta una regla pública de fallback.
3. ¿El límite heredado de dos tareas/seis horas debe ser un perfil distribuido, una
   sugerencia o desaparecer de la versión pública?
4. ¿`@not-done` se mantiene como protocolo opt-in o se expresa solo mediante estados
   nativos de cancelación/bloqueo/devolución?
5. ¿Qué parte del gate histórico merece un ejemplo público y qué parte debe residir
   exclusivamente en el repo de la app?
6. ¿La documentación/tareas externas se configuran mediante perfil o se omiten por
   completo de la distribución pública?
7. ¿El fallback directo por API debe seguir documentado cuando OAuth esté disponible?

## Criterio de migración y retirada

La optimización parte de esta unión, nunca de una copia individual. Antes de retirar una
skill antigua deben cumplirse todas estas condiciones:

1. `tests/skill-lumbre/validate.sh` pasa en la fuente canónica y la validación
   instalada `skills/lumbre/scripts/validate.sh` pasa sin historial Git;
2. la fuente canónica está integrada en una ubicación duradera y alcanzable;
3. los runtimes objetivo resuelven esa misma fuente y no una copia materializada distinta;
4. una comprobación de deriva confirma el mismo contenido;
5. entonces se eliminan o desconectan todas las skills antiguas y backups descubribles.

La retirada final es obligatoria: dejar cuerpos alternativos alcanzables permitiría falsas
selecciones o ejecuciones desde reglas obsoletas. Este worktree no las modifica; prepara el
contrato que debe exigir el instalador.

## Evidencia de validación

- El validador oficial de `skill-creator` acepta `skills/lumbre`.
- `tests/skill-lumbre/validate.sh` pasa en el checkout canónico con la evidencia
  histórica repo-only.
- `skills/lumbre/scripts/validate.sh` y el validador oficial pasan después de copiar
  únicamente `skills/lumbre` a un directorio temporal aislado; la distribución no
  depende de `docs/`, bundles ni historial Git.
- `git diff --check` no encuentra errores de whitespace.
- Un forward-test independiente recorrió lectura explícitamente no mutante, ciclo de una
  tarea de desarrollo y agrupación de ocho tareas en dos lotes conservando secciones. Los
  tres modos cargaron referencias alcanzables y respetaron sus límites de mutación.
- A partir del forward-test se aclaró que refresh, registro de contradicciones,
  `MAPEO_CAPTURA` y retirada de copias no autorizan mutaciones implícitas.

La evaluación confirmó también que las contradicciones de `@acked`, revisión y definición
de «entrega» siguen abiertas. Eso es el resultado esperado de esta fase de unión; resolverlas
corresponde a la optimización y sus pruebas de comportamiento.
