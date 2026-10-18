const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createAiController } = require('./ai-controller.cjs');
const { createLocalAiService } = require('./local-ai-service.cjs');
const { LocalAiError } = require('./local-ai.cjs');
const { createQuitCoordinator } = require('./quit-coordinator.cjs');

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const fault = code => Object.assign(new Error(`Fixture ${code}`), { code });
const environment = { SJ_PAINT_PYTHON: process.execPath, SJ_PAINT_U2NETP_MODEL: path.resolve('fixture-u2netp.onnx'),
  SJ_PAINT_EFFICIENTSAM_ENCODER: path.resolve('fixture-encoder.onnx'), SJ_PAINT_EFFICIENTSAM_DECODER: path.resolve('fixture-decoder.onnx'),
  SJ_PAINT_GENERATIVE_PYTHON: process.execPath, SJ_PAINT_SDXL_MODEL: path.resolve('fixture-sdxl') };

for (const owner of ['setup', 'inference']) test(`confirmed ${owner} late close wakes committed application quit through the controller`, async () => {
  let owned = true, quitCount = 0, setupHook, serviceHook;
  const failures = [], scheduled = [];
  let coordinator;
  const controller = createAiController({ env: {}, onOwnershipReleased: () => coordinator.ownershipReleased(),
    createSetup(options) {
      setupHook = options.onOwnershipReleased;
      return { resolve: async () => null, close: async () => { if (owner === 'setup' && owned) throw fault('CLEANUP'); } };
    },
    createService(options) {
      serviceHook = options.onOwnershipReleased;
      return { shutdown: async () => owner === 'inference' && owned ? { ok: false, error: { code: 'CLEANUP' } } : { ok: true } };
    },
  });
  coordinator = createQuitCoordinator({ shutdown: () => controller.shutdown(), requestQuit: () => { quitCount++; },
    reportFailure: result => failures.push(result), schedule: callback => scheduled.push(callback) });
  coordinator.willQuit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(quitCount, 0); assert.equal(failures.length, 1); assert.equal(failures[0].error.code, 'CLEANUP');
  assert.equal(scheduled.length, 0);
  owned = false;
  (owner === 'setup' ? setupHook : serviceHook)();
  scheduled.shift()(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(quitCount, 0); scheduled.shift()();
  assert.equal(quitCount, 1); assert.equal(failures[0].error.code, 'CLEANUP');
  coordinator.dispose();
});

// The real service owns command/session lifecycle. Only the setup filesystem
// boundary and model backend are replaced; no model, process or network is used.
function fixture() {
  const calls = [], services = [], configurations = [], backends = [], bindings = {
    migan: { pythonPath: process.execPath, removalModelPath: path.resolve('fixture-migan.onnx') },
  };
  const hooks = {};
  const setup = {
    active: null, closed: false,
    async resolve(feature) { calls.push(['resolve', feature]); return hooks.resolve ? hooks.resolve(feature) : bindings[feature] || null; },
    async status() { if (hooks.status) return hooks.status(); return { state: this.closed ? 'closed' : this.active ? 'setting-up' : 'idle', active: this.active, ownsProcess: !!this.active, features: {} }; },
    async plan(request) { calls.push(['plan', request]); return { features: request.features, totalBytes: 1 }; },
    async setup(request) {
      calls.push(['setup', request.id]);
      if (this.closed) throw fault('CLOSED');
      if (this.active) throw fault('BUSY');
      return hooks.setup ? hooks.setup(request) : { installed: request.features };
    },
    async cancel(id) { calls.push(['cancelSetup', id]); return hooks.cancel ? hooks.cancel(id) : false; },
    async close() { calls.push(['closeSetup']); this.closed = true; if (hooks.close) await hooks.close(); },
  };
  const controller = createAiController({ env: environment, createSetup: () => setup, createService: options => {
    configurations.push(options.configuration);
    const ownership = { owned: false, blocked: false, retained: null };
    const backend = { ownership, hook: null, releaseHook: null,
      state: () => ({ ...ownership }),
      async releaseSelection() { if (backend.releaseHook) return backend.releaseHook(); ownership.owned = false; ownership.blocked = false; ownership.retained = null; },
    };
    for (const method of ['probe', 'run', 'generate', 'prepareSelection', 'selectObject']) backend[method] = async request => {
      calls.push([method, request.id]); ownership.owned = true;
      if (backend.hook) return backend.hook(method, request);
      ownership.owned = false; return { ready: true };
    };
    backends.push(backend);
    const service = createLocalAiService({ ...options, env: {}, createBackend: () => backend });
    services.push(service); return service;
  } });
  return { controller, setup, hooks, calls, services, configurations, backends, bindings };
}

test('initialization and successful setup refresh use managed paths while retaining explicit fallback paths', async () => {
  const f = fixture();
  assert.equal((await f.controller.status()).ok, true);
  assert.equal(f.configurations[0].modelPath, environment.SJ_PAINT_U2NETP_MODEL);
  f.bindings.u2netp = { pythonPath: process.execPath, modelPath: path.resolve('managed-u2netp.onnx') };
  assert.equal((await f.controller.install({ id: 'install', features: ['u2netp'] })).ok, true);
  assert.equal(f.services.length, 2);
  assert.equal(f.services[0].status().value.closed, true);
  assert.equal(f.configurations[1].modelPath, f.bindings.u2netp.modelPath);
  assert.equal(f.configurations[1].generativeModelPath, environment.SJ_PAINT_SDXL_MODEL);
  f.bindings.u2net = { pythonPath: process.execPath, modelPath: path.resolve('managed-u2net.onnx'), backgroundModelId: 'u2net' };
  assert.equal((await f.controller.install({ id: 'upgrade', features: ['u2net'] })).ok, true);
  assert.equal(f.configurations[2].modelPath, f.bindings.u2net.modelPath);
  assert.equal(f.configurations[2].backgroundModelId, 'u2net');
  assert.equal((await f.controller.status()).value.model.name, 'u2net');
  await f.controller.shutdown();
});

test('setup reserves the gate before a pending inference status read can admit a worker', async () => {
  const f = fixture(); await f.controller.status();
  const statusEntered = deferred(), releaseStatus = deferred(), setupEntered = deferred(), finishSetup = deferred();
  f.hooks.status = async () => { statusEntered.resolve(); await releaseStatus.promise; return { active: null }; };
  f.hooks.setup = async () => { setupEntered.resolve(); return finishSetup.promise; };
  const inference = f.controller.run({ id: 'image' }); await statusEntered.promise;
  const install = f.controller.install({ id: 'install', features: ['u2netp'] }); await setupEntered.promise;
  releaseStatus.resolve();
  assert.equal((await inference).error.code, 'BUSY');
  assert.equal(f.calls.some(([name]) => name === 'run'), false);
  finishSetup.resolve({ installed: ['u2netp'] }); assert.equal((await install).ok, true);
  await f.controller.shutdown();
});

test('an active inference worker blocks setup until its operation finishes', async () => {
  const f = fixture(); await f.controller.status();
  const started = deferred(), finish = deferred();
  f.backends[0].hook = async () => { started.resolve(); await finish.promise; f.backends[0].ownership.owned = false; return { png: new Uint8Array([1]) }; };
  const inference = f.controller.run({ id: 'image' }); await started.promise;
  assert.equal((await f.controller.install({ id: 'install', features: ['u2netp'] })).error.code, 'BUSY');
  assert.equal(f.calls.some(([name]) => name === 'setup'), false);
  finish.resolve(); assert.equal((await inference).ok, true);
  assert.equal((await f.controller.install({ id: 'retry', features: ['u2netp'] })).ok, true);
  await f.controller.shutdown();
});

test('failed setup cleanup keeps inference blocked until the manager observes late close', async () => {
  const f = fixture(); await f.controller.status();
  f.hooks.setup = async request => { f.setup.active = { id: request.id, finished: true }; throw fault('CLEANUP'); };
  assert.equal((await f.controller.install({ id: 'install', features: ['u2netp'] })).error.code, 'CLEANUP');
  assert.equal((await f.controller.run({ id: 'blocked' })).error.code, 'BUSY');
  assert.equal(f.services.length, 1);
  f.setup.active = null;
  assert.equal((await f.controller.run({ id: 'recovered' })).ok, true);
  await f.controller.shutdown();
});

for (const kind of ['prepareSelection', 'generate']) test(`retained ${kind} session blocks setup until its owned resources release`, async () => {
  const f = fixture(); await f.controller.status();
  const backend = f.backends[0];
  backend.hook = async (method, request) => {
    if (kind === 'prepareSelection') backend.ownership.retained = { sessionId: request.sessionId, targetToken: request.targetToken };
    return { width: 64, height: 64, mode: 'erase', seed: 1 };
  };
  const preview = await f.controller[kind]({ id: 'preview', targetToken: 'drawing', mode: 'erase' });
  assert.equal(preview.ok, true);
  assert.equal((await f.controller.install({ id: 'install', features: ['u2netp'] })).error.code, 'BUSY');
  const release = kind === 'generate' ? 'releaseGeneration' : 'releaseSelection';
  assert.equal((await f.controller[release]({ sessionId: preview.value.sessionId })).ok, true);
  assert.equal((await f.controller.install({ id: 'retry', features: ['u2netp'] })).ok, true);
  await f.controller.shutdown();
});

test('failed inference cleanup preserves ownership and allows setup after observed late close', async () => {
  const f = fixture(); await f.controller.status();
  const backend = f.backends[0];
  backend.hook = async () => { backend.ownership.blocked = true; throw new LocalAiError('CLEANUP', 'Fixture worker did not close'); };
  assert.equal((await f.controller.run({ id: 'image' })).error.code, 'CLEANUP');
  assert.equal((await f.controller.install({ id: 'blocked', features: ['u2netp'] })).error.code, 'BUSY');
  assert.equal(f.services[0].status().value.ownsProcess, true);
  assert.equal(f.services.length, 1);
  backend.ownership.owned = false; backend.ownership.blocked = false;
  assert.equal((await f.controller.install({ id: 'retry', features: ['u2netp'] })).ok, true);
  assert.equal(f.services.length, 2);
  await f.controller.shutdown();
});

test('shutdown during setup aborts its lease and does not configure another service', async () => {
  const f = fixture(); await f.controller.status();
  const started = deferred(), finish = deferred();
  f.hooks.setup = async request => { f.setup.active = { id: request.id }; started.resolve(); try { return await finish.promise; } finally { f.setup.active = null; } };
  f.hooks.close = async () => { finish.reject(fault('ABORTED')); await finish.promise.catch(() => {}); };
  const install = f.controller.install({ id: 'install', features: ['u2netp'] }); await started.promise;
  assert.equal((await f.controller.shutdown()).ok, true);
  assert.equal((await install).error.code, 'ABORTED');
  assert.equal(f.services.length, 1); assert.equal(f.services[0].status().value.closed, true);
  assert.equal((await f.controller.probe({ id: 'after-close' })).error.code, 'CLOSED');
});

test('shutdown prevents an in-flight configuration refresh from publishing a live service', async () => {
  const f = fixture(); await f.controller.status();
  const entered = deferred(), resolvePaths = deferred();
  f.hooks.resolve = async feature => { entered.resolve(); await resolvePaths.promise; return f.bindings[feature] || null; };
  const install = f.controller.install({ id: 'install', features: ['u2netp'] }); await entered.promise;
  const shutdown = f.controller.shutdown();
  // Let shutdown progress while the read-only configuration lookup is still held.
  await new Promise(resolve => setImmediate(resolve));
  resolvePaths.resolve();
  const [installed, closed] = await Promise.all([install, shutdown]);
  assert.equal(closed.ok, true);
  assert.deepEqual({ installed: installed.ok, code: installed.error?.code, everyServiceClosed: f.services.every(service => service.status().value.closed) },
    { installed: false, code: 'CLOSED', everyServiceClosed: true }, 'shutdown must prevent late activation or an open service');
});

test('setup status read failure cannot prevent cancellation of an already owned inference', async () => {
  const f = fixture(); await f.controller.status();
  const started = deferred(), finish = deferred();
  f.backends[0].hook = async (method, request) => { started.resolve(); request.signal.addEventListener('abort', () => finish.reject(new LocalAiError('ABORTED', 'Fixture cancellation')), { once: true }); try { return await finish.promise; } finally { f.backends[0].ownership.owned = false; } };
  const inference = f.controller.run({ id: 'image' }); await started.promise;
  f.hooks.status = async () => { throw fault('CONFIG'); };
  const cancelled = await f.controller.cancel({ id: 'image' });
  // Release the fixture even on regression, so no pending operation leaks from the test.
  finish.reject(fault('ABORTED')); await inference;
  assert.equal(cancelled.ok, true, 'cancel must reach the service without requiring setup configuration reads');
  assert.equal(f.services[0].status().value.ownsProcess, false);
  await f.controller.shutdown();
});

test('setup status read failure cannot prevent releasing a retained generation worker', async () => {
  const f = fixture(); await f.controller.status();
  f.backends[0].hook = async () => ({ mode: 'erase', seed: 1, width: 64, height: 64 });
  assert.equal((await f.controller.generate({ id: 'preview', targetToken: 'drawing', mode: 'erase' })).ok, true);
  f.hooks.status = async () => { throw fault('CONFIG'); };
  const release = await f.controller.releaseOwned();
  const stillOwned = f.services[0].status().value.ownsProcess;
  await f.services[0].shutdown();
  assert.equal(release.ok, true, 'release must not depend on managed setup configuration');
  assert.equal(stillOwned, false);
});

test('initialization failure does not prevent shutdown from closing the setup owner', async () => {
  let closes = 0;
  const controller = createAiController({ createSetup: () => ({ resolve: async () => { throw fault('CONFIG'); }, close: async () => { closes++; } }), createService: () => { throw new Error('Must not create service'); } });
  assert.equal((await controller.status()).error.code, 'CONFIG');
  await controller.shutdown();
  assert.equal(closes, 1, 'setup owner must be closed even if runtime initialization failed');
});

test('failed setup close still closes inference and shutdown can retry after late process exit', async () => {
  const f = fixture(); await f.controller.status();
  const backend = f.backends[0];
  backend.hook = async () => ({ mode: 'erase', seed: 1 });
  await f.controller.generate({ id: 'preview', targetToken: 'drawing', mode: 'erase' });
  let releaseCalls = 0;
  backend.releaseHook = async () => { releaseCalls++; backend.ownership.blocked = true; throw new LocalAiError('CLEANUP', 'Fixture worker still owned'); };
  f.hooks.close = async () => { throw fault('CLEANUP'); };
  assert.equal((await f.controller.shutdown()).error.code, 'CLEANUP');
  assert.equal(releaseCalls, 1, 'failure of one owner must not suppress cleanup of the other');
  assert.equal(f.services[0].status().value.ownsProcess, true);
  backend.ownership.owned = false; backend.ownership.blocked = false;
  f.hooks.close = null;
  assert.equal((await f.controller.shutdown()).ok, true);
  assert.equal(f.services[0].status().value.ownsProcess, false);
  assert.equal((await f.controller.run({ id: 'closed' })).error.code, 'CLOSED');
});

test('excluded generation modes reject before setup readiness or backend calls', async () => {
  const f = fixture(); await f.controller.status();
  const before = f.calls.length;
  f.hooks.status = () => { throw new Error('Excluded request read setup readiness.'); };
  for (const mode of ['create', 'fill', 'cocreate', 'reimagine', 'sticker', 'coloring']) {
    const result = await f.controller.generate({ id: `excluded-${mode}`, mode, targetToken: 'document' });
    assert.equal(result.ok, false); assert.equal(result.error.code, 'INPUT');
  }
  assert.equal(f.calls.length, before);
  await f.controller.shutdown();
});
