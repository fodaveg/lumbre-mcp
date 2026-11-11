#!/usr/bin/env node

// Comprueba que el texto público de la skill describe el comportamiento actual
// y usa el vocabulario de la skill. Recorre todo lo que se instala (router,
// referencias, contratos de subagentes y metadata) y cada fallo nombra
// fichero:línea y motivo.
//
// Qué falla:
//   1. identidad privada («David»);
//   2. una fecha en un formato habitual: ISO (2026-10-28), con barras o guiones
//      (28/10/2026), o con el mes en letra (28 oct 2026, 5 de noviembre de 2026,
//      octubre de 2026);
//   3. un hash de commit: 7 a 40 hex con letras y cifras, aislado y detrás de una
//      palabra que lo sitúa como versión de código (commit, sha, web, rama…). Un
//      `accountId` de 64 hex no casa (no hay frontera dentro de la serie) ni un
//      UUID (sus grupos van pegados a «-»);
//   4. «madre»: la tarea con subtareas se llama «principal»;
//   5. afirmar que las subtareas «no admiten» deadline, recordatorios o
//      repetición: los admiten, solo les falta lista, sección y subtareas propias.
//
// Vive en `tests/` y no en `skills/lumbre/scripts/` porque la instalación tiene
// un tope de tamaño (PUBLIC_SKILL_IS_LIGHTWEIGHT en validate-evidence.mjs); la
// copia instalada conserva la comprobación mínima de validate-contracts.mjs.
//
// Limitación declarada: un hash solo de letras (`deadbeef`) no se caza, para no
// confundirlo con palabras.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const skillDir = join(repoRoot, "skills", "lumbre");

/** Todos los ficheros de texto que se instalan con la skill, salvo scripts. */
function publicFiles(dir = skillDir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "scripts" ? [] : publicFiles(path);
    return /\.(?:md|json|ya?ml)$/.test(entry.name) ? [path] : [];
  });
}

const MONTH = "(?:ene|feb|mar|abr|may|jun|jul|ago|sep|sept|oct|nov|dic|jan|apr|aug|dec)[a-z]*\\.?";
const YEAR = "(?:19|20)\\d{2}";
const DATE_PATTERNS = [
  new RegExp(`\\b${YEAR}[-/]\\d{1,2}[-/]\\d{1,2}\\b`, "g"),
  new RegExp(`\\b\\d{1,2}[-/]\\d{1,2}[-/]${YEAR}\\b`, "g"),
  new RegExp(`(?:\\b\\d{1,2}\\s+(?:de\\s+)?)?\\b${MONTH}\\s+(?:de\\s+)?${YEAR}\\b`, "gi"),
];
const COMMIT_HASH =
  /\b(?:commits?|sha|hash|web|candidat[oa]|merge|rama|head|versi[oó]n|release|build|desde)\b[^.\n]{0,40}?(?<![0-9a-f-])([0-9a-f]{7,40})(?![0-9a-f-])/gi;
const SUBTASK_FIELDS_DENIED = /\bsubtareas?\b[^.]{0,120}?\bno\s+(?:los\s+|las\s+|lo\s+|la\s+)?admite?n?\b/gi;
const SUBTASK_FIELDS = /deadline|recordatorio|repetici|recurren/i;

function lineOf(text, offset) {
  return text.slice(0, offset).split("\n").length;
}

function check(path) {
  const text = readFileSync(path, "utf8");
  const failures = [];
  const fail = (offset, reason) => failures.push(`${relative(repoRoot, path)}:${lineOf(text, offset)}: ${reason}`);

  for (const match of text.matchAll(/\bDavid\b/g)) {
    fail(match.index, "identidad privada en la skill pública");
  }
  for (const pattern of DATE_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      fail(match.index, `fecha «${match[0]}»: la skill pública describe el comportamiento actual, sin fechas`);
    }
  }
  for (const match of text.matchAll(COMMIT_HASH)) {
    const hash = match[1];
    if (/\d/.test(hash) && /[a-f]/i.test(hash)) {
      fail(match.index + match[0].lastIndexOf(hash), `hash de commit «${hash}»: la skill pública no cita versiones de código`);
    }
  }
  for (const match of text.matchAll(/\bmadres?\b/gi)) {
    fail(match.index, "«madre»: la tarea con subtareas se llama «principal»");
  }
  for (const match of text.matchAll(SUBTASK_FIELDS_DENIED)) {
    // «no admiten» solo es la afirmación falsa si habla de esos campos.
    const around = text.slice(Math.max(0, match.index - 120), match.index + match[0].length + 60);
    if (!SUBTASK_FIELDS.test(around)) continue;
    fail(
      match.index,
      `«${match[0].replace(/\s+/g, " ").slice(0, 80)}»: las subtareas admiten deadline, recordatorios y ` +
        "repetición (solo les falta lista, sección y subtareas propias)",
    );
  }
  return failures;
}

const files = publicFiles();
if (files.length < 10) {
  console.error(`validate-public-text: solo veo ${files.length} ficheros en skills/lumbre; el recorrido se ha roto`);
  process.exit(1);
}
const failures = files.flatMap(check);
if (failures.length > 0) {
  console.error(`validate-public-text: ${failures.length} fallo(s)`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(`lumbre skill public text: ok (ficheros=${files.length})`);
