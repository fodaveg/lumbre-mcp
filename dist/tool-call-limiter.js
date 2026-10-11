import { createHash } from 'node:crypto';
/**
 * Tope de `tools/call` EN VUELO del relé HTTP (`http.ts`), global y por
 * credencial. Cada `tools/call` acaba en una o varias peticiones a
 * app.lumbre.pro desde la IP compartida del relé, y cada una retiene memoria
 * mientras espera: medido el 10 oct 2026 (`docs/audit-abuso-y-limites-20261010.md`,
 * hallazgos 1 y 3), 500 llamadas concurrentes con el upstream a 3 s eran 500
 * peticiones simultáneas contra la app y el RSS pasaba de ~90 a ~370 MB, sin
 * techo. Con este tope, lo que no cabe recibe un 429 inmediato en vez de
 * esperar en cola, porque una cola también retiene memoria. Ojo: el cliente
 * del SDK MCP NO reintenta un 429 (`StreamableHTTPClientTransport` lanza
 * `StreamableHTTPError` ante cualquier respuesta no-2xx salvo el 401 con
 * proveedor de auth): esa `tools/call` le llega como error al modelo, que
 * decide si repetirla. Por eso los topes tienen que quedar holgados para el
 * uso legítimo.
 *
 * Por qué estos valores por defecto:
 *  · global 32: el uso real son 1-3 cuentas, y un cliente MCP lanza a lo
 *    sumo un puñado de tools en paralelo. 32 deja sitio a cuatro cuentas
 *    con todas sus tools en paralelo y acota a 32 las peticiones simultáneas
 *    que el relé puede mandar a la app por `tools/call`.
 *  · por credencial 8: una sola cuenta (o un bearer inventado) no puede
 *    quedarse con todo el cupo global y dejar sin servicio a las demás.
 *
 * Se cambian sin recompilar con `LUMBRE_MCP_MAX_TOOL_CALLS` y
 * `LUMBRE_MCP_MAX_TOOL_CALLS_PER_BEARER` (ver `deploy/README-deploy.md`).
 */
export const DEFAULT_MAX_TOOL_CALLS_IN_FLIGHT = 32;
export const DEFAULT_MAX_TOOL_CALLS_PER_BEARER = 8;
/** Techo de cordura para un valor de entorno: más allá ya no es un tope. */
const MAX_CONFIGURABLE_LIMIT = 10_000;
function limitFromEnv(name, raw, fallback) {
    if (raw === undefined || raw.trim() === '')
        return fallback;
    const value = raw.trim();
    const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_CONFIGURABLE_LIMIT) {
        // Texto fijo: el nombre de la variable es nuestro y el valor no se
        // copia (podría ser cualquier cosa pegada por error).
        console.error(`[lumbre-mcp-http] ${name} no es un entero entre 1 y ${MAX_CONFIGURABLE_LIMIT}; se usa ${fallback}`);
        return fallback;
    }
    return parsed;
}
/**
 * Lee los topes del entorno. Un valor ausente, vacío o fuera de rango cae al
 * defecto (nunca a "sin tope"), con una línea en stderr si estaba puesto mal.
 * El tope por credencial nunca supera al global.
 */
export function toolCallLimitsFromEnv(env = process.env) {
    const global = limitFromEnv('LUMBRE_MCP_MAX_TOOL_CALLS', env.LUMBRE_MCP_MAX_TOOL_CALLS, DEFAULT_MAX_TOOL_CALLS_IN_FLIGHT);
    const perBearer = limitFromEnv('LUMBRE_MCP_MAX_TOOL_CALLS_PER_BEARER', env.LUMBRE_MCP_MAX_TOOL_CALLS_PER_BEARER, DEFAULT_MAX_TOOL_CALLS_PER_BEARER);
    return { global, perBearer: Math.min(perBearer, global) };
}
/**
 * Tope de lo que un hueco puede estar ocupado (120 s). El hueco se devuelve
 * cuando la tool termina, y una tool espera como mucho 30 s por petición a la
 * app (`lumbre-client.ts`), así que en condiciones normales esto no salta
 * nunca. Es la red de seguridad para una tool que se quede colgada por otra
 * vía: sin ella, cada una perdería un hueco hasta reiniciar el proceso, y 32
 * colgadas dejarían el relé sirviendo solo 429.
 */
export const TOOL_CALL_SLOT_TIMEOUT_MS = 120_000;
/**
 * Semáforo sin cola: `tryAcquire` reserva un hueco o devuelve `undefined` en
 * el acto. La credencial se cuenta por su hash (SHA-256 truncado), nunca en
 * claro: este mapa vive en memoria toda la vida del proceso y no tiene por
 * qué contener tokens. Las entradas se borran al volver a cero, así que el
 * mapa nunca pasa de `global` claves.
 */
export class ToolCallLimiter {
    limits;
    total = 0;
    perKey = new Map();
    slotTimeoutMs;
    log;
    constructor(limits, options = {}) {
        this.limits = limits;
        this.slotTimeoutMs = options.slotTimeoutMs ?? TOOL_CALL_SLOT_TIMEOUT_MS;
        this.log = options.log ?? ((line) => console.error(line));
    }
    /** `tools/call` en vuelo ahora mismo, en todo el proceso. */
    get inFlight() {
        return this.total;
    }
    /**
     * Reserva un hueco para `credential`. Devuelve la función que lo libera
     * (idempotente: llamarla dos veces no descuenta dos), o `undefined` si el
     * tope global o el de esa credencial ya están llenos. Si nadie lo libera
     * en `slotTimeoutMs`, se libera solo, con una línea de texto fijo en el
     * log (nada de la petición ni de la credencial).
     */
    tryAcquire(credential) {
        const key = createHash('sha256').update(credential).digest('hex').slice(0, 32);
        const current = this.perKey.get(key) ?? 0;
        if (this.total >= this.limits.global || current >= this.limits.perBearer)
            return undefined;
        this.total += 1;
        this.perKey.set(key, current + 1);
        let released = false;
        const release = () => {
            if (released)
                return;
            released = true;
            clearTimeout(expiry);
            this.total -= 1;
            const remaining = (this.perKey.get(key) ?? 1) - 1;
            if (remaining > 0)
                this.perKey.set(key, remaining);
            else
                this.perKey.delete(key);
        };
        const expiry = setTimeout(() => {
            if (released)
                return;
            this.log(`[lumbre-mcp-http] tools/call en vuelo más de ${this.slotTimeoutMs} ms: se libera su hueco`);
            release();
        }, this.slotTimeoutMs);
        // No retiene el proceso: el apagado ordenado no tiene por qué esperarlo.
        expiry.unref();
        return release;
    }
}
//# sourceMappingURL=tool-call-limiter.js.map