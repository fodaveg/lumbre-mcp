import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

const FAKE_SHA = 'c0ffee0000000000000000000000000000000001';
const PREVIOUS_SHA = 'beef000000000000000000000000000000000002';

// Sandbox con dobles de `npm`, `git`, `rsync`, `ssh`, `docker` y `node`:
// registran su invocación en un log en vez de tocar red ni disco real.
//  · `git` contesta como un árbol limpio en `FAKE_SHA` (`FAKE_GIT_DIRTY=1`
//    o `FAKE_DIST_DIRTY=1` lo ensucian) y su `archive` es un tar vacío.
//  · `ssh` simula los permisos 0600 del secreto (`FAKE_REMOTE_MODE` los
//    cambia) y no hace el `chown`; todo lo demás lo EJECUTA aquí con `bash
//    -c`: subir la parte remota, lanzarla desacoplada (con `setsid` falso),
//    seguir su log (con un `tail --pid` falso, porque el de macOS no lo
//    tiene) y leer su código. Así se prueba la parte remota de verdad contra
//    el `docker` falso. `FAKE_FOLLOW_DROPS=1` corta el primer seguimiento,
//    como un ssh que se cae a mitad.
//  · `docker` simula un contenedor en marcha con la revisión
//    `PREVIOUS_SHA` (salvo `FAKE_NO_PREVIOUS=1`), que pasa a healthy salvo si
//    la etiqueta levantada es `FAKE_BAD_TAG`; `FAKE_UP_FAIL_TAG` hace fallar
//    el `compose up` de esa etiqueta.
async function createSandbox() {
	const sandbox = await mkdtemp(join(tmpdir(), 'lumbre-mcp-deploy-test-'));
	const bin = join(sandbox, 'bin');
	const log = join(sandbox, 'calls.log');
	const dest = join(sandbox, 'srv-lumbre-mcp');
	const logDir = join(sandbox, 'logs');
	const empty = join(sandbox, 'vacio');
	await mkdir(bin);
	await mkdir(dest);
	await mkdir(empty);
	const fake = async (name: string, body: string) => {
		const path = join(bin, name);
		await writeFile(path, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o700 });
		await chmod(path, 0o700);
	};
	await fake('npm', 'printf "npm %s\\n" "$*" >> "$CALL_LOG"');
	await fake(
		'git',
		[
			'printf "git %s\\n" "$*" >> "$CALL_LOG"',
			'case "$*" in',
			'"status --porcelain -- dist") [[ -n "${FAKE_DIST_DIRTY:-}" ]] && echo "?? dist/nuevo.js" ;;',
			'"status --porcelain") [[ -n "${FAKE_GIT_DIRTY:-}" ]] && echo " M src/http.ts" ;;',
			`"rev-parse HEAD") echo ${FAKE_SHA} ;;`,
			`archive*) tar -cf - -C "${empty}" . ;;`,
			'esac',
			'exit 0'
		].join('\n')
	);
	await fake('rsync', 'printf "rsync %s\\n" "$*" >> "$CALL_LOG"');
	await fake(
		'ssh',
		[
			'printf "ssh %s\\n" "$*" >> "$CALL_LOG"',
			'cmd="$2"',
			'case "$cmd" in',
			'*"test -r "*) [[ "${FAKE_REMOTE_MODE:-600}" == 600 ]]; exit $? ;;',
			'*"chown -R 0:0"*) exit 0 ;;',
			'*"tail -n "*)',
			'  if [[ -n "${FAKE_FOLLOW_DROPS:-}" && ! -f "$CALL_LOG.caida" ]]; then',
			'    touch "$CALL_LOG.caida"; sleep 0.2; exit 255',
			'  fi ;;',
			'esac',
			'exec bash -c "$cmd"'
		].join('\n')
	);
	await fake('setsid', 'exec "$@"');
	await fake(
		'tail',
		[
			'pid=""; args=()',
			'for a in "$@"; do case "$a" in --pid=*) pid="${a#--pid=}" ;; -F) ;; *) args+=("$a") ;; esac; done',
			'if [[ -n "$pid" ]]; then while kill -0 "$pid" 2>/dev/null; do sleep 0.05; done; fi',
			'exec /usr/bin/tail "${args[@]}"'
		].join('\n')
	);
	await fake(
		'docker',
		[
			'state="$CALL_LOG.estado"',
			'if [[ "$1" == compose ]]; then',
			'  printf "docker %s TAG=%s REV=%s\\n" "$*" "${LUMBRE_MCP_IMAGE_TAG:-}" "${LUMBRE_MCP_REVISION:-}" >> "$CALL_LOG"',
			'  if [[ "$*" == *" up "* ]]; then',
			'    [[ "${LUMBRE_MCP_IMAGE_TAG:-}" == "${FAKE_UP_FAIL_TAG:-ninguna}" ]] && exit 1',
			'    echo "${LUMBRE_MCP_IMAGE_TAG:-latest}" > "$state"',
			'  fi',
			'  exit 0',
			'fi',
			'printf "docker %s\\n" "$*" >> "$CALL_LOG"',
			'case "$1 $2 $3" in',
			'"inspect -f {{.Image}}") [[ -n "${FAKE_NO_PREVIOUS:-}" && ! -f "$state" ]] && exit 1; echo sha256:imagen-previa ;;',
			`"inspect -f {{index"*) [[ -n "\${FAKE_NO_PREVIOUS:-}" && ! -f "$state" ]] && exit 1; [[ -f "$state" ]] || echo ${PREVIOUS_SHA} ;;`,
			'"inspect -f {{if"*) cur="$(cat "$state" 2>/dev/null)"',
			'  if [[ "$cur" == "${FAKE_BAD_TAG:-ninguna}" ]]; then echo unhealthy',
			'  elif [[ "$cur" == "${FAKE_STARTING_TAG:-ninguna}" ]]; then echo starting',
			'  else echo healthy; fi ;;',
			'"inspect -f {{.RestartCount}}") echo 0 ;;',
			'"inspect lumbre-mcp ") [[ -n "${FAKE_NO_PREVIOUS:-}" && ! -f "$state" ]] && exit 1; exit 0 ;;',
			'"logs --timestamps lumbre-mcp") echo "2026-10-11T00:00:00Z [lumbre-mcp-http] tools/call 200" ;;',
			`"image ls lumbre-mcp") printf "%s\\n" latest anterior ${PREVIOUS_SHA} ${FAKE_SHA} 0123456789012345678901234567890123456789 ;;`,
			'esac',
			'exit 0'
		].join('\n')
	);
	await fake(
		'node',
		'printf "node %s token_en_entorno=%s\\n" "$*" "${LUMBRE_TOKEN:+si}" >> "$CALL_LOG"; [[ -z "${FAKE_SMOKE_FAIL:-}" ]]'
	);

	const run = (extraEnv: Record<string, string> = {}) => {
		// Nunca hereda un LUMBRE_TOKEN real de quien corre los tests: con él,
		// el script lanzaría el smoke (contra el `node` falso, pero aun así).
		const env: Record<string, string | undefined> = {
			...process.env,
			PATH: `${bin}:${process.env.PATH}`,
			CALL_LOG: log,
			LUMBRE_MCP_DEST: dest,
			LUMBRE_MCP_LOG_DIR: logDir,
			LUMBRE_MCP_HEALTH_TIMEOUT: '3',
			...extraEnv
		};
		if (!('LUMBRE_TOKEN' in extraEnv)) delete env.LUMBRE_TOKEN;
		return spawnSync('bash', ['deploy/publicar.sh'], { cwd: process.cwd(), encoding: 'utf8', env });
	};

	const reset = async () => {
		await writeFile(log, '');
		await rm(`${log}.estado`, { force: true });
		await rm(`${log}.caida`, { force: true });
	};

	return { sandbox, log, logDir, run, reset };
}

