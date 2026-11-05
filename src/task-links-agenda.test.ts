import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	getBlockAgenda,
	getTaskLinks,
	getTaskLinksOfNote,
	getUpcoming,
	linkTaskNote,
	LumbreApiError,
	parseTaskNoteTarget,
	unlinkTaskNote,
	type LumbreConfig
} from './lumbre-client.js';
import { formatAgenda, formatTaskLinks, formatTaskLinksOfNote } from './format.js';
import {
	BLOCKS_BODY,
	NOTE_ID,
	TASK_ID,
	TASK_NOT_FOUND_BODY,
	UPCOMING_BODY,
	taskLinkRow
} from './test-support/c5-server-shapes.js';
import type { BlockAgenda, UpcomingResponse } from './lumbre-client.js';

const config: LumbreConfig = { baseUrl: 'https://lumbre.test', token: 'tok-123' };
const HEBRA_URL = `https://app.hebra.pro/note/${NOTE_ID}`;
const OBSIDIAN_URL = 'obsidian://open?vault=fodaveg&file=notas%2Fdiseno.md';

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('parseTaskNoteTarget', () => {
	it('https exacta: targetKey note:<uuid> y noteId en minúsculas', () => {
		expect(parseTaskNoteTarget(HEBRA_URL)).toEqual({ kind: 'hebra', noteId: NOTE_ID, targetKey: `note:${NOTE_ID}` });
		const upper = HEBRA_URL.toUpperCase().replace('HTTPS://APP.HEBRA.PRO/NOTE', 'https://app.hebra.pro/note');
		expect(parseTaskNoteTarget(upper)).toEqual({ kind: 'hebra', noteId: NOTE_ID, targetKey: `note:${NOTE_ID}` });
	});

	it('hebra:// sin target usa note:<uuid>; con ancla la conserva', () => {
		expect(parseTaskNoteTarget(`hebra://note/${NOTE_ID}`)?.targetKey).toBe(`note:${NOTE_ID}`);
		const anchored = `hebra://note/${NOTE_ID}?target=note:${NOTE_ID}:heading:Plan`;
		expect(parseTaskNoteTarget(anchored)).toEqual({
			kind: 'hebra',
			noteId: NOTE_ID,
			targetKey: `note:${NOTE_ID}:heading:Plan`
		});
	});

	it('el UUID en mayúsculas se canoniza en el prefijo y se conserva el ancla', () => {
		const upper = NOTE_ID.toUpperCase();
		expect(parseTaskNoteTarget(`hebra://note/${upper}?target=note:${upper}:block:AbC`)).toEqual({
			kind: 'hebra',
			noteId: NOTE_ID,
			targetKey: `note:${NOTE_ID}:block:AbC`
		});
	});

	it('Obsidian: targetKey es la URL y no hay noteId', () => {
		expect(parseTaskNoteTarget(OBSIDIAN_URL)).toEqual({ kind: 'obsidian', targetKey: OBSIDIAN_URL });
	});

	it.each([
		['CR', '\r'],
		['LF', '\n'],
		['NEL', String.fromCharCode(0x85)],
		['LS', String.fromCharCode(0x2028)],
		['PS', String.fromCharCode(0x2029)]
	])('rechaza un salto de línea (%s) en Obsidian y en Hebra', (_name, br) => {
		expect(parseTaskNoteTarget(`obsidian://open?vault=a${br}b`)).toBeNull();
		expect(parseTaskNoteTarget(`hebra://note/${NOTE_ID}${br}`)).toBeNull();
	});

	it('esquema y host en mayúsculas se rechazan; el UUID admite cualquier caja', () => {
		expect(parseTaskNoteTarget(`HTTPS://APP.HEBRA.PRO/NOTE/${NOTE_ID}`)).toBeNull();
		expect(parseTaskNoteTarget(`https://app.hebra.pro/NOTE/${NOTE_ID}`)).toBeNull();
		expect(parseTaskNoteTarget(`https://app.hebra.pro/note/${NOTE_ID.toUpperCase()}`)).toMatchObject({ noteId: NOTE_ID });
	});

	it.each([
		['https con query', `${HEBRA_URL}?x=1`],
		['https con fragmento', `${HEBRA_URL}#h`],
		['https con target', `${HEBRA_URL}?target=note:${NOTE_ID}`],
		['target con sufijo no válido', `hebra://note/${NOTE_ID}?target=note:${NOTE_ID}:cualquier-cosa`],
		['target mayor de 300', `hebra://note/${NOTE_ID}?target=note:${NOTE_ID}:heading:${'a'.repeat(300)}`],
		['query ajena', `hebra://note/${NOTE_ID}?from=lumbre`],
		['otro host', 'https://example.com/nota'],
		['uuid inválido', 'hebra://note/no-uuid']
	])('rechaza %s', (_name, url) => {
		expect(parseTaskNoteTarget(url)).toBeNull();
	});
});

