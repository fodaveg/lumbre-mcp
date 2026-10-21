import type { Server } from 'node:http';

/**
 * Ciclo de vida del PROCESO del relé HTTP (`node dist/http.js`): por qué no
 * arranca y cómo se apaga. Vive aparte de `http.ts` para que sus dos piezas
 * se prueben sin abrir el listener real.
 */

/**
 * Causa de que el relé no arranque, de un conjunto FIJO. Es lo único que se
 * escribe junto a «estado OAuth no disponible»: nunca `error.message`, porque
 * un `SyntaxError` de `JSON.parse` en Node 22 copia un trozo del texto que no
 * pudo leer (el store, con credenciales cifradas), y otros mensajes llevan
 * rutas.
 *
 *  · `clave_ausente`: hay `oauth-store.json` y falta `oauth.key`.
 *  · `clave_invalida`: la clave (la del fichero o la inyectada) no mide 32
 *    bytes o no descifra el store.
 *  · `store_json_invalido`: el store no es JSON (truncado, editado a mano).
 *  · `store_incoherente`: JSON válido que no cumple el contrato (campos,
 *    referencias cruzadas, grants fuera de contrato).
 *  · `store_version`: store provisional v1/v2, que se rechaza sin tocarlo.
 *  · `secreto_backchannel`: `LUMBRE_MCP_BACKCHANNEL_SECRET` falta o no mide
 *    entre 32 y 512 caracteres.
 *  · `app_base_url`: `LUMBRE_APP_BASE_URL` no es exactamente la de Lumbre.
 *  · `proveedor_login`: `LUMBRE_MCP_LOGIN_PROVIDER` no es `lumbre` ni `sumego`.
 *  · `oidc_config`: alguna `LUMBRE_MCP_OIDC_*` inválida, o `sumego` sin
 *    `LUMBRE_MCP_OIDC_CLIENT_SECRET` (el valor no sale nunca).
 *  · `io:<código>`: error del sistema de ficheros (`io:EACCES`, `io:ENOSPC`…).
 *  · `desconocido`: nada de lo anterior.
 */
export type StartupFailureCause =
	| 'clave_ausente'
	| 'clave_invalida'
	| 'store_json_invalido'
	| 'store_incoherente'
	| 'store_version'
	| 'secreto_backchannel'
	| 'app_base_url'
	| 'proveedor_login'
	| 'oidc_config'
	| `io:${string}`
	| 'desconocido';

/**
 * Clasifica el error de `createOAuthService()`/`ensureReady()`. El mensaje
 * se MIRA para clasificar, pero no sale de aquí: lo devuelto es siempre uno
 * de los literales de `StartupFailureCause`, y el código de `io:` solo pasa
 * si tiene forma de errno (`E` + mayúsculas y dígitos).
 *
 * Casa con los mensajes literales de `oauth.ts` y
 * `lumbre-oauth-backchannel.ts`; `http-lifecycle.test.ts` provoca cada causa
 * con el `OAuthService` real, así que si un mensaje cambia, el test lo canta.
 */
export function classifyStartupFailure(error: unknown): StartupFailureCause {
	if (error instanceof SyntaxError) return 'store_json_invalido';
	const code = (error as { code?: unknown } | null)?.code;
	if (typeof code === 'string' && /^E[A-Z0-9]{1,15}$/.test(code)) return `io:${code}`;
	const message = error instanceof Error ? error.message : '';
	if (message.includes('presente sin su clave')) return 'clave_ausente';
	if (
		/^clave (OAuth )?inválida$/.test(message) ||
		message.includes('encryptionKey debe tener 32 bytes') ||
		message.includes('unable to authenticate data')
	) {
		return 'clave_invalida';
	}
	if (message.includes('v1/v2')) return 'store_version';
	if (message.includes('LUMBRE_MCP_BACKCHANNEL_SECRET')) return 'secreto_backchannel';
	if (message.includes('LUMBRE_APP_BASE_URL')) return 'app_base_url';
	if (message.includes('LUMBRE_MCP_LOGIN_PROVIDER') && !message.includes('LUMBRE_MCP_OIDC_')) return 'proveedor_login';
	if (message.includes('LUMBRE_MCP_OIDC_')) return 'oidc_config';
	if (
		/OAuth (inválid[oa]|incoherente|fuera de contrato)/.test(message) ||
		/(credencial upstream|transacción OAuth|outbox OAuth) inválida/.test(message) ||
		// `validateClientIdUrl` lanza un `OAuthError` (`invalid_client`) cuando
		// un grant guardado trae un `client_id` que ya no se admite.
		code === 'invalid_client'
	) {
		return 'store_incoherente';
	}
	return 'desconocido';
}

