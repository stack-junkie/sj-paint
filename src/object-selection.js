import './object-selection.css';
import { ensureAiReady, withAiUi } from './ai-setup.js';

const unwrap = result => {
  if (!result?.ok) {
    const error = new Error(result?.error?.message || 'Local object selection failed.');
    error.code = result?.error?.code;
    throw error;
  }
  return result.value;
};

// The canvas controller owns prompts and its retained worker session. The document owns
// the resulting ordinary selection and its cancellation/history semantics.
export async function selectObject(doc) {
  return withAiUi(() => runObjectSelection(doc));
}
async function runObjectSelection(doc) {
  const bridge = window.paintDesktop;
  if (!['localAiStatus', 'localAiPrepareSelection', 'localAiSelectObject', 'localAiReleaseSelection', 'localAiCancel'].every(key => typeof bridge?.[key] === 'function')) {
    throw new Error('Object select requires the desktop edition and a configured local runtime.');
  }
  if (doc.selection) throw new Error('Finish or cancel the selection before using Object select.');
  if (!doc.activeLayer.visible) throw new Error('Show the active layer before using Object select.');
  if (!await ensureAiReady(['efficientsam-ti'])) return;
  const target = doc.captureEditTarget(), source = doc.activeLayer.canvas, targetToken = crypto.randomUUID();
  const panel = document.createElement('dialog');
  panel.className = 'object-selection-dialog';
  panel.setAttribute('aria-labelledby', 'object-selection-title');
  panel.innerHTML = `<form novalidate>
    <h2 id="object-selection-title">Object select</h2>
    <div class="object-selection-content">
      <p class="object-selection-instructions">Mark the object with points, or drag a box around it. Apply creates an editable selection on this layer.</p>
      <p class="object-selection-scale" hidden></p>
      <p role="status" aria-live="polite">Preparing local image…</p>
      <div class="object-selection-preview"><canvas aria-label="Object selection preview" aria-describedby="object-selection-help" tabindex="0"></canvas></div>
      <p id="object-selection-help" class="hint">Click to add a point. In Box mode, drag between opposite corners. You can also enter preview coordinates below.</p>
      <fieldset class="object-selection-controls" disabled>
        <div class="object-selection-toolbar"><label>Prompt type<select name="mode"><option value="point">Include object</option><option value="negative">Exclude object</option><option value="box">Box</option></select></label><button type="button" data-object="clear">Clear prompts</button></div>
        <div data-coordinates="point" class="object-selection-coordinates"><label>Point X<input name="x" type="number" min="0" step="1" value="0"></label><label>Point Y<input name="y" type="number" min="0" step="1" value="0"></label><button type="button" data-object="point">Add point</button></div>
        <div data-coordinates="box" class="object-selection-coordinates" hidden><label>Box left<input name="x1" type="number" min="0" step="1" value="0"></label><label>Box top<input name="y1" type="number" min="0" step="1" value="0"></label><label>Box right<input name="x2" type="number" min="0" step="1" value="1"></label><label>Box bottom<input name="y2" type="number" min="0" step="1" value="1"></label><button type="button" data-object="box">Set box</button></div>
        <p class="object-selection-count hint"></p>
        <div class="object-selection-candidates" hidden><label for="object-selection-candidate">Selection preview</label><select id="object-selection-candidate" name="candidate" aria-describedby="object-selection-candidates-help"></select></div>
        <p id="object-selection-candidates-help" class="hint" hidden>Try another preview if part of the object is missing. Switching previews does not change the drawing.</p>
      </fieldset>
    </div>
    <footer><button type="button" data-object="cancel">Cancel</button><button type="submit" class="accent" disabled>Apply</button></footer>
  </form>`;
  const form = panel.querySelector('form'), canvas = panel.querySelector('canvas'), context = canvas.getContext('2d');
  const stage = document.querySelector('#stage');
  if (!stage) throw new Error('The drawing surface is unavailable.');
  canvas.className = 'object-selection-overlay';
  canvas.setAttribute('aria-label', 'Target an object on the drawing');
  stage.append(canvas); panel.querySelector('.object-selection-preview').remove();
  const status = panel.querySelector('[role="status"]'), controls = panel.querySelector('fieldset'), apply = panel.querySelector('[type="submit"]');
  const input = name => form.elements.namedItem(name);
  const prepared = document.createElement('canvas'), overlay = document.createElement('canvas');
  let width = 0, height = 0, maxSlots = 0, ready = false, closing = false, cancelled = false, fatal = false;
  let sessionId = null, operation = null, pump = null, mask = null, prompts = { points: [] }, revision = 0, decodedRevision = -1, drag = null, cleanupError = null;
  // Keep the last accepted prompt/mask pair while a proposed refinement runs.
  // A rejected input must not discard the user's usable selection or embedding.
  let decoded = { prompts, mask: null, choices: [], selectedCandidate: null };
  let finish;
  const decision = new Promise(resolve => { finish = resolve; });
  const validTarget = () => doc.matchesEditTarget(target);
  const hasPrompts = () => prompts.points.length > 0 || !!prompts.box;
  const setMessage = text => { status.textContent = text; };
  const previewMessage = () => !mask ? 'No object was found. Try another preview, point or box.' :
    prompts.points.some(point => point.label !== 0 && !mask[point.y * width + point.x]) ?
      'An Include point is outside this preview. Try another preview or refine the prompts.' :
      'Selection preview ready. Apply keeps the original image pixels.';
  function showCandidates() {
    const select = input('candidate');
    select.replaceChildren(...decoded.choices.map((choice, index) => new Option(`Preview ${index + 1}${choice.default ? ' (default)' : ''}`, String(choice.index))));
    select.value = String(decoded.selectedCandidate);
    const visible = decodedRevision === revision && decoded.choices.length > 1;
    select.parentElement.hidden = !visible;
    panel.querySelector('#object-selection-candidates-help').hidden = !visible;
  }
  const fail = error => {
    fatal = true; ready = false; mask = null; controls.disabled = true; apply.disabled = true;
    setMessage(error.code === 'SESSION_EXPIRED' ? 'Selection session expired. Close this dialog and reopen Object select.' :
      `${error.message || 'Object selection failed.'} Close this dialog and reopen Object select to retry.`);
  };
  const cancel = () => {
    cancelled = true; closing = true; controls.disabled = true; apply.disabled = true;
    setMessage('Cancelling…'); finish(false);
    if (operation && !operation.cancel) {
      const id = operation.id;
      // Handle transport rejection immediately, while still awaiting both the
      // matching command and cancellation acknowledgement before releasing UI.
      operation.cancel = Promise.resolve().then(() => bridge.localAiCancel({ id })).catch(error => ({ ok: false, error: { message: error.message } }));
    }
  };
  const changed = () => { if (!validTarget()) cancel(); };
  async function invoke(method, request) {
    const lease = { id: crypto.randomUUID(), cancel: null };
    operation = lease;
    try { return await bridge[method]({ ...request, id: lease.id }); }
    finally {
      try {
        if (lease.cancel) {
          const result = await lease.cancel;
          if (!result?.ok && result?.error?.code !== 'NOT_FOUND') {
            try { unwrap(result); } catch (error) { cleanupError = error; throw error; }
          }
        }
      } finally { if (operation === lease) operation = null; }
    }
  }
  function draw() {
    if (!width) return;
    context.clearRect(0, 0, width, height);
    if (mask) {
      const pixels = overlay.getContext('2d').createImageData(width, height);
      for (let i = 0; i < mask.length; i++) if (mask[i]) {
        pixels.data[i * 4] = 40; pixels.data[i * 4 + 1] = 135; pixels.data[i * 4 + 2] = 245; pixels.data[i * 4 + 3] = 100;
      }
      overlay.getContext('2d').putImageData(pixels, 0, 0); context.drawImage(overlay, 0, 0);
    }
    const line = Math.max(1, Math.max(width, height) / 300);
    context.lineWidth = line; context.strokeStyle = '#fff'; context.fillStyle = '#0369a1';
    for (const point of prompts.points) { context.fillStyle = point.label === 0 ? '#c93434' : '#0369a1'; context.beginPath(); context.arc(point.x, point.y, line * 3, 0, Math.PI * 2); context.fill(); context.stroke(); }
    const box = drag ? { x1: drag.start.x, y1: drag.start.y, x2: drag.end.x, y2: drag.end.y } : prompts.box;
    if (box) {
      context.strokeStyle = '#0369a1'; context.strokeRect(box.x1, box.y1, box.x2 - box.x1, box.y2 - box.y1);
      context.setLineDash([line * 3, line * 3]); context.strokeStyle = '#fff';
      context.strokeRect(box.x1, box.y1, box.x2 - box.x1, box.y2 - box.y1); context.setLineDash([]);
    }
    panel.querySelector('.object-selection-count').textContent = `${prompts.points.length} point${prompts.points.length === 1 ? '' : 's'}${prompts.box ? ' and a box' : ''}. Up to ${maxSlots} points, or a box and ${maxSlots - 2} points.`;
  }
  async function decodeLatest() {
    try {
      while (!closing && !fatal && ready && hasPrompts() && decodedRevision !== revision) {
        const version = revision, requestPrompts = { points: prompts.points.map(point => ({ ...point })), ...(prompts.box ? { box: { ...prompts.box } } : {}) };
        setMessage('Finding the object…');
        const reply = await invoke('localAiSelectObject', { sessionId, targetToken, prompts: requestPrompts });
        if (closing || !validTarget()) { if (!closing) cancel(); return; }
        let result;
        try { result = unwrap(reply); }
        catch (error) {
          if (error.code !== 'INPUT') throw error;
          if (version !== revision) continue;
          prompts = decoded.prompts; mask = decoded.mask; decodedRevision = revision;
          apply.disabled = !mask; showCandidates(); setMessage(error.message); draw();
          return;
        }
        if (version !== revision) continue;
        if (result.sessionId !== sessionId || result.targetToken !== targetToken || result.width !== width || result.height !== height ||
            !Array.isArray(result.candidates) || result.candidates.length !== 3 ||
            result.candidates.some(candidate => !(candidate instanceof Uint8Array) || candidate.length !== width * height || candidate.some(value => value !== 0 && value !== 1)) ||
            !Number.isInteger(result.selectedCandidate) || result.selectedCandidate < 0 || result.selectedCandidate >= 3 ||
            !(result.mask instanceof Uint8Array) || result.mask.length !== width * height || !result.mask.every((value, index) => value === result.candidates[result.selectedCandidate][index])) {
          throw new Error('The local worker returned an invalid object mask.');
        }
        decodedRevision = version;
        mask = result.mask.some(value => value === 1) ? result.mask : null;
        const choices = [];
        // Keep the default first and avoid offering byte-identical alternatives.
        for (const index of [result.selectedCandidate, ...[0, 1, 2].filter(index => index !== result.selectedCandidate)]) {
          const candidate = result.candidates[index];
          if (!choices.some(choice => choice.mask.every((value, offset) => value === candidate[offset]))) choices.push({ index, mask: candidate, default: index === result.selectedCandidate });
        }
        decoded = { prompts: requestPrompts, mask, choices, selectedCandidate: result.selectedCandidate };
        showCandidates();
        apply.disabled = !mask;
        setMessage(previewMessage());
        draw();
      }
    } catch (error) { if (!cancelled || error.code === 'CLEANUP') fail(error); }
    finally { pump = null; }
  }
  function updatePrompts(next) {
    if (!ready || closing || fatal) return;
    prompts = next; revision++; mask = null; apply.disabled = true; draw();
    if (!hasPrompts()) { decoded = { prompts, mask: null, choices: [], selectedCandidate: null }; decodedRevision = revision; }
    showCandidates();
    setMessage(hasPrompts() ? 'Finding the object…' : 'Add a point or box to select an object.');
    if (!pump && hasPrompts()) pump = decodeLatest();
  }
  function addPoint(point) {
    if (point.label === 0 && !prompts.box && !prompts.points.some(value => value.label !== 0)) {
      setMessage('Include a foreground point or rectangle before excluding an object.'); return;
    }
    if (prompts.points.length + (prompts.box ? 2 : 0) >= maxSlots) { setMessage('Prompt limit reached. Clear prompts to start again.'); return; }
    updatePrompts({ ...prompts, points: [...prompts.points, point] });
  }
  function setBox(box) {
    if (prompts.points.length + 2 > maxSlots) { setMessage('A box needs room for two points. Clear prompts to start again.'); return; }
    if (!(box.x1 < box.x2 && box.y1 < box.y2)) { setMessage('Set two different box corners, with right and bottom after left and top.'); return; }
    updatePrompts({ ...prompts, box });
  }
  function coordinates(names) {
    const values = {};
    for (const name of names) {
      const value = Number(input(name).value), limit = name.startsWith('x') ? width : height;
      if (!input(name).value.trim() || !Number.isInteger(value) || value < 0 || value >= limit) {
        setMessage('Enter whole-number coordinates inside the preview image.'); input(name).focus(); return null;
      }
      values[name] = value;
    }
    return values;
  }
  function pointAt(event, clamp = false) {
    const rect = canvas.getBoundingClientRect(), scale = Math.min(rect.width / width, rect.height / height);
    const x = (event.clientX - rect.left - (rect.width - width * scale) / 2) / scale;
    const y = (event.clientY - rect.top - (rect.height - height * scale) / 2) / scale;
    if (!clamp && (x < 0 || y < 0 || x >= width || y >= height)) return null;
    return { x: Math.max(0, Math.min(width - 1, Math.floor(x))), y: Math.max(0, Math.min(height - 1, Math.floor(y))) };
  }
  panel.querySelector('[data-object="cancel"]').onclick = cancel;
  panel.oncancel = event => { event.preventDefault(); cancel(); };
  form.onsubmit = event => {
    event.preventDefault();
    if (mask && decodedRevision === revision && !closing && validTarget()) { closing = true; controls.disabled = true; apply.disabled = true; setMessage('Applying selection…'); finish(true); }
  };
  // Enter in coordinate fields adds the requested prompt, never applies an old mask.
  form.onkeydown = event => {
    if (event.key === 'Enter' && event.target.matches('input[type="number"]')) {
      event.preventDefault(); panel.querySelector(`[data-object="${input('mode').value === 'box' ? 'box' : 'point'}"]`).click();
    }
  };
  input('mode').onchange = () => {
    drag = null;
    for (const group of panel.querySelectorAll('[data-coordinates]')) group.hidden = group.dataset.coordinates !== (input('mode').value === 'box' ? 'box' : 'point');
    draw();
  };
  input('candidate').onchange = () => {
    if (!ready || closing || fatal || decodedRevision !== revision || !validTarget()) return;
    const choice = decoded.choices.find(choice => String(choice.index) === input('candidate').value);
    if (!choice) return;
    mask = choice.mask.some(value => value === 1) ? choice.mask : null;
    decoded = { ...decoded, mask, selectedCandidate: choice.index };
    apply.disabled = !mask;
    setMessage(previewMessage());
    draw();
  };
  panel.querySelector('[data-object="point"]').onclick = () => { const point = coordinates(['x', 'y']); if (point) addPoint({ ...point, label: input('mode').value === 'negative' ? 0 : 1 }); };
  panel.querySelector('[data-object="box"]').onclick = () => { const box = coordinates(['x1', 'y1', 'x2', 'y2']); if (box) setBox(box); };
  panel.querySelector('[data-object="clear"]').onclick = () => { drag = null; updatePrompts({ points: [] }); };
  canvas.onpointerdown = event => {
    if (event.button !== 0 || !ready || closing || fatal) return;
    const point = pointAt(event); if (!point) return;
    event.preventDefault(); event.stopPropagation(); canvas.focus();
    if (input('mode').value !== 'box') addPoint({ ...point, label: input('mode').value === 'negative' ? 0 : 1 });
    else { drag = { id: event.pointerId, start: point, end: point }; canvas.setPointerCapture(event.pointerId); draw(); }
  };
  canvas.onpointermove = event => { if (drag?.id === event.pointerId) { drag.end = pointAt(event, true); draw(); } };
  canvas.onpointerup = event => {
    if (drag?.id !== event.pointerId) return;
    const { start } = drag, end = pointAt(event, true); drag = null;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    setBox({ x1: Math.min(start.x, end.x), y1: Math.min(start.y, end.y), x2: Math.max(start.x, end.x), y2: Math.max(start.y, end.y) }); draw();
  };
  canvas.onpointercancel = canvas.onlostpointercapture = () => { if (drag) { drag = null; draw(); } };
  panel.addEventListener('keydown', event => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); cancel(); } });
  canvas.onkeydown = event => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); cancel(); }
    if (event.key === 'Enter') { event.preventDefault(); input('x').focus(); }
  };
  doc.addEventListener('change', changed); doc.addEventListener('preview', changed);
  let accepted = false;
  try {
    document.body.append(panel); panel.show();
    try {
      const state = unwrap(await bridge.localAiStatus());
      if (!state.features?.['efficientsam-ti']?.configured) throw new Error('Object select is not configured. See the local model setup instructions in README.');
      const bounds = state.selection?.bounds;
      if (!['maxSide', 'maxPixels', 'maxPngBytes', 'maxPromptSlots'].every(key => Number.isSafeInteger(bounds?.[key]) && bounds[key] > 0) || bounds.maxPromptSlots < 2) {
        throw new Error('The local worker returned invalid selection limits.');
      }
      maxSlots = bounds.maxPromptSlots;
      const scale = Math.min(1, bounds.maxSide / Math.max(source.width, source.height), Math.sqrt(bounds.maxPixels / (source.width * source.height)));
      width = Math.max(1, Math.round(source.width * scale)); height = Math.max(1, Math.round(source.height * scale));
      if (width * height > bounds.maxPixels) throw new Error('This image cannot fit the local selection limits.');
      for (const image of [canvas, prepared, overlay]) { image.width = width; image.height = height; }
      prepared.getContext('2d').drawImage(source, 0, 0, width, height); draw();
      if (width !== source.width || height !== source.height) {
        const note = panel.querySelector('.object-selection-scale'); note.hidden = false;
        note.textContent = `Preview scaled to ${width} × ${height} from ${source.width} × ${source.height}. Selection maps back to the original pixels.`;
      }
      for (const name of ['x', 'y', 'x1', 'y1', 'x2', 'y2']) input(name).max = (name.startsWith('x') ? width : height) - 1;
      input('x2').value = width - 1; input('y2').value = height - 1;
      if (!cancelled && validTarget()) {
        const blob = await new Promise((resolve, reject) => prepared.toBlob(value => value ? resolve(value) : reject(new Error('Could not encode the preview.')), 'image/png'));
        if (blob.size > bounds.maxPngBytes) throw new Error('The encoded preview exceeds the local selection limit.');
        const png = new Uint8Array(await blob.arrayBuffer());
        if (!cancelled && validTarget()) {
          const result = unwrap(await invoke('localAiPrepareSelection', { targetToken, png, width, height }));
          if (typeof result.sessionId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(result.sessionId)) sessionId = result.sessionId;
          if (!sessionId || result.targetToken !== targetToken || result.width !== width || result.height !== height) throw new Error('The local worker returned an invalid selection session.');
          if (!cancelled && validTarget()) { ready = true; controls.disabled = false; setMessage('Add a point or box to select an object.'); }
        }
      }
      if (!validTarget()) cancel();
    } catch (error) { if (!cancelled) fail(error); else if (error.code === 'CLEANUP') cleanupError = error; }
    accepted = await decision;
  } finally {
    if (pump) await pump;
    try {
      if (sessionId) {
        const result = await bridge.localAiReleaseSelection({ sessionId });
        if (!result?.ok && !['SESSION_EXPIRED', 'NOT_FOUND'].includes(result?.error?.code)) unwrap(result);
      }
    } catch (error) { cleanupError = error; }
    if (accepted && !cancelled && !cleanupError && mask && validTarget()) {
      try {
        const full = new Uint8Array(source.width * source.height);
        let sliceStart = performance.now();
        for (let y = 0; y < source.height; y++) {
          const sourceRow = Math.min(height - 1, Math.floor((y + .5) * height / source.height)) * width;
          for (let x = 0; x < source.width; x++) full[y * source.width + x] = mask[sourceRow + Math.min(width - 1, Math.floor((x + .5) * width / source.width))];
          if (y % 128 === 127 && performance.now() - sliceStart > 8) {
            await new Promise(resolve => setTimeout(resolve, 0)); sliceStart = performance.now();
            if (cancelled || !validTarget()) break;
          }
        }
        if (!cancelled && validTarget()) {
          doc.removeEventListener('change', changed); doc.removeEventListener('preview', changed);
          doc.selectMask(target, full);
        } else accepted = false;
      } catch (error) { cleanupError = error; accepted = false; }
    } else accepted = false;
    doc.removeEventListener('change', changed); doc.removeEventListener('preview', changed);
    panel.close(); panel.remove(); canvas.remove();
  }
  if (cleanupError) throw cleanupError;
  return accepted || undefined;
}
