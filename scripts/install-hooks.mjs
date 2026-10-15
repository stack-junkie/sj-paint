import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, constants, copyFileSync, existsSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try {
  const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' }).trim();
  if (realpathSync(top) !== realpathSync(root)) throw new Error('Initialize or clone the Paint repository before installing its hooks.');
  const existing = spawnSync('git', ['config', '--local', '--get', 'core.hooksPath'], { cwd: root, encoding: 'utf8' });
  if (existing.error) throw existing.error;
  if (existing.status !== 0 && existing.status !== 1) throw new Error('Cannot read repository-local hook configuration.');
  if (existing.status === 0 && existing.stdout.trim() !== '.githooks') {
    throw new Error(`An existing core.hooksPath is configured (${existing.stdout.trim()}). Preserve or deliberately replace that configuration before installing these hooks.`);
  }
  for (const name of ['pre-commit', 'pre-push']) {
    const path = resolve(root, '.githooks', name);
    if (!existsSync(path)) throw new Error(`Missing .githooks/${name}.`);
    chmodSync(path, 0o755);
  }
  if (existing.status === 1) {
    const config = resolve(root, execFileSync('git', ['rev-parse', '--git-path', 'config'], { cwd: root, encoding: 'utf8' }).trim());
    try { copyFileSync(config, `${config}.sj-paint-hooks.bak`, constants.COPYFILE_EXCL); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  execFileSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], { cwd: root, stdio: 'inherit' });
  console.log('Installed repository-local hooks from .githooks.');
} catch (error) {
  console.error(`Hook installation failed: ${error.message}`);
  process.exitCode = 1;
}
