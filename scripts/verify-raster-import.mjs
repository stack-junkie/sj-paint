/** Atomic format-neutral raster import and asynchronous project ownership. */
export async function verifyRasterImport(page, check) {
  const results = await page.evaluate(async () => {
    const { PaintDocument } = await import('/src/engine.js');
    const results = [], record = (name, ok, detail = null) => results.push({ name, ok, detail });
    const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const pixel = (canvas, x, y) => [...canvas.getContext('2d').getImageData(x, y, 1, 1).data];
    const input = () => ({ width: 3, height: 2, background: '#12345680', activeLayerId: 'upper', layers: [
      { id: 'lower', name: 'Bottom', visible: true, opacity: 1, rgba: Uint8Array.from([255,0,0,255, 0,255,0,255, 0,0,255,255, 0,0,0,0, 255,255,255,255, 0,0,0,255]) },
      { id: 'upper', name: 'Top \u2603', visible: false, opacity: .25, rgba: Uint8Array.from([0,0,0,0, 255,0,0,128, 0,255,0,128, 0,0,255,128, 255,255,255,255, 0,0,0,255]) },
    ] });
    const fixture = () => {
      const d = new PaintDocument(16, 12); d.begin('Ink');
      d.activeLayer.canvas.getContext('2d').fillRect(2, 2, 4, 4); d.commit(); d.markSaved();
      d.setBackground(null); d.undo(); d.selectRect(2, 2, 4, 4); d.moveSelection(6, 3); d.begin('Held gesture');
      return d;
    };
    const snapshot = d => JSON.stringify({ project: d.serialize(), selection: d.selection && { ...d.selection,
      canvas: d.selection.canvas.toDataURL(), mask: [...d.selection.mask] }, revision: d.revision, dirty: d.dirty,
      undo: d._undo.length, redo: d._redo.length, session: d.hasSelectionSession, transaction: Boolean(d._transaction) });

    const loaded = fixture(), data = input(), oldTarget = loaded.captureEditTarget();
    let changes = 0; loaded.addEventListener('change', () => changes++);
    loaded.loadRaster(data);
    record('raster import preserves layer metadata, active layer, dimensions and alpha background', loaded.width === 3 && loaded.height === 2 &&
      loaded.background === '#12345680' && loaded.activeLayerId === 'upper' && equal(loaded.layers.map(({ id, name, visible, opacity }) => ({ id, name, visible, opacity })),
        data.layers.map(({ id, name, visible, opacity }) => ({ id, name, visible, opacity }))));
    record('raster import copies RGBA channels and pixel alpha into separate layers', equal(pixel(loaded.layers[0].canvas, 0, 0), [255,0,0,255]) &&
      equal(pixel(loaded.layers[0].canvas, 2, 0), [0,0,255,255]) && equal(pixel(loaded.layers[1].canvas, 1, 0), [255,0,0,128]) &&
      equal(pixel(loaded.layers[1].canvas, 0, 1), [0,0,255,128]));
    data.layers[0].rgba.fill(0); data.layers[1].rgba.fill(0);
    record('imported canvases do not alias caller-owned RGBA buffers', equal(pixel(loaded.layers[0].canvas, 0, 0), [255,0,0,255]) &&
      equal(pixel(loaded.layers[1].canvas, 1, 0), [255,0,0,128]));
    record('successful raster import publishes once and resets saved state, histories, selection and short gesture', changes === 1 && !loaded.dirty &&
      !loaded.selection && !loaded.hasSelectionSession && !loaded._transaction && !loaded.canUndo && !loaded.canRedo && !loaded.matchesEditTarget(oldTarget));
    const transparent = input(); transparent.background = null; loaded.loadRaster(transparent);
    record('raster import supports an explicitly transparent document background', loaded.background === null);
    const serialized = loaded.serialize(), clone = new PaintDocument(1, 1); await clone.load(serialized);
    record('existing PNG project load retains compatibility with raster-imported documents', equal(clone.serialize(), serialized) && !clone.dirty);

    const guarded = fixture(), before = snapshot(guarded), owner = guarded.captureEditTarget();
    const undo = guarded._undo, redo = guarded._redo, session = guarded._selectionSession, transaction = guarded._transaction;
    const malformed = [
      ['second pixel buffer', d => { d.layers[1].rgba = new Uint8Array(23); }],
      ['second buffer type', d => { d.layers[1].rgba = [...d.layers[1].rgba]; }],
      ['duplicate ID', d => { d.layers[1].id = d.layers[0].id; }],
      ['second opacity', d => { d.layers[1].opacity = Infinity; }],
      ['second visibility', d => { d.layers[1].visible = 1; }],
      ['second name', d => { d.layers[1].name = null; }],
      ['active layer', d => { d.activeLayerId = 'missing'; }],
      ['background', d => { d.background = 'not-a-color'; }],
      ['fractional dimensions', d => { d.width = 3.5; }],
      ['zero dimensions', d => { d.width = 0; }],
      ['aggregate budget', d => { d.width = 8192; d.height = 4096; }],
      ['layer limit', d => { d.layers = Array.from({ length: 65 }, (_, i) => ({ ...d.layers[0], id: String(i) })); }],
    ];
    const originalCreateElement = document.createElement, rejected = [];
    for (const [name, mutate] of malformed) {
      const bad = input(); mutate(bad); let allocations = 0, caught = false;
      document.createElement = function (tag, ...args) {
        if (String(tag).toLowerCase() === 'canvas') allocations++;
        return originalCreateElement.call(this, tag, ...args);
      };
      try { guarded.loadRaster(bad); } catch { caught = true; }
      finally { document.createElement = originalCreateElement; }
      rejected.push({ name, ok: caught && allocations === 0 && snapshot(guarded) === before && guarded.matchesEditTarget(owner) &&
        guarded._undo === undo && guarded._redo === redo && guarded._selectionSession === session && guarded._transaction === transaction, allocations });
    }
    record('all raster inputs and every layer validate before allocation or mutation', rejected.every(r => r.ok), rejected);
    let allocations = 0, allocationFailed = false;
    document.createElement = function (tag, ...args) {
      if (String(tag).toLowerCase() === 'canvas' && ++allocations === 2) throw new Error('Injected second canvas allocation failure');
      return originalCreateElement.call(this, tag, ...args);
    };
    try { guarded.loadRaster(input()); } catch (error) { allocationFailed = error.message === 'Injected second canvas allocation failure'; }
    finally { document.createElement = originalCreateElement; }
    record('second-layer allocation failure leaves the old document, histories and pending session untouched', allocationFailed && allocations === 2 &&
      snapshot(guarded) === before && guarded.matchesEditTarget(owner) && guarded._undo === undo && guarded._redo === redo && guarded._selectionSession === session && guarded._transaction === transaction);
    const originalPut = CanvasRenderingContext2D.prototype.putImageData;
    let writes = 0, pixelFailed = false;
    CanvasRenderingContext2D.prototype.putImageData = function (...args) {
      if (++writes === 2) throw new Error('Injected second raster copy failure');
      return originalPut.apply(this, args);
    };
    try { guarded.loadRaster(input()); } catch (error) { pixelFailed = error.message === 'Injected second raster copy failure'; }
    finally { CanvasRenderingContext2D.prototype.putImageData = originalPut; }
    record('second-layer pixel-copy failure publishes no partial document', pixelFailed && snapshot(guarded) === before && guarded.matchesEditTarget(owner));

    const raceSource = new PaintDocument(3, 2); raceSource.begin('Imported pixel'); raceSource.activeLayer.canvas.getContext('2d').fillRect(0, 0, 1, 1); raceSource.commit();
    const project = raceSource.serialize(), races = [];
    for (const change of ['edit', 'replacement', 'cancelled gesture']) {
      const target = new PaintDocument(8, 6), NativeImage = window.Image;
      let release;
      window.Image = function () {
        const image = new NativeImage();
        Object.defineProperty(image, 'src', { configurable: true, set(value) { release = () => { delete image.src; image.src = value; }; } });
        return image;
      };
      let pending;
      try { pending = target.load(project); }
      finally { window.Image = NativeImage; }
      if (change === 'edit') target.setBackground('#ff0000');
      else if (change === 'replacement') target.newDocument(7, 5);
      else { target.begin('Intervening pointer'); target.cancel(); }
      const expected = snapshot(target), expectedOwner = target.captureEditTarget();
      let cancelled = false;
      release();
      try { await pending; } catch (error) { cancelled = /Open canceled because the drawing changed/.test(error.message); }
      races.push({ change, ok: cancelled && snapshot(target) === expected && target.matchesEditTarget(expectedOwner) });
    }
    record('deferred PNG decoding cannot overwrite edits, replacement documents or intervening cancelled gestures', races.every(r => r.ok), races);
    return results;
  });
  for (const result of results) check(result.name, result.ok, result.detail);
}
