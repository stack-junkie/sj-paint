const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createLocalAi, LocalAiError, BACKGROUND_MODELS, MAX_PIXELS, MAX_PNG_BYTES, SELECTION_HASHES, SELECTION_MAX_SIDE, SELECTION_MAX_PNG_BYTES,
  BASE_MODEL, BASE_REVISION, BASE_COMPONENT_PROFILE, COLORING_MODEL, COLORING_ADAPTER, generationPipeline, GENERATIVE_BOUNDS, GENERATIVE_MODES, GENERATION_MODELS, GENERATION_REQUIREMENTS, GENERATION_DEFAULTS, generationModel, REMOVAL_MODEL, REMOVAL_SHA256 } = require('./local-ai.cjs');
const releaseFeatures = new Set(require('./ai-capabilities.json').setupFeatures);
const releasedGenerationModels = new Set(Object.values(GENERATION_MODELS));
const generationModelDetails = Object.fromEntries(Object.entries({
  [BASE_MODEL]: { name: BASE_MODEL, configuredRevision: BASE_REVISION, componentProfile: BASE_COMPONENT_PROFILE },
  [COLORING_MODEL]: { name: COLORING_MODEL, configuredRevision: BASE_REVISION, componentProfile: BASE_COMPONENT_PROFILE, adapter: { ...COLORING_ADAPTER } },
  [REMOVAL_MODEL]: { name: REMOVAL_MODEL, sha256: REMOVAL_SHA256 },
}).filter(([model]) => releasedGenerationModels.has(model)));
const generationAdapters = Object.fromEntries(Object.entries({ coloring: { ...COLORING_ADAPTER } }).filter(([mode]) => GENERATIVE_MODES.includes(mode)));
const success = value => ({ ok: true, value });
const error = (code, message) => ({ ok: false, error: { code, message } });
const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id);
const cleanupFailure = () => error('CLEANUP', 'Local worker cleanup is unresolved; further work is blocked.');
const backendCodes = new Set(['CONFIG', 'BUSY', 'INPUT', 'MODEL', 'RUNTIME', 'ABORTED', 'TIMEOUT', 'PROTOCOL', 'WORKER', 'CLEANUP', 'SESSION_EXPIRED']);

