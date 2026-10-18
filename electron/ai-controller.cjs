const { createManagedAiSetup } = require('./ai-setup.cjs');
const { FEATURES } = require('./ai-manifest.cjs');
const { GENERATIVE_MODES } = require('./local-ai.cjs');
const { createLocalAiService } = require('./local-ai-service.cjs');

const success = value => ({ ok: true, value });
const failure = (code, message) => ({ ok: false, error: { code, message } });
const knownCodes = new Set(['INPUT', 'CONFIG', 'CAPACITY', 'BUSY', 'ABORTED', 'CLEANUP', 'CLOSED', 'NETWORK', 'INTEGRITY', 'RUNTIME', 'MODEL', 'UNSUPPORTED']);
const caught = error => failure(knownCodes.has(error?.code) ? error.code : 'SETUP', error?.message || 'AI setup failed.');

// One application owner arbitrates setup and inference. Neither runtime can
// start while the other still owns a worker, including after failed cleanup.
function createAiController({ userDataPath, seedAssets, onProgress, onOwnershipReleased, env = process.env,
  createSetup = createManagedAiSetup, createService = createLocalAiService } = {}) {
  const setup = createSetup({ userDataPath, seedAssets, onProgress, onOwnershipReleased });
  let service, installing = false, closing = false;
  async function configure() {
    // Prefer the evaluated full model when installed, retaining the small-model
    // descriptor for existing installations and explicit development settings.
    const descriptors = await Promise.all([...FEATURES.filter(feature => feature !== 'u2net'), 'u2net'].map(feature => setup.resolve(feature)));
    const configuration = { pythonPath: env.SJ_PAINT_PYTHON, modelPath: env.SJ_PAINT_U2NETP_MODEL,
      encoderPath: env.SJ_PAINT_EFFICIENTSAM_ENCODER, decoderPath: env.SJ_PAINT_EFFICIENTSAM_DECODER,
      generativePythonPath: env.SJ_PAINT_GENERATIVE_PYTHON, generativeModelPath: env.SJ_PAINT_SDXL_MODEL,
      ...Object.assign({}, ...descriptors.filter(Boolean)) };
    if (closing && service) return;
    service = createService({ configuration, onProgress, onOwnershipReleased });
  }
  const initialized = configure();
  initialized.catch(() => {});
  async function status() {
    try {
      await initialized;
      const state = await setup.status();
      return success({ ...service.status().value, setup: state, settingUp: installing, closing });
    } catch (error) { return caught(error); }
  }
  async function invoke(method, request) {
    try {
      if (method === 'generate' && !GENERATIVE_MODES.includes(request?.mode)) return failure('INPUT', 'This image operation is unavailable in this release.');
      await initialized;
      // Cleanup must remain reachable when unrelated setup metadata is broken.
      if (['cancel', 'releaseOwned', 'releaseSelection', 'releaseGeneration'].includes(method)) return await service[method](request);
      const setupState = await setup.status();
      if (closing) return failure('CLOSED', 'AI is shutting down.');
      if (installing || setupState.active) return failure('BUSY', 'Finish AI setup before starting an image operation.');
      return await service[method](request);
    } catch (error) { return caught(error); }
  }
  async function plan(request) {
    try { await initialized; return success(await setup.plan(request)); } catch (error) { return caught(error); }
  }
  async function install(request) {
    // Reserve the gate synchronously before any asynchronous boundary.
    if (installing || closing) return failure('BUSY', 'AI setup or shutdown is already in progress.');
    installing = true;
    try {
      await initialized;
      const state = service.status().value;
      if (state.active || state.ownsProcess || state.retainedSelection || state.generationSession) {
        return failure('BUSY', 'Close the current AI preview before changing its runtime.');
      }
      const value = await setup.setup(request);
      if (closing) return failure('CLOSED', 'AI is shutting down.');
      // Setup success activates paths atomically. Replace only an idle service.
      const released = await service.shutdown();
      if (!released.ok) return released;
      if (closing) return failure('CLOSED', 'AI is shutting down.');
      await configure();
      if (closing) return failure('CLOSED', 'AI is shutting down.');
      return success(value);
    } catch (error) { return caught(error); }
    finally { installing = false; }
  }
  async function cancelSetup(request) {
    if (!request || typeof request.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(request.id)) return failure('INPUT', 'Provide the setup operation ID.');
    try { return success({ cancelled: await setup.cancel(request.id) }); } catch (error) { return caught(error); }
  }
  async function shutdown() {
    closing = true;
    try { await initialized; } catch { /* Failed readiness does not remove cleanup ownership. */ }
    // Both owners must receive cleanup even when initialization or the other
    // owner's cleanup failed. A failed close remains retryable after late exit.
    const results = await Promise.allSettled([setup.close(), service?.shutdown()]);
    for (const result of results) {
      if (result.status === 'rejected') return caught(result.reason);
      if (result.value?.ok === false) return result.value;
    }
    return success({ closed: true });
  }
  return { status, plan, install, cancelSetup, shutdown,
    ...Object.fromEntries(['probe', 'run', 'generate', 'prepareSelection', 'selectObject', 'releaseSelection',
      'releaseGeneration', 'releaseOwned', 'cancel'].map(method => [method, request => invoke(method, request)])) };
}

module.exports = { createAiController };
