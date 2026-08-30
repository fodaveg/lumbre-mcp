#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALLOWED_OPERATIONS,
  CRITERIA_FILES,
  OPERATIONAL_FILES,
  SELECTED_IDS,
  assertCriteriaFreeze,
  auditEvents,
  buildCaptureEvidence,
  buildEvaluationEnvelope,
  buildEvaluationEnvironment,
  extractModelCapture,
  findPrivatePaths,
  parseJsonl,
  sha256,
  validateAgainstSchema,
} from "./forward-pilot-lib.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const skillDir = resolve(scriptDir, "..");
const repoRoot = resolve(skillDir, "..", "..");
const promptsPath = join(skillDir, "references", "forward-prompts.md");
const schemaPath = join(skillDir, "references", "forward-pilot-schema.json");
const preregistrationPath = join(
  skillDir,
  "references",
  "forward-pilot-next-preregistration.json",
);
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
const preregistrationSource = readFileSync(preregistrationPath, "utf8");
const preregistration = JSON.parse(preregistrationSource);
const criteriaFreeze = {
  ...preregistration,
  preregistrationSha256: sha256(preregistrationSource),
};
const checkCandidateOnly = process.argv[2] === "--check-candidate";
const outputPath = checkCandidateOnly ? undefined : process.argv[2];
const model = process.env.LUMBRE_PILOT_MODEL ?? "gpt-5.4";

if (!outputPath && !checkCandidateOnly) {
  console.error("usage: run-forward-pilot.mjs <output.json>|--check-candidate");
  process.exit(2);
}

const selectedIds = SELECTED_IDS;
const operationalFiles = OPERATIONAL_FILES;

function listFiles(root, current = root) {
  const found = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) found.push(...listFiles(root, absolute));
    else found.push(relative(root, absolute));
  }
  return found.sort();
}

function hashFiles(root, files) {
  return Object.fromEntries(
    files.map((path) => [path, sha256(readFileSync(join(root, path)))]),
  );
}

function runText(command, args, cwd = repoRoot) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function hashCandidateFiles(candidateSha, files) {
  return Object.fromEntries(
    files.map((path) => {
      const result = spawnSync(
        "git",
        ["show", `${candidateSha}:skills/lumbre/${path}`],
        { cwd: repoRoot, encoding: null },
      );
      if (result.status !== 0) {
        throw new Error(`candidate does not contain ${path}`);
      }
      return [path, sha256(result.stdout)];
    }),
  );
}

function resolvePreregisteredCandidate() {
  const head = runText("git", ["rev-parse", "HEAD"]);
  const preregistrationHash = sha256(preregistrationSource);
  const history = runText("git", ["rev-list", "--all", "--parents"]);
  const candidates = history
    .split("\n")
    .map((line) => line.split(" "))
    .filter((parts) => parts[1] === preregistration.baseSha)
    .map(([candidate]) => candidate)
    .filter((candidate) => {
      const source = spawnSync(
        "git",
        [
          "show",
          `${candidate}:skills/lumbre/references/forward-pilot-next-preregistration.json`,
        ],
        { cwd: repoRoot, encoding: "utf8" },
      );
      return source.status === 0 && sha256(source.stdout) === preregistrationHash;
    });
  if (candidates.length !== 1) {
    throw new Error("cannot resolve a unique preregistered candidate");
  }
  return { candidateSha: candidates[0], headSha: head };
}

const { candidateSha, headSha } = resolvePreregisteredCandidate();

