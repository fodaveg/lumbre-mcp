#!/bin/sh
set -eu

skill_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
entry="$skill_dir/SKILL.md"
manifest="$skill_dir/references/consolidation-manifest.md"

fail() {
  printf '%s\n' "lumbre skill validation failed: $*" >&2
  exit 1
}

[ -f "$entry" ] || fail "missing SKILL.md"
[ -f "$skill_dir/agents/openai.yaml" ] || fail "missing agents/openai.yaml"
[ -f "$manifest" ] || fail "missing consolidation manifest"

for ref in \
  read-and-daily.md \
  backlog.md \
  development.md \
  project-release.md \
  mcp-safe-operations.md \
  source-variants.md
do
  [ -f "$skill_dir/references/$ref" ] || fail "missing references/$ref"
  grep -Fq "references/$ref" "$entry" || fail "SKILL.md does not route to $ref"
done

grep -Eq '^name: lumbre$' "$entry" || fail "invalid skill name"
grep -Fq 'baseline por unión' "$entry" || fail "union baseline marker missing"
grep -Fq 'consolidation-manifest.md' "$skill_dir/references/source-variants.md" ||
  fail "consolidation manifest is not linked"
grep -Fq 'lectura incidental nunca muta' "$skill_dir/references/development.md" ||
  fail "scoped ack variant missing"
grep -Fq 'toda tarea sin estado' "$skill_dir/references/development.md" ||
  fail "strict ack variant missing"
grep -Fq 'Variante A — revisión final' "$skill_dir/references/project-release.md" ||
  fail "final-review variant missing"
grep -Fq 'Variante B — revisión paralela' "$skill_dir/references/project-release.md" ||
  fail "parallel-review variant missing"
grep -Fq 'Cobertura de cláusulas: 100%' "$manifest" || fail "coverage declaration missing"
grep -Fq 'eliminar o desconectar' "$skill_dir/references/source-variants.md" ||
  fail "duplicate-removal condition missing"

for source_id in CX-live AG-live CX-repo AG-repo CL-live CL-backup
do
  grep -Fq "| $source_id |" "$manifest" || fail "inventory source $source_id missing"
  grep -Fq "**$source_id**" "$skill_dir/references/source-variants.md" ||
    fail "source variant $source_id missing"
done

clause_count=$(grep -c '^| S[0-9][0-9] |' "$manifest")
[ "$clause_count" -eq 32 ] || fail "expected 32 mapped clauses, found $clause_count"

if grep -R -E '/Users/|/home/[[:alnum:]_.-]+/' \
  "$entry" "$skill_dir/agents" "$skill_dir/references" >/dev/null 2>&1; then
  fail "hard-coded user path found"
fi

if grep -R -E 'David|2026-[0-9]{2}-[0-9]{2}' \
  "$entry" "$skill_dir/agents" "$skill_dir/references" >/dev/null 2>&1; then
  fail "private identifier or ephemeral date found"
fi

if grep -R -E 'TODO|FIXME|\[TODO\]|<placeholder>' \
  "$entry" "$skill_dir/agents" "$skill_dir/references" >/dev/null 2>&1; then
  fail "unfinished placeholder found"
fi

printf '%s\n' "lumbre skill validation: ok"
