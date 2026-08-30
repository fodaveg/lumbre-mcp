export const LUMBRE_APP_ORIGIN = 'https://app.lumbre.pro';
export const LUMBRE_OAUTH_CALLBACK = 'https://mcp.lumbre.pro/oauth/lumbre/callback';

const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 3_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRANSACTION_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
const ACCESS_TOKEN_PATTERN = /^[a-f0-9]{64}$/;

export type BackchannelFailureKind = 'invalid' | 'transient';

export class BackchannelError extends Error {
	constructor(
		readonly kind: BackchannelFailureKind,
		message: string
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

export interface LumbreBackchannelApi {
	ensureConfigured(): void;
	createAuthorizationRequest(request: CreateAuthorizationRequest): Promise<CreatedAuthorizationRequest>;
	exchange(requestId: string, transactionId: string): Promise<ExchangedCredential>;
	introspect(accessToken: string): Promise<IntrospectionResult>;
	revoke(accessToken: string): Promise<void>;
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
		const body = await this.post('requests', request);
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
		const body = await this.post('exchange', { requestId, transactionId });
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

	async introspect(accessToken: string): Promise<IntrospectionResult> {
		const body = await this.post('introspect', { accessToken });
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
		const body = await this.post('revoke', { accessToken });
		if (!exactObject(body, ['ok']) || body.ok !== true) {
			throw new BackchannelError('invalid', 'Respuesta de revocación fuera de contrato.');
		}
	}

	private async post(path: 'requests' | 'exchange' | 'introspect' | 'revoke', body: unknown): Promise<unknown> {
		this.ensureConfigured();
		let response: Response;
		try {
			response = await this.fetchFn(`${this.baseUrl}/api/integrations/lumbre-mcp/${path}`, {
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
			await response.body?.cancel().catch(() => undefined);
			throw new BackchannelError(
				response.status >= 500 || response.status === 429 ? 'transient' : 'invalid',
				response.status >= 500 || response.status === 429
					? 'Lumbre no está disponible temporalmente.'
					: 'Lumbre rechazó la operación.'
			);
		}
		return await readBoundedJson(response);
	}
}
