/** Compare temporary layer rendering with the same content committed to the document. */
export async function verifyLayerPreview(page, check) {
  const results = await page.evaluate(async () => {
    const { PaintDocument, createCanvas } = await import('/src/engine.js');
    const { createPendingShape, paintPendingShape } = await import('/src/pending-shape.js');
    const results = [];
    const record = (name, ok, detail = null) => results.push({ name, ok, detail });
    const pending = createPendingShape('rectangle', [4, 4], [14, 14], {
      fill: '#00ff00', fillStyle: 'solid', outline: 'none', opacity: 0.5,
    });
    const paint = ctx => paintPendingShape(ctx, pending);
    const fixture = (background = null, opacity = 0.5, selection = false) => {
      const d = new PaintDocument(20, 16), lower = d.activeLayerId;
      d.setBackground(background);
      d.begin('Lower artwork');
      const ctx = d.activeLayer.canvas.getContext('2d');
      ctx.fillStyle = '#ff0000'; ctx.fillRect(2, 2, 10, 10);
      d.commit();
      d.setLayer(lower, { opacity });
      const upper = d.addLayer('Upper occluder');
      d.begin('Upper artwork');
      const top = upper.canvas.getContext('2d');
      top.fillStyle = '#0000ff'; top.fillRect(8, 0, 8, 16);
      d.commit();
      d.selectLayer(lower);
      if (selection) { d.selectRect(2, 2, 2, 2); d.moveSelection(4, 4); }
      d.markSaved();
      return d;
    };
    const render = (d, options = {}) => {
      const surface = createCanvas(d.width, d.height);
      // Match the app display for both sides; export contexts can round alpha differently.
      d.renderTo(surface.getContext('2d'), options);
      return surface;
    };
    const read = (surface, x, y) => [...surface.getContext('2d').getImageData(x, y, 1, 1).data];
    const capture = d => ({ serialized: JSON.stringify(d.serialize()), selection: d.selection, layers: d.layers,
      canvases: d.layers.map(layer => layer.canvas), revision: d.revision, undo: d._undo, redo: d._redo, dirty: d.dirty });
    const unchanged = (d, before) => JSON.stringify(d.serialize()) === before.serialized && d.selection === before.selection &&
      d.layers === before.layers && d.layers.every((layer, index) => layer.canvas === before.canvases[index]) &&
      d.revision === before.revision && d._undo === before.undo && d._redo === before.redo && d.dirty === before.dirty;
    const materialize = d => d._edit('Commit pending shape', () => { d._stampSelection(); paint(d.activeLayer.canvas.getContext('2d')); });
    const comparisons = [];
    for (const background of [null, '#ffffff']) for (const opacity of [1, 0.5]) for (const selection of [false, true]) {
      const d = fixture(background, opacity, selection), before = capture(d);
      const preview = render(d, { layerPreview: { layerId: d.activeLayerId, paint } });
      const preserved = unchanged(d, before), pixels = read(preview, 10, 8);
      materialize(d);
      comparisons.push({ background, opacity, selection, preserved,
        same: preview.toDataURL() === render(d).toDataURL(), upperOccludes: pixels.join(',') === '0,0,255,255' });
    }
    record('layer preview matches committed pixels with opacity, overlap, selection, and both background modes',
      comparisons.every(item => item.same), comparisons.filter(item => !item.same));
    record('temporary layer preview preserves document pixels, selection, revision, history, and ownership',
      comparisons.every(item => item.preserved), comparisons.filter(item => !item.preserved));
    record('higher layers occlude pending artwork before commit', comparisons.every(item => item.upperOccludes));

    const alpha = fixture(), alphaPreview = render(alpha, { layerPreview: { layerId: alpha.activeLayerId, paint } });
    const overlapping = read(alphaPreview, 6, 8), newInk = read(alphaPreview, 6, 13);
    record('layer opacity applies once to overlapping existing and pending pixels', overlapping[3] === 128 && newInk[3] === 64,
      { overlapping, newInk });
    const isolated = fixture('#ffffff', 0.5, true);
    const isolatedPreview = render(isolated, { onlyActive: true, layerPreview: { layerId: isolated.activeLayerId, paint } });
    materialize(isolated);
    record('only-active preview excludes upper layers and document background like committed rendering',
      isolatedPreview.toDataURL() === render(isolated, { onlyActive: true }).toDataURL() && read(isolatedPreview, 0, 0)[3] === 0);

    const hidden = fixture();
    hidden.setLayer(hidden.activeLayerId, { visible: false });
    let hiddenCalls = 0;
    const hiddenPreview = render(hidden, { layerPreview: { layerId: hidden.activeLayerId, paint: ctx => { hiddenCalls++; paint(ctx); } } });
    record('hidden layer preview remains hidden without invoking its painter', hiddenCalls === 0 && hiddenPreview.toDataURL() === render(hidden).toDataURL());

    const reused = fixture(), previewOptions = { layerPreview: { layerId: reused.activeLayerId, paint } };
    const firstPreview = render(reused, previewOptions), scratch = reused._compositeScratch;
    const secondPreview = render(reused, previewOptions);
    record('repeated previews reuse one scratch surface without accumulating ink', reused._compositeScratch === scratch && firstPreview.toDataURL() === secondPreview.toDataURL());
    const cancelled = render(reused);
    record('removing a preview immediately restores the unchanged composite', cancelled.toDataURL() === render(reused).toDataURL() && cancelled.toDataURL() !== firstPreview.toDataURL());

    const failed = fixture(null, 0.5, true), beforeFailure = capture(failed), surface = createCanvas(20, 16), ctx = surface.getContext('2d');
    ctx.translate(2, 3); ctx.globalAlpha = 0.3; ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = '#123456';
    const contextState = () => JSON.stringify({ transform: [...ctx.getTransform().toFloat64Array()], alpha: ctx.globalAlpha,
      operation: ctx.globalCompositeOperation, fill: ctx.fillStyle });
    const beforeContext = contextState();
    let failureCaught = false;
    try {
      failed.renderTo(ctx, { layerPreview: { layerId: failed.activeLayerId, paint: scratchContext => {
        scratchContext.translate(40, 50); scratchContext.globalAlpha = 0.1;
        scratchContext.beginPath(); scratchContext.rect(0, 0, 1, 1); scratchContext.clip();
        throw new Error('Injected preview painter failure');
      } } });
    } catch (error) { failureCaught = error.message === 'Injected preview painter failure'; }
    const contextRestored = contextState() === beforeContext;
    const recovered = render(failed, { layerPreview: { layerId: failed.activeLayerId, paint } });
    const failurePreserved = unchanged(failed, beforeFailure);
    materialize(failed);
    record('preview painter failure restores caller and scratch state without changing the document', failureCaught && contextRestored &&
      failurePreserved && recovered.toDataURL() === render(failed).toDataURL(), { failureCaught, contextRestored, failurePreserved });
    return results;
  });
  for (const result of results) check(result.name, result.ok, result.detail);
}
