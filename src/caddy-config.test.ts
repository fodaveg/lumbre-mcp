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

	it('HSTS alcanza a los subdominios de este host, sin preload', async () => {
		const config = await readFile('deploy/mcp-lumbre-pro.caddy', 'utf8');
		const header = /Strict-Transport-Security\s+"([^"]+)"/.exec(config)?.[1];
		expect(header).toBe('max-age=31536000; includeSubDomains');
		// `preload` se pide desde el ápice y afecta a TODO el dominio; salir de
		// esa lista lleva meses. No entra desde el fragmento de un subdominio.
		expect(header).not.toContain('preload');
	});
});
