import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { MAX_MCP_BODY_BYTES } from './http.js';

// Golden producido por `caddy adapt` (Caddy 2 del borde) sobre el patrón
// saneado `handle /readyz { respond 404 }` + `handle { respond 200 }`.
// Verifica la semántica del grupo de handles; el assert del bloque exacto lo
// enlaza con el fragmento versionado sin enviar su configuración al VPS.
const ADAPTED_HANDLE_ROUTES = [
	{
		group: 'group2',
		match: [{ path: ['/readyz'] }],
		handle: [{ handler: 'subroute', routes: [{ handle: [{ handler: 'static_response', status_code: 404 }] }] }]
	},
	{
		group: 'group2',
		handle: [{ handler: 'subroute', routes: [{ handle: [{ handler: 'static_response', status_code: 200 }] }] }]
	}
] as const;

describe('Caddy — precedencia de credenciales', () => {
	it('el JSON adaptado del handle readiness precede y excluye al catch-all', async () => {
		const config = await readFile('deploy/mcp-lumbre-pro.caddy', 'utf8');
		expect(config).toContain('\thandle /readyz {\n\t\trespond 404\n\t}\n');
		const routes: ReadonlyArray<Record<string, unknown>> = ADAPTED_HANDLE_ROUTES;
		const readinessIndex = routes.findIndex((route) =>
			JSON.stringify(route.match).includes('"/readyz"')
		);
		expect(readinessIndex).toBeGreaterThanOrEqual(0);
		const readiness = routes[readinessIndex]!;
		const catchAllIndex = routes.findIndex(
			(route, index) => index > readinessIndex && route.group === readiness.group && route.match === undefined
		);
		expect(catchAllIndex).toBeGreaterThan(readinessIndex);
		expect(JSON.stringify(readiness.handle)).toContain('"handler":"static_response"');
		expect(JSON.stringify(readiness.handle)).toContain('"status_code":404');
	});

	it('preserva Authorization y solo sintetiza Bearer desde el path si falta', async () => {
		const config = await readFile('deploy/mcp-lumbre-pro.caddy', 'utf8');
		const withAuthStart = config.indexOf('@token_en_path_con_auth');
		const withoutAuthStart = config.indexOf('@token_en_path_sin_auth');
		expect(withAuthStart).toBeGreaterThan(0);
		expect(withoutAuthStart).toBeGreaterThan(withAuthStart);

		const withAuthBlock = config.slice(withAuthStart, withoutAuthStart);
		expect(withAuthBlock).toContain('header Authorization *');
		expect(withAuthBlock).not.toContain('header_up Authorization');

		const withoutAuthBlock = config.slice(withoutAuthStart, config.indexOf('\n\thandle {', withoutAuthStart));
		expect(withoutAuthBlock).toContain('header !Authorization');
		expect(withoutAuthBlock).toContain('header_up Authorization "Bearer {re.tok_noauth.1}"');
	});
});

