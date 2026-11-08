import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

// Configuración del despliegue: compose.yml, Dockerfile, .dockerignore y las
// constantes de deploy/publicar.sh. El comportamiento del despliegue por
// registro (huella, vuelta atrás, orden de los pasos) se prueba en
// `deploy-registro.test.ts` con dobles de docker y ssh.

describe('deploy OAuth fail-closed', () => {
	it('compose exige el secreto y publicar lo pasa a compose desde un fichero FUERA del directorio del servicio', async () => {
		const compose = await readFile('deploy/compose.yml', 'utf8');
		expect(compose).toContain('LUMBRE_MCP_BACKCHANNEL_SECRET:');
		expect(compose).toContain('${LUMBRE_MCP_BACKCHANNEL_SECRET:?');

		const publish = await readFile('deploy/publicar.sh', 'utf8');
		expect(publish).toContain('DEPLOY_SECRETS_ENV="${LUMBRE_MCP_ENV_FILE:-/srv/lumbre-mcp.env}"');
		const remote = await readFile('deploy/lib/remote-release.sh', 'utf8');
		expect(remote).toContain('args=(--env-file "$RELEASE_SECRETS_ENV")');
	});

	it('compose pasa las variables de Sumego como OPCIONALES: lumbre sigue arrancando sin ellas', async () => {
		const compose = await readFile('deploy/compose.yml', 'utf8');
		for (const name of [
			'LUMBRE_MCP_LOGIN_PROVIDER',
			'LUMBRE_MCP_OIDC_ISSUER',
			'LUMBRE_MCP_OIDC_CLIENT_ID',
			'LUMBRE_MCP_OIDC_CLIENT_SECRET'
		]) {
			// `${VAR:-}` y nunca `${VAR:?…}`: compose no puede abortar por ellas;
			// el que decide si faltan es el relé, según el proveedor.
			expect(compose, name).toContain(`${name}: '\${${name}:-}'`);
			expect(compose, name).not.toContain(`\${${name}:?`);
		}
		const example = await readFile('.env.example', 'utf8');
		expect(example).toMatch(/^LUMBRE_MCP_LOGIN_PROVIDER=lumbre$/m);
		expect(example).toMatch(/^LUMBRE_MCP_OIDC_CLIENT_SECRET=$/m);
	});
});

describe('publicar.sh: constantes que tienen que casar con compose.yml y el registro', () => {
	it('servicio, contenedor, variable de imagen y nombre en el registro', async () => {
		const publish = await readFile('deploy/publicar.sh', 'utf8');
		const compose = await readFile('deploy/compose.yml', 'utf8');
		expect(publish).toContain('DEPLOY_SERVICE="mcp"');
		expect(compose).toMatch(/^ {2}mcp:$/m);
		expect(publish).toContain('DEPLOY_CONTAINER="lumbre-mcp"');
		expect(compose).toMatch(/^ {4}container_name: lumbre-mcp$/m);
		expect(publish).toContain('DEPLOY_ENV_VAR="LUMBRE_MCP_IMAGE"');
		expect(compose).toContain("image: '${LUMBRE_MCP_IMAGE:-lumbre-mcp:latest}'");
		expect(publish).toContain('DEPLOY_IMAGE="lumbre-mcp"');
	});

	it('ya no copia el árbol por rsync ni construye en el server', async () => {
		const publish = await readFile('deploy/publicar.sh', 'utf8');
		const lib = await readFile('deploy/lib/deploy-registro.sh', 'utf8');
		const remote = await readFile('deploy/lib/remote-release.sh', 'utf8');
		for (const text of [publish, lib, remote]) {
			expect(text).not.toMatch(/\brsync\b.*(--delete|-rlptz)/);
			expect(text).not.toContain('compose build');
			expect(text).not.toContain('--build');
		}
		const compose = await readFile('deploy/compose.yml', 'utf8');
		expect(compose).not.toMatch(/^ {4}build:/m);
	});

	it('la etiqueta es el sha completo y el build sube por huella (--push + --metadata-file)', async () => {
		const publish = await readFile('deploy/publicar.sh', 'utf8');
		expect(publish).toMatch(/deploy_tag_for_commit\(\) \{\n {2}echo "\$1"\n\}/);
		const lib = await readFile('deploy/lib/deploy-registro.sh', 'utf8');
		expect(lib).toContain('--push');
		expect(lib).toContain('--metadata-file');
		expect(lib).toContain('--label "org.opencontainers.image.revision=$sha"');
	});

	it('los scripts son bash válido', () => {
		for (const file of ['deploy/publicar.sh', 'deploy/lib/deploy-registro.sh', 'deploy/lib/remote-release.sh', 'deploy/lib/docker-platform.sh']) {
			const result = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
			expect(result.status, `${file}: ${result.stderr}`).toBe(0);
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

	it('compose: la imagen sale de la variable por huella y hay healthy en segundos', async () => {
		const compose = await readFile('deploy/compose.yml', 'utf8');
		expect(serviceKey(compose, 'image')).toBe("'${LUMBRE_MCP_IMAGE:-lumbre-mcp:latest}'");
		// Healthy en segundos tras arrancar, para que `up --wait` no espere 30 s.
		expect(compose).toMatch(/^ {6}start_interval: \d+s$/m);
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

describe('un .env local no puede acabar en git ni en la imagen', () => {
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
});
