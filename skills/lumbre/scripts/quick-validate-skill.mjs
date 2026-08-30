#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const skillDir = resolve(process.argv[2] ?? new URL("..", import.meta.url).pathname);
const source = readFileSync(resolve(skillDir, "SKILL.md"), "utf8");
const match = source.match(/^---\n([\s\S]*?)\n---/);
if (!match) throw new Error("invalid or missing YAML frontmatter");

const allowed = new Set([
  "name",
  "description",
  "license",
  "allowed-tools",
  "metadata",
]);
const keys = [...match[1].matchAll(/^([a-zA-Z][a-zA-Z0-9-]*):/gm)].map(
  (entry) => entry[1],
);
for (const key of keys) {
  if (!allowed.has(key)) throw new Error(`unexpected frontmatter key: ${key}`);
}

const name = match[1].match(/^name:\s*([^\n]+)$/m)?.[1]?.trim() ?? "";
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
  throw new Error("invalid skill name");
}
if (!keys.includes("description")) throw new Error("missing skill description");
if (/^\s*\[TODO:[^\n]*\]\s*$/m.test(source.slice(match[0].length))) {
  throw new Error("unfinished skill placeholder");
}

console.log("skill quick validation: ok");
