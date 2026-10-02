#!/usr/bin/env node

// Comprueba que lo que la skill dice del MCP existe en `src/`: tools, ops de
// `mutate_tasks`/`organize`/`mutate_brl` y parámetros. Vive en `tests/` y no en
// `skills/lumbre/scripts/` porque la skill instalada no lleva `src/`.
//
// Qué falla (siempre con fichero:línea):
//   1. un identificador en snake_case citado en backticks (o suelto, en
//      `contracts.json`) que no es tool, op ni parámetro del MCP;
//   2. `tool({param: …})` con un parámetro que esa tool no tiene (o `op` con
//      un nombre de op que no existe en ella);
//   3. «`tool` por `param`» con un parámetro que esa tool no tiene;
//   4. «Acota … por a, b o c» con un `c` que no es parámetro de ninguna tool ni
//      uno de los conceptos humanos de FILTER_CONCEPTS;
//   5. «`op` con `campo`» / «`op` que lleve solo `campo`» con un campo ajeno a
//      esa op;
//   6. un listado «por `#tag`»: `list_tasks` no filtra por tag.
//
// Limitación declarada: solo ve identificadores con forma de tool u op
// (snake_case con guion bajo) y las frases de arriba. Una op de una sola
// palabra mal escrita (`reschedulee`) no se detecta por sí sola.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const toolsDir = join(repoRoot, "src", "tools");
const skillDir = join(repoRoot, "skills", "lumbre");

// Identificadores snake_case legítimos que NO son del MCP. Mantener corta.
const NOT_MCP_IDENTIFIERS = new Set([]);
// Conceptos humanos que la skill puede usar tras «Acota … por»: no son parámetros.
const FILTER_CONCEPTS = new Set(["fecha", "alcance", "proyecto", "área", "sección", "lista"]);

/** Índice del cierre que casa con el `{`/`(`/`[` de `open`, saltando strings y comentarios. */
function balancedEnd(src, open) {
  const pairs = { "{": "}", "(": ")", "[": "]" };
  const stack = [pairs[src[open]]];
  for (let i = open + 1; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      for (i += 1; i < src.length && src[i] !== ch; i += 1) if (src[i] === "\\") i += 1;
    } else if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i += 1;
    } else if (ch === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i + 2) + 1;
    } else if (pairs[ch]) {
      stack.push(pairs[ch]);
    } else if (ch === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return i;
    }
  }
  throw new Error(`unbalanced ${src[open]} at offset ${open}`);
}

/** Claves de primer nivel de un literal de objeto que empieza en `{` (índice `open`). */
function topLevelKeys(src, open) {
  const close = balancedEnd(src, open);
  const keys = [];
  let expectKey = true;
  for (let i = open + 1; i < close; i += 1) {
    const ch = src[i];
    if (ch === "/" && src[i + 1] === "/") {
      while (i < close && src[i] !== "\n") i += 1;
    } else if (ch === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i + 2) + 1;
    } else if (ch === "'" || ch === '"' || ch === "`" || "{([".includes(ch)) {
      i = ch === "{" || ch === "(" || ch === "[" ? balancedEnd(src, i) : skipString(src, i);
      expectKey = false;
    } else if (ch === ",") {
      expectKey = true;
    } else if (expectKey && /[A-Za-z_$]/.test(ch)) {
      const ident = /^[A-Za-z_$][\w$]*/.exec(src.slice(i))[0];
      keys.push(ident);
      i += ident.length - 1;
      expectKey = false;
    } else if (expectKey && ch === ".") {
      expectKey = false; // spread: no aporta claves conocidas
    }
  }
  return keys;
}

function skipString(src, i) {
  const quote = src[i];
  for (i += 1; i < src.length && src[i] !== quote; i += 1) if (src[i] === "\\") i += 1;
  return i;
}

function lineOf(text, offset) {
  return text.slice(0, offset).split("\n").length;
}

