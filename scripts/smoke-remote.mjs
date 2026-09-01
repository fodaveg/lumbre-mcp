#!/usr/bin/env node
/**
 * Guardarraíl de deploy del transporte HTTP remoto (`src/http.ts`). Sin
 * dependencias (`fetch` global de Node 22) — habla Streamable HTTP crudo
 * contra una URL ya desplegada: `initialize` + `tools/list` con token, y el
 * caso NEGATIVO (sin token → 401), porque un guardarraíl que solo prueba el
 * camino feliz no hubiera pillado un fail-open (ver
 * `no-salir-del-cwd-de-la-sesion.md`... perdón, ver la memoria de
 * "un guardarraíl en VERDE no prueba nada" del repo madre: este SÍ rompe si
 * el 401 deja de ser 401).
 *
 * Uso:
 *   node scripts/smoke-remote.mjs <url> <token>
 *   MCP_URL=https://mcp.lumbre.pro/mcp LUMBRE_TOKEN=xxx node scripts/smoke-remote.mjs
 *
 * `<url>` es la del endpoint MCP completo (con `/mcp`), no la base del host.
 * Antes del transporte comprueba el descubrimiento OAuth 2.1 (PRM + AS) y el
 * challenge del 401. Además mantiene el smoke de las dos compatibilidades:
 * Bearer directo y `/mcp/<token>`, con un token bien formado y el NEGATIVO
 * con uno mal formado — sin este último, un fail-open en la validación de
 * forma del path pasaría desapercibido (ver `src/http.test.ts`, mismo sabotaje
 * comprobado allí).
 *
 * Exit 0 si TODAS las comprobaciones pasan, 1 en cualquier otro caso, con un
 * mensaje por comprobación.
 */

const url = process.argv[2] ?? process.env.MCP_URL;
const token = process.argv[3] ?? process.env.LUMBRE_TOKEN;
const issuer = url ? new URL(url).origin : undefined;
const resource = issuer ? `${issuer}/mcp` : undefined;
const scope = 'lumbre:mcp';

// Techo de bytes de `tools/list` para las 20 tools reales — MISMA fuente que
// `src/index.test.ts` ("techo de bytes de las 20 tools", `CHAR_CEILING`):
// medido 22.198 tras podar las 5 tools sueltas de lista (create_list/
// nest_list/rename_list/remove_list/move_to_list, cubiertas entero por
// mutate_tasks) y sustituir add_brl_entry/update_brl_entry/delete_brl_entry
// por mutate_brl (2026-08-27) + ~5% de holgura. Si ese test cambia su techo,
// este número se actualiza a la vez — no hay forma de importarlo desde un
// script standalone sin dependencias, así que va documentado y buscable por
// el mismo comentario en ambos ficheros.
//
// Esta pareja de números YA se quedó atrás una vez: el lote de
// `add_attachment` (26 ago 2026) subió el techo en `index.test.ts` y
// `http.test.ts` y dejó estos dos en 25/25600, así que el deploy salió con el
// smoke en rojo por un recuento congelado, no por un fallo real. Si tocas el
// número de tools, `grep -rn "CHAR_CEILING\|EXPECTED_TOOL_COUNT" src scripts`
// enseña los TRES sitios de golpe.
const CHAR_CEILING = 24950;
const EXPECTED_TOOL_COUNT = 20;

if (!url) {
	console.error('smoke-remote: falta la URL. Uso: node scripts/smoke-remote.mjs <url> <token>');
	process.exit(1);
}
if (!token) {
	console.error('smoke-remote: falta el token. Uso: node scripts/smoke-remote.mjs <url> <token>');
	process.exit(1);
}

const JSON_RPC_HEADERS = {
	'content-type': 'application/json',
	accept: 'application/json, text/event-stream'
};

let requestId = 0;

/** POST JSON-RPC crudo. `withAuth: false` es el caso negativo del
 *  guardarraíl. `targetUrl` (default `url`) deja apuntar a `<url>/<token>`
 *  para probar la segunda forma de auth sin duplicar esta función. */
async function rpc(method, params, { withAuth = true, targetUrl = url } = {}) {
	requestId += 1;
	const headers = { ...JSON_RPC_HEADERS };
	if (withAuth) headers.authorization = `Bearer ${token}`;
	const res = await fetch(targetUrl, {
		method: 'POST',
		headers,
		body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params: params ?? {} })
	});
	let body;
	try {
		body = await res.json();
	} catch {
		body = undefined;
	}
	return { status: res.status, body };
}

const checks = [];
let failed = false;

