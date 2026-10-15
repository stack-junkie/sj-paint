/** Affine selection checks use independent raster and anchor expectations. */
export async function verifySelectionTransform(page, check) {
  const results = await page.evaluate(async () => {
    const { PaintDocument, createCanvas } = await import('/src/engine.js');
    const results = [], record = (name, ok, detail = null) => results.push({ name, ok, detail });
    const near = (a, b) => Math.abs(a-b) < 1e-8;
    const pointNear = (a, b) => a.every((v, i) => near(v, b[i]));
    const bytes = canvas => [...canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data];
    const equal = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    const project = d => JSON.stringify(d.serialize());
    const pixel = (canvas, x, y) => [...canvas.getContext('2d').getImageData(x, y, 1, 1).data];
    const fixture = () => {
      const d = new PaintDocument(80, 64); d.setBackground(null); d.begin('Fixture');
      const ctx = d.activeLayer.canvas.getContext('2d');
      ctx.fillStyle = '#ff0000'; ctx.fillRect(20, 20, 4, 6);
      ctx.fillStyle = '#0000ff'; ctx.fillRect(24, 20, 4, 6);
      ctx.clearRect(20, 20, 1, 1); d.commit(); d.markSaved();
      return d;
    };
    const d = fixture(), baseline = project(d);
    d.selectRect(20, 20, 8, 6);
    const source = d.selection.canvas, mask = d.selection.mask, original = bytes(source), initialTransform = [...d.selection.transform];
    for (let i = 0; i < 12; i++) { d.rotate(17); d.rotate(-17); }
    d.resizeSelection(40, 30); d.resizeSelection(8, 6);
    record('repeated inverse rotations and resizing preserve original source pixels and geometric mask', d.selection.canvas === source &&
      d.selection.mask === mask && equal(bytes(source), original) && pointNear(d.selection.transform, initialTransform) && project(d) === baseline);
    record('selection transform is immutable and source dimensions remain independent of display size', Object.isFrozen(d.selection.transform) && source.width === 8 && source.height === 6);

    d.rotate(57);
    const geometry = d.getSelectionGeometry({ zoom: 2 });
    record('rotated controls preserve frame size and put rotation handle 24 CSS pixels beyond top midpoint', near(geometry.frameWidth, 8) && near(geometry.frameHeight, 6) &&
      near(Math.hypot(geometry.rotationHandle[0]-geometry.handles[1][0], geometry.rotationHandle[1]-geometry.handles[1][1]), 12) && geometry.bounds.width > 8 && geometry.bounds.height > 6);
    record('rotation handle and oriented interior use the same geometry for hit testing', d.hitSelection(geometry.rotationHandle, { zoom: 2 })?.kind === 'rotate' &&
      d.hitSelection(geometry.center, { zoom: 16 })?.kind === 'move');
    const anchor = [...geometry.corners[0]], dragged = geometry.handles[4];
    d.beginSelectionTransform({ kind: 'resize', index: 4 }, dragged);
    d.updateSelectionTransform([dragged[0]+11, dragged[1]+7]); d.commit();
    record('rotated resize keeps the opposite world-space corner fixed without replacing source pixels', pointNear(d.getSelectionGeometry().corners[0], anchor) && d.selection.canvas === source);
    const resized = d.getSelectionGeometry(), movedCorners = resized.corners.map(p => [p[0]+5, p[1]-3]);
    d.beginSelectionTransform({ kind: 'move' }, resized.center);
    d.updateSelectionTransform([resized.center[0]+5, resized.center[1]-3]); d.commit();
    record('move after rotation and resize translates every control by the pointer delta', d.getSelectionGeometry().corners.every((p, i) => pointNear(p, movedCorners[i])));
    const beforeRotate = d.getSelectionGeometry(), center = beforeRotate.center, start = beforeRotate.rotationHandle;
    const current = [center[0]-(start[1]-center[1]), center[1]+start[0]-center[0]];
    d.beginSelectionTransform({ kind: 'rotate' }, start); d.updateSelectionTransform(current); d.commit();
    record('free-rotation gesture preserves center and rotates every corner by its pointer angle', pointNear(d.getSelectionGeometry().center, center) &&
      d.getSelectionGeometry().corners.every((p, i) => pointNear(p, [center[0]-(beforeRotate.corners[i][1]-center[1]), center[1]+beforeRotate.corners[i][0]-center[0]])));
    const beforeCancel = project(d), transformBeforeCancel = [...d.selection.transform];
    d.beginSelectionTransform({ kind: 'move' }, center); d.updateSelectionTransform([center[0]+4, center[1]+2]); d.cancel();
    record('short gesture cancellation restores the preceding affine selection', project(d) === beforeCancel && pointNear(d.selection.transform, transformBeforeCancel));
    d.cancelSelection();
    record('whole-session cancellation restores original orientation and pixels without handles', project(d) === baseline && !d.selection && !d.hasSelectionSession && !d.dirty);

    const skewed = fixture(); skewed.selectRect(20, 20, 8, 6);
    const skewSource = skewed.selection.canvas, skewMask = skewed.selection.mask;
    skewed.resize(12, 9, { scale: true, skewX: 20, skewY: 0 });
    const skewTransform = [...skewed.selection.transform], skewGeometry = skewed.getSelectionGeometry();
    skewed.flip(true); skewed.flip(true);
    record('scaled skew and inverse flips preserve the original source and affine placement', skewed.selection.canvas === skewSource && skewed.selection.mask === skewMask &&
      pointNear(skewed.selection.transform, skewTransform) && near(skewGeometry.frameWidth, 12) && near(skewGeometry.corners[3][0]-skewGeometry.corners[0][0], Math.tan(20*Math.PI/180)*9));
    const resizeStart = skewed.getSelectionGeometry(), fixed = resizeStart.corners[0];
    skewed.beginSelectionTransform({ kind: 'resize', index: 4 }, resizeStart.corners[2]);
    skewed.updateSelectionTransform([fixed[0]-100, fixed[1]-100]); skewed.commit();
    record('crossing the opposite resize anchor clamps to positive frame dimensions', pointNear(skewed.getSelectionGeometry().corners[0], fixed) &&
      near(skewed.getSelectionGeometry().frameWidth, 1) && near(skewed.getSelectionGeometry().frameHeight, 1));

    const exported = fixture(), exportBaseline = project(exported); exported.selectRect(20, 20, 8, 6); exported.rotate(57); exported.translateSelection(10, 3);
    const exportBounds = exported.getSelectionGeometry().bounds, clipboard = exported.selectionCanvas(), composite = exported.composite();
    const documentPixels = [...composite.getContext('2d').getImageData(exportBounds.x, exportBounds.y, exportBounds.width, exportBounds.height).data];
    record('clipboard export contains the transformed AABB pixels rather than untransformed source', clipboard.width === exportBounds.width && clipboard.height === exportBounds.height && equal(bytes(clipboard), documentPixels));
    const serialized = exported.serialize(), exportedProject = project(exported), movedHistory = exported._undo.length;
    const loaded = new PaintDocument(1, 1); await loaded.load(serialized);
    record('project serialization materializes the same transformed pixels without changing selection', project(loaded) === exportedProject && exported.hasSelectionSession);
    exported.commitSelection();
    record('committing affine selection preserves its preview and records one raster edit', project(exported) === exportedProject && !exported.selection && exported._undo.length === movedHistory+1);
    exported.undo(); const undoOriginal = project(exported) === exportBaseline; exported.redo();
    record('Undo and Redo preserve affine result as committed raster without handles', undoOriginal && project(exported) === exportedProject && !exported.selection);

    const layered = fixture(); const lower = layered.activeLayerId;
    layered.begin('Lower landmarks'); const lowerCtx = layered.activeLayer.canvas.getContext('2d'); lowerCtx.fillStyle = '#00ff00'; lowerCtx.fillRect(15, 15, 3, 30); layered.commit();
    layered.addLayer('Selected layer'); layered.begin('Upper pixels'); const upperCtx = layered.activeLayer.canvas.getContext('2d'); upperCtx.fillStyle = '#ffaa00'; upperCtx.fillRect(20, 20, 8, 6); layered.commit();
    layered.setLayer(layered.activeLayerId, { opacity: .5 }); layered.markSaved();
    const beforeTransform = project(layered); layered.selectRect(20, 20, 8, 6); layered.rotate(57);
    const placement = project(layered), cropBounds = layered.getSelectionGeometry().bounds;
    const expectedLower = createCanvas(cropBounds.width, cropBounds.height);
    expectedLower.getContext('2d').drawImage(layered.layers.find(l => l.id === lower).canvas, -cropBounds.x, -cropBounds.y);
    const expectedComposite = createCanvas(cropBounds.width, cropBounds.height);
    expectedComposite.getContext('2d').drawImage(layered.composite(), -cropBounds.x, -cropBounds.y);
    layered.crop();
    record('rotated Crop uses transformed AABB and preserves unrotated lower-layer coordinates', layered.width === cropBounds.width && layered.height === cropBounds.height &&
      equal(bytes(layered.layers.find(l => l.id === lower).canvas), bytes(expectedLower)) && equal(bytes(layered.composite()), bytes(expectedComposite)) && !layered.selection);
    layered.undo(); const cropUndo = project(layered) === placement && !layered.selection; layered.undo();
    record('Crop and prior selection rotation have separate native-observed undo entries', cropUndo && project(layered) === beforeTransform && !layered.selection);

    const opaque = new PaintDocument(480, 360);
    opaque.begin('Colored lower layer'); const opaqueLower = opaque.activeLayer.canvas.getContext('2d');
    opaqueLower.fillStyle = '#113355'; opaqueLower.fillRect(0, 0, 480, 360);
    opaqueLower.fillStyle = '#22cc55'; opaqueLower.fillRect(145, 0, 7, 360); opaque.commit();
    opaque.addLayer('Opaque selected layer'); opaque.begin('Hard-edged upper artwork');
    const opaqueUpper = opaque.activeLayer.canvas.getContext('2d'); opaqueUpper.fillStyle = '#ed1c24'; opaqueUpper.fillRect(105, 105, 108, 67);
    opaqueUpper.clearRect(170, 105, 43, 25); opaque.commit();
    opaque.selectRect(100, 100, 120, 80); opaque.rotate(57);
    const opaquePreview = bytes(opaque.composite()), opaqueBounds = opaque.getSelectionGeometry().bounds;
    const expectedOpaqueCrop = [...opaque.composite().getContext('2d').getImageData(opaqueBounds.x, opaqueBounds.y, opaqueBounds.width, opaqueBounds.height).data];
    opaque.crop(); const opaqueCropMatches = equal(bytes(opaque.composite()), expectedOpaqueCrop); opaque.undo();
    record('opacity-one rotated edges are rasterized inside their layer before blending, so Crop and Undo preserve exact preview pixels',
      opaqueCropMatches && equal(bytes(opaque.composite()), opaquePreview));

    const failedCrop = fixture(); failedCrop.addLayer('Upper'); failedCrop.begin('Upper fixture');
    failedCrop.activeLayer.canvas.getContext('2d').fillRect(20, 20, 8, 6); failedCrop.commit();
    failedCrop.selectRect(20, 20, 8, 6); failedCrop.rotate(57);
    const cropBefore = project(failedCrop), cropTransform = [...failedCrop.selection.transform], cropSession = failedCrop._selectionSession;
    const cropHistory = failedCrop._undo.length, failingBounds = failedCrop.getSelectionGeometry().bounds;
    const cropDrawImage = CanvasRenderingContext2D.prototype.drawImage;
    let cropsDrawn = 0, cropFailed = false;
    CanvasRenderingContext2D.prototype.drawImage = function (...args) {
      const result = cropDrawImage.apply(this, args);
      if (this.canvas.width === failingBounds.width && this.canvas.height === failingBounds.height && ++cropsDrawn === 2) throw new Error('Injected crop failure');
      return result;
    };
    try { failedCrop.crop(); } catch (error) { cropFailed = error.message === 'Injected crop failure'; }
    finally { CanvasRenderingContext2D.prototype.drawImage = cropDrawImage; }
    record('failed multi-layer rotated crop restores its pending transform, pixels, and pre-command history', cropFailed && project(failedCrop) === cropBefore &&
      pointNear(failedCrop.selection.transform, cropTransform) && failedCrop._selectionSession === cropSession && failedCrop._undo.length === cropHistory && failedCrop._transaction === null);

    const masked = new PaintDocument(20, 20); masked.setBackground(null); masked.begin('Mask colors');
    const mc = masked.activeLayer.canvas.getContext('2d'); mc.fillStyle = '#ff0000'; mc.fillRect(2, 2, 4, 4); masked.commit();
    masked.selectPolygon([[2, 2], [6, 2], [2, 6]]); const originalMask = [...masked.selection.mask]; masked.rotate(90);
    masked.fill(5.5, 2.5, '#00ff00');
    record('fill maps document coordinates into transformed source pixels and preserves geometric ownership', equal(pixel(masked.selection.canvas, 0, 0), [0,255,0,255]) && equal([...masked.selection.mask], originalMask));
    const inverseMaskBefore = masked.getSelectionGeometry(); masked.invertSelection();
    // At 90 degrees, original source pixel (0,0) belongs at document pixel (5,2).
    record('Invert Selection complements the transformed mask in document coordinates', masked.selection.mask[2*20+5] === 0 && masked.selection.mask[0] === 1 && inverseMaskBefore.bounds.x === 2);

    const invalid = fixture(); invalid.selectRect(20, 20, 8, 6); invalid.rotate(57);
    const invalidProject = project(invalid), invalidTransform = invalid.selection.transform, undoCount = invalid._undo.length;
    let rejected = false; try { invalid.resizeSelection(16384, 16384); } catch (error) { rejected = error instanceof RangeError; }
    record('oversized transformed selection rejects before mutating its source, transform, or history', rejected && project(invalid) === invalidProject && invalid.selection.transform === invalidTransform && invalid._undo.length === undoCount);
    const allocationLimited = fixture(); allocationLimited.selectRect(20, 20, 8, 6);
    const originalCreateElement = document.createElement;
    let invalidAllocations = 0, capacityRejected = false;
    document.createElement = function (tag, ...args) {
      if (String(tag).toLowerCase() === 'canvas') invalidAllocations++;
      return originalCreateElement.call(this, tag, ...args);
    };
    try { allocationLimited.resizeSelection(16000, 2000); } catch (error) { capacityRejected = error instanceof RangeError; }
    finally { document.createElement = originalCreateElement; }
    record('transformed selection budget rejects before raster allocation or snapshot creation', capacityRejected && invalidAllocations === 0, { invalidAllocations });

    const originalDrawImage = CanvasRenderingContext2D.prototype.drawImage, pendingCanvas = invalid.selection.canvas;
    let failed = false;
    CanvasRenderingContext2D.prototype.drawImage = function (...args) {
      const result = originalDrawImage.apply(this, args);
      if (args[0] === pendingCanvas && this.canvas.width === invalid.width && this.canvas.height === invalid.height) throw new Error('Injected transformed stamp failure');
      return result;
    };
    try { invalid.commitSelection(); } catch (error) { failed = error.message === 'Injected transformed stamp failure'; }
    finally { CanvasRenderingContext2D.prototype.drawImage = originalDrawImage; }
    record('failed transformed stamping restores pixels and keeps the cancellable session', failed && project(invalid) === invalidProject && invalid.hasSelectionSession &&
      pointNear(invalid.selection.transform, invalidTransform) && invalid._undo.length === undoCount && invalid._transaction === null);
    const owner = invalid.captureEditTarget(); invalid.rotate(1);
    record('async edit target ownership invalidates when only the affine transform changes', !invalid.matchesEditTarget(owner));
    return results;
  });
  for (const result of results) check(result.name, result.ok, result.detail);
}
