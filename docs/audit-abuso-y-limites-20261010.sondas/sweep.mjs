// Q6: barrido de credenciales con N grants sembrados en un store de prueba (dir temporal propio).
// Uso: node sweep.mjs <N> <latenciaMs> <inactivos>
// Backchannel FALSO en proceso: cuenta introspect() y simula latencia; no hay red.
import { mkdtempSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { createHash, createCipheriv, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { WORK, sleep, mb } from './lib.mjs';

const N = Number(process.argv[2] ?? 10000);
const LAT = Number(process.argv[3] ?? 0);
const INACTIVE = Number(process.argv[4] ?? 0);

const BUILD = new URL('./build/dist/', import.meta.url);
const root = mkdtempSync(join(WORK, 'sweep-'));
process.env.XDG_STATE_HOME = root;
const stateDir = join(root, 'lumbre-mcp');
mkdirSync(stateDir, { recursive: true, mode: 0o700 });

const { createOAuthService, OAUTH_RESOURCE, OAUTH_SCOPE } = await import(new URL('oauth.js', BUILD));

const key = randomBytes(32);
writeFileSync(join(stateDir, 'oauth.key'), key.toString('base64url'), { mode: 0o600 });
const sha = (s) => createHash('sha256').update(s).digest('hex');
const uuid = (i) => {
	const h = sha(`cred${i}`);
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const clientId = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
const enc = (value, ctx) => {
	const iv = randomBytes(12);
	const c = createCipheriv('aes-256-gcm', key, iv);
	c.setAAD(ctx);
	const ct = Buffer.concat([c.update(value, 'utf8'), c.final()]);
	return { iv: iv.toString('base64url'), tag: c.getAuthTag().toString('base64url'), ciphertext: ct.toString('base64url') };
};
const ctx = Buffer.from(JSON.stringify([clientId, OAUTH_RESOURCE, OAUTH_SCOPE]), 'utf8');
const now = Date.now();
const byUpstream = new Map();
const grants = Array.from({ length: N }, (_, i) => {
	const upstream = sha(`up${i}`);
	byUpstream.set(upstream, { credentialId: uuid(i), inactive: i < INACTIVE });
	return {
		provider: 'lumbre-web', credentialId: uuid(i), familyId: `fam${i}`, familyExpiresAt: now + 30 * 864e5,
		clientId, resource: OAUTH_RESOURCE, scope: OAUTH_SCOPE,
		accessHash: createHash('sha256').update(`a${i}`).digest('base64url'), accessExpiresAt: now + 3600e3,
		refreshHash: createHash('sha256').update(`r${i}`).digest('base64url'), refreshExpiresAt: now + 30 * 864e5,
		upstream: enc(sha(`up${i}`), ctx)
	};
});
const storePath = join(stateDir, 'oauth-store.json');
writeFileSync(storePath, JSON.stringify({ version: 3, grants, usedRefreshTokens: [], authorizationRequests: [], authorizationCodes: [], revocationOutbox: [] }), { mode: 0o600 });
const storeBytes = statSync(storePath).size;

let introspects = 0;
const backchannel = {
	ensureConfigured() {},
	async introspect(token) {
		introspects += 1;
		if (LAT) await sleep(LAT);
		const g = byUpstream.get(token);
		if (g.inactive) return { active: false };
		return { active: true, credentialId: g.credentialId, clientId, resource: OAUTH_RESOURCE, scope: OAUTH_SCOPE };
	},
	async revoke() {},
	async createAuthorizationRequest() { throw new Error('no'); },
	async exchange() { throw new Error('no'); }
};
const oauth = createOAuthService({ stateDir, backchannel });

const t0 = performance.now();
await oauth.ensureReady();
const tReady = performance.now() - t0;

// coste por petición /mcp de resolver un access token con N grants (peor caso: no existe -> recorre todo)
const t1 = performance.now();
const REPS = 200;
for (let i = 0; i < REPS; i++) await oauth.resolveAccessToken('lm_at_' + 'x'.repeat(43));
const perResolveMs = (performance.now() - t1) / REPS;

introspects = 0;
const t2 = performance.now();
const res = await oauth.sweepInactiveCredentials();
const tSweep = performance.now() - t2;
const m = process.memoryUsage();
console.log(JSON.stringify({
	q: 'Q6', grants: N, latencyMs: LAT, inactive: INACTIVE, storeMB: mb(storeBytes / 1048576),
	ensureReadySecs: mb(tReady / 1000), resolveAccessTokenMissMs: mb(perResolveMs),
	sweepSecs: mb(tSweep / 1000), introspectCalls: introspects, result: res,
	storeAfterMB: mb(statSync(storePath).size / 1048576), heapMB: mb(m.heapUsed / 1048576), rssMB: mb(m.rss / 1048576)
}));
process.exit(0);