/** Tools, parámetros por tool y campos por op, extraídos de `src/tools/*.ts`. */
function extractSurface() {
  const tools = new Map(); // nombre -> Set de parámetros de entrada
  const ops = new Map(); // nombre de op -> Set de campos (unión entre tools)
  const opsByTool = new Map(); // tool de lote -> Set de ops
  const sources = new Map(
    readdirSync(toolsDir)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name) => [name, readFileSync(join(toolsDir, name), "utf8")]),
  );
  const allSource = [...sources.values()].join("\n");

  for (const source of sources.values()) {
    for (const match of source.matchAll(/registerTool\(\s*'([a-z_]+)'/g)) {
      const body = source.slice(match.index, balancedEnd(source, source.indexOf("(", match.index)));
      const schema = /inputSchema:\s*(\{|[A-Za-z_]\w*)/.exec(body);
      let params = [];
      if (schema?.[1] === "{") {
        params = topLevelKeys(body, schema.index + schema[0].length - 1);
      } else if (schema) {
        const declaration = new RegExp(`const ${schema[1]}\\s*=\\s*\\{`).exec(allSource);
        if (declaration) params = topLevelKeys(allSource, declaration.index + declaration[0].length - 1);
      }
      tools.set(match[1], new Set(params));
    }
  }

  const strictSchemas = [
    ["batch.ts", "mutateTasksStrictOpSchema", "mutate_tasks"],
    ["batch.ts", "organizeStrictOpSchema", "organize"],
    ["brl.ts", "mutateBrlOpSchema", "mutate_brl"],
  ];
  for (const [file, schemaName, tool] of strictSchemas) {
    const source = sources.get(file);
    const start = source.indexOf(`const ${schemaName}`);
    if (start === -1) throw new Error(`${file}: no encuentro ${schemaName}`);
    const open = source.indexOf("[", source.indexOf("discriminatedUnion", start));
    const region = source.slice(open, balancedEnd(source, open));
    const toolOps = new Set();
    for (const object of region.matchAll(/\.object\(\{/g)) {
      const braceAt = object.index + object[0].length - 1;
      const keys = topLevelKeys(region, braceAt);
      const literal = /op:\s*z\.literal\('([^']+)'\)/.exec(region.slice(braceAt, balancedEnd(region, braceAt)));
      if (!literal) continue;
      toolOps.add(literal[1]);
      const fields = ops.get(literal[1]) ?? new Set();
      for (const key of keys) fields.add(key);
      ops.set(literal[1], fields);
    }
    opsByTool.set(tool, toolOps);
  }
  return { tools, ops, opsByTool };
}

function documents() {
  const files = ["SKILL.md", ...readdirSync(join(skillDir, "references")).map((n) => `references/${n}`)];
  files.push("assets/subagents/contracts.json");
  return files.map((name) => ({ path: join(skillDir, name), text: readFileSync(join(skillDir, name), "utf8") }));
}

const SNAKE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;

function check(surface, { path, text }) {
  const failures = [];
  const where = (offset) => `${relative(repoRoot, path)}:${lineOf(text, offset)}`;
  const fail = (offset, message) => failures.push(`${where(offset)}: ${message}`);
  const isJson = path.endsWith(".json");
  const allParams = new Set([...surface.tools.values()].flatMap((set) => [...set]));
  const allFields = new Set([...surface.ops.values()].flatMap((set) => [...set]));
  const known = new Set([
    ...surface.tools.keys(),
    ...surface.ops.keys(),
    ...allParams,
    ...allFields,
    ...NOT_MCP_IDENTIFIERS,
  ]);
  const paramsOf = (tool) => new Set([...(surface.tools.get(tool) ?? []), ...(surface.ops.get(tool) ?? [])]);

  // 1. Identificadores con forma de tool u op que no existen.
  const candidates = isJson
    ? [...text.matchAll(/(?<![\w#@-])[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?![\w-])/g)].map((m) => [m[0], m.index])
    : [...text.matchAll(/`([^`\n]+)`/g)].map((m) => [m[1], m.index + 1]);
  for (const [name, offset] of candidates) {
    if (SNAKE.test(name) && !known.has(name)) {
      fail(offset, `«${name}» tiene forma de tool u op y no existe en src/tools`);
    }
  }

  // 2. `tool({param: …})`
  for (const match of text.matchAll(/`([a-z][a-z_]*)\(\{([^`]*)\}\)`/g)) {
    const [, tool, body] = match;
    if (!surface.tools.has(tool)) {
      fail(match.index, `«${tool}» no es una tool del MCP`);
      continue;
    }
    for (const part of body.split(",")) {
      const key = /^\s*"?([A-Za-z_]\w*)"?\s*(?::\s*(.*))?$/.exec(part);
      if (!key) continue;
      // `tool({op: "x"})` es la abreviatura que usa el propio MCP para una op de lote.
      const batchShorthand = key[1] === "op" && surface.opsByTool.has(tool);
      if (!surface.tools.get(tool).has(key[1]) && !batchShorthand) {
        fail(match.index, `«${tool}» no tiene el parámetro «${key[1]}»`);
      } else if (batchShorthand && key[2]) {
        const op = key[2].replace(/["'\s]/g, "");
        if (!surface.opsByTool.get(tool).has(op)) fail(match.index, `«${tool}» no tiene la op «${op}»`);
      }
    }
  }

  // 3. «`tool` por `param`»
  const byParam =
    /`([a-z][a-z_]*)`\s+por\s+((?:(?:ese|el)\s+)?`[^`\n]+`(?:\s*(?:,|y|o)\s*(?:(?:ese|el)\s+)?`[^`\n]+`)*)/g;
  for (const match of text.matchAll(byParam)) {
    const [, tool, list] = match;
    if (!surface.tools.has(tool)) continue;
    for (const param of [...list.matchAll(/`([^`\n]+)`/g)].map((m) => m[1])) {
      if (!surface.tools.get(tool).has(param)) {
        fail(match.index, `«${tool}» no tiene el parámetro «${param}»`);
      }
    }
  }

  // 4. «Acota … por a, b o c»
  for (const match of text.matchAll(/\bAcota\b[^.;\n"]*?\bpor\b([^.;\n"]*)/g)) {
    for (const item of match[1].split(/,|\by\b|\bo\b/)) {
      const word = /[\p{L}\w]+/u.exec(item.replace(/`/g, "").replace(/^\s*por\b/, ""))?.[0];
      if (word && !allParams.has(word) && !FILTER_CONCEPTS.has(word.toLowerCase())) {
        fail(match.index, `«${word}» no es un parámetro de ninguna tool del MCP`);
      }
    }
  }

  // 5. «`op` con `campo`» / «`op` que lleve solo `campo`»
  const opWith = /`([a-z][a-z_]*)`[^`.;\n]{0,25}?\b(?:con|que lleve solo|que lleve)\s+((?:`\w+`(?:\s*(?:,|y)\s*)?)+)/g;
  for (const match of text.matchAll(opWith)) {
    const [, name, list] = match;
    if (!surface.ops.has(name) && !surface.tools.has(name)) continue;
    const allowed = paramsOf(name);
    for (const field of [...list.matchAll(/`(\w+)`/g)].map((m) => m[1])) {
      if (!allowed.has(field) && !surface.tools.has(field) && !surface.ops.has(field)) {
        fail(match.index, `la op «${name}» no tiene el campo «${field}»`);
      }
    }
  }

  // 6. Un listado no filtra por tag.
  for (const match of text.matchAll(/\blist\w*[^.;\n]*\bpor\s+(?:ese\s+|el\s+)?`#tag`/gi)) {
    fail(match.index, "list_tasks no filtra por tag: lista el proyecto y filtra en el resultado");
  }

  // contracts.json: cada operación permitida es una tool real.
  if (isJson) {
    const contracts = JSON.parse(text);
    for (const agent of contracts.agents) {
      for (const operation of agent.allowedOperations) {
        if (!surface.tools.has(operation)) {
          fail(text.indexOf(`"${operation}"`), `${agent.name}: «${operation}» no es una tool del MCP`);
        }
      }
    }
  }
  return failures;
}

const surface = extractSurface();
if (surface.tools.size < 15) {
  console.error(`validate-tool-names: solo veo ${surface.tools.size} tools en src/tools (esperaba al menos 15); el extractor se ha roto`);
  process.exit(1);
}
const failures = documents().flatMap((doc) => check(surface, doc));
if (failures.length > 0) {
  console.error(`validate-tool-names: ${failures.length} fallo(s)`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(
  `lumbre skill tool names: ok (tools=${surface.tools.size}, ops=${surface.ops.size}, ficheros=${documents().length})`,
);
