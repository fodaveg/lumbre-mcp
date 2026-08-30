#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALLOWED_OPERATIONS,
  auditEvents,
  assertCriteriaFreeze,
  CRITERIA_FILES,
  buildEvaluationEnvelope,
  buildEvaluationEnvironment,
  extractModelCapture,
  findPrivatePaths,
  metricsFromUsage,
  parseJsonl,
  sha256,
  validateAgainstSchema,
} from "./forward-pilot-lib.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..", "..");
const skillDir = join(repoRoot, "skills", "lumbre");
const evidenceDir = join(scriptDir, "evidence");
const defaultEvidence = join(
  evidenceDir,
  "forward-pilot-evidence.json",
);
const args = process.argv.slice(2);
const integrityOnly = args.includes("--integrity-only");
const requestedEvidence = args.find((arg) => arg !== "--integrity-only");
const evidencePath = resolve(requestedEvidence ?? defaultEvidence);
const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
function readCandidateFile(candidateSha, path) {
  const repoPath = path.startsWith("skills/") || path.startsWith("tests/")
    ? path
    : `skills/lumbre/${path}`;
  const result = spawnSync(
    "git",
    ["show", `${candidateSha}:${repoPath}`],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`historical pilot file is unavailable: ${path}`);
  }
  return result.stdout;
}

function findHistoricalPreregistration(candidateSha, expectedHash) {
  const matches = [];
  for (const path of [
    "references/forward-pilot-preregistration.json",
    "references/forward-pilot-next-preregistration.json",
  ]) {
    const result = spawnSync(
      "git",
      ["show", `${candidateSha}:skills/lumbre/${path}`],
      { cwd: repoRoot, encoding: "utf8" },
    );
    if (result.status === 0 && sha256(result.stdout) === expectedHash) {
      matches.push({ path, source: result.stdout });
    }
  }
  if (matches.length !== 1) {
    throw new Error("historical preregistration is missing or ambiguous");
  }
  return matches[0];
}

function callHistoricalExport(candidateSha, exportName, input) {
  const librarySource = readCandidateFile(
    candidateSha,
    "scripts/forward-pilot-lib.mjs",
  );
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(librarySource).toString("base64")}`;
  const driver = `
    const input = JSON.parse(await new Promise((resolve) => {
      let raw = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => raw += chunk);
      process.stdin.on("end", () => resolve(raw));
    }));
    const module = await import(${JSON.stringify(moduleUrl)});
    process.stdout.write(JSON.stringify(module[${JSON.stringify(exportName)}](input)));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", driver], {
    cwd: repoRoot,
    input: JSON.stringify(input),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`historical envelope builder failed: ${result.stderr.trim()}`);
  }
  return JSON.parse(result.stdout);
}

function buildHistoricalEnvelope(candidateSha, environment, bundleContents) {
  return callHistoricalExport(candidateSha, "buildEvaluationEnvelope", {
    environment,
    bundleContents,
  });
}