describe('linkTaskNote / unlinkTaskNote', () => {
	it('manda noteId y targetKey de Hebra, recorta valores y devuelve el vínculo', async () => {
		const link = taskLinkRow();
		const fetchSpy = vi.fn().mockResolvedValue(json({ ok: true, type: 'link', taskId: TASK_ID, archived: false, link }));
		vi.stubGlobal('fetch', fetchSpy);
		const result = await linkTaskNote(config, { taskId: TASK_ID, url: ` ${HEBRA_URL} `, label: '  Diseño  ' });
		expect(result.link).toEqual(link);
		const [requestUrl, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(requestUrl).toBe('https://lumbre.test/api/task-links');
		expect(init.method).toBe('POST');
		expect(JSON.parse(String(init.body))).toEqual({
			type: 'link',
			taskId: TASK_ID,
			target: { kind: 'hebra', noteId: NOTE_ID, targetKey: `note:${NOTE_ID}`, url: HEBRA_URL, label: 'Diseño' }
		});
	});

	it('Obsidian: targetKey = url y sin noteId', async () => {
		const link = taskLinkRow({ kind: 'obsidian', noteId: null, targetKey: OBSIDIAN_URL, url: OBSIDIAN_URL });
		const fetchSpy = vi.fn().mockResolvedValue(json({ ok: true, type: 'link', taskId: TASK_ID, archived: true, link }));
		vi.stubGlobal('fetch', fetchSpy);
		const result = await linkTaskNote(config, { taskId: TASK_ID, url: OBSIDIAN_URL, label: 'Diseño' });
		expect(result.archived).toBe(true);
		const body = JSON.parse(String((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body));
		expect(body.target).toEqual({ kind: 'obsidian', targetKey: OBSIDIAN_URL, url: OBSIDIAN_URL, label: 'Diseño' });
	});

	it('una URL inválida da un error que dice qué formas valen, sin tocar la red', async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		const err = await linkTaskNote(config, { taskId: TASK_ID, url: `${HEBRA_URL}?x=1`, label: 'x' }).catch((e) => e);
		expect(err).toBeInstanceOf(LumbreApiError);
		expect(String(err.message)).toContain('https://app.hebra.pro/note/<uuid> exacta');
		expect(String(err.message)).toContain('hebra://note/<uuid>');
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('rechaza una respuesta que no cuadra con lo enviado', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				json({ ok: true, type: 'link', taskId: TASK_ID, archived: false, link: taskLinkRow({ label: 'Otro' }) })
			)
		);
		await expect(linkTaskNote(config, { taskId: TASK_ID, url: HEBRA_URL, label: 'Diseño' })).rejects.toThrow(
			/respuesta inesperada/
		);
	});

	it('unlink conserva removed=false como éxito (200)', async () => {
		const fetchSpy = vi
			.fn()
			.mockResolvedValue(json({ ok: true, type: 'unlink', taskId: TASK_ID, archived: false, removed: false }));
		vi.stubGlobal('fetch', fetchSpy);
		expect(await unlinkTaskNote(config, { taskId: TASK_ID, url: HEBRA_URL, label: 'Diseño' })).toMatchObject({
			removed: false,
			archived: false
		});
		const body = JSON.parse(String((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body));
		expect(body.type).toBe('unlink');
	});

	it('404 de la tarea llega como LumbreApiError con status', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(TASK_NOT_FOUND_BODY, 404)));
		const err = await linkTaskNote(config, { taskId: TASK_ID, url: HEBRA_URL, label: 'x' }).catch((e) => e);
		expect(err).toBeInstanceOf(LumbreApiError);
		expect(err.status).toBe(404);
		expect(err.message).toContain('Tarea no encontrada en esta cuenta');
	});
});

