import { PAINT_LIMITS, assertDocumentBudget } from './engine.js';

// The gesture owns only a candidate rectangle. Pixels and history change once,
// on release; the status bar and outline read the same candidate throughout.
export function bindCanvasResize({ doc, stage, viewport, zoom, canStart, prepare, changed, reportError }) {
  const preview = stage.querySelector('#canvas-resize-preview');
  let gesture = null;
  function cancel() {
    if (!gesture) return false;
    const previous = gesture;
    gesture = null;
    preview.hidden = true;
    stage.classList.remove('resizing-canvas');
    if (previous.handle.hasPointerCapture(previous.pointerId)) previous.handle.releasePointerCapture(previous.pointerId);
    changed();
    return true;
  }
  function update(event) {
    const g = gesture;
    if (!g || event.pointerId !== g.pointerId) return;
    const dx = Math.round((event.clientX - g.x + viewport.scrollLeft - g.scrollX) / g.zoom);
    const dy = Math.round((event.clientY - g.y + viewport.scrollTop - g.scrollY) / g.zoom);
    const clamp = value => Math.max(1, Math.min(PAINT_LIMITS.maxDimension, value));
    const width = clamp(g.width + (g.edge.includes('w') ? -dx : g.edge.includes('e') ? dx : 0));
    const height = clamp(g.height + (g.edge.includes('n') ? -dy : g.edge.includes('s') ? dy : 0));
    const left = g.edge.includes('w') ? g.width - width : 0;
    const top = g.edge.includes('n') ? g.height - height : 0;
    g.candidate = { width, height, left, top };
    g.error = null;
    try { assertDocumentBudget(width, height, doc.layers.length); } catch (error) { g.error = error; }
    Object.assign(preview.style, { left: `${left * g.zoom}px`, top: `${top * g.zoom}px`, width: `${width * g.zoom}px`, height: `${height * g.zoom}px` });
    preview.classList.toggle('invalid', Boolean(g.error));
    preview.hidden = false;
    changed();
  }
  for (const handle of stage.querySelectorAll('.resize-handle')) {
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0 || gesture || !canStart()) return;
      event.preventDefault();
      prepare();
      gesture = { handle, pointerId: event.pointerId, edge: handle.dataset.handle,
        x: event.clientX, y: event.clientY, width: doc.width, height: doc.height,
        zoom: zoom(), scrollX: viewport.scrollLeft, scrollY: viewport.scrollTop };
      handle.setPointerCapture(event.pointerId);
      stage.classList.add('resizing-canvas');
      update(event);
    });
    handle.addEventListener('pointermove', update);
    handle.addEventListener('pointerup', event => {
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      update(event);
      const { candidate, error } = gesture;
      cancel();
      if (error) { reportError(error); return; }
      try { doc.resizeCanvas(candidate.width, candidate.height, { offsetX: -candidate.left, offsetY: -candidate.top }); }
      catch (error) { reportError(error); }
    });
    for (const type of ['pointercancel', 'lostpointercapture']) handle.addEventListener(type, event => {
      if (gesture?.pointerId === event.pointerId) cancel();
    });
  }
  // A command that replaces document state cannot retain an old rectangle.
  doc.addEventListener('change', cancel);
  window.addEventListener('blur', cancel);
  return { cancel, get candidate() { return gesture?.candidate ?? null; } };
}
