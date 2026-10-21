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
export function classifyStartupFailure(error) {
    if (error instanceof SyntaxError)
        return 'store_json_invalido';
    const code = error?.code;
    if (typeof code === 'string' && /^E[A-Z0-9]{1,15}$/.test(code))
        return `io:${code}`;
    const message = error instanceof Error ? error.message : '';
    if (message.includes('presente sin su clave'))
        return 'clave_ausente';
    if (/^clave (OAuth )?inválida$/.test(message) ||
        message.includes('encryptionKey debe tener 32 bytes') ||
        message.includes('unable to authenticate data')) {
        return 'clave_invalida';
    }
    if (message.includes('v1/v2'))
        return 'store_version';
    if (message.includes('LUMBRE_MCP_BACKCHANNEL_SECRET'))
        return 'secreto_backchannel';
    if (message.includes('LUMBRE_APP_BASE_URL'))
        return 'app_base_url';
    if (message.includes('LUMBRE_MCP_LOGIN_PROVIDER') && !message.includes('LUMBRE_MCP_OIDC_'))
        return 'proveedor_login';
    if (message.includes('LUMBRE_MCP_OIDC_'))
        return 'oidc_config';
    if (/OAuth (inválid[oa]|incoherente|fuera de contrato)/.test(message) ||
        /(credencial upstream|transacción OAuth|outbox OAuth) inválida/.test(message) ||
        // `validateClientIdUrl` lanza un `OAuthError` (`invalid_client`) cuando
        // un grant guardado trae un `client_id` que ya no se admite.
        code === 'invalid_client') {
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
export function installGracefulShutdown(server, options = {}) {
    const timeoutMs = options.timeoutMs ?? SHUTDOWN_TIMEOUT_MS;
    const signals = options.signals ?? ['SIGTERM', 'SIGINT'];
    const source = options.signalSource ?? process;
    const exit = options.exit ?? ((code) => process.exit(code));
    const log = options.log ?? ((line) => console.error(line));
    let shuttingDown = false;
    let finished = false;
    let deadline;
    let idleSweep;
    /** Sale UNA vez, y sin dejar temporizadores vivos detrás. */
    const finish = (code, line) => {
        if (finished)
            return;
        finished = true;
        clearTimeout(deadline);
        clearInterval(idleSweep);
        log(line);
        exit(code);
    };
    const onSignal = (signal) => {
        if (shuttingDown) {
            finish(1, `[lumbre-mcp-http] ${signal} durante el apagado: salida inmediata`);
            return;
        }
        shuttingDown = true;
        // Una segunda señal igual tiene que encontrar manejador: `once` ya
        // retiró el de esta (las demás conservan el suyo).
        source.once(signal, handlers.get(signal));
        log(`[lumbre-mcp-http] ${signal}: apagado ordenado (plazo ${timeoutMs} ms)`);
        const closed = new Promise((resolve) => server.close(() => resolve()));
        server.closeIdleConnections();
        idleSweep = setInterval(() => server.closeIdleConnections(), IDLE_SWEEP_MS);
        idleSweep.unref();
        deadline = setTimeout(() => {
            if (finished)
                return;
            server.closeAllConnections();
            finish(1, '[lumbre-mcp-http] apagado: plazo agotado, se cortan las conexiones que quedaban');
        }, timeoutMs);
        void closed
            .then(() => options.drain?.())
            .catch(() => undefined)
            .then(() => finish(0, '[lumbre-mcp-http] apagado: sin peticiones en vuelo ni escrituras pendientes'));
    };
    const handlers = new Map();
    for (const name of signals) {
        const handler = () => onSignal(name);
        handlers.set(name, handler);
        source.once(name, handler);
    }
    return () => {
        for (const [name, handler] of handlers)
            source.removeListener(name, handler);
    };
}
//# sourceMappingURL=http-lifecycle.js.map