describe('deploy OAuth fail-closed', () => {
	it('compose exige el secreto y publicar lo lee fuera del árbol borrado por rsync', async () => {
		const compose = await readFile('deploy/compose.yml', 'utf8');
		expect(compose).toContain('LUMBRE_MCP_BACKCHANNEL_SECRET:');
		expect(compose).toContain('${LUMBRE_MCP_BACKCHANNEL_SECRET:?');

		const publish = await readFile('deploy/publicar.sh', 'utf8');
		expect(publish).toContain('ENV_FILE="${LUMBRE_MCP_ENV_FILE:-/srv/lumbre-mcp.env}"');
		expect(publish).toContain('test \\$(stat -c %a $ENV_FILE) = 600');
		expect(publish).toContain('docker compose --env-file "$ENV_FILE" -f deploy/compose.yml');
		const validation = publish.indexOf('Validando secreto remoto');
		const deletion = publish.indexOf('rsync -rlptz --delete');
		expect(validation).toBeGreaterThan(0);
		expect(deletion).toBeGreaterThan(validation);
	});

	it('ejecuta el precheck remoto y rechaza secretos dentro del destino antes de ssh/rsync', async () => {
		const { sandbox, log, run, reset } = await createSandbox();
		try {
			let result = run();
			expect(result.status, result.stderr).toBe(0);
			expect(await readFile(log, 'utf8')).toContain('test -r /srv/lumbre-mcp.env');

			await reset();
			result = run({ LUMBRE_MCP_ENV_FILE: '/srv/secrets/lumbre-mcp.env' });
			expect(result.status, result.stderr).toBe(0);
			expect(await readFile(log, 'utf8')).toContain('test -r /srv/secrets/lumbre-mcp.env');

			for (const envFile of ['/srv/lumbre-mcp', '/srv/lumbre-mcp/.env']) {
				await reset();
				result = run({ LUMBRE_MCP_DEST: '/srv/lumbre-mcp', LUMBRE_MCP_ENV_FILE: envFile });
				expect(result.status, envFile).toBe(1);
				expect(result.stderr, envFile).toContain('fuera de LUMBRE_MCP_DEST');
				expect(await readFile(log, 'utf8'), envFile).toBe('');
			}

			for (const envFile of ['/srv/lumbre-mcp/./.env', '/srv//lumbre-mcp/.env', '/srv/other/../lumbre-mcp/.env']) {
				await reset();
				result = run({ LUMBRE_MCP_ENV_FILE: envFile });
				expect(result.status, envFile).toBe(1);
				expect(result.stderr, envFile).toContain('ruta absoluta canónica');
				expect(await readFile(log, 'utf8'), envFile).toBe('');
			}

			await reset();
			result = run({ FAKE_REMOTE_MODE: '640' });
			expect(result.status).toBe(1);
			const calls = await readFile(log, 'utf8');
			expect(calls).toContain('ssh ');
			expect(calls).not.toContain('rsync ');
		} finally {
			await rm(sandbox, { recursive: true, force: true });
		}
	});
});

