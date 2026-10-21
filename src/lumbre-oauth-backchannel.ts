export const LUMBRE_APP_ORIGIN = 'https://app.lumbre.pro';
export const LUMBRE_OAUTH_CALLBACK = 'https://mcp.lumbre.pro/oauth/lumbre/callback';

const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 3_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRANSACTION_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
const ACCESS_TOKEN_PATTERN = /^[a-f0-9]{64}$/;

export type BackchannelFailureKind = 'invalid' | 'transient';

/**
 * Códigos de error del canje con identidad de Sumego (`{ code }` en el
 * cuerpo de un 4xx/5xx de `/api/integrations/lumbre-mcp/sumego/exchange`). Lista
 * CERRADA: un `code` que no esté aquí se trata como si no viniera, para que
 * nada que mande Lumbre llegue sin filtrar a la página de la persona.
 */
export const SUMEGO_EXCHANGE_ERROR_CODES = [
	'invalid_token',
	'unknown_account',
	'account_pending',
	'account_suspended',
	'account_rejected',
	'transaction_not_found',
	'token_reused',
	'sumego_unavailable',
	'invalid_request',
	'payload_too_large',
	'rate_limited'
] as const;

export type SumegoExchangeErrorCode = (typeof SUMEGO_EXCHANGE_ERROR_CODES)[number];

export class BackchannelError extends Error {
	constructor(
		readonly kind: BackchannelFailureKind,
		message: string,
		/** Solo en el canje con Sumego, y solo si es de la lista cerrada. */
		readonly code?: SumegoExchangeErrorCode
	) {
		super(message);
	}
}

export interface CreateAuthorizationRequest {
	transactionId: string;
	clientId: string;
	clientName: string;
	resource: string;
	scope: string;
	callbackUri: string;
}

export interface CreatedAuthorizationRequest {
	authorizationUrl: string;
	requestId: string;
	expiresAt: number;
}

export interface ExchangedCredential {
	credentialId: string;
	accessToken: string;
	tokenType: 'Bearer';
	resource: string;
	scope: string;
}

export interface IntrospectionResult {
	active: boolean;
	credentialId?: string;
	clientId?: string;
	resource?: string;
	scope?: string;
}

/**
 * Solicitud con login en Sumego: la misma de siempre más dos campos. Lumbre
 * crea su registro igual, pero no manda a la persona a su página: la
 * identidad la pone el ID token de Sumego, y `sumegoNonceSha256` ata ese
 * registro al `nonce` que el relé manda a Sumego (Lumbre lo vuelve a
 * comprobar en el canje, con el ID token en la mano).
 */
export interface CreateSumegoAuthorizationRequest extends CreateAuthorizationRequest {
	identityProvider: 'sumego';
	/** SHA-256 del `nonce`, base64url sin relleno. */
	sumegoNonceSha256: string;
}

/** Con Sumego la respuesta puede traer `authorizationUrl` o no; no se usa. */
export interface CreatedSumegoAuthorizationRequest {
	requestId: string;
	expiresAt: number;
}

/** Cuerpo de `POST /api/integrations/lumbre-mcp/sumego/exchange`. */
export interface SumegoExchangeRequest {
	requestId: string;
	transactionId: string;
	idToken: string;
	clientId: string;
	resource: string;
	scope: string;
}

export interface LumbreBackchannelApi {
	ensureConfigured(): void;
	createAuthorizationRequest(request: CreateAuthorizationRequest): Promise<CreatedAuthorizationRequest>;
	exchange(requestId: string, transactionId: string): Promise<ExchangedCredential>;
	introspect(accessToken: string): Promise<IntrospectionResult>;
	revoke(accessToken: string): Promise<void>;
	createSumegoAuthorizationRequest(request: CreateSumegoAuthorizationRequest): Promise<CreatedSumegoAuthorizationRequest>;
	exchangeSumegoIdentity(request: SumegoExchangeRequest): Promise<ExchangedCredential>;
}

export interface LumbreBackchannelOptions {
	baseUrl?: string;
	secret?: string;
	fetch?: typeof fetch;
	timeoutMs?: number;
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const own = Object.keys(value);
	return own.length === keys.length && keys.every((key) => own.includes(key));
}

function validateBaseUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error('LUMBRE_APP_BASE_URL inválida');
	}
	if (
		url.origin !== LUMBRE_APP_ORIGIN ||
		url.pathname !== '/' ||
		url.search !== '' ||
		url.hash !== '' ||
		url.username !== '' ||
		url.password !== ''
	) {
		throw new Error(`LUMBRE_APP_BASE_URL debe ser exactamente ${LUMBRE_APP_ORIGIN}`);
	}
	return LUMBRE_APP_ORIGIN;
}

export function isValidRequestId(value: string): boolean {
	return UUID_PATTERN.test(value);
}

export function validateAuthorizationUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new BackchannelError('invalid', 'Lumbre devolvió una URL de autorización inválida.');
	}
	if (
		url.protocol !== 'https:' ||
		url.origin !== LUMBRE_APP_ORIGIN ||
		url.pathname !== '/integrations/lumbre-mcp' ||
		url.username !== '' ||
		url.password !== '' ||
		url.port !== '' ||
		url.hash !== '' ||
		[...url.searchParams.keys()].length !== 1 ||
		url.searchParams.getAll('request').length !== 1 ||
		!isValidRequestId(url.searchParams.get('request') ?? '')
	) {
		throw new BackchannelError('invalid', 'Lumbre devolvió una URL de autorización fuera del contrato.');
	}
	return url.toString();
}

async function readBoundedJson(response: Response): Promise<unknown> {
	const declared = Number(response.headers.get('content-length'));
	if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
		throw new BackchannelError('invalid', 'La respuesta de Lumbre supera el límite permitido.');
	}
	const contentType = (response.headers.get('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase();
	if (contentType !== 'application/json') {
		await response.body?.cancel().catch(() => undefined);
		throw new BackchannelError('invalid', 'Lumbre devolvió una respuesta que no es JSON.');
	}
	if (!response.body) throw new BackchannelError('invalid', 'Lumbre devolvió una respuesta vacía.');
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > MAX_RESPONSE_BYTES) {
			await reader.cancel();
			throw new BackchannelError('invalid', 'La respuesta de Lumbre supera el límite permitido.');
		}
		chunks.push(value);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
	} catch {
		throw new BackchannelError('invalid', 'Lumbre devolvió JSON inválido.');
	}
}

/** Respuesta 200 de un canje (el de siempre y el de Sumego): exacta. */
function exchangedCredential(body: unknown): ExchangedCredential {
	if (!exactObject(body, ['credentialId', 'accessToken', 'tokenType', 'resource', 'scope'])) {
		throw new BackchannelError('invalid', 'Respuesta de canje fuera de contrato.');
	}
	if (
		typeof body.credentialId !== 'string' ||
		!isValidRequestId(body.credentialId) ||
		typeof body.accessToken !== 'string' ||
		!ACCESS_TOKEN_PATTERN.test(body.accessToken) ||
		body.tokenType !== 'Bearer' ||
		typeof body.resource !== 'string' ||
		typeof body.scope !== 'string'
	) {
		throw new BackchannelError('invalid', 'Respuesta de canje fuera de contrato.');
	}
	return body as unknown as ExchangedCredential;
}

/**
 * `code` del cuerpo de un error, si es uno de la lista cerrada. Nunca lanza:
 * un cuerpo raro, enorme o que no es JSON solo significa «sin código».
 */
async function errorCodeOf(response: Response): Promise<SumegoExchangeErrorCode | undefined> {
	try {
		const body = await readBoundedJson(response);
		const code = body && typeof body === 'object' && !Array.isArray(body) ? (body as { code?: unknown }).code : undefined;
		return (SUMEGO_EXCHANGE_ERROR_CODES as readonly unknown[]).includes(code)
			? (code as SumegoExchangeErrorCode)
			: undefined;
	} catch {
		return undefined;
	}
}

/** Prefijo del canal servidor con Lumbre, común a todas sus rutas: las de
 *  siempre (`requests`, `exchange`, `introspect`, `revoke`) y el canje con
 *  Sumego (`sumego/exchange`). Las rutas se escriben siempre a partir de él,
 *  nunca como literal: el primer contrato del canje con Sumego citaba una ruta
 *  sin el segmento `lumbre-mcp`, que en Lumbre habría dado 404. */
const LUMBRE_MCP_PATH = '/api/integrations/lumbre-mcp/';

/** Ruta del canje con Sumego (main de Lumbre e0fdd69c7 + 6cfe83b25). */
export const SUMEGO_EXCHANGE_PATH = `${LUMBRE_MCP_PATH}sumego/exchange`;