describe('getTaskLinks / getTaskLinksOfNote', () => {
	it('por tarea solo manda taskId', async () => {
		const fetchSpy = vi.fn().mockResolvedValue(json({ links: [taskLinkRow()] }));
		vi.stubGlobal('fetch', fetchSpy);
		expect(await getTaskLinks(config, TASK_ID)).toHaveLength(1);
		const url = new URL((fetchSpy.mock.calls[0] as [string])[0]);
		expect(url.pathname).toBe('/api/task-links');
		expect([...url.searchParams.keys()]).toEqual(['taskId']);
	});

	it('por nota manda kind=hebra y targetKey con el uuid pelado en minúsculas, y nunca taskId', async () => {
		const fetchSpy = vi.fn().mockResolvedValue(json({ links: [] }));
		vi.stubGlobal('fetch', fetchSpy);
		expect(await getTaskLinksOfNote(config, NOTE_ID.toUpperCase())).toEqual([]);
		const url = new URL((fetchSpy.mock.calls[0] as [string])[0]);
		expect(Object.fromEntries(url.searchParams)).toEqual({ kind: 'hebra', targetKey: NOTE_ID });
	});

	it('404 y respuesta sin links fallan', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(TASK_NOT_FOUND_BODY, 404)));
		await expect(getTaskLinks(config, TASK_ID)).rejects.toMatchObject({ status: 404 });
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ nada: true })));
		await expect(getTaskLinks(config, TASK_ID)).rejects.toThrow(/respuesta inesperada/);
	});

	it('400 por mezclar filtros llega con su mensaje', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ message: 'taskId no admite kind ni targetKey' }, 400)));
		await expect(getTaskLinks(config, TASK_ID)).rejects.toMatchObject({ status: 400 });
	});
});

describe('getUpcoming / getBlockAgenda', () => {
	it('days solo manda days y week solo manda week (sin spaceId ni fechas)', async () => {
		const fetchSpy = vi.fn().mockImplementation(async () => json(UPCOMING_BODY));
		vi.stubGlobal('fetch', fetchSpy);
		await getUpcoming(config, { days: 3 });
		await getUpcoming(config, { week: true });
		const keys = (i: number) => [...new URL((fetchSpy.mock.calls[i] as [string])[0]).searchParams.keys()];
		expect(keys(0)).toEqual(['days']);
		expect(keys(1)).toEqual(['week']);
	});

	it('valida la forma de la respuesta', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ days: 'no' })));
		await expect(getUpcoming(config, { days: 1 })).rejects.toThrow(/respuesta inesperada/);
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ enabled: true })));
		await expect(getBlockAgenda(config)).rejects.toThrow(/respuesta inesperada/);
	});

	it('bloques: pide /api/today?blocks=1', async () => {
		const fetchSpy = vi.fn().mockResolvedValue(json(BLOCKS_BODY));
		vi.stubGlobal('fetch', fetchSpy);
		expect((await getBlockAgenda(config)).blocks).toHaveLength(1);
		expect((fetchSpy.mock.calls[0] as [string])[0]).toBe('https://lumbre.test/api/today?blocks=1');
	});
});

