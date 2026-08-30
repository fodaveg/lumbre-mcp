import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpApp } from './http.js';
import { OAuthService, OAUTH_CALLBACK, OAUTH_ISSUER, OAUTH_RESOURCE, OAUTH_RESOURCE_METADATA, OAUTH_SCOPE } from './oauth.js';

const CLIENT_ID = 'https://claude.ai/.well-known/oauth-client/lumbre';
const VERIFIER = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';
const CHALLENGE = createHash('sha256').update(VERIFIER, 'ascii').digest('base64url');
const UPSTREAM_TOKEN = 'token-lumbre-super-secreto';

const servers: Server[] = [];
const stateDirs: string[] = [];

async function listen(oauth: OAuthService): Promise<string> {
	const server = createHttpApp('https://app.lumbre.test', oauth).listen(0);
	servers.push(server);
	await new Promise<void>((resolve) => server.once('listening', resolve));
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
	} = {}
): typeof fetch {
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

async function authorize(baseUrl: string): Promise<{ code: string; state: string }> {
	const consent = await fetch(authorizeUrl(baseUrl));
	expect(consent.status).toBe(200);
	expect(consent.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
	expect(consent.headers.get('referrer-policy')).toBe('no-referrer');
	const page = await consent.text();
	expect(page).toContain('&lt;Claude &amp; Lumbre&gt;');
	expect(page).not.toContain(UPSTREAM_TOKEN);
	const transaction = page.match(/name="transaction" value="([^"]+)"/)?.[1];
	expect(transaction).toBeTruthy();

	const approved = await fetch(`${baseUrl}/authorize`, {
		method: 'POST',
		redirect: 'manual',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ transaction: transaction!, lumbre_token: UPSTREAM_TOKEN })
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
		const first = new OAuthService({ stateDir, fetch: oauthFetch(), now });
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
		const oauth = new OAuthService({ stateDir, fetch: oauthFetch() });
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

		const capped = new OAuthService({ stateDir, fetch: oauthFetch() });
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
		const restarted = new OAuthService({ stateDir, fetch: oauthFetch() });
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
		const first = fetch(authorizeUrl(concurrentBase));
		await started;
		expect((await fetch(authorizeUrl(concurrentBase))).status).toBe(429);
		releaseMetadata();
		expect((await first).status).toBe(200);

		let metadataCalls = 0;
		const cached = new OAuthService({
			stateDir: await newStateDir(),
			fetch: oauthFetch({ onMetadata: () => (metadataCalls += 1) }),
			publicLimits: { authorize: { concurrent: 2, requestsPerMinute: 1 } }
		});
		const cachedBase = await listen(cached);
		expect((await fetch(authorizeUrl(cachedBase))).status).toBe(200);
		// El segundo cae por rate-limit antes de disparar otro fetch CIMD.
		expect((await fetch(authorizeUrl(cachedBase))).status).toBe(429);
		expect(metadataCalls).toBe(1);

		let cacheHits = 0;
		const cacheOnly = new OAuthService({
			stateDir: await newStateDir(),
			fetch: oauthFetch({ onMetadata: () => (cacheHits += 1) }),
			publicLimits: { authorize: { concurrent: 2, requestsPerMinute: 10 } }
		});
		const cacheBase = await listen(cacheOnly);
		expect((await fetch(authorizeUrl(cacheBase))).status).toBe(200);
		expect((await fetch(authorizeUrl(cacheBase))).status).toBe(200);
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
			expect((await fetch(authorizeUrl(uncachedBase))).status).toBe(200);
			expect((await fetch(authorizeUrl(uncachedBase))).status).toBe(200);
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
		const dynamicFetch: typeof fetch = async (input) => {
			const clientId = String(input);
			if (!clientId.startsWith('https://claude.ai/')) throw new Error(`fetch inesperado: ${clientId}`);
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
		expect((await fetch(authorizeUrl(baseUrl))).status).toBe(200);
		expect((await fetch(authorizeUrl(baseUrl))).status).toBe(200);
		for (let index = 0; index < 128; index += 1) {
			const clientId = `https://claude.ai/oauth/client-${index}.json`;
			expect((await fetch(authorizeUrl(baseUrl, { client_id: clientId }))).status).toBe(200);
		}
		expect(metadataCalls).toBe(129);
		// CLIENT_ID fue la entrada LRU y ya debe volver a consultarse.
		expect((await fetch(authorizeUrl(baseUrl))).status).toBe(200);
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
		expect(steps).toEqual(['temporary-file-synced', 'store-renamed', 'state-directory-synced']);

		const sabotagedDir = await newStateDir();
		const sabotaged = new OAuthService({
			stateDir: sabotagedDir,
			fetch: oauthFetch(),
			persistenceStep: (step) => {
				if (step === 'temporary-file-synced') throw new Error('sabotaje antes de rename');
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
		await expect(stat(join(sabotagedDir, 'oauth-store.json'))).rejects.toMatchObject({ code: 'ENOENT' });
		expect((await readdir(sabotagedDir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
	});

	it('un código falla con PKCE incorrecto y queda consumido', async () => {
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
		expect((await fetch(authorizeUrl(baseUrl, { resource: `${OAUTH_ISSUER}/otro` }))).status).toBe(400);
		expect((await fetch(authorizeUrl(baseUrl, { scope: 'otro:scope' }))).status).toBe(400);
		expect((await fetch(authorizeUrl(baseUrl, { redirect_uri: 'https://claude.ai/otro-callback' }))).status).toBe(400);
		expect((await fetch(authorizeUrl(baseUrl, { client_id: 'https://evil.example/client.json' }))).status).toBe(400);
		expect((await fetch(authorizeUrl(baseUrl, { client_id: 'https://claude.ai/a/../client.json' }))).status).toBe(400);

		const redirectedBase = await listen(new OAuthService({
			stateDir: await newStateDir(),
			fetch: oauthFetch({ metadataStatus: 302, metadataLocation: 'https://claude.ai/otro' })
		}));
		expect((await fetch(authorizeUrl(redirectedBase))).status).toBe(400);

		const wrongContentBase = await listen(new OAuthService({
			stateDir: await newStateDir(),
			fetch: oauthFetch({ metadataContentType: 'text/application/json-evil' })
		}));
		expect((await fetch(authorizeUrl(wrongContentBase))).status).toBe(400);

		const oversizedBase = await listen(new OAuthService({
			stateDir: await newStateDir(),
			fetch: oauthFetch({ metadataBody: 'x'.repeat(64 * 1024 + 1) })
		}));
		expect((await fetch(authorizeUrl(oversizedBase))).status).toBe(400);
	});

	it('limita el body del formulario antes de procesar el token', async () => {
		const baseUrl = await listen(new OAuthService({ stateDir: await newStateDir(), fetch: oauthFetch() }));
		const response = await fetch(`${baseUrl}/authorize`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: `transaction=x&lumbre_token=${'a'.repeat(20_000)}`
		});
		expect(response.status).toBe(413);
	});
});
