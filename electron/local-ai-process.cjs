const { spawn } = require('node:child_process');

const MAX_HEADER_BYTES = 4096;
const MAX_STDERR_BYTES = 16 * 1024;
const MAX_PROGRESS_EVENTS = 256;
// Keep the command line independent of packaged worker size. The same buffered
// stdin reader consumes exactly this source prefix before the framed protocol.
const SOURCE_BOOTSTRAP = `import sys
_source_header = sys.stdin.buffer.read(4)
if len(_source_header) != 4:
    raise EOFError('Incomplete worker source header')
_source_length = int.from_bytes(_source_header, 'big')
_source_bytes = sys.stdin.buffer.read(_source_length)
if len(_source_bytes) != _source_length:
    raise EOFError('Incomplete worker source')
_worker_code = compile(_source_bytes.decode('utf-8'), '<sj-paint-worker>', 'exec')
del _source_header, _source_length, _source_bytes
exec(_worker_code)
`;
class LocalAiError extends Error {
  constructor(code, message) { super(message); this.name = 'LocalAiError'; this.code = code; }
}
const failure = (code, message) => new LocalAiError(code, message);

/** The sole owner of a Python child and its framed stdin/stdout transport. */
function createWorkerProcess({ pythonPath, script, args, timeoutMs = 30_000 }, dependencies = {}) {
  if (typeof script !== 'string') throw failure('CONFIG', 'Worker source must be UTF-8 text.');
  const source = Buffer.from(script, 'utf8'), sourceHeader = Buffer.alloc(4);
  sourceHeader.writeUInt32BE(source.length);
  // Real CUDA teardown can exceed one second. This internal bounded grace does
  // not release ownership; only the child's close event does that.
  const cleanupTimeoutMs = dependencies.cleanupTimeoutMs ?? 3000;
  if (!Number.isInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 1 || cleanupTimeoutMs > 10000) throw failure('CONFIG', 'Invalid internal worker cleanup deadline.');
  const environment = {};
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[key]) environment[key] = process.env[key];
  // Pinned Windows Torch indexes PATH in its DLL-error fallback. Supply the
  // expected key without exposing unrelated host executables or DLL paths.
  if (process.platform === 'win32') environment.PATH = '';
  let child;
  try {
    child = (dependencies.spawnProcess || spawn)(pythonPath, ['-I', '-B', '-u', '-c', SOURCE_BOOTSTRAP, ...args], {
      shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], cwd: require('node:path').dirname(pythonPath), env: environment,
    });
  } catch { throw failure('WORKER', 'The configured Python process could not start.'); }
  let owned = true, closing = false, terminalError = null, cleanupError = null, sequence = 0, pending = null;
  let cleanupTimer, closePromise, resolveClose, rejectClose, stderrBytes = 0;
  function finishPending(error, value) {
    const item = pending;
    if (!item) return;
    pending = null;
    clearTimeout(item.timer); item.signal?.removeEventListener('abort', item.abort);
    error ? item.reject(error) : item.resolve(value);
  }
  function close(reason = null) {
    if (closePromise) return closePromise;
    if (!owned) return terminalError ? Promise.reject(terminalError) : Promise.resolve();
    closing = true;
    terminalError = reason;
    closePromise = new Promise((resolve, reject) => { resolveClose = resolve; rejectClose = reject; });
    // Closing can start from a stream event with no waiting caller.
    closePromise.catch(() => {});
    cleanupTimer = setTimeout(() => {
      cleanupError = failure('CLEANUP', 'The owned local worker has not closed; another operation cannot start.');
      // The operation and cleanup have separate outcomes. A slow close must
      // not replace the original cancellation, timeout or protocol failure.
      finishPending(terminalError || cleanupError); rejectClose(cleanupError);
    }, cleanupTimeoutMs);
    // Exited processes may still have open pipes. Keep the same cleanup deadline.
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch { /* Ownership remains until close. */ }
    }
    return closePromise;
  }
  function protocol(message) { void close(failure('PROTOCOL', message)); }
  child.on('error', () => { void close(failure('WORKER', 'The configured Python process could not start or be controlled.')); });
  child.stdin.on('error', () => { if (!closing) void close(failure('WORKER', 'The local worker input stream closed unexpectedly.')); });
  child.stderr.on('data', chunk => {
    stderrBytes += chunk.length;
    if (stderrBytes > MAX_STDERR_BYTES) protocol('The local worker exceeded its diagnostic limit.');
  });
  child.stdout.on('data', chunk => {
    if (closing) return;
    const item = pending;
    if (!item) { protocol('The local worker returned an unsolicited frame.'); return; }
    item.received += chunk.length;
    if (item.received > MAX_HEADER_BYTES * (MAX_PROGRESS_EVENTS + 1) + item.maxPayload) { protocol('The local worker exceeded its output limit.'); return; }
    while (!closing) {
      if (!item.header) {
        const newline = chunk.indexOf(10), count = newline < 0 ? chunk.length : newline;
        if (item.bytes.length + count >= MAX_HEADER_BYTES) { protocol('The local worker header is too large.'); return; }
        item.bytes = Buffer.concat([item.bytes, chunk.subarray(0, count)]);
        if (newline < 0) return;
        chunk = chunk.subarray(newline + 1);
        let h;
        try { h = JSON.parse(item.bytes.toString('utf8')); } catch { protocol('The local worker returned an invalid header.'); return; }
        item.bytes = Buffer.alloc(0);
        if (!h || h.version !== 2 || h.id !== item.id || h.operation !== item.operation) {
          protocol('The local worker returned an incompatible frame.'); return;
        }
        if (h.event === 'progress') {
          const p = h.progress;
          if (++item.progressEvents > MAX_PROGRESS_EVENTS || h.payloadLength !== 0 || !p ||
              typeof p.stage !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(p.stage) ||
              !Number.isSafeInteger(p.completed) || !Number.isSafeInteger(p.total) || p.total < 1 ||
              p.total > 1000000 || p.completed < 0 || p.completed > p.total) {
            protocol('The local worker returned invalid or excessive progress.'); return;
          }
          try { item.onProgress?.({ stage: p.stage, completed: p.completed, total: p.total }); } catch { /* A UI observer does not own worker transport. */ }
          if (!chunk.length) return;
          continue;
        }
        if (h.event !== undefined || typeof h.ok !== 'boolean' || !Number.isSafeInteger(h.payloadLength) ||
            h.payloadLength < 0 || h.payloadLength > item.maxPayload || (!h.ok && h.payloadLength !== 0)) {
          protocol('The local worker returned an incompatible frame.'); return;
        }
        item.header = h; item.payload = Buffer.alloc(h.payloadLength);
      }
      if (item.payloadReceived + chunk.length > item.payload.length) { protocol('The local worker returned duplicate or trailing bytes.'); return; }
      chunk.copy(item.payload, item.payloadReceived); item.payloadReceived += chunk.length;
      if (item.payloadReceived === item.payload.length) finishPending(null, { header: item.header, payload: item.payload });
      return;
    }
  });
  child.on('close', () => {
    if (!owned) return;
    owned = false; clearTimeout(cleanupTimer);
    if (!closing) terminalError = pending?.received ? failure('PROTOCOL', 'The local worker closed during an incomplete frame.') : failure('WORKER', 'The local worker exited unexpectedly.');
    finishPending(terminalError || failure('ABORTED', 'The local image operation was cancelled.'));
    if (closePromise) terminalError ? rejectClose(terminalError) : resolveClose();
    try { dependencies.onOwnershipReleased?.(); } catch { /* The observer does not own transport cleanup. */ }
  });
  // Queue source only after every error/closure handler owns the child. Node's
  // ordered writable stream puts all subsequent request frames after these bytes.
  try { child.stdin.write(sourceHeader); if (source.length) child.stdin.write(source); }
  catch { void close(failure('WORKER', 'The local worker source could not be sent.')); }
  function request(operation, fields, payload, maxPayload, signal, onProgress) {
    if (owned && cleanupError) return Promise.reject(cleanupError);
    if (closing || !owned) return Promise.reject(terminalError || failure('WORKER', 'The local worker is closed.'));
    if (pending) return Promise.reject(failure('BUSY', 'The local worker already owns an operation.'));
    if (signal?.aborted) return Promise.reject(failure('ABORTED', 'The local image operation was cancelled.'));
    const id = ++sequence;
    const frame = Buffer.from(JSON.stringify({ ...fields, version: 2, id, operation, payloadLength: payload.length }) + '\n');
    if (frame.length > MAX_HEADER_BYTES) return Promise.reject(failure('INPUT', 'The local worker request header is too large.'));
    return new Promise((resolve, reject) => {
      const abort = () => { void close(failure('ABORTED', 'The local image operation was cancelled.')); };
      pending = { id, operation, maxPayload, signal, onProgress, progressEvents: 0, abort, resolve, reject, bytes: Buffer.alloc(0), header: null, received: 0, payloadReceived: 0,
        timer: setTimeout(() => { void close(failure('TIMEOUT', 'The local image worker exceeded its time limit.')); }, timeoutMs) };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      if (!closing) { child.stdin.write(frame); if (payload.length) child.stdin.write(payload); }
    });
  }
  // Node's close event follows exit AND stdio closure. Exit alone cannot clear
  // this gate. A confirmed late close releases ownership without rewriting the
  // already settled operation or cleanup promise.
  return { request, close, state: () => ({ owned, closing, blocked: owned && !!cleanupError,
    error: terminalError || cleanupError, cleanupError }) };
}
module.exports = { createWorkerProcess, LocalAiError };
