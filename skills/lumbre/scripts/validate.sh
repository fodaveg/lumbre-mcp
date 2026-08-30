#!/bin/sh
set -eu

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

for ref in read-and-daily.md backlog.md development.md project-release.md mcp-safe-operations.md
do
  [ -f "$refs/$ref" ] || fail "missing references/$ref"
  grep -Fq "references/$ref" "$entry" || fail "SKILL.md does not route to $ref"
done

[ -f "$refs/source-variants.md" ] || fail "missing historical source evidence"
[ -f "$refs/forward-prompts.md" ] || fail "missing blind forward prompts"
[ -f "$refs/forward-expectations.md" ] || fail "missing forward-test oracle"
if grep -Fq 'source-variants.md' "$entry"; then
  fail "historical variants must not be loaded by the operational router"
fi

grep -Eq '^name: lumbre$' "$entry" || fail "invalid skill name"
entry_lines=$(wc -l < "$entry" | tr -d ' ')
[ "$entry_lines" -le 120 ] || fail "router exceeds 120 lines ($entry_lines)"

grep -Fq 'Está apagado por defecto' "$entry" || fail "development opt-in missing"
grep -Fq 'estrictamente no mutante' "$refs/read-and-daily.md" ||
  fail "read-only mode missing"
grep -Fq 'no autoriza borrar, instalar, publicar ni desplegar' "$entry" ||
  fail "mode activation authority boundary missing"
grep -Fq 'refresques con efectos' "$refs/read-and-daily.md" ||
  fail "mutating refresh boundary missing"
grep -Fq 'No revises el backlog completo' "$refs/read-and-daily.md" ||
  fail "bounded-read rule missing"
grep -Fq 'la lectura puede estar desfasada' "$refs/read-and-daily.md" ||
  fail "omitted refresh freshness disclosure missing"
grep -Fq 'una lectura incidental nunca reconoce tareas' "$refs/development.md" ||
  fail "incidental ack guard missing"
grep -Fq 'Leer o resumir esa tarea sigue siendo lectura' "$entry" ||
  fail "read-only task with dev state routing guard missing"
grep -Fq 'aunque ya contenga un estado de desarrollo' "$refs/development.md" ||
  fail "development adhesion read-only boundary missing"
grep -Fq 'El lote es un `#tag`, nunca una sección' "$refs/development.md" ||
  fail "lot taxonomy missing"
grep -Fq 'checkpoint proporcional con estado' "$refs/development.md" ||
  fail "delegated work checkpoint missing"
grep -Fq 'En una tarea trivial basta una línea' "$refs/development.md" ||
  fail "delegated checkpoint proportionality missing"
grep -Fq 'mismo candidato' "$refs/project-release.md" ||
  fail "single-candidate review rule missing"
grep -Fq 'un push no demuestra despliegue' "$refs/project-release.md" ||
  fail "push/deploy distinction missing"
grep -Fq 'flujo OAuth/autorización' "$refs/mcp-safe-operations.md" ||
  fail "OAuth-first authorization missing"
grep -Fq 'Nunca pongas' "$refs/mcp-safe-operations.md" ||
  fail "URL token prohibition missing"
grep -Fq 'no debe cargarse durante una operación normal' "$refs/source-variants.md" ||
  fail "historical evidence is not marked non-normative"
grep -Fq 'Activar la skill no ejecuta esa retirada' "$manifest" ||
  fail "duplicate-removal authorization boundary missing"

prompt_count=$(grep -c '^| P[0-9][0-9] |' "$refs/forward-prompts.md")
[ "$prompt_count" -eq 12 ] ||
  fail "expected 12 blind prompts, found $prompt_count"
expectation_count=$(grep -c '^| P[0-9][0-9] |' "$refs/forward-expectations.md")
[ "$expectation_count" -eq 12 ] ||
  fail "expected 12 oracle rows, found $expectation_count"
for group in lectura día/dev backlog/release
do
  group_count=$(grep -c "| $group |" "$refs/forward-expectations.md")
  case "$group" in
    lectura|día/dev|backlog/release)
      [ "$group_count" -eq 4 ] || fail "expected 4 $group scenarios"
      ;;
  esac
done
prompt_ids=$(grep '^| P[0-9][0-9] |' "$refs/forward-prompts.md" | cut -d '|' -f 2 | tr -d ' ')
expectation_ids=$(grep '^| P[0-9][0-9] |' "$refs/forward-expectations.md" | cut -d '|' -f 2 | tr -d ' ')
[ "$prompt_ids" = "$expectation_ids" ] || fail "blind prompts and oracle IDs differ"
if grep -E 'Modo esperado|Contrato observable|cero mutaciones|No borra' \
  "$refs/forward-prompts.md" >/dev/null 2>&1; then
  fail "blind prompts leak expectations"
fi
grep -Fq 'No borra, instala, publica ni despliega' "$refs/forward-expectations.md" ||
  fail "activation negative scenario missing"
grep -Fq 'no carga desarrollo, no cambia `@wip`' "$refs/forward-expectations.md" ||
  fail "read-only dev-state negative scenario missing"
grep -Fq 'declara explícitamente que la lectura puede estar desfasada' \
  "$refs/forward-expectations.md" || fail "P04 strict oracle missing"
grep -Fq 'estado, ownership y siguiente paso' "$refs/forward-expectations.md" ||
  fail "P08 strict oracle missing"

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
