import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

if (process.platform !== 'win32') throw new Error('Run this packaged-app check on Windows.');
const root = fileURLToPath(new URL('../', import.meta.url));
// Refuse occupied ports so the harness never attaches to an unrelated session.
for (const port of [9229, 9231]) {
  await new Promise((accept, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => server.close(accept));
  });
}
const profile = await mkdtemp(resolve(tmpdir(), 'sj-paint-test-'));
const executable = resolve(root, 'release/win-unpacked/Stack Junkie Paint.exe');
// Hidden Windows compositors otherwise pace rAF at 1 Hz even with Electron's
// backgroundThrottling disabled. This changes test pacing, not the raster backend.
const child = spawn(executable, ['--hidden', '--disable-frame-rate-limit', `--user-data-dir=${profile}`, '--inspect=127.0.0.1:9231', '--remote-debugging-port=9229'], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
const childExit = new Promise(resolve => child.once('exit', resolve));
let log = '';
let launchError;
child.on('error', error => { launchError = error; });
child.stdout.on('data', data => { log = (log + data).slice(-100_000); });
child.stderr.on('data', data => { log = (log + data).slice(-100_000); });
async function stopOwnedApp() {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  let socket, timer;
  try {
    const targets = await fetch('http://127.0.0.1:9231/json/list', { signal: AbortSignal.timeout(3000) }).then(r => r.json());
    if (child.exitCode !== null || child.signalCode !== null) return;
    const endpoint = new URL(targets[0].webSocketDebuggerUrl);
    if (endpoint.hostname !== '127.0.0.1' || endpoint.port !== '9231') throw new Error('Unexpected cleanup inspector endpoint.');
    socket = new WebSocket(endpoint);
    await Promise.race([childExit, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Owned app did not exit; test profile retained.')), 10000);
      socket.onerror = () => reject(new Error('Could not verify app identity for cleanup.'));
      socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
        expression: `(() => { const app = process.mainModule.require('electron').app; if (process.pid !== ${child.pid} || app.getPath('userData') !== ${JSON.stringify(profile)}) throw new Error('Test process identity changed'); setTimeout(() => app.exit(0), 50); return 'owned-exit-scheduled'; })()`,
      } }));
      socket.onmessage = event => {
        const result = JSON.parse(event.data);
        if (result.id === 1 && (result.error || result.result?.exceptionDetails)) {
          reject(new Error('Cleanup refused an unverified process.'));
        }
        if (result.id === 1 && result.result?.result?.value === 'owned-exit-scheduled') socket.close();
      };
    })]);
  } catch (error) {
    // Close may stop the inspector at any transport stage before the process
    // exit event arrives. The launch-owned exit promise is the completion proof.
    clearTimeout(timer);
    const exited = await Promise.race([childExit.then(() => true), new Promise(resolve => {
      timer = setTimeout(() => resolve(false), 10000);
    })]);
    if (!exited) throw error;
  } finally { clearTimeout(timer); socket?.close(); }
}
try {
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (launchError) throw launchError;
    if (child.exitCode !== null) throw new Error(`App exited before verification: ${child.exitCode}\n${log}`);
    try {
      const [renderer, main] = await Promise.all([9229, 9231].map(port => fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(500) }).then(r => r.json())));
      if (renderer.some(item => item.type === 'page') && main.length) { ready = true; break; }
    } catch { /* Wait for this owned process to expose both loopback endpoints. */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error(`App did not become ready.\n${log}`);
  const verifier = spawn(process.execPath, ['scripts/verify-desktop.mjs'], { cwd: root,
    env: { ...process.env, SJ_PAINT_TEST_PID: String(child.pid), SJ_PAINT_TEST_PROFILE: profile },
    windowsHide: true, stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => { verifier.once('error', reject); verifier.once('exit', resolve); });
  if (code !== 0) throw new Error(`Desktop verification failed (${code}).`);
} finally {
  await mkdir(resolve(root, 'output'), { recursive: true });
  await writeFile(resolve(root, 'output/windows-launch.log'), log);
  try { await stopOwnedApp(); }
  catch (error) {
    await writeFile(resolve(root, 'output/windows-cleanup.json'), JSON.stringify({ pid: child.pid, profile, ownedProcessExited: child.exitCode !== null || child.signalCode !== null, error: error.message }, null, 2));
    throw error;
  }
  await writeFile(resolve(root, 'output/windows-cleanup.json'), JSON.stringify({ pid: child.pid, profile, ownedProcessExited: child.exitCode !== null || child.signalCode !== null }, null, 2));
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
