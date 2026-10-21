import { createHash, createHmac, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHttpApp } from './http.js';
import { BackchannelError } from './lumbre-oauth-backchannel.js';
import { OAUTH_CALLBACK, OAUTH_ISSUER, OAUTH_RESOURCE, OAUTH_SCOPE, OAuthService } from './oauth.js';
import { SUMEGO_PERSON_MESSAGES, exchangeFailure } from './sumego-messages.js';
import {
	BACKCHANNEL_LOGOUT_EVENT,
	OidcError,
	SUMEGO_CALLBACK,
	SumegoOidcClient,
	loginConfigFromEnv,
	type LoginConfig
} from './sumego-oidc.js';

/**
 * Login con Sumego: el cliente OIDC contra un IdP simulado que firma ES256
 * con una clave generada aquí, y el flujo entero por HTTP contra el relé
 * (`/authorize` → Sumego → `/oauth/sumego/callback` → consentimiento →
 * `/token`), con Lumbre simulada también. Reloj falso en todo: nada espera.
 */

const ISSUER = 'https://id.lumbre.pro';
const CLIENT_ID = 'lumbre-mcp';
const CLIENT_SECRET = 'secreto-de-cliente-sumego-de-prueba';
const BACKCHANNEL_SECRET = 'secreto-backchannel-de-prueba-32-caracteres';
const CLAUDE_CLIENT = 'https://claude.ai/.well-known/oauth-client/lumbre';
const VERIFIER = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';
const CHALLENGE = createHash('sha256').update(VERIFIER, 'ascii').digest('base64url');
const START = Date.parse('2026-10-21T10:00:00.000Z');
const SUMEGO_LOGIN: LoginConfig = {
	provider: 'sumego',
	sumego: { issuer: ISSUER, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }
};
const LUMBRE_LOGIN: LoginConfig = { ...SUMEGO_LOGIN, provider: 'lumbre' };

interface SigningKey {
	kid: string;
	privateKey: KeyObject;
	jwk: Record<string, unknown>;
}

function signingKey(kid: string): SigningKey {
	const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
	return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'ES256' } };
}

