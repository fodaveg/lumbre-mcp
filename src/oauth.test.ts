import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHttpApp } from './http.js';
import { OAuthService, OAUTH_CALLBACK, OAUTH_ISSUER, OAUTH_RESOURCE, OAUTH_RESOURCE_METADATA, OAUTH_SCOPE } from './oauth.js';

const CLIENT_ID = 'https://claude.ai/.well-known/oauth-client/lumbre';
const CODEX_CALLBACK_ID = 'codexCallback123';
const CODEX_CLIENT_ID = `https://chatgpt.com/oauth/codex/${CODEX_CALLBACK_ID}/client.json`;
const CODEX_REGISTERED_REDIRECT = `http://127.0.0.1/callback/${CODEX_CALLBACK_ID}`;
const CODEX_REDIRECT = `http://127.0.0.1:49152/callback/${CODEX_CALLBACK_ID}`;
const CODEX_STABLE_CLIENT_ID = 'https://chatgpt.com/oauth/codex/client.json';
const CODEX_STABLE_REGISTERED_REDIRECT = 'http://127.0.0.1/callback';
const CODEX_STABLE_REDIRECT = 'http://127.0.0.1:49153/callback';
const VERIFIER = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';
const CHALLENGE = createHash('sha256').update(VERIFIER, 'ascii').digest('base64url');
const UPSTREAM_TOKEN = 'a'.repeat(64);
const BACKCHANNEL_SECRET = 'secreto-backchannel-de-prueba-32-caracteres';
const CREDENTIAL_ID = '22222222-2222-4222-8222-222222222222';

const servers: Server[] = [];
const stateDirs: string[] = [];

async function listen(oauth: OAuthService): Promise<string> {
	const server = createHttpApp('https://app.lumbre.test', oauth).listen(0);
	servers.push(server);
	await new Promise<void>((resolve, reject) => {
		if (server.listening) resolve();
		else {
			server.once('listening', resolve);
			server.once('error', reject);
		}
	});
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function newStateDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'lumbre-mcp-oauth-'));
	stateDirs.push(dir);
	return dir;
}

async function getStatusWithHost(target: string, host: string): Promise<number> {
	const url = new URL(target);
	return await new Promise<number>((resolve, reject) => {
		const req = httpRequest(
			{ hostname: url.hostname, port: url.port, path: url.pathname, method: 'GET', headers: { host } },
			(response) => {
				response.resume();
				response.once('end', () => resolve(response.statusCode ?? 0));
			}
		);
		req.once('error', reject);
		req.end();
	});
}

