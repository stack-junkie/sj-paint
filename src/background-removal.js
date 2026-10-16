import { maskedCanvas } from './engine.js';

let active = false;
const unwrap = result => {
  if (!result?.ok) throw new Error(result?.error?.message || 'Local background removal failed.');
  return result.value;
};

// This controller owns only its preview dialog. The document owns the eventual
// edit, and the main process owns inference and cancellation until child exit.
export async function removeBackground(doc) {
  if (active) return;
  const bridge = window.paintDesktop;
  if (!bridge?.localAiStatus || !bridge.localAiRun || !bridge.localAiCancel) {
    throw new Error('Local background removal requires the desktop edition and a configured local runtime.');
  }
  if (doc.selection) throw new Error('Finish or cancel the selection before removing the active layer background.');
  if (!doc.activeLayer.visible) throw new Error('Show the active layer before removing its background.');
  active = true;
  const target = doc.captureEditTarget(), source = doc.activeLayer.canvas;
  const id = crypto.randomUUID();
  let cancelled = false, running = false, resultMask = null;
  const panel = document.createElement('dialog');
  panel.className = 'background-removal-dialog';
  panel.setAttribute('aria-labelledby', 'background-removal-title');
  panel.innerHTML = '<form><h2 id="background-removal-title">Remove background</h2><p>Local preview for the active layer. Check fine lines and edges before applying.</p><p role="status">Preparing local preview…</p><div class="background-preview"></div><footer><button type="button">Cancel</button><button class="accent" type="submit" disabled>Apply</button></footer></form>';
  const status = panel.querySelector('[role="status"]'), apply = panel.querySelector('[type="submit"]');
  let finish;
  const decision = new Promise(resolve => { finish = resolve; });
  const cancelOwned = async () => {
    const result = await bridge.localAiCancel({ id });
    if (!result?.ok && result?.error?.code !== 'NOT_FOUND') unwrap(result);
    running = false;
  };
  const cancel = () => {
    cancelled = true; apply.disabled = true; status.textContent = 'Cancelling…';
    finish(false);
  };
  panel.querySelector('[type="button"]').onclick = cancel;
  panel.oncancel = event => { event.preventDefault(); cancel(); };
  panel.querySelector('form').onsubmit = event => {
    event.preventDefault(); if (resultMask && !cancelled) finish(true);
  };
  document.body.append(panel); panel.showModal();
  const changed = () => { if (!doc.matchesEditTarget(target)) cancel(); };
  doc.addEventListener('change', changed); doc.addEventListener('preview', changed);
  try {
    const state = unwrap(await bridge.localAiStatus());
    if (!state.configured) throw new Error('Local background removal is not configured. See the desktop setup instructions in README.');
    const bounds = state.bounds;
    if (!Number.isSafeInteger(bounds?.maxPixels) || bounds.maxPixels < 1 || !Number.isSafeInteger(bounds?.maxPngBytes) || bounds.maxPngBytes < 1) {
      throw new Error('The local worker returned invalid input limits.');
    }
    if (source.width * source.height > bounds.maxPixels) throw new Error(`Local background removal supports at most ${bounds.maxPixels.toLocaleString()} pixels.`);
    if (cancelled) return;
    const blob = await new Promise((resolve, reject) => source.toBlob(value => value ? resolve(value) : reject(new Error('Could not encode the layer.')), 'image/png'));
    if (blob.size > bounds.maxPngBytes) throw new Error('The encoded layer exceeds the local worker limit.');
    const png = new Uint8Array(await blob.arrayBuffer());
    if (cancelled || !doc.matchesEditTarget(target)) return;
    running = true; status.textContent = 'Removing background locally…';
    const pending = bridge.localAiRun({ id, png, width: source.width, height: source.height });
    const first = await Promise.race([pending.then(value => ({ value })), decision.then(() => ({ cancelled: true }))]);
    if (first.cancelled || cancelled) {
      await cancelOwned(); await pending; return;
    }
    running = false;
    const result = unwrap(first.value);
    if (!doc.matchesEditTarget(target)) return;
    if (result.width !== source.width || result.height !== source.height || !(result.mask instanceof Uint8Array)) {
      throw new Error('The local worker returned an invalid background mask.');
    }
    resultMask = result.mask;
    const masked = maskedCanvas(source, resultMask);
    // Preview the prospective document through the same display compositor as
    // the main canvas. Reading layer storage directly skips display rounding
    // and would also omit the background and other layers.
    const preview = document.createElement('canvas');
    preview.width = doc.width; preview.height = doc.height;
    doc.renderTo(preview.getContext('2d'), { layerPreview: {
      layerId: target.layerId,
      paint(context) { context.clearRect(0, 0, doc.width, doc.height); context.drawImage(masked, 0, 0); },
    } });
    preview.setAttribute('aria-label', 'Background removal preview');
    panel.querySelector('.background-preview').append(preview);
    status.textContent = 'Preview ready. Apply changes only this layer and can be undone.'; apply.disabled = false;
    if (await decision && !cancelled) doc.applyLayerMask(target, resultMask);
  } finally {
    doc.removeEventListener('change', changed); doc.removeEventListener('preview', changed);
    if (running) {
      // Keep this UI lease until native cleanup has acknowledged the cancellation.
      try { await cancelOwned(); } finally { panel.close(); panel.remove(); active = false; }
    } else { panel.close(); panel.remove(); active = false; }
  }
}
