import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
/**
 * Preparación LOCAL (sin red) de un adjunto para `add_attachment` (`index.ts`)
 * antes de subirlo con `uploadAttachment` (`lumbre-client.ts`): resolver la
 * ruta, validar el fichero y decidir su mime. Separado en su propio módulo
 * (patrón `notes.ts`/`refs.ts`: lógica + test al lado) porque no depende de
 * `LumbreConfig` ni de red — se testea sin mockear `fetch`.
 */
/** Tope por adjunto — 25 MiB, el mismo límite AUTORITATIVO del servidor
 *  (`POST /api/attachments`, ver `handleCredentialUpload` en el repo
 *  principal). Se valida TAMBIÉN aquí, en el cliente, para dar un error
 *  legible sin gastar la subida — el servidor lo comprueba igual, esto es
 *  una capa extra, no la única. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** Extensión (sin el punto, minúsculas) → mime. Lo que no está aquí sale como
 *  `application/octet-stream` — ver `mimeForFilename`. */
const EXTENSION_MIME = {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    md: 'text/markdown',
    csv: 'text/csv',
    txt: 'text/plain',
    json: 'application/json',
    zip: 'application/zip',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    mp3: 'audio/mpeg',
    mp4: 'video/mp4',
    m4a: 'audio/mp4'
};
/** Mime a partir del NOMBRE de fichero (extensión, case-insensitive):
 *  `application/octet-stream` si la extensión no está en el mapa. YA NO
 *  degrada nada (hasta 2026-08-26 sí lo hacía, ver el JSDoc de
 *  `uploadAttachment` en `lumbre-client.ts` para el motivo del cambio y la
 *  landmine de SvelteKit que esto sorteaba): el `Content-Type` que sale por
 *  el cable es SIEMPRE `application/octet-stream` (fijo, decidido en
 *  `uploadAttachment`), y este mime real viaja aparte, en la cabecera
 *  `x-lumbre-content-type` — así que un `.txt` vuelve a devolver
 *  `text/plain` tal cual, sin ninguna excepción. */
export function mimeForFilename(filename) {
    const ext = path.extname(filename).slice(1).toLowerCase();
    return EXTENSION_MIME[ext] ?? 'application/octet-stream';
}
/**
 * Expande `~`/`~/…` a `os.homedir()` (mismo criterio en Mac/Linux/Windows) y
 * EXIGE que el resultado sea una ruta absoluta: una relativa se resolvería
 * contra el cwd del PROCESO MCP (no el de la sesión que lo invoca), así que
 * es impredecible desde donde se llama — se rechaza en vez de adivinar.
 */
export function resolveLocalPath(filePath) {
    const expanded = filePath === '~' || filePath.startsWith('~/') ? path.join(homedir(), filePath.slice(1)) : filePath;
    if (!path.isAbsolute(expanded)) {
        throw new Error(`file_path debe ser una ruta absoluta o empezar por "~/" — "${filePath}" es relativa y se ` +
            'resolvería contra el cwd del proceso MCP, no el de tu sesión.');
    }
    return expanded;
}
/** MB legibles con un decimal, para el mensaje de tope superado. */
function readableMB(bytes) {
    return (bytes / (1024 * 1024)).toFixed(1);
}
/**
 * Valida y lee un fichero local para adjuntarlo a una tarea: la ruta es
 * absoluta o `~/…` (`resolveLocalPath`), el fichero existe, es un fichero
 * REGULAR (no un directorio), no está vacío, y no pasa de
 * `MAX_ATTACHMENT_BYTES` — con el tamaño REAL en el mensaje, nunca un error
 * genérico. `filename` (opcional) es el nombre con el que se guarda; por
 * defecto el basename de `filePath`. El mime se decide sobre ESE nombre
 * final (`mimeForFilename`), no sobre `filePath`.
 */
