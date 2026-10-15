import PROJECT from './project-format.json' with { type: 'json' };

export const PAINT_LIMITS = Object.freeze({
  maxDimension: 16384, maxPixels: 32 * 1024 * 1024, maxLayers: 64,
  maxDocumentBytes: 128 * 1024 * 1024, historyBytes: 128 * 1024 * 1024,
  maxEncodedProjectBytes: 64 * 1024 * 1024,
});
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
  return canvas;
}

const context = canvas => canvas.getContext('2d', { willReadFrequently: true });
const id = () => globalThis.crypto?.randomUUID?.() ?? `layer-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const copy = canvas => {
  const result = createCanvas(canvas.width, canvas.height);
  context(result).drawImage(canvas, 0, 0);
  return result;
};
const copySelection = selection => selection ? { ...selection, canvas: copy(selection.canvas), mask: selection.mask?.slice() } : null;
const stateBytes = state => state.layers.reduce((total, layer) => total + layer.canvas.width * layer.canvas.height * 4, 0) +
  (state.selection ? state.selection.canvas.width * state.selection.canvas.height * 4 + (state.selection.mask?.byteLength ?? 0) : 0);

function transformedMask(selection, width, height, inverse) {
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const point = inverse(x + 0.5, y + 0.5);
    const sx = Math.floor(point[0]), sy = Math.floor(point[1]);
    if (sx >= 0 && sy >= 0 && sx < selection.width && sy < selection.height) {
      mask[y * width + x] = selection.mask?.[sy * selection.width + sx] ?? 1;
    }
  }
  return mask;
}

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
      a.activeLayerId !== b.activeLayerId || a.layers.length !== b.layers.length ||
      Boolean(a.selection) !== Boolean(b.selection)) return false;
  if (a.selection) {
    for (const key of ['x', 'y', 'width', 'height', 'layerId']) {
      if (a.selection[key] !== b.selection[key]) return false;
    }
    if (!sameCanvas(a.selection.canvas, b.selection.canvas)) return false;
    const pixels = a.selection.width * a.selection.height;
    for (let i = 0; i < pixels; i++) if ((a.selection.mask?.[i] ?? 1) !== (b.selection.mask?.[i] ?? 1)) return false;
  }
  return a.layers.every((layer, index) => {
    const other = b.layers[index];
    return ['id', 'name', 'visible', 'opacity'].every(key => layer[key] === other[key]) && sameCanvas(layer.canvas, other.canvas);
  });
}

function sameSavedContent(a, b) {
  if (a.width !== b.width || a.height !== b.height || a.background !== b.background || a.layers.length !== b.layers.length) return false;
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
        if (selection) ctx.drawImage(selection.canvas, selection.x, selection.y - y);
      }
      if (!sameCanvas(first, second)) return false;
    }
    return true;
  });
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
  constructor(width = 1152, height = 648) {
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
      selection, selectionCanvas: selection?.canvas, mask: selection?.mask,
      x: selection?.x, y: selection?.y, width: selection?.width, height: selection?.height,
      selectionLayerId: selection?.layerId, transaction: this._transaction });
  }
  matchesEditTarget(target) {
    const current = this.captureEditTarget();
    return Boolean(target) && Object.keys(current).every(key => current[key] === target[key]);
  }

  _changed() { this.dispatchEvent(new Event('change')); }
  _snapshot() {
    return { width: this.width, height: this.height, background: this.background,
      activeLayerId: this.activeLayerId, revision: this._revision,
      layers: this.layers.map(layer => ({ ...layer, canvas: copy(layer.canvas) })),
      selection: copySelection(this.selection) };
  }
  _current() { return { width: this.width, height: this.height, background: this.background,
    activeLayerId: this.activeLayerId, layers: this.layers, selection: this.selection }; }
  _restore(state) {
    this.width = state.width;
    this.height = state.height;
    this.background = state.background;
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

  newDocument(width, height) {
    [this.width, this.height] = assertDocumentBudget(width, height, 1);
    this.background = '#ffffff';
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
        if (preview || (selection && layer.opacity !== 1)) {
          // Composite temporary content within its layer before applying opacity.
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
            if (selection) scratch.drawImage(selection.canvas, selection.x, selection.y);
            if (preview) preview.paint(scratch);
          } finally { scratch.restore(); }
          ctx.drawImage(combined, 0, 0);
        } else {
          ctx.drawImage(layer.canvas, 0, 0);
          if (selection) ctx.drawImage(selection.canvas, selection.x, selection.y);
        }
      }
    } finally { ctx.restore(); }
  }

  _stampSelection() {
    if (!this.selection) return;
    const target = this.layers.find(layer => layer.id === this.selection.layerId);
    if (target) context(target.canvas).drawImage(this.selection.canvas, this.selection.x, this.selection.y);
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
          ctx.drawImage(this.selection.canvas, this.selection.x + offsetX, this.selection.y + offsetY);
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
    if (this.selection && target !== 'document') this.assertSelectionSize(nextWidth, nextHeight);
    else assertDocumentBudget(nextWidth, nextHeight, this.layers.length);
    const selectionTarget = Boolean(this.selection && target !== 'document');
    this._edit('Resize', () => {
      const transform = source => {
        const base = createCanvas(baseWidth, baseHeight);
        if (scale) context(base).drawImage(source, 0, 0, baseWidth, baseHeight);
        else context(base).drawImage(source, 0, 0);
        const canvas = createCanvas(nextWidth, nextHeight);
        const ctx = context(canvas);
        ctx.setTransform(1, sy, sx, 1, sx < 0 ? -sx * baseHeight : 0, sy < 0 ? -sy * baseWidth : 0);
        ctx.drawImage(base, 0, 0);
        return canvas;
      };
      if (this.selection && target !== 'document') {
        const selection = this.selection;
        const mask = transformedMask(selection, nextWidth, nextHeight, (x, y) => {
          x -= sx < 0 ? -sx * baseHeight : 0;
          y -= sy < 0 ? -sy * baseWidth : 0;
          const bx = (x - sx * y) / determinant, by = (y - sy * x) / determinant;
          if (bx < 0 || by < 0 || bx >= baseWidth || by >= baseHeight) return [-1, -1];
          return [scale ? bx * selection.width / baseWidth : bx, scale ? by * selection.height / baseHeight : by];
        });
        this.selection.canvas = transform(this.selection.canvas);
        this.selection.mask = mask;
        this.selection.width = nextWidth;
        this.selection.height = nextHeight;
      } else {
        this._stampSelection();
        for (const layer of this.layers) layer.canvas = transform(layer.canvas);
        this.width = nextWidth;
        this.height = nextHeight;
      }
    }, { selection: selectionTarget });
  }
  crop() {
    if (!this.selection) return;
    assertDocumentBudget(this.selection.width, this.selection.height, this.layers.length);
    this._edit('Crop', () => {
      const selection = this.selection;
      const { x, y, width, height } = selection;
      for (const layer of this.layers) {
        const canvas = createCanvas(width, height);
        const ctx = context(canvas);
        ctx.drawImage(layer.canvas, -x, -y);
        if (selection.layerId === layer.id) ctx.drawImage(selection.canvas, 0, 0);
        layer.canvas = canvas;
      }
      this.selection = null;
      this.width = width;
      this.height = height;
    }, { selection: true, finishSelection: true });
  }
  rotate(degrees) {
    if (!Number.isFinite(Number(degrees))) throw new TypeError('Rotation must be a finite angle.');
    const angle = ((Number(degrees) % 360) + 360) % 360;
    if (!angle) return;
    const radians = angle * Math.PI / 180;
    const rotatedDimensions = source => dimensions(
      Math.ceil(source.width * Math.abs(Math.cos(radians)) + source.height * Math.abs(Math.sin(radians)) - 1e-8),
      Math.ceil(source.width * Math.abs(Math.sin(radians)) + source.height * Math.abs(Math.cos(radians)) - 1e-8));
    const [rotatedWidth, rotatedHeight] = rotatedDimensions(this.selection?.canvas ?? this.layers[0].canvas);
    if (this.selection) this.assertSelectionSize(rotatedWidth, rotatedHeight);
    else assertDocumentBudget(rotatedWidth, rotatedHeight, this.layers.length);
    const transform = source => {
      const [w, h] = rotatedDimensions(source);
      const canvas = createCanvas(w, h);
      const ctx = context(canvas);
      ctx.translate(w / 2, h / 2);
      ctx.rotate(radians);
      ctx.drawImage(source, -source.width / 2, -source.height / 2);
      return canvas;
    };
    const selectionTarget = Boolean(this.selection);
    this._edit('Rotate', () => {
      if (this.selection) {
        const { width, height } = this.selection;
        const mask = transformedMask(this.selection, rotatedWidth, rotatedHeight, (x, y) => {
          const dx = x - rotatedWidth / 2, dy = y - rotatedHeight / 2;
          return [dx * Math.cos(radians) + dy * Math.sin(radians) + width / 2,
            -dx * Math.sin(radians) + dy * Math.cos(radians) + height / 2];
        });
        this.selection.canvas = transform(this.selection.canvas);
        this.selection.mask = mask;
        this.selection.width = this.selection.canvas.width;
        this.selection.height = this.selection.canvas.height;
        this.selection.x += Math.round((width - this.selection.width) / 2);
        this.selection.y += Math.round((height - this.selection.height) / 2);
      } else {
        for (const layer of this.layers) layer.canvas = transform(layer.canvas);
        this.width = this.layers[0].canvas.width;
        this.height = this.layers[0].canvas.height;
      }
    }, { selection: selectionTarget });
  }
  flip(horizontal = true) {
    const selectionTarget = Boolean(this.selection);
    this._edit('Flip', () => {
      const flipCanvas = source => {
        const canvas = createCanvas(source.width, source.height);
        const ctx = context(canvas);
        ctx.translate(horizontal ? source.width : 0, horizontal ? 0 : source.height);
        ctx.scale(horizontal ? -1 : 1, horizontal ? 1 : -1);
        ctx.drawImage(source, 0, 0);
        return canvas;
      };
      if (this.selection) {
        const selection = this.selection;
        selection.mask = transformedMask(selection, selection.width, selection.height,
          (x, y) => [horizontal ? selection.width - x : x, horizontal ? y : selection.height - y]);
        selection.canvas = flipCanvas(selection.canvas);
      }
      else for (const layer of this.layers) layer.canvas = flipCanvas(layer.canvas);
    }, { selection: selectionTarget });
  }
  clear() {
    if (this.selection) { this.deleteSelection(); return; }
    this._edit('Clear', () => {
      context(this.activeLayer.canvas).clearRect(0, 0, this.width, this.height);
    });
  }

  invertColors() {
    const selectionTarget = Boolean(this.selection);
    this._edit('Invert colors', () => {
      const ctx = context(this.selection?.canvas ?? this.activeLayer.canvas);
      const image = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
      for (let i = 0; i < image.data.length; i += 4) {
        if (!image.data[i + 3]) continue;
        image.data[i] = 255 - image.data[i];
        image.data[i + 1] = 255 - image.data[i + 1];
        image.data[i + 2] = 255 - image.data[i + 2];
      }
      ctx.putImageData(image, 0, 0);
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
    this.selection = { x, y, width, height, canvas, mask, layerId: this.activeLayerId };
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
  invertSelection() {
    if (!this.selection) { this.selectAll(); return; }
    this.assertSelectionSize(this.width, this.height);
    this._edit('Invert selection', () => {
      const selected = this.selection;
      const mask = new Uint8Array(this.width * this.height).fill(1);
      let count = mask.length;
      for (let y = 0; y < selected.height; y++) for (let x = 0; x < selected.width; x++) {
        if (!(selected.mask?.[y * selected.width + x] ?? 1)) continue;
        const dx = selected.x + x, dy = selected.y + y;
        if (dx >= 0 && dy >= 0 && dx < this.width && dy < this.height) { mask[dy * this.width + dx] = 0; count--; }
      }
      if (!count) { this._stampSelection(); return; }
      this._capture(0, 0, this.width, this.height, null, { transparent: false }, mask);
    }, { selection: true });
  }
  selectAll() { this.selectRect(0, 0, this.width, this.height); }
  deselect() { this.commitSelection(); }
  deleteSelection() { if (this.selection) this._edit('Delete selection', () => { this.selection = null; }, { selection: true, finishSelection: true }); }
  moveSelection(x, y) {
    if (!this.selection || !Number.isFinite(x) || !Number.isFinite(y)) return;
    this._edit('Move selection', () => { this.selection.x = Math.round(x); this.selection.y = Math.round(y); }, { selection: true });
  }
  resizeSelection(width, height, { x = this.selection?.x, y = this.selection?.y, source = this.selection } = {}) {
    if (!this.selection || !source || !Number.isFinite(x) || !Number.isFinite(y)) return;
    [width, height] = this.assertSelectionSize(width, height);
    this._edit('Resize selection', () => {
      const canvas = createCanvas(width, height);
      context(canvas).drawImage(source.canvas, 0, 0, width, height);
      const mask = transformedMask(source, width, height, (px, py) => [px * source.width / width, py * source.height / height]);
      Object.assign(this.selection, { x: Math.round(x), y: Math.round(y), width, height, canvas, mask });
    }, { selection: true });
  }
  pasteCanvas(canvas) {
    if (!canvas || typeof canvas.getContext !== 'function') throw new TypeError('Paste requires a canvas.');
    this.assertSelectionSize(canvas.width, canvas.height);
    this._startSelection('Paste', () => {
      this._stampSelection();
      this.selection = { x: 0, y: 0, width: canvas.width, height: canvas.height, canvas: copy(canvas),
        mask: new Uint8Array(canvas.width * canvas.height).fill(1), layerId: this.activeLayerId };
    });
  }

  fill(x, y, color, tolerance = 0) {
    if (![x, y, tolerance].every(Number.isFinite)) return;
    if (typeof color !== 'string' || !CSS.supports('color', color)) throw new TypeError('Invalid fill color.');
    const selected = this.selection;
    const canvas = selected?.canvas ?? this.activeLayer.canvas;
    x = Math.floor(x - (selected?.x ?? 0)); y = Math.floor(y - (selected?.y ?? 0));
    if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return;
    this._edit('Fill', () => {
      const ctx = context(canvas);
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
    }, { selection: Boolean(selected) });
  }

  serialize() {
    return { format: PROJECT.format, version: PROJECT.schemaVersion, width: this.width, height: this.height,
      background: this.background, activeLayerId: this.activeLayerId,
      layers: this.layers.map(layer => {
        let canvas = layer.canvas;
        if (this.selection?.layerId === layer.id) {
          canvas = copy(canvas);
          context(canvas).drawImage(this.selection.canvas, this.selection.x, this.selection.y);
        }
        return { id: layer.id, name: layer.name, visible: layer.visible, opacity: layer.opacity, png: canvas.toDataURL('image/png') };
      }) };
  }
  async load(data) {
    if (!data || !PROJECT.readableFormats.includes(data.format) || data.version !== PROJECT.schemaVersion) throw new Error('Unsupported SJ Paint project format.');
    const [width, height] = dimensions(data.width, data.height);
    if (!Array.isArray(data.layers) || !data.layers.length || data.layers.length > MAX_LAYERS) throw new Error('A project must contain between 1 and 64 layers.');
    assertDocumentBudget(width, height, data.layers.length);
    if (data.background !== null && (typeof data.background !== 'string' || !CSS.supports('color', data.background))) throw new Error('Invalid project background.');
    const ids = new Set();
    const layers = [];
    let encodedBytes = 0;
    // Check every encoded header before allocating any layer canvas or decoding images.
    for (const layer of data.layers) {
      if (typeof layer?.png !== 'string' || !layer.png.startsWith('data:image/png;base64,')) throw new Error('Invalid project layer PNG.');
      encodedBytes += layer.png.length;
      if (encodedBytes > PAINT_LIMITS.maxEncodedProjectBytes) throw new RangeError('Encoded project layers exceed the 64 MiB input limit.');
      checkPngDimensions(layer.png, width, height);
    }
    // Decode sequentially, and publish the new document only after every layer is valid.
    for (const layer of data.layers) {
      if (!layer || typeof layer.id !== 'string' || !layer.id || ids.has(layer.id) || typeof layer.name !== 'string' ||
          typeof layer.visible !== 'boolean' || !Number.isFinite(layer.opacity) || layer.opacity < 0 || layer.opacity > 1 ||
          typeof layer.png !== 'string' || !layer.png.startsWith('data:image/png;base64,')) throw new Error('Invalid project layer.');
      ids.add(layer.id);
      const image = await imageFromURL(layer.png);
      if (image.naturalWidth !== width || image.naturalHeight !== height) throw new Error('Project layer dimensions do not match the document.');
      const canvas = createCanvas(width, height);
      context(canvas).drawImage(image, 0, 0);
      layers.push({ id: layer.id, name: layer.name, visible: layer.visible, opacity: layer.opacity, canvas });
    }
    if (!ids.has(data.activeLayerId)) throw new Error('The project active layer is missing.');
    this.width = width; this.height = height; this.background = data.background;
    this.layers = layers; this.activeLayerId = data.activeLayerId; this.selection = null;
    this._transaction = null; this._selectionSession = null; this._undo = []; this._redo = []; this._compositeScratch = null;
    this._editEpoch++;
    this._revision = this._savedRevision = this._documentStartRevision = this._nextRevision++;
    this._changed();
  }
}
