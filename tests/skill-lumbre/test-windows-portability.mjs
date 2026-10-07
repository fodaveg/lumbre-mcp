#!/usr/bin/env node

// Portabilidad de la skill `lumbre` a Windows (PowerShell, Git for Windows con
// core.autocrlf=true). Cada caso dice, si cae, QUÉ defecto lo causa. Corre igual
// en macOS, Linux y Windows. Se ejecutan todos los casos y el exit code es 1 si
// cae alguno.
//
// Hermético: los casos 1 y 1b pasan el entorno por variables y apuntan a un
// temporal, así que nunca leen ni escriben el perfil real.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = resolve(dirname(fileURLToPath(import.meta.url)));
const repoRoot = resolve(testDir, "..", "..");
const managerScript = join(repoRoot, "skills", "lumbre", "scripts", "manage-subagents.mjs");

const temporaries = [];
function makeTemp(prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temporaries.push(dir);
  return dir;
}

// Entorno sin HOME ni USERPROFILE (en Windows las claves no distinguen
// mayúsculas, así que se borran por patrón) más lo que se pida.
function envWithout(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(home|userprofile)$/i.test(key)) delete env[key];
  }
  return { ...env, ...extra };
}

function run(script, args, options = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    ...options,
  });
}

function describeRun(result) {
  return `exit=${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

// Clon del HEAD COMMITEADO (no del árbol de trabajo) en un temporal.
function cloneHead(autocrlf) {
  const dir = makeTemp("lumbre-portability-clone-");
  const clone = spawnSync(
    "git",
    ["clone", "--quiet", "-c", `core.autocrlf=${autocrlf}`, repoRoot, dir],
    { encoding: "utf8" },
  );
  assert.equal(clone.status, 0, `git clone falló: ${clone.stderr}`);
  return dir;
}

const SKIP = Symbol("skip");
const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

test("1 defecto HOME: manage-subagents con solo USERPROFILE debe planear dentro de él", () => {
  const profile = makeTemp("lumbre-portability-profile-");
  const result = run(managerScript, ["install", "--runtime", "all", "--dry-run"], {
    env: envWithout({ USERPROFILE: profile }),
  });
  assert.equal(
    result.status,
    0,
    `manage-subagents exige HOME y no cae a USERPROFILE (PowerShell no define HOME); ${describeRun(result)}`,
  );
  const planLines = result.stdout.split(/\r?\n/).filter((line) => line.startsWith("PLAN "));
  assert.ok(planLines.length > 0, `sin líneas PLAN; ${describeRun(result)}`);
  const outside = planLines.filter((line) => !line.includes(profile));
  assert.deepEqual(outside, [], "líneas PLAN fuera del USERPROFILE temporal (toca el perfil real)");
});

test("1b sin HOME ni USERPROFILE sigue fallando pidiendo --home", () => {
  // En Windows el hijo de Node recupera USERPROFILE aunque el env no lo lleve
  // (medido), así que el caso correría contra el perfil real: no se lanza.
  if (process.platform === "win32") {
    console.log("skip 1b (win32): el hijo recupera USERPROFILE del sistema; no se puede quitar y correría contra el perfil real");
    return SKIP;
  }
  const result = run(managerScript, ["install", "--runtime", "all", "--dry-run"], {
    env: envWithout(),
  });
  assert.notEqual(result.status, 0, `debería abortar sin ningún home; ${describeRun(result)}`);
  assert.match(result.stderr + result.stdout, /--home/, "el mensaje no pide --home");
});

for (const script of ["quick-validate-skill.mjs", "validate-contracts.mjs"]) {
  test(`2 defecto URL.pathname: ${script} sin argumentos (sobre copia LF)`, () => {
    const clone = cloneHead("false");
    const result = run(join(clone, "skills", "lumbre", "scripts", script), [], { cwd: clone });
    assert.doesNotMatch(
      result.stderr,
      /ENOENT/,
      `new URL(..).pathname da /C:/... y resolve() lo duplica (C:\\C:\\...); ${describeRun(result)}`,
    );
    assert.equal(result.status, 0, `${script} sin argumentos debe salir 0; ${describeRun(result)}`);
  });
}

// Mide el HEAD commiteado del checkout donde corre, NO el árbol de trabajo:
// un .gitattributes sin commitear no cuenta.
test("3 defecto CRLF: un clon con core.autocrlf=true no debe tener \\r en SKILL.md ni validate.sh", () => {
  const clone = cloneHead("true");
  for (const relative of ["skills/lumbre/SKILL.md", "skills/lumbre/scripts/validate.sh"]) {
    const content = readFileSync(join(clone, ...relative.split("/")), "utf8");
    assert.ok(
      !content.includes("\r"),
      `${relative} sale con CRLF con core.autocrlf=true: falta .gitattributes con eol=lf`,
    );
  }
});

let failed = 0;
let skipped = 0;
for (const { name, fn } of cases) {
  try {
    if (fn() === SKIP) {
      skipped += 1;
      continue;
    }
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${String(error.message).replace(/\n/g, "\n     ")}`);
  }
}
for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
if (failed > 0) {
  console.log(`${failed} de ${cases.length} casos fallan`);
  process.exit(1);
}
console.log(
  `windows portability: ok (${cases.length - skipped} casos ok, ${skipped} saltados)`,
);
