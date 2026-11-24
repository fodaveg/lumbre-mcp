import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OAuthService, OAUTH_CALLBACK, OAUTH_RESOURCE, OAUTH_SCOPE } from './oauth.js';

const clientId = 'https://claude.ai/.well-known/oauth-client/lumbre';
const requestId = '10000000-0000-4000-8000-000000000001';
const credentialId = '20000000-0000-4000-8000-000000000001';
const bearer = 'b3'.repeat(32);
const secret = 'secreto-sintetico-canary-del-backchannel';
const credential = { credentialId, accessToken: bearer, tokenType: 'Bearer', resource: OAUTH_RESOURCE, scope: OAUTH_SCOPE };
const now = Date.parse('2026-11-24T09:00:00Z');

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function call(
	service: OAuthService,
	method: 'handleAuthorize' | 'handleLumbreCallback',
	url: URL
) {
	const capture = { status: 0, headers: {} as Record<string, string>, body: '' };
	const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } } as IncomingMessage;
	const res = {
		writeHead(status: number, headers: Record<string, string>) {
			capture.status = status;
			capture.headers = headers;
		},
		end(body: string) { capture.body = body; }
	} as unknown as ServerResponse;
	await service[method](req, res, url);
	return capture;
}

async function harness() {
	const dir = await mkdtemp(join(tmpdir(), 'lumbre-mcp-exchange-'));
	dirs.push(dir);
	const readStore = () => readFile(join(dir, 'oauth-store.json'), 'utf8');
	const fetches: Array<{ path: string; body: Record<string, unknown> }> = [];
	const options = { lostExchanges: 0, lostAcks: 0, supported: true, revoked: false, pending: false };
	let transactionId: unknown;
	const fetcher: typeof fetch = async (input, init) => {
		const url = new URL(String(input));
		if (url.toString() === clientId) return json({
			client_id: clientId, client_name: 'Claude de prueba', redirect_uris: [OAUTH_CALLBACK],
			token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code']
		});
		expect(url.origin).toBe('https://app.lumbre.pro');
		expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${secret}`);
		const path = url.pathname.replace('/api/integrations/lumbre-mcp/', '');
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		fetches.push({ path, body });
		switch (path) {
			case 'requests':
				transactionId = body.transactionId;
				return json({
					requestId, expiresAt: new Date(now + 60_000).toISOString(),
					authorizationUrl: `https://app.lumbre.pro/integrations/lumbre-mcp?request=${requestId}`
				});
			case 'exchange/capabilities':
				return options.supported ? json({ deliveryId: true }) : json({ code: 'not_found' }, 404);
			case 'exchange':
				expect(body.transactionId).toBe(transactionId);
				if (options.supported) {
					const durable = await readStore();
					expect(durable).toContain(String(body.deliveryId));
					expect(durable).not.toContain(String(transactionId));
					expect(durable).not.toContain(secret);
					expect(durable).not.toContain(bearer);
				}
				if (options.lostExchanges-- > 0) throw new Error('respuesta perdida');
				return json(credential);
			case 'introspect':
				return json(options.revoked ? { active: false } : {
					active: true, credentialId, clientId, resource: OAUTH_RESOURCE, scope: OAUTH_SCOPE
				});
			case 'exchange/ack':
				if (options.lostAcks-- > 0) throw new Error('acuse perdido');
				return json({ acknowledged: true });
			case 'exchange/recover':
				if (options.pending) return json({ state: 'pending' }, 202);
				return options.revoked ? json({ code: 'credential_inactive' }, 410) : json(credential);
			case 'revoke':
				options.revoked = true;
				return json({ ok: true });
			default:
				throw new Error('ruta inesperada');
		}
	};
	const open = () => new OAuthService({ stateDir: dir, now: () => now, fetch: fetcher,
		backchannelSecret: secret, backchannelRetryDelaysMs: [] });
	const browser = new URL(`https://mcp.lumbre.pro/oauth/lumbre/callback?request=${requestId}&decision=approved`);
	const authorize = new URL('https://mcp.lumbre.pro/authorize');
	authorize.search = new URLSearchParams({
		response_type: 'code', client_id: clientId, redirect_uri: OAUTH_CALLBACK, scope: OAUTH_SCOPE,
		resource: OAUTH_RESOURCE, code_challenge_method: 'S256',
		code_challenge: createHash('sha256').update('v'.repeat(43)).digest('base64url'), state: 'synthetic-state'
	}).toString();
	const service = open();
	expect((await call(service, 'handleAuthorize', authorize)).status).toBe(302);
	return { service, browser, opts: options, open, fetches, readStore };
}