function check(name, ok, detail) {
	checks.push({ name, ok, detail });
	if (!ok) failed = true;
	console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
	// 0. Descubrimiento OAuth 2.1 que usa claude.ai al recibir el 401.
	const prmPath = await fetch(`${issuer}/.well-known/oauth-protected-resource/mcp`);
	const prmPathBody = await prmPath.json().catch(() => undefined);
	check('PRM path-specific responde HTTP 200', prmPath.status === 200, `status=${prmPath.status}`);
	check(
		'PRM declara resource, issuer, bearer header y scope exactos',
		prmPathBody?.resource === resource &&
			Array.isArray(prmPathBody?.authorization_servers) && prmPathBody.authorization_servers.length === 1 &&
			prmPathBody.authorization_servers[0] === issuer &&
			Array.isArray(prmPathBody?.bearer_methods_supported) && prmPathBody.bearer_methods_supported.join(',') === 'header' &&
			Array.isArray(prmPathBody?.scopes_supported) && prmPathBody.scopes_supported.join(',') === scope,
		JSON.stringify(prmPathBody).slice(0, 300)
	);
	const prmAlias = await fetch(`${issuer}/.well-known/oauth-protected-resource`);
	check(
		'PRM alias base coincide con el path-specific',
		prmAlias.status === 200 && JSON.stringify(await prmAlias.json().catch(() => undefined)) === JSON.stringify(prmPathBody),
		`status=${prmAlias.status}`
	);
	const as = await fetch(`${issuer}/.well-known/oauth-authorization-server`);
	const asBody = await as.json().catch(() => undefined);
	check('AS metadata responde HTTP 200', as.status === 200, `status=${as.status}`);
	check(
		'AS metadata anuncia code+refresh, PKCE S256, cliente público y CIMD sin DCR',
		asBody?.issuer === issuer &&
			asBody?.authorization_endpoint === `${issuer}/authorize` &&
			asBody?.token_endpoint === `${issuer}/token` &&
			asBody?.revocation_endpoint === `${issuer}/revoke` &&
			Array.isArray(asBody?.grant_types_supported) && asBody.grant_types_supported.includes('authorization_code') && asBody.grant_types_supported.includes('refresh_token') &&
			Array.isArray(asBody?.code_challenge_methods_supported) && asBody.code_challenge_methods_supported.join(',') === 'S256' &&
			Array.isArray(asBody?.token_endpoint_auth_methods_supported) && asBody.token_endpoint_auth_methods_supported.join(',') === 'none' &&
			asBody?.client_id_metadata_document_supported === true &&
			asBody?.authorization_response_iss_parameter_supported === true &&
			asBody?.registration_endpoint === undefined,
		JSON.stringify(asBody).slice(0, 400)
	);

	// 1. initialize, con token.
	const init = await rpc('initialize', {
		protocolVersion: '2025-06-18',
		capabilities: {},
		clientInfo: { name: 'smoke-remote', version: '0.0.0' }
	});
	check('initialize responde HTTP 200', init.status === 200, `status=${init.status}`);
	check(
		'initialize expone serverInfo.name',
		typeof init.body?.result?.serverInfo?.name === 'string',
		JSON.stringify(init.body).slice(0, 200)
	);

	// 2. tools/list, con token: recuento + techo de bytes.
	const list = await rpc('tools/list');
	check('tools/list responde HTTP 200', list.status === 200, `status=${list.status}`);
	const tools = list.body?.result?.tools;
	const toolCount = Array.isArray(tools) ? tools.length : -1;
	// La etiqueta interpola la constante a propósito: escrita a mano decía
	// "exactamente 25 tools" al lado de un `count=26` en VERDE, que es peor que
	// no decir nada.
	check(
		`tools/list expone exactamente ${EXPECTED_TOOL_COUNT} tools`,
		toolCount === EXPECTED_TOOL_COUNT,
		`count=${toolCount}`
	);
	const size = tools ? JSON.stringify(tools).length : -1;
	check(`tools/list <= ${CHAR_CEILING} chars`, size >= 0 && size <= CHAR_CEILING, `size=${size}`);

	// 3. Caso NEGATIVO: sin token, 401 fail-closed.
	const noAuth = await rpc('tools/list', undefined, { withAuth: false });
	check('sin Authorization: 401 (fail-closed)', noAuth.status === 401, `status=${noAuth.status}`);
	const challengeResponse = await fetch(url, {
		method: 'POST',
		headers: JSON_RPC_HEADERS,
		body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method: 'tools/list', params: {} })
	});
	check(
		'401 anuncia el PRM path-specific y scope exactos',
		challengeResponse.status === 401 &&
			challengeResponse.headers.get('www-authenticate') ===
				`Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp", scope="${scope}"`,
		`status=${challengeResponse.status} challenge=${challengeResponse.headers.get('www-authenticate')}`
	);

	// 4. Token en el PATH (compatibilidad temporal — ver JSDoc de
	// cabecera): mismo `initialize` + `tools/list`, pero contra `<url>/<token>`
	// y SIN cabecera, para no tapar un bug que solo se dispare cuando la
	// cabecera falta de verdad.
	const pathUrl = `${url}/${token}`;
	const pathInit = await rpc(
		'initialize',
		{ protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke-remote-path', version: '0.0.0' } },
		{ withAuth: false, targetUrl: pathUrl }
	);
	check('token en el path: initialize responde HTTP 200', pathInit.status === 200, `status=${pathInit.status}`);
	const pathList = await rpc('tools/list', undefined, { withAuth: false, targetUrl: pathUrl });
	check('token en el path: tools/list responde HTTP 200', pathList.status === 200, `status=${pathList.status}`);

	// 5. Caso NEGATIVO del path: un segmento que NO tiene forma de token (el
	// token real de email-to-task son 32 hex) tiene que dar 401 exactamente
	// igual que sin credencial — sin esta comprobación, un fail-open en la
	// validación de forma del path (aceptar cualquier segmento no vacío)
	// pasaría desapercibido. Mismo sabotaje comprobado en `src/http.test.ts`.
	const malformedPathUrl = `${url}/no-es-un-token-valido`;
	const badPath = await rpc('tools/list', undefined, { withAuth: false, targetUrl: malformedPathUrl });
	check('token mal formado en el path: 401 (fail-closed)', badPath.status === 401, `status=${badPath.status}`);

	if (failed) {
		console.error(`\nsmoke-remote: ${checks.filter((c) => !c.ok).length}/${checks.length} comprobaciones en rojo.`);
		process.exit(1);
	}
	console.log('\nINFO metadata/challenge no certifican el flujo OAuth; ejecuta el canary local y el QA con broker.');
	console.log(`\nsmoke-remote: ${checks.length}/${checks.length} comprobaciones en verde.`);
	process.exit(0);
}

main().catch((err) => {
	console.error('smoke-remote: excepción sin capturar —', err instanceof Error ? err.stack : err);
	process.exit(1);
});
