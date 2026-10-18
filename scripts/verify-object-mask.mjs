// Producer coverage for binary model masks. UI/model inference lives in separate checks.
export async function verifyObjectMask(page, check) {
  const results = await page.evaluate(async () => {
    const { PaintDocument } = await import('/src/engine.js');
    const results = [];
    const record = (name, ok, detail) => results.push({ name, ok, detail });
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const pixels = canvas => [...canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data];
    const state = d => JSON.stringify({ saved: d.serialize(), pixels: d.layers.map(l => pixels(l.canvas)),
      revision: d.revision, dirty: d.dirty, undo: d._undo.length, redo: d._redo.length,
      selection: d.selection && { mask: [...d.selection.mask], transform: d.selection.transform, pixels: pixels(d.selection.canvas) },
      transaction: Boolean(d._transaction) });
    const fixture = () => {
      const d = new PaintDocument(8, 6);
      d.setBackground(null);
      d.begin('Lower fixture');
      const lower = d.activeLayer.canvas.getContext('2d');
      lower.fillStyle = '#2468ac'; lower.fillRect(0, 0, 8, 6); d.commit();
      d.setLayer(d.activeLayerId, { name: 'Lower', opacity: .25 });
      d.addLayer('Original source');
      d.begin('Source fixture');
      const ctx = d.activeLayer.canvas.getContext('2d');
      const data = ctx.createImageData(8, 6);
      data.data.set([255, 255, 255, 255], (1 * 8 + 2) * 4);
      data.data.set([181, 73, 31, 127], (1 * 8 + 3) * 4);
      data.data.set([18, 52, 86, 255], (2 * 8 + 3) * 4); // Unselected hole.
      data.data.set([4, 128, 250, 255], (3 * 8 + 4) * 4);
      ctx.putImageData(data, 0, 0); d.commit();
      d.setLayer(d.activeLayerId, { opacity: .7 });
      d.setSelectionTransparency(true, '#ffffff'); d.markSaved();
      return d;
    };
    const maskFor = () => { const mask = new Uint8Array(48); for (const i of [10, 11, 20, 28]) mask[i] = 1; return mask; };
    for (const [label, mask] of [['empty', new Uint8Array(48)], ['wrong length', new Uint8Array(47)],
      ['wrong type', new Uint8ClampedArray(48)], ['nonbinary', Object.assign(maskFor(), { 47: 255 })]]) {
      const d = fixture(), before = state(d); let rejected = false;
      try { d.selectMask(d.captureEditTarget(), mask); } catch { rejected = true; }
      record(`object mask rejects ${label} before any mutation`, rejected && state(d) === before);
    }
    const staleMutations = {
      'foreign document': d => new PaintDocument(8, 6).captureEditTarget(),
      'canceled edit epoch': d => { const target = d.captureEditTarget(); d.begin('Canceled'); d.cancel(); return target; },
      'active layer': d => { const target = d.captureEditTarget(); d.selectLayer(d.layers[0].id); return target; },
      'pending transaction': d => { d.begin('Pending'); return d.captureEditTarget(); },
      'existing selection': d => { d.selectRect(0, 0, 1, 1); return d.captureEditTarget(); },
      'edit then Undo': d => { const target = d.captureEditTarget(); d.setBackground('#112233'); d.undo(); return target; },
    };
    for (const [label, mutate] of Object.entries(staleMutations)) {
      const d = fixture(), target = mutate(d), before = state(d); let rejected = false;
      try { d.selectMask(target, maskFor()); } catch { rejected = true; }
      record(`object mask rejects ${label} without altering newer state`, rejected && state(d) === before);
    }
    const d = fixture(), before = state(d), source = pixels(d.activeLayer.canvas), lower = pixels(d.layers[0].canvas);
    const mask = maskFor(), undo = d._undo.length;
    d.selectMask(d.captureEditTarget(), mask);
    const s = d.selection, crop = pixels(s.canvas), cut = pixels(d.activeLayer.canvas);
    record('object mask crops to its exact nonzero bounds and retains holes', s.x === 2 && s.y === 1 &&
      s.canvas.width === 3 && s.canvas.height === 3 && same([...s.mask], [1, 1, 0, 0, 0, 1, 0, 0, 1]),
    { x: s.x, y: s.y, width: s.canvas.width, height: s.canvas.height, mask: [...s.mask] });
    let ownedExact = true;
    for (let y = 0; y < 6; y++) for (let x = 0; x < 8; x++) {
      const index = y * 8 + x, rgba = source.slice(index * 4, index * 4 + 4);
      if (mask[index]) {
        const offset = ((y - 1) * 3 + x - 2) * 4;
        ownedExact &&= same(crop.slice(offset, offset + 4), rgba) && same(cut.slice(index * 4, index * 4 + 4), [0, 0, 0, 0]);
      } else ownedExact &&= same(cut.slice(index * 4, index * 4 + 4), rgba);
    }
    record('object mask owns original RGBA including partial alpha, transparent geometry and white key color', ownedExact);
    record('object mask leaves lower layer and layer opacity unchanged', same(pixels(d.layers[0].canvas), lower) && d.activeLayer.opacity === .7);
    mask.fill(0);
    record('object mask takes independent ownership of its cropped binary mask', same([...s.mask], [1, 1, 0, 0, 0, 1, 0, 0, 1]));
    record('object mask selection alone leaves saved revision and history unchanged', !d.dirty && d._undo.length === undo);
    d.cancelSelection(); record('object mask cancellation restores exact original layers and history', state(d) === before);
    d.selectMask(d.captureEditTarget(), maskFor()); d.commitSelection();
    record('object mask unchanged commit restores exact original content without an Undo entry', state(d) === before);
    d.selectMask(d.captureEditTarget(), maskFor()); d.moveSelection(5, 1); d.commitSelection();
    const moved = state(d), movedPixels = pixels(d.activeLayer.canvas);
    record('object mask moved commit creates exactly one content Undo entry', d._undo.length === undo + 1 && d.dirty);
    record('object mask move retains its unselected source hole', same(movedPixels.slice(19 * 4, 20 * 4), source.slice(19 * 4, 20 * 4)));
    d.undo(); record('object mask move Undo restores original source pixels and saved revision', same(pixels(d.activeLayer.canvas), source) && !d.dirty);
    d.redo(); record('object mask move Redo restores exact committed state', state(d) === moved);
    const deleted = fixture(), deleteBefore = pixels(deleted.activeLayer.canvas), deleteUndo = deleted._undo.length;
    deleted.selectMask(deleted.captureEditTarget(), maskFor()); deleted.deleteSelection();
    const deleteAfter = pixels(deleted.activeLayer.canvas);
    record('object mask Delete commits one history entry and preserves its unselected hole', deleted._undo.length === deleteUndo + 1 &&
      !deleted.selection && same(deleteAfter.slice(19 * 4, 20 * 4), deleteBefore.slice(19 * 4, 20 * 4)));
    deleted.undo(); record('object mask Delete Undo restores original source pixels', same(pixels(deleted.activeLayer.canvas), deleteBefore));
    deleted.redo(); record('object mask Delete Redo restores exact result', same(pixels(deleted.activeLayer.canvas), deleteAfter));
    const pendingRedo = fixture(); pendingRedo.setBackground('#abcdef'); pendingRedo.undo();
    const redoBefore = state(pendingRedo); pendingRedo.selectMask(pendingRedo.captureEditTarget(), maskFor()); pendingRedo.cancelSelection();
    record('object mask cancel preserves an existing Redo branch', state(pendingRedo) === redoBefore && pendingRedo.canRedo);
    return results;
  });
  for (const { name, ok, detail } of results) check(name, ok, detail);
}