function b64json(value: unknown): string {
	return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function jws(payload: Record<string, unknown>, key: SigningKey, header: Record<string, unknown> = { alg: 'ES256', kid: key.kid }): string {
	const signed = `${b64json(header)}.${b64json(payload)}`;
	const signature = sign('sha256', Buffer.from(signed), { key: key.privateKey, dsaEncoding: 'ieee-p1363' });
	return `${signed}.${signature.toString('base64url')}`;
}

interface Person {
	sub: string;
	sid: string;
	email?: string;
}

const ANA: Person = { sub: 'sub-ana', sid: 'sid-ana-1', email: 'ana@example.com' };

/**
 * IdP simulado: discovery, JWKS y token endpoint en el origen del issuer.
 * `issueCode` hace de «la persona entra en Sumego»: lee `nonce` y
 * `code_challenge` de la URL de `/authorize` y devuelve un `code`.
 */
class FakeSumego {
	readonly key = signingKey('k1');
	jwks: Record<string, unknown>[] = [this.key.jwk];
	discoveryIssuer = ISSUER;
	down = false;
	/** Estado HTTP del JWKS (500 = JWKS caído con el resto de Sumego en pie). */
	jwksStatus = 200;
	tokenStatus = 200;
	/** Estado del canje de un refresh (`grant_type=refresh_token`). */
	refreshStatus = 200;
	/** Publica `revocation_endpoint` en el discovery. */
	revocationEndpoint = true;
	/** Sustituye los claims (o el JWT entero) del siguiente ID token. */
	nextIdToken?: (claims: Record<string, unknown>) => string;
	/** Se espera antes de responder a un canje de `code` (para colar algo en medio). */
	beforeCodeResponse?: () => Promise<void>;
	/** Se espera antes de responder a un refresh (para abrir una carrera). */
	beforeRefreshResponse?: () => Promise<void>;
	readonly calls = { discovery: 0, jwks: 0, token: 0, refresh: 0, refreshReused: 0 };
	/** Refresh tokens que el relé pidió revocar en Sumego. */
	readonly revokedRefresh: string[] = [];
	private readonly codes = new Map<string, { nonce: string; challenge: string; person: Person }>();
	/** Refresh vivos → de quién; Sumego los rota en cada uso (§4.0.1). */
	private readonly refreshTokens = new Map<string, Person>();
	private readonly usedRefresh = new Set<string>();

	/** El refresh vivo de esta persona (el último que emitió). */
	liveRefreshOf(person: Person): string | undefined {
		return [...this.refreshTokens].filter(([, who]) => who.sid === person.sid).map(([token]) => token).at(-1);
	}

	/** Lo que hace Sumego al suspender la cuenta o revocar el grant: el
	 *  refresh deja de valer (sin logout por canal servidor). */
	forgetRefreshOf(person: Person): void {
		for (const [token, who] of this.refreshTokens) if (who.sub === person.sub) this.refreshTokens.delete(token);
	}

	private issueRefresh(person: Person): string {
		const token = `rt-${randomUUID()}`;
		this.refreshTokens.set(token, person);
		return token;
	}

	constructor(private readonly now: () => number) {}

	issueCode(authorizeUrl: string, person: Person = ANA): { code: string; state: string; nonce: string } {
		const url = new URL(authorizeUrl);
		expect(`${url.origin}${url.pathname}`).toBe(`${ISSUER}/oidc/auth`);
		expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
		expect(url.searchParams.get('redirect_uri')).toBe(SUMEGO_CALLBACK);
		expect(url.searchParams.get('scope')).toBe('openid email');
		expect(url.searchParams.get('code_challenge_method')).toBe('S256');
		const code = `code-${randomUUID()}`;
		const nonce = url.searchParams.get('nonce')!;
		this.codes.set(code, { nonce, challenge: url.searchParams.get('code_challenge')!, person });
		return { code, state: url.searchParams.get('state')!, nonce };
	}

	idTokenClaims(nonce: string, person: Person): Record<string, unknown> {
		const iat = Math.floor(this.now() / 1000);
		return {
			iss: ISSUER,
			aud: CLIENT_ID,
			sub: person.sub,
			sid: person.sid,
			...(person.email ? { email: person.email, email_verified: true } : {}),
			nonce,
			iat,
			exp: iat + 3600,
			auth_time: iat
		};
	}

	logoutToken(claims: Record<string, unknown>, key: SigningKey = this.key): string {
		const iat = Math.floor(this.now() / 1000);
		return jws(
			{
				iss: ISSUER,
				aud: CLIENT_ID,
				iat,
				exp: iat + 120,
				jti: randomUUID(),
				events: { [BACKCHANNEL_LOGOUT_EVENT]: {} },
				...claims
			},
			key,
			{ alg: 'ES256', kid: key.kid, typ: 'logout+jwt' }
		);
	}

	async handle(url: string, init?: RequestInit): Promise<Response | undefined> {
		if (!url.startsWith(`${ISSUER}/`)) return undefined;
		if (this.down) throw new TypeError('fetch failed');
		if (url === `${ISSUER}/.well-known/openid-configuration`) {
			this.calls.discovery += 1;
			return Response.json({
				issuer: this.discoveryIssuer,
				authorization_endpoint: `${ISSUER}/oidc/auth`,
				token_endpoint: `${ISSUER}/oidc/token`,
				jwks_uri: `${ISSUER}/oidc/jwks`,
				...(this.revocationEndpoint ? { revocation_endpoint: `${ISSUER}/oidc/token/revocation` } : {}),
				id_token_signing_alg_values_supported: ['ES256'],
				authorization_response_iss_parameter_supported: true
			});
		}
		if (url === `${ISSUER}/oidc/jwks`) {
			this.calls.jwks += 1;
			if (this.jwksStatus !== 200) return new Response('caído', { status: this.jwksStatus });
			return Response.json({ keys: this.jwks });
		}
		const basic = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`;
		if (url === `${ISSUER}/oidc/token/revocation`) {
			expect(new Headers(init?.headers).get('authorization')).toBe(basic);
			const form = new URLSearchParams(String(init?.body));
			expect(form.get('token_type_hint')).toBe('refresh_token');
			this.revokedRefresh.push(form.get('token')!);
			this.refreshTokens.delete(form.get('token')!);
			return new Response(null, { status: 200 });
		}
		if (url === `${ISSUER}/oidc/token`) {
			expect(init?.method).toBe('POST');
			expect(new Headers(init?.headers).get('authorization')).toBe(basic);
			const form = new URLSearchParams(String(init?.body));
			if (form.get('grant_type') === 'refresh_token') {
				this.calls.refresh += 1;
				await this.beforeRefreshResponse?.();
				if (this.refreshStatus !== 200) return Response.json({ error: 'invalid_grant' }, { status: this.refreshStatus });
				const presented = form.get('refresh_token') ?? '';
				const person = this.refreshTokens.get(presented);
				if (!person) {
					if (this.usedRefresh.has(presented)) this.calls.refreshReused += 1;
					return Response.json({ error: 'invalid_grant' }, { status: 400 });
				}
				// Rotación siempre: el viejo deja de valer.
				this.refreshTokens.delete(presented);
				this.usedRefresh.add(presented);
				return Response.json({
					access_token: 'at-de-sumego-que-se-tira',
					refresh_token: this.issueRefresh(person),
					token_type: 'Bearer',
					expires_in: 3600
				});
			}
			this.calls.token += 1;
			if (this.tokenStatus !== 200) return Response.json({ error: 'invalid_grant' }, { status: this.tokenStatus });
			const grant = this.codes.get(form.get('code') ?? '');
			if (
				!grant ||
				form.get('grant_type') !== 'authorization_code' ||
				form.get('redirect_uri') !== SUMEGO_CALLBACK ||
				createHash('sha256').update(form.get('code_verifier') ?? '', 'ascii').digest('base64url') !== grant.challenge
			) {
				return Response.json({ error: 'invalid_grant' }, { status: 400 });
			}
			this.codes.delete(form.get('code')!);
			const claims = this.idTokenClaims(grant.nonce, grant.person);
			const idToken = this.nextIdToken ? this.nextIdToken(claims) : jws(claims, this.key);
			this.nextIdToken = undefined;
			await this.beforeCodeResponse?.();
			return Response.json({
				access_token: 'at-de-sumego-que-se-tira',
				refresh_token: this.issueRefresh(grant.person),
				token_type: 'Bearer',
				expires_in: 3600,
				id_token: idToken
			});
		}
		return new Response('no existe', { status: 404 });
	}
}

/**
 * Lumbre simulada: el canal servidor de siempre (`/requests`, `/exchange`,
 * `/introspect`, `/revoke`) y el canje con Sumego. Cada canje emite una
 * credencial distinta y la recuerda para introspección y revocación.
 */
class FakeLumbre {
	readonly requests: Record<string, unknown>[] = [];
	readonly sumegoExchanges: Record<string, unknown>[] = [];
	readonly revoked: string[] = [];
	exchangeFailure?: { status: number; body: unknown };
	/** Se espera antes de responder al canje con Sumego. */
	beforeSumegoExchange?: () => Promise<void>;
	private counter = 0;
	private readonly credentials = new Map<string, { credentialId: string; clientId: string }>();

	constructor(private readonly now: () => number) {}

	private issue(clientId: string): Record<string, unknown> {
		this.counter += 1;
		const credentialId = `30000000-0000-4000-8000-${String(this.counter).padStart(12, '0')}`;
		const accessToken = createHash('sha256').update(`credencial-${this.counter}`).digest('hex');
		this.credentials.set(accessToken, { credentialId, clientId });
		return { credentialId, accessToken, tokenType: 'Bearer', resource: OAUTH_RESOURCE, scope: OAUTH_SCOPE };
	}

	async handle(url: string, init?: RequestInit): Promise<Response | undefined> {
		if (!url.startsWith('https://app.lumbre.pro/api/integrations/')) return undefined;
		expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${BACKCHANNEL_SECRET}`);
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		const path = url.slice('https://app.lumbre.pro/api/integrations/'.length);
		if (path === 'lumbre-mcp/requests') {
			this.requests.push(body);
			const requestId = `10000000-0000-4000-8000-${String(this.requests.length).padStart(12, '0')}`;
			const expiresAt = new Date(this.now() + 10 * 60_000).toISOString();
			// Con Sumego, sin `authorizationUrl` (el contrato dice que puede no venir).
			return Response.json(
				body.identityProvider === 'sumego'
					? { requestId, expiresAt }
					: { authorizationUrl: `https://app.lumbre.pro/integrations/lumbre-mcp?request=${requestId}`, requestId, expiresAt }
			);
		}
		if (path === 'mcp/sumego/exchange') {
			this.sumegoExchanges.push(body);
			await this.beforeSumegoExchange?.();
			if (this.exchangeFailure) return Response.json(this.exchangeFailure.body, { status: this.exchangeFailure.status });
			return Response.json(this.issue(String(body.clientId)));
		}
		if (path === 'lumbre-mcp/exchange') return Response.json(this.issue(CLAUDE_CLIENT));
		if (path === 'lumbre-mcp/introspect') {
			const known = this.credentials.get(String(body.accessToken));
			if (!known || this.revoked.includes(String(body.accessToken))) return Response.json({ active: false });
			return Response.json({ active: true, ...known, resource: OAUTH_RESOURCE, scope: OAUTH_SCOPE });
		}
		if (path === 'lumbre-mcp/revoke') {
			this.revoked.push(String(body.accessToken));
			return Response.json({ ok: true });
		}
		return new Response('no existe', { status: 404 });
	}
}

interface Harness {
	baseUrl: string;
	stateDir: string;
	service: OAuthService;
	idp: FakeSumego;
	lumbre: FakeLumbre;
	clock: { now: number };
	clientName: string;
	/** Costuras del servicio que un test puede enganchar. */
	hooks: { renewalJoined?: () => void };
}

const servers: Server[] = [];
const dirs: string[] = [];

async function newDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'lumbre-mcp-sumego-'));
	dirs.push(dir);
	return dir;
}

