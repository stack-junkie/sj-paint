const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');

const MODEL_SHA256 = '309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8';
const MAX_PIXELS = 16_000_000;
const MAX_PNG_BYTES = 64 * 1024 * 1024;
const MAX_HEADER_BYTES = 4096;
const MAX_STDERR_BYTES = 16 * 1024;
const ERROR_CODES = new Set(['INPUT', 'MODEL', 'RUNTIME']);

class LocalAiError extends Error {
  constructor(code, message) { super(message); this.name = 'LocalAiError'; this.code = code; }
}
const failure = (code, message) => new LocalAiError(code, message);

function validateInput(png, width, height) {
  if (!(png instanceof Uint8Array) || !Number.isInteger(width) || !Number.isInteger(height) ||
      width < 1 || height < 1 || width * height > MAX_PIXELS || png.byteLength < 33 || png.byteLength > MAX_PNG_BYTES) {
    throw failure('INPUT', 'Choose a PNG image of at most 16 million pixels and 64 MiB.');
  }
  const bytes = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR' ||
      bytes.readUInt32BE(16) !== width || bytes.readUInt32BE(20) !== height) {
    throw failure('INPUT', 'PNG dimensions do not match the requested image.');
  }
  // Snapshot the caller's bytes before awaiting or spawning the worker.
  return Buffer.from(bytes);
}

function decodeResponse(bytes, mode, width, height) {
  const newline = bytes.indexOf(10);
  if (newline < 1 || newline >= MAX_HEADER_BYTES) throw failure('PROTOCOL', 'The local worker returned an invalid header.');
  let header;
  try { header = JSON.parse(bytes.toString('utf8', 0, newline)); }
  catch { throw failure('PROTOCOL', 'The local worker returned an invalid header.'); }
  if (!header || header.version !== 1 || header.operation !== mode || typeof header.ok !== 'boolean') {
    throw failure('PROTOCOL', 'The local worker returned an incompatible response.');
  }
  const payload = bytes.subarray(newline + 1);
  if (!header.ok) {
    if (payload.length || !ERROR_CODES.has(header.code) || typeof header.message !== 'string' || header.message.length > 256) {
      throw failure('PROTOCOL', 'The local worker returned an invalid error.');
    }
    throw failure(header.code, header.message);
  }
  const metadata = header.metadata;
  if (!metadata || metadata.model !== 'u2netp' || metadata.modelSha256 !== MODEL_SHA256 ||
      metadata.provider !== 'CPUExecutionProvider' || typeof metadata.runtimeVersion !== 'string' ||
      !/^\d+\.\d+\.\d+[\w.+-]*$/.test(metadata.runtimeVersion)) {
    throw failure('PROTOCOL', 'The local worker did not confirm the configured model and CPU runtime.');
  }
  if (mode === 'probe') {
    if (payload.length) throw failure('PROTOCOL', 'The readiness probe returned unexpected bytes.');
    return metadata;
  }
  if (header.width !== width || header.height !== height || payload.length !== width * height ||
      !Number.isFinite(metadata.elapsedMs) || metadata.elapsedMs < 0 ||
      !Number.isFinite(metadata.rawMin) || !Number.isFinite(metadata.rawMax) ||
      metadata.rawMin < 0 || metadata.rawMax > 1 || metadata.rawMax <= metadata.rawMin) {
    throw failure('PROTOCOL', 'The local worker returned an invalid mask.');
  }
  return { mask: Uint8Array.from(payload), width, height, metadata };
}

