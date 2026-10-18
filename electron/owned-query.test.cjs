const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createOwnedQuery } = require('./owned-query.cjs');
const { createFontCatalog } = require('./font-catalog.cjs');

function fixture() {
  const calls = [];
  const run = (_command, _args, _options, callback) => {
    const child = new EventEmitter();
    child.kill = () => false;
    child.on('error', error => callback(error, ''));
    calls.push({ child, callback });
    return child;
  };
  return { run, calls };
}

test('query outcome and actual closure are separate; stale callback cannot retire a later query', async () => {
  const { run, calls } = fixture(), owner = createOwnedQuery(run);
  const first = owner.query('fixed', [], {});
  calls[0].callback(null, 'first'); assert.equal(await first, 'first'); assert.equal(owner.active, true);
  assert.equal(owner.query('fixed', [], {}), first); assert.equal(calls.length, 1);
  calls[0].child.emit('close'); assert.equal(owner.active, false);
  const second = owner.query('fixed', [], {});
  calls[0].callback(new Error('late callback')); calls[0].child.emit('close');
  assert.equal(owner.active, true);
  calls[1].callback(null, 'second'); calls[1].child.emit('close');
  assert.equal(await second, 'second'); assert.equal(owner.active, false);
});

for (const code of ['ENOENT', 'ETIMEDOUT']) test(`${code} callback before close preserves shutdown ownership`, async () => {
  const { run, calls } = fixture(), owner = createOwnedQuery(run);
  const result = owner.query('fixed', [], {}); const rejected = assert.rejects(result, { code });
  calls[0].child.emit('error', Object.assign(new Error(code), { code })); await rejected;
  assert.equal(owner.active, true);
  let done = false; const cancel = owner.cancel().then(() => { done = true; });
  await Promise.resolve(); assert.equal(done, false);
  calls[0].child.emit('close'); await cancel; assert.equal(owner.active, false);
});

test('synchronous spawn failure creates no retained child and permits retry', async () => {
  const owner = createOwnedQuery(() => { throw new Error('spawn failed'); });
  await assert.rejects(owner.query('fixed', [], {}), /spawn failed/);
  assert.equal(owner.active, false); await owner.cancel();
  await assert.rejects(owner.query('fixed', [], {}), /spawn failed/);
});

test('font catalog fallback does not release a live helper after kill error', async () => {
  const { run, calls } = fixture(), catalog = createFontCatalog({ run });
  const result = catalog.load();
  calls[0].child.kill = () => { calls[0].child.emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM' })); return false; };
  let done = false; const cancel = catalog.cancel().then(() => { done = true; });
  assert.equal((await result).ok, false); assert.equal(catalog.active, true); assert.equal(done, false);
  calls[0].child.emit('close'); await cancel; assert.equal(catalog.active, false);
});
