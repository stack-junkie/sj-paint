import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { managedAiTestProfile, managedAiTestEnvironment, desktopVerificationArguments } from './managed-ai-test-profile.mjs';
import { windowsGenerationCapacity, pendingCapacityStreams } from './windows-generation-capacity.mjs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

if (process.platform !== 'win32') throw new Error('Run this packaged-app check on Windows.');
const verifierArgs = process.argv.slice(2);
const { workflow } = desktopVerificationArguments(verifierArgs);
// Opt-in managed workflows require explicit absolute paths in
// SJ_PAINT_TEST_MANAGED_PROFILE and SJ_PAINT_TEST_SETUP_RECEIPT. The completed
// setup receipt must bind that preserved profile to this checkout. There is no
// normal-user-profile fallback. Real generation also requires
// SJ_PAINT_TEST_CAPACITY_PYTHON, an absolute existing Python interpreter, then:
// node scripts/test-windows.mjs --workflow managed-generation --photo-fixture <absolute 1024px photo edit fixture>
// The release workflow covers one completed CPU erase request,
// plus the initial erase cancellation check.
// The tracked ctypes sampler reads Windows host capacity; nothing is installed.
// Managed photo acceptance uses the original NASA astronaut PNG, SHA-256
// 88431cd9653ccd539741b555fb0a46b61558b301d4110412b5bc28b5e3ea6cb5:
// node scripts/test-windows.mjs --workflow managed-ai --photo-fixture <absolute path>
// Its fixed Include/box coordinates require this exact read-only fixture.
// Photo masks, previews and package identity are retained under output/.
if(workflow === '--workflow managed-generation') {
  try {
    const capacity=await windowsGenerationCapacity();
    try { await capacity.sample(); } finally { await capacity.close(); }
  } finally {
    const pending=pendingCapacityStreams();
    if(pending.length){
      console.error(JSON.stringify({capacityCleanupPending:pending.map(owner=>owner.receipt)}));
      const closed=await Promise.all(pending.map(owner=>owner.waitForClose()));
      console.error(JSON.stringify({capacityCleanupClosed:closed}));
    }
  }
}
const root = fileURLToPath(new URL('../', import.meta.url));
const managed = ['--workflow managed-ai', '--workflow managed-quit', '--workflow managed-generation'].includes(workflow) ? await managedAiTestProfile(root) : null;
const environment = managed ? managedAiTestEnvironment(process.env) : process.env;
// Refuse occupied ports so the harness never attaches to an unrelated session.
for (const port of [9229, 9231]) {
  await new Promise((accept, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => server.close(accept));
  });
}
const profile = managed?.profile ?? await mkdtemp(resolve(tmpdir(), 'sj-paint-test-'));
const executable = resolve(root, 'release/win-unpacked/Stack Junkie Paint.exe');
// Hidden Windows compositors otherwise pace rAF at 1 Hz even with Electron's
// backgroundThrottling disabled. This changes test pacing, not the raster backend.
const child = spawn(executable, ['--hidden', '--disable-frame-rate-limit', `--user-data-dir=${profile}`, '--inspect=127.0.0.1:9231', '--remote-debugging-port=9229'], {
  cwd: root, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
const childExit = new Promise(resolve => child.once('exit', resolve));
let log = '';
const cleanupEvents = [];
let launchError;
child.on('error', error => { launchError = error; });
child.stdout.on('data', data => { log = (log + data).slice(-100_000); });
child.stderr.on('data', data => { log = (log + data).slice(-100_000); });
async function stopOwnedApp() {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  let socket, timer;
  try {
    cleanupEvents.push({ at: new Date().toISOString(), event: 'begin-owned-shutdown' });
    const targets = await fetch('http://127.0.0.1:9231/json/list', { signal: AbortSignal.timeout(3000) }).then(r => r.json());
    if (child.exitCode !== null || child.signalCode !== null) return;
    const endpoint = new URL(targets[0].webSocketDebuggerUrl);
    if (endpoint.hostname !== '127.0.0.1' || endpoint.port !== '9231') throw new Error('Unexpected cleanup inspector endpoint.');
    socket = new WebSocket(endpoint);
    await Promise.race([childExit, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Owned app did not exit; test profile retained.')), 10000);
      socket.onerror = () => reject(new Error('Could not verify app identity for cleanup.'));
      socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
        expression: `(() => { const electron = process.mainModule.require('electron'), app = electron.app; if (process.pid !== ${child.pid} || app.getPath('userData') !== ${JSON.stringify(profile)}) throw new Error('Test process identity changed'); ${managed ? `electron.dialog.showMessageBox = async () => ({ response: 1 });
          const trace = (event, extra = {}) => console.log(JSON.stringify({ shutdownTrace: event, at: new Date().toISOString(), ...extra }));
          for (const name of ['before-quit', 'will-quit', 'window-all-closed', 'quit']) app.on(name, event => trace(name, { prevented: event?.defaultPrevented }));
          for (const window of electron.BrowserWindow.getAllWindows()) for (const name of ['close', 'closed']) window.on(name, () => trace('window-' + name));
          setTimeout(() => trace('after-quit-request', { windows: electron.BrowserWindow.getAllWindows().map(window => ({ id: window.id, visible: window.isVisible() })) }), 1000);
          ` : ''} setTimeout(() => app.${managed ? 'quit()' : 'exit(0)'}, 50); return 'owned-exit-scheduled'; })()`,
      } }));
      socket.onmessage = event => {
        const result = JSON.parse(event.data);
        if (result.id === 1) cleanupEvents.push({ at: new Date().toISOString(), event: 'shutdown-evaluation', result });
        if (result.id === 1 && (result.error || result.result?.exceptionDetails)) {
          reject(new Error('Cleanup refused an unverified process.'));
        }
        if (result.id === 1 && result.result?.result?.value === 'owned-exit-scheduled') socket.close();
      };
    })]);
    cleanupEvents.push({ at: new Date().toISOString(), event: 'owned-child-exit', exitCode: child.exitCode, signalCode: child.signalCode });
  } catch (error) {
    cleanupEvents.push({ at: new Date().toISOString(), event: 'shutdown-wait-error', message: error.message });
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
  const verifier = spawn(process.execPath, ['scripts/verify-desktop.mjs', ...verifierArgs], { cwd: root,
    env: { ...environment, SJ_PAINT_TEST_PID: String(child.pid), SJ_PAINT_TEST_PROFILE: profile },
    windowsHide: true, stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => { verifier.once('error', reject); verifier.once('exit', resolve); });
  if (code !== 0) throw new Error(`Desktop verification failed (${code}).`);
  if (verifierArgs.join(' ') === '--workflow quit-cancel') {
    let timer;
    try {
      await Promise.race([childExit, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Approved application quit did not exit before harness cleanup.')), 10000);
      })]);
    } finally { clearTimeout(timer); }
  }
} finally {
  await mkdir(resolve(root, 'output'), { recursive: true });
  await writeFile(resolve(root, 'output/windows-launch.log'), log);
  const exitedBeforeHarnessCleanup = child.exitCode !== null || child.signalCode !== null;
  const profileEvidence = managed ? { ...managed, profileRetained: true } : { profileRetained: false };
  const recordRegistryAfter = async () => {
    if (managed) profileEvidence.registryAfterSha256 = await readFile(managed.registryPath)
      .then(bytes => createHash('sha256').update(bytes).digest('hex')).catch(error => ({ error: error.message }));
  };
  try { await stopOwnedApp(); }
  catch (error) {
    await recordRegistryAfter();
    await writeFile(resolve(root, 'output/windows-launch.log'), log);
    await writeFile(resolve(root, 'output/windows-cleanup.json'), JSON.stringify({ pid: child.pid, profile, ...profileEvidence, cleanupEvents, profileRetained: true, ownedProcessExited: child.exitCode !== null || child.signalCode !== null, error: error.message }, null, 2));
    throw error;
  }
  await recordRegistryAfter();
  await writeFile(resolve(root, 'output/windows-launch.log'), log);
  await writeFile(resolve(root, 'output/windows-cleanup.json'), JSON.stringify({ pid: child.pid, profile, ...profileEvidence, cleanupEvents, ownedProcessExited: child.exitCode !== null || child.signalCode !== null, exitedBeforeHarnessCleanup }, null, 2));
  if (!managed) await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