describe('Caddy — tope del cuerpo y HSTS', () => {
	/** Las unidades de `max_size` las parsea Caddy con go-humanize: `MB` es
	 *  decimal (10^6) y `MiB` binario (2^20). Se reproduce aquí para poder
	 *  comparar el número del borde con el de la app en BYTES, que es lo único
	 *  que se puede comparar de verdad. */
	function parseBytes(value: string): number {
		const [, amount, unit] = /^(\d+(?:\.\d+)?)(\w*)$/.exec(value) ?? [];
		const factors: Record<string, number> = {
			'': 1, B: 1, KB: 1_000, MB: 1_000_000, GB: 1_000_000_000,
			KIB: 1024, MIB: 1024 * 1024, GIB: 1024 * 1024 * 1024
		};
		const factor = factors[(unit ?? '').toUpperCase()];
		expect(factor).toBeDefined();
		return Number(amount) * factor!;
	}

	it('el borde acota el cuerpo y no por encima del tope de la app', async () => {
		const config = await readFile('deploy/mcp-lumbre-pro.caddy', 'utf8');
		const declared = /request_body\s*\{\s*max_size\s+(\S+)\s*\}/.exec(config)?.[1];
		expect(declared).toBeDefined();
		const edgeBytes = parseBytes(declared!);
		// Que el borde sea el que corta primero es deliberado: el tope de la
		// app queda como red de seguridad para quien alcance el contenedor por
		// la red `edge` sin pasar por aquí. Y atarlo a la constante, en vez de
		// a un número escrito a mano, es lo que impide que uno de los dos se
		// mueva sin el otro.
		expect(edgeBytes).toBeLessThanOrEqual(MAX_MCP_BODY_BYTES);
		// Y con margen de sobra sobre el cuerpo legítimo más grande
		// (`content_base64` de 1 MiB ≈ 1,33 MiB de base64 + sobre JSON-RPC).
		expect(edgeBytes).toBeGreaterThan(1.5 * 1024 * 1024);
	});

	/** Bloques `reverse_proxy … { … }` del fragmento, con llaves anidadas. */
	function reverseProxyBlocks(config: string): string[] {
		const blocks: string[] = [];
		let from = 0;
		for (;;) {
			const start = config.indexOf('reverse_proxy lumbre-mcp:8787 {', from);
			if (start < 0) return blocks;
			let depth = 0;
			let end = start;
			for (let i = config.indexOf('{', start); i < config.length; i += 1) {
				if (config[i] === '{') depth += 1;
				if (config[i] === '}') depth -= 1;
				if (depth === 0) {
					end = i + 1;
					break;
				}
			}
			blocks.push(config.slice(start, end));
			from = end;
		}
	}

	/** Duraciones de Caddy (`5s`, `90s`, `1m`) en milisegundos. */
	function durationMs(value: string): number {
		const [, amount, unit] = /^(\d+)(ms|s|m)$/.exec(value) ?? [];
		expect(unit, value).toBeDefined();
		return Number(amount) * { ms: 1, s: 1_000, m: 60_000 }[unit as 'ms' | 's' | 'm'];
	}

	it('los tres reverse_proxy llevan los mismos plazos hacia el contenedor, atados al relé', async () => {
		const { MCP_REQUEST_TIMEOUT_MS } = await import('./http.js');
		const config = await readFile('deploy/mcp-lumbre-pro.caddy', 'utf8');
		const blocks = reverseProxyBlocks(config);
		// con Authorization + token en el path, sin Authorization, y el resto.
		expect(blocks).toHaveLength(3);
		const timeouts = blocks.map((block) => {
			const transport = /transport http \{([^}]*)\}/.exec(block)?.[1];
			expect(transport, block).toBeDefined();
			const read = (name: string) => {
				const value = new RegExp(`\\b${name}\\s+(\\S+)`).exec(transport!)?.[1];
				expect(value, `${name} en ${block}`).toBeDefined();
				return durationMs(value!);
			};
			return {
				dial: read('dial_timeout'),
				responseHeader: read('response_header_timeout'),
				write: read('write_timeout'),
				keepalive: read('keepalive')
			};
		});
		expect(new Set(timeouts.map((t) => JSON.stringify(t))).size).toBe(1);
		const [t] = timeouts;
		expect(t!.dial).toBeLessThanOrEqual(10_000);
		// El cuerpo lento lo corta el relé (408), no el borde a medias.
		expect(t!.write).toBe(MCP_REQUEST_TIMEOUT_MS);
		// Una tool puede encadenar varias peticiones de 30 s a la app.
		expect(t!.responseHeader).toBeGreaterThanOrEqual(60_000);
		expect(t!.responseHeader).toBeLessThanOrEqual(120_000);
		// Caddy suelta la conexión ociosa ANTES que Node: si no, puede
		// reutilizar una que Node está cerrando y devolver un 502.
		const { createHttpApp } = await import('./http.js');
		const app = createHttpApp('https://app.lumbre.test', {} as never);
		expect(t!.keepalive).toBeGreaterThan(0);
		expect(t!.keepalive).toBeLessThan(app.keepAliveTimeout);
	});

	it('los tres reverse_proxy reciben el cuerpo entero antes de hablar con el contenedor', async () => {
		const config = await readFile('deploy/mcp-lumbre-pro.caddy', 'utf8');
		const blocks = reverseProxyBlocks(config);
		expect(blocks).toHaveLength(3);
		const edgeMax = parseBytes(/request_body\s*\{\s*max_size\s+(\S+)\s*\}/.exec(config)![1]!);
		for (const block of blocks) {
			const declared = /\n\s*request_buffers\s+(\S+)/.exec(block)?.[1];
			expect(declared, block).toBeDefined();
			const buffer = parseBytes(declared!);
			// Cabe el cuerpo más grande que deja pasar el borde y el que acepta
			// la app: el contenedor nunca ve una subida a medias.
			expect(buffer).toBeGreaterThanOrEqual(MAX_MCP_BODY_BYTES);
			expect(buffer).toBeGreaterThanOrEqual(edgeMax);
			// …y no es un búfer sin techo por error de unidades.
			expect(buffer).toBeLessThanOrEqual(4 * 1024 * 1024);
		}
	});

	it('las rutas OAuth (Lumbre y Sumego) llegan al contenedor por el catch-all, sin un handle que las corte', async () => {
		const config = await readFile('deploy/mcp-lumbre-pro.caddy', 'utf8');
		const routes = [
			'/authorize',
			'/token',
			'/revoke',
			'/oauth/lumbre/callback',
			'/oauth/sumego/callback',
			'/oauth/sumego/consent',
			'/oauth/sumego/backchannel-logout'
		];
		// Los únicos handles con matcher son `/readyz` y los dos del token en
		// el path; ninguno puede casar una ruta OAuth.
		const matchedHandles = [...config.matchAll(/^\thandle (\S+) \{$/gm)].map((match) => match[1]);
		expect(matchedHandles).toEqual(['/readyz', '@token_en_path_con_auth', '@token_en_path_sin_auth']);
		const tokenPath = new RegExp(/path_regexp tok_auth (\S+)/.exec(config)![1]!);
		for (const route of routes) {
			expect(route).not.toBe('/readyz');
			expect(tokenPath.test(route), route).toBe(false);
		}
		// …y el catch-all las manda al relé.
		expect(config).toMatch(/\n\thandle \{\n\t\treverse_proxy lumbre-mcp:8787 \{/);
		for (const route of routes.filter((path) => path.startsWith('/oauth/'))) {
			expect(config, route).toContain(route);
		}
	});

	it('HSTS alcanza a los subdominios de este host, sin preload', async () => {
		const config = await readFile('deploy/mcp-lumbre-pro.caddy', 'utf8');
		const header = /Strict-Transport-Security\s+"([^"]+)"/.exec(config)?.[1];
		expect(header).toBe('max-age=31536000; includeSubDomains');
		// `preload` se pide desde el ápice y afecta a TODO el dominio; salir de
		// esa lista lleva meses. No entra desde el fragmento de un subdominio.
		expect(header).not.toContain('preload');
	});
});