const captureContext = {
  codexVersion: runText("codex", ["--version"]),
  model,
  candidateParentSha: candidateSha,
};
assertCriteriaFreeze(
  skillDir,
  preregistration,
  captureContext.candidateParentSha,
);
if (!checkCandidateOnly) {
  const preflight = spawnSync(join(scriptDir, "validate.sh"), ["--preflight"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (preflight.status !== 0) {
    throw new Error(
      `pilot preflight failed: ${preflight.stderr || preflight.stdout}`,
    );
  }
}
const candidateCriteriaHashes = hashCandidateFiles(
  captureContext.candidateParentSha,
  CRITERIA_FILES,
);
if (
  JSON.stringify(candidateCriteriaHashes) !==
  JSON.stringify(preregistration.criteriaFiles)
) {
  throw new Error("criteria freeze differs from snapshotted candidate");
}
const candidatePreregistrationHash = hashCandidateFiles(
  captureContext.candidateParentSha,
  ["references/forward-pilot-next-preregistration.json"],
)["references/forward-pilot-next-preregistration.json"];
if (candidatePreregistrationHash !== criteriaFreeze.preregistrationSha256) {
  throw new Error("preregistration differs from snapshotted candidate");
}
if (checkCandidateOnly) {
  console.log(`forward pilot candidate: ok (${candidateSha})`);
  process.exit(0);
}

const promptSource = readFileSync(promptsPath, "utf8");
const outputSchemaSha256 = sha256(readFileSync(schemaPath));
const evaluationEnvironment = buildEvaluationEnvironment({
  promptSource,
  model,
  captureContext,
  outputSchemaSha256,
  criteriaFreeze,
});
const tempRoot = mkdtempSync(join(tmpdir(), "lumbre-forward-pilot-"));
const bundleDir = join(tempRoot, "bundle");
const executionDir = join(tempRoot, "execution");
mkdirSync(bundleDir);
mkdirSync(executionDir);

try {
for (const path of operationalFiles) {
  const target = join(bundleDir, path);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(skillDir, path), target);
}
const bundleFilesBefore = listFiles(bundleDir);
if (JSON.stringify(bundleFilesBefore) !== JSON.stringify(operationalFiles.slice().sort())) {
  throw new Error(`isolated bundle contains unexpected files: ${bundleFilesBefore}`);
}
const bundleHashesBefore = hashFiles(bundleDir, bundleFilesBefore);
const candidateOperationalHashes = hashCandidateFiles(
  captureContext.candidateParentSha,
  bundleFilesBefore,
);
if (JSON.stringify(candidateOperationalHashes) !== JSON.stringify(bundleHashesBefore)) {
  throw new Error("operational bundle differs from snapshotted candidate");
}
const bundleContents = Object.fromEntries(
  bundleFilesBefore.map((path) => [path, readFileSync(join(bundleDir, path), "utf8")]),
);
const evaluationPrompt = buildEvaluationEnvelope({
  environment: evaluationEnvironment,
  bundleContents,
});

const rawLogPath = outputPath.endsWith(".json")
  ? `${outputPath.slice(0, -5)}.events.jsonl`
  : `${outputPath}.events.jsonl`;
const envelopePath = outputPath.endsWith(".json")
  ? `${outputPath.slice(0, -5)}.envelope.txt`
  : `${outputPath}.envelope.txt`;
const lastMessagePath = join(executionDir, "last-message.json");
const runnerSource = readFileSync(fileURLToPath(import.meta.url));
const librarySource = readFileSync(join(scriptDir, "forward-pilot-lib.mjs"));
const runnerSourceSha256 = sha256(runnerSource);
const librarySourceSha256 = sha256(librarySource);
const promptPrivatePaths = findPrivatePaths(evaluationPrompt);
if (promptPrivatePaths.length > 0) {
  throw new Error(
    `evaluation envelope contains private paths: ${JSON.stringify(promptPrivatePaths)}`,
  );
}
const startedAt = process.hrtime.bigint();

  const args = [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--enable",
    "skip_host_skill_discovery",
    "--config",
    "suppress_unstable_features_warning=true",
    "--disable",
    "skill_search",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--model",
    model,
    "--json",
    "--output-schema",
    schemaPath,
    "--output-last-message",
    lastMessagePath,
    "-C",
    executionDir,
    "-",
  ];
  const result = spawnSync("codex", args, {
    encoding: "utf8",
    input: evaluationPrompt,
    maxBuffer: 10 * 1024 * 1024,
  });
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  const captureRawEventLog = result.stdout ?? "";
  const capturePrivatePaths = findPrivatePaths(
    `${captureRawEventLog}\n${result.stderr ?? ""}`,
  );
  if (capturePrivatePaths.length > 0) {
    throw new Error(
      `capture contains private paths; refusing to publish: ${JSON.stringify(capturePrivatePaths)}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `codex evaluator failed (${result.status ?? "no status"}): ${result.stderr || result.stdout}`,
    );
  }

  const events = parseJsonl(captureRawEventLog);
  const eventAudit = auditEvents(events);
  if (eventAudit.toolCalls !== 0) {
    throw new Error(`evaluator used denied tools: ${JSON.stringify(eventAudit.deniedItems)}`);
  }
  if (
    eventAudit.runtimeErrors.some(
      (message) =>
        !message.includes(
          "Under-development features enabled: skip_host_skill_discovery",
        ),
    )
  ) {
    throw new Error(
      `evaluator emitted an unexpected runtime error: ${JSON.stringify(eventAudit.runtimeErrors)}`,
    );
  }
  const { response, responseText } = extractModelCapture(events);
  const lastMessage = readFileSync(lastMessagePath, "utf8").trimEnd();
  if (lastMessage !== responseText) {
    throw new Error("agent_message and output-last-message differ");
  }
  const schemaFailures = validateAgainstSchema(response, schema);
  if (schemaFailures.length > 0) {
    throw new Error(`evaluator response failed schema: ${schemaFailures.join("; ")}`);
  }
  const bundleFilesAfter = listFiles(bundleDir);
  const bundleHashesAfter = hashFiles(bundleDir, bundleFilesAfter);
  if (
    JSON.stringify(bundleFilesAfter) !== JSON.stringify(bundleFilesBefore) ||
    JSON.stringify(bundleHashesAfter) !== JSON.stringify(bundleHashesBefore)
  ) {
    throw new Error("isolated skill bundle changed during evaluation");
  }
  if (
    runText("codex", ["--version"]) !== captureContext.codexVersion ||
    runText("git", ["rev-parse", "HEAD"]) !== headSha ||
    resolvePreregisteredCandidate().candidateSha !==
      captureContext.candidateParentSha
  ) {
    throw new Error("Codex version or candidate HEAD changed during evaluation");
  }
  assertCriteriaFreeze(
    skillDir,
    preregistration,
    captureContext.candidateParentSha,
  );

  const evidence = buildCaptureEvidence({
    ...captureContext,
    selection: selectedIds,
    runner:
      "codex exec --ephemeral --ignore-user-config --ignore-rules --enable skip_host_skill_discovery --config suppress_unstable_features_warning=true --disable skill_search --sandbox read-only",
    hashes: {
      operationalBundleSha256: sha256(
        bundleFilesBefore
          .map((path) => `${path}\0${bundleHashesBefore[path]}`)
          .join("\n"),
      ),
      operationalFiles: bundleHashesBefore,
      blindPromptsSha256: sha256(promptSource),
      outputSchemaSha256,
      preregistrationSha256: criteriaFreeze.preregistrationSha256,
      runnerSourceSha256,
      librarySourceSha256,
      verifierSourceSha256: sha256(
        readFileSync(join(scriptDir, "verify-forward-pilot.mjs")),
      ),
      negativeTestSourceSha256: sha256(
        readFileSync(join(scriptDir, "test-forward-pilot-verifier.mjs")),
      ),
    },
    environment: evaluationEnvironment,
    isolationAudit: {
      bundleFiles: bundleFilesBefore,
      unexpectedBundleFiles: [],
      bundleUnchangedAfterRun: true,
      oracleExposed: false,
      eventLogFile: basename(rawLogPath),
      envelopeFile: basename(envelopePath),
    },
    eventLog: captureRawEventLog,
    envelope: evaluationPrompt,
    elapsedMs: Math.round(elapsedMs),
  });

  writeFileSync(envelopePath, evaluationPrompt);
  writeFileSync(rawLogPath, captureRawEventLog);
  writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`forward pilot captured: ${outputPath}`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
