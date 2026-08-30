import { describe, expect, it, vi } from 'vitest';
import {
	BackchannelError,
	LUMBRE_OAUTH_CALLBACK,
	LumbreBackchannel,
	validateAuthorizationUrl
} from './lumbre-oauth-backchannel.js';

const SECRET = 'secreto-backchannel-de-prueba-32-caracteres';
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const CREDENTIAL_ID = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'a'.repeat(64);

function response(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', ...headers }
	});
}

describe('backchannel web de Lumbre', () => {
	it('falla cerrado sin secreto suficiente y cierra el origin configurable', () => {
		expect(() => new LumbreBackchannel().ensureConfigured()).toThrow(/SECRET/);
		expect(() => new LumbreBackchannel({ secret: 'corto' }).ensureConfigured()).toThrow(/SECRET/);
		expect(() => new LumbreBackchannel({ secret: SECRET, baseUrl: 'https://evil.example' })).toThrow(/exactamente/);
	});

	it('envía el secreto solo en Authorization y valida la creación exacta', async () => {
		const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
			expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${SECRET}`);
			expect(String(init?.body)).not.toContain(SECRET);
			return response({
				authorizationUrl: `https://app.lumbre.pro/integrations/lumbre-mcp?request=${REQUEST_ID}`,
				requestId: REQUEST_ID,
				expiresAt: '2026-08-30T10:00:00.000Z'
			});
		});
		const backchannel = new LumbreBackchannel({ secret: SECRET, fetch: fetchMock });
		const created = await backchannel.createAuthorizationRequest({
			transactionId: 'x'.repeat(32),
			clientId: 'https://claude.ai/client.json',
			clientName: 'Claude',
			resource: 'https://mcp.lumbre.pro/mcp',
			scope: 'lumbre:mcp',
			callbackUri: LUMBRE_OAUTH_CALLBACK
		});
		expect(created.requestId).toBe(REQUEST_ID);
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it.each([
		'https://evil.example/integrations/lumbre-mcp?request=' + REQUEST_ID,
		'https://app.lumbre.pro:444/integrations/lumbre-mcp?request=' + REQUEST_ID,
		'https://user@app.lumbre.pro/integrations/lumbre-mcp?request=' + REQUEST_ID,
		'https://app.lumbre.pro/integrations/lumbre-mcp?request=' + REQUEST_ID + '&extra=1',
		'https://app.lumbre.pro/integrations/lumbre-mcp?request=' + REQUEST_ID + '#fragmento',
		'https://app.lumbre.pro/otro?request=' + REQUEST_ID
	])('rechaza authorizationUrl maliciosa: %s', (url) => {
		expect(() => validateAuthorizationUrl(url)).toThrow(BackchannelError);
	});

	it('clasifica 4xx/5xx/red y rechaza JSON malformado o sobredimensionado', async () => {
		for (const [fetchFn, kind] of [
			[async () => response({}, 401), 'invalid'],
			[async () => response({}, 503), 'transient'],
			[async () => { throw new Error('timeout'); }, 'transient'],
			[async () => response('{', 200), 'invalid'],
			[async () => response('x'.repeat(65 * 1024), 200), 'invalid']
		] as const) {
			const backchannel = new LumbreBackchannel({ secret: SECRET, fetch: fetchFn as typeof fetch });
			await expect(backchannel.introspect(TOKEN)).rejects.toMatchObject({ kind });
		}
	});

	it('valida exchange/introspect/revoke completos, sin aceptar contratos parciales', async () => {
		const bodies = [
			response({ credentialId: CREDENTIAL_ID, accessToken: TOKEN, tokenType: 'bearer', resource: 'https://mcp.lumbre.pro/mcp', scope: 'lumbre:mcp' }),
			response({ active: true, credentialId: CREDENTIAL_ID, clientId: 'https://claude.ai/client.json', resource: 'otro', scope: 'lumbre:mcp' }),
			response({ ok: false })
		];
		const backchannel = new LumbreBackchannel({ secret: SECRET, fetch: (async () => bodies.shift()!) as typeof fetch });
		await expect(backchannel.exchange(REQUEST_ID, 'x'.repeat(32))).rejects.toMatchObject({ kind: 'invalid' });
		const introspection = await backchannel.introspect(TOKEN);
		expect(introspection).toMatchObject({ active: true, resource: 'otro' });
		await expect(backchannel.revoke(TOKEN)).rejects.toMatchObject({ kind: 'invalid' });
	});
});