export class LumbreBackchannel implements LumbreBackchannelApi {
	private readonly baseUrl: string;
	private readonly secret: string;
	private readonly fetchFn: typeof fetch;
	private readonly timeoutMs: number;

	constructor(options: LumbreBackchannelOptions = {}) {
		this.baseUrl = validateBaseUrl(options.baseUrl?.trim() || LUMBRE_APP_ORIGIN);
		this.secret = options.secret?.trim() ?? '';
		this.fetchFn = options.fetch ?? globalThis.fetch;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	ensureConfigured(): void {
		if (this.secret.length < 32 || this.secret.length > 512 || /[\r\n]/.test(this.secret)) {
			throw new Error('LUMBRE_MCP_BACKCHANNEL_SECRET debe tener entre 32 y 512 caracteres y no contener saltos de línea');
		}
	}

	async createAuthorizationRequest(request: CreateAuthorizationRequest): Promise<CreatedAuthorizationRequest> {
		if (!TRANSACTION_PATTERN.test(request.transactionId)) {
			throw new BackchannelError('invalid', 'transactionId local fuera de contrato.');
		}
		const body = await this.post(`${LUMBRE_MCP_PATH}requests`, request);
		if (!exactObject(body, ['authorizationUrl', 'requestId', 'expiresAt'])) {
			throw new BackchannelError('invalid', 'Respuesta de creación fuera de contrato.');
		}
		const requestId = body.requestId;
		const expiresAtValue = body.expiresAt;
		const expiresAt = typeof expiresAtValue === 'string' ? Date.parse(expiresAtValue) : NaN;
		if (typeof requestId !== 'string' || !isValidRequestId(requestId) || !Number.isFinite(expiresAt)) {
			throw new BackchannelError('invalid', 'Respuesta de creación fuera de contrato.');
		}
		return {
			authorizationUrl: validateAuthorizationUrl(String(body.authorizationUrl)),
			requestId,
			expiresAt
		};
	}

	async exchange(requestId: string, transactionId: string): Promise<ExchangedCredential> {
		return exchangedCredential(await this.post(`${LUMBRE_MCP_PATH}exchange`, { requestId, transactionId }));
	}

	/**
	 * Abre la solicitud en Lumbre para un login con Sumego. Mismo endpoint y
	 * mismos campos que `createAuthorizationRequest`, más `identityProvider` y
	 * `sumegoNonceSha256`. La respuesta trae `requestId` y `expiresAt`, y
	 * puede traer `authorizationUrl`: con Sumego no se usa (la persona va a
	 * id.lumbre.pro, no a la página de Lumbre), así que ni se valida.
	 */
	async createSumegoAuthorizationRequest(
		request: CreateSumegoAuthorizationRequest
	): Promise<CreatedSumegoAuthorizationRequest> {
		if (!TRANSACTION_PATTERN.test(request.transactionId)) {
			throw new BackchannelError('invalid', 'transactionId local fuera de contrato.');
		}
		if (!/^[A-Za-z0-9_-]{43}$/.test(request.sumegoNonceSha256)) {
			throw new BackchannelError('invalid', 'Hash del nonce fuera de contrato.');
		}
		const body = await this.post(`${LUMBRE_MCP_PATH}requests`, request);
		if (
			!exactObject(body, ['requestId', 'expiresAt']) &&
			!exactObject(body, ['authorizationUrl', 'requestId', 'expiresAt'])
		) {
			throw new BackchannelError('invalid', 'Respuesta de creación fuera de contrato.');
		}
		const requestId = body.requestId;
		const expiresAt = typeof body.expiresAt === 'string' ? Date.parse(body.expiresAt) : NaN;
		if (typeof requestId !== 'string' || !isValidRequestId(requestId) || !Number.isFinite(expiresAt)) {
			throw new BackchannelError('invalid', 'Respuesta de creación fuera de contrato.');
		}
		return { requestId, expiresAt };
	}

	/**
	 * Canjea la identidad de Sumego por la credencial dedicada de la API de
	 * Lumbre. Lumbre vuelve a validar el ID token (firma, `aud`, `nonce`
	 * contra el hash que se le dio al crear la solicitud) y busca la cuenta
	 * por su `sub`. El 200 es idéntico al de `exchange`.
	 *
	 * Ruta: `SUMEGO_EXCHANGE_PATH`, `POST /api/integrations/lumbre-mcp/sumego/exchange`,
	 * con el mismo prefijo que el resto del canal (main de Lumbre e0fdd69c7 +
	 * 6cfe83b25). Errores, con `{ code }` en el cuerpo: 400
	 * `invalid_token` (también si `clientId`, `resource` o `scope` no casan
	 * con la solicitud), `unknown_account` o `invalid_request` (cuerpo roto o
	 * con claves de más: fallo NUESTRO); 401 secreto del canal malo, con el
	 * cuerpo de error de SvelteKit y SIN `code`; 403 `account_pending`,
	 * `account_suspended` o `account_rejected`; 404 `transaction_not_found`;
	 * 409 `token_reused`; 413 `payload_too_large`; 429 `rate_limited` (10
	 * intentos por minuto y solicitud); 503 `sumego_unavailable` si a Lumbre
	 * le falla el discovery o el JWKS de Sumego. 4xx salvo 429 = `invalid`;
	 * 5xx, 429 y timeout = `transient`. El `code` viaja en el
	 * `BackchannelError` solo si es de la lista cerrada
	 * (`SUMEGO_EXCHANGE_ERROR_CODES`). Si el contrato cambia, se ajusta AQUÍ
	 * y en `sumego-messages.ts`.
	 *
	 * Un `invalid_token` de Lumbre deja SU solicitud viva para otro ID token,
	 * pero aquí no se reintenta: la transacción y el consentimiento del relé
	 * ya se consumieron, y el flujo acaba con su página de error.
	 */
	async exchangeSumegoIdentity(request: SumegoExchangeRequest): Promise<ExchangedCredential> {
		if (!TRANSACTION_PATTERN.test(request.transactionId) || !isValidRequestId(request.requestId)) {
			throw new BackchannelError('invalid', 'Canje con Sumego fuera de contrato.');
		}
		return exchangedCredential(
			await this.post(SUMEGO_EXCHANGE_PATH, request, { readErrorCode: true })
		);
	}

	async introspect(accessToken: string): Promise<IntrospectionResult> {
		const body = await this.post(`${LUMBRE_MCP_PATH}introspect`, { accessToken });
		if (exactObject(body, ['active']) && body.active === false) return { active: false };
		if (
			!exactObject(body, ['active', 'credentialId', 'clientId', 'resource', 'scope']) ||
			body.active !== true ||
			typeof body.credentialId !== 'string' ||
			!isValidRequestId(body.credentialId) ||
			typeof body.clientId !== 'string' ||
			typeof body.resource !== 'string' ||
			typeof body.scope !== 'string'
		) {
			throw new BackchannelError('invalid', 'Respuesta de introspección fuera de contrato.');
		}
		return body as unknown as IntrospectionResult;
	}

	async revoke(accessToken: string): Promise<void> {
		const body = await this.post(`${LUMBRE_MCP_PATH}revoke`, { accessToken });
		if (!exactObject(body, ['ok']) || body.ok !== true) {
			throw new BackchannelError('invalid', 'Respuesta de revocación fuera de contrato.');
		}
	}

	/** `path` es la ruta absoluta en Lumbre; el origen es siempre el cerrado
	 *  de `LUMBRE_APP_BASE_URL`. `readErrorCode` lee el `{ code }` de un error
	 *  (solo el canje con Sumego lo manda). */
	private async post(path: string, body: unknown, options: { readErrorCode?: boolean } = {}): Promise<unknown> {
		this.ensureConfigured();
		let response: Response;
		try {
			response = await this.fetchFn(`${this.baseUrl}${path}`, {
				method: 'POST',
				redirect: 'error',
				signal: AbortSignal.timeout(this.timeoutMs),
				headers: {
					authorization: `Bearer ${this.secret}`,
					accept: 'application/json',
					'content-type': 'application/json'
				},
				body: JSON.stringify(body)
			});
		} catch {
			throw new BackchannelError('transient', 'No se pudo contactar con Lumbre.');
		}
		if (response.status < 200 || response.status >= 300) {
			const code = options.readErrorCode ? await errorCodeOf(response) : undefined;
			await response.body?.cancel().catch(() => undefined);
			throw new BackchannelError(
				response.status >= 500 || response.status === 429 ? 'transient' : 'invalid',
				response.status >= 500 || response.status === 429
					? 'Lumbre no está disponible temporalmente.'
					: 'Lumbre rechazó la operación.',
				code
			);
		}
		return await readBoundedJson(response);
	}
}
