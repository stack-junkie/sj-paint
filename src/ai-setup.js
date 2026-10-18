import './ai.css';
let uiOwned = false;
export async function withAiUi(callback) {
  if (uiOwned) return;
  uiOwned = true;
  try { return await callback(); } finally { uiOwned = false; }
}
export function aiValue(result) {
  if (!result?.ok) { const error = new Error(result?.error?.message || 'The local AI operation failed.'); error.code = result?.error?.code; throw error; }
  return result.value;
}
export const aiBytes = value => `${(value / 1024 ** (value >= 1024 ** 3 ? 3 : 2)).toFixed(1)} ${value >= 1024 ** 3 ? 'GiB' : 'MiB'}`;
let setupOpen = false;
const setupProgressLabels = { verifying: 'Verifying', reusing: 'Reusing downloaded files',
  downloading: 'Downloading', extracting: 'Preparing the private runtime',
  'installing-model': 'Installing model', ready: 'Setup ready' };

export async function ensureAiReady(features) {
  const bridge = window.paintDesktop;
  if (!bridge?.localAiSetup) throw new Error('Local AI requires the desktop application.');
  const state = aiValue(await bridge.localAiStatus());
  if (features.every(feature => state.features?.[feature]?.configured)) return true;
  // The existing IPC capability name covers either background model. New
  // installations use the full model evaluated for photos and stickers.
  return showAiSetup(features.map(feature => feature === 'u2netp' ? 'u2net' : feature));
}

export async function showAiSetup(features) {
  if (setupOpen) return false;
  const bridge = window.paintDesktop;
  if (!bridge?.localAiSetupPlan) throw new Error('Local AI requires the desktop application.');
  setupOpen = true;
  const panel = document.createElement('dialog');
  panel.className = 'ai-dialog'; panel.setAttribute('aria-labelledby', 'ai-setup-title');
  panel.innerHTML = '<form><h2 id="ai-setup-title">Set up local AI</h2><p>Download and verify the models and a private runtime. Images stay on this computer.</p><label>Image generation hardware<select name="accelerator"><option value="cpu">CPU</option><option value="cuda">NVIDIA GPU (CUDA)</option></select></label><p class="hint">CPU generation can be slow. NVIDIA acceleration requires a compatible installed driver.</p><p class="ai-setup-plan" role="status">Checking setup…</p><progress aria-label="Local AI setup progress" hidden></progress><p class="ai-setup-progress" role="status"></p><footer><button type="button" data-cancel>Cancel</button><button type="button" data-recheck hidden>Recheck setup</button><button type="submit" class="accent" disabled>Install</button></footer></form>';
  const accelerator = panel.querySelector('select'), install = panel.querySelector('[type="submit"]');
  const cancel = panel.querySelector('[data-cancel]'), estimate = panel.querySelector('.ai-setup-plan');
  const recheck = panel.querySelector('[data-recheck]');
  const progress = panel.querySelector('progress'), status = panel.querySelector('.ai-setup-progress');
  let running = false, canceling = false, closed = false, id, planEpoch = 0, settle, acceleratorChosen = false, capabilitiesRequest;
  const decision = new Promise(resolve => { settle = resolve; });
  const updatePlan = async () => {
    if (running || canceling || closed) return;
    const epoch = ++planEpoch; install.disabled = true; recheck.disabled = true;
    estimate.textContent = 'Checking setup…';
    try {
      const state = aiValue(await (capabilitiesRequest ||= bridge.localAiStatus()));
      if (closed || epoch !== planEpoch) return;
      const requested = features ?? state.setup?.defaultFeatures;
      if (!Array.isArray(requested) || !requested.length || requested.some(feature =>
        typeof feature !== 'string' || typeof state.setup?.features?.[feature]?.supportsAcceleration !== 'boolean')) {
        throw new Error('The local AI setup description is unavailable. Restart the application and retry.');
      }
      features = [...requested];
      const accelerated = features.map(feature => state.setup.features[feature]).filter(feature => feature.supportsAcceleration);
      accelerator.closest('label').hidden = panel.querySelector('.hint').hidden = !accelerated.length;
      const choices = [...new Set(accelerated.map(feature => feature.accelerator).filter(value => ['cpu', 'cuda'].includes(value)))];
      const selected = choices.length === 1 ? choices[0] : state.setup.preferredAccelerator;
      if (!acceleratorChosen && ['cpu', 'cuda'].includes(selected)) accelerator.value = selected;
      const plan = aiValue(await bridge.localAiSetupPlan({ features, accelerator: accelerator.value }));
      if (closed || epoch !== planEpoch) return;
      estimate.textContent = `${aiBytes(plan.estimatedDownloadBytes)} estimated download; ${aiBytes(plan.requiredFreeBytesEstimate)} free space required. Licenses: ${plan.licenses.join(', ')}.`;
      install.disabled = false; recheck.hidden = true;
    } catch (error) {
      if (!closed && epoch === planEpoch) { capabilitiesRequest = undefined; estimate.textContent = error.message; recheck.hidden = false; recheck.disabled = false; }
    }
  };
  const unsubscribe = bridge.onLocalAiProgress?.(event => {
    if (!running || canceling || closed || event.id !== id) return;
    const value = event.progress || event;
    status.textContent = `${setupProgressLabels[value.stage] || 'Installing'}${value.artifact ? `: ${value.artifact}` : ''}`;
    if (Number.isFinite(value.total) && value.total > 0) { progress.max = value.total; progress.value = value.completed || 0; }
    else progress.removeAttribute('value');
  });
  const stop = async () => {
    if (closed || canceling) return;
    if (!running) { closed = true; settle(false); return; }
    const canceledId = id;
    canceling = true; cancel.disabled = true; status.textContent = 'Canceling setup…';
    try { aiValue(await bridge.localAiSetupCancel({ id: canceledId })); closed = true; settle(false); }
    catch (error) { status.textContent = error.message; }
    finally {
      canceling = false;
      if (!closed) { cancel.disabled = false; install.disabled = running; accelerator.disabled = running; progress.hidden = !running; }
    }
  };
  panel.oncancel = event => { event.preventDefault(); void stop(); };
  cancel.onclick = () => void stop(); recheck.onclick = () => void updatePlan();
  accelerator.onchange = () => { acceleratorChosen = true; void updatePlan(); };
  panel.querySelector('form').onsubmit = async event => {
    event.preventDefault(); if (running || canceling || closed || install.disabled) return;
    running = true; id = crypto.randomUUID(); install.disabled = true; accelerator.disabled = true;
    progress.hidden = false; status.textContent = 'Preparing setup…';
    try {
      aiValue(await bridge.localAiSetup({ id, features, accelerator: accelerator.value }));
      if (!canceling) { closed = true; settle(true); }
    }
    catch (error) { if (!canceling) status.textContent = error.message; }
    finally {
      running = false;
      if (!closed) { install.disabled = canceling; accelerator.disabled = canceling; progress.hidden = !canceling; }
    }
  };
  document.body.append(panel); panel.showModal(); void updatePlan();
  try { return await decision; }
  finally { closed = true; unsubscribe?.(); panel.close(); panel.remove(); setupOpen = false; }
}