/**
 * Plazo del apagado ordenado. Por debajo de `stop_grace_period: 15s` de
 * `deploy/compose.yml` con margen: si el relé no ha terminado en 10 s, corta
 * él las conexiones que queden y sale, antes de que Docker mande SIGKILL.
 * Un `tools/call` espera como mucho 30 s al upstream (`lumbre-client.ts`),
 * así que una llamada muy lenta sí puede cortarse; lo normal (decenas de
 * milisegundos) termina dentro.
 */
export const SHUTDOWN_TIMEOUT_MS = 10_000;

/** Cada cuánto se vuelven a cerrar las conexiones keep-alive que se quedan
 *  ociosas mientras se drena: `server.close()` solo cierra las que lo están
 *  en ese instante, y una que termina su respuesta después seguiría abierta
 *  hasta su `keepAliveTimeout`. */
const IDLE_SWEEP_MS = 100;

/** Lo que el apagado necesita del proceso. Inyectable en los tests. */
export interface SignalSource {
	once(event: NodeJS.Signals, listener: () => void): unknown;
	removeListener(event: NodeJS.Signals, listener: () => void): unknown;
}

export interface GracefulShutdownOptions {
	/** Default `SHUTDOWN_TIMEOUT_MS`. */
	timeoutMs?: number;
	/** Trabajo a esperar tras cerrar el servidor (la cola de escritura del
	 *  store OAuth). Un rechazo no impide salir. */
	drain?: () => Promise<void>;
	/** Default `['SIGTERM', 'SIGINT']`. */
	signals?: NodeJS.Signals[];
	/** Default `process`. */
	signalSource?: SignalSource;
	/** Default `process.exit`. */
	exit?: (code: number) => void;
	/** Default `console.error`. */
	log?: (line: string) => void;
}

/**
 * Apagado ordenado ante SIGTERM/SIGINT: deja de aceptar conexiones
 * (`server.close()`), cierra las ociosas, espera a que acaben las peticiones
 * en vuelo y a que se vacíe la cola de escritura (`drain`), y sale con 0. Si
 * en `timeoutMs` no ha acabado, corta lo que quede
 * (`closeAllConnections()`) y sale con 1. Una segunda señal sale en el acto.
 *
 * Sin esto, con Node como PID 1 en el contenedor, SIGTERM no hacía nada:
 * Docker esperaba 10 s y mandaba SIGKILL a mitad de lo que hubiera en vuelo
 * (medido en el deploy del 8 oct 2026,
 * `docs/audit-recuperacion-despliegue-20261010.md`, H3), y fuera de Docker
 * las 50 peticiones en vuelo de la sonda acababan en ECONNRESET.
 *
 * Devuelve la función que retira los manejadores (para los tests).
 */
export function installGracefulShutdown(server: Server, options: GracefulShutdownOptions = {}): () => void {
	const timeoutMs = options.timeoutMs ?? SHUTDOWN_TIMEOUT_MS;
	const signals = options.signals ?? ['SIGTERM', 'SIGINT'];
	const source: SignalSource = options.signalSource ?? process;
	const exit = options.exit ?? ((code: number) => process.exit(code));
	const log = options.log ?? ((line: string) => console.error(line));
	let shuttingDown = false;
	let finished = false;
	let deadline: NodeJS.Timeout | undefined;
	let idleSweep: NodeJS.Timeout | undefined;

	/** Sale UNA vez, y sin dejar temporizadores vivos detrás. */
	const finish = (code: number, line: string): void => {
		if (finished) return;
		finished = true;
		clearTimeout(deadline);
		clearInterval(idleSweep);
		log(line);
		exit(code);
	};

	const onSignal = (signal: NodeJS.Signals): void => {
		if (shuttingDown) {
			finish(1, `[lumbre-mcp-http] ${signal} durante el apagado: salida inmediata`);
			return;
		}
		shuttingDown = true;
		// Una segunda señal igual tiene que encontrar manejador: `once` ya
		// retiró el de esta (las demás conservan el suyo).
		source.once(signal, handlers.get(signal)!);
		log(`[lumbre-mcp-http] ${signal}: apagado ordenado (plazo ${timeoutMs} ms)`);

		const closed = new Promise<void>((resolve) => server.close(() => resolve()));
		server.closeIdleConnections();
		idleSweep = setInterval(() => server.closeIdleConnections(), IDLE_SWEEP_MS);
		idleSweep.unref();
		deadline = setTimeout(() => {
			if (finished) return;
			server.closeAllConnections();
			finish(1, '[lumbre-mcp-http] apagado: plazo agotado, se cortan las conexiones que quedaban');
		}, timeoutMs);
		void closed
			.then(() => options.drain?.())
			.catch(() => undefined)
			.then(() => finish(0, '[lumbre-mcp-http] apagado: sin peticiones en vuelo ni escrituras pendientes'));
	};

	const handlers = new Map<NodeJS.Signals, () => void>();
	for (const name of signals) {
		const handler = (): void => onSignal(name);
		handlers.set(name, handler);
		source.once(name, handler);
	}
	return () => {
		for (const [name, handler] of handlers) source.removeListener(name, handler);
	};
}
