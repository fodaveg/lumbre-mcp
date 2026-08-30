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

El candidato `4ea5756` congeló por hashes exactos prompts, oráculo, esquema,
librería, validadores, runner, verificador, 109 negativos y gate. La captura publicada
se ejecutó una sola vez y quedó roja, sin adaptar el oráculo ni repetir la llamada. El
JSONL y el envelope publicados son sus bytes exactos.

## Resultado preregistrado rechazado

- Resultado conductual: **10/12 contratos; captura rechazada**.
- Runtime: **Codex CLI 0.151.0**, modelo solicitado **gpt-5.4**.
- Candidato padre: `4ea5756377bf7a1c42f402bb0beeaf0f8bbe398e`.
- Latencia del batch: **80 877 ms**; media derivada: **6 740 ms/caso**.
- Tokens derivados del único `turn.completed`: **24 654** de entrada, **1 792**
  cacheados, **0** escritos a caché, **4 246** de salida y **2 721** de razonamiento.
- Eventos ejecutados: **0 tool calls, 0 shell, 0 MCP, 0 mutaciones de fichero y 0
  acciones externas**.
- Contratos verdes: P01 y P03–P10 y P12. Ninguna acción se ejecutó.

| Caso | Diagnóstico contra la norma |
|---|---|
| P02 | Enrutó la petición como lectura, cargó solo `read.md` y no propuso mutaciones, pero copió el `@wip` ya existente a `devState`; el contrato exige dejar ese estado de salida vacío en una inspección pura. |
| P11 | Preparó, implementó, pasó gate y revisión, pero terminó en `@wip`: omitió la segunda transición a `@done`, su verificación y el siguiente paso del checkpoint antes del handoff. |

Los bytes exactos de la captura 10/12 están en `captures/4ea5756/raw/`; el receipt
adyacente registra el exit 1 y evita confundir el `captureStatus: accepted`
pre-verificación del runner con un veredicto aceptado. La captura histórica 9/12 se
conserva en `forward-pilot-evidence.*` como fixture del verificador. La captura nueva
mantiene exactos targets/campos, autoridad, aislamiento y cero efectos externos; sus
dos fallos son señal conductual informativa, no un fallo de los gates deterministas.

## Reproducción

La preregistración de `4ea5756` ya consumió su única captura y no admite recaptura. Su
rojo se reproduce sin egress; el primer comando debe terminar con exit 1 y fallos
P02/P11:

```sh
node tests/skill-lumbre/verify-forward-pilot.mjs \
  tests/skill-lumbre/evidence/captures/4ea5756/raw/lumbre-forward-pilot-20260830.json
node tests/skill-lumbre/test-forward-pilot-verifier.mjs
```

El runner y el verificador son herramientas del repositorio: necesitan un checkout Git
con el commit candidato disponible. Un archivo de la skill instalada, un archive o un
shallow clone que no contenga ese commit puede fallar al comprobar `git show`; eso no
afecta al uso operativo normal de la skill.

Cada preregistración permite una sola captura, sin ajustar criterios ni recapturar en
el mismo lote. Una única salida estocástica, incluso 12/12, se conserva como señal
conductual informativa mientras no haya repeticiones y tolerancia preregistradas. La
publicación exige los gates deterministas de integridad histórica, privacidad,
aislamiento, cobertura 32/32 y controles negativos, además de revisión independiente.
El seguimiento real de dos semanas queda como observación post-publicación no
bloqueante.
