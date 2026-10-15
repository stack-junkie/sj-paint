/** Exercise document boundary changes independently of pointer geometry. */
export async function verifyCanvasEngine(page, check) {
  const results = await page.evaluate(async () => {
    const { PaintDocument } = await import('/src/engine.js');
    const results = [];
    const record = (name, ok, detail = null) => results.push({ name, ok, detail });
    const pixel = (canvas, x, y) => [...canvas.getContext('2d').getImageData(x, y, 1, 1).data];
    const equals = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const metadata = d => ({ background: d.background, activeLayerId: d.activeLayerId,
      layers: d.layers.map(({ id, name, visible, opacity }) => ({ id, name, visible, opacity })) });
    const state = d => JSON.stringify({ project: d.serialize(), metadata: metadata(d),
      selection: d.selection && { ...d.selection, canvas: d.selection.canvas.toDataURL(), mask: [...d.selection.mask] },
      revision: d.revision, dirty: d.dirty, undo: d._undo.length, redo: d._redo.length });
    const fixture = () => {
      const d = new PaintDocument(6, 5);
      d.setBackground('#f0e0d0');
      d.begin('Boundary fixture');
      const first = d.activeLayer.canvas.getContext('2d');
      first.fillStyle = '#ff0000'; first.fillRect(0, 0, 1, 1);
      first.fillStyle = '#00ff00'; first.fillRect(5, 4, 1, 1);
      d.commit();
      d.setLayer(d.activeLayerId, { name: 'Hidden base', visible: false, opacity: 0.25 });
      d.addLayer('Visible upper');
      d.begin('Upper fixture');
      const second = d.activeLayer.canvas.getContext('2d');
      second.fillStyle = '#0000ff'; second.fillRect(2, 2, 1, 1);
      d.commit();
      d.setLayer(d.activeLayerId, { opacity: 0.5 });
      d.markSaved();
      return d;
    };

    const d = fixture();
    const originalProject = JSON.stringify(d.serialize()), originalMetadata = metadata(d);
    const undoBefore = d._undo.length;
    d.resizeCanvas(9, 7, { offsetX: 3, offsetY: 2 });
    const grownProject = JSON.stringify(d.serialize());
    const growthPixels = [pixel(d.layers[0].canvas, 3, 2), pixel(d.layers[0].canvas, 8, 6),
      pixel(d.layers[1].canvas, 5, 4), pixel(d.layers[0].canvas, 0, 0)];
    record('northwest growth translates all layer pixels without scaling', d.width === 9 && d.height === 7 &&
      equals(growthPixels, [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [0, 0, 0, 0]]), growthPixels);
    record('canvas resize preserves background and layer metadata', equals(metadata(d), originalMetadata), metadata(d));
    record('canvas resize creates one undo entry and marks changed content dirty', d._undo.length === undoBefore + 1 && d.dirty);
    d.undo();
    record('canvas resize undo restores exact saved layers and dimensions', JSON.stringify(d.serialize()) === originalProject && !d.dirty);
    d.redo();
    record('canvas resize redo restores exact translated layers', JSON.stringify(d.serialize()) === grownProject && d.dirty);
    d.resizeCanvas(6, 5, { offsetX: -3, offsetY: -2 });
    record('northwest shrink back to original boundary preserves every original pixel', JSON.stringify(d.serialize()) === originalProject);
    d.resizeCanvas(4, 3);
    const croppedPixels = [pixel(d.layers[0].canvas, 0, 0), pixel(d.layers[1].canvas, 2, 2)];
    record('southeast shrink clips far edges while retaining unscaled interior pixels', d.width === 4 && d.height === 3 &&
      equals(croppedPixels, [[255, 0, 0, 255], [0, 0, 255, 255]]) && equals(metadata(d), originalMetadata), croppedPixels);
    d.undo();
    record('undo recovers pixels clipped by canvas shrink', JSON.stringify(d.serialize()) === originalProject &&
      equals(pixel(d.layers[0].canvas, 5, 4), [0, 255, 0, 255]));

    const selected = fixture();
    selected.selectRect(2, 2, 1, 1);
    selected.moveSelection(3, 2);
    const selectedBefore = state(selected), selectedUndo = selected._undo.length;
    selected.resizeCanvas(8, 6, { offsetX: 2, offsetY: 1 });
    const stamped = [pixel(selected.activeLayer.canvas, 5, 3), pixel(selected.activeLayer.canvas, 4, 3)];
    record('canvas boundary resize stamps floating pixels without resizing the selection', !selected.selection &&
      selected.width === 8 && selected.height === 6 && equals(stamped, [[0, 0, 255, 255], [0, 0, 0, 0]]) &&
      selected._undo.length === selectedUndo + 1, stamped);
    selected.undo();
    // Undo adds a redo entry, so compare document and selection separately from stack lengths.
    const selectionRestored = JSON.parse(state(selected)), expectedSelection = JSON.parse(selectedBefore);
    record('canvas resize undo restores floating selection ownership and raster',
      equals(selectionRestored.project, expectedSelection.project) && equals(selectionRestored.selection, expectedSelection.selection) &&
      selectionRestored.revision === expectedSelection.revision && selectionRestored.dirty === expectedSelection.dirty);
    selected.redo();
    record('canvas resize redo stamps selection exactly once', !selected.selection &&
      equals(pixel(selected.activeLayer.canvas, 5, 3), [0, 0, 255, 255]) &&
      equals(pixel(selected.activeLayer.canvas, 4, 3), [0, 0, 0, 0]));

    const idle = fixture();
    idle.selectRect(2, 2, 1, 1);
    idle.moveSelection(3, 2);
    idle.undo();
    const idleBefore = state(idle), selectionIdentity = idle.selection, layersIdentity = idle.layers;
    const undoIdentity = idle._undo, redoIdentity = idle._redo;
    const originalCreateElement = document.createElement;
    let allocations = 0;
    document.createElement = function (name, ...args) {
      if (String(name).toLowerCase() === 'canvas') allocations++;
      return originalCreateElement.call(this, name, ...args);
    };
    try { idle.resizeCanvas(6, 5); } finally { document.createElement = originalCreateElement; }
    record('unchanged canvas boundary preserves selection, saved state, redo, and object identity without allocation',
      state(idle) === idleBefore && !idle.dirty && idle.selection === selectionIdentity && idle.layers === layersIdentity &&
      idle._undo === undoIdentity && idle._redo === redoIdentity && idle.canRedo && allocations === 0, { allocations });

    const invalidCases = [
      ['zero width', 0, 5, {}], ['infinite height', 6, Infinity, {}],
      ['dimension limit', 16385, 5, {}], ['combined layer budget', 6000, 4000, {}],
      ['fractional offset', 8, 6, { offsetX: 0.5 }], ['infinite offset', 8, 6, { offsetY: Infinity }],
      ['unsafe offset', 8, 6, { offsetX: Number.MAX_SAFE_INTEGER + 1 }],
    ];
    const rejected = [];
    for (const [name, width, height, options] of invalidCases) {
      const before = state(idle);
      allocations = 0;
      document.createElement = function (tag, ...args) {
        if (String(tag).toLowerCase() === 'canvas') allocations++;
        return originalCreateElement.call(this, tag, ...args);
      };
      let error;
      try { idle.resizeCanvas(width, height, options); } catch (caught) { error = caught; }
      finally { document.createElement = originalCreateElement; }
      rejected.push({ name, rangeError: error instanceof RangeError, allocations, unchanged: state(idle) === before,
        sameSelection: idle.selection === selectionIdentity, sameHistory: idle._undo === undoIdentity && idle._redo === redoIdentity });
    }
    record('invalid canvas bounds and offsets fail before allocation without changing document or history',
      rejected.every(result => result.rangeError && result.allocations === 0 && result.unchanged && result.sameSelection && result.sameHistory), rejected);

    const failed = fixture();
    failed.selectRect(2, 2, 1, 1);
    const beforeFailure = state(failed);
    const originalDrawImage = CanvasRenderingContext2D.prototype.drawImage;
    let replacementsDrawn = 0, caughtFailure = false;
    CanvasRenderingContext2D.prototype.drawImage = function (...args) {
      if (this.canvas.width === 9 && this.canvas.height === 7 && ++replacementsDrawn === 2) throw new Error('Injected surface failure');
      return originalDrawImage.apply(this, args);
    };
    try { failed.resizeCanvas(9, 7, { offsetX: 3, offsetY: 2 }); }
    catch (error) { caughtFailure = error.message === 'Injected surface failure'; }
    finally { CanvasRenderingContext2D.prototype.drawImage = originalDrawImage; }
    record('failed canvas surface construction restores layers, selection, revision, and history',
      caughtFailure && replacementsDrawn === 2 && state(failed) === beforeFailure && failed._transaction === null,
      { caughtFailure, replacementsDrawn });
    return results;
  });
  for (const result of results) check(result.name, result.ok, result.detail);
}