describe('formatTaskLinks / formatTaskLinksOfNote', () => {
	it('por tarea: una fila por vínculo con url y etiqueta', () => {
		const out = formatTaskLinks(TASK_ID, [taskLinkRow() as never]);
		expect(out).toContain(`1 vínculo de la tarea ${TASK_ID}`);
		expect(out).toContain(`Diseño — ${HEBRA_URL}`);
	});

	it('por tarea vacía: sin vínculos', () => {
		const out = formatTaskLinks(TASK_ID, []);
		expect(out).toContain('No hay vínculos visibles');
		expect(out).toContain('token personal');
	});

	it('url y targetKey de un vínculo creado por otra vía no fabrican filas', () => {
		const out = formatTaskLinks(TASK_ID, [
			taskLinkRow({ url: 'obsidian://a\n· fila falsa', targetKey: 'k\n· otra' }) as never
		]);
		expect(out.split('\n').filter((l) => l.startsWith('·'))).toHaveLength(1);
		expect(out).toContain('obsidian://a · fila falsa');
		expect(formatTaskLinksOfNote(NOTE_ID, [taskLinkRow({ url: 'x\n· y' }) as never]).split('\n').filter((l) => l.startsWith('·'))).toHaveLength(1);
	});

	it('por nota: taskId, título, url y etiqueta; un título con saltos no fabrica filas', () => {
		const out = formatTaskLinksOfNote(NOTE_ID, [taskLinkRow({ title: 'Hacer\n· otra fila falsa' }) as never]);
		expect(out).toContain(`taskId: ${TASK_ID}`);
		expect(out).toContain('Hacer · otra fila falsa');
		expect(out).toContain(`url: ${HEBRA_URL}`);
		expect(out.split('\n').filter((l) => l.startsWith('·'))).toHaveLength(1);
	});

	it('por nota vacía: no distingue sin vínculos de fuera de alcance', () => {
		const out = formatTaskLinksOfNote(NOTE_ID, []);
		expect(out).toContain('No hay vínculos visibles');
		expect(out).toContain('no distingue');
	});
});

describe('formatAgenda', () => {
	const upcoming = UPCOMING_BODY as unknown as UpcomingResponse;
	const blocks = BLOCKS_BODY as unknown as BlockAgenda;

	it('eventos antes que tareas, todo el día, cancelada distinta de hecha, subtarea, hábito y espacio', () => {
		const out = formatAgenda(upcoming, blocks);
		expect(out.indexOf('Cumple de Ana')).toBeLessThan(out.indexOf('Llamar al banco'));
		expect(out).toContain('todo el día — Cumple de Ana');
		expect(out).toContain('[x] Hecha');
		expect(out).toContain('[-] Cancelada (cancelada)');
		expect(out).toContain('Padre > Subtarea');
		expect(out).toContain('espacio: Casa');
		expect(out).toContain('↻hábito 🧘');
		expect(out).toContain('[ ] 09:30 Llamar al banco');
		expect(out).toContain(`id: ${TASK_ID}`);
		expect(out).toContain('(sin eventos ni tareas)');
	});

	it('un título de evento con saltos de línea no fabrica filas', () => {
		const out = formatAgenda(upcoming, blocks);
		expect(out).toContain('10:00 — Reunión - [x] fila falsa');
		expect(out).not.toMatch(/^\s*- \[x\] fila falsa/m);
	});

	it('bloques: horas en la zona del servidor, no la de la máquina', () => {
		const out = formatAgenda(upcoming, blocks);
		expect(out).toContain('zona Europe/Madrid');
		expect(out).toContain('10:00–11:30 Escribir informe');
		expect(out).toContain(`taskId: ${TASK_ID}`);
		const tokyo = formatAgenda(upcoming, { ...blocks, timezone: 'Asia/Tokyo' });
		expect(tokyo).toContain('18:00–19:30 Escribir informe');
	});

	it('Horario apagado: una línea', () => {
		const out = formatAgenda(upcoming, { ...blocks, enabled: false, blocks: [] });
		expect(out).toContain('Horario está apagado');
	});

	it('bloques no disponibles: lo dice con el motivo', () => {
		expect(formatAgenda(upcoming, 'Lumbre respondió 500: boom')).toContain(
			'bloques de Horario: no disponibles (Lumbre respondió 500: boom)'
		);
	});

	it('evento multidía: el tramo intermedio dice que viene de ayer y sigue mañana', () => {
		const mid = {
			...upcoming,
			days: [
				{
					date: '2026-11-05',
					tasks: [],
					events: [{ id: 'e', title: 'Congreso', date: '2026-11-05', time: null, allDay: false, continuedFromPrevDay: true, continuesNextDay: true }]
				}
			]
		} as UpcomingResponse;
		expect(formatAgenda(mid, blocks)).toContain('viene de ayer, sigue mañana — Congreso');
	});

	it('zona desconocida: cae a UTC y lo dice una sola vez', () => {
		const out = formatAgenda(upcoming, { ...blocks, timezone: 'No/Existe' });
		expect(out).not.toContain('(zona UTC)');
		expect(out).toContain('(zona «No/Existe» desconocida: horas en UTC):');
		expect(out).toContain('desconocida: horas en UTC');
		expect(out).toContain('09:00–10:30 Escribir informe');
	});

	it('semana: hábitos y resumen', () => {
		const week = {
			...upcoming,
			week: 45,
			year: 2026,
			to: '2026-11-08',
			habits: [{ id: 'h1', name: 'Meditar', done: 2, planned: 7, emoji: '🧘', kind: 'registro', consistency: { done: 4, total: 7 } }],
			habitsSummary: { total: 1, doneToday: 1 }
		} as UpcomingResponse;
		const out = formatAgenda(week, blocks);
		expect(out).toContain('Semana 45 de 2026');
		expect(out).toContain('Hábitos: 1 (con registro hoy: 1)');
		expect(out).toContain('🧘 Meditar — registro · 4/7 en 7 días');
	});
});

