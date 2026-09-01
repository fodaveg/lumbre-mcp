#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MANAGER_ID = "lumbre-subagent-manager:v1";
const MANAGED_PATTERN =
  /^(?:#|<!--) lumbre-subagent-manager:v\d+ digest=[a-f0-9]{64}(?: -->)?$/m;
const DEFAULT_SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIMES = ["claude", "codex"];

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function validateDefinition(contracts, runtimeProfiles) {
  invariant(contracts.schemaVersion === 1, "unsupported contracts schema");
  invariant(contracts.skill === "lumbre", "contracts must target the lumbre skill");
  invariant(Array.isArray(contracts.shared?.invariants), "missing shared invariants");
  invariant(Array.isArray(contracts.agents), "missing agent contracts");
  invariant(runtimeProfiles.schemaVersion === 1, "unsupported runtime profile schema");

  const names = contracts.agents.map((agent) => agent.name);
  invariant(new Set(names).size === names.length, "agent names must be unique");
  invariant(
    JSON.stringify([...names].sort()) ===
      JSON.stringify([
        "lumbre-daily-operator",
        "lumbre-reader",
        "lumbre-tagger",
      ]),
    "the canonical contract must define the three supported agents",
  );

  for (const agent of contracts.agents) {
    invariant(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(agent.name), `invalid agent name: ${agent.name}`);
    for (const key of [
      "description",
      "trigger",
      "purpose",
      "allowedOperations",
      "operationLimits",
      "forbiddenCapabilities",
      "workflow",
    ]) {
      invariant(agent[key] && agent[key].length > 0, `${agent.name}: missing ${key}`);
    }
  }

  const portableSource = JSON.stringify({ shared: contracts.shared, agents: contracts.agents });
  invariant(
    !/(?:claude|codex|anthropic|openai|haiku|luna|sonnet|opus|gpt-)/i.test(portableSource),
    "provider or runtime names belong in runtime profiles, not portable contracts",
  );
  invariant(!/bookkeeper/i.test(portableSource), "portable agents must not depend on bookkeeper");

  for (const runtime of RUNTIMES) {
    invariant(runtimeProfiles.profiles?.[runtime], `missing runtime profile: ${runtime}`);
  }
}

export function loadDefinitions(skillDir = DEFAULT_SKILL_DIR) {
  const assetsDir = join(resolve(skillDir), "assets", "subagents");
  const contracts = readJson(join(assetsDir, "contracts.json"));
  const runtimeProfiles = readJson(join(assetsDir, "runtime-profiles.json"));
  validateDefinition(contracts, runtimeProfiles);
  return { contracts, runtimeProfiles };
}

function bulletList(items) {
  return items.map((item) => `- ${item}`).join("\n");
}

export function renderInstructions(contracts, agent) {
  return `Eres el subagente opcional \`${agent.name}\` de la skill pública de Lumbre.

## Propósito y activación

${agent.purpose}

Actívate cuando: ${agent.trigger}

${contracts.shared.purpose} Si este encargo rebasa tu contrato, detente y devuelve
al coordinador el trabajo restante; no intentes adquirir más tools ni ampliar autoridad.

## Invariantes compartidas

${bulletList(contracts.shared.invariants)}

## Operaciones permitidas

${bulletList(agent.allowedOperations.map((operation) => `\`${operation}\``))}

Límites de esas operaciones:

${bulletList(agent.operationLimits)}

## Capacidades prohibidas

${bulletList(agent.forbiddenCapabilities)}

## Flujo

