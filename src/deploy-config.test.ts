import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('deploy OAuth fail-closed', () => {
	it('compose exige el secreto y publicar lo lee fuera del árbol borrado por rsync', async () => {
		const compose = await readFile('deploy/compose.yml', 'utf8');
		expect(compose).toContain('LUMBRE_MCP_BACKCHANNEL_SECRET:');
		expect(compose).toContain('${LUMBRE_MCP_BACKCHANNEL_SECRET:?');

		const publish = await readFile('deploy/publicar.sh', 'utf8');
		expect(publish).toContain('ENV_FILE="${LUMBRE_MCP_ENV_FILE:-/srv/lumbre-mcp.env}"');
		expect(publish).toContain('test \\$(stat -c %a $ENV_FILE) = 600');
		expect(publish).toContain('docker compose --env-file $ENV_FILE -f deploy/compose.yml up -d --build');
		const validation = publish.indexOf('Validando secreto remoto');
		const deletion = publish.indexOf('rsync -az --delete');
		expect(validation).toBeGreaterThan(0);
		expect(deletion).toBeGreaterThan(validation);
	});

	it('ejecuta el precheck remoto y rechaza secretos dentro del destino antes de ssh/rsync', async () => {
		const sandbox = await mkdtemp(join(tmpdir(), 'lumbre-mcp-deploy-test-'));
		try {
			const bin = join(sandbox, 'bin');
			const log = join(sandbox, 'calls.log');
			await mkdir(bin);
			const fake = async (name: string, body: string) => {
				const path = join(bin, name);
				await writeFile(path, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o700 });
				await chmod(path, 0o700);
			};
			await fake('npm', 'printf "npm %s\\n" "$*" >> "$CALL_LOG"');
			await fake('git', 'printf "git %s\\n" "$*" >> "$CALL_LOG"');
			await fake('rsync', 'printf "rsync %s\\n" "$*" >> "$CALL_LOG"');
			await fake('ssh', 'printf "ssh %s\\n" "$*" >> "$CALL_LOG"; [[ "${FAKE_REMOTE_MODE:-600}" == 600 ]]');

			const run = (extraEnv: Record<string, string> = {}) => spawnSync('bash', ['deploy/publicar.sh'], {
				cwd: process.cwd(),
				encoding: 'utf8',
				env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALL_LOG: log, ...extraEnv }
			});

			let result = run();
			expect(result.status).toBe(0);
			expect(await readFile(log, 'utf8')).toContain('test -r /srv/lumbre-mcp.env');

			await writeFile(log, '');
			result = run({ LUMBRE_MCP_ENV_FILE: '/srv/secrets/lumbre-mcp.env' });
			expect(result.status).toBe(0);
			expect(await readFile(log, 'utf8')).toContain('test -r /srv/secrets/lumbre-mcp.env');

			for (const envFile of ['/srv/lumbre-mcp', '/srv/lumbre-mcp/.env']) {
				await writeFile(log, '');
				result = run({ LUMBRE_MCP_ENV_FILE: envFile });
				expect(result.status, envFile).toBe(1);
				expect(result.stderr, envFile).toContain('fuera de LUMBRE_MCP_DEST');
				expect(await readFile(log, 'utf8'), envFile).toBe('');
			}

			for (const envFile of ['/srv/lumbre-mcp/./.env', '/srv//lumbre-mcp/.env', '/srv/other/../lumbre-mcp/.env']) {
				await writeFile(log, '');
				result = run({ LUMBRE_MCP_ENV_FILE: envFile });
				expect(result.status, envFile).toBe(1);
				expect(result.stderr, envFile).toContain('ruta absoluta canónica');
				expect(await readFile(log, 'utf8'), envFile).toBe('');
			}

			await writeFile(log, '');
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
