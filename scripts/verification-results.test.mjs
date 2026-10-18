import test from 'node:test';
import assert from 'node:assert/strict';
import { createVerificationResults } from './verification-results.mjs';

test('unavailable independent evidence is a skip, never a successful assertion', () => {
  const report = createVerificationResults();
  report.check('drawing survives save', true);
  report.check.skip('native TIFF fixtures', 'Private fixtures absent');
  report.check.skip('independent PDF raster inspection', 'Separate verifier required');
  assert.equal(report.summary().passed, 1);
  assert.equal(report.summary().skipped.length, 2);
  assert.equal(report.summary().failed.length, 0);
  const serialized = JSON.parse(JSON.stringify(report.checks));
  assert.ok(serialized.slice(1).every(result => result.skipped === true && !Object.hasOwn(result, 'ok')));
});

test('failed assertions stop the workflow and remain in the report', () => {
  const report = createVerificationResults();
  assert.throws(() => report.check('saved bytes match', false, { different: true }), /saved bytes match/);
  assert.equal(report.summary().passed, 0);
  assert.equal(report.summary().failed[0].name, 'saved bytes match');
  assert.throws(() => report.check('unresolved assertion', undefined), /boolean/);
  assert.equal(report.checks.length, 1);
});