/** Trusted main-process configuration only. This API never reads renderer-selected paths. */
function createLocalAi({ pythonPath, modelPath, timeoutMs = 30_000 } = {}, dependencies = {}) {
  if (typeof pythonPath !== 'string' || !path.isAbsolute(pythonPath) ||
      typeof modelPath !== 'string' || !path.isAbsolute(modelPath) ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw failure('CONFIG', 'Configure absolute Python and model paths and a timeout of at most 120 seconds.');
  }
  // Injection is for process-boundary tests; the packaged caller uses native spawn/readFile.
  const spawnProcess = dependencies.spawnProcess || spawn;
  const readFile = dependencies.readFile || fs.readFile;
  let active = false;
  let ownedChild = null;

  async function execute(mode, { png, width, height, signal } = {}) {
    if (signal?.aborted) throw failure('ABORTED', 'Background removal was cancelled.');
    if (active) throw failure('BUSY', 'The local image worker is already running.');
    const input = mode === 'run' ? validateInput(png, width, height) : Buffer.alloc(0);
    active = true;
    let script;
    try {
      // Electron fs reads resources in app.asar. Python receives source directly, no extracted temp script.
      script = await readFile(path.join(__dirname, 'background-worker.py'), 'utf8');
      if (signal?.aborted) throw failure('ABORTED', 'Background removal was cancelled.');
    } catch (error) { active = false; throw error instanceof LocalAiError ? error : failure('WORKER', 'The local worker source could not be read.'); }

    return new Promise((resolve, reject) => {
      let child, stoppedError, settled = false, killTimer;
      let stdoutBytes = 0, stderrBytes = 0;
      const chunks = [];
      const maxOutput = MAX_HEADER_BYTES + (mode === 'run' ? width * height : 0);
      const environment = {};
      for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
        if (process.env[key]) environment[key] = process.env[key];
      }
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer); clearTimeout(killTimer);
        signal?.removeEventListener('abort', abort);
        error ? reject(error) : resolve(value);
      };
      const stop = error => {
        if (stoppedError) return;
        stoppedError = error;
        // Exit and stdio close are separate events. An exited child can still
        // leave its pipes open; retain ownership but bound that cleanup wait.
        killTimer = setTimeout(() => finish(failure('CLEANUP', 'The owned local worker has not closed; another operation cannot start.')), 1000);
        if (!child || child.exitCode !== null || child.signalCode !== null) return;
        try { child.kill('SIGKILL'); }
        catch { /* Keep ownership and BUSY until close, even when cleanup fails. */ }
      };
      const abort = () => stop(failure('ABORTED', 'Background removal was cancelled.'));
      const timer = setTimeout(() => stop(failure('TIMEOUT', 'The local image worker exceeded its time limit.')), timeoutMs);
      try {
        child = spawnProcess(pythonPath, ['-I', '-B', '-u', '-c', script, mode, modelPath, String(width || 0), String(height || 0)], {
          shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], cwd: path.dirname(pythonPath), env: environment,
        });
        ownedChild = child;
      } catch { active = false; finish(failure('WORKER', 'The configured Python process could not start.')); return; }
      child.on('error', () => stop(failure('WORKER', 'The configured Python process could not start or be controlled.')));
      child.stdin.on('error', () => { /* An early worker rejection can close stdin before all bytes are sent. */ });
      child.stdout.on('data', chunk => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxOutput) { stop(failure('PROTOCOL', 'The local worker exceeded its output limit.')); return; }
        if (!stoppedError) chunks.push(chunk);
      });
      child.stderr.on('data', chunk => {
        stderrBytes += chunk.length;
        if (stderrBytes > MAX_STDERR_BYTES) stop(failure('PROTOCOL', 'The local worker exceeded its diagnostic limit.'));
      });
      child.on('close', code => {
        if (ownedChild === child) { ownedChild = null; active = false; }
        if (stoppedError) { finish(stoppedError); return; }
        try {
          const value = decodeResponse(Buffer.concat(chunks, stdoutBytes), mode, width, height);
          if (code !== 0) throw failure('WORKER', 'The local worker exited unsuccessfully.');
          finish(null, value);
        } catch (error) { finish(error); }
      });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      if (!stoppedError) child.stdin.end(input);
    });
  }
  return { probe: options => execute('probe', options), run: options => execute('run', options) };
}

module.exports = { createLocalAi, LocalAiError, MODEL_SHA256, MAX_PIXELS, MAX_PNG_BYTES };