export async function readLocalAttachment(filePath, filename) {
    const resolved = resolveLocalPath(filePath);
    let stat;
    try {
        stat = await fs.stat(resolved);
    }
    catch {
        throw new Error(`No existe el fichero "${resolved}".`);
    }
    if (stat.isDirectory()) {
        throw new Error(`"${resolved}" es un directorio, no un fichero.`);
    }
    if (!stat.isFile()) {
        throw new Error(`"${resolved}" no es un fichero regular.`);
    }
    if (stat.size === 0) {
        throw new Error(`"${resolved}" está vacío (0 bytes).`);
    }
    if (stat.size > MAX_ATTACHMENT_BYTES) {
        throw new Error(`El fichero pesa ${readableMB(stat.size)} MB y el tope es ${readableMB(MAX_ATTACHMENT_BYTES)} MB.`);
    }
    const bytes = await fs.readFile(resolved);
    const name = filename?.trim() || path.basename(resolved);
    return { bytes, filename: name, mime: mimeForFilename(name) };
}
/**
 * Tope de `add_attachment({ content_base64 })` — MUCHO más bajo que
 * `MAX_ATTACHMENT_BYTES` (25 MiB) a propósito: ese argumento lo emite el
 * MODELO dentro de la tool call, no un `fetch` del servidor MCP, y base64
 * infla ~33% (medido con la captura real que motivó esta feature: 482.979
 * bytes de PNG → ~644 KB en base64, ~160k tokens — inviable). 1 MiB
 * decodificado (~1,33 MiB en base64) sigue siendo caro pero cabe en una
 * respuesta de herramienta razonable; por encima de eso, la vía es el
 * conector STDIO local (ver `README.md`, "Transporte HTTP remoto" y
 * `add_attachment` en `index.ts`), que sube por `file_path` sin pasar por el
 * contexto del modelo.
 */
export const MAX_BASE64_ATTACHMENT_BYTES = 1 * 1024 * 1024;
/** Base64 "de verdad": alfabeto estándar + padding opcional, longitud múltiplo
 *  de 4 tras quitar espacios/saltos de línea (el modelo puede envolver el
 *  argumento con saltos de línea; `Buffer.from(str, 'base64')` los ignora al
 *  decodificar, así que también se ignoran aquí para no rechazar un base64
 *  válido solo por su formato). */
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
function isValidBase64(compact) {
    return compact.length > 0 && compact.length % 4 === 0 && BASE64_PATTERN.test(compact);
}
/**
 * Decodifica y valida `content_base64` para `add_attachment` (la vía SIN
 * disco, ver `readLocalAttachment` para la vía CON disco): rechaza un base64
 * mal formado o que decodifique a 0 bytes, y aplica
 * `MAX_BASE64_ATTACHMENT_BYTES` con el tamaño REAL decodificado en el
 * mensaje — mismo criterio de mensajes que `readLocalAttachment`. `filename`
 * es SIEMPRE obligatorio aquí (a diferencia de `readLocalAttachment`): no hay
 * ninguna ruta de la que sacar un basename, así que lo exige el llamante
 * (`index.ts`) antes de llegar aquí; esta función solo valida que no venga en
 * blanco. El mime se decide igual que en la vía con disco (`mimeForFilename`
 * sobre el nombre final).
 */
export function decodeBase64Attachment(base64, filename) {
    const name = filename.trim();
    if (!name) {
        throw new Error('filename no puede estar vacío.');
    }
    const compact = base64.replace(/\s+/g, '');
    if (!isValidBase64(compact)) {
        throw new Error('content_base64 no es base64 válido (revisa que no falte relleno ni haya caracteres ajenos al alfabeto).');
    }
    const bytes = Buffer.from(compact, 'base64');
    if (bytes.length === 0) {
        throw new Error('content_base64 decodifica a 0 bytes — ¿el fichero de origen estaba vacío?');
    }
    if (bytes.length > MAX_BASE64_ATTACHMENT_BYTES) {
        throw new Error(`El fichero pesa ${readableMB(bytes.length)} MB decodificado y el tope de content_base64 es ` +
            `${readableMB(MAX_BASE64_ATTACHMENT_BYTES)} MB (ese argumento lo emites TÚ como modelo; algo más ` +
            'grande necesita el conector local por file_path, ver README "Transporte HTTP remoto").');
    }
    return { bytes, filename: name, mime: mimeForFilename(name) };
}
//# sourceMappingURL=attachments.js.map