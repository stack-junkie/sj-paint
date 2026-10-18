const fs = require('node:fs/promises');
const path = require('node:path');
const { createWorkerProcess, LocalAiError } = require('./local-ai-process.cjs');
const MODEL_SHA256 = '309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8';
const BACKGROUND_MODELS = Object.freeze({ u2netp: MODEL_SHA256, u2net: '8d10d2f3bb75ae3b6d527c77944fc5e7dcd94b29809d47a739a7a728a912b491' });
const SELECTION_HASHES = Object.freeze({ encoder: '84ed466ffcc5c1f8d08409bc34a23bb364ab2c15e402cb12d4335a42be0e0951', decoder: 'a62f8fa5ea080447c0689418d69e58f1e83e0b7adf9c142e2bd9bcc8045c0b11' });
const MAX_PIXELS = 16_000_000, MAX_PNG_BYTES = 64 * 1024 * 1024;
const SELECTION_MAX_SIDE = 1024, SELECTION_MAX_PNG_BYTES = 8 * 1024 * 1024;
const BASE_MODEL = 'sdxl-base', BASE_REVISION = '462165984030d82259a11f4367a4eed129e94a7b';
const COLORING_MODEL = 'sdxl-coloring';
const BASE_COMPONENT_PROFILE = 'base-unet-shared-clip-fp16-fixed-vae';
const COLORING_ADAPTER = Object.freeze({ name: 'ColoringBookRedmond-V2', revision: '0e67e0de2b603db085e525e7f6194b24dc60033d', sha256: '94eb17068a45df06a9e6ab0bcbbd5c381e03f09320da46839c1ed0cee733af31' });
const REMOVAL_MODEL = 'migan', REMOVAL_SHA256 = '6f1f3530a1a2324b19752018ce756088b07973cda8d7d890034ace5c8a48c40b';
const FLOAT32_EPSILON = 2 ** -23;
const GENERATIVE_BOUNDS = Object.freeze({ maxSide: 1024, minSide: 64, dimensionMultiple: 8, maxPngBytes: 8 * 1024 * 1024,
  maxPromptBytes: 1536, maxNegativePromptBytes: 512, minSteps: 1, maxSteps: 50, maxCandidates: 4 });
const releaseCapabilities = require('./ai-capabilities.json');
const GENERATION_MODELS = Object.freeze(Object.fromEntries(Object.entries(releaseCapabilities.generation).map(([mode, value]) => [mode, value.model])));
const GENERATIVE_MODES = Object.freeze(Object.keys(GENERATION_MODELS));
const generationModel = mode => Object.hasOwn(GENERATION_MODELS, mode) ? GENERATION_MODELS[mode] : undefined;
const GENERATION_REQUIREMENTS = Object.freeze(Object.fromEntries(Object.entries(GENERATION_MODELS)
  .map(([mode, model]) => [mode, Object.freeze(mode === 'sticker' ? [model, 'u2netp'] : [model])])));
