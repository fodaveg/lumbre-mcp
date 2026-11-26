import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OAUTH_CALLBACK, OAUTH_RESOURCE, OAUTH_SCOPE, OAuthService } from './oauth.js';
import { loginConfigFromEnv } from './sumego-oidc.js';

const SECRET = 's'.repeat(32);
const CLIENT = 'https://claude.ai/.well-known/oauth-client/lumbre';
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const CREDENTIAL_ID = '22222222-2222-4222-8222-222222222222';
const BEARER = 'ab'.repeat(32);
const dirs: string[] = [];

afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function response() {
	const req = new IncomingMessage(new Socket());
	req.method = 'GET';
	const res = new ServerResponse(req);
	return { req, res };
}

async function fixture() {
	const stateDir = await mkdtemp(join(tmpdir(), 'lumbre-oauth-delivery-'));
	dirs.push(stateDir);
	const calls: [string, Record<string, unknown>][] = [];
	let capabilitiesStatus = 200;
	let recoverStatus = 200;
	let loseExchange = true;
	let ackStatus = 200;
	const credential = {
		credentialId: CREDENTIAL_ID, accessToken: BEARER, tokenType: 'Bearer', resource: OAUTH_RESOURCE, scope: OAUTH_SCOPE
	};
	const readStore = async () => JSON.parse(await readFile(join(stateDir, 'oauth-store.json'), 'utf8')) as {
		authorizationDeliveries: { requestId: string; deliveryId: string; transaction: unknown; owned: boolean }[];
		authorizationCodes: unknown[];
	};
	const fetcher: typeof fetch = async (input, init) => {
		if (String(input) === CLIENT) {
			return Response.json({ client_id: CLIENT, client_name: 'Claude', redirect_uris: [OAUTH_CALLBACK],
				token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
		}
		const path = new URL(String(input)).pathname.replace('/api/integrations/lumbre-mcp/', '');
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		calls.push([path, body]);
		switch (path) {
			case 'requests': return Response.json({ requestId: REQUEST_ID,
				authorizationUrl: `https://app.lumbre.pro/integrations/lumbre-mcp?request=${REQUEST_ID}`,
				expiresAt: new Date(Date.now() + 300_000).toISOString() });
			case 'exchange/capabilities': return Response.json({ deliveryId: true }, { status: capabilitiesStatus });
			case 'exchange': {
				if (body.deliveryId) {
					const stored = (await readStore()).authorizationDeliveries;
					expect(stored).toEqual([{ requestId: REQUEST_ID, deliveryId: body.deliveryId, transaction: expect.any(Object), owned: false }]);
					expect(JSON.stringify(stored)).not.toContain(body.transactionId);
				}
				if (loseExchange) throw new Error('respuesta perdida después de emitir');
				return Response.json(credential);
			}
			case 'exchange/recover': return Response.json(credential, { status: recoverStatus });
			case 'exchange/ack': return Response.json({ acknowledged: true }, { status: ackStatus });
			case 'revoke': return Response.json({ ok: true });
			default: throw new Error('ruta inesperada');
		}
	};
	function open() {
		return new OAuthService({ stateDir, fetch: fetcher, login: loginConfigFromEnv({}), backchannelSecret: SECRET, backchannelRetryDelaysMs: [] });
	}
	async function consent(service: OAuthService) {
		const start = response();
		const params = new URLSearchParams({
			response_type: 'code', client_id: CLIENT, redirect_uri: OAUTH_CALLBACK, scope: OAUTH_SCOPE,
			resource: OAUTH_RESOURCE, code_challenge: createHash('sha256').update('v'.repeat(43)).digest('base64url'),
			code_challenge_method: 'S256'
		});
		await service.handleAuthorize(start.req, start.res, new URL(`/authorize?${params}`, OAUTH_RESOURCE));
		expect(start.res.statusCode).toBe(302);
		const finish = response();
		await service.handleLumbreCallback(finish.req, finish.res,
			new URL(`/oauth/lumbre/callback?request=${REQUEST_ID}&decision=approved`, OAUTH_RESOURCE));
		return finish.res.statusCode;
	}
	return {
		open, consent, calls, readStore,
		setLegacy: () => { capabilitiesStatus = 404; loseExchange = false; },
		failCapabilities: () => { capabilitiesStatus = 503; },
		failRecover: () => { recoverStatus = 503; },
		restoreRecover: () => { recoverStatus = 200; },
		failAck: () => { ackStatus = 503; },
		restoreAck: () => { ackStatus = 200; }
	};
}

describe('entrega durable del proveedor OAuth de Lumbre', () => {
	it('recupera la misma entrega y reanuda el acuse de un código ya guardado', async () => {
		const f = await fixture();
		f.failAck();
		expect(await f.consent(f.open())).toBe(302);
		const exchange = f.calls.find(([path]) => path === 'exchange')![1];
		expect(exchange.deliveryId).toMatch(/^[0-9a-f-]{36}$/);
		expect(f.calls.slice(2)).toEqual([['exchange', exchange], ['exchange/recover', exchange], ['exchange/ack', exchange]]);
		const owned = await f.readStore();
		expect(owned.authorizationCodes).toHaveLength(1);
		expect(owned.authorizationDeliveries).toEqual([expect.objectContaining({ deliveryId: exchange.deliveryId, owned: true })]);
		f.restoreAck();
		await f.open().ensureReady();
		expect(f.calls.slice(5)).toEqual([['exchange/ack', exchange]]);
		expect((await f.readStore()).authorizationDeliveries).toEqual([]);
	});

	it('tras reiniciar revoca la entrega sin custodia local sin crear otro código', async () => {
		const f = await fixture();
		f.failRecover();
		expect(await f.consent(f.open())).toBe(503);
		const ref = f.calls.find(([path]) => path === 'exchange')![1];
		expect((await f.readStore()).authorizationDeliveries).toEqual([expect.objectContaining({ deliveryId: ref.deliveryId, owned: false })]);
		f.restoreRecover();
		await f.open().ensureReady();
		expect(f.calls.slice(-3)).toEqual([['exchange/recover', ref], ['revoke', { accessToken: BEARER }], ['exchange/ack', ref]]);
		expect((await f.readStore()).authorizationCodes).toEqual([]);
		expect((await f.readStore()).authorizationDeliveries).toEqual([]);
	});

	it('negocia el servidor anterior y conserva el cuerpo histórico', async () => {
		const f = await fixture();
		f.setLegacy();
		expect(await f.consent(f.open())).toBe(302);
		expect(f.calls.map(([path]) => path)).toEqual(['requests', 'exchange/capabilities', 'exchange']);
		expect(f.calls.at(-1)![1]).toEqual({ requestId: REQUEST_ID, transactionId: expect.any(String) });
	});

	it('un fallo de capabilities no activa el canje histórico', async () => {
		const f = await fixture();
		f.failCapabilities();
		expect(await f.consent(f.open())).toBe(503);
		expect(f.calls.map(([path]) => path)).toEqual(['requests', 'exchange/capabilities']);
	});
});
