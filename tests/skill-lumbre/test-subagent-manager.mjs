#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadDefinitions,
  renderAgent,
  renderInstructions,
  runManager,
  targetPath,
} from "../../skills/lumbre/scripts/manage-subagents.mjs";

const testDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const repoRoot = resolve(testDir, "..", "..");
const skillDir = join(repoRoot, "skills", "lumbre");
const definitions = loadDefinitions(skillDir);

function captureIo() {
  const lines = [];
  return {
    lines,
    io: {
      log: (line) => lines.push(String(line)),
      error: (line) => lines.push(String(line)),
    },
  };
}

function options(home, overrides = {}) {
  return {
    command: "install",
    runtime: "all",
    home,
    skillDir,
    dryRun: false,
    replaceManaged: false,
    replaceUnmanaged: false,
    ...overrides,
  };
}

function claudeTools(source) {
  return source
    .match(/^tools:\s*(.+)$/m)?.[1]
    .split(",")
    .map((tool) => tool.trim());
}

function assertPromptContract(agentName, source) {
  const expected = renderInstructions(
    definitions.contracts,
    definitions.contracts.agents.find((agent) => agent.name === agentName),
  ).trim();
  assert.ok(source.includes(expected), `${agentName}: generated runtime lost canonical prompt`);
}

const portable = JSON.stringify(definitions.contracts);
assert.doesNotMatch(portable, /(?:claude|codex|anthropic|openai|haiku|luna|sonnet|opus|gpt-)/i);
assert.doesNotMatch(portable, /bookkeeper/i);

