import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export const SELECTED_IDS = Array.from({ length: 12 }, (_, index) =>
  `P${String(index + 1).padStart(2, "0")}`,
);

export const OPERATIONAL_FILES = [
  "SKILL.md",
  "references/read.md",
  "references/daily.md",
  "references/backlog.md",
  "references/development.md",
  "references/project-release.md",
  "references/mcp-safe-operations.md",
];

export const ALLOWED_OPERATIONS = [
  "list_tasks_today",
  "get_task_full",
  "list_lists",
  "list_tasks",
  "read_snapshot",
  "refresh_sync",
  "ask_clarification",
  "create_task",
  "cancel_task",
  "update_task_tags",
  "delegate_tests",
  "verify_task",
  "propose_triage",
  "move_task_list",
  "update_task_section",
  "verify_preserved_fields",
  "read_repo_workflow",
  "prepare_candidate",
  "implement_candidate",
  "gate_candidate",
  "review_candidate",
  "handoff_release",
];

export const CRITERIA_FILES = [
  "tests/skill-lumbre/evidence/forward-prompts.md",
  "tests/skill-lumbre/evidence/forward-expectations.md",
  "tests/skill-lumbre/evidence/forward-pilot-schema.json",
  "tests/skill-lumbre/forward-pilot-lib.mjs",
  "skills/lumbre/scripts/quick-validate-skill.mjs",
  "skills/lumbre/scripts/validate-contracts.mjs",
  "skills/lumbre/scripts/validate.sh",
  "tests/skill-lumbre/run-forward-pilot.mjs",
  "tests/skill-lumbre/test-subagent-manager.mjs",
  "tests/skill-lumbre/test-forward-pilot-verifier.mjs",
  "tests/skill-lumbre/validate-evidence.mjs",
  "tests/skill-lumbre/validate.sh",
  "tests/skill-lumbre/verify-forward-pilot.mjs",
];

export function currentCriteriaHashes(repoRoot) {
  return Object.fromEntries(
    CRITERIA_FILES.map((path) => [path, sha256(readFileSync(join(repoRoot, path)))]),
  );
}