async function listen(service: OAuthService): Promise<string> {
	const server = createHttpApp('https://app.lumbre.test', service);
	server.keepAliveTimeout = 60_000;
	server.listen(0, '127.0.0.1');
	servers.push(server);
	await new Promise<void>((resolve) => server.once('listening', resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function serviceFor(
	h: Pick<Harness, 'idp' | 'lumbre' | 'clock' | 'clientName' | 'hooks'>,
	stateDir: string,
	login: LoginConfig
): OAuthService {
	const fetchFn: typeof fetch = async (input, init) => {
		const url = String(input);
		if (url === CLAUDE_CLIENT) {
			return Response.json({
				client_id: CLAUDE_CLIENT,
				client_name: h.clientName,
				redirect_uris: [OAUTH_CALLBACK],
				token_endpoint_auth_method: 'none'
			});
		}
		const answer = (await h.idp.handle(url, init)) ?? (await h.lumbre.handle(url, init));
		if (answer) return answer;
		throw new Error(`fetch inesperado: ${url}`);
	};
	return new OAuthService({
		stateDir,
		fetch: fetchFn,
		now: () => h.clock.now,
		backchannelSecret: BACKCHANNEL_SECRET,
		login,
		sumegoRenewalJoined: () => h.hooks.renewalJoined?.()
	});
}

async function harness(login: LoginConfig = SUMEGO_LOGIN, clientName = 'Claude'): Promise<Harness> {
	const clock = { now: START };
	const parts = {
		idp: new FakeSumego(() => clock.now),
		lumbre: new FakeLumbre(() => clock.now),
		clock,
		clientName,
		hooks: {} as Harness['hooks']
	};
	const stateDir = await newDir();
	const service = serviceFor(parts, stateDir, login);
	return { ...parts, stateDir, service, baseUrl: await listen(service) };
}

function authorizeUrl(baseUrl: string): string {
	return `${baseUrl}/authorize?${new URLSearchParams({
		response_type: 'code',
		client_id: CLAUDE_CLIENT,
		redirect_uri: OAUTH_CALLBACK,
		scope: OAUTH_SCOPE,
		resource: OAUTH_RESOURCE,
		code_challenge: CHALLENGE,
		code_challenge_method: 'S256',
		state: 'estado-de-claude'
	})}`;
}

/** `/authorize` con Sumego: la URL de Sumego y la cookie de atadura. */
async function startLogin(h: Harness): Promise<{ location: string; cookie: string }> {
	const response = await fetch(authorizeUrl(h.baseUrl), { redirect: 'manual' });
	expect(response.status).toBe(302);
	const setCookie = response.headers.get('set-cookie')!;
	expect(setCookie).toMatch(/^__Host-lumbre-mcp-sumego=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/);
	return { location: response.headers.get('location')!, cookie: setCookie.split(';', 1)[0]! };
}

function callbackUrl(h: Harness, params: Record<string, string>): string {
	return `${h.baseUrl}/oauth/sumego/callback?${new URLSearchParams(params)}`;
}

async function callback(h: Harness, params: Record<string, string>, cookie?: string): Promise<Response> {
	return await fetch(callbackUrl(h, params), { redirect: 'manual', headers: cookie ? { cookie } : {} });
}

/** Hasta la página de consentimiento; devuelve lo que el formulario lleva. */
async function reachConsent(h: Harness, person: Person = ANA): Promise<{ cookie: string; request: string; csrf: string; html: string; nonce: string }> {
	const { location, cookie } = await startLogin(h);
	const { code, state, nonce } = h.idp.issueCode(location, person);
	const response = await callback(h, { code, state, iss: ISSUER }, cookie);
	const html = await response.text();
	expect(response.status, html).toBe(200);
	return {
		cookie,
		html,
		nonce,
		request: html.match(/name="request" value="([^"]+)"/)![1]!,
		csrf: html.match(/name="csrf" value="([^"]+)"/)![1]!
	};
}

async function consent(
	h: Harness,
	form: { request: string; csrf: string; decision: string },
	cookie?: string
): Promise<Response> {
	return await fetch(`${h.baseUrl}/oauth/sumego/consent`, {
		method: 'POST',
		redirect: 'manual',
		headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
		body: new URLSearchParams(form)
	});
}

async function token(h: Harness, form: Record<string, string>): Promise<Response> {
	return await fetch(`${h.baseUrl}/token`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ client_id: CLAUDE_CLIENT, resource: OAUTH_RESOURCE, ...form })
	});
}

/** Conexión completa con Sumego hasta los tokens del relé. */
async function connect(h: Harness, person: Person = ANA): Promise<{ access: string; refresh: string }> {
	const page = await reachConsent(h, person);
	const allowed = await consent(h, { request: page.request, csrf: page.csrf, decision: 'allow' }, page.cookie);
	expect(allowed.status, await allowed.clone().text()).toBe(302);
	const back = new URL(allowed.headers.get('location')!);
	expect(`${back.origin}${back.pathname}`).toBe(OAUTH_CALLBACK);
	expect(back.searchParams.get('iss')).toBe(OAUTH_ISSUER);
	expect(back.searchParams.get('state')).toBe('estado-de-claude');
	const tokens = await token(h, {
		grant_type: 'authorization_code',
		code: back.searchParams.get('code')!,
		redirect_uri: OAUTH_CALLBACK,
		code_verifier: VERIFIER
	});
	expect(tokens.status).toBe(200);
	const body = (await tokens.json()) as { access_token: string; refresh_token: string };
	return { access: body.access_token, refresh: body.refresh_token };
}

/** Conexión completa por el camino de Lumbre de siempre. */
async function connectWithLumbre(h: Harness): Promise<{ access: string; refresh: string }> {
	const started = await fetch(authorizeUrl(h.baseUrl), { redirect: 'manual' });
	expect(started.status).toBe(302);
	const requestId = new URL(started.headers.get('location')!).searchParams.get('request')!;
	const approved = await fetch(`${h.baseUrl}/oauth/lumbre/callback?request=${requestId}&decision=approved`, {
		redirect: 'manual'
	});
	expect(approved.status).toBe(302);
	const code = new URL(approved.headers.get('location')!).searchParams.get('code')!;
	const tokens = await token(h, { grant_type: 'authorization_code', code, redirect_uri: OAUTH_CALLBACK, code_verifier: VERIFIER });
	expect(tokens.status).toBe(200);
	const body = (await tokens.json()) as { access_token: string; refresh_token: string };
	return { access: body.access_token, refresh: body.refresh_token };
}

interface StoredGrantView {
	sumego?: { sub: string; sid: string };
	credentialId: string;
	sumegoRefresh?: { ciphertext: string };
	sumegoCheckedAt?: number;
}

async function storedGrants(h: Harness): Promise<StoredGrantView[]> {
	return (JSON.parse(await readFile(join(h.stateDir, 'oauth-store.json'), 'utf8')) as { grants: StoredGrantView[] }).grants;
}