describe('entrega recuperable del canje de Lumbre', () => {
	it('repite la misma solicitud y toma el sobre antes de confirmar custodia', async () => {
		const h = await harness();
		h.opts.lostExchanges = 1;
		expect((await call(h.service, 'handleLumbreCallback', h.browser)).status).toBe(302);
		const attempted = h.fetches.filter((call) => call.path === 'exchange');
		expect(attempted[0]).toEqual(attempted[1]);
		expect(attempted[0]?.body.deliveryId).toMatch(/^[\da-f-]{36}$/);
		expect(h.fetches.map((call) => call.path)).toEqual([
			'requests', 'exchange/capabilities', 'exchange', 'exchange/capabilities', 'exchange', 'introspect', 'exchange/ack'
		]);
		const disk = await h.readStore();
		expect(disk).not.toContain(bearer);
		expect(JSON.parse(disk)).toMatchObject({ exchangeDeliveries: [], authorizationCodes: [{ credentialId }] });
		expect((await call(h.service, 'handleLumbreCallback', h.browser)).status).toBe(400);
		expect(h.fetches.filter((call) => call.path === 'exchange')).toHaveLength(2);
	});

	it('tras reiniciar recupera para revocar y conserva una entrega incierta', async () => {
		const h = await harness();
		h.opts.lostExchanges = 2;
		expect((await call(h.service, 'handleLumbreCallback', h.browser)).status).toBe(503);
		const saved = JSON.parse(await h.readStore());
		expect(saved.authorizationCodes).toEqual([]);
		expect(saved.exchangeDeliveries).toHaveLength(1);
		expect(saved.exchangeDeliveries[0].disposition).toBe('recover');

		h.opts.pending = true;
		const restarted = h.open();
		await restarted.ensureReady();
		expect(JSON.parse(await h.readStore()).exchangeDeliveries).toEqual(saved.exchangeDeliveries);
		h.opts.pending = false;
		await restarted.ensureReady();
		expect(h.fetches.slice(-3).map((call) => call.path)).toEqual(['exchange/recover', 'revoke', 'exchange/ack']);
		expect(JSON.parse(await h.readStore())).toMatchObject({ authorizationCodes: [], exchangeDeliveries: [] });
	});

	it('reanuda solo el ACK cuando el código ya quedó guardado', async () => {
		const h = await harness();
		h.opts.lostAcks = 1;
		expect((await call(h.service, 'handleLumbreCallback', h.browser)).status).toBe(302);
		expect(JSON.parse(await h.readStore())).toMatchObject({
			exchangeDeliveries: [{ disposition: 'acknowledge' }], authorizationCodes: [{ credentialId }]
		});
		await h.open().ensureReady();
		expect(h.fetches.slice(-2).map((call) => call.path)).toEqual(['exchange/ack', 'exchange/ack']);
		expect(JSON.parse(await h.readStore())).toMatchObject({ exchangeDeliveries: [], authorizationCodes: [{ credentialId }] });
	});

	it('una concesión revocada entre el canje y la introspección no emite código', async () => {
		const h = await harness();
		h.opts.revoked = true;
		expect((await call(h.service, 'handleLumbreCallback', h.browser)).status).toBe(502);
		await h.open().ensureReady();
		expect(h.fetches.at(-1)?.path).toBe('exchange/recover');
		expect(JSON.parse(await h.readStore())).toMatchObject({ authorizationCodes: [], exchangeDeliveries: [] });
	});

	it('un servidor anterior no recibe deliveryId ni repetición del canje', async () => {
		const h = await harness();
		h.opts.supported = false;
		h.opts.lostExchanges = 1;
		expect((await call(h.service, 'handleLumbreCallback', h.browser)).status).toBe(503);
		expect(h.fetches.filter((call) => call.path === 'exchange').map(({ body }) => Object.keys(body))).toEqual([
			['requestId', 'transactionId']
		]);
		expect(JSON.parse(await h.readStore()).exchangeDeliveries).toEqual([]);
	});
});