export function assertCriteriaFreeze(repoRoot, freeze, candidateSha) {
  if (
    freeze?.protocolVersion !== 1 ||
    freeze?.status !== "frozen-before-egress" ||
    !/^[0-9a-f]{40}$/.test(freeze?.baseSha ?? "") ||
    JSON.stringify(freeze.criteriaFiles) !==
      JSON.stringify(currentCriteriaHashes(repoRoot))
  ) {
    throw new Error("pilot criteria differ from pre-egress preregistration");
  }
  if (!/^[0-9a-f]{40}$/.test(candidateSha ?? "")) {
    throw new Error("pilot candidate SHA is missing");
  }
  const baseExists = spawnSync(
    "git",
    ["cat-file", "-e", `${freeze.baseSha}^{commit}`],
    { cwd: repoRoot },
  );
  if (baseExists.status !== 0) {
    throw new Error("pilot preregistration base commit does not exist");
  }
  const candidateExists = spawnSync(
    "git",
    ["cat-file", "-e", `${candidateSha}^{commit}`],
    { cwd: repoRoot },
  );
  if (candidateExists.status !== 0) {
    throw new Error("pilot candidate commit does not exist");
  }
  const parent = spawnSync("git", ["rev-parse", `${candidateSha}^`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (parent.status !== 0 || parent.stdout.trim() !== freeze.baseSha) {
    throw new Error("pilot preregistration base is not the candidate parent");
  }
}

const fixtures = {
  P01: "Snapshot actual con tres tareas fechadas hoy y dos fuera de fecha.",
  P02: "task-p02 está en @wip; el listado trae preview y la lectura íntegra contiene el feedback completo.",
  P03: "list_lists contiene X; list_tasks para su id devuelve una colección vacía.",
  P04: "Hay un snapshot legible; el cambio pudo hacerse en la app y ya llegó al servidor. refresh_sync solo fuerza su flush y no escribe datos nuevos.",
  P05: "Borrador: content='Planificar semana', listId='list-personal'. El conector acepta recurrence='weekly:monday' sin fecha ni hora.",
  P06: "La única tarea contextual es task-p06, pendiente y ajena a desarrollo.",
  P07: "La tarea de desarrollo contextual es task-p07, pendiente, sin estado de agente y con id resuelto.",
  P08: "task-p08 está en @acked. La superficie tests pertenece a agente-tests y el checkbox está sin marcar.",
  P09: "task-a y task-b describen autorización; task-c y task-d describen documentación. Conservan secciones conceptuales distintas.",
  P10: "task-e, task-f, list-x y section-y están resueltos. El contrato indica que mover de lista limpia sectionId.",
  P11: "task-p11 está en @acked. El workflow exige worktree y gate/revisión sobre un SHA; la sesión implementa pero no es release owner. Los pasos simulados resultan satisfactorios.",
  P12: "No hay objetivo operativo, tarea ni autorización adicional.",
};

export function buildEvaluationEnvironment({
  promptSource,
  model,
  captureContext,
  outputSchemaSha256,
  criteriaFreeze,
}) {
  const prompts = new Map();
  for (const line of promptSource.split("\n")) {
    const match = line.match(/^\| (P\d{2}) \| «(.+)» \|$/);
    if (match) prompts.set(match[1], match[2]);
  }
  for (const id of SELECTED_IDS) {
    if (!prompts.has(id)) throw new Error(`blind prompt missing: ${id}`);
  }
  return {
    cases: SELECTED_IDS.map((id) => ({
      id,
      request: prompts.get(id),
      fixture: fixtures[id],
    })),
    allowedOperations: ALLOWED_OPERATIONS,
    model,
    captureContext,
    outputSchemaSha256,
    criteriaFreeze,
    sandbox: "read-only",
    userConfig: "ignored",
    execPolicyRules: "ignored",
    hostSkillDiscovery: "skipped",
    skillSearch: "disabled",
    mcpConfiguration: "absent",
  };
}

export function buildEvaluationEnvelope({ environment, bundleContents }) {
  const bundleText = Object.keys(bundleContents)
    .sort()
    .map(
      (path) =>
        `\n--- BEGIN ${path} ---\n${bundleContents[path]}\n--- END ${path} ---`,
    )
    .join("\n");
  return `
Evalua la skill incluida abajo en un dry-run aislado. No uses tools, shell, MCP, web,
ficheros ni acciones externas: todo el material permitido ya está en este mensaje.
No existe oraculo ni evidencia previa en el entorno.

Devuelve solo el JSON del esquema. Usa los ids exactos de fixtures como targets. En
operationSequence usa exclusivamente estos nombres globales cuando correspondan:
${JSON.stringify(environment.allowedOperations)}.

firstUsefulAction debe ser exactamente la primera operación de operationSequence.
Respeta el orden exigido por la skill: primero obtén los datos necesarios, después
propón o muta y verifica siempre después de la escritura.
Antes de mutar una tarea existente o delegar sobre ella incluye get_task_full. Si una
petición abierta exige vista previa y confirmación, operationSequence se detiene en
propose_triage y no incluye todavía escrituras.
Una lectura no carga desarrollo solo porque la tarea tenga estado de agente. Verifica
@wip antes de delegar. Si el workflow exige un SHA y la implementación está autorizada,
el commit candidato se registra en externalActions, sin inferir merge, push o deploy.
Una lectura ordinaria tampoco carga mcp-safe-operations; preguntar si una lista vacía
existe no carga backlog. Cuando la frescura depende de un cambio externo ya recibido,
refresh_sync precede a la relectura y sigue siendo lectura. Puede haber verificaciones
intermedias, pero la última
verify_preserved_fields de un movimiento ocurre después de reasignar la sección.

references enumera los ficheros del bundle que realmente aplicaste a cada decisión,
con su basename. proposedMutations registra solo escrituras de Lumbre que propondrías
para satisfacer la petición. externalActions registra acciones externas que esta
operación de Lumbre ejecutaría ahora; pasos de repo meramente planificados se expresan
en operationSequence. checkpoint usa strings vacíos cuando no aplica.
Cuando aplique checkpoint usa exclusivamente los tokens estructurados del esquema:
ownership identifica ownership positivo y nextAction la acción pendiente, sin prosa ni
negaciones. releaseAuthority indica si esta sesión posee autoridad de release;
releaseHandoffRequired indica si debe entregar el candidato a otra persona.
El checkpoint registra inicio o delegación: asumir trabajo y quedar en @acked no basta
para crear uno. prepare_candidate incluye declarar ownership y preparar rama/worktree;
por eso precede a implement_candidate.

Entorno, casos, schema y metadata capturados antes de la invocacion:
${JSON.stringify(environment, null, 2)}

Bundle operativo cerrado:
${bundleText}
`;
}

export function parseJsonl(raw) {
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`invalid JSONL event at line ${index + 1}: ${error.message}`);
      }
    });
}

