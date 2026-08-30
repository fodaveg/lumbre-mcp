#!/bin/sh
set -eu

mode=${1:-full}
case "$mode" in
  full|--preflight) ;;
  *) printf '%s\n' "usage: validate.sh [--preflight]" >&2; exit 2 ;;
esac

skill_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
entry="$skill_dir/SKILL.md"
refs="$skill_dir/references"
manifest="$refs/consolidation-manifest.md"
repo_root=$(CDPATH= cd -- "$skill_dir/../.." 2>/dev/null && pwd || true)
optimization_doc="$repo_root/docs/lumbre-skill-optimization.md"

fail() {
  printf '%s\n' "lumbre skill validation failed: $*" >&2
  exit 1
}

[ -f "$entry" ] || fail "missing SKILL.md"
[ -f "$skill_dir/agents/openai.yaml" ] || fail "missing agents/openai.yaml"
[ -f "$manifest" ] || fail "missing consolidation manifest"

for ref in read.md daily.md backlog.md development.md project-release.md mcp-safe-operations.md
do
  [ -f "$refs/$ref" ] || fail "missing references/$ref"
  grep -Fq "references/$ref" "$entry" || fail "SKILL.md does not route to $ref"
done

[ -f "$refs/source-variants.md" ] || fail "missing historical source evidence"
[ -f "$refs/forward-prompts.md" ] || fail "missing blind forward prompts"
[ -f "$refs/forward-expectations.md" ] || fail "missing forward-test oracle"
[ -f "$refs/forward-pilot.md" ] || fail "missing reproducible pilot protocol"
[ -f "$refs/forward-pilot-evidence.json" ] || fail "missing pilot evidence"
[ -f "$refs/forward-pilot-evidence.events.jsonl" ] || fail "missing raw pilot event log"
[ -f "$refs/forward-pilot-evidence.envelope.txt" ] || fail "missing exact pilot envelope"
[ -f "$refs/forward-pilot-schema.json" ] || fail "missing pilot output schema"
[ -f "$refs/forward-pilot-preregistration.json" ] ||
  fail "missing historical pilot preregistration"
[ -f "$refs/forward-pilot-next-preregistration.json" ] ||
  fail "missing next pilot preregistration"
[ -f "$refs/forward-pilot-history.bundle" ] ||
  fail "missing self-contained pilot git bundle"
if grep -Fq 'source-variants.md' "$entry"; then
  fail "historical variants must not be loaded by the operational router"
fi

grep -Eq '^name: lumbre$' "$entry" || fail "invalid skill name"
entry_lines=$(wc -l < "$entry" | tr -d ' ')
[ "$entry_lines" -le 120 ] || fail "router exceeds 120 lines ($entry_lines)"

grep -Fq 'Está apagado por defecto' "$entry" || fail "development opt-in missing"
grep -Fq 'estrictamente no mutante' "$refs/read.md" ||
  fail "read-only mode missing"
grep -Fq 'no autoriza borrar, instalar, publicar ni desplegar' "$entry" ||
  fail "mode activation authority boundary missing"
grep -Fq 'refresques con efectos' "$refs/read.md" ||
  fail "mutating refresh boundary missing"
grep -Fq 'No revises el backlog completo' "$refs/read.md" ||
  fail "bounded-read rule missing"
grep -Fq 'la lectura puede estar desfasada' "$refs/read.md" ||
  fail "omitted refresh freshness disclosure missing"
grep -Fq 'una lectura incidental nunca reconoce tareas' "$refs/development.md" ||
  fail "incidental ack guard missing"
grep -Fq 'Leer o resumir esa tarea sigue siendo lectura' "$entry" ||
  fail "read-only task with dev state routing guard missing"
grep -Fq 'aunque ya contenga un estado de desarrollo' "$refs/development.md" ||
  fail "development adhesion read-only boundary missing"
grep -Fq 'No cargues `development.md` solo porque la tarea leída' "$refs/read.md" ||
  fail "read-only progressive disclosure boundary missing"
grep -Fq 'El lote es un `#tag`, nunca una sección' "$refs/development.md" ||
  fail "lot taxonomy missing"
grep -Fq 'checkpoint proporcional con' "$refs/development.md" ||
  fail "delegated work checkpoint missing"
grep -Fq 'En una tarea trivial basta una línea' "$refs/development.md" ||
  fail "delegated checkpoint proportionality missing"
grep -Fq 'verifica esa escritura antes de delegar' "$refs/development.md" ||
  fail "verify-before-delegate boundary missing"
