import { promises as fs, type Stats } from 'node:fs';
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
const EXTENSION_MIME: Record<string, string> = {
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

/**
 * Mimes que SvelteKit reconoce como "form content type" (`is_form_content_type`,
 * `@sveltejs/kit` 2.66.0, `src/utils/http.js:93`, llamada desde
 * `src/runtime/server/respond.js:83`; el cuarto sale de
 * `src/runtime/form-utils.js:69`) e intenta parsear como formulario ANTES de
 * llegar a nuestro handler: una petición SIN cabecera `Origin` (como la de
 * este MCP, que corre fuera del navegador) con uno de estos cuatro
 * Content-Type se rechaza con 403 sin ejecutar ni una línea de
 * `handleCredentialUpload`, y el mensaje no dice nada útil. `mimeForFilename`
 * DEGRADA los cuatro a `application/octet-stream` antes de mandar — en la
 * práctica el único que se cruza aquí es `text/plain` (un `.txt`/`.log`):
 * `text/markdown`/`text/csv` no están en la lista y viajan con su mime real.
 */
const SVELTEKIT_FORM_CONTENT_TYPES = new Set([
	'application/x-www-form-urlencoded',
	'multipart/form-data',
	'text/plain',
	'application/x-sveltekit-formdata'
]);

/** Mime a partir del NOMBRE de fichero (extensión, case-insensitive):
 *  `application/octet-stream` si la extensión no está en el mapa, o si el
 *  mime que le tocaría es uno de los cuatro que SvelteKit intercepta como
 *  formulario (ver `SVELTEKIT_FORM_CONTENT_TYPES`) — degradarlo es la única
 *  forma de que la subida llegue al handler en vez de un 403 mudo. */
export function mimeForFilename(filename: string): string {
	const ext = path.extname(filename).slice(1).toLowerCase();
	const mime = EXTENSION_MIME[ext] ?? 'application/octet-stream';
	return SVELTEKIT_FORM_CONTENT_TYPES.has(mime) ? 'application/octet-stream' : mime;
}

/**
 * Expande `~`/`~/…` a `os.homedir()` (mismo criterio en Mac/Linux/Windows) y
 * EXIGE que el resultado sea una ruta absoluta: una relativa se resolvería
 * contra el cwd del PROCESO MCP (no el de la sesión que lo invoca), así que
 * es impredecible desde donde se llama — se rechaza en vez de adivinar.
 */
export function resolveLocalPath(filePath: string): string {
	const expanded =
		filePath === '~' || filePath.startsWith('~/') ? path.join(homedir(), filePath.slice(1)) : filePath;
	if (!path.isAbsolute(expanded)) {
		throw new Error(
			`file_path debe ser una ruta absoluta o empezar por "~/" — "${filePath}" es relativa y se ` +
				'resolvería contra el cwd del proceso MCP, no el de tu sesión.'
		);
	}
	return expanded;
}

/** MB legibles con un decimal, para el mensaje de tope superado. */
function readableMB(bytes: number): string {
	return (bytes / (1024 * 1024)).toFixed(1);
}

/** Fichero local ya validado y leído, listo para `uploadAttachment`. */
export interface LocalAttachmentFile {
	bytes: Buffer;
	filename: string;
	mime: string;
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
export async function readLocalAttachment(filePath: string, filename?: string): Promise<LocalAttachmentFile> {
	const resolved = resolveLocalPath(filePath);
	let stat: Stats;
	try {
		stat = await fs.stat(resolved);
	} catch {
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
		throw new Error(
			`El fichero pesa ${readableMB(stat.size)} MB y el tope es ${readableMB(MAX_ATTACHMENT_BYTES)} MB.`
		);
	}
	const bytes = await fs.readFile(resolved);
	const name = filename?.trim() || path.basename(resolved);
	return { bytes, filename: name, mime: mimeForFilename(name) };
}
