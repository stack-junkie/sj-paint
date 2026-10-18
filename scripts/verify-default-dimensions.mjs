import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultDimensionsForDisplay, DEFAULT_DOCUMENT_SIZE } from '../src/engine.js';

test('Properties dimensions follow retained native display cases and non-divisible pixels', () => {
  assert.deepEqual(defaultDimensionsForDisplay({ width: 2560, height: 1600 }), { width: 1536, height: 960 });
  assert.deepEqual(defaultDimensionsForDisplay({ width: 1920, height: 1080 }), { width: 1152, height: 648 });
  assert.deepEqual(defaultDimensionsForDisplay({ width: 1366, height: 768 }), { width: 819, height: 460 });
  assert.deepEqual(DEFAULT_DOCUMENT_SIZE, { width: 1152, height: 648 });
});

test('invalid or oversized display results cannot become canvas dimensions', () => {
  for (const metrics of [null, {}, { width: NaN, height: 600 }, { width: 0, height: 600 }, { width: 100.5, height: 600 }, { width: 2147483648, height: 600 }, { width: 50000, height: 50000 }]) {
    assert.throws(() => defaultDimensionsForDisplay(metrics), RangeError);
  }
});