describe('publicar.sh: un commit, con revisión, log guardado y vuelta atrás', () => {
	/** Líneas del log de llamadas, en orden. */
	async function calls(log: string): Promise<string[]> {
		return (await readFile(log, 'utf8')).split('\n').filter(Boolean);
	}

	function indexOf(lines: string[], fragment: string): number {
		const index = lines.findIndex((line) => line.includes(fragment));
		expect(index, `falta «${fragment}» en:\n${lines.join('\n')}`).toBeGreaterThanOrEqual(0);
		return index;
	}

	it('árbol con cambios o ficheros sin seguimiento: aborta antes de compilar y de tocar el servidor', async () => {
		const { sandbox, log, run } = await createSandbox();
		try {
			const result = run({ FAKE_GIT_DIRTY: '1' });
			expect(result.status).toBe(1);
			expect(result.stderr).toContain('sin commitear o ficheros sin seguimiento');
			const lines = await calls(log);
			expect(lines.some((line) => line.startsWith('npm '))).toBe(false);
			expect(lines.some((line) => /^(ssh|rsync) /.test(line))).toBe(false);
		} finally {
			await rm(sandbox, { recursive: true, force: true });
		}
	});

	it('un fichero NUEVO en dist/ tras recompilar también aborta (git diff --quiet no lo veía)', async () => {
		const { sandbox, log, run } = await createSandbox();
		try {
			const result = run({ FAKE_DIST_DIRTY: '1' });
			expect(result.status).toBe(1);
			expect(result.stderr).toContain('dist/ recompilado NO coincide');
			expect((await calls(log)).some((line) => /^(ssh|rsync) /.test(line))).toBe(false);
		} finally {
			await rm(sandbox, { recursive: true, force: true });
		}
	});

	it('camino feliz: copia el export de HEAD, etiqueta por SHA, guarda el log del saliente y mueve latest', async () => {
		const { sandbox, log, logDir, run } = await createSandbox();
		try {
			const result = run();
			expect(result.status, result.stderr).toBe(0);
			const lines = await calls(log);

			// Copia: desde el export de `git archive`, sin dueño del Mac y sin .DS_Store.
			const archive = indexOf(lines, 'git archive --format=tar HEAD');
			const rsync = indexOf(lines, 'rsync ');
			expect(rsync).toBeGreaterThan(archive);
			expect(lines[rsync]).toMatch(/^rsync -rlptz --delete /);
			expect(lines[rsync]).toContain('--exclude .DS_Store');
			expect(lines[rsync]).toMatch(/lumbre-mcp-publicar\.[A-Za-z0-9]+\/ /);
			expect(lines[rsync]).not.toMatch(/ -a| --owner| -o /);
			expect(lines[indexOf(lines, 'chown -R 0:0')]).toContain('-name .DS_Store -type f -delete');

			// La parte remota se sube y se lanza desacoplada del ssh.
			const upload = indexOf(lines, '/desplegar.sh');
			const launch = indexOf(lines, 'setsid nohup bash ');
			expect(lines[upload]).toContain('cat >');
			expect(lines[launch]).toContain(FAKE_SHA);
			expect(lines[launch]).toMatch(/<\/dev\/null &$/);
			expect(upload).toBeGreaterThan(rsync);
			expect(launch).toBeGreaterThan(upload);

			// Servidor, en orden: anterior → build → stop del viejo → su log → up → healthy → latest.
			const tagPrevious = indexOf(lines, 'docker tag sha256:imagen-previa lumbre-mcp:anterior');
			const build = indexOf(lines, `build TAG=${FAKE_SHA} REV=${FAKE_SHA}`);
			const stop = indexOf(lines, 'docker stop -t 15 lumbre-mcp');
			const logs = indexOf(lines, 'docker logs --timestamps lumbre-mcp');
			const up = indexOf(lines, `up -d --no-build TAG=${FAKE_SHA}`);
			const latest = indexOf(lines, `docker tag lumbre-mcp:${FAKE_SHA} lumbre-mcp:latest`);
			expect(build).toBeGreaterThan(tagPrevious);
			expect(stop).toBeGreaterThan(build);
			expect(logs).toBeGreaterThan(stop);
			expect(up).toBeGreaterThan(logs);
			expect(latest).toBeGreaterThan(up);
			// Poda: solo las etiquetas por SHA que no son ni la nueva ni la anterior.
			const removed = lines.filter((line) => line.startsWith('docker image rm'));
			expect(removed).toEqual(['docker image rm lumbre-mcp:0123456789012345678901234567890123456789']);

			// El log del contenedor saliente queda, comprimido y con su revisión.
			const entries = await readdir(logDir);
			const saved = entries.filter((name) => name.endsWith('.log.gz'));
			expect(saved).toHaveLength(1);
			expect(saved[0]).toMatch(new RegExp(`^\\d{8}T\\d{6}Z-saliente-${PREVIOUS_SHA.slice(0, 12)}\\.log\\.gz$`));
			expect(gunzipSync(await readFile(join(logDir, saved[0]!))).toString()).toContain('tools/call 200');
			// …y el del propio deploy, que es lo que se ha seguido desde aquí.
			const deployLogs = entries.filter((name) => name.startsWith('deploy-'));
			expect(deployLogs).toEqual([expect.stringMatching(new RegExp(`^deploy-\\d{8}T\\d{6}Z-${FAKE_SHA}\\.log$`))]);
			expect(await readFile(join(logDir, deployLogs[0]!), 'utf8')).toContain('[servidor] healthy');
			expect(result.stdout).toContain('[servidor] healthy');
			// El directorio de trabajo se retira al recoger el código.
			expect(entries.some((name) => name.startsWith('.deploy-'))).toBe(false);

			// Sin LUMBRE_TOKEN no hay smoke, y lo dice.
			expect(lines.some((line) => line.startsWith('node '))).toBe(false);
			expect(result.stdout).toContain('Sin LUMBRE_TOKEN');
		} finally {
			await rm(sandbox, { recursive: true, force: true });
		}
	});

	it('si la nueva no llega a healthy: guarda su log, vuelve a «anterior» y sale con 1 sin mover latest', async () => {
		const { sandbox, log, logDir, run } = await createSandbox();
		try {
			const result = run({ FAKE_BAD_TAG: FAKE_SHA, LUMBRE_TOKEN: 'tok-que-no-debe-usarse' });
			expect(result.status).toBe(1);
			expect(result.stdout + result.stderr).toContain('no llegó a healthy');
			expect(result.stderr).toContain('el deploy remoto salió con 1');
			const lines = await calls(log);
			const up = indexOf(lines, `up -d --no-build TAG=${FAKE_SHA}`);
			const stopFailed = lines.findIndex((line, i) => i > up && line === 'docker stop -t 15 lumbre-mcp');
			const rollback = indexOf(lines, 'up -d --no-build TAG=anterior');
			// La fallida se para (y se vuelca) antes de volver a la anterior.
			expect(stopFailed).toBeGreaterThan(up);
			expect(rollback).toBeGreaterThan(stopFailed);
			expect(lines.some((line) => line.includes('lumbre-mcp:latest'))).toBe(false);
			expect(lines.some((line) => line.startsWith('docker image rm'))).toBe(false);
			// Sin deploy bueno no se corre el smoke.
			expect(lines.some((line) => line.startsWith('node '))).toBe(false);
			const saved = (await readdir(logDir)).filter((name) => name.endsWith('.log.gz'));
			expect(saved).toHaveLength(2);
			expect(saved.some((name) => name.includes('-fallido'))).toBe(true);
			expect(saved.some((name) => name.includes('-saliente-'))).toBe(true);
		} finally {
			await rm(sandbox, { recursive: true, force: true });
		}
	});

	it('si el `compose up` de la nueva FALLA: no muere con set -e, vuelve a «anterior» y sale con 1', async () => {
		const { sandbox, log, run } = await createSandbox();
		try {
			const result = run({ FAKE_UP_FAIL_TAG: FAKE_SHA });
			expect(result.status).toBe(1);
			expect(result.stdout + result.stderr).toContain('no arrancó o no llegó a healthy');
			expect(result.stdout + result.stderr).toContain('la anterior vuelve a estar healthy');
			const lines = await calls(log);
			const up = indexOf(lines, `up -d --no-build TAG=${FAKE_SHA}`);
			const rollback = indexOf(lines, 'up -d --no-build TAG=anterior');
			expect(rollback).toBeGreaterThan(up);
			// Llega al `docker ps` final del script remoto.
			expect(indexOf(lines, 'docker ps -a --filter name=lumbre-mcp')).toBeGreaterThan(rollback);
			expect(lines.some((line) => line.includes('lumbre-mcp:latest'))).toBe(false);
		} finally {
			await rm(sandbox, { recursive: true, force: true });
		}
	});

	it('si el ssh de seguimiento se cae, el deploy sigue en el servidor y su código se recoge igual', async () => {
		const { sandbox, log, run } = await createSandbox();
		try {
			const result = run({ FAKE_FOLLOW_DROPS: '1' });
			expect(result.status, result.stderr).toBe(0);
			const lines = await calls(log);
			const follows = lines.filter((line) => line.includes('tail -n '));
			// Primer intento desde el principio; el reenganche, sin repetir.
			expect(follows).toHaveLength(2);
			expect(follows[0]).toContain('tail -n +1 -F');
			expect(follows[1]).toContain('tail -n 0 -F');
			indexOf(lines, `docker tag lumbre-mcp:${FAKE_SHA} lumbre-mcp:latest`);
			indexOf(lines, '/codigo');
		} finally {
			await rm(sandbox, { recursive: true, force: true });
		}
	});

	it('el tope de salud es en segundos reales: una que se queda en «starting» se corta a su hora', async () => {
		const { sandbox, run } = await createSandbox();
		try {
			const t0 = Date.now();
			const result = run({ FAKE_STARTING_TAG: FAKE_SHA, LUMBRE_MCP_HEALTH_TIMEOUT: '2' });
			const elapsed = Date.now() - t0;
			expect(result.status).toBe(1);
			expect(result.stdout + result.stderr).toMatch(/estado: starting, reinicios: 0, tras [23] s/);
			// Dos segundos de espera, más el arranque del script y la vuelta atrás.
			expect(elapsed).toBeLessThan(10_000);
		} finally {
			await rm(sandbox, { recursive: true, force: true });
		}
	});

	it('smoke rojo: sale con 1 y el comando de vuelta atrás devuelve también `latest` a la anterior', async () => {
		const { sandbox, run } = await createSandbox();
		try {
			const result = run({ LUMBRE_TOKEN: 'tok-smoke', FAKE_SMOKE_FAIL: '1' });
			expect(result.status).toBe(1);
			expect(result.stderr).toContain('el smoke ha fallado');
			expect(result.stderr).toMatch(
				/docker tag lumbre-mcp:anterior lumbre-mcp:latest && LUMBRE_MCP_IMAGE_TAG=anterior docker compose .* up -d --no-build/
			);
		} finally {
			await rm(sandbox, { recursive: true, force: true });
		}
	});

	it('primer deploy (no hay contenedor): no etiqueta anterior ni vuelca log, y llega a healthy', async () => {
		const { sandbox, log, logDir, run } = await createSandbox();
		try {
			const result = run({ FAKE_NO_PREVIOUS: '1' });
			expect(result.status, result.stderr).toBe(0);
			const lines = await calls(log);
			expect(lines.some((line) => line.includes('lumbre-mcp:anterior'))).toBe(false);
			expect(lines.some((line) => line.startsWith('docker stop'))).toBe(false);
			indexOf(lines, `docker tag lumbre-mcp:${FAKE_SHA} lumbre-mcp:latest`);
			expect((await readdir(logDir)).filter((name) => name.endsWith('.log.gz'))).toEqual([]);
		} finally {
			await rm(sandbox, { recursive: true, force: true });
		}
	});

	it('con LUMBRE_TOKEN corre el smoke, con el token en el entorno y no en la línea de órdenes', async () => {
		const { sandbox, log, logDir, run } = await createSandbox();
		try {
			const result = run({ LUMBRE_TOKEN: 'tok-smoke-secreto' });
			expect(result.status, result.stderr).toBe(0);
			const smoke = (await calls(log)).filter((line) => line.startsWith('node '));
			expect(smoke).toEqual(['node scripts/smoke-remote.mjs https://mcp.lumbre.pro/mcp token_en_entorno=si']);
			expect(await readFile(log, 'utf8')).not.toContain('tok-smoke-secreto');
			// Ni el log del deploy que queda en el servidor.
			for (const name of (await readdir(logDir)).filter((entry) => entry.startsWith('deploy-'))) {
				expect(await readFile(join(logDir, name), 'utf8')).not.toContain('tok-smoke-secreto');
			}
		} finally {
			await rm(sandbox, { recursive: true, force: true });
		}
	});

	it('LOG_DIR dentro del destino o un plazo de salud raro abortan antes de tocar nada', async () => {
		const { sandbox, log, run, reset } = await createSandbox();
		try {
			for (const extra of <Array<Record<string, string>>>[
				{ LUMBRE_MCP_DEST: '/srv/lumbre-mcp', LUMBRE_MCP_LOG_DIR: '/srv/lumbre-mcp/logs' },
				{ LUMBRE_MCP_HEALTH_TIMEOUT: '0' },
				{ LUMBRE_MCP_HEALTH_TIMEOUT: '10; rm -rf /' },
				{ LUMBRE_MCP_SMOKE_URL: 'https://mcp.lumbre.pro/mcp?x=$(id)' }
			]) {
				await reset();
				const result = run(extra);
				expect(result.status, JSON.stringify(extra)).toBe(1);
				expect(await readFile(log, 'utf8'), JSON.stringify(extra)).toBe('');
			}
		} finally {
			await rm(sandbox, { recursive: true, force: true });
		}
	});
});