const generationPipeline = mode => ['create', 'sticker', 'coloring'].includes(mode) ? 'StableDiffusionXLPipeline' : null;
const GENERATION_DEFAULTS = Object.freeze(Object.fromEntries(GENERATIVE_MODES.map(mode => [mode, Object.freeze({ steps: 30, guidance: mode === 'coloring' ? 7 : 7.5, strength: 1 })])));
const failure = (code, message) => new LocalAiError(code, message);
const validToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
function validateInput(png, width, height, selection = false) {
  if (!(png instanceof Uint8Array) || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > MAX_PIXELS || (selection && (width > SELECTION_MAX_SIDE || height > SELECTION_MAX_SIDE)) || png.byteLength < 33 || png.byteLength > (selection ? SELECTION_MAX_PNG_BYTES : MAX_PNG_BYTES)) throw failure('INPUT', selection ? 'Choose a PNG of at most 1024 pixels per side and 8 MiB.' : 'Choose a PNG image of at most 16 million pixels and 64 MiB.');
  const bytes = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR' || bytes.readUInt32BE(16) !== width || bytes.readUInt32BE(20) !== height) throw failure('INPUT', 'PNG dimensions do not match the requested image.');
  return Buffer.from(bytes);
}
function normalizePrompts(prompts, width, height) {
  if (!prompts || typeof prompts !== 'object' || !Array.isArray(prompts.points) || prompts.points.length > 6 || Object.keys(prompts).some(key => !['points', 'box'].includes(key))) throw failure('INPUT', 'Provide foreground/background points and an optional rectangle.');
  const coords = [], labels = [];
  const point = (x, y, label) => {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= width || y >= height) throw failure('INPUT', 'Selection prompts must be inside the image.');
    coords.push([x, y]); labels.push(label);
  };
  for (const value of prompts.points) {
    if (!value || Object.keys(value).some(key => !['x', 'y', 'label'].includes(key)) || (value.label !== undefined && value.label !== 0 && value.label !== 1)) throw failure('INPUT', 'Point labels must be 1 for foreground or 0 for background.');
    point(value.x, value.y, value.label ?? 1);
  }
  if (prompts.box !== undefined) {
    const box = prompts.box;
    if (!box || Object.keys(box).some(key => !['x1', 'y1', 'x2', 'y2'].includes(key)) || !(box.x1 < box.x2 && box.y1 < box.y2)) throw failure('INPUT', 'Provide ordered nonempty rectangle corners.');
    point(box.x1, box.y1, 2); point(box.x2, box.y2, 3);
  }
  if (coords.length < 1 || coords.length > 6) throw failure('INPUT', 'Use one to six prompt slots; a rectangle uses two.');
  if (labels.every(label => label === 0)) throw failure('INPUT', 'Include a foreground point or rectangle before excluding an object.');
  return { coords, labels };
}
function generationRequest(request) {
  const { mode, width, height, targetToken, seed } = request;
  const prompt = request.prompt ?? '', negativePrompt = request.negativePrompt ?? '';
  const defaults = GENERATION_DEFAULTS[mode] || {};
  const steps = request.steps ?? defaults.steps, strength = request.strength ?? defaults.strength, guidance = request.guidance ?? defaults.guidance;
  if (!GENERATIVE_MODES.includes(mode) || !validToken(targetToken) ||
      ![width, height].every(value => Number.isInteger(value) && value >= GENERATIVE_BOUNDS.minSide && value <= GENERATIVE_BOUNDS.maxSide && value % 8 === 0) ||
      !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff || !Number.isInteger(steps) || steps < GENERATIVE_BOUNDS.minSteps || steps > GENERATIVE_BOUNDS.maxSteps ||
      !Number.isFinite(strength) || strength <= 0 || strength > 1 || Math.floor(steps * (strength)) < 1 ||
      !Number.isFinite(guidance) || guidance < 1 || guidance > 20 ||
      typeof prompt !== 'string' || typeof negativePrompt !== 'string' || (mode !== 'erase' && !prompt.trim()) ||
      Buffer.byteLength(prompt) > GENERATIVE_BOUNDS.maxPromptBytes || Buffer.byteLength(negativePrompt) > GENERATIVE_BOUNDS.maxNegativePromptBytes) {
    throw failure('INPUT', 'Provide a supported generation mode, bounded prompt, seed, steps and image dimensions.');
  }
  if (mode === 'erase' && (prompt.length || negativePrompt.length)) throw failure('INPUT', 'Erase removes selected objects without a prompt.');
  const needsSource = mode === 'erase', needsMask = needsSource;
  if (!needsSource && strength !== 1) throw failure('INPUT', 'New image generation requires full generation strength.');
  if ((!needsSource && request.png !== undefined) || (!needsMask && request.mask !== undefined)) throw failure('INPUT', 'This generation mode does not accept that source or mask.');
  const source = needsSource ? validateInput(request.png, width, height, true) : Buffer.alloc(0);
  const mask = needsMask ? validateInput(request.mask, width, height, true) : Buffer.alloc(0);
  return { fields: { mode, width, height, targetToken, prompt, negativePrompt, seed, steps, strength, guidance,
    sourceLength: source.length, maskLength: mask.length }, payload: Buffer.concat([source, mask]) };
}
function response(frame, feature, operation, width, height, requestedAccelerator = 'auto') {
  const { header, payload } = frame;
  if (!header.ok) {
    if (!['INPUT', 'MODEL', 'RUNTIME'].includes(header.code) || typeof header.message !== 'string' || header.message.length > 256 || payload.length) throw failure('PROTOCOL', 'The local worker returned an invalid error.');
    throw failure(header.code, header.message);
  }
  const m = header.metadata;
  if (feature === REMOVAL_MODEL) {
    if (!m || m.model !== REMOVAL_MODEL || m.modelSha256 !== REMOVAL_SHA256 || m.provider !== 'CPUExecutionProvider' ||
        typeof m.runtimeVersion !== 'string' || !/^\d+\.\d+\.\d+[\w.+-]*$/.test(m.runtimeVersion) || !Number.isFinite(m.elapsedMs) || m.elapsedMs < 0 ||
        m.requestedStrength !== undefined || m.effectiveStrength !== undefined) throw failure('PROTOCOL', 'The removal worker returned invalid model metadata.');
    if (operation === 'probe') { if (payload.length) throw failure('PROTOCOL', 'The readiness probe returned unexpected bytes.'); return m; }
    if (operation !== 'generate' || header.mode !== 'erase' || m.conditioningMargin !== 3 || header.width !== width || header.height !== height) throw failure('PROTOCOL', 'The removal worker returned invalid dimensions or conditioning metadata.');
    try { validateInput(payload, width, height, true); } catch { throw failure('PROTOCOL', 'The removal worker returned an invalid PNG.'); }
    return { png: Uint8Array.from(payload), width, height, targetToken: header.targetToken, mode: header.mode, seed: header.seed, metadata: m };
  }
  if ([BASE_MODEL, COLORING_MODEL].includes(feature)) {
    if (!m || m.model !== feature || m.configuredRevision !== BASE_REVISION || !['cuda', 'cpu'].includes(m.provider) || (requestedAccelerator !== 'auto' && m.provider !== requestedAccelerator) ||
        typeof m.runtimeVersion !== 'string' || m.runtimeVersion.length > 80 || !Number.isFinite(m.elapsedMs) || m.elapsedMs < 0) {
      throw failure('PROTOCOL', 'The generation worker returned invalid runtime metadata.');
    }
    if (operation === 'probe') { if (payload.length) throw failure('PROTOCOL', 'The readiness probe returned unexpected bytes.'); return m; }
    if (m.componentProfile !== BASE_COMPONENT_PROFILE) throw failure('PROTOCOL', 'The generation component profile does not match the configured model.');
    if (!Number.isFinite(m.requestedStrength) || m.requestedStrength <= 0 || m.requestedStrength > 1 ||
        !Number.isFinite(m.effectiveStrength) || m.effectiveStrength <= 0 || m.effectiveStrength > 1 || m.effectiveStrength !== m.requestedStrength) throw failure('PROTOCOL', 'The generation worker returned invalid strength metadata.');
    if (generationModel(header.mode) !== feature || m.pipelineKind !== generationPipeline(header.mode)) throw failure('PROTOCOL', 'The generation pipeline does not match its operation.');
    if (header.mode === 'coloring' ? m.adapter !== COLORING_ADAPTER.name || m.adapterRevision !== COLORING_ADAPTER.revision || m.adapterSha256 !== COLORING_ADAPTER.sha256 || m.adapterScale !== 1 : m.adapter !== null) throw failure('PROTOCOL', 'The generation adapter does not match its operation.');
    if (header.width !== width || header.height !== height) throw failure('PROTOCOL', 'The generation worker returned invalid dimensions.');
    try { validateInput(payload, width, height, true); } catch { throw failure('PROTOCOL', 'The generation worker returned an invalid PNG.'); }
    return { png: Uint8Array.from(payload), width, height, targetToken: header.targetToken, mode: header.mode, seed: header.seed, metadata: m };
  }
  if (!m || m.model !== feature || m.provider !== 'CPUExecutionProvider' || typeof m.runtimeVersion !== 'string' || !/^\d+\.\d+\.\d+[\w.+-]*$/.test(m.runtimeVersion) || (Object.hasOwn(BACKGROUND_MODELS, feature) ? m.modelSha256 !== BACKGROUND_MODELS[feature] : m.encoderSha256 !== SELECTION_HASHES.encoder || m.decoderSha256 !== SELECTION_HASHES.decoder)) throw failure('PROTOCOL', 'The local worker did not confirm the configured model and CPU runtime.');
  if (Object.hasOwn(BACKGROUND_MODELS, feature) && m.matte !== undefined) {
    const matte = m.matte;
    if (!matte || !['model-saliency', 'flat-drawing-border-flood'].includes(matte.method) ||
        (matte.method === 'flat-drawing-border-flood' && (!Array.isArray(matte.paperRgb) || matte.paperRgb.length !== 3 || !matte.paperRgb.every(value => Number.isInteger(value) && value >= 0 && value <= 255) || matte.unmixEdges !== true ||
          ![matte.borderAgreement, matte.foregroundFlatColorFraction, matte.antialiasEdgeSupport].every(value => Number.isFinite(value) && value >= 0 && value <= 1) || matte.connectivity !== 4 || matte.preservesEnclosedInteriors !== true))) {
      throw failure('PROTOCOL', 'The local worker returned invalid matte-method metadata.');
    }
  }
  if (operation === 'probe') { if (payload.length) throw failure('PROTOCOL', 'The readiness probe returned unexpected bytes.'); return m; }
  if (header.width !== width || header.height !== height || !Number.isFinite(m.elapsedMs) || m.elapsedMs < 0) throw failure('PROTOCOL', 'The local worker returned invalid dimensions or timing.');
  if (operation === 'prepare') { if (payload.length) throw failure('PROTOCOL', 'Image preparation returned unexpected bytes.'); return { width, height, metadata: m }; }
  const validMatteRange = () => m.modelExecuted === false
    ? m.matte?.method === 'flat-drawing-border-flood' && m.rawMin === undefined && m.rawMax === undefined
    : (m.modelExecuted === undefined || m.modelExecuted === true) && m.matte?.method !== 'flat-drawing-border-flood' && Number.isFinite(m.rawMin) && Number.isFinite(m.rawMax) && m.rawMin >= -FLOAT32_EPSILON && m.rawMax <= 1 + FLOAT32_EPSILON && m.rawMax > m.rawMin;
  if (operation === 'cutout') {
    if (!Object.hasOwn(BACKGROUND_MODELS, feature) || !validMatteRange()) throw failure('PROTOCOL', 'The cutout worker returned an invalid matte.');
    try { validateInput(payload, width, height, true); } catch { throw failure('PROTOCOL', 'The cutout worker returned an invalid PNG.'); }
    return { png: Uint8Array.from(payload), width, height, metadata: m };
  }
  const selection = feature === 'efficientsam-ti';
  if (payload.length !== width * height * (selection ? 3 : 1)) throw failure('PROTOCOL', 'The local worker returned an invalid mask.');
  if (Object.hasOwn(BACKGROUND_MODELS, feature)) {
    if (!validMatteRange()) throw failure('PROTOCOL', 'The local worker returned an invalid mask.');
  } else if (!Array.isArray(header.scores) || header.scores.length !== 3 || !header.scores.every(Number.isFinite) || !Number.isInteger(header.selectedCandidate) || header.selectedCandidate < 0 || header.selectedCandidate > 2 || header.selectedCandidate !== header.scores.indexOf(Math.max(...header.scores)) || payload.some(value => value !== 0 && value !== 1)) throw failure('PROTOCOL', 'The local worker returned invalid selection candidates.');
  const candidates = selection ? Array.from({ length: 3 }, (_, index) => Uint8Array.from(payload.subarray(index * width * height, (index + 1) * width * height))) : null;
  const mask = selection ? candidates[header.selectedCandidate] : Uint8Array.from(payload);
  if (selection && m.refinement !== undefined) {
    const r = m.refinement;
    if (!r || r.method !== 'object-mask-subtraction' || !Number.isInteger(r.excludedObjects) || r.excludedObjects < 1 || r.excludedObjects > 5 ||
        typeof r.empty !== 'boolean' || r.empty !== !mask.some(value => value === 1) || !Array.isArray(r.candidates) || r.candidates.length !== r.excludedObjects ||
        r.candidates.some(candidate => !candidate || !Array.isArray(candidate.scores) || candidate.scores.length !== 3 || !candidate.scores.every(Number.isFinite) ||
          !Number.isInteger(candidate.selectedCandidate) || candidate.selectedCandidate !== candidate.scores.indexOf(Math.max(...candidate.scores)))) {
      throw failure('PROTOCOL', 'The local worker returned invalid exclusion metadata.');
    }
  }
  return { mask, width, height, metadata: m, ...(selection ? { candidates, scores: header.scores, selectedCandidate: header.selectedCandidate } : {}) };
}
/** Trusted main-process configuration only; process supervision has one owner. */
function createLocalAi({ pythonPath, modelPath, backgroundModelId = 'u2netp', encoderPath, decoderPath, removalModelPath, basePythonPath, baseModelPath, baseAccelerator = 'auto', coloringPythonPath, coloringModelPath, coloringAccelerator = 'auto',
  timeoutMs = 30_000, generationTimeoutMs = 600_000 } = {}, dependencies = {}) {
  if (![baseAccelerator, coloringAccelerator].every(value => ['auto', 'cpu', 'cuda'].includes(value)) || !Object.hasOwn(BACKGROUND_MODELS, backgroundModelId) || [pythonPath, modelPath, encoderPath, decoderPath, removalModelPath, basePythonPath, baseModelPath, coloringPythonPath, coloringModelPath].some(value => value !== undefined && (typeof value !== 'string' || !path.isAbsolute(value))) ||
      !(pythonPath && (modelPath || removalModelPath || (encoderPath && decoderPath))) && !(basePythonPath && baseModelPath) && !(coloringPythonPath && coloringModelPath) ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000 ||
      !Number.isInteger(generationTimeoutMs) || generationTimeoutMs < 1 || generationTimeoutMs > 600_000) throw failure('CONFIG', 'Configure absolute Python/model paths and bounded operation deadlines.');
  let active = false, worker = null, workerFeature = null, retained = null;
  const readFile = dependencies.readFile || fs.readFile;
  function reconcileClosedWorker() {
    if (!active && worker && !worker.state().owned) { worker = null; workerFeature = null; retained = null; }
  }
  async function dispose() {
    if (!worker) { retained = null; return; }
    // A prior cleanup wait may have failed while this same child subsequently
    // closed. Its rejected promise is historical, not current ownership.
    if (worker.state().owned) {
      try { await worker.close(); }
      catch (error) { if (worker.state().owned) throw error; }
    }
    if (worker.state().owned) throw failure('CLEANUP', 'Local worker cleanup is unresolved.');
    worker = null; workerFeature = null; retained = null;
  }
  async function start(feature, signal) {
    const generative = [BASE_MODEL, COLORING_MODEL].includes(feature);
    const paths = generative ? [feature === COLORING_MODEL ? coloringModelPath : baseModelPath] : feature === REMOVAL_MODEL ? [removalModelPath] : Object.hasOwn(BACKGROUND_MODELS, feature) ? [modelPath] : [encoderPath, decoderPath];
    const runtime = generative ? (feature === COLORING_MODEL ? coloringPythonPath : basePythonPath) : pythonPath;
    if (!runtime || paths.some(value => !value)) throw failure('CONFIG', 'This local model is not configured.');
    let script;
    try { script = await readFile(path.join(__dirname, generative ? 'generative-worker.py' : 'local-ai-worker.py'), 'utf8'); }
    catch { throw failure('WORKER', 'The local worker source could not be read.'); }
    if (signal?.aborted) throw failure('ABORTED', 'The local image operation was cancelled.');
    worker = createWorkerProcess({ pythonPath: runtime, script, args: [feature, ...paths, ...(generative ? [feature === COLORING_MODEL ? coloringAccelerator : baseAccelerator] : [])], timeoutMs: generative ? generationTimeoutMs : timeoutMs }, dependencies);
    workerFeature = feature;
  }
  async function execute(operation, request = {}) {
    const { signal, sessionId, targetToken } = request;
    reconcileClosedWorker();
    if (worker?.state().blocked) throw failure('CLEANUP', 'Local worker cleanup is unresolved.');
    if (active) throw failure('BUSY', 'The local image worker is already running.');
    if (signal?.aborted) throw failure('ABORTED', 'The local image operation was cancelled.');
    const requestedFeature = operation === 'probe' ? request.feature || 'u2netp' : null;
    const feature = operation === 'generate' ? generationModel(request.mode) : operation === 'prepare' || operation === 'select' ? 'efficientsam-ti' : operation === 'probe' && requestedFeature !== 'u2netp' ? requestedFeature : backgroundModelId;
    if (![backgroundModelId, 'efficientsam-ti', BASE_MODEL, COLORING_MODEL, REMOVAL_MODEL].includes(feature)) throw failure('INPUT', 'Unknown local model.');
    if (retained && operation !== 'select') throw failure('BUSY', 'Release the current selection session before starting another model operation.');
    let payload = Buffer.alloc(0), fields = {}, width = request.width, height = request.height;
    if (operation === 'generate') ({ payload, fields } = generationRequest(request));
    if (operation === 'generate' && fields.mode === 'sticker' && (!pythonPath || !modelPath)) throw failure('CONFIG', 'Sticker generation also requires the local background-removal model.');
    if (operation === 'run' || operation === 'prepare') { payload = validateInput(request.png, width, height, operation === 'prepare'); fields = { width, height }; }
    if (operation === 'select') {
      if (!retained || retained.sessionId !== sessionId || retained.targetToken !== targetToken) throw failure('SESSION_EXPIRED', 'That image selection session is no longer available.');
      ({ width, height } = retained); fields = { width, height, ...normalizePrompts(request.prompts, width, height) };
    }
    if (operation === 'prepare' && (!validToken(sessionId) || !validToken(targetToken))) throw failure('INPUT', 'Provide valid image session and target tokens.');
    active = true;
    try {
      if (worker && workerFeature !== feature) await dispose();
      if (!worker) await start(feature, signal);
      if (signal?.aborted) throw failure('ABORTED', 'The local image operation was cancelled.');
      const frame = await worker.request(operation, fields, payload, operation === 'generate' ? GENERATIVE_BOUNDS.maxPngBytes : operation === 'select' ? 3 * width * height : operation === 'run' ? width * height : 0, signal, request.onProgress);
      let result = response(frame, feature, operation, width, height, feature === COLORING_MODEL ? coloringAccelerator : baseAccelerator);
      if (operation === 'generate' && (result.targetToken !== fields.targetToken || result.mode !== fields.mode || result.seed !== fields.seed || ([BASE_MODEL, COLORING_MODEL].includes(feature) && result.metadata.requestedStrength !== fields.strength))) throw failure('PROTOCOL', 'The generated result does not match its request.');
      if (signal?.aborted) throw failure('ABORTED', 'The local image operation was cancelled.');
      if (operation === 'generate' && fields.mode === 'sticker') {
        // One lease spans both models. The diffusion process must actually close
        // before segmentation allocates anything, and no partial candidate escapes.
        await dispose();
        if (signal?.aborted) throw failure('ABORTED', 'The local image operation was cancelled.');
        try { request.onProgress?.({ stage: 'matte', completed: 0, total: 1 }); } catch { /* Observer only. */ }
        await start(backgroundModelId, signal);
        const cutoutFrame = await worker.request('cutout', { width, height }, Buffer.from(result.png), GENERATIVE_BOUNDS.maxPngBytes, signal);
        const cutout = response(cutoutFrame, backgroundModelId, 'cutout', width, height);
        result = { ...result, png: cutout.png, metadata: { ...result.metadata, postprocessing: cutout.metadata } };
        if (signal?.aborted) throw failure('ABORTED', 'The local image operation was cancelled.');
        try { request.onProgress?.({ stage: 'matte', completed: 1, total: 1 }); } catch { /* Observer only. */ }
      }
      if (['prepare', 'select', 'generate'].includes(operation) && (!worker.state().owned || worker.state().closing)) throw worker.state().error || failure('WORKER', 'The local worker closed before its session could be retained.');
      if (operation === 'prepare') retained = { sessionId, targetToken, width, height };
      if (operation === 'run' || operation === 'probe') await dispose();
      return result;
    } catch (error) {
      // Preserve the failed operation's reason; state() separately exposes an
      // unresolved cleanup gate until this exact child actually closes.
      try { await dispose(); } catch { /* Retain the owned worker. */ }
      throw signal?.aborted && error?.code === 'CLEANUP' ? failure('ABORTED', 'The local image operation was cancelled.') : error;
    } finally { active = false; }
  }
  return { probe: request => execute('probe', request), run: request => execute('run', request), generate: request => execute('generate', request), prepareSelection: request => execute('prepare', request), selectObject: request => execute('select', request),
    releaseSelection: async () => { if (active) throw failure('BUSY', 'Cancel the active operation before releasing its image.'); await dispose(); },
    state: () => { reconcileClosedWorker(); const state = worker?.state(); return {
      retained: state?.owned && !state.closing ? retained : null, feature: state?.owned && !state.closing ? workerFeature : null, blocked: !!state?.blocked, owned: !!state?.owned }; } };
}
module.exports = { createLocalAi, LocalAiError, MODEL_SHA256, BACKGROUND_MODELS, MAX_PIXELS, MAX_PNG_BYTES, SELECTION_HASHES, SELECTION_MAX_SIDE, SELECTION_MAX_PNG_BYTES,
  BASE_MODEL, BASE_REVISION, BASE_COMPONENT_PROFILE, COLORING_MODEL, COLORING_ADAPTER, generationPipeline, GENERATIVE_BOUNDS, GENERATIVE_MODES, GENERATION_MODELS, GENERATION_REQUIREMENTS, GENERATION_DEFAULTS, generationModel, REMOVAL_MODEL, REMOVAL_SHA256 };
