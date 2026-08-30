# Manifiesto autocontenido de consolidación

Evidencia de que la optimización parte de la unión completa y no de una copia elegida.
Este fichero no se carga en el uso normal. La matriz narrativa y las decisiones están
en la documentación del repositorio canónico; `forward-prompts.md` y
`forward-expectations.md` separan la batería ciega de su oráculo.

## Fuentes incorporadas antes de optimizar

| ID | Líneas | Bytes | SHA-256 |
|---|---:|---:|---|
| CX-live | 211 | 13 563 | `36df439032d1dc211fdb76d9c0db271447ffad96441191f315cf658f98039b3f` |
| AG-live | 216 | 13 912 | `9b4620748c4b570e616c2f021d428d2c39672d0fb6b25813656cc9f6fe4b07e6` |
| CX-repo | 191 | 12 055 | `2c25ffc6958c6733748a90451dbd0e8ce4b4d1fe1977b9148f0fe32d2fbef100` |
| AG-repo | 191 | 12 302 | `b0b64b58e664cb1f441b30554aabef48c20d840ba9639e36d3ac02494e5538db` |
| CL-live | 153 | 7 967 | `d620a2b9bf319f29499fe6b35d1f27964066d6d715f68a47b144302335acf574` |
| CL-backup | 230 | 15 600 | `a8d66ee7a0bf3701ab501dd1192ed1d873fbfcc90daf41b2561b590a55645d20` |

Los dos `agents/openai.yaml` encontrados eran idénticos:
`82441cb68af4298cd0f0d00f0d452f0f446a6df853192a06402449dff048c5dd`.

## Cobertura final

Cobertura de cláusulas: 100% (32/32). Las decisiones normativas viven en el router y
las referencias de modo; `source-variants.md` conserva procedencia no normativa.

| ID | Destino final |
|---|---|
| S01 | `SKILL.md` |
| S02 | `SKILL.md`, `project-release.md` |
| S03 | `SKILL.md`, `mcp-safe-operations.md`, `backlog.md` |
| S04 | `project-release.md`, `source-variants.md` (histórico) |
| S05 | `backlog.md` |
| S06 | `backlog.md` |
| S07 | `backlog.md` |
| S08 | `backlog.md`, `mcp-safe-operations.md` |
| S09 | `backlog.md` |
| S10 | `SKILL.md`, `mcp-safe-operations.md` |
| S11 | `mcp-safe-operations.md` |
| S12 | `SKILL.md`, `mcp-safe-operations.md`, `read-and-daily.md` |
| S13 | `mcp-safe-operations.md`, `source-variants.md` (histórico) |
| S14 | `development.md` |
| S15 | `development.md` |
| S16 | `development.md` |
| S17 | `development.md`, `project-release.md` |
| S18 | `development.md`, `mcp-safe-operations.md` |
| S19 | `development.md` |
| S20 | `development.md`, `project-release.md` |
| S21 | `development.md` |
| S22 | `development.md` |
| S23 | `development.md` |
| S24 | `development.md`, `project-release.md` |
| S25 | `project-release.md` |
| S26 | `project-release.md`, `source-variants.md` (histórico) |
| S27 | `development.md`, `project-release.md` |
| S28 | `project-release.md` |
| S29 | `project-release.md`, `source-variants.md` (histórico) |
| S30 | `project-release.md` |
| S31 | `project-release.md`, `source-variants.md` (histórico) |
| S32 | `agents/openai.yaml`, `source-variants.md` (histórico) |

Las copias antiguas se retiran solo cuando la fuente canónica es duradera y alcanzable,
el instalador autorizado demuestra que los runtimes resuelven esta misma skill y la
validación pasa. Activar la skill no ejecuta esa retirada.