/** Promesa que se resuelve desde fuera; para ordenar una carrera sin esperas. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function logout(h: Harness, logoutToken: string): Promise<Response> {
	return await fetch(`${h.baseUrl}/oauth/sumego/backchannel-logout`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ logout_token: logoutToken })
	});
}

beforeEach(async () => {
	// La huella de notas de un grant revocado se borra bajo XDG_STATE_HOME
	// (`notes.ts`): que no caiga en el directorio real de quien corre esto.
	process.env.XDG_STATE_HOME = await newDir();
});

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	delete process.env.XDG_STATE_HOME;
});

describe('configuración del login', () => {
	it('por defecto es lumbre, con el issuer y el client_id de Sumego por defecto', () => {
		expect(loginConfigFromEnv({})).toEqual({
			provider: 'lumbre',
			sumego: { issuer: ISSUER, clientId: CLIENT_ID, clientSecret: undefined }
		});
		expect(loginConfigFromEnv({ LUMBRE_MCP_LOGIN_PROVIDER: '' }).provider).toBe('lumbre');
	});

	it('un proveedor desconocido aborta sin repetir el valor', () => {
		expect(() => loginConfigFromEnv({ LUMBRE_MCP_LOGIN_PROVIDER: 'google-valor-raro' })).toThrow(/LUMBRE_MCP_LOGIN_PROVIDER/);
		try {
			loginConfigFromEnv({ LUMBRE_MCP_LOGIN_PROVIDER: 'google-valor-raro' });
		} catch (error) {
			expect((error as Error).message).not.toContain('google-valor-raro');
		}
	});

	it('sumego exige el secreto, y el mensaje nunca lleva el valor', () => {
		expect(() => loginConfigFromEnv({ LUMBRE_MCP_LOGIN_PROVIDER: 'sumego' })).toThrow(/LUMBRE_MCP_OIDC_CLIENT_SECRET es obligatorio/);
		const leaky = 'secreto-con\nsalto-que-no-debe-salir';
		let message = '';
		try {
			loginConfigFromEnv({ LUMBRE_MCP_LOGIN_PROVIDER: 'sumego', LUMBRE_MCP_OIDC_CLIENT_SECRET: leaky });
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain('LUMBRE_MCP_OIDC_CLIENT_SECRET');
		expect(message).not.toContain('salto-que-no-debe-salir');
		expect(
			loginConfigFromEnv({ LUMBRE_MCP_LOGIN_PROVIDER: 'sumego', LUMBRE_MCP_OIDC_CLIENT_SECRET: CLIENT_SECRET }).sumego.clientSecret
		).toBe(CLIENT_SECRET);
	});

	it('el issuer tiene que ser https; la barra final no cuenta', () => {
		expect(() => loginConfigFromEnv({ LUMBRE_MCP_OIDC_ISSUER: 'http://id.lumbre.pro' })).toThrow(/LUMBRE_MCP_OIDC_ISSUER/);
		expect(loginConfigFromEnv({ LUMBRE_MCP_OIDC_ISSUER: 'https://id.lumbre.pro/' }).sumego.issuer).toBe(ISSUER);
	});

	it('el servicio no se construye con un proveedor desconocido ni con sumego sin secreto', () => {
		const previous = { ...process.env };
		try {
			process.env.LUMBRE_MCP_LOGIN_PROVIDER = 'otro';
			expect(() => new OAuthService({ stateDir: '/nunca-se-usa' })).toThrow(/LUMBRE_MCP_LOGIN_PROVIDER/);
			process.env.LUMBRE_MCP_LOGIN_PROVIDER = 'sumego';
			delete process.env.LUMBRE_MCP_OIDC_CLIENT_SECRET;
			expect(() => new OAuthService({ stateDir: '/nunca-se-usa' })).toThrow(/LUMBRE_MCP_OIDC_CLIENT_SECRET/);
		} finally {
			process.env = previous;
		}
	});
});

describe('cliente OIDC: ID token', () => {
	const clock = { now: START };
	let idp: FakeSumego;
	let client: SumegoOidcClient;

	beforeEach(() => {
		clock.now = START;
		idp = new FakeSumego(() => clock.now);
		client = new SumegoOidcClient({
			config: SUMEGO_LOGIN.sumego,
			now: () => clock.now,
			fetch: (async (input, init) => (await idp.handle(String(input), init))!) as typeof fetch
		});
	});

	async function redeemWith(rewrite?: (claims: Record<string, unknown>) => string): Promise<unknown> {
		const url = await client.authorizationUrl({ state: 's'.repeat(43), nonce: 'nonce-bueno', codeChallenge: CHALLENGE });
		const { code } = idp.issueCode(url);
		idp.nextIdToken = rewrite;
		return await client.redeemCode(code, VERIFIER, 'nonce-bueno').catch((error: unknown) => error);
	}

	it('la vuelta buena devuelve sub, sid y el email solo para enseñarlo', async () => {
		const redeemed = (await redeemWith()) as { identity: unknown; idToken: string };
		expect(redeemed.identity).toEqual({ sub: ANA.sub, sid: ANA.sid, email: ANA.email });
		expect(redeemed.idToken.split('.')).toHaveLength(3);
		// Discovery y JWKS se cachean: un segundo login no vuelve a pedirlos.
		await redeemWith();
		expect(idp.calls).toMatchObject({ discovery: 1, jwks: 1, token: 2 });
	});

	it.each([
		['iss ausente', (c: Record<string, unknown>) => jws({ ...c, iss: undefined }, idp.key)],
		['iss de otro', (c: Record<string, unknown>) => jws({ ...c, iss: 'https://otro.example' }, idp.key)],
		['nonce distinto', (c: Record<string, unknown>) => jws({ ...c, nonce: 'otro-nonce' }, idp.key)],
		['aud ajeno', (c: Record<string, unknown>) => jws({ ...c, aud: 'lumbre-web' }, idp.key)],
		['varias aud sin azp', (c: Record<string, unknown>) => jws({ ...c, aud: [CLIENT_ID, 'lumbre-web'] }, idp.key)],
		['azp ajeno', (c: Record<string, unknown>) => jws({ ...c, azp: 'lumbre-web' }, idp.key)],
		['caducado', (c: Record<string, unknown>) => jws({ ...c, exp: Math.floor(START / 1000) - 120 }, idp.key)],
		['iat del futuro', (c: Record<string, unknown>) => jws({ ...c, iat: Math.floor(START / 1000) + 600 }, idp.key)],
		['sin sid', (c: Record<string, unknown>) => jws({ ...c, sid: undefined }, idp.key)],
		['firmado con otra clave', (c: Record<string, unknown>) => jws(c, { ...signingKey('k1') })],
		['alg none', (c: Record<string, unknown>) => `${b64json({ alg: 'none' })}.${b64json(c)}.`],
		[
			'alg HS256 con la clave pública como secreto',
			(c: Record<string, unknown>) => {
				const signed = `${b64json({ alg: 'HS256', kid: 'k1' })}.${b64json(c)}`;
				const mac = createHmac('sha256', JSON.stringify(idp.key.jwk)).update(signed).digest('base64url');
				return `${signed}.${mac}`;
			}
		]
	])('rechaza un ID token con %s', async (_name, rewrite) => {
		const error = await redeemWith(rewrite);
		expect(error).toBeInstanceOf(OidcError);
		expect((error as OidcError).kind).toBe('invalid');
	});

	it('un 4xx del token endpoint hace fallar el login; 429 y 5xx son transitorios', async () => {
		for (const [status, kind] of [[400, 'invalid'], [401, 'invalid'], [429, 'transient'], [503, 'transient']] as const) {
			idp.tokenStatus = status;
			expect(await redeemWith()).toMatchObject({ kind });
		}
	});

	it('un discovery con otro issuer o un endpoint fuera de su origen no se acepta', async () => {
		idp.discoveryIssuer = 'https://otro.example';
		await expect(client.authorizationUrl({ state: 's', nonce: 'n', codeChallenge: 'c' })).rejects.toMatchObject({ kind: 'invalid' });
		idp.down = true;
		await expect(client.authorizationUrl({ state: 's', nonce: 'n', codeChallenge: 'c' })).rejects.toMatchObject({ kind: 'transient' });
	});

	it('un kid nuevo relee el JWKS una vez (rotación), pero no más de una vez por minuto', async () => {
		await redeemWith();
		expect(idp.calls.jwks).toBe(1);
		const rotated = signingKey('k2');
		idp.jwks = [idp.key.jwk, rotated.jwk];
		clock.now += 61_000;
		expect(await redeemWith((c) => jws(c, rotated))).toMatchObject({ identity: { sub: ANA.sub } });
		expect(idp.calls.jwks).toBe(2);
		// Un kid inventado justo después: el freno impide otra relectura.
		const forged = signingKey('k-inventado');
		expect(await redeemWith((c) => jws(c, forged))).toBeInstanceOf(OidcError);
		expect(idp.calls.jwks).toBe(2);
	});
});

describe('cliente OIDC: logout_token', () => {
	const clock = { now: START };
	const idp = new FakeSumego(() => clock.now);
	const client = new SumegoOidcClient({
		config: { issuer: ISSUER, clientId: CLIENT_ID },
		now: () => clock.now,
		fetch: (async (input, init) => (await idp.handle(String(input), init))!) as typeof fetch
	});

	it('uno bueno devuelve jti, sub, sid y hasta cuándo recordar el jti (sin secreto de cliente)', async () => {
		const claims = await client.validateLogoutToken(idp.logoutToken({ sub: 'sub-ana', sid: 'sid-1', jti: 'jti-1' }));
		expect(claims).toEqual({ jti: 'jti-1', sub: 'sub-ana', sid: 'sid-1', keepUntil: START + 6 * 60_000, issuedAt: START });
	});

	it.each([
		['sin events', { events: undefined }],
		['events sin la clave de logout', { events: { 'http://otro/evento': {} } }],
		['con nonce', { nonce: 'n' }],
		['aud ajeno', { aud: 'lumbre-web' }],
		['iss de otro', { iss: 'https://otro.example' }],
		['sin sub ni sid', {}],
		['sin jti', { jti: undefined }],
		['demasiado viejo', { iat: Math.floor(START / 1000) - 3600, exp: undefined }],
		['caducado', { exp: Math.floor(START / 1000) - 600 }]
	])('rechaza uno %s', async (_name, overrides) => {
		const base = Object.keys(overrides).length === 0 ? {} : { sub: 'sub-ana' };
		const error = await client.validateLogoutToken(idp.logoutToken({ ...base, ...overrides })).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(OidcError);
		expect((error as OidcError).kind).toBe('invalid');
	});
});

describe('login con Sumego en el relé', () => {
	it('la vuelta buena pasa por el consentimiento y crea el grant con sub y sid', async () => {
		const h = await harness();
		const page = await reachConsent(h);
		// La solicitud en Lumbre lleva el proveedor y el hash del nonce que fue a Sumego.
		expect(h.lumbre.requests).toHaveLength(1);
		expect(h.lumbre.requests[0]).toMatchObject({
			identityProvider: 'sumego',
			sumegoNonceSha256: createHash('sha256').update(page.nonce, 'utf8').digest('base64url'),
			clientId: CLAUDE_CLIENT
		});
		expect(page.html).toContain('ana@example.com');
		expect(page.html).toContain('claude.ai');
		expect(h.lumbre.sumegoExchanges).toHaveLength(0);
		const allowed = await consent(h, { request: page.request, csrf: page.csrf, decision: 'allow' }, page.cookie);
		expect(allowed.status).toBe(302);
		expect(allowed.headers.get('set-cookie')).toContain('Max-Age=0');
		expect(h.lumbre.sumegoExchanges).toHaveLength(1);
		const exchange = h.lumbre.sumegoExchanges[0]!;
		expect(Object.keys(exchange).sort()).toEqual(['clientId', 'idToken', 'requestId', 'resource', 'scope', 'transactionId']);
		expect(exchange).toMatchObject({ requestId: page.request, clientId: CLAUDE_CLIENT, resource: OAUTH_RESOURCE, scope: OAUTH_SCOPE });
		expect(exchange.transactionId).toBe(h.lumbre.requests[0]!.transactionId);
		const code = new URL(allowed.headers.get('location')!).searchParams.get('code')!;
		const tokens = await token(h, { grant_type: 'authorization_code', code, redirect_uri: OAUTH_CALLBACK, code_verifier: VERIFIER });
		expect(tokens.status).toBe(200);
		const { access_token: access } = (await tokens.json()) as { access_token: string };
		expect(await h.service.resolveAccessToken(access)).toMatch(/^[a-f0-9]{64}$/);
		expect((await storedGrants(h)).map((grant) => grant.sumego)).toEqual([{ sub: ANA.sub, sid: ANA.sid }]);
		// Del canje con Sumego solo se usó el ID token: nada de sus tokens en disco.
		const raw = await readFile(join(h.stateDir, 'oauth-store.json'), 'utf8');
		expect(raw).not.toContain('se-tira');
	});

	it('con Sumego caído falla /authorize sin crear nada en Lumbre', async () => {
		const h = await harness();
		h.idp.down = true;
		const response = await fetch(authorizeUrl(h.baseUrl), { redirect: 'manual' });
		expect(response.status).toBe(503);
		expect(h.lumbre.requests).toHaveLength(0);
	});

	it('un state repetido o desconocido no vale', async () => {
		const h = await harness();
		const { location, cookie } = await startLogin(h);
		const { code, state } = h.idp.issueCode(location);
		expect((await callback(h, { code, state, iss: ISSUER }, cookie)).status).toBe(200);
		expect((await callback(h, { code, state, iss: ISSUER }, cookie)).status).toBe(400);
		expect((await callback(h, { code, state: 'x'.repeat(43), iss: ISSUER }, cookie)).status).toBe(400);
		expect(h.idp.calls.token).toBe(1);
	});

	it('sin iss o con otro iss se rechaza sin consumir la transacción', async () => {
		const h = await harness();
		const { location, cookie } = await startLogin(h);
		const { code, state } = h.idp.issueCode(location);
		expect((await callback(h, { code, state }, cookie)).status).toBe(400);
		expect((await callback(h, { code, state, iss: 'https://otro.example' }, cookie)).status).toBe(400);
		expect(h.idp.calls.token).toBe(0);
		// La buena sigue funcionando: lo de arriba no la quemó.
		expect((await callback(h, { code, state, iss: ISSUER }, cookie)).status).toBe(200);
	});

	it('un error de Sumego con iss vuelve al cliente con access_denied y quema la transacción', async () => {
		const h = await harness();
		const { location, cookie } = await startLogin(h);
		const { state } = h.idp.issueCode(location);
		const denied = await callback(h, { error: 'login_required', state, iss: ISSUER }, cookie);
		expect(denied.status).toBe(302);
		const back = new URL(denied.headers.get('location')!);
		expect(back.searchParams.get('error')).toBe('access_denied');
		expect(back.searchParams.get('iss')).toBe(OAUTH_ISSUER);
		expect(back.searchParams.get('state')).toBe('estado-de-claude');
		expect((await callback(h, { code: 'c', state, iss: ISSUER }, cookie)).status).toBe(400);
	});

	it('la vuelta sin la cookie del navegador que abrió el flujo se quema', async () => {
		const h = await harness();
		const { location, cookie } = await startLogin(h);
		const { code, state } = h.idp.issueCode(location);
		expect((await callback(h, { code, state, iss: ISSUER })).status).toBe(400);
		expect((await callback(h, { code, state, iss: ISSUER }, cookie)).status).toBe(400);
		expect(h.idp.calls.token).toBe(0);
	});

	it('un ID token que no vale (aquí, nonce cambiado) no llega al consentimiento', async () => {
		const h = await harness();
		const { location, cookie } = await startLogin(h);
		const { code, state } = h.idp.issueCode(location);
		h.idp.nextIdToken = (claims) => jws({ ...claims, nonce: 'otro' }, h.idp.key);
		const response = await callback(h, { code, state, iss: ISSUER }, cookie);
		expect(response.status).toBe(502);
		expect(await response.text()).not.toContain('name="csrf"');
	});

	it('consentimiento sin cookie, con un CSRF que no es o repetido: 4xx y no canjea', async () => {
		const h = await harness();
		const page = await reachConsent(h);
		expect((await consent(h, { request: page.request, csrf: page.csrf, decision: 'allow' })).status).toBe(403);
		expect((await consent(h, { request: page.request, csrf: 'y'.repeat(43), decision: 'allow' }, page.cookie)).status).toBe(403);
		expect(h.lumbre.sumegoExchanges).toHaveLength(0);
		// Ninguno de los dos la quemó: la buena pasa, y repetirla ya no.
		expect((await consent(h, { request: page.request, csrf: page.csrf, decision: 'allow' }, page.cookie)).status).toBe(302);
		expect((await consent(h, { request: page.request, csrf: page.csrf, decision: 'allow' }, page.cookie)).status).toBe(403);
		expect(h.lumbre.sumegoExchanges).toHaveLength(1);
	});

	it('el consentimiento caduca con la transacción', async () => {
		const h = await harness();
		const page = await reachConsent(h);
		h.clock.now += 10 * 60_000 + 1;
		expect((await consent(h, { request: page.request, csrf: page.csrf, decision: 'allow' }, page.cookie)).status).toBe(403);
		expect(h.lumbre.sumegoExchanges).toHaveLength(0);
	});

	it('«Cancelar» vuelve al cliente con access_denied e iss, sin canjear', async () => {
		const h = await harness();
		const page = await reachConsent(h);
		const denied = await consent(h, { request: page.request, csrf: page.csrf, decision: 'deny' }, page.cookie);
		expect(denied.status).toBe(302);
		const back = new URL(denied.headers.get('location')!);
		expect(`${back.origin}${back.pathname}`).toBe(OAUTH_CALLBACK);
		expect(back.searchParams.get('error')).toBe('access_denied');
		expect(back.searchParams.get('iss')).toBe(OAUTH_ISSUER);
		expect(h.lumbre.sumegoExchanges).toHaveLength(0);
	});

	it('la página de consentimiento escapa el nombre del cliente y lleva CSP estricta y no-store', async () => {
		const h = await harness(SUMEGO_LOGIN, '<script>alert("x")</script> & "Claude"');
		const { location, cookie } = await startLogin(h);
		const { code, state } = h.idp.issueCode(location);
		const response = await callback(h, { code, state, iss: ISSUER }, cookie);
		const html = await response.text();
		expect(html).not.toContain('<script>');
		expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &quot;Claude&quot;');
		expect(response.headers.get('cache-control')).toBe('no-store');
		const csp = response.headers.get('content-security-policy')!;
		expect(csp).toContain("default-src 'none'");
		expect(csp).toContain("frame-ancestors 'none'");
		expect(csp).toContain("form-action 'self' https://claude.ai");
		expect(response.headers.get('x-frame-options')).toBe('DENY');
	});

	it.each([
		[400, { code: 'invalid_token' }, 400, 'invalidToken', false],
		[400, { code: 'unknown_account' }, 403, 'unknownAccount', false],
		[403, { code: 'account_pending' }, 403, 'accountPending', false],
		[403, { code: 'account_suspended' }, 403, 'accountSuspended', false],
		[403, { code: 'account_rejected' }, 403, 'accountRejected', false],
		[404, { code: 'transaction_not_found' }, 400, 'transactionNotFound', false],
		[409, { code: 'token_reused' }, 400, 'tokenReused', false],
		[503, { code: 'sumego_unavailable' }, 503, 'accountsUnavailable', false],
		[400, { code: 'invalid_request' }, 502, 'generic', true],
		[413, { code: 'payload_too_large' }, 502, 'generic', true],
		// 401 del secreto: el cuerpo de error de SvelteKit, sin `code`.
		[401, { message: 'Unauthorized' }, 502, 'generic', true],
		[502, { code: 'algo_que_no_esta_en_la_lista' }, 503, 'lumbreUnavailable', false]
	] as const)('Lumbre %i %j: página %i con la frase %s (fallo nuestro: %s)', async (status, body, pageStatus, key, ourFault) => {
		const h = await harness();
		h.lumbre.exchangeFailure = { status, body };
		const page = await reachConsent(h);
		const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		let response: Response;
		let lines: string[];
		try {
			response = await consent(h, { request: page.request, csrf: page.csrf, decision: 'allow' }, page.cookie);
		} finally {
			// `mockRestore` vacía las llamadas: se copian antes.
			lines = logged.mock.calls.map(([line]) => String(line));
			logged.mockRestore();
		}
		expect(response.status).toBe(pageStatus);
		expect(response.headers.get('content-type')).toContain('text/html');
		const html = await response.text();
		expect(html).toContain(SUMEGO_PERSON_MESSAGES[key]);
		// Nada interno: ni el código de Lumbre ni su cuerpo.
		expect(html).not.toMatch(/invalid_|unknown_account|account_|transaction_not_found|token_reused|sumego_unavailable|payload_|Unauthorized|algo_que/);
		const ourFaultLines = lines.filter((line) => line.includes('fallo del relé'));
		expect(ourFaultLines.length > 0).toBe(ourFault);
		for (const line of ourFaultLines) expect(line).not.toMatch(/eyJ|[a-f0-9]{64}/);
		// Un rechazo termina el flujo: el consentimiento no se puede repetir
		// aunque Lumbre admitiera otro ID token para su solicitud.
		expect((await consent(h, { request: page.request, csrf: page.csrf, decision: 'allow' }, page.cookie)).status).toBe(403);
		expect(h.lumbre.sumegoExchanges).toHaveLength(1);
	});

	it('cada frase para la persona sale de un solo sitio y ninguna lleva jerga interna', () => {
		for (const [key, message] of Object.entries(SUMEGO_PERSON_MESSAGES)) {
			expect(message, key).not.toMatch(/[a-z]+_[a-z]+|https?:|\{|\}/);
			expect(message.length, key).toBeLessThan(140);
		}
		expect(exchangeFailure(new BackchannelError('invalid', 'x', 'account_suspended'))).toMatchObject({
			status: 403,
			key: 'accountSuspended'
		});
		expect(exchangeFailure(new BackchannelError('invalid', 'x')).log).toBeDefined();
		expect(exchangeFailure(new BackchannelError('transient', 'x')).key).toBe('lumbreUnavailable');
	});
});

describe('back-channel logout de Sumego', () => {
	it('con sid revoca solo el grant de esa sesión, también en Lumbre', async () => {
		const h = await harness();
		const first = await connect(h, { ...ANA, sid: 'sid-1' });
		const second = await connect(h, { ...ANA, sid: 'sid-2' });
		const response = await logout(h, h.idp.logoutToken({ sid: 'sid-1' }));
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(await h.service.resolveAccessToken(first.access)).toBeUndefined();
		expect(await h.service.resolveAccessToken(second.access)).toBeDefined();
		expect(h.lumbre.revoked).toHaveLength(1);
		expect((await storedGrants(h)).map((grant) => grant.sumego?.sid)).toEqual(['sid-2']);
	});

	it('con solo sub revoca todo lo de esa persona y nada de otra', async () => {
		const h = await harness();
		const ana1 = await connect(h, { ...ANA, sid: 'sid-1' });
		const ana2 = await connect(h, { ...ANA, sid: 'sid-2' });
		const bea = await connect(h, { sub: 'sub-bea', sid: 'sid-bea' });
		expect((await logout(h, h.idp.logoutToken({ sub: ANA.sub }))).status).toBe(200);
		expect(await h.service.resolveAccessToken(ana1.access)).toBeUndefined();
		expect(await h.service.resolveAccessToken(ana2.access)).toBeUndefined();
		expect(await h.service.resolveAccessToken(bea.access)).toBeDefined();
		expect(h.lumbre.revoked).toHaveLength(2);
		// El refresh de lo revocado tampoco sirve ya.
		expect((await token(h, { grant_type: 'refresh_token', refresh_token: ana1.refresh })).status).toBe(400);
	});

	it('un jti repetido da 400', async () => {
		const h = await harness();
		await connect(h);
		const logoutToken = h.idp.logoutToken({ sub: ANA.sub, jti: 'jti-unico' });
		expect((await logout(h, logoutToken)).status).toBe(200);
		expect((await logout(h, logoutToken)).status).toBe(400);
		// Otro jti para la misma persona sí se atiende (aunque ya no quede nada).
		expect((await logout(h, h.idp.logoutToken({ sub: ANA.sub }))).status).toBe(200);
	});

	it.each([
		['sin events', { sub: ANA.sub, events: undefined }],
		['con nonce', { sub: ANA.sub, nonce: 'n' }],
		['con aud ajeno', { sub: ANA.sub, aud: 'lumbre-web' }]
	])('%s da 400 y no revoca nada', async (_name, claims) => {
		const h = await harness();
		const session = await connect(h);
		const response = await logout(h, h.idp.logoutToken(claims));
		expect(response.status).toBe(400);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(await h.service.resolveAccessToken(session.access)).toBeDefined();
	});

	it('solo POST con formulario; sin cookies ni CSRF', async () => {
		const h = await harness();
		expect((await fetch(`${h.baseUrl}/oauth/sumego/backchannel-logout`)).status).toBe(405);
		const json = await fetch(`${h.baseUrl}/oauth/sumego/backchannel-logout`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ logout_token: h.idp.logoutToken({ sub: ANA.sub }) })
		});
		expect(json.status).toBe(400);
	});
});

describe('cambiar de proveedor no corta los grants vivos', () => {
	it('un grant nacido con Sumego sigue valiendo (y rotando) con lumbre, y su logout sigue llegando', async () => {
		const h = await harness();
		const session = await connect(h);
		const afterSwitch = serviceFor(h, h.stateDir, LUMBRE_LOGIN);
		const baseUrl = await listen(afterSwitch);
		const switched = { ...h, service: afterSwitch, baseUrl };
		expect(await afterSwitch.resolveAccessToken(session.access)).toBeDefined();
		const rotated = await token(switched, { grant_type: 'refresh_token', refresh_token: session.refresh });
		expect(rotated.status).toBe(200);
		const { access_token: access } = (await rotated.json()) as { access_token: string };
		// Con `lumbre`, el back-channel logout sigue atendiendo a los grants de Sumego.
		expect((await logout(switched, h.idp.logoutToken({ sub: ANA.sub }))).status).toBe(200);
		expect(await afterSwitch.resolveAccessToken(access)).toBeUndefined();
	});

	it('un grant nacido con Lumbre sigue valiendo con sumego, y /authorize ya va a Sumego', async () => {
		const h = await harness(LUMBRE_LOGIN);
		const session = await connectWithLumbre(h);
		expect((await storedGrants(h))[0]!.sumego).toBeUndefined();
		const afterSwitch = serviceFor(h, h.stateDir, SUMEGO_LOGIN);
		const switched = { ...h, service: afterSwitch, baseUrl: await listen(afterSwitch) };
		expect(await afterSwitch.resolveAccessToken(session.access)).toBeDefined();
		expect((await token(switched, { grant_type: 'refresh_token', refresh_token: session.refresh })).status).toBe(200);
		const { location } = await startLogin(switched);
		expect(location.startsWith(`${ISSUER}/oidc/auth?`)).toBe(true);
	});
});

describe('la cookie de atadura solo se borra al quemar la transacción (B2)', () => {
	it('una vuelta con otro iss da error sin borrar la cookie, y la vuelta buena sigue funcionando', async () => {
		const h = await harness();
		const { location, cookie } = await startLogin(h);
		const { code, state } = h.idp.issueCode(location);
		const forged = await callback(h, { code, state, iss: 'https://otro.example' }, cookie);
		expect(forged.status).toBe(400);
		expect(forged.headers.get('set-cookie')).toBeNull();
		expect((await callback(h, { code, state, iss: ISSUER }, cookie)).status).toBe(200);
	});

	it('recargar la vuelta ya consumida, con el consentimiento abierto, dice que la página ya se usó y no toca la cookie', async () => {
		const h = await harness();
		const { location, cookie } = await startLogin(h);
		const { code, state } = h.idp.issueCode(location);
		const first = await callback(h, { code, state, iss: ISSUER }, cookie);
		const html = await first.text();
		const reload = await callback(h, { code, state, iss: ISSUER }, cookie);
		expect(reload.status).toBe(400);
		expect(reload.headers.get('set-cookie')).toBeNull();
		expect(await reload.text()).toContain('Esta página ya se usó');
		// La confirmación abierta en la otra ventana sigue valiendo.
		const allowed = await consent(
			h,
			{ request: html.match(/name="request" value="([^"]+)"/)![1]!, csrf: html.match(/name="csrf" value="([^"]+)"/)![1]!, decision: 'allow' },
			cookie
		);
		expect(allowed.status).toBe(302);
	});
});

describe('un logout que llega a mitad de la conexión la alcanza (B1)', () => {
	it('logout por sid durante el canje del code con Sumego: no se llega al consentimiento', async () => {
		const h = await harness();
		const { location, cookie } = await startLogin(h);
		const { code, state } = h.idp.issueCode(location);
		h.idp.beforeCodeResponse = async () => {
			h.idp.beforeCodeResponse = undefined;
			expect((await logout(h, h.idp.logoutToken({ sid: ANA.sid }))).status).toBe(200);
		};
		const response = await callback(h, { code, state, iss: ISSUER }, cookie);
		const html = await response.text();
		expect(response.status).toBe(403);
		expect(html).toContain('Se cerró la sesión de tu cuenta');
		expect(html).not.toContain('name="csrf"');
		expect(h.lumbre.sumegoExchanges).toHaveLength(0);
	});

	it('logout por sub durante el canje con Lumbre: la credencial recién emitida se revoca y no sale código', async () => {
		const h = await harness();
		const page = await reachConsent(h);
		h.lumbre.beforeSumegoExchange = async () => {
			h.lumbre.beforeSumegoExchange = undefined;
			expect((await logout(h, h.idp.logoutToken({ sub: ANA.sub }))).status).toBe(200);
		};
		const response = await consent(h, { request: page.request, csrf: page.csrf, decision: 'allow' }, page.cookie);
		expect(response.status).toBe(403);
		expect(response.headers.get('location')).toBeNull();
		expect(await response.text()).toContain('Se cerró la sesión de tu cuenta');
		// Lo que Lumbre acababa de emitir no se queda vivo allí.
		expect(h.lumbre.revoked).toHaveLength(1);
		expect(JSON.parse(await readFile(join(h.stateDir, 'oauth-store.json'), 'utf8')).authorizationCodes).toEqual([]);
	});
});

describe('freno a Sumego también cuando falla (B3)', () => {
	const clock = { now: START };
	let idp: FakeSumego;
	let client: SumegoOidcClient;
	/** Toda petición que sale hacia Sumego, también las que fallan. */
	let outgoing: string[];

	beforeEach(() => {
		clock.now = START;
		outgoing = [];
		idp = new FakeSumego(() => clock.now);
		client = new SumegoOidcClient({
			config: SUMEGO_LOGIN.sumego,
			now: () => clock.now,
			fetch: (async (input, init) => {
				outgoing.push(String(input));
				const answer = await idp.handle(String(input), init);
				if (!answer) throw new Error(`fetch inesperado: ${String(input)}`);
				return answer;
			}) as typeof fetch
		});
	});

	it('con el JWKS caído, cinco logout tokens con kid inventados hacen UNA lectura del JWKS por minuto', async () => {
		idp.jwksStatus = 500;
		for (let i = 0; i < 5; i += 1) {
			const forged = signingKey(`kid-inventado-${i}`);
			await expect(client.validateLogoutToken(idp.logoutToken({ sub: 'x' }, forged))).rejects.toBeInstanceOf(OidcError);
		}
		expect(idp.calls.jwks).toBe(1);
		// Pasado el minuto se vuelve a intentar, y con Sumego de vuelta funciona.
		idp.jwksStatus = 200;
		clock.now += 61_000;
		await expect(client.validateLogoutToken(idp.logoutToken({ sub: 'x' }))).resolves.toMatchObject({ sub: 'x' });
		expect(idp.calls.jwks).toBe(2);
	});

	it('con el discovery caído, cinco intentos hacen UNA lectura del discovery por minuto', async () => {
		const discovery = `${ISSUER}/.well-known/openid-configuration`;
		idp.down = true;
		for (let i = 0; i < 5; i += 1) {
			await expect(client.authorizationUrl({ state: 's', nonce: 'n', codeChallenge: 'c' })).rejects.toMatchObject({ kind: 'transient' });
		}
		expect(outgoing.filter((url) => url === discovery)).toHaveLength(1);
		// Sumego vuelve, pero dentro del minuto no se le vuelve a preguntar.
		idp.down = false;
		await expect(client.authorizationUrl({ state: 's', nonce: 'n', codeChallenge: 'c' })).rejects.toMatchObject({ kind: 'transient' });
		expect(outgoing.filter((url) => url === discovery)).toHaveLength(1);
		clock.now += 61_000;
		await expect(client.authorizationUrl({ state: 's', nonce: 'n', codeChallenge: 'c' })).resolves.toContain('/oidc/auth');
		expect(outgoing.filter((url) => url === discovery)).toHaveLength(2);
	});
});

