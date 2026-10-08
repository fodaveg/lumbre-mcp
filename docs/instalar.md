# Instalar y conectar Lumbre

Cómo conectar el MCP de Lumbre a un cliente y cómo instalar la skill opcional. Las
tools del servidor están descritas en el [README](../README.md).

## Conectar el MCP remoto

La URL pública es `https://mcp.lumbre.pro/mcp`. El cliente abre el navegador y
redirige a Lumbre para iniciar sesión y autorizar la conexión.

En Codex:

```bash
codex mcp add lumbre --url https://mcp.lumbre.pro/mcp
codex mcp login lumbre
```

En claude.ai web o móvil, añade un conector personalizado con esa misma URL. No
añadas un bearer ni un token en el path.

Los clientes cachean `tools/list` al conectar: cuando cambia la superficie del
MCP (la última vez, el 2026-09-24, al añadir seis ops nuevas de `mutate_tasks`/
`organize` en MC7; antes, el 2026-09-23, al ampliar el esquema de
`recurrence`; antes, el 2026-09-19, al retirar las nueve tools sueltas de
mutación y partir el lote en `mutate_tasks`/`organize`), una sesión ya abierta
de claude.ai o de Claude Code sigue viendo las tools viejas hasta que
reconectes el conector o abras una sesión nueva.

## Instalar la skill opcional