/** One main-process owner for operations and an optional retained image session. */
function createLocalAiService({ env = process.env, configuration, createBackend = createLocalAi, idleTimeoutMs = 60_000, onProgress, onOwnershipReleased } = {}) {
  if (!Number.isInteger(idleTimeoutMs) || idleTimeoutMs < 1 || idleTimeoutMs > 60_000) throw new RangeError('Selection idle timeout must be between 1 and 60000 milliseconds.');
  // Managed setup passes this configuration from the main process. Environment
  // aliases remain available for existing development/verification launchers.
  const source = configuration ?? { pythonPath: env.SJ_PAINT_PYTHON, modelPath: env.SJ_PAINT_U2NETP_MODEL,
    encoderPath: env.SJ_PAINT_EFFICIENTSAM_ENCODER, decoderPath: env.SJ_PAINT_EFFICIENTSAM_DECODER };
  const backgroundModelId = source.backgroundModelId ?? 'u2netp';
  const config = { backgroundModelId };
  for (const [feature, key] of [[BASE_MODEL, 'baseAccelerator'], [COLORING_MODEL, 'coloringAccelerator']]) if (releaseFeatures.has(feature) && source[key] !== undefined) config[key] = source[key];
  const configurations = {};
  for (const [feature, keys] of [['u2netp', ['pythonPath', 'modelPath']], ['efficientsam-ti', ['pythonPath', 'encoderPath', 'decoderPath']],
    [BASE_MODEL, ['basePythonPath', 'baseModelPath']], [COLORING_MODEL, ['coloringPythonPath', 'coloringModelPath']], [REMOVAL_MODEL, ['pythonPath', 'removalModelPath']]]) {
    if (!releaseFeatures.has(feature)) continue;
    const values = keys.map(key => source[key]);
    configurations[feature] = values.some(value => !value) ? error('UNCONFIGURED', 'Configure an existing Python runtime and the approved local model paths.') : values.some(value => typeof value !== 'string' || !path.isAbsolute(value)) ? error('CONFIG', 'Local inference requires absolute Python and model paths.') : null;
    if (!configurations[feature]) for (const key of keys) config[key] = source[key];
  }
  let backend = null, active = null, retained = null, generation = null, closed = false, idleTimer = null, releasing = null;
  const ready = Object.fromEntries(Object.keys(configurations).map(feature => [feature, false]));
  if (Object.values(configurations).some(value => value === null)) {
    try { backend = createBackend(config, { onOwnershipReleased }); if (typeof backend?.state !== 'function') throw new TypeError('Backend ownership is required.'); }
    catch { backend = null; for (const feature of Object.keys(configurations)) configurations[feature] = error('CONFIG', 'The existing local runtime configuration is invalid.'); }
  }
  const stopIdle = () => { clearTimeout(idleTimer); idleTimer = null; };
  function inspectBackend() {
    const state = backend?.state();
    if (state && retained && !state.retained && !state.blocked) { retained = null; ready['efficientsam-ti'] = false; stopIdle(); }
    // A generation lease may outlive a worker while an operation is starting.
    // Only a settled operation can establish lost retention.
    if (state && generation && !state.owned && !state.blocked && (!active || active.finished)) { generation = null; for (const model of new Set(Object.values(GENERATION_MODELS))) ready[model] = false; stopIdle(); }
    // A failed lease remains identifiable while its worker is owned. Late close
    // clears that lease; no second latch may outlive the process owner's facts.
    if (active?.finished && state && !state.owned) active = null;
    return state;
  }
  function status() {
    const ownership = inspectBackend(), blocked = !!ownership?.blocked;
    const features = {};
    for (const feature of Object.keys(configurations)) features[feature] = { configured: !!backend && !configurations[feature], ready: ready[feature] && !closed && !blocked, configurationError: configurations[feature]?.error || null };
    return success({ state: blocked ? 'blocked' : closed ? 'closed' : !backend ? 'unconfigured' : active || releasing ? 'busy' : 'idle', configured: features.u2netp.configured, ready: features.u2netp.ready, closed, active: active ? { id: active.id, kind: active.kind, ...(active.progress ? { progress: { ...active.progress } } : {}) } : null,
      model: { name: backgroundModelId, sha256: BACKGROUND_MODELS[backgroundModelId] }, bounds: { maxPixels: MAX_PIXELS, maxPngBytes: MAX_PNG_BYTES }, configurationError: features.u2netp.configurationError, features,
      selection: { model: { name: 'efficientsam-ti', ...SELECTION_HASHES }, bounds: { maxSide: SELECTION_MAX_SIDE, maxPixels: SELECTION_MAX_SIDE ** 2, maxPngBytes: SELECTION_MAX_PNG_BYTES, maxPromptSlots: 6 }, idleTimeoutMs }, retainedSelection: retained ? { ...retained } : null,
      generation: { modelDetails: structuredClone(generationModelDetails),
        models: { ...GENERATION_MODELS }, defaults: Object.fromEntries(Object.entries(GENERATION_DEFAULTS).map(([mode, value]) => [mode, { ...value }])), pipelines: Object.fromEntries(GENERATIVE_MODES.map(mode => [mode, generationPipeline(mode)])), adapters: structuredClone(generationAdapters), requirements: Object.fromEntries(Object.entries(GENERATION_REQUIREMENTS).map(([mode, features]) => [mode, [...features]])), modes: [...GENERATIVE_MODES], bounds: { ...GENERATIVE_BOUNDS }, idleTimeoutMs },
      generationSession: generation ? { ...generation, candidates: generation.candidates.map(candidate => ({ ...candidate })) } : null,
      ownsProcess: !!ownership?.owned, cleanupBlocked: blocked });
  }
  function backendFailure(cause) {
    return cause instanceof LocalAiError && backendCodes.has(cause.code) ? error(cause.code, cause.message) : error('WORKER', 'The local image worker failed unexpectedly.');
  }
  function recordFailure(result, feature) {
    if (['CONFIG', 'MODEL', 'RUNTIME', 'PROTOCOL', 'WORKER', 'TIMEOUT', 'CLEANUP'].includes(result.error.code)) ready[feature] = false;
  }
  function armIdle() {
    stopIdle();
    const ownership = inspectBackend();
    if ((retained || generation) && !ownership?.blocked && !closed) {
      idleTimer = setTimeout(() => { void releaseOwned(); }, idleTimeoutMs);
      idleTimer.unref?.();
    }
  }
  async function execute(kind, request) {
    if (inspectBackend()?.blocked) return cleanupFailure();
    if (closed) return error('CLOSED', 'The local image service is shutting down.');
    const feature = kind === 'generate' ? generationModel(request?.mode) : kind === 'prepareSelection' || kind === 'selectObject' ? 'efficientsam-ti' : kind === 'probe' ? request?.feature || 'u2netp' : 'u2netp';
    if (!Object.hasOwn(configurations, feature)) return error('INPUT', 'Unknown local model.');
    if (kind === 'generate') for (const required of GENERATION_REQUIREMENTS[request.mode]) if (configurations[required]) return { ok: false, error: { ...configurations[required].error } };
    if (configurations[feature]) return { ok: false, error: { ...configurations[feature].error } };
    if (!request || !validId(request.id)) return error('INPUT', 'Provide an operation ID of 1 to 80 letters, digits, underscores or hyphens.');
    if (active || releasing) return error('BUSY', 'The local image service already owns an operation.');
    if (['prepareSelection', 'generate'].includes(kind) && !validId(request.targetToken)) return error('INPUT', 'Provide a bounded image target token.');
    if (kind === 'selectObject' && (!retained || request.sessionId !== retained.sessionId || request.targetToken !== retained.targetToken)) return error('SESSION_EXPIRED', 'That image selection session is no longer available.');
    if (retained && kind !== 'selectObject') return error('BUSY', 'Release the selection image before starting another operation.');
    if (generation && kind !== 'generate') return error('BUSY', 'Release the generation session before starting another operation.');
    if (kind === 'generate' && (generation ? request.sessionId !== generation.sessionId || request.targetToken !== generation.targetToken : request.sessionId !== undefined)) return error('SESSION_EXPIRED', 'That generation session is no longer available.');
    const sessionId = kind === 'prepareSelection' || (kind === 'generate' && !generation) ? randomUUID() : kind === 'generate' ? generation.sessionId : retained?.sessionId;
    const targetToken = request.targetToken;
    const lease = { id: request.id, kind, controller: new AbortController(), settled: null, finished: false };
    active = lease; stopIdle();
    lease.settled = (async () => {
      let result;
      try {
        const signal = lease.controller.signal;
        const progress = value => {
          if (active !== lease || signal.aborted || lease.finished) return;
          lease.progress = { ...value };
          try { onProgress?.({ id: lease.id, kind, targetToken, progress: { ...value } }); } catch { /* Progress observers cannot change execution ownership. */ }
        };
        let value;
        if (kind === 'probe') value = await backend.probe({ feature, signal, onProgress: progress });
        else if (kind === 'run') value = await backend.run({ png: request.png, width: request.width, height: request.height, signal });
        else if (kind === 'generate') value = await backend.generate({ targetToken, mode: request.mode, prompt: request.prompt,
          negativePrompt: request.negativePrompt, png: request.png, mask: request.mask, width: request.width, height: request.height,
          seed: request.seed, steps: request.steps, strength: request.strength, guidance: request.guidance, signal, onProgress: progress });
        else if (kind === 'prepareSelection') value = await backend.prepareSelection({ sessionId, targetToken, png: request.png, width: request.width, height: request.height, signal });
        else value = await backend.selectObject({ sessionId, targetToken, prompts: request.prompts, signal });
        if (signal.aborted) {
          if (feature === 'efficientsam-ti' || kind === 'generate') {
            try { await backend.releaseSelection(); } catch { /* Preserve cancellation; ownership reports cleanup separately. */ }
            if (!inspectBackend()?.owned) { retained = null; generation = null; }
          }
          result = error('ABORTED', 'The local image operation was cancelled.');
        } else {
          ready[feature] = true;
          if (kind === 'prepareSelection') retained = { sessionId, targetToken, width: value.width, height: value.height };
          if (kind === 'generate') {
            generation ??= { sessionId, targetToken, candidates: [] };
            const candidateId = randomUUID();
            generation.candidates.push({ candidateId, mode: value.mode, seed: value.seed });
            const evictedCandidateId = generation.candidates.length > GENERATIVE_BOUNDS.maxCandidates ? generation.candidates.shift().candidateId : null;
            result = success({ ...value, sessionId, targetToken, candidateId, evictedCandidateId });
          } else result = success(kind === 'prepareSelection' || kind === 'selectObject' ? { ...value, sessionId, targetToken } : value);
        }
      } catch (cause) {
        result = backendFailure(cause); recordFailure(result, feature);
        if (feature === 'efficientsam-ti' && !inspectBackend()?.blocked && !['INPUT', 'SESSION_EXPIRED', 'BUSY'].includes(result.error.code)) retained = null;
      }
      lease.finished = true;
      if (!inspectBackend()?.blocked && active === lease) active = null;
      inspectBackend(); if (!active && !releasing) armIdle();
      return result;
    })();
    return lease.settled;
  }
  async function cancel(request) {
    if (inspectBackend()?.blocked) return cleanupFailure();
    if (!request || !validId(request.id)) return error('INPUT', 'Provide a valid operation ID to cancel.');
    const lease = active;
    if (!lease || request.id !== lease.id) return error('NOT_FOUND', 'That operation is not active.');
    lease.controller.abort();
    await lease.settled;
    if (inspectBackend()?.blocked) return cleanupFailure();
    return success({ id: lease.id, cancelled: true });
  }
  function releaseOwned() {
    if (inspectBackend()?.blocked) return Promise.resolve(cleanupFailure());
    if (releasing) return releasing;
    stopIdle();
    // Set the gate before awaiting even when there is no active command.
    let resolve;
    releasing = new Promise(done => { resolve = done; });
    const resultPromise = releasing;
    void (async () => {
      let result = success({ released: true });
      try {
        const lease = active;
        if (lease) { lease.controller.abort(); await lease.settled; if (inspectBackend()?.blocked) { result = cleanupFailure(); return; } }
        if (retained || generation || backend?.state?.().owned) {
          const owner = { id: retained?.sessionId || generation?.sessionId || randomUUID(), kind: generation ? 'releaseGeneration' : 'releaseSelection', controller: new AbortController(), settled: resultPromise, finished: false };
          active = owner;
          await backend.releaseSelection(); retained = null; generation = null;
          if (active === owner) active = null;
        }
      } catch (cause) { result = backendFailure(cause); for (const feature of Object.keys(ready)) recordFailure(result, feature); }
      finally { if (active) active.finished = true; if (!inspectBackend()?.blocked) active = null; releasing = null; resolve(result); }
    })();
    return resultPromise;
  }
  async function releaseSelection(request) {
    if (inspectBackend()?.blocked) return cleanupFailure();
    if (!retained || request?.sessionId !== retained.sessionId) return error('SESSION_EXPIRED', 'That image selection session is no longer available.');
    const sessionId = retained.sessionId;
    const result = await releaseOwned();
    return result.ok ? success({ sessionId, released: true }) : result;
  }
  async function shutdown() {
    closed = true; for (const feature of Object.keys(ready)) ready[feature] = false;
    const result = await releaseOwned();
    return result.ok ? success({ closed: true }) : result;
  }
  async function releaseGeneration(request) {
    if (inspectBackend()?.blocked) return cleanupFailure();
    if (!generation || request?.sessionId !== generation.sessionId) return error('SESSION_EXPIRED', 'That generation session is no longer available.');
    const sessionId = generation.sessionId, result = await releaseOwned();
    return result.ok ? success({ sessionId, released: true }) : result;
  }
  return { status, probe: request => execute('probe', request), run: request => execute('run', request), generate: request => execute('generate', request),
    prepareSelection: request => execute('prepareSelection', request), selectObject: request => execute('selectObject', request), releaseSelection, releaseGeneration, releaseOwned, cancel, shutdown };
}
module.exports = { createLocalAiService };
