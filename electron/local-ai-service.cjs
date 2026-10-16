const path = require('node:path');
const { createLocalAi, LocalAiError, MODEL_SHA256, MAX_PIXELS, MAX_PNG_BYTES } = require('./local-ai.cjs');

const success = value => ({ ok: true, value });
const error = (code, message) => ({ ok: false, error: { code, message } });
const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id);
const cleanupFailure = () => error('CLEANUP', 'Local worker cleanup is unresolved; further work is blocked.');
const backendCodes = new Set(['CONFIG', 'BUSY', 'INPUT', 'MODEL', 'RUNTIME', 'ABORTED', 'TIMEOUT', 'PROTOCOL', 'WORKER', 'CLEANUP']);

/** Main-process owner. Configuration is captured once from trusted host environment. */
function createLocalAiService({ env = process.env, createBackend = createLocalAi } = {}) {
  const pythonPath = env.SJ_PAINT_PYTHON;
  const modelPath = env.SJ_PAINT_U2NETP_MODEL;
  let configurationError = null;
  let backend = null;
  let active = null;
  let ready = false;
  let closed = false;
  let blocked = false;

  if (!pythonPath || !modelPath) {
    configurationError = error('UNCONFIGURED', 'Set SJ_PAINT_PYTHON and SJ_PAINT_U2NETP_MODEL to an existing Python runtime and the approved model.');
  } else if (typeof pythonPath !== 'string' || !path.isAbsolute(pythonPath) ||
      typeof modelPath !== 'string' || !path.isAbsolute(modelPath)) {
    configurationError = error('CONFIG', 'Local background removal requires absolute Python and model paths.');
  } else {
    try { backend = createBackend({ pythonPath, modelPath }); }
    catch { configurationError = error('CONFIG', 'The existing local runtime configuration is invalid.'); }
  }

  function status() {
    return success({
      state: blocked ? 'blocked' : closed ? 'closed' : !backend ? 'unconfigured' : active ? 'busy' : 'idle',
      configured: !!backend,
      ready: ready && !closed && !blocked,
      closed,
      active: active ? { id: active.id, kind: active.kind } : null,
      model: { name: 'u2netp', sha256: MODEL_SHA256 },
      bounds: { maxPixels: MAX_PIXELS, maxPngBytes: MAX_PNG_BYTES },
      configurationError: configurationError ? { ...configurationError.error } : null,
    });
  }

  function backendFailure(cause) {
    if (cause instanceof LocalAiError && backendCodes.has(cause.code)) {
      return error(cause.code, cause.message);
    }
    // Never propagate unexpected runtime paths, exception objects or ambient details over IPC.
    return error('WORKER', 'The local image worker failed unexpectedly.');
  }

  async function execute(kind, request) {
    if (blocked) return cleanupFailure();
    if (closed) return error('CLOSED', 'The local image service is shutting down.');
    if (!backend) return { ok: false, error: { ...configurationError.error } };
    if (!request || !validId(request.id)) return error('INPUT', 'Provide an operation ID of 1 to 80 letters, digits, underscores or hyphens.');
    if (active) return error('BUSY', 'The local image service already owns an operation.');
    const lease = { id: request.id, kind, controller: new AbortController(), settled: null };
    active = lease;
    lease.settled = (async () => {
      let result;
      try {
        const value = kind === 'probe'
          ? await backend.probe({ signal: lease.controller.signal })
          : await backend.run({ png: request.png, width: request.width, height: request.height, signal: lease.controller.signal });
        // An abort raced with a completed worker. Do not return an apply-able late result.
        if (lease.controller.signal.aborted) result = error('ABORTED', 'Background removal was cancelled.');
        else { ready = true; result = success(value); }
      } catch (cause) {
        result = backendFailure(cause);
        if (['CONFIG', 'MODEL', 'RUNTIME', 'PROTOCOL', 'WORKER', 'CLEANUP'].includes(result.error.code)) ready = false;
        if (result.error.code === 'CLEANUP') blocked = true;
      }
      // CLEANUP means the backend still owns an unresolved child. Retain this lease.
      if (!blocked && active === lease) active = null;
      return result;
    })();
    return lease.settled;
  }

  async function cancel(request) {
    if (blocked) return cleanupFailure();
    if (!request || !validId(request.id)) return error('INPUT', 'Provide a valid operation ID to cancel.');
    const lease = active;
    if (!lease || request.id !== lease.id) return error('NOT_FOUND', 'That operation is not active.');
    lease.controller.abort();
    const result = await lease.settled;
    if (!result.ok && result.error.code === 'CLEANUP') return cleanupFailure();
    return success({ id: lease.id, cancelled: true });
  }

  async function shutdown() {
    closed = true;
    ready = false;
    if (blocked) return cleanupFailure();
    const lease = active;
    if (lease) {
      lease.controller.abort();
      const result = await lease.settled;
      if (!result.ok && result.error.code === 'CLEANUP') return cleanupFailure();
    }
    return success({ closed: true });
  }

  return { status, probe: request => execute('probe', request), run: request => execute('run', request), cancel, shutdown };
}

module.exports = { createLocalAiService };
