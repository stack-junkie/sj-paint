import PROJECT from './project-format.json' with { type: 'json' };
import { normalizeResolution } from './image-metadata.js';
import { matrix, translation, multiply, inverse, mapPoint, around, rotation, selectionGeometry, hitSelectionGeometry, gestureTransform, paintSelection, ownsDocumentPoint } from './selection-transform.js';

export const PAINT_LIMITS = Object.freeze({
  maxDimension: 16384, maxPixels: 32 * 1024 * 1024, maxLayers: 64,
  maxDocumentBytes: 128 * 1024 * 1024, historyBytes: 128 * 1024 * 1024,
  maxEncodedProjectBytes: 64 * 1024 * 1024,
});
export const DEFAULT_DOCUMENT_SIZE = Object.freeze({ width: 1152, height: 648 });
// Native Paint 11.2605.81.0 ICommandHost.GetDefaultDimensions uses MULSS
// with float32 0.6, then truncates. Properties owns when to request this size.
export function defaultDimensionsForDisplay(metrics) {
  if (!metrics || !['width', 'height'].every(axis => Number.isSafeInteger(metrics[axis]) && metrics[axis] > 0 && metrics[axis] <= 0x7fffffff)) {
    throw new RangeError('Invalid primary display dimensions.');
  }
  const scaled = axis => Math.trunc(Math.fround(Math.fround(metrics[axis]) * Math.fround(0.6)));
  const [width, height] = dimensions(scaled('width'), scaled('height'));
  return { width, height };
}
const { historyBytes: HISTORY_LIMIT, maxPixels: MAX_PIXELS, maxDimension: MAX_DIMENSION, maxLayers: MAX_LAYERS } = PAINT_LIMITS;

function dimensions(width, height) {
  const w = Math.round(Number(width));
  const h = Math.round(Number(height));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1 ||
      w > MAX_DIMENSION || h > MAX_DIMENSION || w * h > MAX_PIXELS) {
    throw new RangeError('Canvas must be 1–16384 pixels per side and at most 32 megapixels.');
  }
  return [w, h];
}

export function assertDocumentBudget(width, height, layerCount, selectionPixels = 0) {
  const [w, h] = dimensions(width, height);
  if (!Number.isInteger(layerCount) || layerCount < 1 || layerCount > MAX_LAYERS ||
      !Number.isSafeInteger(selectionPixels) || selectionPixels < 0 ||
      w * h * layerCount * 4 + selectionPixels * 5 > PAINT_LIMITS.maxDocumentBytes) {
    throw new RangeError('The combined layers and floating selection exceed the 128 MiB document pixel limit.');
  }
  return [w, h];
}

export function createCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  // Establish one raster backend before any consumer obtains the context.
  // Draft scratch surfaces and accepted layers must use the same antialiasing.
  canvas.getContext('2d', { willReadFrequently: true });
  return canvas;
}