describe('contenedor: memoria, señales e imagen reproducible', () => {
	/** Valor de una clave del servicio `mcp` (YAML plano, sin anidar). */
	function serviceKey(compose: string, key: string): string | undefined {
		return new RegExp(`^    ${key}:\\s*(.+)$`, 'm').exec(compose)?.[1]?.trim();
	}

	it('compose acota la memoria (límite y reserva) con el límite por encima de la reserva', async () => {
		const compose = await readFile('deploy/compose.yml', 'utf8');
		const toMiB = (value: string | undefined) => {
			const [, amount, unit] = /^(\d+)([mg])$/.exec(value ?? '') ?? [];
			expect(unit, value).toBeDefined();
			return Number(amount) * (unit === 'g' ? 1024 : 1);
		};
		const limit = toMiB(serviceKey(compose, 'mem_limit'));
		const reservation = toMiB(serviceKey(compose, 'mem_reservation'));
		// El peor caso medido con los topes nuevos (32 add_attachment de 1 MiB
		// en vuelo) fueron ~320 MB de RSS: el límite tiene que dejar margen.
		expect(limit).toBeGreaterThanOrEqual(384);
		expect(limit).toBeLessThanOrEqual(1024);
		expect(reservation).toBeLessThan(limit);
	});

	it('compose: init como PID 1 y margen de parada sobre el apagado ordenado de 10 s', async () => {
		const { SHUTDOWN_TIMEOUT_MS } = await import('./http-lifecycle.js');
		const compose = await readFile('deploy/compose.yml', 'utf8');
		expect(serviceKey(compose, 'init')).toBe('true');
		const grace = /^(\d+)s$/.exec(serviceKey(compose, 'stop_grace_period') ?? '')?.[1];
		expect(grace).toBeDefined();
		expect(Number(grace) * 1000).toBeGreaterThan(SHUTDOWN_TIMEOUT_MS);
	});

	it('compose: la imagen se etiqueta por variable y la revisión llega como build-arg', async () => {
		const compose = await readFile('deploy/compose.yml', 'utf8');
		expect(serviceKey(compose, 'image')).toBe("'lumbre-mcp:${LUMBRE_MCP_IMAGE_TAG:-latest}'");
		expect(compose).toContain("REVISION: '${LUMBRE_MCP_REVISION:-desconocida}'");
		// Healthy en segundos tras arrancar, para que publicar.sh no espere 30 s.
		expect(compose).toMatch(/^      start_interval: \d+s$/m);
	});

	it('Dockerfile: base fijada por digest y etiqueta OCI de la revisión al final', async () => {
		const dockerfile = await readFile('Dockerfile', 'utf8');
		expect(dockerfile).toMatch(/^FROM node:22-alpine@sha256:[0-9a-f]{64}$/m);
		expect(dockerfile).not.toMatch(/^FROM node:22-alpine$/m);
		expect(dockerfile).toContain('ARG REVISION=desconocida');
		expect(dockerfile).toContain('LABEL org.opencontainers.image.revision=$REVISION');
		// Después de `npm ci`: si fuera antes, cada deploy invalidaría esa capa.
		expect(dockerfile.indexOf('ARG REVISION')).toBeGreaterThan(dockerfile.indexOf('RUN npm ci'));
	});
});

