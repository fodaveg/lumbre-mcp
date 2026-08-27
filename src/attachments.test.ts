import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	decodeBase64Attachment,
	MAX_ATTACHMENT_BYTES,
	MAX_BASE64_ATTACHMENT_BYTES,
	mimeForFilename,
	readLocalAttachment,
	resolveLocalPath
} from './attachments.js';

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'lumbre-mcp-attachments-test-'));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe('mimeForFilename', () => {
	it('mapea extensiones conocidas por su nombre, case-insensitive', () => {
		expect(mimeForFilename('informe.PDF')).toBe('application/pdf');
		expect(mimeForFilename('foto.JPG')).toBe('image/jpeg');
		expect(mimeForFilename('notas.md')).toBe('text/markdown');
		expect(mimeForFilename('datos.csv')).toBe('text/csv');
	});

	it('extensión desconocida o sin extensión → application/octet-stream', () => {
		expect(mimeForFilename('binario.xyz')).toBe('application/octet-stream');
		expect(mimeForFilename('sinextension')).toBe('application/octet-stream');
	});

	/**
	 * Hasta 2026-08-26 `.txt`/`.log` degradaban a `application/octet-stream`
	 * (landmine de SvelteKit, ver el JSDoc de `uploadAttachment` en
	 * `lumbre-client.ts`): esa degradación se ha MOVIDO — ahora el
	 * `Content-Type` que sale por el cable es SIEMPRE `application/octet-stream`
	 * (decidido en `uploadAttachment`, no aquí) y el mime real viaja en
	 * `x-lumbre-content-type`, así que `mimeForFilename` vuelve a devolver el
	 * mime real sin excepciones. El guardarraíl real (nunca uno de los cuatro
	 * Content-Type de SvelteKit sale por el cable) se mueve con el test de
	 * `uploadAttachment` en `lumbre-client.test.ts`.
	 */
	it('.txt/.log YA NO degradan: devuelven su mime real (la degradación viajó a uploadAttachment)', () => {
		expect(mimeForFilename('notas.txt')).toBe('text/plain');
		expect(mimeForFilename('salida.log')).toBe('application/octet-stream'); // .log no está en el mapa
	});

	it('text/markdown y text/csv viajan con su mime real (nunca degradaron)', () => {
		expect(mimeForFilename('a.md')).toBe('text/markdown');
		expect(mimeForFilename('a.csv')).toBe('text/csv');
	});
});

describe('resolveLocalPath', () => {
	it('una ruta absoluta se devuelve tal cual', () => {
		expect(resolveLocalPath('/tmp/algo.pdf')).toBe('/tmp/algo.pdf');
	});

	it('"~/…" se expande contra os.homedir()', () => {
		expect(resolveLocalPath('~/informe.pdf')).toBe(join(homedir(), 'informe.pdf'));
	});

	it('una ruta relativa se rechaza (impredecible: cwd del proceso MCP, no de la sesión)', () => {
		expect(() => resolveLocalPath('informe.pdf')).toThrow(/absoluta/);
		expect(() => resolveLocalPath('./informe.pdf')).toThrow(/absoluta/);
		expect(() => resolveLocalPath('../informe.pdf')).toThrow(/absoluta/);
	});
});

describe('readLocalAttachment', () => {
	it('camino feliz: lee los bytes, usa el basename y decide el mime', async () => {
		const filePath = join(dir, 'informe.pdf');
		await writeFile(filePath, Buffer.from('%PDF-1.4 contenido de prueba'));

		const result = await readLocalAttachment(filePath);

		expect(result.filename).toBe('informe.pdf');
		expect(result.mime).toBe('application/pdf');
		expect(result.bytes.toString()).toBe('%PDF-1.4 contenido de prueba');
	});

	it('`filename` explícito GANA al basename de file_path', async () => {
		const filePath = join(dir, 'original.bin');
		await writeFile(filePath, Buffer.from('contenido'));

		const result = await readLocalAttachment(filePath, 'informe año.pdf');

		expect(result.filename).toBe('informe año.pdf');
		expect(result.mime).toBe('application/pdf'); // el mime se decide sobre el nombre FINAL
	});

	it('fichero que no existe: error legible', async () => {
		await expect(readLocalAttachment(join(dir, 'no-existe.pdf'))).rejects.toThrow(/No existe/);
	});

	it('es un directorio: error legible', async () => {
		const subdir = join(dir, 'carpeta');
		await mkdir(subdir);
		await expect(readLocalAttachment(subdir)).rejects.toThrow(/directorio/);
	});

	it('fichero vacío (0 bytes): error legible', async () => {
		const filePath = join(dir, 'vacio.txt');
		await writeFile(filePath, Buffer.alloc(0));
		await expect(readLocalAttachment(filePath)).rejects.toThrow(/vacío/);
	});

	it('supera el tope de 25 MiB: el mensaje trae el tamaño REAL, no uno genérico', async () => {
		const filePath = join(dir, 'grande.bin');
		await writeFile(filePath, Buffer.alloc(MAX_ATTACHMENT_BYTES + 1));
		await expect(readLocalAttachment(filePath)).rejects.toThrow(/25\.0 MB/);
	});

	it('ruta relativa: rechazada antes de tocar el disco', async () => {
		await expect(readLocalAttachment('informe.pdf')).rejects.toThrow(/absoluta/);
	});
});

describe('decodeBase64Attachment', () => {
	it('camino feliz: decodifica los bytes y decide el mime sobre `filename`', () => {
		const bytes = Buffer.from('contenido de prueba');
		const result = decodeBase64Attachment(bytes.toString('base64'), 'notas.txt');
		expect(result.bytes.toString()).toBe('contenido de prueba');
		expect(result.filename).toBe('notas.txt');
		expect(result.mime).toBe('text/plain');
	});

	it('tolera saltos de línea dentro del base64 (el modelo puede envolver el argumento)', () => {
		const bytes = Buffer.from('a'.repeat(60));
		const wrapped = bytes.toString('base64').replace(/(.{10})/g, '$1\n');
		const result = decodeBase64Attachment(wrapped, 'a.txt');
		expect(result.bytes.equals(bytes)).toBe(true);
	});

	it('filename vacío o en blanco: error legible', () => {
		const bytes = Buffer.from('x').toString('base64');
		expect(() => decodeBase64Attachment(bytes, '')).toThrow(/filename/);
		expect(() => decodeBase64Attachment(bytes, '   ')).toThrow(/filename/);
	});

	it('base64 mal formado (caracteres fuera de alfabeto, longitud no múltiplo de 4): error legible', () => {
		expect(() => decodeBase64Attachment('no-es-base64!!!', 'a.txt')).toThrow(/base64/);
		expect(() => decodeBase64Attachment('abc', 'a.txt')).toThrow(/base64/);
	});

	it('cadena vacía: error legible (no decodifica silenciosamente a 0 bytes)', () => {
		expect(() => decodeBase64Attachment('', 'a.txt')).toThrow(/base64/);
	});

	it('supera el tope de 1 MiB decodificado: el mensaje trae el tamaño REAL', () => {
		const oversized = Buffer.alloc(MAX_BASE64_ATTACHMENT_BYTES + 1).toString('base64');
		expect(() => decodeBase64Attachment(oversized, 'grande.bin')).toThrow(/1\.0 MB/);
	});
});
