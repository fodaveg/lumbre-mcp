#!/usr/bin/env node

import { readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const skillDir = resolve(process.argv[2] ?? new URL("..", import.meta.url).pathname);
const referencesDir = join(skillDir, "references");
const operationalReferences = [
  "attachments-and-connection.md",
  "backlog.md",
  "daily.md",
  "destinations.md",
  "development.md",
  "mcp-safe-operations.md",
  "project-release.md",
  "read.md",
  "subagents.md",
];

function read(relativePath) {
  return readFileSync(join(skillDir, relativePath), "utf8");
}

function invariant(name, condition, detail) {
  if (!condition) throw new Error(`${name}: ${detail}`);
}

function section(source, heading) {
  const marker = `## ${heading}\n`;
  const start = source.indexOf(marker);
  if (start === -1) return "";
  const body = source.slice(start + marker.length);
  const next = body.indexOf("\n## ");
  return next === -1 ? body : body.slice(0, next);
}

function linkedMarkdownFiles(source) {
  return [...source.matchAll(/\]\(([^)#]+\.md)(?:#[^)]+)?\)/g)].map(
    (match) => basename(match[1]),
  );
}

function hasAll(source, patterns) {
  return patterns.every((pattern) => pattern.test(source));
}

const entry = read("SKILL.md");
const normalizedEntry = entry.replace(/\s+/g, " ");
const readMode = read("references/read.md");
const daily = read("references/daily.md");
const backlog = read("references/backlog.md");
const development = read("references/development.md");
const release = read("references/project-release.md");
const safeOperations = read("references/mcp-safe-operations.md");
const normalizedSafeOperations = safeOperations.replace(/\s+/g, " ");
const attachments = read("references/attachments-and-connection.md");
const normalizedAttachments = attachments.replace(/\s+/g, " ");
const subagents = read("references/subagents.md");

const installedReferences = readdirSync(referencesDir, { withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
  .sort();
invariant(
  "PUBLIC_REFERENCES_EXACTLY_OPERATIONAL_NINE",
  JSON.stringify(installedReferences) === JSON.stringify(operationalReferences),
  `expected ${operationalReferences.join(", ")}; found ${installedReferences.join(", ")}`,
);

const routerLines = entry.split("\n").length;
invariant("ROUTER_BOUNDED", routerLines <= 120, `${routerLines} lines exceeds 120`);
for (const reference of operationalReferences) {
  invariant(
    "ROUTER_LINKS_EACH_OPERATIONAL_REFERENCE",
    entry.includes(`references/${reference}`),
    `missing route to ${reference}`,
  );
}

const modeRouter = section(entry, "Elegir modo base y extensiones");
const readRoute = modeRouter.match(/- \*\*Lectura\*\*:[\s\S]*?(?=\n- \*\*)/)?.[0] ?? "";
invariant(
  "READ_ROUTE_LOADS_ONLY_READ_REFERENCE",
  JSON.stringify(linkedMarkdownFiles(readRoute)) === JSON.stringify(["read.md"]),
  "the read route must link only read.md",
);
invariant(
  "READ_ROUTE_EXCLUDES_OTHER_REFERENCES",
  hasAll(readRoute, [/solo/i, /ninguna otra\s+referencia/i, /enumere proyectos y áreas/i]),
  "the router must make progressive disclosure explicit before references are loaded",
);
invariant(
  "READ_EMPTY_LIST_STAYS_READ_ONLY",
  hasAll(modeRouter, [/proyecto vac[ií]o/i, /enumera proyectos y áreas/i, /sin activar triaje/i]),
  "empty-list discovery must be routed as reading",
);

const sharedRules = section(entry, "Reglas compartidas");
const safeReferenceRule = sharedRules.match(/^4\.[\s\S]*?(?=^5\.)/m)?.[0] ?? "";
invariant(
  "SAFE_OPERATIONS_REFERENCE_ONLY_BEFORE_WRITE",
  hasAll(safeReferenceRule, [/Solo cuando vayas a escribir/i, /mcp-safe-operations\.md/]),
  "read-only requests must not preload the write contract",
);
invariant(
  "SUBAGENTS_AND_ATTACHMENTS_LOAD_ON_DEMAND",
  hasAll(normalizedEntry, [
    /references\/subagents\.md/,
    /references\/attachments-and-connection\.md/,
  ]) && !/manage-subagents\.mjs/.test(entry) && !/--replace-managed/.test(entry),
  "the router must only point to subagent and attachment references, not carry their bodies",
);
invariant(
  "SUBAGENT_MANAGER_INSTRUCTIONS_LIVE_IN_REFERENCE",
  hasAll(subagents, [
    /manage-subagents\.mjs/,
    /--dry-run/,
    /--replace-managed/,
    /--replace-unmanaged/,
    /--claude-tool-prefix/,
    /mcp__lumbre__/,
    /mcp__claude_ai_Lumbre__/,
    /mcp__claude_ai_lumbre__/,
  ]),
  "subagent installation rules and the three default Claude prefixes must be documented",
);
invariant(
  "MISSING_MCP_FAILS_HONESTLY",
  hasAll(entry, [/no expone las tools de Lumbre/i, /sin inventar/i, /flujo de autorizaci[oó]n/i]),
  "missing connection must be disclosed without fabricated data or API routes",
);

invariant(
  "READ_MODE_NON_MUTATING",
  hasAll(readMode, [/estrictamente no mutante/i, /No añadas estados/i, /no.*reorganices/i]),
  "reading must not write task state or structure",
);
invariant(
  "REFRESH_SYNC_IS_READ_FRESHNESS_OPERATION",
  hasAll(readMode, [
    /`refresh_sync`/,
    /fuerza el flush/i,
    /operaci[oó]n de lectura/i,
    /fuera de este MCP/i,
    /dispositivo[\s\S]*offline/i,
    /puede estar desfasada/i,
  ]),
  "refresh_sync must be allowed for external-change freshness with an offline caveat",
);

invariant(
  "BATCH_OPERATIONS_ARE_DISCOVERABLE",
  hasAll(normalizedSafeOperations, [
    /tools? de lote/i,
    /como `op`.*no como tool independiente/i,
  ]),
  "an operation nested in a batch tool must not be mistaken for a missing capability",
);
invariant(
  "BATCH_REPORTS_PARTIAL_RESULTS",
  hasAll(normalizedSafeOperations, [/orden de env[ií]o/i, /cada operaci[oó]n reporta/i, /aplicado a medias/i, /no asumas atomicidad/i]),
  "batch order and partial success must be distinguished",
);
invariant(
  "MOVE_TO_LIST_CLEARS_SECTION",
  hasAll(normalizedSafeOperations, [/Cambiar de proyecto o área limpia la secci[oó]n/i, /mueve primero/i, /reasigna despu[eé]s/i]),
  "the section reset and safe repair order must be explicit",
);
invariant(
  "WRITE_VERIFICATION_RETRIES_AFTER_REFRESH",
  hasAll(section(safeOperations, "Consistencia").replace(/\s+/g, " "), [
    /relee por id o filtro acotado/i,
    /`refresh_sync`/,
    /relee una segunda vez/i,
    /solo despu[eé]s declara la limitaci[oó]n/i,
  ]),
  "an asynchronous write must get one refresh and bounded reread before a limitation",
);
invariant(
  "ATTACHMENT_UPLOAD_IS_SYNCHRONOUS_AND_OTHER_WRITES_NEED_APPLIED",
  hasAll(section(attachments, "Adjuntos y topología").replace(/\s+/g, " "), [
    /`add_attachment` es s[ií]ncrona/i,
    /ya est[aá] enlazado/i,
    /Las dem[aá]s escrituras se dan por hechas solo si el informe de cada op dice «aplicada»/i,
  ]) && !/se encola/i.test(normalizedAttachments),
  "attachment linking must be distinguished from other writes, which count only when reported «aplicada»",
);
invariant(
  "WRITES_ARE_ACCEPTED_THEN_REPORTED_PER_OP",
  hasAll(section(safeOperations, "Consistencia").replace(/\s+/g, " "), [
    /aceptadas/i,
    /Aceptada no es aplicada/i,
    /solo «aplicada» cuenta como hecho/i,
  ]) && !/\bencoladas?\b/i.test(normalizedSafeOperations),
  "the write report must speak of accepted operations and never present them as queued",
);
invariant(
  "FULL_READ_NARROW_BEFORE_MUTATION",
  hasAll(section(safeOperations, "Identidad y lectura íntegra").replace(/\s+/g, " "), [
    /antes de reeditar su `content` o sus `notes`/i,
    /`reschedule`, `complete`, `cancel`[\s\S]*no la necesitan/i,
  ]),
  "full reads are required before re-editing content or notes, not before every mutation",
);

invariant(
  "OPEN_TRIAGE_STOPS_AT_PREVIEW",
  hasAll(backlog.replace(/\s+/g, " "), [/muestra primero una vista previa/i, /espera confirmaci[oó]n/i, /no incluye.*escritura/i]),
  "open taxonomy changes require a non-mutating preview",
);
invariant(
  "DEVELOPMENT_EXTENSION_IS_OPT_IN",
  hasAll(normalizedEntry, [/Desarrollo/i, /apagado por defecto/i, /petici[oó]n expl[ií]cita/i]),
  "development states must not activate for incidental reads",
);
invariant(
  "DEVELOPMENT_STATE_MACHINE_PRESENT",
  hasAll(development, [/@acked/, /@wip/, /@done/, /@not-done/]),
  "all development states must retain their documented handling",
);
invariant(
  "WIP_IS_A_TRANSIT_STATE",
  hasAll(section(development, "Estado de agente").replace(/\s+/g, " "), [
    /`@wip` es un estado de tr[aá]nsito/i,
    /Ninguna tarea termina un lote, una entrega o un turno en `@wip`/i,
  ]),
  "@wip must stay a transit state that no batch, handoff or turn can end on",
);
const developmentClose = section(development, "Cierre: ninguna tarea se queda en `@wip`")
  .replace(/\s+/g, " ");
invariant(
  "CLOSING_LEAVES_NO_UNEXPLAINED_WIP",
  developmentClose !== "" &&
    hasAll(developmentClose, [
      /toda tarea en `@wip` sale de `@wip`/i,
      /no hay una tercera/i,
      /`@done`/,
      /`@acked`/,
      /escribe el motivo/i,
      /nota de la tarea/i,
      /barrido/i,
      /resultados «aplicada» de este encargo/i,
      /Relee solo la tarea cuyo estado no consta/i,
    ]),
  "closing a batch must force every @wip task to @done or back to @acked with a written reason, verified by a sweep against this task's reads and applied results",
);
invariant(
  "RELEASE_AUTHORITY_DOES_NOT_EXPAND_MUTATION",
  hasAll(release.replace(/\s+/g, " "), [/no autoriza por s[ií] misma ninguna mutaci[oó]n adicional/i, /autoridad requerida/i, /mismo candidato/i]),
  "release workflow must preserve authority and candidate identity",
);
invariant(
  "DAILY_MODE_PRESENT",
  hasAll(daily.replace(/\s+/g, " "), [/propiedades nativas/i, /checklist/i, /cancel/i]),
  "ordinary task management must retain native task semantics",
);

// Exact wording is intentional for this safety-critical prohibition.
invariant(
  "TOKEN_NEVER_APPEARS_IN_URL_OR_LUMBRE_DATA",
  normalizedAttachments.includes(
    "Nunca pongas un token en una URL ni lo copies a tareas, notas, logs o documentación.",
  ),
  "the exact token-handling prohibition changed",
);

const publicText = [
  entry,
  readMode,
  daily,
  backlog,
  development,
  release,
  safeOperations,
  attachments,
  subagents,
  read("references/destinations.md"),
].join("\n");
invariant(
  "PUBLIC_SKILL_HAS_NO_USER_PATHS",
  !/(?:\/Users\/|\/home\/[A-Za-z0-9_.-]+\/)/.test(publicText),
  "hard-coded user path found",
);
invariant(
  "PUBLIC_SKILL_HAS_NO_PRIVATE_IDENTITY_OR_DATED_STATE",
  !/(?:\bDavid\b|\b20\d{2}-\d{2}-\d{2}\b)/.test(publicText),
  "private identity or ephemeral date found",
);

console.log(
  `lumbre skill contracts: ok (router=${routerLines} lines, references=${installedReferences.length})`,
);