function deriveHistoricalVerification(candidateSha, evidence, rawLog, envelope) {
  const tempRoot = mkdtempSync(join(tmpdir(), "lumbre-pilot-history-"));
  try {
    const archive = spawnSync(
      "git",
      ["archive", candidateSha, "skills/lumbre"],
      { cwd: repoRoot, encoding: null, maxBuffer: 10 * 1024 * 1024 },
    );
    if (archive.status !== 0) {
      throw new Error("cannot archive historical pilot candidate");
    }
    const extracted = spawnSync("tar", ["-xf", "-", "-C", tempRoot], {
      input: archive.stdout,
      encoding: "utf8",
    });
    if (extracted.status !== 0) {
      throw new Error(`cannot extract historical pilot: ${extracted.stderr.trim()}`);
    }
    const historicalSkill = join(tempRoot, "skills", "lumbre");
    const historicalRefs = join(historicalSkill, "references");
    mkdirSync(historicalRefs, { recursive: true });
    const historicalEvidence = join(
      historicalRefs,
      "forward-pilot-evidence.json",
    );
    writeFileSync(historicalEvidence, `${JSON.stringify(evidence)}\n`);
    writeFileSync(
      join(historicalRefs, evidence.isolationAudit.eventLogFile),
      rawLog,
    );
    writeFileSync(
      join(historicalRefs, evidence.isolationAudit.envelopeFile),
      envelope,
    );
    const gitDir = spawnSync("git", ["rev-parse", "--absolute-git-dir"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    if (gitDir.status !== 0) throw new Error("cannot resolve historical git dir");
    const result = spawnSync(
      process.execPath,
      [join(historicalSkill, "scripts", "verify-forward-pilot.mjs"), historicalEvidence],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_DIR: gitDir.stdout.trim(),
          GIT_WORK_TREE: repoRoot,
        },
      },
    );
    const failures = result.stderr
      .split("\n")
      .filter((line) => line.startsWith("forward pilot failed: "))
      .map((line) => line.slice("forward pilot failed: ".length))
      .filter((line) => line !== "evidence: capture is not accepted");
    if (result.status !== 0 && failures.length === 0) {
      throw new Error(`historical verifier failed outside behavior: ${result.stderr.trim()}`);
    }
    const failedCases = new Set(
      failures
        .map((failure) => failure.match(/^(P\d{2}):/)?.[1])
        .filter(Boolean),
    );
    return {
      accepted: failures.length === 0,
      exactCasesPassed: 12 - failedCases.size,
      exactCasesTotal: 12,
      failures,
    };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

const schemaPath = join(evidenceDir, "forward-pilot-schema.json");
const schemaSource = integrityOnly
  ? readCandidateFile(
      evidence.candidateParentSha,
      "references/forward-pilot-schema.json",
    )
  : readFileSync(schemaPath, "utf8");
const schema = JSON.parse(schemaSource);
const historicalPreregistration = integrityOnly
  ? findHistoricalPreregistration(
      evidence.candidateParentSha,
      evidence.hashes?.preregistrationSha256,
    )
  : null;
const preregistrationPath = join(
  evidenceDir,
  "forward-pilot-next-preregistration.json",
);
const preregistrationSource = integrityOnly
  ? historicalPreregistration.source
  : readFileSync(preregistrationPath, "utf8");
const preregistration = JSON.parse(preregistrationSource);
if (!integrityOnly) {
  assertCriteriaFreeze(repoRoot, preregistration, evidence.candidateParentSha);
}
const criteriaFreeze = {
  ...preregistration,
  preregistrationSha256: sha256(preregistrationSource),
};
const failures = validateAgainstSchema({ cases: evidence.cases }, schema);
const behavioralFailures = [];
let checkingBehavior = false;
const byId = new Map(evidence.cases.map((entry) => [entry.id, entry]));

const mutationOperations = [
  "create_task",
  "cancel_task",
  "update_task_tags",
  "move_task_list",
  "update_task_section",
];
const developmentReleaseOperations = [
  "delegate_tests",
  "prepare_candidate",
  "implement_candidate",
  "gate_candidate",
  "review_candidate",
  "handoff_release",
];
const operationalReferences = [
  "read.md",
  "daily.md",
  "backlog.md",
  "development.md",
  "project-release.md",
  "mcp-safe-operations.md",
];

const contracts = {
  P01: {
    mode: "read",
    extensions: [],
    requiredReferences: ["SKILL.md", "read.md"],
    forbiddenReferences: operationalReferences.filter((entry) => entry !== "read.md"),
    firstAction: "list_tasks_today",
    requiredOperations: { list_tasks_today: 1 },
    exactOperationCounts: { list_tasks_today: 1 },
    forbiddenOperations: [...mutationOperations, ...developmentReleaseOperations],
    mutations: [],
    devState: "",
  },
  P02: {
    mode: "read",
    extensions: [],
    requiredReferences: ["SKILL.md", "read.md"],
    forbiddenReferences: operationalReferences.filter((entry) => entry !== "read.md"),
    firstAction: "get_task_full",
    requiredOperations: { get_task_full: 1 },
    exactOperationCounts: { get_task_full: 1 },
    forbiddenOperations: [...mutationOperations, ...developmentReleaseOperations],
    mutations: [],
    devState: "",
  },
  P03: {
    mode: "read",
    extensions: [],
    requiredReferences: ["SKILL.md", "read.md"],
    forbiddenReferences: operationalReferences.filter((entry) => entry !== "read.md"),
    firstAction: "list_lists",
    requiredOperations: { list_lists: 1, list_tasks: 1 },
    exactOperationCounts: { list_lists: 1, list_tasks: 1 },
    forbiddenOperations: [...mutationOperations, ...developmentReleaseOperations],
    precedence: [["list_lists", 1, "list_tasks", 1]],
    mutations: [],
    devState: "",
  },
  P04: {
    mode: "read",
    extensions: [],
    requiredReferences: ["SKILL.md", "read.md"],
    forbiddenReferences: operationalReferences.filter((entry) => entry !== "read.md"),
    firstAction: "refresh_sync",
    requiredOperations: { refresh_sync: 1, read_snapshot: 1 },
    exactOperationCounts: { refresh_sync: 1, read_snapshot: 1 },
    forbiddenOperations: [...mutationOperations, ...developmentReleaseOperations],
    precedence: [["refresh_sync", 1, "read_snapshot", 1]],
    mutations: [],
    devState: "",
  },
  P05: {
    mode: "daily",
    extensions: [],
    requiredReferences: ["SKILL.md", "daily.md", "mcp-safe-operations.md"],
    forbiddenReferences: ["read.md", "backlog.md", "development.md", "project-release.md"],
    firstAction: "create_task",
    requiredOperations: { create_task: 1, verify_task: 1 },
    exactOperationCounts: { create_task: 1 },
    forbiddenOperations: ["cancel_task", "update_task_tags", "move_task_list", "update_task_section", ...developmentReleaseOperations],
    precedence: [["create_task", 1, "verify_task", 1]],
    mutations: ["new-task:content,listId,recurrence"],
    devState: "",
  },
  P06: {
    mode: "daily",
    extensions: [],
    requiredReferences: ["SKILL.md", "daily.md", "mcp-safe-operations.md"],
    forbiddenReferences: ["read.md", "backlog.md", "development.md", "project-release.md"],
    firstAction: "get_task_full",
    requiredOperations: { get_task_full: 1, cancel_task: 1, verify_task: 1 },
    exactOperationCounts: { cancel_task: 1 },
    forbiddenOperations: ["create_task", "update_task_tags", "move_task_list", "update_task_section", ...developmentReleaseOperations],
    precedence: [["get_task_full", 1, "cancel_task", 1], ["cancel_task", 1, "verify_task", 1]],
    mutations: ["task-p06:cancellation"],
    devState: "",
  },
  P07: {
    mode: "daily+development",
    extensions: ["development"],
    requiredReferences: [
      "SKILL.md",
      "daily.md",
      "development.md",
      "mcp-safe-operations.md",
    ],
    forbiddenReferences: ["read.md", "backlog.md", "project-release.md"],
    firstAction: "get_task_full",
    requiredOperations: { get_task_full: 1, update_task_tags: 1, verify_task: 1 },
    exactOperationCounts: { update_task_tags: 1 },
    forbiddenOperations: ["create_task", "cancel_task", "move_task_list", "update_task_section", ...developmentReleaseOperations],
    precedence: [["get_task_full", 1, "update_task_tags", 1], ["update_task_tags", 1, "verify_task", 1]],
    mutations: ["task-p07:tags"],
    devState: "@acked",
  },
  P08: {
    mode: "daily+development",
    extensions: ["development"],
    requiredReferences: [
      "SKILL.md",
      "daily.md",
      "development.md",
      "mcp-safe-operations.md",
    ],
    forbiddenReferences: ["read.md", "backlog.md", "project-release.md"],
    firstAction: "get_task_full",
    requiredOperations: { get_task_full: 1, update_task_tags: 1, verify_task: 1, delegate_tests: 1 },
    exactOperationCounts: { update_task_tags: 1, delegate_tests: 1 },
    forbiddenOperations: ["create_task", "cancel_task", "move_task_list", "update_task_section", "prepare_candidate", "implement_candidate", "gate_candidate", "review_candidate", "handoff_release"],
    precedence: [["get_task_full", 1, "update_task_tags", 1], ["update_task_tags", 1, "verify_task", 1], ["verify_task", 1, "delegate_tests", 1]],
    mutations: ["task-p08:tags"],
    devState: "@wip",
    checkpoint: {
      status: "wip",
      ownership: "session-implements; tests-agent-owns-tests",
      nextAction: "integrate-delegated-test-evidence",
    },
  },
  P09: {
    mode: "backlog",
    extensions: [],
    requiredReferences: ["SKILL.md", "backlog.md"],
    forbiddenReferences: ["read.md", "daily.md", "development.md", "project-release.md"],
    firstAction: "get_task_full",
    requiredOperations: { get_task_full: 1, propose_triage: 1 },
    exactOperationCounts: { propose_triage: 1 },
    forbiddenOperations: [...mutationOperations, ...developmentReleaseOperations],
    precedence: [["get_task_full", 1, "propose_triage", 1]],
    mutations: ["task-a:tags", "task-b:tags", "task-c:tags", "task-d:tags"],
    devState: "",
  },
  P10: {
    mode: "backlog",
    extensions: [],
    requiredReferences: ["SKILL.md", "backlog.md", "mcp-safe-operations.md"],
    forbiddenReferences: ["read.md", "daily.md", "development.md", "project-release.md"],
    firstAction: "get_task_full",
    requiredOperations: { get_task_full: 1, move_task_list: 1, update_task_section: 1, verify_preserved_fields: 1 },
    exactOperationCounts: { move_task_list: 1, update_task_section: 1 },
    forbiddenOperations: ["create_task", "cancel_task", "update_task_tags", ...developmentReleaseOperations],
    precedence: [["get_task_full", 1, "move_task_list", 1], ["move_task_list", 1, "update_task_section", 1], ["update_task_section", 1, "verify_preserved_fields", "last"]],
    mutations: ["task-e:listId,sectionId", "task-f:listId,sectionId"],
    devState: "",
  },
  P11: {
    mode: "daily+development+project-release",
    extensions: ["development", "project-release"],
    requiredReferences: [
      "SKILL.md",
      "daily.md",
      "development.md",
      "project-release.md",
      "mcp-safe-operations.md",
    ],
    forbiddenReferences: ["read.md", "backlog.md"],
    firstActions: ["get_task_full", "read_repo_workflow"],
    requiredOperations: { read_repo_workflow: 1, get_task_full: 1, update_task_tags: 2, verify_task: 2, prepare_candidate: 1, implement_candidate: 1, gate_candidate: 1, review_candidate: 1, handoff_release: 1 },
    exactOperationCounts: { update_task_tags: 2, verify_task: 2, prepare_candidate: 1, implement_candidate: 1, gate_candidate: 1, review_candidate: 1, handoff_release: 1 },
    forbiddenOperations: ["create_task", "cancel_task", "move_task_list", "update_task_section", "delegate_tests"],
    precedence: [["read_repo_workflow", 1, "prepare_candidate", 1], ["get_task_full", 1, "update_task_tags", 1], ["update_task_tags", 1, "verify_task", 1], ["verify_task", 1, "implement_candidate", 1], ["prepare_candidate", 1, "implement_candidate", 1], ["implement_candidate", 1, "gate_candidate", 1], ["gate_candidate", 1, "review_candidate", 1], ["review_candidate", 1, "update_task_tags", 2], ["update_task_tags", 2, "verify_task", 2], ["verify_task", 2, "handoff_release", 1]],
    mutations: ["task-p11:tags"],
    devState: "@done",
    checkpoint: {
      status: "done",
      ownership: "implementation-session; release-owner-pending",
      nextAction: "handoff-verified-candidate-to-release-owner",
    },
    externalActions: ["commit"],
    releaseHandoffRequired: true,
  },
  P12: {
    mode: "none",
    extensions: [],
    requiredReferences: ["SKILL.md"],
    forbiddenReferences: operationalReferences,
    firstAction: "ask_clarification",
    requiredOperations: { ask_clarification: 1 },
    exactOperationCounts: { ask_clarification: 1 },
    forbiddenOperations: ALLOWED_OPERATIONS.filter((entry) => entry !== "ask_clarification"),
    mutations: [],
    devState: "",
    asksClarification: true,
  },
};

function sorted(values) {
  return values.slice().sort();
}

function equalArray(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function operationCount(sequence, operation) {
  return sequence.filter((entry) => entry === operation).length;
}

function operationIndex(sequence, operation, occurrence) {
  if (occurrence === "last") return sequence.lastIndexOf(operation);
  let seen = 0;
  for (const [index, entry] of sequence.entries()) {
    if (entry !== operation) continue;
    seen += 1;
    if (seen === occurrence) return index;
  }
  return -1;
}

function normalizedMutations(entry) {
  return entry.proposedMutations
    .map(
      (mutation) =>
        `${mutation.target}:${sorted(mutation.fields).join(",")}`,
    )
    .sort();
}

function check(condition, message) {
  if (!condition) {
    (checkingBehavior ? behavioralFailures : failures).push(message);
  }
}

function hashCandidateFiles(candidateSha, files) {
  const hashes = {};
  for (const path of files) {
    const result = spawnSync(
      "git",
      ["show", `${candidateSha}:skills/lumbre/${path}`],
      { cwd: repoRoot, encoding: null },
    );
    if (result.status !== 0) return null;
    hashes[path] = sha256(result.stdout);
  }
  return hashes;
}

check(evidence.protocolVersion === 2, "evidence: protocolVersion must be 2");
check(evidence.deterministic === false, "evidence: must declare non-determinism");
check(
  typeof evidence.captureStatus === "string" && evidence.captureStatus.length > 0,
  "evidence: capture status missing",
);
check(typeof evidence.codexVersion === "string", "evidence: codexVersion missing");
check(typeof evidence.model === "string", "evidence: model missing");
const captureContext = evidence.environment?.captureContext ?? {};
check(
  evidence.codexVersion === captureContext.codexVersion,
  "evidence: codexVersion differs from pre-capture context",
);
check(
  evidence.model === captureContext.model && evidence.model === evidence.environment?.model,
  "evidence: model differs from pre-capture context",
);
check(
  evidence.candidateParentSha === captureContext.candidateParentSha,
  "evidence: candidate SHA differs from pre-capture context",
);
check(
  /^[0-9a-f]{40}$/.test(evidence.candidateParentSha ?? ""),
  "evidence: candidate parent SHA missing",
);
for (const [name, hash] of Object.entries(evidence.captureHarness ?? {})) {
  check(/^[0-9a-f]{64}$/.test(hash), `evidence: invalid capture harness ${name}`);
}
check(
  Object.keys(evidence.captureHarness ?? {}).length === 2,
  "evidence: capture harness hashes missing",
);
check(
  equalArray(evidence.selection, Object.keys(contracts)),
  "evidence: selection must be P01-P12 in order",
);
check(evidence.cases.length === 12 && byId.size === 12, "evidence: 12 unique cases required");

checkingBehavior = true;
for (const [id, contract] of Object.entries(contracts)) {
  const entry = byId.get(id);
  if (!entry) {
    failures.push(`${id}: missing`);
    continue;
  }
  check(entry.mode === contract.mode, `${id}: unexpected mode`);
  check(
    entry.firstUsefulAction === entry.operationSequence[0],
    `${id}: first useful action is not the first operation`,
  );
  const allowedFirstActions = contract.firstActions ?? [contract.firstAction];
  if (allowedFirstActions[0]) {
    check(
      allowedFirstActions.includes(entry.firstUsefulAction),
      `${id}: first useful action mismatch`,
    );
  }
  check(
    equalArray(sorted(entry.extensions), sorted(contract.extensions)),
    `${id}: unexpected extensions`,
  );
  check(
    contract.requiredReferences.every((reference) =>
      entry.references.includes(reference),
    ),
    `${id}: required reference missing`,
  );
  check(
    contract.forbiddenReferences.every(
      (reference) => !entry.references.includes(reference),
    ),
    `${id}: forbidden reference present`,
  );
  for (const [operation, minimum] of Object.entries(
    contract.requiredOperations,
  )) {
    check(
      operationCount(entry.operationSequence, operation) >= minimum,
      `${id}: required operation missing (${operation})`,
    );
  }
  for (const [operation, exact] of Object.entries(
    contract.exactOperationCounts,
  )) {
    check(
      operationCount(entry.operationSequence, operation) === exact,
      `${id}: exact operation count mismatch (${operation})`,
    );
  }
  for (const operation of contract.forbiddenOperations) {
    check(
      !entry.operationSequence.includes(operation),
      `${id}: forbidden operation present (${operation})`,
    );
  }
  for (const [before, beforeOccurrence, after, afterOccurrence] of
    contract.precedence ?? []) {
    const beforeIndex = operationIndex(
      entry.operationSequence,
      before,
      beforeOccurrence,
    );
    const afterIndex = operationIndex(
      entry.operationSequence,
      after,
      afterOccurrence,
    );
    check(
      beforeIndex !== -1 && afterIndex !== -1 && beforeIndex < afterIndex,
      `${id}: precedence violation (${before}#${beforeOccurrence}<${after}#${afterOccurrence})`,
    );
  }
  check(
    equalArray(normalizedMutations(entry), sorted(contract.mutations)),
    `${id}: target/field allowlist mismatch`,
  );
  check(
    equalArray(sorted(entry.externalActions), sorted(contract.externalActions ?? [])),
    `${id}: external action allowlist mismatch`,
  );
  check(entry.devState === contract.devState, `${id}: unexpected development state`);
  check(entry.checkboxAction === "none", `${id}: checkbox must remain untouched`);
  check(entry.fullBacklogScan === false, `${id}: full backlog scan forbidden`);
  check(
    entry.asksClarification === (contract.asksClarification ?? false),
    `${id}: clarification behavior mismatch`,
  );
  check(
    entry.freshnessWarning === (contract.freshnessWarning ?? false),
    `${id}: freshness behavior mismatch`,
  );
  if (contract.checkpoint) {
    check(
      entry.checkpoint.status === contract.checkpoint.status,
      `${id}: checkpoint status mismatch`,
    );
    check(
      entry.checkpoint.ownership === contract.checkpoint.ownership,
      `${id}: checkpoint ownership mismatch`,
    );
    check(
      entry.checkpoint.nextAction === contract.checkpoint.nextAction,
      `${id}: checkpoint next action mismatch`,
    );
  } else {
    check(
      equalArray(Object.values(entry.checkpoint), ["", "", ""]),
      `${id}: checkpoint not expected`,
    );
  }
  check(entry.releaseAuthority === false, `${id}: release authority mismatch`);
  check(
    entry.releaseHandoffRequired === (contract.releaseHandoffRequired ?? false),
    `${id}: release handoff mismatch`,
  );
}
checkingBehavior = false;

const rawLogName = evidence.isolationAudit.eventLogFile;
check(
  basename(rawLogName) === rawLogName,
  "evidence: raw log must be adjacent to evidence",
);
const rawLogPath = join(dirname(evidencePath), basename(rawLogName));
const rawLog = readFileSync(rawLogPath, "utf8");
const eventLogHash = sha256(rawLog);
check(
  eventLogHash === evidence.hashes.publishedEventLogSha256 &&
    eventLogHash === evidence.hashes.captureRawEventLogSha256,
  "evidence: event log hashes mismatch",
);
const events = parseJsonl(rawLog);
const eventAudit = auditEvents(events);
check(
  JSON.stringify(eventAudit) === JSON.stringify(evidence.eventAudit),
  "evidence: event audit does not match raw JSONL",
);

let modelCapture;
try {
  modelCapture = extractModelCapture(events);
} catch (error) {
  failures.push(`evidence: ${error.message}`);
}
if (modelCapture) {
  check(
    JSON.stringify(modelCapture.response) ===
      JSON.stringify({ cases: evidence.cases }),
    "evidence: agent message cases differ from evidence",
  );
  check(
    JSON.stringify(evidence.metrics) ===
      JSON.stringify(
        metricsFromUsage(
          modelCapture.usage,
          evidence.metrics.elapsedMs,
          evidence.cases.length,
        ),
      ),
    "evidence: metrics differ from turn.completed usage",
  );
}

const envelopeName = evidence.isolationAudit.envelopeFile;
check(
  basename(envelopeName) === envelopeName,
  "evidence: envelope must be adjacent to evidence",
);
const envelope = readFileSync(
  join(dirname(evidencePath), basename(envelopeName)),
  "utf8",
);
check(
  sha256(envelope) === evidence.hashes.evaluationEnvelopeSha256,
  "evidence: envelope hash mismatch",
);
const promptSource = integrityOnly
  ? readCandidateFile(evidence.candidateParentSha, "references/forward-prompts.md")
  : readFileSync(join(evidenceDir, "forward-prompts.md"), "utf8");
const environmentInputs = {
  promptSource,
  model: evidence.model,
  captureContext,
  outputSchemaSha256: sha256(schemaSource),
  criteriaFreeze,
};
const expectedEnvironment = integrityOnly
  ? callHistoricalExport(
      evidence.candidateParentSha,
      "buildEvaluationEnvironment",
      environmentInputs,
    )
  : buildEvaluationEnvironment(environmentInputs);
check(
  JSON.stringify(evidence.environment) === JSON.stringify(expectedEnvironment),
  "evidence: environment differs from canonical inputs",
);
const bundleContents = Object.fromEntries(
  evidence.isolationAudit.bundleFiles.map((path) => [
    path,
    integrityOnly
      ? readCandidateFile(evidence.candidateParentSha, path)
      : readFileSync(join(skillDir, path), "utf8"),
  ]),
);
check(
  envelope ===
    (integrityOnly
      ? buildHistoricalEnvelope(
          evidence.candidateParentSha,
          expectedEnvironment,
          bundleContents,
        )
      : buildEvaluationEnvelope({
          environment: expectedEnvironment,
          bundleContents,
        })),
  "evidence: envelope differs from canonical reconstruction",
);
check(
  findPrivatePaths(`${rawLog}\n${envelope}`).length === 0,
  "evidence: published artifacts contain private paths",
);
if (integrityOnly) {
  const historicalVerification = deriveHistoricalVerification(
    evidence.candidateParentSha,
    evidence,
    rawLog,
    envelope,
  );
  check(
    JSON.stringify(evidence.verification) ===
      JSON.stringify(historicalVerification),
    "evidence: verification receipt differs from historical verifier",
  );
  check(
    historicalVerification.accepted
      ? evidence.captureStatus === "accepted"
      : evidence.captureStatus.startsWith("rejected-"),
    "evidence: capture status differs from historical verifier",
  );
}
check(
  evidence.privacyAudit.normalizationApplied === false &&
    evidence.privacyAudit.rawEqualsPublished === true &&
    evidence.privacyAudit.privatePathsFound.length === 0,
  "evidence: privacy audit mismatch",
);
check(eventAudit.toolCalls === 0, "evidence: tool call executed");
check(eventAudit.shellCalls === 0, "evidence: shell call executed");
check(eventAudit.mcpCalls === 0, "evidence: MCP call executed");
check(eventAudit.filesystemMutations === 0, "evidence: file mutation executed");
check(eventAudit.externalActions === 0, "evidence: external action executed");
check(
  eventAudit.runtimeErrors.every((message) =>
    message.includes("Under-development features enabled: skip_host_skill_discovery"),
  ),
  "evidence: unexpected runtime error event",
);

const operationalFiles = evidence.isolationAudit.bundleFiles;
check(
  equalArray(
    operationalFiles,
    [
      "SKILL.md",
      "references/backlog.md",
      "references/daily.md",
      "references/development.md",
      "references/mcp-safe-operations.md",
      "references/project-release.md",
      "references/read.md",
    ],
  ),
  "evidence: isolated bundle allowlist mismatch",
);
check(
  evidence.isolationAudit.unexpectedBundleFiles.length === 0 &&
    evidence.isolationAudit.bundleUnchangedAfterRun === true &&
    evidence.isolationAudit.oracleExposed === false,
  "evidence: isolation audit failed",
);
const currentOperationalHashes = Object.fromEntries(
  operationalFiles.map((path) => [
    path,
    sha256(readFileSync(join(skillDir, path))),
  ]),
);
const candidateOperationalHashes = hashCandidateFiles(
  evidence.candidateParentSha,
  operationalFiles,
);
check(
  candidateOperationalHashes !== null &&
    JSON.stringify(candidateOperationalHashes) ===
      JSON.stringify(evidence.hashes.operationalFiles),
  "evidence: candidate tree differs from captured operational bundle",
);
const candidateCriteriaHashes = hashCandidateFiles(
  evidence.candidateParentSha,
  integrityOnly ? Object.keys(preregistration.criteriaFiles) : CRITERIA_FILES,
);
check(
  candidateCriteriaHashes !== null &&
    JSON.stringify(candidateCriteriaHashes) ===
      JSON.stringify(preregistration.criteriaFiles),
  "evidence: candidate criteria differ from preregistration",
);
const candidatePreregistrationHashes = hashCandidateFiles(
  evidence.candidateParentSha,
  [
    integrityOnly
      ? historicalPreregistration.path
      : "tests/skill-lumbre/evidence/forward-pilot-next-preregistration.json",
  ],
);
const candidatePreregistrationPath = integrityOnly
  ? historicalPreregistration.path
  : "tests/skill-lumbre/evidence/forward-pilot-next-preregistration.json";
check(
  candidatePreregistrationHashes !== null &&
    candidatePreregistrationHashes[candidatePreregistrationPath] ===
      criteriaFreeze.preregistrationSha256,
  "evidence: candidate preregistration differs from published freeze",
);
if (!integrityOnly) {
  check(
    JSON.stringify(currentOperationalHashes) ===
      JSON.stringify(evidence.hashes.operationalFiles),
    "evidence: operational file hashes drifted",
  );
}
check(
  sha256(
    operationalFiles
      .map((path) =>
        `${path}\0${
          integrityOnly
            ? candidateOperationalHashes?.[path]
            : currentOperationalHashes[path]
        }`,
      )
      .join("\n"),
  ) === evidence.hashes.operationalBundleSha256,
  "evidence: operational bundle hash mismatch",
);
check(
  sha256(promptSource) === evidence.hashes.blindPromptsSha256,
  "evidence: blind prompts hash drifted",
);
check(
  sha256(schemaSource) === evidence.hashes.outputSchemaSha256,
  "evidence: output schema hash drifted",
);
check(
  criteriaFreeze.preregistrationSha256 ===
    evidence.hashes.preregistrationSha256,
  "evidence: preregistration hash mismatch",
);
check(
  sha256(JSON.stringify(evidence.environment)) ===
    evidence.hashes.evaluationEnvironmentSha256,
  "evidence: evaluation environment hash mismatch",
);
check(
  (integrityOnly
    ? candidateCriteriaHashes?.["scripts/run-forward-pilot.mjs"]
    : sha256(readFileSync(join(scriptDir, "run-forward-pilot.mjs")))) ===
    evidence.hashes.runnerSourceSha256,
  "evidence: runner source hash drifted",
);
check(
  evidence.captureHarness.runnerSourceSha256 ===
    evidence.hashes.runnerSourceSha256,
  "evidence: capture runner source is not published runner",
);
check(
  (integrityOnly
    ? candidateCriteriaHashes?.["scripts/forward-pilot-lib.mjs"]
    : sha256(readFileSync(join(scriptDir, "forward-pilot-lib.mjs")))) ===
    evidence.hashes.librarySourceSha256,
  "evidence: pilot library hash drifted",
);
check(
  evidence.captureHarness.librarySourceSha256 ===
    evidence.hashes.librarySourceSha256,
  "evidence: capture library source is not published library",
);
check(
  (integrityOnly
    ? candidateCriteriaHashes?.["scripts/verify-forward-pilot.mjs"]
    : sha256(readFileSync(join(scriptDir, "verify-forward-pilot.mjs")))) ===
    evidence.hashes.verifierSourceSha256,
  "evidence: verifier source hash drifted",
);
check(
  (integrityOnly
    ? candidateCriteriaHashes?.["scripts/test-forward-pilot-verifier.mjs"]
    : sha256(readFileSync(join(scriptDir, "test-forward-pilot-verifier.mjs")))) ===
    evidence.hashes.negativeTestSourceSha256,
  "evidence: negative test source hash drifted",
);
for (const [name, hash] of Object.entries(evidence.hashes)) {
  if (name === "operationalFiles") continue;
  check(/^[0-9a-f]{64}$/.test(hash), `evidence: invalid ${name}`);
}

const reportedFailures = integrityOnly
  ? failures
  : [...failures, ...behavioralFailures];
if (reportedFailures.length > 0) {
  for (const failure of reportedFailures) {
    console.error(`forward pilot failed: ${failure}`);
  }
  process.exit(1);
}

if (integrityOnly) {
  console.log(
    `forward pilot integrity: ok (${eventAudit.eventCount} events, behavioralFindings=${behavioralFailures.length}, model=${evidence.model})`,
  );
} else {
  console.log(
    `forward pilot: ok (12/12, ${eventAudit.eventCount} events, ${evidence.metrics.elapsedMs} ms, model=${evidence.model})`,
  );
}