describe('tools get_task_links, link_task_note, unlink_task_note y get_agenda', () => {
	async function buildClient() {
		const indexModule = await import('./index.js');
		const server = indexModule.createServer({ baseUrl: 'https://lumbre.test', token: 'tok-tools' });
		const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
		const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		indexModule.stripToolsListSchema(serverTransport);
		await server.connect(serverTransport);
		const client = new Client({ name: 'task-links-agenda-test', version: '0.0.0' });
		await client.connect(clientTransport);
		return client;
	}
	const textOf = (r: unknown) => ((r as { content: { text: string }[] }).content[0]).text;

	it('get_task_links exige exactamente uno y no llama al servidor', async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();
		for (const args of [{}, { taskId: TASK_ID, noteId: NOTE_ID }]) {
			const result = await client.callTool({ name: 'get_task_links', arguments: args });
			expect(result.isError).toBe(true);
			expect(textOf(result)).toContain('exactamente uno');
		}
		const bad = await client.callTool({ name: 'get_task_links', arguments: { noteId: 'no-uuid' } });
		expect(bad.isError).toBe(true);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('get_task_links por nota enseña tarea, título, url y etiqueta', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ links: [taskLinkRow({ title: 'Escribir' })] })));
		const client = await buildClient();
		const text = textOf(await client.callTool({ name: 'get_task_links', arguments: { noteId: NOTE_ID } }));
		expect(text).toContain('Escribir');
		expect(text).toContain(`taskId: ${TASK_ID}`);
	});

	it('get_task_links por tarea: el 404 es un error de la tool', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(TASK_NOT_FOUND_BODY, 404)));
		const client = await buildClient();
		const result = await client.callTool({ name: 'get_task_links', arguments: { taskId: TASK_ID } });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain('Tarea no encontrada en esta cuenta');
	});

	it('link_task_note dice que la tarea está archivada; unlink enseña removed', async () => {
		const link = taskLinkRow();
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValueOnce(json({ ok: true, type: 'link', taskId: TASK_ID, archived: true, link }))
				.mockResolvedValueOnce(json({ ok: true, type: 'unlink', taskId: TASK_ID, archived: false, removed: false }))
		);
		const client = await buildClient();
		const args = { taskId: TASK_ID, url: HEBRA_URL, label: 'Diseño' };
		const linked = textOf(await client.callTool({ name: 'link_task_note', arguments: args }));
		expect(linked).toContain('archivada o cancelada');
		expect(linked).toContain(HEBRA_URL);
		expect(textOf(await client.callTool({ name: 'unlink_task_note', arguments: args }))).toContain('removed=false');
	});

	it('link_task_note rechaza antes de la red una URL que solo valdría con otra credencial', async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();
		const result = await client.callTool({
			name: 'link_task_note',
			arguments: { taskId: TASK_ID, url: `${HEBRA_URL}?target=note:${NOTE_ID}`, label: 'x' }
		});
		expect(result.isError).toBe(true);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	function agendaFetch(handlers: { blocks: () => Response; upcoming?: () => Response }) {
		return vi.fn().mockImplementation(async (url: string) =>
			url.includes('/api/upcoming') ? (handlers.upcoming ?? (() => json(UPCOMING_BODY)))() : handlers.blocks()
		);
	}

	it('get_agenda hace dos peticiones y por defecto pide days=1', async () => {
		const fetchSpy = agendaFetch({ blocks: () => json(BLOCKS_BODY) });
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();
		const text = textOf(await client.callTool({ name: 'get_agenda', arguments: {} }));
		expect(text).toContain('Escribir informe');
		const urls = fetchSpy.mock.calls.map((c) => (c as [string])[0]);
		expect(urls).toContain('https://lumbre.test/api/upcoming?days=1');
		expect(urls).toContain('https://lumbre.test/api/today?blocks=1');
	});

	it('get_agenda con week:true pide week=1; con days y week da error sin red', async () => {
		const fetchSpy = agendaFetch({ blocks: () => json(BLOCKS_BODY) });
		vi.stubGlobal('fetch', fetchSpy);
		const client = await buildClient();
		await client.callTool({ name: 'get_agenda', arguments: { week: true } });
		expect(fetchSpy.mock.calls.map((c) => (c as [string])[0])).toContain('https://lumbre.test/api/upcoming?week=1');
		fetchSpy.mockClear();
		const both = await client.callTool({ name: 'get_agenda', arguments: { days: 3, week: true } });
		expect(both.isError).toBe(true);
		expect(fetchSpy).not.toHaveBeenCalled();
		const tooMany = await client.callTool({ name: 'get_agenda', arguments: { days: 15 } });
		expect(tooMany.isError).toBe(true);
	});

	it('si fallan los bloques (no 401) responde igual y lo dice', async () => {
		vi.stubGlobal('fetch', agendaFetch({ blocks: () => json({ message: 'boom' }, 500) }));
		const client = await buildClient();
		const result = await client.callTool({ name: 'get_agenda', arguments: {} });
		expect(result.isError).not.toBe(true);
		expect(textOf(result)).toContain('bloques de Horario: no disponibles (Lumbre respondió 500: boom)');
		expect(textOf(result)).toContain('Llamar al banco');
	});

	it('un 401 en los bloques se relanza como error', async () => {
		vi.stubGlobal('fetch', agendaFetch({ blocks: () => json({ message: 'no' }, 401) }));
		const client = await buildClient();
		const result = await client.callTool({ name: 'get_agenda', arguments: {} });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain('Token inválido');
	});

	it('si falla /api/upcoming, error', async () => {
		vi.stubGlobal(
			'fetch',
			agendaFetch({ blocks: () => json(BLOCKS_BODY), upcoming: () => json({ message: 'days inválido' }, 400) })
		);
		const client = await buildClient();
		const result = await client.callTool({ name: 'get_agenda', arguments: { days: 2 } });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain('400');
	});

	it('Horario apagado: la tool lo dice', async () => {
		vi.stubGlobal(
			'fetch',
			agendaFetch({ blocks: () => json({ ...BLOCKS_BODY, enabled: false, blocks: [] }) })
		);
		const client = await buildClient();
		expect(textOf(await client.callTool({ name: 'get_agenda', arguments: {} }))).toContain('Horario está apagado');
	});
});
