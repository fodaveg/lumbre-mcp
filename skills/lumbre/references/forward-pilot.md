# Piloto sintético reproducible

Esta evidencia valida decisiones observables de la skill en un entorno aislado. No
representa dos semanas de uso real ni mide el servidor de Lumbre. El protocolo y sus
controles son reproducibles; la respuesta del modelo, latencia y tokens no son
deterministas.

## Aislamiento y captura

El runner seleccionó P01–P12: cuatro casos de lectura, cuatro de
cotidiano/desarrollo y cuatro de backlog/release. Copió a un bundle temporal cerrado
solo `SKILL.md` y las seis referencias operativas. No copió oráculo, variantes,
manifiesto, scripts ni evidencia previa. El envelope exacto publicado contiene el
bundle, los prompts y fixtures enviados.

El evaluador corrió efímero, con configuración y reglas ignoradas, descubrimiento de
skills host desactivado, sandbox de solo lectura y sin MCP. El arnés rechaza cualquier
tool call, shell, MCP, mutación o acción externa. También falla antes de publicar si
encuentra una ruta local: esta captura no necesitó saneado y el JSONL crudo es idéntico
al publicado.

El preflight `0957116` congeló por hashes exactos prompts, oráculo, esquema,
librería, quick validator, runner, verificador, 100 negativos y gate. Una revisión
independiente comprobó los nueve blobs, la relación base→candidato y el verde de
`validate.sh --preflight` antes del egress. La captura publicada se ejecutó una sola
vez y quedó roja, sin adaptar el oráculo ni repetir la llamada. El JSONL y el envelope
publicados son sus bytes exactos.

## Resultado preregistrado rechazado

- Resultado conductual: **9/12 contratos; captura rechazada**.
- Runtime: **Codex CLI 0.151.0**, modelo solicitado **gpt-5.4**.
- Candidato padre: `0957116153550efcbf1f42c57d2f4b98a402229e`.
- Latencia del batch: **77 842 ms**; media derivada: **6 487 ms/caso**.
- Tokens derivados del único `turn.completed`: **23 948** de entrada, **1 792**
  cacheados, **0** escritos a caché, **4 132** de salida y **2 572** de razonamiento.
- Eventos ejecutados: **0 tool calls, 0 shell, 0 MCP, 0 mutaciones de fichero y 0
  acciones externas**.
- Contratos verdes: P01, P04–P09 y P11–P12. Ninguna acción se ejecutó.

| Caso | Diagnóstico contra la norma |
|---|---|
| P02 | Cargó `mcp-safe-operations.md` en una lectura ordinaria sin escritura, configuración ni diagnóstico. |
| P03 | Cargó `backlog.md` para comprobar la existencia de una lista vacía, aunque no había triaje ni reorganización. |
| P10 | Hizo una verificación intermedia tras mover y otra final tras reasignar la sección. La norma se cumple; el edge contra la primera verificación era demasiado estricto. |

La candidata posterior conserva `validate.sh --preflight`, aclara las dos referencias
prohibidas y aplica section→última verify-preserved. Mantiene exactos targets/campos,
checkpoints, autoridad y cero efectos. Sus controles negativos cubren además ambos
fallos de progressive disclosure.

## Reproducción

Una corrida nueva requiere autorización para enviar el bundle público al modelo:

```sh
node scripts/run-forward-pilot.mjs /tmp/lumbre-forward-pilot.json
node scripts/verify-forward-pilot.mjs /tmp/lumbre-forward-pilot.json
node scripts/test-forward-pilot-verifier.mjs
```

El runner y el verificador son herramientas del repositorio: necesitan un checkout Git
con el commit candidato disponible. Un archivo de la skill instalada, un archive o un
shallow clone que no contenga ese commit puede fallar al comprobar `git show`; eso no
afecta al uso operativo normal de la skill.

Cada preregistración permite una sola captura, sin ajustar criterios ni recapturar en
el mismo lote. El resultado conductual se conserva como evidencia informativa; la
publicación exige integridad histórica, privacidad, cobertura 32/32, controles
negativos y revisión independiente. El seguimiento real de dos semanas queda como
observación post-publicación no bloqueante.
