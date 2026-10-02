#!/bin/sh
set -eu

mode=${1:-full}
require_pilot=0
case "${2:-}" in
  "") ;;
  --require-pilot) require_pilot=1 ;;
  *) printf '%s\n' "usage: validate.sh [full|--preflight] [--require-pilot]" >&2; exit 2 ;;
esac
case "$mode" in
  full|--preflight) ;;
  --require-pilot) mode=full; require_pilot=1 ;;
  *) printf '%s\n' "usage: validate.sh [full|--preflight] [--require-pilot]" >&2; exit 2 ;;
esac

test_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$test_dir/../.." && pwd)
skill_dir="$repo_root/skills/lumbre"
evidence_dir="$test_dir/evidence"

command -v node >/dev/null 2>&1 || {
  printf '%s\n' "lumbre skill repository validation failed: node is required" >&2
  exit 1
}
git -C "$repo_root" rev-parse --git-dir >/dev/null 2>&1 || {
  printf '%s\n' \
    "lumbre skill repository validation failed: run from a Git checkout; installed copies intentionally omit pilot history" >&2
  exit 1
}

# El piloto vigente se verifica por su SHA. La captura histórica queda como
# fixture independiente y no acredita la skill actual.
current_evidence="$evidence_dir/forward-pilot-current.json"
pilot_available=1
if [ -f "$current_evidence" ]; then
  candidate_parent_sha=$(node -p \
    "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')).candidateParentSha" \
    "$current_evidence")
  git -C "$repo_root" cat-file -e "${candidate_parent_sha}^{commit}" >/dev/null 2>&1 \
    || pilot_available=0
else
  pilot_available=0
fi

if [ "$pilot_available" = 0 ]; then
  pilot_warning="piloto actual aún sin captura verificable; la evidencia histórica no acredita la skill vigente"
  printf '%s\n' "$pilot_warning" >&2
  if [ "$require_pilot" = 1 ]; then
    exit 1
  fi
fi

sh "$skill_dir/scripts/validate.sh"
node --check "$test_dir/forward-pilot-lib.mjs"
node --check "$test_dir/run-forward-pilot.mjs"
node --check "$test_dir/test-forward-pilot-verifier.mjs"
node --check "$test_dir/test-subagent-manager.mjs"
node --check "$test_dir/validate-evidence.mjs"
node --check "$test_dir/validate-tool-names.mjs"
node --check "$test_dir/verify-forward-pilot.mjs"
node "$test_dir/validate-evidence.mjs"
node "$test_dir/validate-tool-names.mjs"

if [ "$mode" = full ] && [ "$pilot_available" = 1 ]; then
  node "$test_dir/verify-forward-pilot.mjs" \
    --integrity-only "$current_evidence"
fi
if [ "$pilot_available" = 1 ]; then
  node "$test_dir/test-forward-pilot-verifier.mjs"
fi
node "$test_dir/test-subagent-manager.mjs"
if [ "$pilot_available" = 1 ]; then
  node "$test_dir/run-forward-pilot.mjs" --check-candidate
fi

if [ "$pilot_available" = 1 ]; then
  printf '%s\n' "lumbre skill repository validation: ok (piloto actual: integridad verificada; veredicto conductual en evidencia)"
else
  printf '%s\n' "lumbre skill repository validation: ok (sin piloto actual)"
fi
