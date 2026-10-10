// Sonda en proceso, sin red ni servidor: ¿qué pasa si un documento CIMD de
// claude.ai registra un redirect_uri distinto del callback fijo?
// Uso: node sonda-redirect-cimd.mjs <ruta absoluta a dist/oauth.js>
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
const { OAuthService } = await import(process.argv[2]);
const CLIENT = 'https://claude.ai/sonda/client.json';
const OTHER = 'https://example.invalid/cb';
let backchannelCalls = 0;
const backchannel = {
  ensureConfigured() {},
  async createAuthorizationRequest() {
    backchannelCalls += 1;
    const requestId = '11111111-1111-4111-8111-111111111111';
    return { authorizationUrl: `https://app.lumbre.pro/integrations/lumbre-mcp?request=${requestId}`, requestId, expiresAt: Date.now() + 5 * 60_000 };
  },
  async exchange() { throw new Error('no'); }, async introspect() { throw new Error('no'); }, async revoke() {}
};
const fakeFetch = async () => new Response(JSON.stringify({ client_id: CLIENT, client_name: 'Sonda', redirect_uris: [OTHER] }), { status: 200, headers: { 'content-type': 'application/json' } });
const oauth = new OAuthService({ stateDir: await mkdtemp(join(tmpdir(), 'sonda-')), encryptionKey: randomBytes(32), fetch: fakeFetch, backchannel });
const challenge = createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url');
const url = new URL('https://mcp.lumbre.pro/authorize');
for (const [k, v] of Object.entries({ response_type: 'code', client_id: CLIENT, redirect_uri: OTHER, scope: 'lumbre:mcp', resource: 'https://mcp.lumbre.pro/mcp', code_challenge: challenge, code_challenge_method: 'S256', state: 's' })) url.searchParams.set(k, v);
const out = {};
const res = { writeHead(s, h) { out.status = s; out.location = h?.location; }, end(b) { out.body = String(b); } };
const req = { method: 'GET', headers: {}, socket: { remoteAddress: '192.0.2.1' } };
await oauth.handleAuthorize(req, res, url);
console.log(JSON.stringify({ status: out.status, redirectedTo: out.location ?? null, body: out.body, backchannelCalls }));
