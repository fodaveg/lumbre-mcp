# Manifiesto autocontenido de consolidación

Evidencia de que la optimización parte de la unión completa y no de una copia elegida.
Este fichero no se carga en el uso normal. La matriz narrativa y las decisiones están
en la documentación del repositorio canónico; `forward-prompts.md` y
`forward-expectations.md` separan la batería ciega de su oráculo. El piloto sintético
reproducible y sus métricas viven en `forward-pilot.md` y
`forward-pilot-evidence.json`; no se presentan como uso longitudinal real. Toda esta
carpeta es evidencia repo-only y no forma parte de la skill instalada.

## Captura vigente preregistrada rechazada

La captura única P01–P12 del candidato
`4ea5756377bf7a1c42f402bb0beeaf0f8bbe398e` usó Codex CLI 0.151.0 y el modelo
solicitado `gpt-5.4`. El verificador aceptó 10/12 casos: P02 conservó `@wip` como
`devState` en una lectura pura y P11 no cerró `@wip`→`@done` ni verificó esa segunda
transición antes del handoff. No se adaptaron los criterios ni se repitió la captura.

| Artefacto | SHA-256 |
|---|---|
| Evidencia cruda | `018ee980e1cc7083c314c39638ead75835d5243c01d2c9d18c769b086b126956` |
| Receipt del verificador | `1e9acf782f08c76c46637fa10a846d117143f251f389c5b155ce40cac6c2b692` |
| Bundle operativo | `15235984833b3e697c31b425c0799caad564b070130721918f1d7a178dc3f20f` |
| Prompts ciegos | `95322be63160134d92ee51c65c5804cd18886eedf264147da4509a266729adf8` |
| Esquema de salida | `3b394778ffff146f8921e3dbf7dbd7a142c8e267d764a6e7154f437683cf4d53` |
| Preregistración | `2e88f0e844201251868cc73124b6f7eb4239fd79cf9e2e057c9a6cdca6dbacac` |
| Entorno aislado | `2daff5aa98ad692285f705523729a6f7b8ba2ee5f553b1e2e34d0c1de5592303` |
| Envelope exacto | `f2db550e050261ae778093416149bd6c615da7510f0e9cff7c87b7aa895bc028` |
| JSONL crudo y público | `e64de42b03a677b88c96c1a31072f80d567c9b22f62e0130d00ac94e1337979e` |

Los cuatro eventos contienen cero tool calls, shell, MCP, mutaciones de fichero o
acciones externas. La respuesta consumió 24 654 tokens de entrada, 1 792 cacheados,
4 246 de salida y 2 721 de razonamiento. La latencia del batch fue 80 877 ms; la
media de 6 740 ms/caso es derivada.

Los tres artefactos exactos están en `captures/4ea5756/raw/`; su
`verification-receipt.json` adyacente separa el veredicto final de los bytes crudos.
El `captureStatus: accepted` del JSON crudo es la salida pre-verificación del runner:
el verificador terminó con exit 1 y rechazó la captura 10/12. Esto no se presenta como
una captura aceptada.

## Captura histórica preregistrada rechazada

La captura P01–P12 publicada usó Codex CLI 0.151.0, modelo solicitado `gpt-5.4` y
candidato padre `0957116153550efcbf1f42c57d2f4b98a402229e`. Fue una única llamada
tras un preflight completo congelado y revisado. El resultado fue 9/12, sin adaptar el
oráculo ni repetir la captura.

| Artefacto | SHA-256 |
|---|---|
| Bundle operativo | `095b51e637942c0ac5a7f759eb140a8c8ba0f208ee954d1c315c44f0f10cd0f1` |
| Prompts ciegos | `95322be63160134d92ee51c65c5804cd18886eedf264147da4509a266729adf8` |
| Esquema de salida | `4e50d5b23453d5b0c583a2cf0e6438f88c3b44cbdccc1f1ade79721dd323b4e7` |
| Preregistración | `d32e162850129de638403136d5a6bc45810fb79ae4fcc7627056f5a10df79679` |
| Entorno aislado | `72c9736bb0229f874d4fd3ed282b77477fcd449bd596769cdc73d89df658ab0e` |
| Envelope exacto | `a949b11c2303cfdb923e7fc5b7b364a36ab5d4d414f2a6058e105300ae64fd08` |
| Runner exacto de captura | `0813c85a91960132978dc821e660a10d525fa7e3eda07dfb63cd60a43980d6ab` |
| Librería exacta de captura | `953c1954d9a155043506a22ce0e1bca5882c21b51b3f55a398b30e604d925db7` |
| JSONL crudo y público | `a12dd84270d5ab50cdb2c01c5d839e1ec74a20d4412d43199cf1bdfd3e8b7b94` |

Los cuatro eventos contienen cero tool calls, shell, MCP, mutaciones de fichero o
acciones externas. La respuesta consumió 23 948 tokens de entrada, 1 792 cacheados,
4 132 de salida y 2 572 de razonamiento. La latencia del batch fue 77 842 ms; la
media de 6 487 ms/caso es derivada. Nueve contratos pasaron y tres fallaron.

Los hashes completos, fixtures, configuración de aislamiento, contadores y resultado
por caso de esta captura permanecen en los tres artefactos
`forward-pilot-evidence.*`. La conducta del modelo es evidencia informativa no
bloqueante; integridad, privacidad, cobertura 32/32, negativos y revisión
independiente siguen siendo gates. No hubo saneado ni normalización y la captura no
se presenta como determinista ni aceptada.

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
| S12 | `SKILL.md`, `mcp-safe-operations.md`, `read.md` |
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