export function auditEvents(events) {
  const itemTypes = {};
  const deniedItems = [];
  const runtimeErrors = [];
  let shellCalls = 0;
  let mcpCalls = 0;
  let filesystemMutations = 0;
  let externalActions = 0;

  for (const event of events) {
    if (!event.item || typeof event.item.type !== "string") continue;
    const type = event.item.type;
    itemTypes[type] = (itemTypes[type] ?? 0) + 1;
    if (type === "agent_message" || type === "reasoning") continue;
    if (type === "error") {
      runtimeErrors.push(event.item.message ?? "");
      continue;
    }

    const serialized = JSON.stringify(event.item).toLowerCase();
    deniedItems.push({ id: event.item.id ?? "", type });
    if (type.includes("command") || type.includes("shell")) shellCalls += 1;
    if (type.includes("mcp") || serialized.includes("mcp_tool")) mcpCalls += 1;
    if (type.includes("file_change") || type.includes("patch")) {
      filesystemMutations += 1;
    }
    if (
      /(web_search|browser|computer|network|http|image_generation)/.test(type)
    ) {
      externalActions += 1;
    }
  }

  return {
    eventCount: events.length,
    itemTypes,
    toolCalls: deniedItems.length,
    shellCalls,
    mcpCalls,
    filesystemMutations,
    externalActions,
    runtimeErrors,
    deniedItems,
  };
}

export function extractModelCapture(events) {
  const messages = events.filter(
    (event) =>
      event.type === "item.completed" && event.item?.type === "agent_message",
  );
  const completions = events.filter((event) => event.type === "turn.completed");
  if (messages.length !== 1) {
    throw new Error(`expected exactly one agent_message, got ${messages.length}`);
  }
  if (completions.length !== 1) {
    throw new Error(`expected exactly one turn.completed, got ${completions.length}`);
  }

  let response;
  try {
    response = JSON.parse(messages[0].item.text);
  } catch (error) {
    throw new Error(`agent_message is not JSON: ${error.message}`);
  }
  const usage = completions[0].usage;
  const usageFields = [
    "input_tokens",
    "cached_input_tokens",
    "cache_write_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
  ];
  if (
    !usage ||
    usageFields.some((field) => !Number.isInteger(usage[field]) || usage[field] < 0)
  ) {
    throw new Error("turn.completed usage is missing or invalid");
  }

  return { response, responseText: messages[0].item.text, usage };
}

export function metricsFromUsage(usage, elapsedMs = null, caseCount = 12) {
  return {
    elapsedMs,
    meanElapsedMsPerCase:
      elapsedMs === null ? null : Math.round(elapsedMs / caseCount),
    latencyNote:
      elapsedMs === null
        ? "Exact wall time is unavailable; no timing is inferred."
        : "Batch wall time observed by the capture harness; per-case mean is derived.",
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.cached_input_tokens,
    cacheWriteInputTokens: usage.cache_write_input_tokens,
    outputTokens: usage.output_tokens,
    reasoningOutputTokens: usage.reasoning_output_tokens,
  };
}

