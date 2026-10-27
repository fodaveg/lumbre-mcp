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
		// `retryDelaysMs: []`: este test mide la CLASIFICACIÓN de un único
		// intento (`postOnce`); los reintentos de lo transitorio tienen su
		// propio describe abajo.
		for (const [fetchFn, kind] of [
			[async () => response({}, 401), 'invalid'],
			[async () => response({}, 503), 'transient'],
			[async () => { throw new Error('timeout'); }, 'transient'],
			[async () => response('{', 200), 'invalid'],
			[async () => response('x'.repeat(65 * 1024), 200), 'invalid']
		] as const) {
			const backchannel = new LumbreBackchannel({ secret: SECRET, fetch: fetchFn as typeof fetch, retryDelaysMs: [] });
			await expect(backchannel.introspect(TOKEN)).rejects.toMatchObject({ kind });
		}
	});

	it('Sumego: la solicitud lleva identityProvider y el hash del nonce, y acepta la respuesta sin authorizationUrl', async () => {
		const bodies: unknown[] = [];
		const replies = [
			response({ requestId: REQUEST_ID, expiresAt: '2026-10-21T10:10:00.000Z' }),
			response({ authorizationUrl: 'https://cualquier.cosa/que-no-se-usa', requestId: REQUEST_ID, expiresAt: '2026-10-21T10:10:00.000Z' }),
			response({ requestId: 'no-es-uuid', expiresAt: '2026-10-21T10:10:00.000Z' })
		];
		const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
			expect(String(input)).toBe('https://app.lumbre.pro/api/integrations/lumbre-mcp/requests');
			bodies.push(JSON.parse(String(init?.body)));
			return replies.shift()!;
		});
		const backchannel = new LumbreBackchannel({ secret: SECRET, fetch: fetchMock });
		const request = {
			transactionId: 'x'.repeat(32),
			clientId: 'https://claude.ai/client.json',
			clientName: 'Claude',
			resource: 'https://mcp.lumbre.pro/mcp',
			scope: 'lumbre:mcp',
			callbackUri: LUMBRE_OAUTH_CALLBACK,
			identityProvider: 'sumego' as const,
			sumegoNonceSha256: 'n'.repeat(43)
		};
		expect(await backchannel.createSumegoAuthorizationRequest(request)).toEqual({
			requestId: REQUEST_ID,
			expiresAt: Date.parse('2026-10-21T10:10:00.000Z')
		});
		expect(bodies[0]).toMatchObject({ identityProvider: 'sumego', sumegoNonceSha256: 'n'.repeat(43) });
		expect((await backchannel.createSumegoAuthorizationRequest(request)).requestId).toBe(REQUEST_ID);
		await expect(backchannel.createSumegoAuthorizationRequest(request)).rejects.toMatchObject({ kind: 'invalid' });
	});

	it('Sumego: el canje va EXACTAMENTE a /api/integrations/lumbre-mcp/sumego/exchange con su cuerpo y valida el 200', async () => {
		let seen: { url: string; body: unknown } | undefined;
		const backchannel = new LumbreBackchannel({
			secret: SECRET,
			fetch: (async (input, init) => {
				seen = { url: String(input), body: JSON.parse(String(init?.body)) };
				return response({ credentialId: CREDENTIAL_ID, accessToken: TOKEN, tokenType: 'Bearer', resource: 'r', scope: 's' });
			}) as typeof fetch
		});
		const request = {
			requestId: REQUEST_ID,
			transactionId: 'x'.repeat(32),
			idToken: 'cabecera.cuerpo.firma',
			clientId: 'https://claude.ai/client.json',
			resource: 'https://mcp.lumbre.pro/mcp',
			scope: 'lumbre:mcp'
		};
		expect(await backchannel.exchangeSumegoIdentity(request)).toMatchObject({ credentialId: CREDENTIAL_ID, accessToken: TOKEN });
		// Literal a propósito, y no `SUMEGO_EXCHANGE_PATH`: una ruta mal escrita
		// en la constante tiene que salir aquí en rojo (la primera versión del
		// contrato citaba `/api/integrations/mcp/sumego/…`, que en Lumbre da 404).
		expect(seen).toEqual({ url: 'https://app.lumbre.pro/api/integrations/lumbre-mcp/sumego/exchange', body: request });
	});

	it.each([
		[400, { code: 'invalid_token' }, 'invalid', 'invalid_token'],
		[400, { code: 'unknown_account' }, 'invalid', 'unknown_account'],
		[401, {}, 'invalid', undefined],
		[403, { code: 'account_pending' }, 'invalid', 'account_pending'],
		[403, { code: 'account_suspended' }, 'invalid', 'account_suspended'],
		[403, { code: 'account_rejected' }, 'invalid', 'account_rejected'],
		[404, { code: 'transaction_not_found' }, 'invalid', 'transaction_not_found'],
		[409, { code: 'token_reused' }, 'invalid', 'token_reused'],
		[401, { message: 'Unauthorized' }, 'invalid', undefined],
		[400, { code: 'invalid_request' }, 'invalid', 'invalid_request'],
		[413, { code: 'payload_too_large' }, 'invalid', 'payload_too_large'],
		[413, {}, 'invalid', undefined],
		[400, { code: '<script>no-es-de-la-lista</script>' }, 'invalid', undefined],
		[503, { code: 'sumego_unavailable' }, 'transient', 'sumego_unavailable'],
		[429, { code: 'rate_limited' }, 'transient', 'rate_limited'],
		[503, { code: 'jwks_unavailable' }, 'transient', undefined],
		[500, 'no es json', 'transient', undefined]
	] as const)('Sumego: el canje con %i %j es %s y lleva el code %s', async (status, body, kind, code) => {
		const backchannel = new LumbreBackchannel({
			secret: SECRET,
			fetch: (async () => response(body, status)) as typeof fetch
		});
		const error = await backchannel
			.exchangeSumegoIdentity({
				requestId: REQUEST_ID,
				transactionId: 'x'.repeat(32),
				idToken: 'a.b.c',
				clientId: 'c',
				resource: 'r',
				scope: 's'
			})
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(BackchannelError);
		expect(error).toMatchObject({ kind, code });
	});

	it('Sumego: el canje sin respuesta a tiempo es transitorio', async () => {
		const backchannel = new LumbreBackchannel({
			secret: SECRET,
			fetch: (async () => { throw new DOMException('timeout', 'TimeoutError'); }) as typeof fetch
		});
		await expect(
			backchannel.exchangeSumegoIdentity({
				requestId: REQUEST_ID,
				transactionId: 'x'.repeat(32),
				idToken: 'a.b.c',
				clientId: 'c',
				resource: 'r',
				scope: 's'
			})
		).rejects.toMatchObject({ kind: 'transient' });
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

describe('reintento de lo transitorio (ventana de deploy de lumbre-web)', () => {
	/** El mismo 502/503 que devuelve el borde mientras el contenedor de la
	 *  app se recrea en un despliegue. */
	function edgeDown(): Response {
		return response({}, 503);
	}

	it('introspect reintenta un 503 y sale bien cuando la app vuelve (el refresh de un cliente ya no muere)', async () => {
		const replies = [edgeDown(), edgeDown(), response({ active: false })];
		const sleeps: number[] = [];
		const backchannel = new LumbreBackchannel({
			secret: SECRET,
			fetch: (async () => replies.shift()!) as typeof fetch,
			retryDelaysMs: [10, 20],
			sleepFn: async (ms) => {
				sleeps.push(ms);
			}
		});
		await expect(backchannel.introspect(TOKEN)).resolves.toEqual({ active: false });
		expect(sleeps).toEqual([10, 20]);
	});

	it('introspect agota los reintentos y devuelve el fallo transitorio, con una espera por intento agotado', async () => {
		const sleeps: number[] = [];
		const backchannel = new LumbreBackchannel({
			secret: SECRET,
			fetch: (async () => edgeDown()) as typeof fetch,
			retryDelaysMs: [5, 5],
			sleepFn: async (ms) => {
				sleeps.push(ms);
			}
		});
		await expect(backchannel.introspect(TOKEN)).rejects.toMatchObject({ kind: 'transient' });
		expect(sleeps).toEqual([5, 5]);
	});

	it('un 4xx no se reintenta ni una vez (sigue siendo invalid al primer intento)', async () => {
		let calls = 0;
		const backchannel = new LumbreBackchannel({
			secret: SECRET,
			fetch: (async () => {
				calls++;
				return response({}, 401);
			}) as typeof fetch,
			retryDelaysMs: [5],
			sleepFn: async () => {
				throw new Error('no debería dormir');
			}
		});
		await expect(backchannel.introspect(TOKEN)).rejects.toMatchObject({ kind: 'invalid' });
		expect(calls).toBe(1);
	});

	it('el canje de una transacción de un solo uso nunca reintenta (token_reused al segundo intento)', async () => {
		let calls = 0;
		const backchannel = new LumbreBackchannel({
			secret: SECRET,
			fetch: (async () => {
				calls++;
				return edgeDown();
			}) as typeof fetch,
			retryDelaysMs: [5],
			sleepFn: async () => {
				throw new Error('no debería dormir');
			}
		});
		await expect(backchannel.exchange(REQUEST_ID, 'x'.repeat(32))).rejects.toMatchObject({ kind: 'transient' });
		expect(calls).toBe(1);
	});

	it('revoke también reintenta lo transitorio', async () => {
		const replies = [edgeDown(), response({ ok: true })];
		const backchannel = new LumbreBackchannel({
			secret: SECRET,
			fetch: (async () => replies.shift()!) as typeof fetch,
			retryDelaysMs: [1],
			sleepFn: async () => {}
		});
		await expect(backchannel.revoke(TOKEN)).resolves.toBeUndefined();
	});
});
