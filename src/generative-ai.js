import releaseCapabilities from '../electron/ai-capabilities.json';
import { aiValue, ensureAiReady, withAiUi } from './ai-setup.js';
import { copyCanvas, saveImageFile } from './files.js';

const titles = Object.fromEntries(Object.entries(releaseCapabilities.generation).map(([mode, value]) => [mode, value.title]));
const progressLabels = { loading: 'Loading local AI', 'torch-import': 'Loading local AI',
  'pipeline-import': 'Loading local AI', 'cuda-check': 'Checking graphics support',
  'model-load': 'Loading the image model', 'cuda-offload': 'Preparing graphics memory',
  denoise: 'Generating image', blend: 'Blending selection', encode: 'Preparing the preview' };
const makeCanvas = (width, height) => Object.assign(document.createElement('canvas'), { width, height });
const encode = canvas => new Promise((resolve, reject) => canvas.toBlob(async blob => {
  if (!blob || blob.size > 8 * 1024 ** 2) { reject(new Error('The AI input must fit within 8 MiB.')); return; }
  try { resolve(new Uint8Array(await blob.arrayBuffer())); } catch (error) { reject(error); }
}, 'image/png'));

export async function generateImage(doc, mode) {
  if (!Object.hasOwn(titles, mode)) throw new Error('This image operation is unavailable in this release.');
  return withAiUi(() => runGeneration(doc, mode));
}
async function runGeneration(doc, mode) {
  const masked = mode === 'erase', editing = masked;
  if (masked && !doc.selection) throw new Error('Select the area to change first.');
  if (editing && !doc.activeLayer.visible) throw new Error('Show the active layer before editing it.');
  const bridge = window.paintDesktop;
  if (!bridge?.localAiStatus) throw new Error('Local AI requires the desktop application.');
  const requirements = aiValue(await bridge.localAiStatus()).generation?.requirements?.[mode];
  if (!Array.isArray(requirements) || !requirements.length || requirements.some(feature => typeof feature !== 'string' || !feature)) {
    throw new Error('This image operation is unavailable. Restart the application and retry.');
  }
  if (!await ensureAiReady(requirements)) return;
  const generation = aiValue(await bridge.localAiStatus()).generation;
  const promptByteLimit = generation?.bounds?.maxPromptBytes, defaults = generation?.defaults?.[mode];
  if (!Number.isSafeInteger(promptByteLimit) || promptByteLimit < 1) throw new Error('The local AI description limit is unavailable. Restart the application and retry.');
  if (!defaults || !Number.isSafeInteger(defaults.steps) || defaults.steps < generation.bounds.minSteps || defaults.steps > generation.bounds.maxSteps ||
      !Number.isFinite(defaults.guidance) || !Number.isFinite(defaults.strength) || defaults.strength <= 0 || defaults.strength > 1) {
    throw new Error('The local AI generation settings are unavailable. Restart the application and retry.');
  }
  const target = doc.captureEditTarget(), targetToken = crypto.randomUUID();
  const exportResolution = editing ? doc.resolution : undefined;
  const panel = document.createElement('dialog'); panel.className = 'ai-dialog generation-dialog';
  panel.setAttribute('aria-labelledby', 'generation-title');
  panel.innerHTML = `<form><h2 id="generation-title">${titles[mode]}</h2><label class="generation-prompt">${mode === 'erase' ? 'Background details (optional)' : 'Describe the image'}<textarea name="prompt" rows="3" maxlength="1000" ${mode === 'erase' ? '' : 'required'}></textarea></label><label class="generation-size" ${editing ? 'hidden' : ''}>Image size<select name="size"><option value="1024">1024 × 1024</option><option value="512">512 × 512</option></select></label><p class="generation-context hint"></p><p role="status" aria-live="polite">Ready to generate locally.</p><progress aria-label="Image generation progress" hidden></progress><button type="submit" class="accent">Generate</button><div class="generation-candidates" role="group" aria-label="Generated candidates"></div><div class="generation-preview"></div><footer><button type="button" data-ai="close">Close</button><button type="button" data-ai="copy" disabled>Copy</button><button type="button" data-ai="save" disabled>Save</button><button type="button" class="accent" data-ai="apply" disabled>${editing ? 'Apply' : 'Add to drawing'}</button></footer></form>`;
  const form = panel.querySelector('form'), status = panel.querySelector('[role="status"]');
  const progress = panel.querySelector('progress'), generate = panel.querySelector('[type="submit"]');
  const preview = panel.querySelector('.generation-preview'), candidatesView = panel.querySelector('.generation-candidates');
  const prompt = form.elements.namedItem('prompt'), size = form.elements.namedItem('size');
  if (mode === 'erase') prompt.closest('label').hidden = true;
  prompt.maxLength = promptByteLimit;
  prompt.oninput = () => prompt.setCustomValidity(new TextEncoder().encode(prompt.value).length > promptByteLimit ?
    'Shorten the description before generating.' : mode !== 'erase' && !prompt.value.trim() ? 'Describe the image to generate.' : '');
  const buttons = Object.fromEntries([...panel.querySelectorAll('[data-ai]')].map(button => [button.dataset.ai, button]));
  let sessionId, operationId, running = false, closed = false, selected = null, candidates = [], actionBusy = false, applying = false, resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const valid = () => doc.matchesEditTarget(target);
  const updateButtons = () => {
    generate.disabled = running || closed || actionBusy || !valid(); prompt.disabled = running || actionBusy; size.disabled = running || actionBusy;
    buttons.apply.disabled = !selected || running || closed || actionBusy || !valid();
    buttons.copy.disabled = buttons.save.disabled = !selected || running || closed || actionBusy;
    buttons.close.disabled = actionBusy;
    for (const button of candidatesView.children) button.disabled = running || closed || actionBusy;
  };
  const renderCandidate = candidate => {
    const canvas = editing ? doc.generatedLayer(target, candidate.canvas, { selectionOnly: masked }) : candidate.canvas;
    const display = makeCanvas(canvas.width, canvas.height);
    if (editing) {
      doc.renderTo(display.getContext('2d'), { includeSelection: false, layerPreview: { layerId: target.layerId, paint(ctx) {
        ctx.clearRect(0, 0, doc.width, doc.height); ctx.drawImage(canvas, 0, 0);
      } } });
      display.setAttribute('aria-label', 'Generated edit preview');
    } else { display.getContext('2d').drawImage(canvas, 0, 0); display.setAttribute('aria-label', 'Generated image preview'); }
    // Keep only the selected editable layer and its visible composite. Apply
    // consumes that layer; exports consume the exact canvas shown to the user.
    selected = { ...candidate, editableCanvas: canvas, displayCanvas: display };
    preview.replaceChildren(display);
    for (const button of candidatesView.children) button.setAttribute('aria-pressed', String(button.dataset.candidate === candidate.candidateId));
    updateButtons();
  };
  const changed = () => {
    if (applying || valid()) return;
    selected = null; candidates = []; preview.replaceChildren(); candidatesView.replaceChildren();
    status.textContent = 'The drawing changed. Close this preview and start again with the updated drawing.';
    updateButtons(); if (operationId) void bridge.localAiCancel({ id: operationId });
  };
  const unsubscribe = bridge.onLocalAiProgress?.(event => {
    if (!running || closed || !valid() || event.id !== operationId) return;
    const value = event.progress || event;
    const label = progressLabels[value.stage] || 'Preparing image';
    status.textContent = `${label}${value.stage === 'denoise' && value.total ? ` (${value.completed || 0}/${value.total})` : ''}…`;
    if (value.total > 0) { progress.max = value.total; progress.value = value.completed || 0; } else progress.removeAttribute('value');
  });
  const close = async () => {
    if (closed || actionBusy) return;
    closed = true; updateButtons(); status.textContent = 'Releasing local AI…';
    try {
      if (operationId) { const result = await bridge.localAiCancel({ id: operationId }); if (!result.ok && result.error?.code !== 'NOT_FOUND') aiValue(result); }
      resolveDone();
    } catch (error) { closed = false; status.textContent = error.message; updateButtons(); }
  };
  buttons.close.onclick = () => void close();
  panel.oncancel = event => { event.preventDefault(); void close(); };
  panel.querySelector('.generation-context').textContent = mode === 'erase' ?
    'Erase from the active layer. Include the object and its shadow in the selection. Check the preview, then Apply with one Undo step.' : editing ?
    'The active layer supplies the image. Preview keeps layer order and opacity. Apply is one Undo step.' : 'Choose a candidate, then add it to the drawing, copy it or save it.';
  const withCandidate = async callback => {
    if (!selected || actionBusy || running || closed) return;
    actionBusy = true; updateButtons();
    try { await callback(selected); } catch (error) { status.textContent = error.message; }
    finally { actionBusy = false; updateButtons(); }
  };
  buttons.copy.onclick = () => void withCandidate(async candidate => { await copyCanvas(candidate.displayCanvas); status.textContent = 'Copied image.'; });
  buttons.save.onclick = () => void withCandidate(async candidate => {
    const receipt = await saveImageFile(candidate.displayCanvas, 'png', titles[mode], { resolution: exportResolution }); status.textContent = receipt ? 'Saved image.' : 'Save canceled.';
  });
  buttons.apply.onclick = () => void withCandidate(async candidate => {
    if (!valid()) throw new Error('The drawing changed. Generate again from its current state.');
    const canvas = candidate.editableCanvas;
    const released = await bridge.localAiReleaseGeneration({ sessionId });
    if (!released.ok && released.error?.code !== 'SESSION_EXPIRED') aiValue(released);
    if (closed || !valid()) throw new Error('The drawing changed while the AI preview was closing.');
    applying = true;
    try { if (editing) doc.applyGeneratedLayer(target, canvas, titles[mode]); else doc.insertGeneratedImage(target, canvas, titles[mode]); }
    finally { applying = false; }
    closed = true; resolveDone();
  });
  form.onsubmit = async event => {
    event.preventDefault(); if (running || closed || actionBusy || !valid() || !form.reportValidity()) return;
    running = true; operationId = crypto.randomUUID(); progress.hidden = false; updateButtons(); status.textContent = 'Preparing image…';
    try {
      const scale = Math.min(1, 1024 / Math.max(doc.width, doc.height));
      const width = editing ? Math.max(64, Math.round(doc.width * scale / 8) * 8) : Number(size.value);
      const height = editing ? Math.max(64, Math.round(doc.height * scale / 8) * 8) : Number(size.value);
      const request = { id: operationId, targetToken, ...(sessionId ? { sessionId } : {}), mode,
        prompt: mode === 'erase' ? '' : prompt.value, width, height, seed: crypto.getRandomValues(new Uint32Array(1))[0],
        steps: defaults.steps, guidance: defaults.guidance,
        strength: defaults.strength };
      if (editing) {
        const source = makeCanvas(width, height); source.getContext('2d').drawImage(doc.activeLayerImage(), 0, 0, width, height); request.png = await encode(source);
        if (masked) {
          const full = makeCanvas(doc.width, doc.height), ctx = full.getContext('2d'), pixels = ctx.createImageData(doc.width, doc.height), mask = doc.selectionMask();
          for (let i = 0; i < mask.length; i++) { const offset = i * 4; pixels.data[offset] = pixels.data[offset + 1] = pixels.data[offset + 2] = mask[i] ? 255 : 0; pixels.data[offset + 3] = 255; }
          ctx.putImageData(pixels, 0, 0); source.getContext('2d').imageSmoothingEnabled = false; source.getContext('2d').drawImage(full, 0, 0, width, height); request.mask = await encode(source);
        }
      }
      if (closed || !valid()) return;
      let response = await bridge.localAiGenerate(request);
      if (response?.error?.code === 'SESSION_EXPIRED' && !closed && valid()) {
        sessionId = undefined; delete request.sessionId;
        response = await bridge.localAiGenerate(request);
      }
      const result = aiValue(response);
      if (closed || !valid()) return;
      if (result.targetToken !== targetToken || result.width !== width || result.height !== height || !(result.png instanceof Uint8Array)) throw new Error('The generated candidate does not match this request.');
      sessionId = result.sessionId;
      const bitmap = await createImageBitmap(new Blob([result.png], { type: 'image/png' }));
      if (bitmap.width !== width || bitmap.height !== height) { bitmap.close(); throw new Error('Invalid generated image dimensions.'); }
      const canvas = makeCanvas(width, height); canvas.getContext('2d').drawImage(bitmap, 0, 0); bitmap.close();
      if (closed || !valid()) return;
      const candidate = { canvas, candidateId: result.candidateId, seed: result.seed };
      candidates = candidates.filter(item => item.candidateId !== result.evictedCandidateId); candidates.push(candidate); candidates = candidates.slice(-4);
      candidatesView.replaceChildren(...candidates.map((item, index) => {
        const button = document.createElement('button'); button.type = 'button'; button.dataset.candidate = item.candidateId; button.textContent = `Candidate ${index + 1}`;
        button.onclick = () => { if (valid() && !running && !closed && !actionBusy) renderCandidate(item); }; return button;
      }));
      renderCandidate(candidate); status.textContent = 'Candidate ready. Check the preview before applying.';
    } catch (error) { if (!closed && valid()) status.textContent = error.message; }
    finally { operationId = null; running = false; progress.hidden = true; updateButtons(); }
  };
  doc.addEventListener('change', changed); doc.addEventListener('preview', changed);
  document.body.append(panel); panel.showModal();
  try { await done; }
  finally {
    closed = true; unsubscribe?.(); doc.removeEventListener('change', changed); doc.removeEventListener('preview', changed);
    try { const result = await bridge.localAiRelease(); if (!result.ok) aiValue(result); }
    finally { panel.close(); panel.remove(); candidates = []; selected = null; }
  }
}
