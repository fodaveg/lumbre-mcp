import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_ATTACHMENT_BYTES, mimeForFilename, readLocalAttachment, resolveLocalPath } from './attachments.js';

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
	 * LA LANDMINE (ver el JSDoc de `SVELTEKIT_FORM_CONTENT_TYPES` en
	 * `attachments.ts`): `text/plain` es uno de los cuatro Content-Type que
	 * `is_form_content_type` de `@sveltejs/kit` intercepta ANTES de nuestro
	 * handler cuando la petición no trae `Origin` (el caso de este MCP) — un
	 * `.txt`/`.log` con su mime "correcto" se rechazaría con 403 mudo. Este
	 * test es lo único que impide que alguien "arregle" el mapa poniendo el
	 * mime real y rompa la subida en producción sin que nada se ponga rojo.
	 */
	it('.txt degrada a application/octet-stream (si no, 403 mudo de SvelteKit)', () => {
		expect(mimeForFilename('notas.txt')).toBe('application/octet-stream');
		expect(mimeForFilename('salida.log')).toBe('application/octet-stream');
	});

	it('text/markdown y text/csv NO están en la lista de SvelteKit: viajan con su mime real', () => {
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
