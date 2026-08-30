#!/usr/bin/env node

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "..", "..");
const skillDir = join(repoRoot, "skills", "lumbre");
const evidenceDir = join(testDir, "evidence");
const expectedEvidence = [
  "consolidation-manifest.md",
  "forward-expectations.md",
  "forward-pilot-evidence.envelope.txt",
  "forward-pilot-evidence.events.jsonl",
  "forward-pilot-evidence.json",
  "forward-pilot-history-update.bundle",
  "forward-pilot-history.bundle",
  "forward-pilot-next-preregistration.json",
  "forward-pilot-preregistration.json",
  "forward-pilot-schema.json",
  "forward-pilot.md",
  "forward-prompts.md",
  "source-variants.md",
];

function invariant(name, condition, detail) {
  if (!condition) throw new Error(`${name}: ${detail}`);
}

function read(path) {
  return readFileSync(path, "utf8");
}

function statExists(path) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

const evidenceFiles = readdirSync(evidenceDir, { withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
  .sort();
invariant(
  "REPO_ONLY_EVIDENCE_INVENTORY",
  JSON.stringify(evidenceFiles) === JSON.stringify(expectedEvidence),
  `unexpected inventory: ${evidenceFiles.join(", ")}`,
);

const publicReferenceFiles = readdirSync(join(skillDir, "references"), {
  withFileTypes: true,
})
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name);
invariant(
  "EVIDENCE_NOT_INSTALLED_AS_REFERENCE",
  publicReferenceFiles.every((name) => !expectedEvidence.includes(name)),
  "repo-only evidence leaked into the installed reference index",
);

function directoryBytes(root) {
  let total = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    total += entry.isDirectory() ? directoryBytes(path) : statSync(path).size;
  }
  return total;
}

const publicBytes = directoryBytes(skillDir);
invariant(
  "PUBLIC_SKILL_IS_LIGHTWEIGHT",
  publicBytes < 100_000,
  `installed surface is ${publicBytes} bytes (limit 100000)`,
);

const prompts = read(join(evidenceDir, "forward-prompts.md"));
const expectations = read(join(evidenceDir, "forward-expectations.md"));
const promptIds = [...prompts.matchAll(/^\| (P\d{2}) \|/gm)].map((match) => match[1]);
const expectationRows = [...expectations.matchAll(/^\| (P\d{2}) \| ([^|]+) \|/gm)];
const expectationIds = expectationRows.map((match) => match[1]);
invariant(
  "BLIND_PROMPTS_MATCH_ORACLE_IDS",
  promptIds.length === 16 && JSON.stringify(promptIds) === JSON.stringify(expectationIds),
  "expected matching P01-P16 tables",
);
const groupCounts = Object.fromEntries(
  ["lectura", "día/dev", "backlog/release"].map((group) => [
    group,
    expectationRows.filter((row) => row[2].trim() === group).length,
  ]),
);
invariant(
  "FORWARD_GROUP_COVERAGE",
  groupCounts.lectura === 4 &&
    groupCounts["día/dev"] === 6 &&
    groupCounts["backlog/release"] === 6,
  `unexpected groups: ${JSON.stringify(groupCounts)}`,
);
invariant(
  "BLIND_PROMPTS_DO_NOT_EXPOSE_ORACLE",
  !/(Modo esperado|Contrato observable|cero mutaciones|No borra)/.test(prompts),
  "blind prompts contain oracle language",
);

const manifest = read(join(evidenceDir, "consolidation-manifest.md"));
const clauses = [...manifest.matchAll(/^\| (S\d{2}) \|/gm)].map(
  (match) => match[1],
);
invariant(
  "CONSOLIDATION_COVERS_32_CLAUSES",
  clauses.length === 32 && new Set(clauses).size === 32,
  `found ${clauses.length} rows and ${new Set(clauses).size} unique ids`,
);
for (const sourceId of ["CX-live", "AG-live", "CX-repo", "AG-repo", "CL-live", "CL-backup"]) {
  invariant(
    "CONSOLIDATION_PRESERVES_ALL_SOURCE_VARIANTS",
    manifest.includes(`| ${sourceId} |`),
    `missing source ${sourceId}`,
  );
}

for (const name of evidenceFiles.filter((name) => name.endsWith(".md"))) {
  const source = read(join(evidenceDir, name));
  for (const match of source.matchAll(/\]\(([^)#]+)(?:#[^)]+)?\)/g)) {
    if (/^(?:https?:|mailto:)/.test(match[1])) continue;
    invariant(
      "EVIDENCE_RELATIVE_LINK_RESOLVES",
      statExists(join(evidenceDir, match[1])),
      `${name} -> ${match[1]}`,
    );
  }
}

const publishedArtifacts = [
  "forward-pilot-evidence.envelope.txt",
  "forward-pilot-evidence.events.jsonl",
  "forward-pilot-evidence.json",
].map((name) => read(join(evidenceDir, name))).join("\n");
invariant(
  "PUBLISHED_EVIDENCE_HAS_NO_PRIVATE_PATHS",
  !/(?:\/Users\/|\/home\/[A-Za-z0-9_.-]+\/)/.test(publishedArtifacts),
  "published capture includes a private path",
);

console.log(
  `lumbre skill evidence: ok (coverage=32/32, public=${publicBytes} bytes)`,
);