${agent.workflow.map((step, index) => `${index + 1}. ${step}`).join("\n")}
`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validateClaudePrefix(prefix) {
  invariant(
    /^mcp__[A-Za-z0-9_-]+__$/.test(prefix),
    "--claude-tool-prefix must look like mcp__lumbre__",
  );
}

function renderClaude(contracts, profile, agent, options) {
  const prefixes = options.claudeToolPrefixes ?? profile.defaultToolPrefixes;
  invariant(Array.isArray(prefixes) && prefixes.length > 0, "Claude needs at least one tool prefix");
  for (const prefix of prefixes) validateClaudePrefix(prefix);
  const tools = [
    ...new Set(
      prefixes.flatMap((prefix) =>
        agent.allowedOperations.map((operation) => `${prefix}${operation}`),
      ),
    ),
  ];
  const instructions = renderInstructions(contracts, agent);
  const payload = [
    "---",
    `name: ${agent.name}`,
    `description: ${JSON.stringify(agent.description)}`,
    `model: ${profile.model}`,
    `tools: ${tools.join(", ")}`,
    "---",
    "",
    instructions,
  ].join("\n");
  return payload.replace(
    "---\n\n",
    `---\n\n<!-- ${MANAGER_ID} digest=${sha256(payload)} -->\n\n`,
  );
}

function renderCodex(contracts, profile, agent) {
  const instructions = renderInstructions(contracts, agent);
  const description =
    `${agent.description} En Codex, despachar con model=${profile.dispatchModel}; ` +
    "las tools se heredan y este contrato limita su uso.";
  invariant(!instructions.includes("'''"), `${agent.name}: unsupported TOML literal delimiter`);
  const payload = [
    "# tool-policy: instructions-only; this Codex agent format has no per-agent allowlist",
    `name = ${JSON.stringify(agent.name)}`,
    `model = ${JSON.stringify(profile.dispatchModel)}`,
    `description = ${JSON.stringify(description)}`,
    `model_reasoning_effort = ${JSON.stringify(profile.reasoningEffort)}`,
    "developer_instructions = '''",
    instructions.trimEnd(),
    "'''",
    "",
  ].join("\n");
  return `# ${MANAGER_ID} digest=${sha256(payload)}\n${payload}`;
}

export function renderAgent(definitions, runtime, agentName, options = {}) {
  invariant(RUNTIMES.includes(runtime), `unsupported runtime: ${runtime}`);
  const agent = definitions.contracts.agents.find((candidate) => candidate.name === agentName);
  invariant(agent, `unknown agent: ${agentName}`);
  const profile = definitions.runtimeProfiles.profiles[runtime];
  return runtime === "claude"
    ? renderClaude(definitions.contracts, profile, agent, options)
    : renderCodex(definitions.contracts, profile, agent);
}

export function targetPath(definitions, runtime, agentName, homeDir) {
  const profile = definitions.runtimeProfiles.profiles[runtime];
  return join(homeDir, profile.directory, `${agentName}${profile.extension}`);
}

function parseArgs(argv) {
  const options = {
    command: "install",
    runtime: "all",
    home: process.env.HOME,
    skillDir: DEFAULT_SKILL_DIR,
    dryRun: false,
    replaceManaged: false,
    replaceUnmanaged: false,
  };
  const args = [...argv];
  if (args[0] && !args[0].startsWith("--")) options.command = args.shift();

  while (args.length > 0) {
    const flag = args.shift();
    if (flag === "--dry-run") options.dryRun = true;
    else if (flag === "--replace-managed") options.replaceManaged = true;
    else if (flag === "--replace-unmanaged") options.replaceUnmanaged = true;
    else if (flag === "--runtime") options.runtime = args.shift();
    else if (flag === "--home") options.home = args.shift();
    else if (flag === "--skill-dir") options.skillDir = args.shift();
    else if (flag === "--claude-tool-prefix") {
      options.claudeToolPrefixes ??= [];
      options.claudeToolPrefixes.push(args.shift());
    }
    else throw new Error(`unknown argument: ${flag}`);
  }

  invariant(["install", "check"].includes(options.command), "command must be install or check");
  invariant([...RUNTIMES, "all"].includes(options.runtime), "--runtime must be all, claude or codex");
  invariant(options.home, "HOME is required (or pass --home)");
  invariant(options.skillDir, "--skill-dir requires a path");
  invariant(
    !(options.command === "check" && (options.dryRun || options.replaceManaged || options.replaceUnmanaged)),
    "check does not accept mutation flags",
  );
  return options;
}

function classifyTarget(path, expected) {
  if (!existsSync(path)) return { status: "missing" };
  const current = readFileSync(path, "utf8");
  if (current === expected) return { status: "current" };
  return { status: MANAGED_PATTERN.test(current) ? "managed-stale" : "unmanaged" };
}

function extractClaudeToolPrefixes(source) {
  const toolsLine = source.match(/^tools:\s*(.+)$/m)?.[1];
  if (!toolsLine) return undefined;
  const prefixes = [];
  for (const tool of toolsLine.split(",").map((value) => value.trim())) {
    const match = tool.match(/^(mcp__[A-Za-z0-9_-]+__)[A-Za-z0-9_]+$/);
    if (!match) return undefined;
    if (!prefixes.includes(match[1])) prefixes.push(match[1]);
  }
  return prefixes.length > 0 ? prefixes : undefined;
}