La skill pública multimodo vive en `skills/lumbre/`. No es necesaria para usar
el MCP, pero añade reglas seguras de lectura, gestión cotidiana, backlog y el
flujo opcional de desarrollo/release. Se instala desde este repositorio con
[`skills`](https://skills.sh), que mantiene una única instalación global y la
hace visible para los clientes seleccionados:

`npx` viene incluido con `npm`, que se instala junto con Node.js. Si todavía no
lo tienes, instala Node.js con el gestor de paquetes de tu sistema:

```bash
# macOS
brew install node

# Fedora
sudo dnf install nodejs
```

Comprueba el requisito antes de instalar la skill:

```bash
node --version
npm --version
npx --version
```

```bash
npx --yes skills add fodaveg/lumbre-mcp -g -y \
  --skill lumbre \
  --agent codex claude-code
```

La skill no depende de subagentes, pero puede generar tres roles opcionales
(`lumbre-tagger`, `lumbre-reader` y `lumbre-daily-operator`) desde un único
contrato portable. En una instalación nueva, revisa primero el plan y después
instálalos para Codex y Claude Code:

```bash
node "$HOME/.agents/skills/lumbre/scripts/manage-subagents.mjs" install \
  --runtime all --dry-run
node "$HOME/.agents/skills/lumbre/scripts/manage-subagents.mjs" install \
  --runtime all
node "$HOME/.agents/skills/lumbre/scripts/manage-subagents.mjs" check \
  --runtime all
```

El instalador nunca reemplaza silenciosamente una definición existente. Para
migrar copias manuales antiguas añade `--replace-unmanaged`; para actualizar
copias que ya generó este script, `--replace-managed`. Por defecto Claude recibe
los tres prefijos reales del conector (`mcp__lumbre__`, `mcp__claude_ai_Lumbre__`
y `mcp__claude_ai_lumbre__`). Si el tuyo es otro, repite el flag por cada
prefijo, por ejemplo
`--claude-tool-prefix mcp__lumbre__ --claude-tool-prefix mcp__mi_alias__`.
Esa lista forma parte de la definición generada. Hay que pasarla al migrar
ficheros manuales con `--replace-unmanaged` o al cambiar los aliases
deliberadamente. A partir de ahí, el gestor la recupera de sus propios ficheros
gestionados, por lo que los comandos cortos de `install` y `check` la conservan
en futuras actualizaciones. Si las copias gestionadas discrepan o están dañadas,
el gestor aborta y exige la lista explícita en vez de elegir una silenciosamente.
Claude fija `haiku` y limita las tools en su definición. El TOML de Codex
también fija el modelo (`model = "gpt-5.6-luna"`), pero ese formato no tiene
allowlist de tools a nivel de agente: la definición conserva esa restricción
operativa en las instrucciones. Claude.ai web no instala agentes locales; en
esa superficie la skill sigue funcionando por sí sola.

Verifica primero la copia global gestionada y el enlace de Claude Code:

```bash
test -f ~/.agents/skills/lumbre/SKILL.md
test -f ~/.claude/skills/lumbre/SKILL.md
```

Codex actual resuelve la copia global de `~/.agents/skills`; no hace falta crear
otra copia en `~/.codex/skills`. El lockfile de `skills` acredita qué se instaló,
pero no demuestra que cada runtime la haya descubierto: abre una conversación
nueva y pide explícitamente usar `lumbre` en Codex y Claude Code. Si uno no la
resuelve, actualiza ese runtime y repite la instalación. Como último recurso para un
Codex antiguo, crea un enlace a la copia canónica, nunca una segunda copia:

```bash
mkdir -p "$HOME/.codex/skills"
if [ -e "$HOME/.codex/skills/lumbre" ] && [ ! -L "$HOME/.codex/skills/lumbre" ]; then
  echo "No se reemplaza una instalación real de lumbre" >&2
  exit 1
fi
ln -sfn ../../.agents/skills/lumbre "$HOME/.codex/skills/lumbre"
test -f "$HOME/.codex/skills/lumbre/SKILL.md"
```

Codex actual no necesita ese enlace. El guardado previo evita sobreescribir una
instalación real y el comando es idempotente si ya existe el enlace.

Para traer versiones posteriores:

```bash
npx --yes skills update lumbre -g -y
```

La distribución soportada sigue la rama `main` de este repositorio; no se
publican tags de versión de la skill. `skills` registra el origen y el hash
instalado en su lockfile para poder actualizar esa única copia gestionada.

La skill y el MCP se instalan por separado: este paso aporta las instrucciones
de trabajo al agente, pero no conecta Lumbre. Para autorizar el MCP remoto,
completa antes los pasos de [Conectar el MCP remoto](#conectar-el-mcp-remoto).

La instalación pública es ligera: incluye el router, nueve referencias operativas
(las de subagentes, adjuntos y conexión, y destinos se leen solo bajo demanda), metadata y una validación estructural pequeña. El historial, los bundles y el
oráculo del piloto permanecen en `tests/skill-lumbre/` dentro del repositorio y no
se copian a los runtimes. No se ha medido que Claude cargara accidentalmente esos
artefactos; separarlos elimina el riesgo de enrutamiento y reduce el paquete sin
presentar esa hipótesis como un fallo observado.

### Windows

Medido el 2026-10-07 en Windows 11 con Node.js 24, en Windows PowerShell 5.1 y
en Git Bash (el shell que instala Git for Windows). No se ha probado en
`cmd.exe`, PowerShell 7 ni WSL.

En Git Bash los bloques de esta guía funcionan tal cual: define `HOME` y
entiende `test -f` y la continuación de línea con `\`.

En PowerShell esos bloques no se pueden pegar: rechaza la continuación con `\`
y no tiene `test`. Escribe cada comando en una sola línea:

```powershell
npx --yes skills add fodaveg/lumbre-mcp -g -y --skill lumbre --agent codex claude-code
node "$HOME/.agents/skills/lumbre/scripts/manage-subagents.mjs" install --runtime all --dry-run
node "$HOME/.agents/skills/lumbre/scripts/manage-subagents.mjs" install --runtime all
node "$HOME/.agents/skills/lumbre/scripts/manage-subagents.mjs" check --runtime all
```

PowerShell no define la variable de entorno `HOME`; el gestor de subagentes
usa entonces `USERPROFILE`. Una copia de la skill instalada antes de ese
arreglo aborta con `HOME is required (or pass --home)`: añade `--home "$HOME"`
a los tres comandos de `manage-subagents.mjs`.

En la app de escritorio de Claude el conector puede llegar con un prefijo que no
es ninguno de los tres por defecto: el 7 oct 2026 se vio `mcp__<uuid>__` en
Windows, y los subagentes arrancaban sin ninguna tool. Mira el nombre completo
de una tool de Lumbre en tu sesión (por ejemplo `mcp__<uuid>__list_tasks`) y
pasa ese prefijo junto a los tres habituales, en una sola línea:

```powershell
node "$HOME/.agents/skills/lumbre/scripts/manage-subagents.mjs" install --runtime claude --replace-managed --claude-tool-prefix mcp__lumbre__ --claude-tool-prefix mcp__claude_ai_Lumbre__ --claude-tool-prefix mcp__claude_ai_lumbre__ --claude-tool-prefix mcp__<uuid>__
```

No está medido si ese identificador cambia al reconectar el conector ni si pasa
igual en la app de escritorio de macOS. Si cambia, repite el comando con el
nuevo. Sin subagentes la skill funciona igual: solo son un reparto opcional.

Para verificar la instalación, las dos líneas deben responder `True`:

```powershell
Test-Path "$HOME/.agents/skills/lumbre/SKILL.md"
Test-Path "$HOME/.claude/skills/lumbre/SKILL.md"
```

En Windows `skills` no crea un enlace simbólico en `~/.claude/skills/lumbre`,
sino una junction de directorio hacia `~/.agents/skills/lumbre`; sigue habiendo
una única copia. Se comprueba con:

```powershell
(Get-Item "$HOME/.claude/skills/lumbre").LinkType
```

El enlace de último recurso para un Codex antiguo (`ln -sfn`) no se ha medido
en Windows.

Si trabajas en un clon del repositorio, los validadores `.sh` se ejecutan desde
Git Bash: en la instalación medida PowerShell no tenía `sh` en el `PATH`. Git
for Windows trae
`core.autocrlf=true` y este repositorio fija los finales de línea en LF con
`.gitattributes`; un clon anterior a ese fichero sale en CRLF y
`skills/lumbre/scripts/validate.sh` falla con
`invalid or missing YAML frontmatter`. Vuelve a clonar para obtenerlo en LF.

