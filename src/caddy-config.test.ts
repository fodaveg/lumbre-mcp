import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

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