const context = canvas => canvas.getContext('2d', { willReadFrequently: true });
const id = () => globalThis.crypto?.randomUUID?.() ?? `layer-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const copy = canvas => {
  const result = createCanvas(canvas.width, canvas.height);
  context(result).drawImage(canvas, 0, 0);
  return result;
};
export function maskedCanvas(source, mask, matte) {
  if (!(mask instanceof Uint8Array) || mask.length !== source.width * source.height) {
    throw new Error('The background mask does not match this layer.');
  }
  const image = context(source).getImageData(0, 0, source.width, source.height);
  const unmix = matte?.unmixEdges === true;
  if (matte?.unmixEdges !== undefined && !unmix || unmix &&
      (matte.method !== 'flat-drawing-border-flood' || !Array.isArray(matte.paperRgb) || matte.paperRgb.length !== 3 ||
       !matte.paperRgb.every(value => Number.isInteger(value) && value >= 0 && value <= 255) ||
       image.data.some((value, index) => index % 4 === 3 && value !== 255))) {
    throw new Error('The background matte correction does not match this layer.');
  }
  for (let i = 0; i < mask.length; i++) {
    const offset = i * 4, alpha = mask[i] / 255;
    if (unmix && mask[i] > 0 && mask[i] < 255) {
      // The worker estimates coverage; composition removes the known opaque
      // paper contribution from only those antialiased boundary pixels.
      for (let channel = 0; channel < 3; channel++) image.data[offset + channel] =
        Math.round((image.data[offset + channel] - (1 - alpha) * matte.paperRgb[channel]) / alpha);
    }
    image.data[offset + 3] = Math.round(image.data[offset + 3] * alpha);
  }
  const result = createCanvas(source.width, source.height);
  context(result).putImageData(image, 0, 0);
  return result;
}
function makeSelection({ canvas, mask, layerId, transform = translation(0, 0) }) {
  const selected = { canvas, mask, layerId, transform: matrix(transform) };
  // Compatibility views for existing integrations. Geometry has one canonical owner.
  for (const key of ['x', 'y', 'width', 'height']) {
    Object.defineProperty(selected, key, { enumerable: true, get() { return selectionGeometry(this).bounds[key]; } });
  }
  return selected;
}
const copySelection = selection => selection ? makeSelection({ ...selection, canvas: copy(selection.canvas), mask: selection.mask?.slice() }) : null;
const stateBytes = state => state.layers.reduce((total, layer) => total + layer.canvas.width * layer.canvas.height * 4, 0) +
  (state.selection ? state.selection.canvas.width * state.selection.canvas.height * 4 + (state.selection.mask?.byteLength ?? 0) : 0);

function colorBytes(color) {
  if (typeof color !== 'string' || !CSS.supports('color', color)) throw new TypeError('Invalid selection key color.');
  const ctx = context(createCanvas(1, 1));
  ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1);
  return ctx.getImageData(0, 0, 1, 1).data;
}

function sameCanvas(a, b) {
  if (a.width !== b.width || a.height !== b.height) return false;
  // Compare strips to keep comparison scratch memory independent of canvas height.
  for (let y = 0; y < a.height; y += 32) {
    const h = Math.min(32, a.height - y);
    const left = context(a).getImageData(0, y, a.width, h).data;
    const right = context(b).getImageData(0, y, b.width, h).data;
    for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
  }
  return true;
}

function sameState(a, b) {
  if (a.width !== b.width || a.height !== b.height || a.background !== b.background ||
      a.resolution.xDpi !== b.resolution.xDpi || a.resolution.yDpi !== b.resolution.yDpi ||
      a.activeLayerId !== b.activeLayerId || a.layers.length !== b.layers.length ||
      Boolean(a.selection) !== Boolean(b.selection)) return false;
  if (a.selection) {
    for (const key of ['layerId']) {
      if (a.selection[key] !== b.selection[key]) return false;
    }
    if (!a.selection.transform.every((value, index) => value === b.selection.transform[index])) return false;
    if (!sameCanvas(a.selection.canvas, b.selection.canvas)) return false;
    const pixels = a.selection.canvas.width * a.selection.canvas.height;
    for (let i = 0; i < pixels; i++) if ((a.selection.mask?.[i] ?? 1) !== (b.selection.mask?.[i] ?? 1)) return false;
  }
  return a.layers.every((layer, index) => {
    const other = b.layers[index];
    return ['id', 'name', 'visible', 'opacity'].every(key => layer[key] === other[key]) && sameCanvas(layer.canvas, other.canvas);
  });
}

function sameSavedContent(a, b) {
  if (a.width !== b.width || a.height !== b.height || a.background !== b.background || a.layers.length !== b.layers.length ||
      a.resolution.xDpi !== b.resolution.xDpi || a.resolution.yDpi !== b.resolution.yDpi) return false;
  return a.layers.every((layer, index) => {
    const other = b.layers[index];
    if (!['id', 'name', 'visible', 'opacity'].every(key => layer[key] === other[key])) return false;
    const firstSelection = a.selection?.layerId === layer.id ? a.selection : null;
    const secondSelection = b.selection?.layerId === other.id ? b.selection : null;
    if (!firstSelection && !secondSelection) return sameCanvas(layer.canvas, other.canvas);
    const first = createCanvas(a.width, Math.min(32, a.height));
    const second = createCanvas(a.width, Math.min(32, a.height));
    for (let y = 0; y < a.height; y += 32) {
      const stripHeight = Math.min(32, a.height - y);
      if (first.height !== stripHeight) first.height = second.height = stripHeight;
      for (const [target, source, selection] of [[first, layer.canvas, firstSelection], [second, other.canvas, secondSelection]]) {
        const ctx = context(target);
        ctx.clearRect(0, 0, target.width, target.height);
        ctx.drawImage(source, 0, -y);
        paintSelection(ctx, selection, 0, -y);
      }
      if (!sameCanvas(first, second)) return false;
    }
    return true;
  });
}

function validateLoadedLayers(data) {
  if (!Array.isArray(data.layers) || !data.layers.length || data.layers.length > MAX_LAYERS) throw new Error('A project must contain between 1 and 64 layers.');
  if (data.background !== null && (typeof data.background !== 'string' || !CSS.supports('color', data.background))) throw new Error('Invalid project background.');
  const ids = new Set();
  for (const layer of data.layers) {
    if (!layer || typeof layer.id !== 'string' || !layer.id || ids.has(layer.id) || typeof layer.name !== 'string' ||
      typeof layer.visible !== 'boolean' || !Number.isFinite(layer.opacity) || layer.opacity < 0 || layer.opacity > 1) throw new Error('Invalid project layer.');
    ids.add(layer.id);
  }
  if (!ids.has(data.activeLayerId)) throw new Error('The project active layer is missing.');
}

function checkPngDimensions(url, width, height) {
  let header;
  try { header = atob(url.slice('data:image/png;base64,'.length, 'data:image/png;base64,'.length + 44)); }
  catch { throw new Error('A project layer contains an invalid PNG header.'); }
  const bytes = Uint8Array.from(header, character => character.charCodeAt(0));
  if (bytes.length < 24 || ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte) ||
      String.fromCharCode(...bytes.slice(12, 16)) !== 'IHDR') throw new Error('A project layer contains an invalid PNG header.');
  const view = new DataView(bytes.buffer);
  if (view.getUint32(8) !== 13 || view.getUint32(16) !== width || view.getUint32(20) !== height) {
    throw new Error('Project layer dimensions do not match the document.');
  }
}

function imageFromURL(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('A project layer contains an unreadable PNG.'));
    image.src = url;
  });
}

export class PaintDocument extends EventTarget {
  constructor(width = DEFAULT_DOCUMENT_SIZE.width, height = DEFAULT_DOCUMENT_SIZE.height) {
    super();
    this._undo = [];
    this._redo = [];
    this._transaction = null;
    this.newDocument(width, height);
  }

  get activeLayer() { return this.layers.find(layer => layer.id === this.activeLayerId); }
  get canUndo() { return Boolean(this._selectionSession) || this._undo.length > 0; }
  get canRedo() { return this._redo.length > 0; }
  get hasSelectionSession() { return Boolean(this._selectionSession); }
  get revision() { return this._revision; }
  get dirty() { return this._revision !== this._savedRevision; }
  set dirty(value) {
    if (!value) this.markSaved();
    else if (!this.dirty) this._revision = this._nextRevision++;
  }
  markSaved(revision = this._revision) {
    if (!Number.isInteger(revision) || revision < this._documentStartRevision || revision >= this._nextRevision) return;
    this._savedRevision = revision;
    this._changed();
  }

  assertSelectionSize(width, height) {
    const [w, h] = dimensions(width, height);
    assertDocumentBudget(this.width, this.height, this.layers.length, w * h);
    return [w, h];
  }

  captureEditTarget() {
    const selection = this.selection;
    return Object.freeze({ document: this, generation: this._documentStartRevision, revision: this._revision,
      epoch: this._editEpoch, layer: this.activeLayer, layerId: this.activeLayerId, canvas: this.activeLayer?.canvas,
      selection, selectionCanvas: selection?.canvas, mask: selection?.mask, transform: selection?.transform,
      x: selection?.x, y: selection?.y, width: selection?.width, height: selection?.height,
      selectionLayerId: selection?.layerId, transaction: this._transaction });
  }
  matchesEditTarget(target) {
    const current = this.captureEditTarget();
    return Boolean(target) && Object.keys(current).every(key => current[key] === target[key]);
  }

  _changed() { this.dispatchEvent(new Event('change')); }
  _snapshot() {
    return { width: this.width, height: this.height, background: this.background, resolution: this.resolution,
      activeLayerId: this.activeLayerId, revision: this._revision,
      layers: this.layers.map(layer => ({ ...layer, canvas: copy(layer.canvas) })),
      selection: copySelection(this.selection) };
  }
  _current() { return { width: this.width, height: this.height, background: this.background, resolution: this.resolution,
    activeLayerId: this.activeLayerId, layers: this.layers, selection: this.selection }; }
  _restore(state) {
    this.width = state.width;
    this.height = state.height;
    this.background = state.background;
    this.resolution = state.resolution;
    this.activeLayerId = state.activeLayerId;
    this._revision = state.revision;
    // A restored state is removed from its stack and becomes exclusively owned by the document.
    this.layers = state.layers;
    this.selection = state.selection;
  }
  _retainedSnapshotBytes() {
    const seen = new Set();
    const bytes = states => states.reduce((sum, state) => {
      if (!state || seen.has(state)) return sum;
      seen.add(state); return sum + stateBytes(state);
    }, 0);
    // History retains its own cap. Cancellable snapshots have distinct owners,
    // each bounded by the document limit, and never evict pre-session history.
    return {
      history: bytes([...this._undo, ...this._redo]),
      selection: bytes([this._selectionSession?.before]),
      gesture: bytes([this._transaction?.before]),
      settlement: bytes([this._settlement?.before, ...(this._settlement?.undo ?? []), ...(this._settlement?.redo ?? [])]),
    };
  }
  _trimHistory() {
    // An enclosing command may still fail, so keep its original history available.
    if (this._settlement) return;
    let total = this._retainedSnapshotBytes().history;
    while (total > HISTORY_LIMIT && this._undo.length) total -= stateBytes(this._undo.shift());
    while (total > HISTORY_LIMIT && this._redo.length) total -= stateBytes(this._redo.shift());
  }
  _settleSelection(callback) {
    const settlement = { before: this._snapshot(), session: this._selectionSession,
      changed: this._selectionSession.changed, transaction: this._transaction,
      undo: this._undo.slice(), redo: this._redo.slice() };
    this._settlement = settlement;
    try {
      this.commitSelection();
      const result = callback();
      this._settlement = null;
      this._trimHistory();
      return result;
    } catch (error) {
      this._restore(settlement.before);
      this._selectionSession = settlement.session;
      this._selectionSession.changed = settlement.changed;
      this._transaction = settlement.transaction;
      this._undo = settlement.undo;
      this._redo = settlement.redo;
      this._settlement = null;
      this._editEpoch++;
      this._changed();
      throw error;
    }
  }
  _edit(label, callback, { selection = false, finishSelection = false } = {}) {
    if (!selection && this._selectionSession) {
      return this._settleSelection(() => this._edit(label, callback));
    }
    const ownTransaction = !this._transaction;
    if (ownTransaction) this.begin(label);
    try {
      const value = callback();
      this._editEpoch++;
      if (ownTransaction) this.commit();
      else {
        if (this._selectionSession) this._refreshSelectionRevision(this._transaction.before);
        this._changed();
      }
      if (selection && this._selectionSession && (finishSelection || !this.selection)) this.commitSelection();
      return value;
    } catch (error) {
      if (ownTransaction) this.cancel();
      throw error;
    }
  }
  begin(label = 'Edit') {
    if (this._transaction) return;
    assertDocumentBudget(this.width, this.height, this.layers.length, this.selection ? this.selection.canvas.width * this.selection.canvas.height : 0);
    this._transaction = { label, before: this._snapshot() };
    this._editEpoch++;
  }
  _refreshSelectionRevision(before) {
    const session = this._selectionSession;
    if (!session) return;
    const current = this._current();
    session.changed = !sameSavedContent(session.before, current);
    if (!session.changed) this._revision = session.before.revision;
    else if (!sameSavedContent(before, current)) this._revision = this._nextRevision++;
    if (this._transaction) this._transaction.selectionUpdated = true;
  }
  commit() {
    if (!this._transaction) return;
    const { before } = this._transaction;
    try {
      assertDocumentBudget(this.width, this.height, this.layers.length, this.selection ? this.selection.canvas.width * this.selection.canvas.height : 0);
    } catch (error) { this.cancel(); throw error; }
    if (this._selectionSession) {
      if (!this._transaction.selectionUpdated) this._refreshSelectionRevision(before);
    }
    else if (!sameState(before, this._current())) {
      if (!sameSavedContent(before, this._current())) this._revision = this._nextRevision++;
      this._undo.push(before);
      this._redo = [];
      this._trimHistory();
    }
    this._transaction = null;
    this._editEpoch++;
    this._changed();
  }
  cancel() {
    if (!this._transaction) return;
    this._restore(this._transaction.before);
    this._transaction = null;
    if (this._selectionSession) this._selectionSession.changed = !sameSavedContent(this._selectionSession.before, this._current());
    this._editEpoch++;
    this._changed();
  }
  _startSelection(label, callback) {
    if (this._selectionSession) return this._settleSelection(() => this._startSelection(label, callback));
    this.commitSelection();
    if (this._transaction) this.commit();
    this._selectionSession = { before: this._snapshot(), changed: false };
    try { return this._edit(label, callback, { selection: true }); }
    catch (error) { this.cancelSelection(); throw error; }
  }
  commitSelection() {
    const session = this._selectionSession;
    if (!session) {
      if (this.selection) this._edit('Deselect', () => this._stampSelection());
      return false;
    }
    if (this._transaction) this.commit();
    this.begin('Commit selection');
    try { this._stampSelection(); this.commit(); }
    catch (error) { this.cancel(); throw error; }
    this._selectionSession = null;
    if (session.changed) {
      this._undo.push(session.before);
      this._redo = [];
      this._trimHistory();
    }
    this._editEpoch++;
    this._changed();
    return session.changed;
  }
  cancelSelection() {
    if (!this._selectionSession) return false;
    if (this._transaction) this.cancel();
    const { before } = this._selectionSession;
    this._selectionSession = null;
    this._restore(before);
    this._editEpoch++;
    this._changed();
    return true;
  }
  undo() {
    if (this._transaction) this.cancel();
    if (this._selectionSession?.changed) this.commitSelection();
    else if (this._selectionSession) { this.cancelSelection(); return; }
    if (!this.canUndo) return;
    this._redo.push(this._snapshot());
    this._restore(this._undo.pop());
    this._editEpoch++;
    this._trimHistory();
    this._changed();
  }
  redo() {
    if (this._transaction) this.cancel();
    if (this._selectionSession?.changed) this.commitSelection();
    else if (this._selectionSession) this.cancelSelection();
    if (!this.canRedo) return;
    this._undo.push(this._snapshot());
    this._restore(this._redo.pop());
    this._editEpoch++;
    this._trimHistory();
    this._changed();
  }

  newDocument(width = DEFAULT_DOCUMENT_SIZE.width, height = DEFAULT_DOCUMENT_SIZE.height) {
    [this.width, this.height] = assertDocumentBudget(width, height, 1);
    this.background = '#ffffff';
    this.resolution = normalizeResolution();
    this.layers = [{ id: id(), name: 'Layer 1', visible: true, opacity: 1, canvas: createCanvas(this.width, this.height) }];
    this.activeLayerId = this.layers[0].id;
    this.selection = null;
    this.selectionTransparent ??= false;
    this.selectionKeyColor ??= '#ffffff';
    this._undo = [];
    this._redo = [];
    this._transaction = null;
    this._selectionSession = null;
    this._editEpoch = (this._editEpoch ?? 0) + 1;
    this._compositeScratch = null;
    this._nextRevision ??= 1;
    this._revision = this._savedRevision = this._documentStartRevision = this._nextRevision++;
    this._changed();
  }

  composite({ includeSelection = true, onlyActive = false } = {}) {
    const canvas = createCanvas(this.width, this.height);
    this.renderTo(context(canvas), { includeSelection, onlyActive });
    return canvas;
  }

  /** Render into a caller-owned display canvas without allocating an export snapshot. */
  renderTo(ctx, { includeSelection = true, onlyActive = false, layerPreview = null } = {}) {
    if (layerPreview && typeof layerPreview.paint !== 'function') throw new TypeError('A layer preview requires a paint callback.');
    ctx.save();
    try {
      ctx.resetTransform();
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      if (this.background !== null && !onlyActive) {
        ctx.fillStyle = this.background;
        ctx.fillRect(0, 0, this.width, this.height);
      }
      for (const layer of this.layers) {
        if ((onlyActive && layer.id !== this.activeLayerId) || !layer.visible) continue;
        ctx.globalAlpha = layer.opacity;
        const selection = includeSelection && this.selection?.layerId === layer.id ? this.selection : null;
        const preview = layerPreview?.layerId === layer.id ? layerPreview : null;
        if (preview || selection) {
          // Rasterize temporary content within its layer before compositing.
          // Rotated edge coverage must be quantized before blending with lower layers,
          // even at opacity 1, exactly as it is when the selection is committed.
          // Share one scratch surface between selections and pending shape previews.
          if (!this._compositeScratch || this._compositeScratch.width !== this.width || this._compositeScratch.height !== this.height) {
            this._compositeScratch = createCanvas(this.width, this.height);
          }
          const combined = this._compositeScratch;
          const scratch = context(combined);
          scratch.save();
          try {
            scratch.resetTransform();
            scratch.globalAlpha = 1;
            scratch.globalCompositeOperation = 'source-over';
            scratch.clearRect(0, 0, this.width, this.height);
            scratch.drawImage(layer.canvas, 0, 0);
            paintSelection(scratch, selection);
            if (preview) preview.paint(scratch);
          } finally { scratch.restore(); }
          ctx.drawImage(combined, 0, 0);
        } else {
          ctx.drawImage(layer.canvas, 0, 0);
        }
      }
    } finally { ctx.restore(); }
  }

  _stampSelection() {
    if (!this.selection) return;
    const target = this.layers.find(layer => layer.id === this.selection.layerId);
    if (target) paintSelection(context(target.canvas), this.selection);
    this.selection = null;
  }

  resizeCanvas(width, height, { offsetX = 0, offsetY = 0 } = {}) {
    const [nextWidth, nextHeight] = assertDocumentBudget(width, height, this.layers.length);
    if (!Number.isSafeInteger(offsetX) || !Number.isSafeInteger(offsetY)) {
      throw new RangeError('Canvas offsets must be finite safe integers.');
    }
    if (nextWidth === this.width && nextHeight === this.height && offsetX === 0 && offsetY === 0) return;
    this._edit('Resize canvas', () => {
      // Build the replacement surfaces before changing any document-owned state.
      // This also leaves an enclosing transaction intact if a surface fails to draw.
      const layers = this.layers.map(layer => {
        const canvas = createCanvas(nextWidth, nextHeight);
        const ctx = context(canvas);
        ctx.drawImage(layer.canvas, offsetX, offsetY);
        if (this.selection?.layerId === layer.id) {
          // Commit floating pixels within the old canvas boundary, then translate
          // them with their layer, just as stamping before resizing would do.
          ctx.save();
          ctx.beginPath();
          ctx.rect(offsetX, offsetY, this.width, this.height);
          ctx.clip();
          paintSelection(ctx, this.selection, offsetX, offsetY);
          ctx.restore();
        }
        return { ...layer, canvas };
      });
      this.layers = layers;
      this.selection = null;
      this.width = nextWidth;
      this.height = nextHeight;
      this._compositeScratch = null;
    });
  }

  resize(width, height, { scale = false, skewX = 0, skewY = 0, target = 'selection-or-document' } = {}) {
    const [baseWidth, baseHeight] = dimensions(width, height);
    if (![skewX, skewY].every(value => Number.isFinite(Number(value)) && Math.abs(Number(value)) < 89)) {
      throw new RangeError('Skew angles must be between -89 and 89 degrees.');
    }
    if (!scale && Number(skewX) === 0 && Number(skewY) === 0 && (!this.selection || target === 'document')) {
      return this.resizeCanvas(baseWidth, baseHeight);
    }
    const sx = Math.tan(Number(skewX) * Math.PI / 180);
    const sy = Math.tan(Number(skewY) * Math.PI / 180);
    const determinant = 1 - sx * sy;
    if (Math.abs(determinant) < 1e-8) throw new RangeError('This combination of skew angles collapses the image to a line.');
    const [nextWidth, nextHeight] = dimensions(Math.ceil(baseWidth + Math.abs(sx) * baseHeight), Math.ceil(baseHeight + Math.abs(sy) * baseWidth));
    if (this.selection && target !== 'document') {
      const source = this.selection, frame = selectionGeometry(source), [a, b, c, d, e, f] = source.transform;
      const basis = matrix([a*source.canvas.width/frame.frameWidth, b*source.canvas.width/frame.frameWidth,
        c*source.canvas.height/frame.frameHeight, d*source.canvas.height/frame.frameHeight, e, f]);
      const skew = matrix([1, sy, sx, 1, sx < 0 ? -sx*baseHeight : 0, sy < 0 ? -sy*baseWidth : 0]);
      const transform = multiply(basis, multiply(skew, scale ?
        matrix([baseWidth/source.canvas.width, 0, 0, baseHeight/source.canvas.height, 0, 0]) : translation(0, 0)));
      if (scale) { this._setSelectionTransform(transform, 'Resize selection'); return; }
      // Unscaled boundary changes deliberately crop or pad source pixels. Geometry gestures never do.
      this._validateSelectionTransform({ canvas: { width: baseWidth, height: baseHeight }, transform });
      this._edit('Resize selection bounds', () => {
        const canvas = createCanvas(baseWidth, baseHeight), ctx = context(canvas);
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'low';
        ctx.drawImage(source.canvas, 0, 0, frame.frameWidth, frame.frameHeight);
        const mask = new Uint8Array(baseWidth*baseHeight);
        for (let y = 0; y < baseHeight; y++) for (let x = 0; x < baseWidth; x++) {
          const px = Math.floor((x+.5)*source.canvas.width/frame.frameWidth), py = Math.floor((y+.5)*source.canvas.height/frame.frameHeight);
          if (px < source.canvas.width && py < source.canvas.height) mask[y*baseWidth+x] = source.mask?.[py*source.canvas.width+px] ?? 1;
        }
        this.selection = makeSelection({ canvas, mask, layerId: source.layerId, transform });
      }, { selection: true });
      return;
    }
    assertDocumentBudget(nextWidth, nextHeight, this.layers.length);
    this._edit('Resize', () => {
      this.layers = this.layers.map(layer => {
        const base = createCanvas(baseWidth, baseHeight);
        if (scale) context(base).drawImage(layer.canvas, 0, 0, baseWidth, baseHeight);
        else context(base).drawImage(layer.canvas, 0, 0);
        const canvas = createCanvas(nextWidth, nextHeight), ctx = context(canvas);
        ctx.setTransform(1, sy, sx, 1, sx < 0 ? -sx*baseHeight : 0, sy < 0 ? -sy*baseWidth : 0);
        ctx.drawImage(base, 0, 0);
        return { ...layer, canvas };
      });
      this.width = nextWidth; this.height = nextHeight;
    });
  }
  crop() {
    if (!this.selection) return;
    const { x, y, width, height } = this.getSelectionGeometry().bounds;
    assertDocumentBudget(width, height, this.layers.length);
    // Accept placement first. Crop has its own undo entry and keeps other layers unrotated.
    this._edit('Crop', () => {
      const layers = this.layers.map(layer => {
        const canvas = createCanvas(width, height);
        context(canvas).drawImage(layer.canvas, -x, -y);
        return { ...layer, canvas };
      });
      this.layers = layers;
      this.width = width;
      this.height = height;
    });
  }
  rotate(degrees) {
    if (!Number.isFinite(Number(degrees))) throw new TypeError('Rotation must be a finite angle.');
    const angle = ((Number(degrees) % 360) + 360) % 360;
    if (!angle) return;
    const radians = angle * Math.PI / 180;
    if (this.selection) {
      const transform = multiply(around(this.getSelectionGeometry().center, rotation(radians)), this.selection.transform);
      this._setSelectionTransform(transform, 'Rotate selection');
      return;
    }
    const rotatedDimensions = source => dimensions(
      Math.ceil(source.width * Math.abs(Math.cos(radians)) + source.height * Math.abs(Math.sin(radians)) - 1e-8),
      Math.ceil(source.width * Math.abs(Math.sin(radians)) + source.height * Math.abs(Math.cos(radians)) - 1e-8));
    const [width, height] = rotatedDimensions(this.layers[0].canvas);
    assertDocumentBudget(width, height, this.layers.length);
    this._edit('Rotate', () => {
      this.layers = this.layers.map(layer => {
        const canvas = createCanvas(width, height), ctx = context(canvas);
        ctx.translate(width / 2, height / 2); ctx.rotate(radians);
        ctx.drawImage(layer.canvas, -layer.canvas.width / 2, -layer.canvas.height / 2);
        return { ...layer, canvas };
      });
      this.width = width; this.height = height;
      if (angle === 90 || angle === 270) {
        this.resolution = normalizeResolution({ xDpi: this.resolution.yDpi, yDpi: this.resolution.xDpi });
      }
    });
  }
  flip(horizontal = true) {
    if (this.selection) {
      const source = this.selection;
      const reflection = around([source.canvas.width/2, source.canvas.height/2], matrix([horizontal ? -1 : 1, 0, 0, horizontal ? 1 : -1, 0, 0]));
      this._setSelectionTransform(multiply(source.transform, reflection), 'Flip selection');
      return;
    }
    this._edit('Flip', () => {
      this.layers = this.layers.map(layer => {
        const canvas = createCanvas(layer.canvas.width, layer.canvas.height), ctx = context(canvas);
        ctx.translate(horizontal ? canvas.width : 0, horizontal ? 0 : canvas.height);
        ctx.scale(horizontal ? -1 : 1, horizontal ? 1 : -1);
        ctx.drawImage(layer.canvas, 0, 0);
        return { ...layer, canvas };
      });
    });
  }
  clear() {
    if (this.selection) { this.deleteSelection(); return; }
    this._edit('Clear', () => {
      context(this.activeLayer.canvas).clearRect(0, 0, this.width, this.height);
    });
  }

  applyLayerMask(target, mask, matte) {
    if (!this.matchesEditTarget(target) || this.selection || this._transaction) {
      throw new Error('Background removal canceled because the drawing changed.');
    }
    const canvas = maskedCanvas(this.activeLayer.canvas, mask, matte);
    this._edit('Remove background', () => { this.activeLayer.canvas = canvas; });
  }

  activeLayerImage() {
    const canvas = copy(this.activeLayer.canvas);
    if (this.selection?.layerId === this.activeLayerId) paintSelection(context(canvas), this.selection);
    return canvas;
  }
  selectionMask() {
    if (!this.selection) throw new Error('Select the area to change first.');
    const mask = new Uint8Array(this.width * this.height), inv = inverse(this.selection.transform);
    for (let y = 0; y < this.height; y++) for (let x = 0; x < this.width; x++) {
      if (ownsDocumentPoint(this.selection, x + .5, y + .5, inv)) mask[y * this.width + x] = 1;
    }
    return mask;
  }
  generatedLayer(target, image, { selectionOnly = false } = {}) {
    if (!this.matchesEditTarget(target) || this._transaction) throw new Error('The drawing changed while AI was working.');
    const canvas = createCanvas(this.width, this.height), ctx = context(canvas);
    ctx.drawImage(image, 0, 0, this.width, this.height);
    if (selectionOnly) {
      const mask = this.selectionMask(), original = context(this.activeLayerImage()).getImageData(0, 0, this.width, this.height);
      const generated = ctx.getImageData(0, 0, this.width, this.height);
      // The document, not model output or resized masks, defines pixel ownership.
      for (let i = 0; i < mask.length; i++) if (!mask[i]) generated.data.set(original.data.subarray(i * 4, i * 4 + 4), i * 4);
      ctx.putImageData(generated, 0, 0);
    }
    return canvas;
  }
  applyGeneratedLayer(target, canvas, label = 'AI edit') {
    if (!this.matchesEditTarget(target) || this._transaction) throw new Error('The drawing changed while AI was working.');
    if (canvas.width !== this.width || canvas.height !== this.height) throw new Error('The generated layer does not match the drawing.');
    const owned = copy(canvas);
    this._edit(label, () => { this.activeLayer.canvas = owned; this.selection = null; }, { selection: true, finishSelection: true });
  }
  insertGeneratedImage(target, image, name) {
    if (!this.matchesEditTarget(target) || this._transaction) throw new Error('The drawing changed while AI was working.');
    assertDocumentBudget(this.width, this.height, this.layers.length + 1);
    const canvas = createCanvas(this.width, this.height), ctx = context(canvas);
    const scale = Math.min(1, this.width / image.width, this.height / image.height);
    const width = Math.max(1, Math.round(image.width * scale)), height = Math.max(1, Math.round(image.height * scale));
    ctx.drawImage(image, Math.floor((this.width - width) / 2), Math.floor((this.height - height) / 2), width, height);
    this._edit(name, () => {
      this._stampSelection();
      const layer = { id: id(), name, visible: true, opacity: 1, canvas };
      this.layers.splice(this.layers.findIndex(item => item.id === this.activeLayerId) + 1, 0, layer);
      this.activeLayerId = layer.id;
    });
  }

  invertColors() {
    const selectionTarget = Boolean(this.selection);
    this._edit('Invert colors', () => {
      const selected = this.selection;
      const edited = selected ? copy(selected.canvas) : this.activeLayer.canvas;
      const ctx = context(edited);
      const image = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
      for (let i = 0; i < image.data.length; i += 4) {
        if (!image.data[i + 3]) continue;
        image.data[i] = 255 - image.data[i];
        image.data[i + 1] = 255 - image.data[i + 1];
        image.data[i + 2] = 255 - image.data[i + 2];
      }
      ctx.putImageData(image, 0, 0);
      if (selected) this.selection = makeSelection({ ...selected, canvas: edited });
    }, { selection: selectionTarget });
  }

  addLayer(name) {
    if (this.layers.length >= MAX_LAYERS) throw new RangeError('A document supports up to 64 layers.');
    assertDocumentBudget(this.width, this.height, this.layers.length + 1);
    return this._edit('Add layer', () => {
      this._stampSelection();
      const layer = { id: id(), name: name ?? `Layer ${this.layers.length + 1}`, visible: true, opacity: 1, canvas: createCanvas(this.width, this.height) };
      this.layers.splice(this.layers.findIndex(item => item.id === this.activeLayerId) + 1, 0, layer);
      this.activeLayerId = layer.id;
      return layer;
    });
  }
  deleteLayer(layerId = this.activeLayerId) {
    const index = this.layers.findIndex(layer => layer.id === layerId);
    if (index < 0) return;
    this._edit('Delete layer', () => {
      this._stampSelection();
      if (this.layers.length === 1) context(this.layers[0].canvas).clearRect(0, 0, this.width, this.height);
      else {
        this.layers.splice(index, 1);
        if (this.activeLayerId === layerId) this.activeLayerId = this.layers[Math.min(index, this.layers.length - 1)].id;
      }
    });
  }
  duplicateLayer(layerId = this.activeLayerId) {
    const index = this.layers.findIndex(layer => layer.id === layerId);
    if (index < 0) return;
    if (this.layers.length >= MAX_LAYERS) throw new RangeError('A document supports up to 64 layers.');
    assertDocumentBudget(this.width, this.height, this.layers.length + 1);
    return this._edit('Duplicate layer', () => {
      this._stampSelection();
      const original = this.layers[index];
      const layer = { ...original, id: id(), name: `${original.name} copy`, canvas: copy(original.canvas) };
      this.layers.splice(index + 1, 0, layer);
      this.activeLayerId = layer.id;
      return layer;
    });
  }
  mergeDown(layerId = this.activeLayerId) {
    const index = this.layers.findIndex(layer => layer.id === layerId);
    if (index <= 0) return;
    this._edit('Merge layers', () => {
      this._stampSelection();
      const below = this.layers[index - 1];
      const above = this.layers[index];
      const canvas = createCanvas(this.width, this.height);
      const ctx = context(canvas);
      for (const layer of [below, above]) if (layer.visible) {
        ctx.globalAlpha = layer.opacity;
        ctx.drawImage(layer.canvas, 0, 0);
      }
      below.canvas = canvas;
      below.opacity = 1;
      below.visible = below.visible || above.visible;
      this.layers.splice(index, 1);
      this.activeLayerId = below.id;
    });
  }
  moveLayer(layerId, delta) {
    const index = this.layers.findIndex(layer => layer.id === layerId);
    if (index < 0 || !Number.isFinite(delta)) return;
    const target = Math.max(0, Math.min(this.layers.length - 1, index + Math.round(delta)));
    if (target === index) return;
    this._edit('Reorder layer', () => this.layers.splice(target, 0, this.layers.splice(index, 1)[0]));
  }
  setLayer(layerId, changes) {
    const layer = this.layers.find(item => item.id === layerId);
    if (!layer) return;
    if (typeof changes.name !== 'string' && typeof changes.visible !== 'boolean' && !Number.isFinite(changes.opacity)) return;
    this._edit('Layer properties', () => {
      if (typeof changes.name === 'string') layer.name = changes.name;
      if (typeof changes.visible === 'boolean') layer.visible = changes.visible;
      if (Number.isFinite(changes.opacity)) layer.opacity = Math.max(0, Math.min(1, changes.opacity));
    });
  }
  selectLayer(layerId) {
    if (!this.layers.some(layer => layer.id === layerId) || this.activeLayerId === layerId) return;
    if (this.selection) this.deselect();
    this.activeLayerId = layerId;
    this._editEpoch++;
    this._changed();
  }
  setBackground(colorOrNull) {
    if (colorOrNull !== null && (typeof colorOrNull !== 'string' || !CSS.supports('color', colorOrNull))) throw new TypeError('Invalid background color.');
    this._edit('Background', () => { this.background = colorOrNull; });
  }

  setResolution(value) {
    const resolution = normalizeResolution(value);
    this._edit('Image resolution', () => { this.resolution = resolution; });
  }

  setSelectionTransparency(enabled, color = this.selectionKeyColor) {
    colorBytes(color);
    this.selectionTransparent = Boolean(enabled);
    this.selectionKeyColor = color;
    this._editEpoch++;
    this._changed();
  }

  _capture(x, y, width, height, polygon, options = {}, providedMask = null) {
    this.assertSelectionSize(width, height);
    const transparent = options.transparent ?? this.selectionTransparent;
    const key = transparent ? colorBytes(options.color ?? this.selectionKeyColor) : null;
    this._stampSelection();
    const canvas = createCanvas(width, height);
    const ctx = context(canvas);
    const source = context(this.activeLayer.canvas);
    const mask = providedMask ?? new Uint8Array(width * height).fill(1);
    if (polygon) {
      ctx.beginPath();
      polygon.forEach((point, index) => ctx[index ? 'lineTo' : 'moveTo'](point.x - x, point.y - y));
      ctx.closePath();
      ctx.fill();
      const raster = ctx.getImageData(0, 0, width, height);
      for (let i = 0; i < mask.length; i++) mask[i] = raster.data[i * 4 + 3] >= 128 ? 1 : 0;
    }
    const pixels = source.getImageData(x, y, width, height);
    const captured = ctx.createImageData(width, height);
    // Geometric ownership remains independent of pixel alpha and color keying.
    // Keyed pixels stay in the source, so selecting and deselecting in place is lossless.
    for (let pixel = 0; pixel < mask.length; pixel++) {
      if (!mask[pixel]) continue;
      const offset = pixel * 4;
      if (key && key.every((value, channel) => value === pixels.data[offset + channel])) continue;
      for (let channel = 0; channel < 4; channel++) {
        captured.data[offset + channel] = pixels.data[offset + channel];
        pixels.data[offset + channel] = 0;
      }
    }
    ctx.putImageData(captured, 0, 0);
    source.putImageData(pixels, x, y);
    this.selection = makeSelection({ canvas, mask, layerId: this.activeLayerId, transform: translation(x, y) });
  }
  selectRect(x, y, width, height, options = {}) {
    if (![x, y, width, height].every(Number.isFinite)) return;
    const x1 = Math.max(0, Math.min(this.width, Math.floor(Math.min(x, x + width))));
    const y1 = Math.max(0, Math.min(this.height, Math.floor(Math.min(y, y + height))));
    const x2 = Math.max(0, Math.min(this.width, Math.ceil(Math.max(x, x + width))));
    const y2 = Math.max(0, Math.min(this.height, Math.ceil(Math.max(y, y + height))));
    if (x2 <= x1 || y2 <= y1) return;
    this.assertSelectionSize(x2 - x1, y2 - y1);
    if (options.transparent ?? this.selectionTransparent) colorBytes(options.color ?? this.selectionKeyColor);
    this._startSelection('Select', () => this._capture(x1, y1, x2 - x1, y2 - y1, null, options));
  }
  selectPolygon(points, options = {}) {
    if (!Array.isArray(points) || points.length < 3) return;
    points = points.map(point => Array.isArray(point) ? { x: point[0], y: point[1] } : point);
    if (!points.every(point => point && Number.isFinite(point.x) && Number.isFinite(point.y))) return;
    let x1 = this.width, y1 = this.height, x2 = 0, y2 = 0;
    for (const point of points) { x1 = Math.min(x1, point.x); y1 = Math.min(y1, point.y); x2 = Math.max(x2, point.x); y2 = Math.max(y2, point.y); }
    x1 = Math.max(0, Math.floor(x1)); y1 = Math.max(0, Math.floor(y1));
    x2 = Math.min(this.width, Math.ceil(x2)); y2 = Math.min(this.height, Math.ceil(y2));
    if (x2 <= x1 || y2 <= y1) return;
    this.assertSelectionSize(x2 - x1, y2 - y1);
    if (options.transparent ?? this.selectionTransparent) colorBytes(options.color ?? this.selectionKeyColor);
    this._startSelection('Free-form select', () => this._capture(x1, y1, x2 - x1, y2 - y1, points, options));
  }
  selectMask(target, mask) {
    if (!this.matchesEditTarget(target) || this.selection || this._transaction) {
      throw new Error('The drawing changed before object selection was applied.');
    }
    if (!(mask instanceof Uint8Array) || mask.length !== this.width * this.height) {
      throw new Error('The object mask does not match this drawing.');
    }
    let left = this.width, top = this.height, right = -1, bottom = -1;
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] !== 0 && mask[i] !== 1) throw new Error('The object mask must contain binary selection values.');
      if (!mask[i]) continue;
      const x = i % this.width, y = Math.floor(i / this.width);
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
    if (right < left) throw new Error('No object was selected. Try another point or box.');
    const width = right - left + 1, height = bottom - top + 1;
    this.assertSelectionSize(width, height);
    const cropped = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      cropped.set(mask.subarray((top + y) * this.width + left, (top + y) * this.width + left + width), y * width);
    }
    this._startSelection('Select object', () => this._capture(left, top, width, height, null, { transparent: false }, cropped));
  }
  invertSelection() {
    if (!this.selection) { this.selectAll(); return; }
    this.assertSelectionSize(this.width, this.height);
    this._edit('Invert selection', () => {
      const selected = this.selection;
      const mask = new Uint8Array(this.width * this.height).fill(1);
      let count = mask.length;
      const inv = inverse(selected.transform);
      for (let y = 0; y < this.height; y++) for (let x = 0; x < this.width; x++) {
        if (ownsDocumentPoint(selected, x+.5, y+.5, inv)) { mask[y*this.width+x] = 0; count--; }
      }
      if (!count) { this._stampSelection(); return; }
      this._capture(0, 0, this.width, this.height, null, { transparent: false }, mask);
    }, { selection: true });
  }
  selectAll() { this.selectRect(0, 0, this.width, this.height); }
  deselect() { this.commitSelection(); }
  deleteSelection() { if (this.selection) this._edit('Delete selection', () => { this.selection = null; }, { selection: true, finishSelection: true }); }
  getSelectionGeometry({ zoom = 1 } = {}) {
    return this.selection ? selectionGeometry(this.selection, zoom) : null;
  }
  hitSelection(point, { zoom = 1 } = {}) {
    return this.selection ? hitSelectionGeometry(this.selection, point, zoom) : null;
  }
  _validateSelectionTransform(selection) {
    inverse(selection.transform);
    const { width, height } = selectionGeometry(selection).bounds;
    const [w, h] = dimensions(width, height);
    const sourcePixels = selection.canvas.width * selection.canvas.height;
    assertDocumentBudget(this.width, this.height, this.layers.length, Math.max(sourcePixels, w*h));
    return selection;
  }
  _setSelectionTransform(transform, label = 'Transform selection') {
    if (!this.selection) return;
    const next = this._validateSelectionTransform(makeSelection({ ...this.selection, transform }));
    if (next.transform.every((value, index) => value === this.selection.transform[index])) return;
    this._edit(label, () => { this.selection = next; }, { selection: true });
  }
  beginSelectionTransform(hit, point) {
    if (!this.selection || !Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite) ||
      !hit || !['move', 'resize', 'rotate'].includes(hit.kind) ||
      (hit.kind === 'resize' && (!Number.isInteger(hit.index) || hit.index < 0 || hit.index > 7))) return false;
    if (this._transaction) return false;
    this.begin('Transform selection');
    this._transaction.selectionGesture = { hit: { ...hit }, start: [...point], source: this.selection };
    return true;
  }
  updateSelectionTransform(point) {
    const gesture = this._transaction?.selectionGesture;
    if (!gesture || !Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)) return;
    this._setSelectionTransform(gestureTransform(gesture.source, gesture.hit, gesture.start, point));
  }
  translateSelection(dx, dy) {
    if (!this.selection || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
    this._setSelectionTransform(multiply(translation(dx, dy), this.selection.transform), 'Move selection');
  }
  moveSelection(x, y) {
    if (!this.selection || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const bounds = this.getSelectionGeometry().bounds;
    this.translateSelection(Math.round(x)-bounds.x, Math.round(y)-bounds.y);
  }
  resizeSelection(width, height, { x, y, source = this.selection } = {}) {
    if (!this.selection || !source) return;
    [width, height] = dimensions(width, height);
    const geometry = selectionGeometry(source), [a, b, c, d, e, f] = source.transform;
    let transform = matrix([a*width/geometry.frameWidth, b*width/geometry.frameWidth,
      c*height/geometry.frameHeight, d*height/geometry.frameHeight, e, f]);
    if (x !== undefined || y !== undefined) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const bounds = selectionGeometry({ ...source, transform }).bounds;
      transform = multiply(translation(Math.round(x)-bounds.x, Math.round(y)-bounds.y), transform);
    }
    this._setSelectionTransform(transform, 'Resize selection');
  }
  selectionCanvas() {
    if (!this.selection) return null;
    this._validateSelectionTransform(this.selection);
    const { x, y, width, height } = this.getSelectionGeometry().bounds;
    const canvas = createCanvas(width, height);
    paintSelection(context(canvas), this.selection, -x, -y);
    return canvas;
  }
  pasteCanvas(canvas) {
    if (!canvas || typeof canvas.getContext !== 'function') throw new TypeError('Paste requires a canvas.');
    this.assertSelectionSize(canvas.width, canvas.height);
    this._startSelection('Paste', () => {
      this._stampSelection();
      this.selection = makeSelection({ canvas: copy(canvas),
        mask: new Uint8Array(canvas.width * canvas.height).fill(1), layerId: this.activeLayerId });
    });
  }

  fill(x, y, color, tolerance = 0) {
    if (![x, y, tolerance].every(Number.isFinite)) return;
    if (typeof color !== 'string' || !CSS.supports('color', color)) throw new TypeError('Invalid fill color.');
    const selected = this.selection;
    const canvas = selected?.canvas ?? this.activeLayer.canvas;
    if (selected) [x, y] = mapPoint(inverse(selected.transform), [x, y]);
    x = Math.floor(x); y = Math.floor(y);
    if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return;
    this._edit('Fill', () => {
      const edited = selected ? copy(canvas) : canvas;
      const ctx = context(edited);
      const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = image.data;
      const swatch = context(createCanvas(1, 1));
      swatch.fillStyle = color; swatch.fillRect(0, 0, 1, 1);
      const replacement = swatch.getImageData(0, 0, 1, 1).data;
      const seed = (y * canvas.width + x) * 4;
      const original = data.slice(seed, seed + 4);
      if (replacement.every((value, index) => value === original[index])) return;
      const limit = Math.max(0, Math.min(255, tolerance));
      const visited = new Uint8Array(canvas.width * canvas.height);
      const matches = pixel => {
        if (visited[pixel] || (selected?.mask && !selected.mask[pixel])) return false;
        const offset = pixel * 4;
        if (Math.abs(data[offset + 3] - original[3]) > limit) return false;
        if (data[offset + 3] === 0 && original[3] === 0) return true;
        return Math.abs(data[offset] - original[0]) <= limit && Math.abs(data[offset + 1] - original[1]) <= limit && Math.abs(data[offset + 2] - original[2]) <= limit;
      };
      const stack = [y * canvas.width + x];
      while (stack.length) {
        const pixel = stack.pop();
        if (!matches(pixel)) continue;
        const rowStart = Math.floor(pixel / canvas.width) * canvas.width;
        let left = pixel, right = pixel;
        while (left > rowStart && matches(left - 1)) left--;
        while (right < rowStart + canvas.width - 1 && matches(right + 1)) right++;
        let aboveSpan = false, belowSpan = false;
        for (let current = left; current <= right; current++) {
          visited[current] = 1;
          data.set(replacement, current * 4);
          const above = current >= canvas.width && matches(current - canvas.width);
          const below = current < canvas.width * (canvas.height - 1) && matches(current + canvas.width);
          if (above && !aboveSpan) stack.push(current - canvas.width);
          if (below && !belowSpan) stack.push(current + canvas.width);
          aboveSpan = above; belowSpan = below;
        }
      }
      ctx.putImageData(image, 0, 0);
      if (selected) this.selection = makeSelection({ ...selected, canvas: edited });
    }, { selection: Boolean(selected) });
  }

  serialize() {
    return { format: PROJECT.format, version: PROJECT.schemaVersion, width: this.width, height: this.height,
      background: this.background, resolution: this.resolution, activeLayerId: this.activeLayerId,
      layers: this.layers.map(layer => {
        let canvas = layer.canvas;
        if (this.selection?.layerId === layer.id) {
          canvas = copy(canvas);
          paintSelection(context(canvas), this.selection);
        }
        return { id: layer.id, name: layer.name, visible: layer.visible, opacity: layer.opacity, png: canvas.toDataURL('image/png') };
      }) };
  }
  _publishLoaded({ width, height, background, resolution, layers, activeLayerId }) {
    this.width = width; this.height = height; this.background = background;
    this.resolution = resolution;
    this.layers = layers; this.activeLayerId = activeLayerId; this.selection = null;
    this._transaction = null; this._selectionSession = null; this._settlement = null;
    this._undo = []; this._redo = []; this._compositeScratch = null;
    this._editEpoch++;
    this._revision = this._savedRevision = this._documentStartRevision = this._nextRevision++;
    this._changed();
  }
  loadRaster(data) {
    if (!data || !Number.isInteger(data.width) || !Number.isInteger(data.height)) throw new Error('Raster dimensions must be integers.');
    const { width, height, background, activeLayerId } = data;
    const resolution = normalizeResolution(data.resolution);
    validateLoadedLayers(data);
    assertDocumentBudget(width, height, data.layers.length);
    const expectedBytes = width * height * 4;
    // Validate every source buffer before allocating canvases or replacing the current document.
    for (const layer of data.layers) {
      if (!(layer.rgba instanceof Uint8Array) || layer.rgba.byteLength !== expectedBytes) throw new Error('Raster layer pixel length does not match the document.');
    }
    const layers = data.layers.map(layer => {
      const canvas = createCanvas(width, height), ctx = context(canvas);
      const pixels = ctx.createImageData(width, height);
      pixels.data.set(layer.rgba);
      ctx.putImageData(pixels, 0, 0);
      return { id: layer.id, name: layer.name, visible: layer.visible, opacity: layer.opacity, canvas };
    });
    this._publishLoaded({ width, height, background, resolution, layers, activeLayerId });
  }
  async load(data) {
    const target = this.captureEditTarget();
    const ensureCurrent = () => {
      if (!this.matchesEditTarget(target)) throw new Error('Open canceled because the drawing changed while the project was decoding.');
    };
    if (!data || !PROJECT.readableFormats.includes(data.format) || data.version !== PROJECT.schemaVersion) throw new Error('Unsupported SJ Paint project format.');
    const [width, height] = dimensions(data.width, data.height);
    const resolution = normalizeResolution(data.resolution);
    validateLoadedLayers(data);
    assertDocumentBudget(width, height, data.layers.length);
    const layers = [];
    let encodedBytes = 0;
    // Check every encoded header before allocating any layer canvas or decoding images.
    for (const layer of data.layers) {
      if (typeof layer.png !== 'string' || !layer.png.startsWith('data:image/png;base64,')) throw new Error('Invalid project layer PNG.');
      encodedBytes += layer.png.length;
      if (encodedBytes > PAINT_LIMITS.maxEncodedProjectBytes) throw new RangeError('Encoded project layers exceed the 64 MiB input limit.');
      checkPngDimensions(layer.png, width, height);
    }
    // Decode sequentially, and publish the new document only after every layer is valid.
    for (const layer of data.layers) {
      const image = await imageFromURL(layer.png);
      ensureCurrent();
      if (image.naturalWidth !== width || image.naturalHeight !== height) throw new Error('Project layer dimensions do not match the document.');
      const canvas = createCanvas(width, height);
      context(canvas).drawImage(image, 0, 0);
      layers.push({ id: layer.id, name: layer.name, visible: layer.visible, opacity: layer.opacity, canvas });
    }
    ensureCurrent();
    this._publishLoaded({ width, height, background: data.background, resolution, layers, activeLayerId: data.activeLayerId });
  }
}