for (const agent of definitions.contracts.agents) {
  const claude = renderAgent(definitions, "claude", agent.name, {
    claudeToolPrefixes: ["mcp__test_lumbre__", "mcp__claude_alias__"],
  });
  const codex = renderAgent(definitions, "codex", agent.name);
  assertPromptContract(agent.name, claude);
  assertPromptContract(agent.name, codex);
  assert.match(claude, /^model: haiku$/m);
  assert.match(codex, /^# dispatch-model: gpt-5\.6-luna$/m);
  assert.match(codex, /^description = .*model=gpt-5\.6-luna.*tools se heredan/m);
  assert.match(codex, /^model_reasoning_effort = "low"$/m);
  assert.doesNotMatch(codex, /^model\s*=/m, "Codex cannot pin the model in this agent format");
  assert.doesNotMatch(codex, /^tools\s*=/m, "Codex cannot enforce a per-agent tool allowlist");
  assert.deepEqual(
    claudeTools(claude),
    ["mcp__test_lumbre__", "mcp__claude_alias__"].flatMap((prefix) =>
      agent.allowedOperations.map((operation) => `${prefix}${operation}`),
    ),
  );
  assert.doesNotMatch(`${claude}\n${codex}`, /bookkeeper/i);
}

const taggerContract = definitions.contracts.agents.find((agent) => agent.name === "lumbre-tagger");
const taggerPrompt = renderInstructions(definitions.contracts, taggerContract);
assert.match(taggerPrompt, /taskId[\s\S]*primero con get_task/i);
assert.match(taggerPrompt, /content íntegro devuelto por get_task/i);
assert.match(taggerPrompt, /No copies el texto de display de list_tasks/i);
assert.match(taggerPrompt, /Conserva byte a byte el resto del contenido/i);
assert.match(taggerPrompt, /éxito parcial/i);
assert.match(taggerPrompt, /refresh_sync una sola vez[\s\S]*relee una segunda vez/i);
assert.match(taggerPrompt, /mutate_tasks solo puede contener operaciones update con taskId y content/i);
assert.match(taggerPrompt, /@not-done es una señal humana/i);

const readerContract = definitions.contracts.agents.find((agent) => agent.name === "lumbre-reader");
assert.deepEqual(readerContract.allowedOperations, [
  "refresh_sync",
  "list_lists",
  "list_tasks",
  "get_task",
  "read_attachment",
]);
assert.match(renderInstructions(definitions.contracts, readerContract), /estrictamente read-only/i);

const dailyContract = definitions.contracts.agents.find(
  (agent) => agent.name === "lumbre-daily-operator",
);
for (const forbiddenOperation of [
  "delete_task",
  "remove_section",
  "move_to_list",
  "create_list",
  "rename_list",
  "remove_list",
]) {
  assert.ok(
    !dailyContract.allowedOperations.includes(forbiddenOperation),
    `daily operator unexpectedly allows ${forbiddenOperation}`,
  );
}
const dailyPrompt = renderInstructions(definitions.contracts, dailyContract);
assert.ok(!dailyContract.allowedOperations.includes("mutate_tasks"));
assert.match(dailyPrompt, /Borrar tareas, listas, secciones, adjuntos/i);
assert.match(dailyPrompt, /mover tareas entre ellas; triar o reorganizar backlogs/i);
assert.match(dailyPrompt, /No uses mutate_tasks/i);
assert.match(dailyPrompt, /refresh_sync una vez y relee una segunda vez/i);
assert.match(dailyPrompt, /@acked, @wip, @done o @not-done/i);

const temporaryHome = await mkdtemp(join(tmpdir(), "lumbre-subagents-test-"));
try {
  let capture = captureIo();
  assert.equal(runManager(options(temporaryHome, { dryRun: true }), capture.io), 0);
  assert.ok(capture.lines.some((line) => line.startsWith("PLAN claude/lumbre-tagger")));
  assert.equal(existsSync(join(temporaryHome, ".claude")), false, "dry-run wrote files");

  const preexistingPath = targetPath(definitions, "claude", "lumbre-tagger", temporaryHome);
  mkdirSync(dirname(preexistingPath), { recursive: true });
  writeFileSync(preexistingPath, "personal agent\n");
  capture = captureIo();
  assert.equal(runManager(options(temporaryHome), capture.io), 1);
  assert.match(capture.lines.join("\n"), /ABORT no files written/);
  assert.equal(
    existsSync(targetPath(definitions, "claude", "lumbre-reader", temporaryHome)),
    false,
    "a conflicting file caused a partial install",
  );
  assert.equal(existsSync(join(temporaryHome, ".codex")), false);
  unlinkSync(preexistingPath);

  capture = captureIo();
  assert.equal(runManager(options(temporaryHome), capture.io), 0);
  assert.equal(
    capture.lines.filter((line) => line.startsWith("WRITE ")).length,
    6,
    "first install must generate both adapters for all three agents",
  );

  capture = captureIo();
  assert.equal(runManager(options(temporaryHome), capture.io), 0);
  assert.equal(capture.lines.filter((line) => line.startsWith("KEEP ")).length, 6);

  const managedPath = targetPath(definitions, "claude", "lumbre-tagger", temporaryHome);
  const managedExpected = renderAgent(definitions, "claude", "lumbre-tagger");
  writeFileSync(managedPath, `${managedExpected}\nlocal drift\n`);
  capture = captureIo();
  assert.equal(runManager(options(temporaryHome), capture.io), 1);
  assert.match(capture.lines.join("\n"), /REFUSE claude\/lumbre-tagger managed-stale/);
  assert.match(readFileSync(managedPath, "utf8"), /local drift/);

  capture = captureIo();
  assert.equal(
    runManager(options(temporaryHome, { replaceManaged: true }), capture.io),
    0,
  );
  assert.equal(readFileSync(managedPath, "utf8"), managedExpected);

  const unmanagedPath = targetPath(definitions, "codex", "lumbre-reader", temporaryHome);
  writeFileSync(unmanagedPath, "name = \"personal-reader\"\n");
  capture = captureIo();
  assert.equal(
    runManager(options(temporaryHome, { replaceManaged: true }), capture.io),
    1,
  );
  assert.match(capture.lines.join("\n"), /REFUSE codex\/lumbre-reader unmanaged/);
  assert.equal(readFileSync(unmanagedPath, "utf8"), "name = \"personal-reader\"\n");

  capture = captureIo();
  assert.equal(
    runManager(options(temporaryHome, { replaceUnmanaged: true }), capture.io),
    0,
  );
  assert.equal(readFileSync(unmanagedPath, "utf8"), renderAgent(definitions, "codex", "lumbre-reader"));
  assert.equal(statSync(unmanagedPath).mode & 0o777, 0o600);

  capture = captureIo();
  assert.equal(
    runManager(options(temporaryHome, { command: "check" }), capture.io),
    0,
  );
  assert.equal(capture.lines.filter((line) => line.startsWith("OK ")).length, 6);

  const customPrefixes = ["mcp__lumbre__", "mcp__claude_ai_Lumbre__"];
  capture = captureIo();
  assert.equal(
    runManager(
      options(temporaryHome, {
        replaceManaged: true,
        claudeToolPrefixes: customPrefixes,
      }),
      capture.io,
    ),
    0,
  );
  capture = captureIo();
  assert.equal(
    runManager(
      options(temporaryHome, {
        command: "check",
        claudeToolPrefixes: customPrefixes,
      }),
      capture.io,
    ),
    0,
  );
  capture = captureIo();
  assert.equal(runManager(options(temporaryHome, { command: "check" }), capture.io), 1);
  assert.match(capture.lines.join("\n"), /FAIL claude\/lumbre-tagger managed-stale/);
} finally {
  await rm(temporaryHome, { recursive: true, force: true });
}

console.log("lumbre subagent manager: ok (contracts=3, adapters=6)");