function oauthFetch(
	overrides: {
		metadataStatus?: number;
		metadataLocation?: string;
		metadataContentType?: string;
		metadataBody?: string;
		metadataCacheControl?: string;
		onMetadata?: () => void;
		metadataGate?: Promise<void>;
		requestStatus?: number;
		requestBody?: unknown;
		exchangeStatus?: number;
		exchangeBody?: unknown | ((body: Record<string, unknown>) => unknown);
		exchangeError?: boolean;
		introspectStatus?: number;
		introspectBody?: unknown | ((body: Record<string, unknown>) => unknown);
		revokeStatus?: number;
		revokeBody?: unknown;
		onBackchannel?: (path: string, body: unknown) => void;
	} = {}
): typeof fetch {
	let requestCounter = 0;
	const transactions = new Map<string, string>();
	return async (input, init) => {
		const url = String(input);
		if (url === CLIENT_ID) {
			overrides.onMetadata?.();
			await overrides.metadataGate;
			return new Response(
				overrides.metadataBody ?? JSON.stringify({
					client_id: CLIENT_ID,
					client_name: '<Claude & Lumbre>',
					redirect_uris: [OAUTH_CALLBACK],
					token_endpoint_auth_method: 'none',
					grant_types: ['authorization_code', 'refresh_token'],
					response_types: ['code']
				}),
				{
					status: overrides.metadataStatus ?? 200,
					headers: {
						'content-type': overrides.metadataContentType ?? 'application/json',
						...(overrides.metadataCacheControl ? { 'cache-control': overrides.metadataCacheControl } : {}),
						...(overrides.metadataLocation ? { location: overrides.metadataLocation } : {})
					}
				}
			);
		}
		const backchannelPrefix = 'https://app.lumbre.pro/api/integrations/lumbre-mcp/';
		if (url.startsWith(backchannelPrefix)) {
			expect(init?.method).toBe('POST');
			expect(init?.redirect).toBe('error');
			expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${BACKCHANNEL_SECRET}`);
			const path = url.slice(backchannelPrefix.length);
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			overrides.onBackchannel?.(path, body);
			if (path === 'requests') {
				requestCounter += 1;
				const requestId = `10000000-0000-4000-8000-${String(requestCounter).padStart(12, '0')}`;
				transactions.set(requestId, String(body.transactionId));
				return new Response(JSON.stringify(overrides.requestBody ?? {
					authorizationUrl: `https://app.lumbre.pro/integrations/lumbre-mcp?request=${requestId}`,
					requestId,
					expiresAt: new Date(Date.now() + 10 * 60_000).toISOString()
				}), { status: overrides.requestStatus ?? 200, headers: { 'content-type': 'application/json' } });
			}
			if (path === 'exchange') {
				if (overrides.exchangeError) throw new Error('timeout simulado');
				const expectedTransaction = transactions.get(String(body.requestId));
				if (expectedTransaction) expect(body.transactionId).toBe(expectedTransaction);
				const exchangeBody = typeof overrides.exchangeBody === 'function'
					? overrides.exchangeBody(body)
					: overrides.exchangeBody;
				return new Response(JSON.stringify(exchangeBody ?? {
					credentialId: CREDENTIAL_ID,
					accessToken: UPSTREAM_TOKEN,
					tokenType: 'Bearer',
					resource: OAUTH_RESOURCE,
					scope: OAUTH_SCOPE
				}), { status: overrides.exchangeStatus ?? 200, headers: { 'content-type': 'application/json' } });
			}
			if (path === 'introspect') {
				const introspectBody = typeof overrides.introspectBody === 'function'
					? overrides.introspectBody(body)
					: overrides.introspectBody;
				return new Response(JSON.stringify(introspectBody ?? {
					active: true,
					credentialId: CREDENTIAL_ID,
					clientId: CLIENT_ID,
					resource: OAUTH_RESOURCE,
					scope: OAUTH_SCOPE
				}), { status: overrides.introspectStatus ?? 200, headers: { 'content-type': 'application/json' } });
			}
			if (path === 'revoke') {
				return new Response(JSON.stringify(overrides.revokeBody ?? { ok: true }), {
					status: overrides.revokeStatus ?? 200,
					headers: { 'content-type': 'application/json' }
				});
			}
		}
		if (url.startsWith('https://app.lumbre.test/api/tasks')) {
			expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${UPSTREAM_TOKEN}`);
			return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
		}
		throw new Error(`fetch inesperado: ${url}`);
	};
}

function authorizeUrl(baseUrl: string, overrides: Record<string, string> = {}): string {
	const params = new URLSearchParams({
		response_type: 'code',
		client_id: CLIENT_ID,
		redirect_uri: OAUTH_CALLBACK,
		scope: OAUTH_SCOPE,
		resource: OAUTH_RESOURCE,
		code_challenge: CHALLENGE,
		code_challenge_method: 'S256',
		state: 'estado con espacios & símbolos',
		...overrides
	});
	return `${baseUrl}/authorize?${params}`;
}

async function beginAuthorization(baseUrl: string, overrides: Record<string, string> = {}): Promise<Response> {
	return await fetch(authorizeUrl(baseUrl, overrides), { redirect: 'manual' });
}

async function authorize(baseUrl: string): Promise<{ code: string; state: string }> {
	const consent = await beginAuthorization(baseUrl);
	expect(consent.status).toBe(302);
	expect(consent.headers.get('referrer-policy')).toBe('no-referrer');
	const lumbre = new URL(consent.headers.get('location')!);
	expect(lumbre.origin).toBe('https://app.lumbre.pro');
	const requestId = lumbre.searchParams.get('request');
	expect(requestId).toBeTruthy();
	const approved = await fetch(`${baseUrl}/oauth/lumbre/callback?request=${requestId}&decision=approved`, {
		redirect: 'manual'
	});
	expect(approved.status).toBe(302);
	const callback = new URL(approved.headers.get('location')!);
	expect(`${callback.origin}${callback.pathname}`).toBe(OAUTH_CALLBACK);
	expect(callback.searchParams.get('iss')).toBe(OAUTH_ISSUER);
	expect(callback.searchParams.get('state')).toBe('estado con espacios & símbolos');
	return { code: callback.searchParams.get('code')!, state: callback.searchParams.get('state')! };
}

async function exchangeCode(baseUrl: string, code: string, verifier = VERIFIER): Promise<Record<string, unknown>> {
	const response = await fetch(`${baseUrl}/token`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'authorization_code',
			code,
			client_id: CLIENT_ID,
			redirect_uri: OAUTH_CALLBACK,
			resource: OAUTH_RESOURCE,
			code_verifier: verifier
		})
	});
	expect(response.status).toBe(200);
	return (await response.json()) as Record<string, unknown>;
}

async function refresh(baseUrl: string, token: string, overrides: Record<string, string> = {}): Promise<Response> {
	return await fetch(`${baseUrl}/token`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: token,
			client_id: CLIENT_ID,
			resource: OAUTH_RESOURCE,
			...overrides
		})
	});
}

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
	await Promise.all(stateDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

beforeEach(() => {
	process.env.LUMBRE_MCP_BACKCHANNEL_SECRET = BACKCHANNEL_SECRET;
	delete process.env.LUMBRE_APP_BASE_URL;
});

describe('OAuth 2.1 para claude.ai', () => {
	it('publica descubrimiento path-specific/alias y challenge RFC 9728', async () => {
		const baseUrl = await listen(new OAuthService({ stateDir: await newStateDir(), fetch: oauthFetch() }));
		for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
			const response = await fetch(`${baseUrl}${path}`);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				resource: OAUTH_RESOURCE,
				authorization_servers: [OAUTH_ISSUER],
				bearer_methods_supported: ['header'],
				scopes_supported: [OAUTH_SCOPE]
			});
		}
		const metadata = (await (await fetch(`${baseUrl}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
		expect(metadata.issuer).toBe(OAUTH_ISSUER);
		expect(metadata.client_id_metadata_document_supported).toBe(true);
		expect(metadata.registration_endpoint).toBeUndefined();
		expect(metadata.code_challenge_methods_supported).toEqual(['S256']);

		const noAuth = await fetch(`${baseUrl}/mcp`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
		});
		expect(noAuth.status).toBe(401);
		expect(noAuth.headers.get('www-authenticate')).toBe(
			`Bearer resource_metadata="${OAUTH_RESOURCE_METADATA}", scope="${OAUTH_SCOPE}"`
		);
		const invalidOAuth = await fetch(`${baseUrl}/mcp`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				accept: 'application/json, text/event-stream',
				authorization: 'Bearer lm_at_no-existe'
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
		});
		expect(invalidOAuth.status).toBe(401);
		expect(invalidOAuth.headers.get('www-authenticate')).toBe(noAuth.headers.get('www-authenticate'));
	});

	it('completa code+PKCE, cifra el token upstream y sobrevive a reinicio con rotación refresh', async () => {
		const stateDir = await newStateDir();
		let currentTime = 1_000_000;
		const now = () => currentTime;
		const first = new OAuthService({
			stateDir,
			fetch: oauthFetch({ requestBody: {
				authorizationUrl: 'https://app.lumbre.pro/integrations/lumbre-mcp?request=10000000-0000-4000-8000-000000000001',
				requestId: '10000000-0000-4000-8000-000000000001',
				expiresAt: new Date(currentTime + 10 * 60_000).toISOString()
			} }),
			now
		});
		const firstBase = await listen(first);
		const { code } = await authorize(firstBase);
		const tokens = await exchangeCode(firstBase, code);
		const access = String(tokens.access_token);
		const oldRefresh = String(tokens.refresh_token);
		expect(access).toMatch(/^lm_at_/);
		expect(oldRefresh).toMatch(/^lm_rt_/);
		expect(await first.resolveAccessToken(access)).toBe(UPSTREAM_TOKEN);
		const mcp = await fetch(`${firstBase}/mcp`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				accept: 'application/json, text/event-stream',
				authorization: `Bearer ${access}`
			},
			body: JSON.stringify({
				jsonrpc: '2.0', id: 10, method: 'initialize',
				params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'oauth-test', version: '1' } }
			})
		});
		expect(mcp.status).toBe(200);
		expect(((await mcp.json()) as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe('lumbre-mcp');
		const headerWins = await fetch(`${firstBase}/mcp/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				accept: 'application/json, text/event-stream',
				authorization: `Bearer ${access}`
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 11,
				method: 'tools/call',
				params: { name: 'list_tasks', arguments: { scope: 'today', notes: 'none' } }
			})
		});
		expect(headerWins.status).toBe(200);

		const storeText = await readFile(join(stateDir, 'oauth-store.json'), 'utf8');
		expect(storeText).not.toContain(UPSTREAM_TOKEN);
		expect(storeText).not.toContain(access);
		expect(storeText).not.toContain(oldRefresh);
		expect((await stat(join(stateDir, 'oauth-store.json'))).mode & 0o777).toBe(0o600);
		expect((await stat(join(stateDir, 'oauth.key'))).mode & 0o777).toBe(0o600);

		const second = new OAuthService({ stateDir, fetch: oauthFetch(), now });
		const secondBase = await listen(second);
		expect(await second.resolveAccessToken(access)).toBe(UPSTREAM_TOKEN);
		// La familia tiene una vigencia absoluta: rotar no prolonga ni el grant
		// ni sus tombstones de forma indefinida.
		currentTime += 29 * 24 * 60 * 60_000;
		expect(await second.resolveAccessToken(access)).toBeUndefined();
		const rotated = await refresh(secondBase, oldRefresh);
		expect(rotated.status).toBe(200);
		const rotatedTokens = (await rotated.json()) as { access_token: string; refresh_token: string };
		expect(rotatedTokens.refresh_token).not.toBe(oldRefresh);
		expect((await refresh(secondBase, oldRefresh, { resource: `${OAUTH_ISSUER}/otro` })).status).toBe(400);
		expect(await second.resolveAccessToken(rotatedTokens.access_token)).toBe(UPSTREAM_TOKEN);

		currentTime += 12 * 60 * 60_000;
		const third = new OAuthService({ stateDir, fetch: oauthFetch(), now });
		const thirdBase = await listen(third);
		// Replay después de reiniciar revoca la familia completa, incluido el
		// refresh vigente.
		expect((await refresh(thirdBase, oldRefresh)).status).toBe(400);
		expect(await third.resolveAccessToken(rotatedTokens.access_token)).toBeUndefined();
		expect((await refresh(thirdBase, rotatedTokens.refresh_token)).status).toBe(400);

		const fourth = new OAuthService({ stateDir, fetch: oauthFetch(), now });
		const fourthBase = await listen(fourth);
		expect((await refresh(fourthBase, rotatedTokens.refresh_token)).status).toBe(400);
	});

	it('persiste la transacción cifrada y callback/restart es one-shot; denied conserva state', async () => {
		const stateDir = await newStateDir();
		let transactionId = '';
		let exchangeCalls = 0;
		const fetchFn = oauthFetch({
			onBackchannel: (path, body) => {
				if (path === 'requests') transactionId = String((body as { transactionId: string }).transactionId);
				if (path === 'exchange') exchangeCalls += 1;
			}
		});
		const firstBase = await listen(new OAuthService({ stateDir, fetch: fetchFn }));
		const started = await beginAuthorization(firstBase);
		const requestId = new URL(started.headers.get('location')!).searchParams.get('request')!;
		const persisted = await readFile(join(stateDir, 'oauth-store.json'), 'utf8');
		expect(persisted).not.toContain(transactionId);
		expect(persisted).not.toContain(UPSTREAM_TOKEN);

		const restartedBase = await listen(new OAuthService({ stateDir, fetch: fetchFn }));
		const approved = await fetch(
			`${restartedBase}/oauth/lumbre/callback?request=${requestId}&decision=approved`,
			{ redirect: 'manual' }
		);
		expect(approved.status).toBe(302);
		expect(exchangeCalls).toBe(1);
		expect((await fetch(
			`${restartedBase}/oauth/lumbre/callback?request=${requestId}&decision=approved`,
			{ redirect: 'manual' }
		)).status).toBe(400);
		expect(exchangeCalls).toBe(1);

		const deniedStart = await beginAuthorization(restartedBase);
		const deniedId = new URL(deniedStart.headers.get('location')!).searchParams.get('request')!;
		const denied = await fetch(
			`${restartedBase}/oauth/lumbre/callback?request=${deniedId}&decision=denied`,
			{ redirect: 'manual' }
		);
		const claude = new URL(denied.headers.get('location')!);
		expect(claude.searchParams.get('error')).toBe('access_denied');
		expect(claude.searchParams.get('state')).toBe('estado con espacios & símbolos');
		expect(exchangeCalls).toBe(1);
	});

	it('callback alterado/caducado no canjea y no filtra secretos', async () => {
		let currentTime = Date.now();
		let exchangeCalls = 0;
		const fetchFn = oauthFetch({ onBackchannel: (path) => { if (path === 'exchange') exchangeCalls += 1; } });
		const baseUrl = await listen(new OAuthService({
			stateDir: await newStateDir(), fetch: fetchFn, now: () => currentTime
		}));
		const started = await beginAuthorization(baseUrl);
		const requestId = new URL(started.headers.get('location')!).searchParams.get('request')!;
		expect((await fetch(`${baseUrl}/oauth/lumbre/callback?request=${requestId}&decision=otro`)).status).toBe(400);
		currentTime += 10 * 60_000 + 1;
		const expired = await fetch(`${baseUrl}/oauth/lumbre/callback?request=${requestId}&decision=approved`);
		expect(expired.status).toBe(400);
		expect(await expired.text()).not.toContain(UPSTREAM_TOKEN);
		expect(expired.headers.get('location')).toBeNull();
		expect(exchangeCalls).toBe(0);
	});

	it('requests/exchange fallan cerrados ante redirect, 5xx y contrato alterado', async () => {
		const malicious = new OAuthService({
			stateDir: await newStateDir(),
			fetch: oauthFetch({ requestBody: {
				authorizationUrl: 'https://app.lumbre.pro/integrations/lumbre-mcp?request=11111111-1111-4111-8111-111111111111&extra=1',
				requestId: '11111111-1111-4111-8111-111111111111',
				expiresAt: new Date(Date.now() + 60_000).toISOString()
			} })
		});
		const maliciousBase = await listen(malicious);
		const rejected = await beginAuthorization(maliciousBase);
		expect(rejected.status).toBe(502);
		expect(rejected.headers.get('location')).toBeNull();

		const unavailableBase = await listen(new OAuthService({
			stateDir: await newStateDir(), fetch: oauthFetch({ requestStatus: 503 })
		}));
		expect((await beginAuthorization(unavailableBase)).status).toBe(503);

		const stateDir = await newStateDir();
		const mismatchFetch = oauthFetch({
			exchangeBody: {
				credentialId: CREDENTIAL_ID, accessToken: UPSTREAM_TOKEN, tokenType: 'Bearer',
				resource: `${OAUTH_ISSUER}/otro`, scope: OAUTH_SCOPE
			},
			revokeStatus: 503
		});
		const mismatchBase = await listen(new OAuthService({ stateDir, fetch: mismatchFetch }));
		const started = await beginAuthorization(mismatchBase);
		const requestId = new URL(started.headers.get('location')!).searchParams.get('request')!;
		const callback = await fetch(
			`${mismatchBase}/oauth/lumbre/callback?request=${requestId}&decision=approved`
		);
		expect(callback.status).toBe(502);
		const store = await readFile(join(stateDir, 'oauth-store.json'), 'utf8');
		expect(store).not.toContain(UPSTREAM_TOKEN);
		expect((JSON.parse(store) as { revocationOutbox: unknown[] }).revocationOutbox).toHaveLength(1);

		let ambiguousExchangeCalls = 0;
		const ambiguousBase = await listen(new OAuthService({
			stateDir: await newStateDir(),
			fetch: oauthFetch({
				exchangeError: true,
				onBackchannel: (path) => { if (path === 'exchange') ambiguousExchangeCalls += 1; }
			})
		}));
		const ambiguousStart = await beginAuthorization(ambiguousBase);
		const ambiguousId = new URL(ambiguousStart.headers.get('location')!).searchParams.get('request')!;
		expect((await fetch(
			`${ambiguousBase}/oauth/lumbre/callback?request=${ambiguousId}&decision=approved`
		)).status).toBe(503);
		expect((await fetch(
			`${ambiguousBase}/oauth/lumbre/callback?request=${ambiguousId}&decision=approved`
		)).status).toBe(400);
		expect(ambiguousExchangeCalls).toBe(1);
	});

	it('dos refresh concurrentes detectan replay y dejan toda la familia revocada', async () => {
		const stateDir = await newStateDir();
		const oauth = new OAuthService({ stateDir, fetch: oauthFetch() });
		const baseUrl = await listen(oauth);
		const { code } = await authorize(baseUrl);
		const initial = await exchangeCode(baseUrl, code);
		const responses = await Promise.all([
			refresh(baseUrl, String(initial.refresh_token)),
			refresh(baseUrl, String(initial.refresh_token))
		]);
		expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
		const successful = responses.find((response) => response.status === 200)!;
		const rotated = (await successful.json()) as { access_token: string; refresh_token: string };
		expect(await oauth.resolveAccessToken(rotated.access_token)).toBeUndefined();
		expect((await refresh(baseUrl, rotated.refresh_token)).status).toBe(400);
	});

	it('al cap exacto, rotación/revoke/replay eliminan familias y persisten tras reinicio', async () => {
		const stateDir = await newStateDir();
		let credentialCounter = 0;
		const credentials = new Map<string, string>();
		const contractFetch = oauthFetch({
			exchangeBody: () => {
				credentialCounter += 1;
				const credentialId = `22222222-2222-4222-8222-${String(credentialCounter).padStart(12, '0')}`;
				const accessToken = (credentialCounter + 10).toString(16).repeat(64);
				credentials.set(accessToken, credentialId);
				return { credentialId, accessToken, tokenType: 'Bearer', resource: OAUTH_RESOURCE, scope: OAUTH_SCOPE };
			},
			introspectBody: (body: Record<string, unknown>) => ({
				active: true,
				credentialId: credentials.get(String(body.accessToken)),
				clientId: CLIENT_ID,
				resource: OAUTH_RESOURCE,
				scope: OAUTH_SCOPE
			})
		});
		const oauth = new OAuthService({ stateDir, fetch: contractFetch });
		const baseUrl = await listen(oauth);
		const grants: Array<{ access: string; refresh: string }> = [];
		for (let index = 0; index < 3; index += 1) {
			const { code } = await authorize(baseUrl);
			const issued = await exchangeCode(baseUrl, code);
			grants.push({ access: String(issued.access_token), refresh: String(issued.refresh_token) });
		}
		const rotated = await refresh(baseUrl, grants[2]!.refresh);
		expect(rotated.status).toBe(200);
		const rotatedTokens = (await rotated.json()) as { access_token: string; refresh_token: string };

		const storePath = join(stateDir, 'oauth-store.json');
		const store = JSON.parse(await readFile(storePath, 'utf8')) as {
			grants: Array<{ familyId: string; familyExpiresAt: number; refreshExpiresAt: number }>;
			usedRefreshTokens: Array<{ hash: string; familyId: string; expiresAt: number }>;
		};
		expect(store.grants.every((grant) => grant.refreshExpiresAt === grant.familyExpiresAt)).toBe(true);
		const replayTombstone = store.usedRefreshTokens[0]!;
		store.usedRefreshTokens = [
			replayTombstone,
			...Array.from({ length: 9_999 }, (_, index) => ({
				hash: `cap-${index}`,
				familyId: `otra-familia-${index}`,
				expiresAt: replayTombstone.expiresAt
			}))
		];
		await writeFile(storePath, JSON.stringify(store), { mode: 0o600 });

		const capped = new OAuthService({ stateDir, fetch: contractFetch });
		const cappedBase = await listen(capped);
		// Rotar al cap revoca fail-safe en vez de responder 503 o dejar el grant.
		expect((await refresh(cappedBase, grants[0]!.refresh)).status).toBe(400);
		const revoked = await fetch(`${cappedBase}/revoke`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ token: grants[1]!.access, client_id: CLIENT_ID })
		});
		expect(revoked.status).toBe(200);
		expect((await refresh(cappedBase, grants[2]!.refresh)).status).toBe(400);
		expect((await refresh(cappedBase, rotatedTokens.refresh_token)).status).toBe(400);

		const persisted = JSON.parse(await readFile(storePath, 'utf8')) as { grants: unknown[] };
		expect(persisted.grants).toEqual([]);
		const restarted = new OAuthService({ stateDir, fetch: contractFetch });
		const restartedBase = await listen(restarted);
		expect((await refresh(restartedBase, grants[0]!.refresh)).status).toBe(400);
		expect((await refresh(restartedBase, rotatedTokens.refresh_token)).status).toBe(400);
		expect(await restarted.resolveAccessToken(grants[1]!.access)).toBeUndefined();
	});

	it('el cap por familia revoca fail-safe sin crecer ni bloquear la rotación', async () => {
		const stateDir = await newStateDir();
		const oauth = new OAuthService({ stateDir, fetch: oauthFetch() });
		const baseUrl = await listen(oauth);
		const { code } = await authorize(baseUrl);
		const issued = await exchangeCode(baseUrl, code);
		const storePath = join(stateDir, 'oauth-store.json');
		const store = JSON.parse(await readFile(storePath, 'utf8')) as {
			grants: Array<{ familyId: string; familyExpiresAt: number }>;
			usedRefreshTokens: Array<{ hash: string; familyId: string; expiresAt: number }>;
		};
		const grant = store.grants[0]!;
		store.usedRefreshTokens = Array.from({ length: 64 }, (_, index) => ({
			hash: `familia-cap-${index}`,
			familyId: grant.familyId,
			expiresAt: grant.familyExpiresAt
		}));
		await writeFile(storePath, JSON.stringify(store), { mode: 0o600 });

		const capped = new OAuthService({ stateDir, fetch: oauthFetch() });
		const cappedBase = await listen(capped);
		expect((await refresh(cappedBase, String(issued.refresh_token))).status).toBe(400);
		const persisted = JSON.parse(await readFile(storePath, 'utf8')) as {
			grants: unknown[];
			usedRefreshTokens: Array<{ familyId: string }>;
		};
		expect(persisted.grants).toEqual([]);
		expect(persisted.usedRefreshTokens.some((item) => item.familyId === grant.familyId)).toBe(false);
	});

	it('store v3 ya sobre cap se rechaza intacto y no pierde la credencial', async () => {
		const stateDir = await newStateDir();
		const firstBase = await listen(new OAuthService({ stateDir, fetch: oauthFetch() }));
		const { code } = await authorize(firstBase);
		await exchangeCode(firstBase, code);
		const storePath = join(stateDir, 'oauth-store.json');
		const store = JSON.parse(await readFile(storePath, 'utf8')) as {
			grants: Array<{ familyId: string; familyExpiresAt: number }>;
			usedRefreshTokens: Array<{ hash: string; familyId: string; expiresAt: number }>;
		};
		const grant = store.grants[0]!;
		store.usedRefreshTokens = Array.from({ length: 65 }, (_, index) => ({
			hash: `overflow-${index}`,
			familyId: grant.familyId,
			expiresAt: grant.familyExpiresAt
		}));
		const exactText = JSON.stringify(store);
		await writeFile(storePath, exactText, { mode: 0o600 });
		let backchannelCalls = 0;
		const corrupt = new OAuthService({
			stateDir,
			fetch: oauthFetch({ onBackchannel: () => { backchannelCalls += 1; } })
		});
		await expect(corrupt.ensureReady()).rejects.toThrow(/sobre el límite/);
		expect(backchannelCalls).toBe(0);
		expect(await readFile(storePath, 'utf8')).toBe(exactText);
	});

	it('revoke invalida access y refresh de la familia y persiste tras reinicio', async () => {
		const stateDir = await newStateDir();
		const oauth = new OAuthService({ stateDir, fetch: oauthFetch() });
		const baseUrl = await listen(oauth);
		const { code } = await authorize(baseUrl);
		const tokens = await exchangeCode(baseUrl, code);
		const access = String(tokens.access_token);
		const refreshToken = String(tokens.refresh_token);
		const response = await fetch(`${baseUrl}/revoke`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ token: access, client_id: CLIENT_ID })
		});
		expect(response.status).toBe(200);
		expect(await oauth.resolveAccessToken(access)).toBeUndefined();
		expect((await refresh(baseUrl, refreshToken)).status).toBe(400);

		const restarted = new OAuthService({ stateDir, fetch: oauthFetch() });
		const restartedBase = await listen(restarted);
		expect((await refresh(restartedBase, refreshToken)).status).toBe(400);
	});

	it('introspect inactive invalida familia y conserva revoke en outbox hasta ACK tras reinicio', async () => {
		const stateDir = await newStateDir();
		const healthy = new OAuthService({ stateDir, fetch: oauthFetch() });
		const healthyBase = await listen(healthy);
		const { code } = await authorize(healthyBase);
		const issued = await exchangeCode(healthyBase, code);

		const inactive = new OAuthService({
			stateDir,
			fetch: oauthFetch({ introspectBody: { active: false }, revokeStatus: 503 })
		});
		const inactiveBase = await listen(inactive);
		const rejected = await refresh(inactiveBase, String(issued.refresh_token));
		expect(rejected.status).toBe(400);
		expect((await rejected.json()) as { error: string }).toMatchObject({ error: 'invalid_grant' });
		const queued = JSON.parse(await readFile(join(stateDir, 'oauth-store.json'), 'utf8')) as {
			grants: unknown[]; revocationOutbox: unknown[];
		};
		expect(queued.grants).toEqual([]);
		expect(queued.revocationOutbox).toHaveLength(1);
		expect(JSON.stringify(queued)).not.toContain(UPSTREAM_TOKEN);

		const restarted = new OAuthService({ stateDir, fetch: oauthFetch() });
		await restarted.ensureReady();
		const drained = JSON.parse(await readFile(join(stateDir, 'oauth-store.json'), 'utf8')) as { revocationOutbox: unknown[] };
		expect(drained.revocationOutbox).toEqual([]);
	});

	it('introspect 5xx/malformed falla temporalmente sin rotar el refresh', async () => {
		const stateDir = await newStateDir();
		const firstBase = await listen(new OAuthService({ stateDir, fetch: oauthFetch() }));
		const { code } = await authorize(firstBase);
		const issued = await exchangeCode(firstBase, code);
		for (const brokenFetch of [
			oauthFetch({ introspectStatus: 503 }),
			oauthFetch({ introspectBody: { active: true } })
		]) {
			const brokenBase = await listen(new OAuthService({ stateDir, fetch: brokenFetch }));
			const failed = await refresh(brokenBase, String(issued.refresh_token));
			expect(failed.status).toBe(503);
			expect((await failed.json()) as { error: string }).toMatchObject({ error: 'temporarily_unavailable' });
		}
		const recoveredBase = await listen(new OAuthService({ stateDir, fetch: oauthFetch() }));
		expect((await refresh(recoveredBase, String(issued.refresh_token))).status).toBe(200);
	});

	it('refresh/revoke aleatorios no reescriben el store', async () => {
		const stateDir = await newStateDir();
		const oauth = new OAuthService({ stateDir, fetch: oauthFetch() });
		const baseUrl = await listen(oauth);
		const { code } = await authorize(baseUrl);
		await exchangeCode(baseUrl, code);
		const storePath = join(stateDir, 'oauth-store.json');
		const before = await readFile(storePath, 'utf8');
		const beforeMtime = (await stat(storePath)).mtimeMs;
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect((await refresh(baseUrl, 'lm_rt_no-existe')).status).toBe(400);
		const revoked = await fetch(`${baseUrl}/revoke`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ token: 'lm_at_no-existe', client_id: CLIENT_ID })
		});
		expect(revoked.status).toBe(200);
		expect(await readFile(storePath, 'utf8')).toBe(before);
		expect((await stat(storePath)).mtimeMs).toBe(beforeMtime);
	});

	it('refresh/revoke desconocidos no amplifican un outbox pendiente', async () => {
		const stateDir = await newStateDir();
		const firstBase = await listen(new OAuthService({ stateDir, fetch: oauthFetch() }));
		const { code } = await authorize(firstBase);
		const issued = await exchangeCode(firstBase, code);
		let revokeCalls = 0;
		const pendingFetch = oauthFetch({
			revokeStatus: 503,
			onBackchannel: (path) => { if (path === 'revoke') revokeCalls += 1; }
		});
		const pendingBase = await listen(new OAuthService({ stateDir, fetch: pendingFetch }));
		expect((await fetch(`${pendingBase}/revoke`, {
			method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ token: String(issued.access_token), client_id: CLIENT_ID })
		})).status).toBe(200);
		expect(revokeCalls).toBe(1);
		revokeCalls = 0;
		expect((await refresh(pendingBase, 'lm_rt_no-existe')).status).toBe(400);
		expect((await fetch(`${pendingBase}/revoke`, {
			method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ token: 'lm_at_no-existe', client_id: CLIENT_ID })
		})).status).toBe(200);
		expect(revokeCalls).toBe(0);
		const store = JSON.parse(await readFile(join(stateDir, 'oauth-store.json'), 'utf8')) as { revocationOutbox: unknown[] };
		expect(store.revocationOutbox).toHaveLength(1);
	});

	it('readiness reintenta como máximo una revocación pendiente por pasada', async () => {
		const stateDir = await newStateDir();
		const firstBase = await listen(new OAuthService({ stateDir, fetch: oauthFetch() }));
		const { code } = await authorize(firstBase);
		const access = String((await exchangeCode(firstBase, code)).access_token);
		const failingBase = await listen(new OAuthService({
			stateDir, fetch: oauthFetch({ revokeStatus: 503 })
		}));
		expect((await fetch(`${failingBase}/revoke`, {
			method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ token: access, client_id: CLIENT_ID })
		})).status).toBe(200);
		const storePath = join(stateDir, 'oauth-store.json');
		const queued = JSON.parse(await readFile(storePath, 'utf8')) as {
			revocationOutbox: Array<Record<string, unknown>>;
		};
		queued.revocationOutbox.push(
			{ ...queued.revocationOutbox[0]!, credentialId: '22222222-2222-4222-8222-222222222223' },
			{ ...queued.revocationOutbox[0]!, credentialId: '22222222-2222-4222-8222-222222222224' }
		);
		await writeFile(storePath, JSON.stringify(queued), { mode: 0o600 });
		let revokeCalls = 0;
		const restarted = new OAuthService({
			stateDir,
			fetch: oauthFetch({ onBackchannel: (path) => { if (path === 'revoke') revokeCalls += 1; } })
		});
		await restarted.ensureReady();
		expect(revokeCalls).toBe(1);
		expect((JSON.parse(await readFile(storePath, 'utf8')) as {
			revocationOutbox: unknown[];
		}).revocationOutbox).toHaveLength(2);
		await restarted.ensureReady();
		expect(revokeCalls).toBe(2);
	});

	it('limita concurrencia/rate y reutiliza la caché CIMD', async () => {
		let releaseMetadata!: () => void;
		let metadataStarted!: () => void;
		const gate = new Promise<void>((resolve) => (releaseMetadata = resolve));
		const started = new Promise<void>((resolve) => (metadataStarted = resolve));
		const concurrent = new OAuthService({
			stateDir: await newStateDir(),
			fetch: oauthFetch({ metadataGate: gate, onMetadata: metadataStarted }),
			publicLimits: { authorize: { concurrent: 1, requestsPerMinute: 10 } }
		});
		const concurrentBase = await listen(concurrent);
		const first = beginAuthorization(concurrentBase);
		await started;
		expect((await beginAuthorization(concurrentBase)).status).toBe(429);
		releaseMetadata();
		expect((await first).status).toBe(302);

		let metadataCalls = 0;
		const cached = new OAuthService({
			stateDir: await newStateDir(),
			fetch: oauthFetch({ onMetadata: () => (metadataCalls += 1) }),
			publicLimits: { authorize: { concurrent: 2, requestsPerMinute: 1 } }
		});
		const cachedBase = await listen(cached);
		expect((await beginAuthorization(cachedBase)).status).toBe(302);
		// El segundo cae por rate-limit antes de disparar otro fetch CIMD.
		expect((await beginAuthorization(cachedBase)).status).toBe(429);
		expect(metadataCalls).toBe(1);

		let cacheHits = 0;
		const cacheOnly = new OAuthService({
			stateDir: await newStateDir(),
			fetch: oauthFetch({ onMetadata: () => (cacheHits += 1) }),
			publicLimits: { authorize: { concurrent: 2, requestsPerMinute: 10 } }
		});
		const cacheBase = await listen(cacheOnly);
		expect((await beginAuthorization(cacheBase)).status).toBe(302);
		expect((await beginAuthorization(cacheBase)).status).toBe(302);
		expect(cacheHits).toBe(1);

		for (const directive of ['no-store', 'no-cache']) {
			let uncachedCalls = 0;
			const uncached = new OAuthService({
				stateDir: await newStateDir(),
				fetch: oauthFetch({
					metadataCacheControl: `${directive}, max-age=3600`,
					onMetadata: () => (uncachedCalls += 1)
				}),
				publicLimits: { authorize: { concurrent: 2, requestsPerMinute: 10 } }
			});
			const uncachedBase = await listen(uncached);
			expect((await beginAuthorization(uncachedBase)).status).toBe(302);
			expect((await beginAuthorization(uncachedBase)).status).toBe(302);
			expect(uncachedCalls).toBe(2);
		}

		const tokenAndRevoke = new OAuthService({
			stateDir: await newStateDir(),
			fetch: oauthFetch(),
			publicLimits: {
				token: { concurrent: 2, requestsPerMinute: 1 },
				revoke: { concurrent: 2, requestsPerMinute: 1 }
			}
		});
		const limitedBase = await listen(tokenAndRevoke);
		expect((await refresh(limitedBase, 'lm_rt_no-existe')).status).toBe(400);
		expect((await refresh(limitedBase, 'lm_rt_otro')).status).toBe(429);
		const revoke = (token: string) => fetch(`${limitedBase}/revoke`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ token, client_id: CLIENT_ID })
		});
		expect((await revoke('lm_at_no-existe')).status).toBe(200);
		expect((await revoke('lm_at_otro')).status).toBe(429);
	});

	it('acota la caché CIMD y expulsa la entrada menos reciente', async () => {
		let metadataCalls = 0;
		const backchannelFetch = oauthFetch();
		const dynamicFetch: typeof fetch = async (input, init) => {
			const clientId = String(input);
			if (!clientId.startsWith('https://claude.ai/')) return await backchannelFetch(input, init);
			metadataCalls += 1;
			return new Response(
				JSON.stringify({
					client_id: clientId,
					client_name: 'Claude test',
					redirect_uris: [OAUTH_CALLBACK],
					token_endpoint_auth_method: 'none'
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			);
		};
		const oauth = new OAuthService({
			stateDir: await newStateDir(),
			fetch: dynamicFetch,
			publicLimits: { authorize: { concurrent: 2, requestsPerMinute: 300 } }
		});
		const baseUrl = await listen(oauth);
		expect((await beginAuthorization(baseUrl)).status).toBe(302);
		expect((await beginAuthorization(baseUrl)).status).toBe(302);
		for (let index = 0; index < 128; index += 1) {
			const clientId = `https://claude.ai/oauth/client-${index}.json`;
			expect((await beginAuthorization(baseUrl, { client_id: clientId })).status).toBe(302);
		}
		expect(metadataCalls).toBe(129);
		// CLIENT_ID fue la entrada LRU y ya debe volver a consultarse.
		expect((await beginAuthorization(baseUrl)).status).toBe(302);
		expect(metadataCalls).toBe(130);
	});

	it('store sin clave o con clave incoherente falla cerrado en readiness', async () => {
		const stateDir = await newStateDir();
		const first = new OAuthService({ stateDir, fetch: oauthFetch() });
		const baseUrl = await listen(first);
		const { code } = await authorize(baseUrl);
		await exchangeCode(baseUrl, code);
		const storePath = join(stateDir, 'oauth-store.json');
		const originalStore = await readFile(storePath, 'utf8');
		const corrupted = JSON.parse(originalStore) as {
			grants: Array<{ familyId: string; refreshHash: string; refreshExpiresAt: number }>;
			usedRefreshTokens: Array<{ hash: string; familyId: string; expiresAt: number }>;
		};
		corrupted.usedRefreshTokens.push({
			hash: corrupted.grants[0]!.refreshHash,
			familyId: corrupted.grants[0]!.familyId,
			expiresAt: corrupted.grants[0]!.refreshExpiresAt
		});
		await writeFile(storePath, JSON.stringify(corrupted), { mode: 0o600 });
		await expect(new OAuthService({ stateDir, fetch: oauthFetch() }).ensureReady()).rejects.toThrow(/incoherente/);
		await writeFile(storePath, originalStore, { mode: 0o600 });

		await unlink(join(stateDir, 'oauth.key'));
		const missingKey = new OAuthService({ stateDir, fetch: oauthFetch() });
		await expect(missingKey.ensureReady()).rejects.toThrow(/clave/);
		const missingBase = await listen(missingKey);
		expect((await fetch(`${missingBase}/readyz`)).status).toBe(503);
		await expect(stat(join(stateDir, 'oauth.key'))).rejects.toMatchObject({ code: 'ENOENT' });

		await writeFile(join(stateDir, 'oauth.key'), Buffer.alloc(32, 7).toString('base64url'), { mode: 0o600 });
		const wrongKey = new OAuthService({ stateDir, fetch: oauthFetch() });
		await expect(wrongKey.ensureReady()).rejects.toThrow();
		const wrongBase = await listen(wrongKey);
		expect((await fetch(`${wrongBase}/readyz`)).status).toBe(503);
	});

	it('readiness falla cerrado con secreto backchannel ausente o corto', async () => {
		delete process.env.LUMBRE_MCP_BACKCHANNEL_SECRET;
		await expect(new OAuthService({ stateDir: await newStateDir(), fetch: oauthFetch() }).ensureReady()).rejects.toThrow(/SECRET/);
		await expect(new OAuthService({
			stateDir: await newStateDir(), fetch: oauthFetch(), backchannelSecret: 'corto'
		}).ensureReady()).rejects.toThrow(/SECRET/);
		process.env.LUMBRE_MCP_BACKCHANNEL_SECRET = BACKCHANNEL_SECRET;
	});

	it('store provisional v2 se rechaza intacto y nunca toca el backchannel', async () => {
		const stateDir = await newStateDir();
		const firstBase = await listen(new OAuthService({ stateDir, fetch: oauthFetch() }));
		const { code } = await authorize(firstBase);
		const issued = await exchangeCode(firstBase, code);
		const storePath = join(stateDir, 'oauth-store.json');
		const provisional = JSON.parse(await readFile(storePath, 'utf8')) as {
			version: number;
			grants: Array<Record<string, unknown>>;
		};
		provisional.version = 2;
		for (const grant of provisional.grants) {
			delete grant.provider;
			delete grant.credentialId;
		}
		const exactText = JSON.stringify(provisional);
		await writeFile(storePath, exactText, { mode: 0o600 });
		let backchannelCalls = 0;
		const legacy = new OAuthService({
			stateDir,
			fetch: oauthFetch({ onBackchannel: () => { backchannelCalls += 1; } })
		});
		await expect(legacy.ensureReady()).rejects.toThrow(/provisional v1\/v2/);
		expect(await legacy.resolveAccessToken(String(issued.access_token))).toBeUndefined();
		expect(backchannelCalls).toBe(0);
		expect(await readFile(storePath, 'utf8')).toBe(exactText);
	});

	it('store v3 exige todas sus colecciones y falla cerrado sin reescribir ni llamar al backchannel', async () => {
		const complete = {
			version: 3,
			grants: [],
			usedRefreshTokens: [],
			authorizationRequests: [],
			authorizationCodes: [],
			revocationOutbox: []
		};
		for (const missing of [
			'grants', 'usedRefreshTokens', 'authorizationRequests', 'authorizationCodes', 'revocationOutbox'
		] as const) {
			const stateDir = await newStateDir();
			await new OAuthService({ stateDir, fetch: oauthFetch() }).ensureReady();
			const storePath = join(stateDir, 'oauth-store.json');
			const incompleteStore: Partial<typeof complete> = structuredClone(complete);
			delete incompleteStore[missing];
			const exactText = JSON.stringify(incompleteStore);
			await writeFile(storePath, exactText, { mode: 0o600 });
			let backchannelCalls = 0;
			const incomplete = new OAuthService({
				stateDir,
				fetch: oauthFetch({ onBackchannel: () => { backchannelCalls += 1; } })
			});
			await expect(incomplete.ensureReady(), missing).rejects.toThrow(/store OAuth inválido/);
			expect(backchannelCalls, missing).toBe(0);
			expect(await readFile(storePath, 'utf8'), missing).toBe(exactText);
		}
	});

	it('store v3 rechaza credenciales terminales coexistentes, IDs y hashes duplicados sin mutarlo', async () => {
		const cases: Array<{
			name: string;
			mutate: (store: Record<string, Array<Record<string, unknown>>>, savedCode: Record<string, unknown>) => void;
		}> = [
			{
				name: 'grant+code',
				mutate: (store, savedCode) => { store.authorizationCodes!.push(savedCode); }
			},
			{
				name: 'grant+outbox',
				mutate: (store) => {
					const grant = store.grants![0]!;
					store.revocationOutbox!.push({
						provider: grant.provider,
						credentialId: grant.credentialId,
						clientId: grant.clientId,
						resource: grant.resource,
						scope: grant.scope,
						upstream: grant.upstream
					});
				}
			},
			{
				name: 'code+outbox',
				mutate: (store, savedCode) => {
					store.grants = [];
					store.authorizationCodes!.push(savedCode);
					store.revocationOutbox!.push({
						provider: 'lumbre-web',
						credentialId: savedCode.credentialId,
						clientId: savedCode.clientId,
						resource: savedCode.resource,
						scope: savedCode.scope,
						upstream: savedCode.upstream
					});
				}
			},
			{
				name: 'hash code+access',
				mutate: (store, savedCode) => {
					store.authorizationCodes!.push({
						...savedCode,
						credentialId: '33333333-3333-4333-8333-333333333333',
						codeHash: store.grants![0]!.accessHash
					});
				}
			}
		];
		for (const testCase of cases) {
			const stateDir = await newStateDir();
			const baseUrl = await listen(new OAuthService({ stateDir, fetch: oauthFetch() }));
			const { code } = await authorize(baseUrl);
			const storePath = join(stateDir, 'oauth-store.json');
			const codeStore = JSON.parse(await readFile(storePath, 'utf8')) as Record<string, Array<Record<string, unknown>>>;
			const savedCode = structuredClone(codeStore.authorizationCodes![0]!);
			await exchangeCode(baseUrl, code);
			const store = JSON.parse(await readFile(storePath, 'utf8')) as Record<string, Array<Record<string, unknown>>>;
			testCase.mutate(store, savedCode);
			const exactText = JSON.stringify(store);
			await writeFile(storePath, exactText, { mode: 0o600 });
			let backchannelCalls = 0;
			const corrupted = new OAuthService({
				stateDir,
				fetch: oauthFetch({ onBackchannel: () => { backchannelCalls += 1; } })
			});
			await expect(corrupted.ensureReady(), testCase.name).rejects.toThrow(/store OAuth incoherente/);
			expect(backchannelCalls, testCase.name).toBe(0);
			expect(await readFile(storePath, 'utf8'), testCase.name).toBe(exactText);
		}

		const pendingDir = await newStateDir();
		const pendingBase = await listen(new OAuthService({ stateDir: pendingDir, fetch: oauthFetch() }));
		await beginAuthorization(pendingBase);
		const pendingPath = join(pendingDir, 'oauth-store.json');
		const pendingStore = JSON.parse(await readFile(pendingPath, 'utf8')) as {
			authorizationRequests: Array<Record<string, unknown>>;
		};
		pendingStore.authorizationRequests.push(structuredClone(pendingStore.authorizationRequests[0]!));
		const exactPending = JSON.stringify(pendingStore);
		await writeFile(pendingPath, exactPending, { mode: 0o600 });
		let pendingCalls = 0;
		await expect(new OAuthService({
			stateDir: pendingDir,
			fetch: oauthFetch({ onBackchannel: () => { pendingCalls += 1; } })
		}).ensureReady()).rejects.toThrow(/store OAuth incoherente/);
		expect(pendingCalls).toBe(0);
		expect(await readFile(pendingPath, 'utf8')).toBe(exactPending);
	});

	it('normaliza una sola vez el nombre CIMD antes de enviarlo y persistirlo', async () => {
		const rawName = `  ${'C'.repeat(130)}  `;
		const expectedName = 'C'.repeat(120);
		let sentName: unknown;
		const stateDir = await newStateDir();
		const baseUrl = await listen(new OAuthService({
			stateDir,
			fetch: oauthFetch({
				metadataBody: JSON.stringify({
					client_id: CLIENT_ID,
					client_name: rawName,
					redirect_uris: [OAUTH_CALLBACK],
					token_endpoint_auth_method: 'none',
					grant_types: ['authorization_code', 'refresh_token'],
					response_types: ['code']
				}),
				onBackchannel: (path, body) => {
					if (path === 'requests') sentName = (body as Record<string, unknown>).clientName;
				}
			})
		}));
		expect((await beginAuthorization(baseUrl)).status).toBe(302);
		expect(sentName).toBe(expectedName);
		const store = JSON.parse(await readFile(join(stateDir, 'oauth-store.json'), 'utf8')) as {
			authorizationRequests: Array<{ clientName: string }>;
		};
		expect(store.authorizationRequests[0]!.clientName).toBe(expectedName);
		await expect(new OAuthService({ stateDir, fetch: oauthFetch() }).ensureReady()).resolves.toBeUndefined();
	});

	it('readiness rechaza redirects alterados en pending/code sin tocar backchannel', async () => {
		for (const kind of ['pending', 'code'] as const) {
			const stateDir = await newStateDir();
			const baseUrl = await listen(new OAuthService({ stateDir, fetch: oauthFetch() }));
			if (kind === 'pending') await beginAuthorization(baseUrl);
			else await authorize(baseUrl);
			const storePath = join(stateDir, 'oauth-store.json');
			const store = JSON.parse(await readFile(storePath, 'utf8')) as {
				authorizationRequests: Array<{ redirectUri: string }>;
				authorizationCodes: Array<{ redirectUri: string }>;
			};
			if (kind === 'pending') store.authorizationRequests[0]!.redirectUri = 'https://evil.example/callback';
			else store.authorizationCodes[0]!.redirectUri = 'https://evil.example/callback';
			await writeFile(storePath, JSON.stringify(store), { mode: 0o600 });
			let backchannelCalls = 0;
			const tampered = new OAuthService({
				stateDir,
				fetch: oauthFetch({ onBackchannel: () => { backchannelCalls += 1; } })
			});
			await expect(tampered.ensureReady()).rejects.toThrow(/autorización OAuth inválida|código OAuth inválido/);
			expect(backchannelCalls).toBe(0);
		}
	});

	it('readyz valida Host y deduplica/cachea comprobaciones concurrentes', async () => {
		let currentTime = 10_000;
		const oauth = new OAuthService({ stateDir: await newStateDir(), fetch: oauthFetch(), now: () => currentTime });
		const readySpy = vi.spyOn(oauth, 'ensureReady');
		const baseUrl = await listen(oauth);
		expect(await getStatusWithHost(`${baseUrl}/readyz`, 'evil.example')).toBe(403);
		expect(readySpy).not.toHaveBeenCalled();

		const concurrent = await Promise.all(Array.from({ length: 20 }, () => fetch(`${baseUrl}/readyz`)));
		expect(concurrent.every((response) => response.status === 200)).toBe(true);
		expect(readySpy).toHaveBeenCalledTimes(1);
		expect((await fetch(`${baseUrl}/readyz`)).status).toBe(200);
		expect(readySpy).toHaveBeenCalledTimes(1);

		currentTime += 5_001;
		expect((await fetch(`${baseUrl}/readyz`)).status).toBe(200);
		expect(readySpy).toHaveBeenCalledTimes(2);
	});

	it('persiste en orden flush temporal, rename y flush del directorio; aborta antes de rename', async () => {
		const steps: string[] = [];
		const stateDir = await newStateDir();
		const oauth = new OAuthService({
			stateDir,
			fetch: oauthFetch(),
			persistenceStep: (step) => {
				steps.push(step);
			}
		});
		const baseUrl = await listen(oauth);
		const { code } = await authorize(baseUrl);
		await exchangeCode(baseUrl, code);
		expect(steps.length).toBeGreaterThanOrEqual(3);
		expect(steps.length % 3).toBe(0);
		for (let index = 0; index < steps.length; index += 3) {
			expect(steps.slice(index, index + 3)).toEqual([
				'temporary-file-synced', 'store-renamed', 'state-directory-synced'
			]);
		}

		const sabotagedDir = await newStateDir();
		let temporarySyncs = 0;
		const sabotaged = new OAuthService({
			stateDir: sabotagedDir,
			fetch: oauthFetch(),
			persistenceStep: (step) => {
				if (step === 'temporary-file-synced' && ++temporarySyncs === 4) {
					throw new Error('sabotaje antes de rename');
				}
			}
		});
		const sabotagedBase = await listen(sabotaged);
		const pending = await authorize(sabotagedBase);
		const failed = await fetch(`${sabotagedBase}/token`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'authorization_code', code: pending.code, client_id: CLIENT_ID,
				redirect_uri: OAUTH_CALLBACK, resource: OAUTH_RESOURCE, code_verifier: VERIFIER
			})
		});
		expect(failed.status).toBe(500);
		const survivingStore = await readFile(join(sabotagedDir, 'oauth-store.json'), 'utf8');
		expect(survivingStore).not.toContain(UPSTREAM_TOKEN);
		expect((await readdir(sabotagedDir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
	});

	it('PKCE incorrecto no consume ni revoca; el correcto canjea una sola vez', async () => {
		const baseUrl = await listen(new OAuthService({ stateDir: await newStateDir(), fetch: oauthFetch() }));
		const { code } = await authorize(baseUrl);
		const invalid = await fetch(`${baseUrl}/token`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'authorization_code', code, client_id: CLIENT_ID, redirect_uri: OAUTH_CALLBACK,
				resource: OAUTH_RESOURCE, code_verifier: 'x'.repeat(43)
			})
		});
		expect(invalid.status).toBe(400);
		const correct = await fetch(`${baseUrl}/token`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'authorization_code', code, client_id: CLIENT_ID, redirect_uri: OAUTH_CALLBACK,
				resource: OAUTH_RESOURCE, code_verifier: VERIFIER
			})
		});
		expect(correct.status).toBe(200);
		const replay = await fetch(`${baseUrl}/token`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'authorization_code', code, client_id: CLIENT_ID, redirect_uri: OAUTH_CALLBACK,
				resource: OAUTH_RESOURCE, code_verifier: VERIFIER
			})
		});
		expect(replay.status).toBe(400);
	});

	it('rechaza resource distinto, client_id fuera de claude.ai y redirects de CIMD', async () => {
		const baseUrl = await listen(new OAuthService({ stateDir: await newStateDir(), fetch: oauthFetch() }));
		expect((await beginAuthorization(baseUrl, { resource: `${OAUTH_ISSUER}/otro` })).status).toBe(400);
		expect((await beginAuthorization(baseUrl, { scope: 'otro:scope' })).status).toBe(400);
		expect((await beginAuthorization(baseUrl, { redirect_uri: 'https://claude.ai/otro-callback' })).status).toBe(400);
		expect((await beginAuthorization(baseUrl, { client_id: 'https://evil.example/client.json' })).status).toBe(400);
		expect((await beginAuthorization(baseUrl, { client_id: 'https://claude.ai/a/../client.json' })).status).toBe(400);

		const redirectedBase = await listen(new OAuthService({
			stateDir: await newStateDir(),
			fetch: oauthFetch({ metadataStatus: 302, metadataLocation: 'https://claude.ai/otro' })
		}));
		expect((await beginAuthorization(redirectedBase)).status).toBe(400);

		const wrongContentBase = await listen(new OAuthService({
			stateDir: await newStateDir(),
			fetch: oauthFetch({ metadataContentType: 'text/application/json-evil' })
		}));
		expect((await beginAuthorization(wrongContentBase)).status).toBe(400);

		const oversizedBase = await listen(new OAuthService({
			stateDir: await newStateDir(),
			fetch: oauthFetch({ metadataBody: 'x'.repeat(64 * 1024 + 1) })
		}));
		expect((await beginAuthorization(oversizedBase)).status).toBe(400);
	});

	it('acepta el CIMD de Codex con el puerto loopback efímero registrado por path', async () => {
		const fallback = oauthFetch();
		const codexFetch: typeof fetch = async (input, init) => {
			if (String(input) === CODEX_CLIENT_ID) {
				return new Response(JSON.stringify({
					client_id: CODEX_CLIENT_ID,
					client_name: 'Codex',
					redirect_uris: [CODEX_REGISTERED_REDIRECT],
					token_endpoint_auth_method: 'none',
					grant_types: ['authorization_code', 'refresh_token'],
					response_types: ['code']
				}), { status: 200, headers: { 'content-type': 'application/json' } });
			}
			return await fallback(input, init);
		};
		const baseUrl = await listen(new OAuthService({ stateDir: await newStateDir(), fetch: codexFetch }));
		const accepted = await beginAuthorization(baseUrl, { client_id: CODEX_CLIENT_ID, redirect_uri: CODEX_REDIRECT });
		expect(accepted.status).toBe(302);
		expect(accepted.headers.get('location')).toMatch(/^https:\/\/app\.lumbre\.pro\/integrations\/lumbre-mcp\?request=/);

		expect((await beginAuthorization(baseUrl, {
			client_id: CODEX_CLIENT_ID,
			redirect_uri: `http://localhost:49152/callback/${CODEX_CALLBACK_ID}`
		})).status).toBe(400);
		expect((await beginAuthorization(baseUrl, {
			client_id: CODEX_CLIENT_ID,
			redirect_uri: 'https://evil.example/callback'
		})).status).toBe(400);
	});

	it('acepta el CIMD estable issuer-bound que usa Codex 0.151', async () => {
		const fallback = oauthFetch({
			introspectBody: {
				active: true,
				credentialId: CREDENTIAL_ID,
				clientId: CODEX_STABLE_CLIENT_ID,
				resource: OAUTH_RESOURCE,
				scope: OAUTH_SCOPE
			}
		});
		const codexFetch: typeof fetch = async (input, init) => {
			if (String(input) === CODEX_STABLE_CLIENT_ID) {
				return new Response(JSON.stringify({
					client_id: CODEX_STABLE_CLIENT_ID,
					client_name: 'Codex',
					redirect_uris: [CODEX_STABLE_REGISTERED_REDIRECT],
					token_endpoint_auth_method: 'none',
					grant_types: ['authorization_code', 'refresh_token'],
					response_types: ['code']
				}), { status: 200, headers: { 'content-type': 'application/json' } });
			}
			return await fallback(input, init);
		};
		const stateDir = await newStateDir();
		const baseUrl = await listen(new OAuthService({ stateDir, fetch: codexFetch }));
		const accepted = await beginAuthorization(baseUrl, {
			client_id: CODEX_STABLE_CLIENT_ID,
			redirect_uri: CODEX_STABLE_REDIRECT
		});
		expect(accepted.status).toBe(302);
		expect(accepted.headers.get('location')).toMatch(/^https:\/\/app\.lumbre\.pro\/integrations\/lumbre-mcp\?request=/);
		const requestId = new URL(accepted.headers.get('location')!).searchParams.get('request');
		const approved = await fetch(`${baseUrl}/oauth/lumbre/callback?request=${requestId}&decision=approved`, {
			redirect: 'manual'
		});
		expect(approved.status).toBe(302);
		const callback = new URL(approved.headers.get('location')!);
		expect(`${callback.origin}${callback.pathname}`).toBe(CODEX_STABLE_REDIRECT);
		expect(callback.searchParams.get('iss')).toBe(OAUTH_ISSUER);
		const token = await fetch(`${baseUrl}/token`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'authorization_code',
				code: callback.searchParams.get('code')!,
				client_id: CODEX_STABLE_CLIENT_ID,
				redirect_uri: CODEX_STABLE_REDIRECT,
				resource: OAUTH_RESOURCE,
				code_verifier: VERIFIER
			})
		});
		expect(token.status).toBe(200);
		await expect(new OAuthService({ stateDir, fetch: codexFetch }).ensureReady()).resolves.toBeUndefined();
	});

	it('authorize no acepta formulario ni entrada de tokens en el navegador', async () => {
		const baseUrl = await listen(new OAuthService({ stateDir: await newStateDir(), fetch: oauthFetch() }));
		const response = await fetch(`${baseUrl}/authorize`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: `token=${'a'.repeat(20_000)}`
		});
		expect(response.status).toBe(405);
		expect(await response.text()).not.toContain(UPSTREAM_TOKEN);
	});
});
