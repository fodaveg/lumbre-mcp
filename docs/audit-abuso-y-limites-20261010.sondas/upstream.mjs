// Upstream FALSO de Lumbre (127.0.0.1). Responde GET /api/tasks con 40 tareas plausibles
// y cuenta peticiones por ruta. GET /__stats devuelve los contadores.
// Env: UP_PORT (default 0 -> imprime el puerto), UP_DELAY_MS (latencia artificial).
import { createServer } from 'node:http';

const delay = Number(process.env.UP_DELAY_MS || 0);
const counts = {};
let inflight = 0;
let maxInflight = 0;
const tasks = Array.from({ length: 40 }, (_, i) => ({
	id: `t${String(i).padStart(6, '0')}`,
	content: `Tarea de prueba ${i} #casa`, tags: ["casa"], effectiveTags: ["casa"],
	notes: i % 3 === 0 ? `Nota de prueba ${i}\n`.repeat(20) : null,
	notesUpdatedAt: '2026-10-01T10:00:00.000Z',
	notesLength: i % 3 === 0 ? 400 : null,
	done: false,
	priority: null,
	date: '2026-10-10',
	deadline: null,
	list: null,
	createdAt: '2026-09-01T10:00:00.000Z'
}));

const server = createServer((req, res) => {
	const path = new URL(req.url, 'http://x').pathname;
	if (path === '/__stats') {
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ counts, maxInflight }));
		return;
	}
	counts[path] = (counts[path] ?? 0) + 1;
	inflight += 1;
	maxInflight = Math.max(maxInflight, inflight);
	req.resume();
	setTimeout(() => {
		inflight -= 1;
		res.writeHead(Number(process.env.UP_STATUS || 200), { 'content-type': 'application/json' });
		res.end(process.env.UP_STATUS ? JSON.stringify({ error: 'unauthorized' }) : path === '/api/tasks' ? JSON.stringify(tasks) : '[]');
	}, delay);
});
server.listen(Number(process.env.UP_PORT || 0), '127.0.0.1', () => {
	console.log(`UPSTREAM_PORT=${server.address().port}`);
});
