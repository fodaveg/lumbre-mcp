import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `dist/` va VERSIONADO en este repo (ver README, "Actualizar sin toolchain":
 * una máquina con el clon actualiza con `git pull`, sin toolchain), así que
 * quien toca `src/` tiene que recompilar y commitear `dist/` en el MISMO
 * commit. Hasta hoy eso no lo vigilaba nada y el README lo decía: un `dist/`
 * viejo no rompe ningún test, simplemente sirve el código de antes a quien
 * enchufe el conector — el fallo más silencioso que puede tener este repo.
 *
 * Este test compila `src/` con la MISMA configuración que `npm run build`
 * (`tsc -p tsconfig.json`, solo cambiando `--outDir` a un temporal bajo
 * `os.tmpdir()`) y compara el resultado con `dist/`, fichero a fichero.
 *
 * Determinismo: los `.js.map` llevan en `sources` la ruta RELATIVA del fuente
 * desde el fichero de mapa, así que un build en `os.tmpdir()` y otro en
 * `dist/` difieren siempre ahí aunque el código sea idéntico (`../src/x.ts`
 * vs `../../../…/src/x.ts`). `normalizarContenido` neutraliza SOLO eso:
 * reduce cada `sources` a su basename y vacía `sourceRoot`. Un fuente
 * renombrado sigue cantando (cambia el basename) y el resto del mapa
 * (`mappings`, `names`) se compara tal cual. Los `.js` no llevan rutas
 * absolutas: su `sourceMappingURL` es el nombre del mapa hermano.
 *
 * Coste medido en este repo (Mac, 2026-09-19): 982 ms el test del árbol real
 * (casi todo `tsc`) y 1-2 ms cada uno de los dos de la función pura; el
 * primero lleva timeout explícito por si una máquina más lenta o un `tsc`
 * frío se acercan al default de vitest.
 */

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Diferencias entre dos árboles de ficheros, por ruta RELATIVA. */
export interface DiferenciasArboles {
	/** Rutas que están en el candidato y NO en la referencia (basura vieja). */
	sobran: string[];
	/** Rutas que están en la referencia y NO en el candidato (sin compilar). */
	faltan: string[];
	/** Rutas presentes en los dos, con contenido distinto. */
	difieren: string[];
}

/** Rutas relativas de TODOS los ficheros bajo `raiz`, recursivo y ordenadas. */
function rutasDe(raiz: string, prefijo = ''): string[] {
	const rutas: string[] = [];
	for (const entrada of readdirSync(join(raiz, prefijo), { withFileTypes: true })) {
		const relativa = prefijo === '' ? entrada.name : `${prefijo}/${entrada.name}`;
		if (entrada.isDirectory()) rutas.push(...rutasDe(raiz, relativa));
		else rutas.push(relativa);
	}
	return rutas.sort();
}

/** Contenido comparable de un fichero emitido: tal cual, salvo los `.map`,
 *  cuyas rutas de `sources`/`sourceRoot` dependen de DÓNDE se compiló (ver el
 *  JSDoc de cabecera) y se reducen al basename. */
function normalizarContenido(ruta: string, raiz: string): string {
	const bruto = readFileSync(join(raiz, ruta), 'utf8');
	if (!ruta.endsWith('.map')) return bruto;
	const mapa = JSON.parse(bruto) as { sources?: string[]; sourceRoot?: string };
	return JSON.stringify({
		...mapa,
		sourceRoot: '',
		sources: (mapa.sources ?? []).map((fuente) => basename(fuente))
	});
}

/**
 * Compara dos árboles de ficheros: `referencia` (lo que DEBERÍA haber) contra
 * `candidato` (lo que hay). Pura sobre disco y sin dependencias del proyecto,
 * para poder probarla con dos directorios de juguete — ver el segundo test.
 */
export function compararArboles(referencia: string, candidato: string): DiferenciasArboles {
	const enReferencia = rutasDe(referencia);
	const enCandidato = rutasDe(candidato);
	const setReferencia = new Set(enReferencia);
	const setCandidato = new Set(enCandidato);
	return {
		sobran: enCandidato.filter((ruta) => !setReferencia.has(ruta)),
		faltan: enReferencia.filter((ruta) => !setCandidato.has(ruta)),
		difieren: enReferencia
			.filter((ruta) => setCandidato.has(ruta))
			.filter((ruta) => normalizarContenido(ruta, referencia) !== normalizarContenido(ruta, candidato))
	};
}