describe('un .env local no puede acabar en git, en la imagen ni en el servidor', () => {
	it('.gitignore ignora .env y .env.* pero conserva .env.example versionado', () => {
		const result = spawnSync('git', ['check-ignore', '-v', '.env', '.env.local', '.env.example'], {
			cwd: process.cwd(),
			encoding: 'utf8'
		});
		// `git check-ignore` sale 0 en cuanto UNA de las rutas está ignorada y
		// solo imprime en `stdout` las que sí matchean una regla.
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('.env');
		expect(result.stdout).toContain('.env.local');
		expect(result.stdout).not.toContain('.env.example');
	});

	it('.dockerignore excluye .env y .env.* pero conserva .env.example', async () => {
		const dockerignore = await readFile('.dockerignore', 'utf8');
		expect(dockerignore).toContain('.env');
		expect(dockerignore).toContain('.env.*');
		expect(dockerignore).toContain('!.env.example');
	});

	it('publicar.sh excluye .env* del rsync antes de copiar, conservando .env.example', async () => {
		const publish = await readFile('deploy/publicar.sh', 'utf8');
		expect(publish).toContain("--include '.env.example'");
		expect(publish).toContain("--exclude '.env*'");
		// El include tiene que ir ANTES que el exclude: rsync evalúa los filtros
		// en el orden dado, así que al revés `.env.example` también caería.
		expect(publish.indexOf("--include '.env.example'")).toBeLessThan(publish.indexOf("--exclude '.env*'"));
		expect(publish).toContain('excluir un fichero no lo borra en destino');
	});

	it('un HOST con formato inválido aborta antes de invocar ssh o rsync', async () => {
		const { sandbox, log, run } = await createSandbox();
		try {
			// Una cadena vacía no cuenta: `${LUMBRE_MCP_HOST:-lumbre}` la trata como
			// no puesta y cae al valor por defecto, que sí es válido.
			for (const host of ['-oProxyCommand=evil', 'lumbre;rm -rf /', ' lumbre', '.lumbre.pro']) {
				await writeFile(log, '');
				const result = run({ LUMBRE_MCP_HOST: host });
				expect(result.status, JSON.stringify(host)).toBe(1);
				expect(result.stderr, JSON.stringify(host)).toContain('LUMBRE_MCP_HOST');
				expect(await readFile(log, 'utf8'), JSON.stringify(host)).toBe('');
			}

			await writeFile(log, '');
			const result = run({ LUMBRE_MCP_HOST: 'usuario@lumbre.example.com' });
			expect(result.status).toBe(0);
			expect(await readFile(log, 'utf8')).toContain('ssh ');
		} finally {
			await rm(sandbox, { recursive: true, force: true });
		}
	});
});