const privatePathPatterns = [
  /\/Users\/[^\s"']+/g,
  /\/home\/[^\s"']+/g,
  /\/private\/tmp\/[^\s"']+/g,
  /\/var\/folders\/[^\s"']+/g,
  /file:\/\/[^\s"']+/g,
];

export function findPrivatePaths(value) {
  const found = [];
  for (const pattern of privatePathPatterns) {
    for (const match of value.matchAll(pattern)) found.push(match[0]);
  }
  return [...new Set(found)].sort();
}

export function buildCaptureEvidence({
  codexVersion,
  model,
  candidateParentSha,
  runner,
  selection,
  hashes,
  environment,
  isolationAudit,
  eventLog,
  envelope,
  elapsedMs,
}) {
  const context = environment.captureContext;
  if (
    !context ||
    context.codexVersion !== codexVersion ||
    context.model !== model ||
    context.candidateParentSha !== candidateParentSha ||
    environment.model !== model ||
    environment.outputSchemaSha256 !== hashes.outputSchemaSha256 ||
    environment.criteriaFreeze?.preregistrationSha256 !==
      hashes.preregistrationSha256
  ) {
    throw new Error("top-level capture metadata differs from canonical environment");
  }
  const privatePaths = findPrivatePaths(`${eventLog}\n${envelope}`);
  if (privatePaths.length > 0) {
    throw new Error(
      `capture artifacts contain private paths: ${JSON.stringify(privatePaths)}`,
    );
  }
  const events = parseJsonl(eventLog);
  const { response, usage } = extractModelCapture(events);
  const eventLogSha256 = sha256(eventLog);
  return {
    protocolVersion: 2,
    deterministic: false,
    captureStatus: "accepted",
    reproducibilityClaim:
      "The protocol and checks are reproducible; model wording, latency and token counts are not deterministic.",
    runner,
    codexVersion,
    model,
    candidateParentSha,
    selection,
    captureHarness: {
      runnerSourceSha256: hashes.runnerSourceSha256,
      librarySourceSha256: hashes.librarySourceSha256,
    },
    hashes: {
      ...hashes,
      evaluationEnvironmentSha256: sha256(JSON.stringify(environment)),
      evaluationEnvelopeSha256: sha256(envelope),
      captureRawEventLogSha256: eventLogSha256,
      publishedEventLogSha256: eventLogSha256,
    },
    environment,
    isolationAudit,
    privacyAudit: {
      privatePathsFound: [],
      normalizationApplied: false,
      rawEqualsPublished: true,
    },
    eventAudit: auditEvents(events),
    metrics: metricsFromUsage(usage, elapsedMs, selection.length),
    cases: response.cases,
  };
}

function matchesType(value, type) {
  if (type === "array") return Array.isArray(value);
  if (type === "null") return value === null;
  if (type === "integer") return Number.isInteger(value);
  return typeof value === type;
}

export function validateAgainstSchema(value, schema, path = "$") {
  const failures = [];
  const types = schema.type
    ? Array.isArray(schema.type)
      ? schema.type
      : [schema.type]
    : [];

  if (types.length > 0 && !types.some((type) => matchesType(value, type))) {
    return [`${path}: expected ${types.join(" or ")}`];
  }
  if (schema.enum && !schema.enum.some((item) => Object.is(item, value))) {
    failures.push(`${path}: value is outside enum`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      failures.push(`${path}: fewer than ${schema.minItems} items`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      failures.push(`${path}: more than ${schema.maxItems} items`);
    }
    if (schema.uniqueItems && new Set(value.map(JSON.stringify)).size !== value.length) {
      failures.push(`${path}: duplicate items`);
    }
    if (schema.items) {
      value.forEach((item, index) => {
        failures.push(
          ...validateAgainstSchema(item, schema.items, `${path}[${index}]`),
        );
      });
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const properties = schema.properties ?? {};
    for (const required of schema.required ?? []) {
      if (!(required in value)) failures.push(`${path}.${required}: required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) failures.push(`${path}.${key}: unexpected`);
      }
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (key in value) {
        failures.push(
          ...validateAgainstSchema(value[key], childSchema, `${path}.${key}`),
        );
      }
    }
  }
  return failures;
}
