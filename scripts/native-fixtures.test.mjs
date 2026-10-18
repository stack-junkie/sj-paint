import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readNativeFixture } from './native-fixtures.mjs';

test('an explicit private fixture directory cannot silently skip missing or changed evidence', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sj-paint-fixture-check-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const name = 'reference-native-colors.tif';
  await assert.rejects(readNativeFixture(name, { directory }), /Cannot read requested native fixture/);
  await writeFile(path.join(directory, name), 'incorrect reference bytes');
  await assert.rejects(readNativeFixture(name, { directory }), /provenance changed/);
});

test('private fixture lookup rejects paths and unregistered names', async () => {
  await assert.rejects(readNativeFixture('../private-file'), /Unknown native fixture/);
  await assert.rejects(readNativeFixture('reference-native-colors.tif', { directory: 'relative' }), /absolute directory/);
  await assert.rejects(readNativeFixture('reference-native-colors.tif', { directory: '' }), /absolute directory/);
});
