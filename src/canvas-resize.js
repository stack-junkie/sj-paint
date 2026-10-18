import { PAINT_LIMITS, assertDocumentBudget } from './engine.js';

// The gesture owns only a candidate rectangle. Pixels and history change once,
// on pointer release or keyboard confirmation; every preview shares this owner.
export function bindCanvasResize({ doc, stage, viewport, zoom, canStart, prepare, changed, reportError }) {
  const preview = stage.querySelector('#canvas-resize-preview');
  const announcement = document.createElement('span');
  announcement.className = 'canvas-resize-announcement';
  announcement.setAttribute('role', 'status');
  announcement.setAttribute('aria-live', 'polite');
  stage.append(announcement);
  let gesture = null;
  function clearGesture(message) {
    if (!gesture) return false;
    const previous = gesture;
    gesture = null;
    preview.hidden = true;
    stage.classList.remove('resizing-canvas', 'keyboard-resize');
    if (previous.pointerId !== null && previous.handle.hasPointerCapture(previous.pointerId)) previous.handle.releasePointerCapture(previous.pointerId);
    if (previous.mode === 'keyboard') announcement.textContent = message;
    changed();
    return true;
  }
  function cancel() { return clearGesture('Canvas resize cancelled.'); }
  function updateCandidate(dx, dy) {
    const g = gesture;
    if (!g) return;
    const clamp = value => Math.max(1, Math.min(PAINT_LIMITS.maxDimension, value));
    const width = clamp(g.width + (g.edge.includes('w') ? -dx : g.edge.includes('e') ? dx : 0));
    const height = clamp(g.height + (g.edge.includes('n') ? -dy : g.edge.includes('s') ? dy : 0));
    const left = g.edge.includes('w') ? g.width - width : 0;
    const top = g.edge.includes('n') ? g.height - height : 0;
    g.candidate = { width, height, left, top };
    // Retain the accepted displacement so reversing a keyboard step at a
    // dimension limit responds immediately, with no accumulated overshoot.
    g.dx = g.edge.includes('w') ? left : width - g.width;
    g.dy = g.edge.includes('n') ? top : height - g.height;
    g.error = null;
    try { assertDocumentBudget(width, height, doc.layers.length); } catch (error) { g.error = error; }
    Object.assign(preview.style, { left: `${left * g.zoom}px`, top: `${top * g.zoom}px`, width: `${width * g.zoom}px`, height: `${height * g.zoom}px` });
    preview.classList.toggle('invalid', Boolean(g.error));
    preview.hidden = false;
    if (g.mode === 'keyboard') announcement.textContent = g.error ? g.error.message : `Canvas preview: ${width} by ${height} pixels. Enter applies; Escape cancels.`;
    changed();
  }
  function update(event) {
    const g = gesture;
    if (!g || g.mode !== 'pointer' || event.pointerId !== g.pointerId) return;
    updateCandidate(Math.round((event.clientX - g.x + viewport.scrollLeft - g.scrollX) / g.zoom),
      Math.round((event.clientY - g.y + viewport.scrollTop - g.scrollY) / g.zoom));
  }
  function begin(handle, event = null) {
    if (gesture || !canStart()) return false;
    prepare();
    if (!event) handle.focus({ preventScroll: true });
    gesture = { handle, mode: event ? 'pointer' : 'keyboard', pointerId: event?.pointerId ?? null, edge: handle.dataset.handle,
      x: event?.clientX, y: event?.clientY, width: doc.width, height: doc.height,
      zoom: zoom(), scrollX: viewport.scrollLeft, scrollY: viewport.scrollTop, dx: 0, dy: 0 };
    if (event) handle.setPointerCapture(event.pointerId);
    stage.classList.add('resizing-canvas');
    stage.classList.toggle('keyboard-resize', !event);
    updateCandidate(0, 0);
    return true;
  }
  function commit() {
    if (!gesture) return;
    const { candidate, error } = gesture;
    clearGesture(error ? error.message : `Canvas resized to ${candidate.width} by ${candidate.height} pixels.`);
    if (error) { reportError(error); return; }
    try { doc.resizeCanvas(candidate.width, candidate.height, { offsetX: -candidate.left, offsetY: -candidate.top }); }
    catch (error) { announcement.textContent = error.message; reportError(error); }
  }
  const names = { nw: 'top left', n: 'top', ne: 'top right', w: 'left', e: 'right', sw: 'bottom left', s: 'bottom', se: 'bottom right' };
  for (const handle of stage.querySelectorAll('.resize-handle')) {
    const edge = handle.dataset.handle;
    const axes = edge === 'n' || edge === 's' ? 'Up and Down' : edge === 'w' || edge === 'e' ? 'Left and Right' : 'Arrow';
    handle.tabIndex = 0;
    handle.setAttribute('role', 'button');
    handle.setAttribute('aria-label', `Resize canvas ${names[edge]}`);
    const instructions = `${axes} keys move this edge by 1 pixel; Shift moves 10 pixels. Enter applies; Escape or leaving the handle cancels.`;
    handle.setAttribute('aria-description', instructions);
    handle.title = `Resize canvas ${names[edge]}. ${instructions}`;
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0 || gesture || !canStart()) return;
      event.preventDefault();
      begin(handle, event);
    });
    handle.addEventListener('pointermove', update);
    handle.addEventListener('pointerup', event => {
      if (!gesture || gesture.mode !== 'pointer' || event.pointerId !== gesture.pointerId) return;
      update(event);
      commit();
    });
    for (const type of ['pointercancel', 'lostpointercapture']) handle.addEventListener(type, event => {
      if (gesture?.pointerId === event.pointerId) cancel();
    });
    handle.addEventListener('keydown', event => {
      if (event.ctrlKey || event.metaKey || event.altKey || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', 'Escape'].includes(event.key)) return;
      // Escape retains its document-wide cancellation route when this module
      // has no gesture, including while a dormant handle happens to be focused.
      if (event.key === 'Escape' && !gesture) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') { cancel(); return; }
      if (gesture && (gesture.mode !== 'keyboard' || gesture.handle !== handle)) return;
      if (event.key === 'Enter') { commit(); return; }
      const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
      if (horizontal ? !/[we]/.test(edge) : !/[ns]/.test(edge)) return;
      if (!gesture && !begin(handle)) return;
      const step = (event.shiftKey ? 10 : 1) * (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1);
      updateCandidate(gesture.dx + (horizontal ? step : 0), gesture.dy + (horizontal ? 0 : step));
    });
    handle.addEventListener('blur', () => { if (gesture?.mode === 'keyboard' && gesture.handle === handle) cancel(); });
  }
  // A command that replaces document state cannot retain an old rectangle.
  doc.addEventListener('change', cancel);
  window.addEventListener('blur', cancel);
  return { cancel, get candidate() { return gesture?.candidate ?? null; } };
}