describe('la sesión de Sumego se comprueba cada hora en el refresh (M1)', () => {
	const HOUR = 60 * 60_000;

	it('el grant guarda el refresh de Sumego cifrado; dentro de la hora /token no le pregunta', async () => {
		const h = await harness();
		const session = await connect(h);
		const [grant] = await storedGrants(h);
		expect(grant!.sumegoRefresh).toBeDefined();
		expect(grant!.sumegoCheckedAt).toBe(START);
		const raw = await readFile(join(h.stateDir, 'oauth-store.json'), 'utf8');
		expect(raw).not.toContain(h.idp.liveRefreshOf(ANA)!);
		h.clock.now += HOUR - 1;
		expect((await token(h, { grant_type: 'refresh_token', refresh_token: session.refresh })).status).toBe(200);
		expect(h.idp.calls.refresh).toBe(0);
	});

	it('pasada la hora renueva en Sumego, guarda el refresh rotado y la hora, y no repite hasta la siguiente', async () => {
		const h = await harness();
		const session = await connect(h);
		const before = (await storedGrants(h))[0]!.sumegoRefresh!.ciphertext;
		h.clock.now += HOUR + 1;
		const first = await token(h, { grant_type: 'refresh_token', refresh_token: session.refresh });
		expect(first.status).toBe(200);
		expect(h.idp.calls.refresh).toBe(1);
		const [grant] = await storedGrants(h);
		expect(grant!.sumegoRefresh!.ciphertext).not.toBe(before);
		expect(grant!.sumegoCheckedAt).toBe(START + HOUR + 1);
		const { refresh_token: next } = (await first.json()) as { refresh_token: string };
		expect((await token(h, { grant_type: 'refresh_token', refresh_token: next })).status).toBe(200);
		expect(h.idp.calls.refresh).toBe(1);
	});

	it('si Sumego ya no renueva (cuenta suspendida, logout perdido) el refresh da invalid_grant y se revoca todo', async () => {
		const h = await harness();
		const session = await connect(h);
		h.idp.forgetRefreshOf(ANA);
		h.clock.now += HOUR + 1;
		const response = await token(h, { grant_type: 'refresh_token', refresh_token: session.refresh });
		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: string }).error).toBe('invalid_grant');
		expect(await h.service.resolveAccessToken(session.access)).toBeUndefined();
		expect(h.lumbre.revoked).toHaveLength(1);
		expect(await storedGrants(h)).toEqual([]);
	});

	it.each([
		['un 503', (idp: FakeSumego) => { idp.refreshStatus = 503; }],
		['un 429', (idp: FakeSumego) => { idp.refreshStatus = 429; }],
		['Sumego caído', (idp: FakeSumego) => { idp.down = true; }]
	])('con %s no se corta nada y se reintenta en el siguiente /token', async (_name, breakSumego) => {
		const h = await harness();
		const session = await connect(h);
		h.clock.now += HOUR + 1;
		// El discovery ya está en caché del login; caído, solo falla el refresh.
		breakSumego(h.idp);
		const first = await token(h, { grant_type: 'refresh_token', refresh_token: session.refresh });
		expect(first.status).toBe(200);
		expect((await storedGrants(h))[0]!.sumegoCheckedAt).toBe(START);
		h.idp.refreshStatus = 200;
		h.idp.down = false;
		const { refresh_token: next } = (await first.json()) as { refresh_token: string };
		expect((await token(h, { grant_type: 'refresh_token', refresh_token: next })).status).toBe(200);
		expect((await storedGrants(h))[0]!.sumegoCheckedAt).toBe(START + HOUR + 1);
		expect(h.lumbre.revoked).toHaveLength(0);
	});

	it('dos /token a la vez sobre el mismo grant hacen UNA renovación en Sumego, sin reusar su refresh', async () => {
		const h = await harness();
		const session = await connect(h);
		h.clock.now += HOUR + 1;
		const insideSumego = deferred();
		const release = deferred();
		h.idp.beforeRefreshResponse = async () => {
			insideSumego.resolve();
			await release.promise;
		};
		// La segunda petición suelta a Sumego en cuanto se suma a la renovación
		// en vuelo. Si no se sumara y fuera a Sumego por su cuenta, entraría
		// aquí otra vez y la soltaría igual: el test no se cuelga en ningún caso.
		h.hooks.renewalJoined = () => release.resolve();
		const first = token(h, { grant_type: 'refresh_token', refresh_token: session.refresh });
		await insideSumego.promise;
		h.idp.beforeRefreshResponse = async () => release.resolve();
		const second = token(h, { grant_type: 'refresh_token', refresh_token: session.refresh });
		const [a, b] = await Promise.all([first, second]);
		expect(h.idp.calls.refresh).toBe(1);
		expect(h.idp.calls.refreshReused).toBe(0);
		// La primera rota; la segunda presentaba el MISMO refresh del relé, y eso
		// es un replay (RFC 6749), que ya revocaba la familia antes de Sumego.
		expect([a.status, b.status].sort()).toEqual([200, 400]);
	});

	it('al revocar un grant (/revoke o logout) se revoca también su refresh en Sumego', async () => {
		const h = await harness();
		const viaRevoke = await connect(h, { ...ANA, sid: 'sid-revoke' });
		await connect(h, { ...ANA, sid: 'sid-logout' });
		const refreshRevoke = h.idp.liveRefreshOf({ ...ANA, sid: 'sid-revoke' })!;
		const refreshLogout = h.idp.liveRefreshOf({ ...ANA, sid: 'sid-logout' })!;
		const revoked = await fetch(`${h.baseUrl}/revoke`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ token: viaRevoke.refresh, client_id: CLAUDE_CLIENT })
		});
		expect(revoked.status).toBe(200);
		expect((await logout(h, h.idp.logoutToken({ sid: 'sid-logout' }))).status).toBe(200);
		await h.service.whenWritesSettled();
		expect(h.idp.revokedRefresh.sort()).toEqual([refreshLogout, refreshRevoke].sort());
	});

	it('sin revocation_endpoint en el discovery, revocar el grant no falla ni sale a Sumego', async () => {
		const h = await harness();
		h.idp.revocationEndpoint = false;
		const session = await connect(h);
		const revoked = await fetch(`${h.baseUrl}/revoke`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ token: session.refresh, client_id: CLAUDE_CLIENT })
		});
		expect(revoked.status).toBe(200);
		await h.service.whenWritesSettled();
		expect(h.idp.revokedRefresh).toEqual([]);
		expect(await h.service.resolveAccessToken(session.access)).toBeUndefined();
	});

	it('«Cancelar» revoca en Sumego el refresh que ya no va a usar nadie', async () => {
		const h = await harness();
		const page = await reachConsent(h);
		const refresh = h.idp.liveRefreshOf(ANA)!;
		expect((await consent(h, { request: page.request, csrf: page.csrf, decision: 'deny' }, page.cookie)).status).toBe(302);
		await h.service.whenWritesSettled();
		expect(h.idp.revokedRefresh).toEqual([refresh]);
	});
});

describe('el consentimiento caduca antes de que Lumbre rechace el ID token (M2)', () => {
	it('la página avisa del plazo, y a los 4 min 30 s del ID token ya no canjea', async () => {
		const h = await harness();
		const page = await reachConsent(h);
		expect(page.html).toContain(SUMEGO_PERSON_MESSAGES.consentDeadline);
		h.clock.now += 5 * 60_000 - 30_000;
		const late = await consent(h, { request: page.request, csrf: page.csrf, decision: 'allow' }, page.cookie);
		expect(late.status).toBe(403);
		expect(await late.text()).toContain(SUMEGO_PERSON_MESSAGES.consentInvalid);
		expect(h.lumbre.sumegoExchanges).toHaveLength(0);
	});

	it('un segundo antes de ese plazo todavía canjea', async () => {
		const h = await harness();
		const page = await reachConsent(h);
		h.clock.now += 5 * 60_000 - 30_000 - 1_000;
		expect((await consent(h, { request: page.request, csrf: page.csrf, decision: 'allow' }, page.cookie)).status).toBe(302);
		expect(h.lumbre.sumegoExchanges).toHaveLength(1);
	});
});
