#!/bin/sh
set -eu

mode=${1:-full}
case "$mode" in
  full|--preflight) ;;
  *) printf '%s\n' "usage: validate.sh [--preflight]" >&2; exit 2 ;;
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

sh "$skill_dir/scripts/validate.sh"
node --check "$test_dir/forward-pilot-lib.mjs"
node --check "$test_dir/run-forward-pilot.mjs"
node --check "$test_dir/test-forward-pilot-verifier.mjs"
node --check "$test_dir/validate-evidence.mjs"
node --check "$test_dir/verify-forward-pilot.mjs"
node "$test_dir/validate-evidence.mjs"

if [ "$mode" = full ]; then
  node "$test_dir/verify-forward-pilot.mjs" \
    --integrity-only "$evidence_dir/forward-pilot-evidence.json"
fi
node "$test_dir/test-forward-pilot-verifier.mjs"
node "$test_dir/run-forward-pilot.mjs" --check-candidate

printf '%s\n' "lumbre skill repository validation: ok"