grep -Fq 'exclusivamente una señal humana' "$refs/development.md" ||
  fail "human-only not-done boundary missing"
grep -Fq 'en la conversación un checkpoint' "$refs/development.md" ||
  fail "checkpoint surface missing"
grep -Fq 'muestra primero una vista' "$refs/backlog.md" ||
  fail "open-triage preview boundary missing"
grep -Fq 'no autoriza por sí misma ninguna mutación adicional' "$refs/project-release.md" ||
  fail "release mutation boundary missing"
grep -Fq 'Elige primero el modo base' "$entry" ||
  fail "base mode routing missing"
grep -Fq 'Añade solo las extensiones necesarias' "$entry" ||
  fail "extension routing missing"
grep -Fq 'mismo candidato' "$refs/project-release.md" ||
  fail "single-candidate review rule missing"
grep -Fq 'un push no demuestra despliegue' "$refs/project-release.md" ||
  fail "push/deploy distinction missing"
grep -Fq 'permite crear el commit candidato' "$refs/project-release.md" ||
  fail "implementation commit authority boundary missing"
grep -Fq 'flujo OAuth/autorización' "$refs/mcp-safe-operations.md" ||
  fail "OAuth-first authorization missing"
grep -Fq 'Antes de mutar una tarea existente o delegar trabajo' \
  "$refs/mcp-safe-operations.md" || fail "full-read-before-write boundary missing"
grep -Fq 'esa respuesta no incluye todavía operaciones de' "$refs/backlog.md" ||
  fail "open triage confirmation stop missing"
grep -Fq 'Prepara ownership, rama y worktree antes de implementar' \
  "$refs/project-release.md" || fail "prepare-before-implement boundary missing"
grep -Fq 'Nunca pongas' "$refs/mcp-safe-operations.md" ||
  fail "URL token prohibition missing"
grep -Fq 'no debe cargarse durante una operación normal' "$refs/source-variants.md" ||
  fail "historical evidence is not marked non-normative"
grep -Fq 'Activar la skill no ejecuta esa retirada' "$manifest" ||
  fail "duplicate-removal authorization boundary missing"

prompt_count=$(grep -c '^| P[0-9][0-9] |' "$refs/forward-prompts.md")
[ "$prompt_count" -eq 16 ] ||
  fail "expected 16 blind prompts, found $prompt_count"
expectation_count=$(grep -c '^| P[0-9][0-9] |' "$refs/forward-expectations.md")
[ "$expectation_count" -eq 16 ] ||
  fail "expected 16 oracle rows, found $expectation_count"
[ "$(grep -c '| lectura |' "$refs/forward-expectations.md")" -eq 4 ] ||
  fail "expected 4 lectura scenarios"
[ "$(grep -c '| día/dev |' "$refs/forward-expectations.md")" -eq 6 ] ||
  fail "expected 6 día/dev scenarios"
[ "$(grep -c '| backlog/release |' "$refs/forward-expectations.md")" -eq 6 ] ||
  fail "expected 6 backlog/release scenarios"
prompt_ids=$(grep '^| P[0-9][0-9] |' "$refs/forward-prompts.md" | cut -d '|' -f 2 | tr -d ' ')
expectation_ids=$(grep '^| P[0-9][0-9] |' "$refs/forward-expectations.md" | cut -d '|' -f 2 | tr -d ' ')
[ "$prompt_ids" = "$expectation_ids" ] || fail "blind prompts and oracle IDs differ"
if grep -E 'Modo esperado|Contrato observable|cero mutaciones|No borra' \
  "$refs/forward-prompts.md" >/dev/null 2>&1; then
  fail "blind prompts leak expectations"
fi
grep -Fq 'No borra, instala, publica ni despliega' "$refs/forward-expectations.md" ||
  fail "activation negative scenario missing"
grep -Fq 'no carga desarrollo ni la referencia MCP' "$refs/forward-expectations.md" ||
  fail "read-only dev-state negative scenario missing"
grep -Fq 'Enumera listas sin cargar backlog' "$refs/forward-expectations.md" ||
  fail "read-only empty-list routing scenario missing"
grep -Fq 'declara explícitamente que la lectura puede estar desfasada' \
  "$refs/forward-expectations.md" || fail "P04 strict oracle missing"
grep -Fq 'aplica y verifica `@wip` antes de delegar' \
  "$refs/forward-expectations.md" || fail "P08 verify-before-delegate oracle missing"
grep -Fq 'checkpoint proporcional' "$refs/forward-expectations.md" ||
  fail "P08 checkpoint oracle missing"
