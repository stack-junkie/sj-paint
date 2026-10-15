/** Geometry checks use independent world-space anchors, without changing the app document. */
export async function verifyPendingShapeGeometry(page, check) {
  const results = await page.evaluate(async () => {
    const { createPendingShape, paintPendingShape, hitPendingShape, transformPendingShape } = await import('/src/pending-shape.js');
    const { drawShape } = await import('/src/shapes.js');
    const { SHAPES } = await import('/src/icons.js');
    const results = [];
    const record = (name, ok, detail = null) => results.push({ name, ok, detail });
    // Chromium's DOMMatrix translation path rounds subpixel coordinates slightly.
    // Ten millionths of a document pixel covers that independent oracle's rounding.
    const close = (a, b) => Math.abs(a - b) < 1e-5;
    const samePoint = (a, b) => close(a[0], b[0]) && close(a[1], b[1]);
    const center = shape => [(shape.start[0] + shape.end[0]) / 2, (shape.start[1] + shape.end[1]) / 2];
    const size = shape => [Math.abs(shape.end[0] - shape.start[0]), Math.abs(shape.end[1] - shape.start[1])];
    const worldPoint = (shape, point) => {
      const [x, y] = center(shape);
      const matrix = new DOMMatrix().translate(x, y).rotate(shape.angle * 180 / Math.PI).translate(-x, -y);
      const transformed = matrix.transformPoint(new DOMPoint(...point));
      return [transformed.x, transformed.y];
    };
    const worldVector = (angle, point) => {
      const transformed = new DOMMatrix().rotate(angle * 180 / Math.PI).transformPoint(new DOMPoint(...point));
      return [transformed.x, transformed.y];
    };
    const controls = shape => {
      const x0 = Math.min(shape.start[0], shape.end[0]), x1 = Math.max(shape.start[0], shape.end[0]);
      const y0 = Math.min(shape.start[1], shape.end[1]), y1 = Math.max(shape.start[1], shape.end[1]);
      const [cx, cy] = center(shape);
      return [[x0, y0], [cx, y0], [x1, y0], [x1, cy], [x1, y1], [cx, y1], [x0, y1], [x0, cy]]
        .map(point => worldPoint(shape, point));
    };
    const shape = (type = 'rectangle') => createPendingShape(type, [40, 60], [120, 120],
      { stroke: '#ff0000', fill: '#00ff00', outline: 'solid', fillStyle: 'solid', lineWidth: 2 });
    const canvas = () => { const c = document.createElement('canvas'); c.width = c.height = 256; return c; };

    const rendering = [];
    for (const type of SHAPES.filter(type => type !== 'curve' && type !== 'polygon')) {
      for (const constrain of [false, true]) {
        const options = { ...shape().options, constrain };
        const original = canvas(), pending = canvas();
        drawShape(original.getContext('2d'), type, 120, 120, 40, 65, options);
        const editable = createPendingShape(type, [120, 120], [40, 65], options);
        paintPendingShape(pending.getContext('2d'), editable);
        rendering.push({ type, constrain, same: original.toDataURL() === pending.toDataURL(), baked: editable.options.constrain === false });
      }
    }
    record('pending basic shapes preserve existing initial raster and Shift constraints', rendering.every(item => item.same && item.baked), rendering.filter(item => !item.same || !item.baked));

    const resizeCases = [], hitCases = [];
    for (const angle of [0, Math.PI / 2, -Math.PI / 7]) {
      const original = { ...shape(), angle }, saved = JSON.stringify(original);
      const handles = controls(original);
      for (let index = 0; index < handles.length; index++) {
        // Move outward in the handle's normal directions, keeping dimensions positive.
        const localDelta = [[-21, -13], [0, -13], [21, -13], [21, 0], [21, 13], [0, 13], [-21, 13], [-21, 0]][index];
        const delta = worldVector(angle, localDelta), start = handles[index];
        const current = [start[0] + delta[0], start[1] + delta[1]];
        const changed = transformPendingShape(original, { kind: 'resize', index }, start, current);
        const changedHandles = controls(changed), opposite = (index + 4) % 8;
        resizeCases.push({ angle, index, grabbedTracksPointer: samePoint(changedHandles[index], current),
          oppositeFixed: samePoint(changedHandles[opposite], handles[opposite]), anglePreserved: changed.angle === angle,
          originalUnchanged: JSON.stringify(original) === saved });
        for (const zoom of [0.5, 1, 2, 4]) {
          const hit = hitPendingShape(original, start, zoom);
          hitCases.push({ angle, index, zoom, correct: hit?.kind === 'resize' && hit.index === index });
        }
      }
    }
    record('all eight rotated resize handles track the pointer and retain their opposite anchors',
      resizeCases.every(item => item.grabbedTracksPointer && item.oppositeFixed && item.anglePreserved && item.originalUnchanged),
      resizeCases.filter(item => !item.grabbedTracksPointer || !item.oppositeFixed || !item.anglePreserved || !item.originalUnchanged));
    record('rotated resize control hit tests remain aligned at four zoom levels', hitCases.every(item => item.correct), hitCases.filter(item => !item.correct));

    const crossed = { ...shape(), angle: Math.PI / 3 };
    const crossedStart = worldPoint(crossed, crossed.start), fixedEnd = worldPoint(crossed, crossed.end);
    const crossing = worldVector(crossed.angle, [110, 95]);
    const crossedPointer = [crossedStart[0] + crossing[0], crossedStart[1] + crossing[1]];
    const afterCrossing = transformPendingShape(crossed, { kind: 'resize', index: 0 }, crossedStart, crossedPointer);
    record('dragging a rotated corner across both opposite edges preserves its anchor and endpoint',
      samePoint(worldPoint(afterCrossing, afterCrossing.start), crossedPointer) && samePoint(worldPoint(afterCrossing, afterCrossing.end), fixedEnd), afterCrossing);
    const reversedLine = createPendingShape('line', [120, 60], [40, 120]);
    reversedLine.angle = -Math.PI / 4;
    const lineStart = worldPoint(reversedLine, reversedLine.start), lineEnd = worldPoint(reversedLine, reversedLine.end);
    const lineDelta = worldVector(reversedLine.angle, [20, -15]);
    const movedLineStart = [lineStart[0] + lineDelta[0], lineStart[1] + lineDelta[1]];
    const resizedLine = transformPendingShape(reversedLine, { kind: 'resize', index: 2 }, lineStart, movedLineStart);
    record('reversed diagonal line resizing retains endpoint orientation', samePoint(worldPoint(resizedLine, resizedLine.start), movedLineStart) &&
      samePoint(worldPoint(resizedLine, resizedLine.end), lineEnd));
    const flat = createPendingShape('line', [40, 100], [120, 100]);
    const expandedFlat = transformPendingShape(flat, { kind: 'resize', index: 4 }, [120, 100], [140, 130]);
    record('zero-height line expands without NaN geometry', samePoint(expandedFlat.start, [40, 100]) && samePoint(expandedFlat.end, [140, 130]));

    const rotated = { ...shape(), angle: Math.PI / 5 }, originalCenter = center(rotated);
    const moved = transformPendingShape(rotated, { kind: 'move' }, [50, 70], [33, 93]);
    record('moving a rotated shape translates every corner without resizing or rotating', controls(moved).every((point, index) =>
      samePoint(point, [controls(rotated)[index][0] - 17, controls(rotated)[index][1] + 23])) && samePoint(size(moved), size(rotated)) && moved.angle === rotated.angle);
    const turned = transformPendingShape(rotated, { kind: 'rotate' }, [originalCenter[0], originalCenter[1] - 50], [originalCenter[0] + 50, originalCenter[1]]);
    record('free rotation preserves center and size while following a quarter-circle pointer movement', samePoint(center(turned), originalCenter) &&
      samePoint(size(turned), size(rotated)) && close(turned.angle, rotated.angle + Math.PI / 2));
    const resizeConstrained = transformPendingShape(rotated, { kind: 'resize', index: 0 }, controls(rotated)[0],
      [controls(rotated)[0][0] - 40, controls(rotated)[0][1] - 15], { constrain: true });
    record('optional aspect-preserving resize keeps opposite corner fixed', close(size(resizeConstrained)[0] / size(resizeConstrained)[1], 4 / 3) &&
      samePoint(controls(resizeConstrained)[4], controls(rotated)[4]));

    const rotations = [];
    for (const zoom of [0.5, 1, 2, 4]) {
      const handle = worldPoint(rotated, [originalCenter[0], 60 - 24 / zoom]);
      const hit = hitPendingShape(rotated, handle, zoom);
      rotations.push({ zoom, hit: hit?.kind, center: hitPendingShape(rotated, originalCenter, zoom)?.kind,
        outside: hitPendingShape(rotated, [-500, -500], zoom) });
    }
    record('rotation handle uses CSS spacing and interior moves while outside clicks miss', rotations.every(item =>
      item.hit === 'rotate' && item.center === 'move' && item.outside === null), rotations);

    const surface = canvas(), ctx = surface.getContext('2d'), editable = shape();
    paintPendingShape(ctx, editable);
    const beforeColor = [...ctx.getImageData(80, 90, 1, 1).data];
    editable.options = { ...editable.options, fill: '#0000ff' };
    ctx.clearRect(0, 0, 256, 256);
    paintPendingShape(ctx, editable);
    const afterColor = [...ctx.getImageData(80, 90, 1, 1).data];
    record('changing pending shape colors changes its next raster without moving its bounds',
      beforeColor.join(',') === '0,255,0,255' && afterColor.join(',') === '0,0,255,255' && samePoint(editable.start, [40, 60]) && samePoint(editable.end, [120, 120]));
    const rotationHandlePixel = [...ctx.getImageData(80, 36, 1, 1).data];
    paintPendingShape(ctx, editable, { handles: true });
    record('preview controls appear only when requested', rotationHandlePixel[3] === 0 && ctx.getImageData(80, 36, 1, 1).data[3] > 0);
    ctx.translate(2, 3); ctx.rotate(0.2); ctx.globalAlpha = 0.4; ctx.lineWidth = 7;
    ctx.globalCompositeOperation = 'multiply'; ctx.strokeStyle = '#123456'; ctx.fillStyle = '#abcdef'; ctx.setLineDash([9, 5]);
    const contextState = () => JSON.stringify({ transform: [...ctx.getTransform().toFloat64Array()], alpha: ctx.globalAlpha,
      operation: ctx.globalCompositeOperation, stroke: ctx.strokeStyle, fill: ctx.fillStyle, width: ctx.lineWidth, dash: ctx.getLineDash() });
    const beforeContext = contextState();
    paintPendingShape(ctx, rotated, { handles: true, zoom: 2 });
    record('pending shape preview restores caller drawing context state', contextState() === beforeContext);

    const immutable = shape(), immutableBefore = JSON.stringify(immutable);
    const result = transformPendingShape(immutable, { kind: 'move' }, [0, 0], [1, 2]);
    result.start[0] = 999; result.options.fill = '#123456';
    record('transformed shape owns its endpoints and mutable color options', JSON.stringify(immutable) === immutableBefore);
    return results;
  });
  for (const result of results) check(result.name, result.ok, result.detail);
}
