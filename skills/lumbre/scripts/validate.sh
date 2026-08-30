#!/bin/sh
set -eu

skill_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

command -v node >/dev/null 2>&1 || {
  printf '%s\n' "lumbre skill validation failed: node is required" >&2
  exit 1
}

node "$skill_dir/scripts/quick-validate-skill.mjs" "$skill_dir"
node "$skill_dir/scripts/validate-contracts.mjs" "$skill_dir"