function inferManagedClaudePrefixes(definitions, homeDir) {
  const recovered = [];
  for (const agent of definitions.contracts.agents) {
    const path = targetPath(definitions, "claude", agent.name, homeDir);
    if (!existsSync(path)) continue;
    const source = readFileSync(path, "utf8");
    if (!MANAGED_PATTERN.test(source)) continue;
    const prefixes = extractClaudeToolPrefixes(source);
    invariant(
      prefixes,
      `cannot recover Claude tool prefixes from managed file: ${path}; ` +
        "pass --claude-tool-prefix explicitly",
    );
    recovered.push({ path, prefixes });
  }
  if (recovered.length === 0) return undefined;
  const expected = JSON.stringify(recovered[0].prefixes);
  invariant(
    recovered.every(({ prefixes }) => JSON.stringify(prefixes) === expected),
    "managed Claude agents disagree on tool prefixes; pass the intended " +
      "--claude-tool-prefix list explicitly",
  );
  return recovered[0].prefixes;
}

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  invariant(!existsSync(temporary), `temporary path already exists: ${temporary}`);
  try {
    writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function selectedRuntimes(runtime) {
  return runtime === "all" ? RUNTIMES : [runtime];
}

export function runManager(options, io = console) {
  const definitions = loadDefinitions(options.skillDir);
  const homeDir = resolve(options.home);
  const effectiveOptions = { ...options };
  if (
    selectedRuntimes(options.runtime).includes("claude") &&
    !effectiveOptions.claudeToolPrefixes
  ) {
    effectiveOptions.claudeToolPrefixes = inferManagedClaudePrefixes(definitions, homeDir);
    if (effectiveOptions.claudeToolPrefixes) {
      io.log(
        `NOTE Claude: recovered managed tool prefixes: ${effectiveOptions.claudeToolPrefixes.join(", ")}`,
      );
    }
  }
  const targets = [];
  for (const runtime of selectedRuntimes(options.runtime)) {
    for (const agent of definitions.contracts.agents) {
      const expected = renderAgent(definitions, runtime, agent.name, effectiveOptions);
      const path = targetPath(definitions, runtime, agent.name, homeDir);
      targets.push({ runtime, agent: agent.name, path, expected, ...classifyTarget(path, expected) });
    }
  }

  const replacementAuthorized = (target) =>
    target.status === "missing" ||
    target.status === "current" ||
    (target.status === "managed-stale" && options.replaceManaged) ||
    (target.status === "unmanaged" && options.replaceUnmanaged);
  const blockers =
    options.command === "install"
      ? targets.filter((target) => !replacementAuthorized(target))
      : [];
  if (blockers.length > 0) {
    for (const target of blockers) {
      const label = `${target.runtime}/${target.agent}`;
      const flag = target.status === "managed-stale" ? "--replace-managed" : "--replace-unmanaged";
      io.error(`REFUSE ${label} ${target.status}: ${target.path} (authorize with ${flag})`);
    }
    io.error("ABORT no files written because at least one target needs explicit replacement authority");
    return 1;
  }

  let failed = false;
  for (const target of targets) {
    const label = `${target.runtime}/${target.agent}`;
    if (options.command === "check") {
      io.log(`${target.status === "current" ? "OK" : "FAIL"} ${label} ${target.status}: ${target.path}`);
      failed ||= target.status !== "current";
      continue;
    }

    if (target.status === "current") {
      io.log(`KEEP ${label} current: ${target.path}`);
      continue;
    }
    if (options.dryRun) {
      io.log(`PLAN ${label} ${target.status}: ${target.path}`);
    } else {
      atomicWrite(target.path, target.expected);
      io.log(`WRITE ${label} ${target.status}: ${target.path}`);
    }
  }

  const codexProfile = definitions.runtimeProfiles.profiles.codex;
  if (selectedRuntimes(options.runtime).includes("codex")) {
    io.log(
      `NOTE Codex: dispatch these roles with model=${codexProfile.dispatchModel}; ` +
        "the installed TOML cannot enforce a per-agent tool allowlist.",
    );
  }
  return failed ? 1 : 0;
}

function realpathOrResolve(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    process.exitCode = runManager(options);
  } catch (error) {
    console.error(`lumbre subagent manager: ${error.message}`);
    process.exitCode = 2;
  }
}

if (
  process.argv[1] &&
  realpathOrResolve(fileURLToPath(import.meta.url)) === realpathOrResolve(process.argv[1])
) {
  main();
}
