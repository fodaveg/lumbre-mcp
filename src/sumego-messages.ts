import { BackchannelError, type SumegoExchangeErrorCode } from './lumbre-oauth-backchannel.js';

/**
 * TODO lo que el login con Sumego le dice a la PERSONA, en un solo sitio.
 *
 * Son frases cerradas: nada de lo que manden Lumbre o Sumego (un `code`, un
 * `error_description`, un cuerpo) llega tal cual a la página. Los códigos de
 * Lumbre solo ELIGEN la frase. Y los fallos que son nuestros (un cuerpo mal
 * formado, el secreto del canal, un contrato roto) no se le explican a la
 * persona, que no puede hacer nada con eso: reciben la genérica, y el
 * detalle va al log del servidor (`exchangeFailure`).
 */
export const SUMEGO_PERSON_MESSAGES = {
	// Canje con Lumbre, por `code`.
	invalidToken: 'No se pudo confirmar tu identidad. Vuelve a conectar desde la aplicación.',
	unknownAccount: 'No hay ninguna cuenta de Lumbre con este usuario.',
	accountPending: 'Tu cuenta de Lumbre está pendiente de aprobación.',
	accountSuspended: 'Tu cuenta de Lumbre está suspendida.',
	accountRejected: 'Tu solicitud de cuenta de Lumbre no fue aprobada.',
	transactionNotFound: 'La autorización ha caducado. Vuelve a conectar desde la aplicación.',
	tokenReused: 'Esta autorización ya se usó. Vuelve a conectar desde la aplicación.',
	accountsUnavailable: 'El servicio de cuentas no responde. Inténtalo en un rato.',
	lumbreUnavailable: 'Lumbre no está disponible ahora mismo. Inténtalo de nuevo en unos minutos.',
	generic: 'No se pudo completar la conexión con Lumbre. Vuelve a intentarlo desde la aplicación.',
	// Vuelta de Sumego y consentimiento.
	wrongIssuer: 'La respuesta no viene del servicio de cuentas esperado.',
	identityRejected: 'El servicio de cuentas no pudo confirmar tu identidad. Vuelve a conectar desde la aplicación.',
	otherBrowser: 'Esta autorización se abrió en otro navegador. Vuelve a conectar desde la aplicación.',
	expired: 'La autorización ha caducado, ya se usó o no existe. Vuelve a conectar desde la aplicación.',
	consentInvalid: 'La confirmación ha caducado, ya se usó o no corresponde a esta autorización.',
	consentMalformed: 'Confirmación inválida.'
} as const;

export type SumegoPersonMessage = keyof typeof SUMEGO_PERSON_MESSAGES;

/** Qué se enseña por cada `code` del canje de Lumbre, y con qué estado HTTP.
 *  `ourFault`: el fallo es del relé o de su configuración, no de la persona. */
const EXCHANGE_CODES: Record<SumegoExchangeErrorCode, { status: number; message: SumegoPersonMessage; ourFault?: true }> = {
	invalid_token: { status: 400, message: 'invalidToken' },
	unknown_account: { status: 403, message: 'unknownAccount' },
	account_pending: { status: 403, message: 'accountPending' },
	account_suspended: { status: 403, message: 'accountSuspended' },
	account_rejected: { status: 403, message: 'accountRejected' },
	transaction_not_found: { status: 400, message: 'transactionNotFound' },
	token_reused: { status: 400, message: 'tokenReused' },
	sumego_unavailable: { status: 503, message: 'accountsUnavailable' },
	invalid_request: { status: 502, message: 'generic', ourFault: true },
	payload_too_large: { status: 502, message: 'generic', ourFault: true }
};

export interface ExchangeFailure {
	status: number;
	message: string;
	/** Clave de la frase elegida, para los tests. */
	key: SumegoPersonMessage;
	/** Línea para el log del servidor si el fallo es nuestro; sin datos de
	 *  nadie, solo el estado o el código. */
	log?: string;
}

/**
 * Traduce un fallo de `exchangeSumegoIdentity` a lo que ve la persona.
 *   · Con `code` de la lista: su frase.
 *   · Transitorio sin `code` (5xx, 429, timeout): Lumbre no disponible.
 *   · Lo demás (401 del secreto, 413 sin código, un 200 fuera de contrato):
 *     la genérica, y una línea de log que dice que es fallo nuestro.
 */
export function exchangeFailure(error: unknown): ExchangeFailure {
	if (error instanceof BackchannelError && error.code !== undefined) {
		const known = EXCHANGE_CODES[error.code];
		return {
			status: known.status,
			key: known.message,
			message: SUMEGO_PERSON_MESSAGES[known.message],
			...(known.ourFault ? { log: `Lumbre respondió ${error.code}` } : {})
		};
	}
	if (error instanceof BackchannelError && error.kind === 'transient') {
		return { status: 503, key: 'lumbreUnavailable', message: SUMEGO_PERSON_MESSAGES.lumbreUnavailable };
	}
	return {
		status: 502,
		key: 'generic',
		message: SUMEGO_PERSON_MESSAGES.generic,
		log: 'Lumbre rechazó la petición sin código (secreto del canal) o respondió fuera de contrato'
	};
}