grep -Fq 'última verificación de campos preservados' \
  "$refs/forward-expectations.md" || fail "P10 final preservation check missing"
grep -Fq 'He puesto `@not-done`' "$refs/forward-prompts.md" ||
  fail "ambiguous not-done scenario missing"
grep -Fq 'observación post-publicación no bloqueante' \
  "$refs/forward-expectations.md" || fail "honest longitudinal criterion missing"

command -v node >/dev/null 2>&1 || fail "node is required for behavioral pilot checks"
history_tmp=
next_base=$(sed -n 's/.*"baseSha": "\([0-9a-f]*\)".*/\1/p' \
  "$refs/forward-pilot-next-preregistration.json")
if ! git -C "$repo_root" cat-file -e "$next_base^{commit}" >/dev/null 2>&1; then
  history_tmp=$(mktemp -d)
  trap 'rm -rf "$history_tmp"' EXIT HUP INT TERM
  git clone -q --bare "$refs/forward-pilot-history.bundle" "$history_tmp/repo.git" ||
    fail "cannot open self-contained pilot git bundle"
  export GIT_DIR="$history_tmp/repo.git"
  export GIT_WORK_TREE="$repo_root"
fi
node --check "$skill_dir/scripts/forward-pilot-lib.mjs" >/dev/null
node --check "$skill_dir/scripts/quick-validate-skill.mjs" >/dev/null
node --check "$skill_dir/scripts/run-forward-pilot.mjs" >/dev/null
node --check "$skill_dir/scripts/verify-forward-pilot.mjs" >/dev/null
node --check "$skill_dir/scripts/test-forward-pilot-verifier.mjs" >/dev/null
node "$skill_dir/scripts/quick-validate-skill.mjs" "$skill_dir"
if [ "$mode" = full ]; then
  node "$skill_dir/scripts/verify-forward-pilot.mjs" --integrity-only
fi
node "$skill_dir/scripts/test-forward-pilot-verifier.mjs"

for source_id in CX-live AG-live CX-repo AG-repo CL-live CL-backup
do
  grep -Fq "| $source_id |" "$manifest" ||
    fail "inventory source $source_id missing"
  grep -Fq "**$source_id**" "$refs/source-variants.md" ||
    fail "source evidence $source_id missing"
done

clause_count=$(grep -c '^| S[0-9][0-9] |' "$manifest")
[ "$clause_count" -eq 32 ] || fail "expected 32 mapped clauses, found $clause_count"
grep -Fq '100% (32/32)' "$manifest" || fail "32/32 coverage declaration missing"

for file in "$entry" "$refs"/*.md
do
  links=$(grep -oE '\]\([^)]+' "$file" 2>/dev/null | sed 's/^](//' || true)
  [ -z "$links" ] && continue
  old_ifs=$IFS
  IFS='
'
  for link in $links
  do
    case "$link" in
      http://*|https://*|mailto:*|'#'*) continue ;;
    esac
    target=${link%%#*}
    [ -z "$target" ] && continue
    [ -e "$(dirname -- "$file")/$target" ] || fail "broken link in $file: $link"
  done
  IFS=$old_ifs
done

if grep -R -E '/Users/|/home/[[:alnum:]_.-]+/' \
  "$entry" "$skill_dir/agents" "$refs" >/dev/null 2>&1; then
  fail "hard-coded user path found"
fi

if grep -R -E 'David|2026-[0-9]{2}-[0-9]{2}' \
  "$entry" "$skill_dir/agents" "$refs" >/dev/null 2>&1; then
  fail "private identifier or ephemeral date found"
fi

if grep -R -E 'TODO|FIXME|\[TODO\]|<placeholder>' \
  "$entry" "$skill_dir/agents" "$refs" >/dev/null 2>&1; then
  fail "unfinished placeholder found"
fi

if [ -f "$optimization_doc" ]; then
  grep -Fq 'forward-prompts.md' "$optimization_doc" ||
    fail "optimization doc does not describe blind prompts"
  grep -Fq 'forward-expectations.md' "$optimization_doc" ||
    fail "optimization doc does not describe the oracle"
  if grep -Eq '^\| P[0-9][0-9] \|' "$optimization_doc"; then
    fail "optimization doc leaks prompt/oracle rows together"
  fi
  disposition_count=$(grep -c '^| S[0-9][0-9] |' "$optimization_doc")
  [ "$disposition_count" -eq 32 ] ||
    fail "expected 32 optimization dispositions, found $disposition_count"
fi

printf '%s\n' "lumbre skill validation: ok (router=$entry_lines lines, coverage=32/32)"
