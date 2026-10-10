// Réplicas: dos procesos con el MISMO volumen de estado (lo que haría `docker compose up --scale mcp=2`).
// Alternamos 5+5 /authorize y contamos cuántos pendientes sobreviven en oauth-store.json (esperado 10).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { boot, req, WORK } from './lib.mjs';

const state = mkdtempSync(join(WORK, 'state-replicas-'));
const A = await boot({ stateDir: state });
const B = await boot({ stateDir: state });
const authz = (s, n) =>
	req(s.app, {
		method: 'GET',
		path: '/authorize?' + new URLSearchParams({
			response_type: 'code', client_id: `https://claude.ai/oauth/r${n}/client.json`,
			redirect_uri: 'https://claude.ai/api/mcp/auth_callback', scope: 'lumbre:mcp',
			resource: 'https://mcp.lumbre.pro/mcp', code_challenge: 'A'.repeat(43), code_challenge_method: 'S256'
		})
	});
const sts = [];
for (let i = 0; i < 10; i++) sts.push((await authz(i % 2 ? B : A, i)).status);
const store = JSON.parse(readFileSync(join(A.stateLumbre, 'oauth-store.json'), 'utf8'));
console.log(JSON.stringify({ q: 'réplicas', test: '10 /authorize alternando 2 procesos con el mismo volumen', statuses: sts, pendientesEnDisco: store.authorizationRequests.length, esperado: 10 }));
await A.stop();
await B.stop();
process.exit(0);