/** `null` si los dos árboles coinciden; si no, el detalle por categoría. */
function resumenDeDiferencias(diferencias: DiferenciasArboles): string | null {
	const lineas = [
		diferencias.faltan.length > 0 ? `faltan en dist/: ${diferencias.faltan.join(', ')}` : '',
		diferencias.sobran.length > 0 ? `sobran en dist/: ${diferencias.sobran.join(', ')}` : '',
		diferencias.difieren.length > 0 ? `difieren: ${diferencias.difieren.join(', ')}` : ''
	].filter((linea) => linea !== '');
	return lineas.length > 0 ? lineas.join('\n') : null;
}

const MENSAJE = 'dist/ no está al día con src/: ejecuta `npm run build` y commitea dist/ en el mismo commit';

describe('dist/ versionado — coincide con src/ compilado', () => {
	it('compilar src/ con la config de `npm run build` da exactamente el dist/ del repo', () => {
		const temporal = mkdtempSync(join(tmpdir(), 'lumbre-mcp-dist-al-dia-'));
		try {
			execFileSync(
				process.execPath,
				[
					join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
					'-p',
					join(REPO_ROOT, 'tsconfig.json'),
					'--outDir',
					temporal
				],
				{ cwd: REPO_ROOT, stdio: 'pipe' }
			);
			const resumen = resumenDeDiferencias(compararArboles(temporal, join(REPO_ROOT, 'dist')));
			if (resumen !== null) expect.fail(`${MENSAJE}\n${resumen}`);
		} finally {
			rmSync(temporal, { recursive: true, force: true });
		}
	}, 120_000);

	it('compararArboles detecta un byte cambiado y NOMBRA la ruta', () => {
		const referencia = mkdtempSync(join(tmpdir(), 'lumbre-mcp-arbol-ref-'));
		const candidato = mkdtempSync(join(tmpdir(), 'lumbre-mcp-arbol-cand-'));
		try {
			for (const raiz of [referencia, candidato]) {
				mkdirSync(join(raiz, 'tools'), { recursive: true });
				writeFileSync(join(raiz, 'index.js'), 'export const a = 1;\n');
				writeFileSync(join(raiz, 'tools', 'batch.js'), 'export const b = 2;\n');
			}
			expect(compararArboles(referencia, candidato)).toEqual({ sobran: [], faltan: [], difieren: [] });

			// UN byte distinto en un fichero anidado: 2 → 3.
			writeFileSync(join(candidato, 'tools', 'batch.js'), 'export const b = 3;\n');
			// Y un fichero que sobra y otro que falta, para que el informe los
			// separe en vez de decir solo "hay diferencias".
			writeFileSync(join(candidato, 'viejo.js'), 'export const c = 3;\n');
			writeFileSync(join(referencia, 'nuevo.js'), 'export const d = 4;\n');

			const diferencias = compararArboles(referencia, candidato);
			expect(diferencias).toEqual({
				sobran: ['viejo.js'],
				faltan: ['nuevo.js'],
				difieren: ['tools/batch.js']
			});
			const resumen = resumenDeDiferencias(diferencias);
			expect(resumen).toContain('tools/batch.js');
			expect(resumen).toContain('viejo.js');
			expect(resumen).toContain('nuevo.js');
		} finally {
			rmSync(referencia, { recursive: true, force: true });
			rmSync(candidato, { recursive: true, force: true });
		}
	});

	it('los `.map` no delatan DÓNDE se compiló (solo el basename del fuente)', () => {
		// Regresión del propio instrumento: si esta normalización se cae, el
		// primer test falla SIEMPRE (dist/ y el temporal nunca coinciden en
		// `sources`) y se leería como "dist/ está desactualizado" con dist/ al día.
		const referencia = mkdtempSync(join(tmpdir(), 'lumbre-mcp-map-ref-'));
		const candidato = mkdtempSync(join(tmpdir(), 'lumbre-mcp-map-cand-'));
		try {
			const mapa = (sources: string[], sourceRoot: string) =>
				JSON.stringify({ version: 3, file: 'index.js', sourceRoot, sources, names: [], mappings: 'AAAA' });
			writeFileSync(join(referencia, 'index.js.map'), mapa(['../src/index.ts'], ''));
			writeFileSync(join(candidato, 'index.js.map'), mapa(['../../../var/tmp/x/src/index.ts'], '/x'));
			expect(compararArboles(referencia, candidato).difieren).toEqual([]);

			// …pero un fuente RENOMBRADO sí sigue cantando.
			writeFileSync(join(candidato, 'index.js.map'), mapa(['../src/index-viejo.ts'], ''));
			expect(compararArboles(referencia, candidato).difieren).toEqual(['index.js.map']);
		} finally {
			rmSync(referencia, { recursive: true, force: true });
			rmSync(candidato, { recursive: true, force: true });
		}
	});
});
