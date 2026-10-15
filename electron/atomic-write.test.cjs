const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { writeFileAtomically } = require('./atomic-write.cjs');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(process.env.PAINT_TEST_TEMP_DIR || os.tmpdir(), 'paint-atomic-save-'));
  t.after(async () => {
    for (const name of await fs.readdir(directory)) await fs.unlink(path.join(directory, name));
    await fs.rmdir(directory);
  });
  const destination = path.join(directory, 'drawing.png');
  await fs.writeFile(destination, 'previous saved content');
  return { directory, destination };
}

test('successful save syncs and closes the sibling file before replacing existing content', async t => {
  const { directory, destination } = await fixture(t);
  const events = [];
  const filesystem = {
    ...fs,
    async open(temporary, flags, mode) {
      assert.equal(path.dirname(temporary), directory);
      assert.equal(flags, 'wx');
      const file = await fs.open(temporary, flags, mode);
      return {
        async writeFile(data) { events.push('write'); await file.writeFile(data); },
        async sync() { events.push('sync'); await file.sync(); },
        async close() { events.push('close'); await file.close(); },
      };
    },
    async rename(source, target) { events.push('rename'); await fs.rename(source, target); },
  };
  await writeFileAtomically(destination, Buffer.from('new image bytes'), filesystem);
  assert.deepEqual(events, ['write', 'sync', 'close', 'rename']);
  assert.equal(await fs.readFile(destination, 'utf8'), 'new image bytes');
  assert.deepEqual(await fs.readdir(directory), ['drawing.png']);
  await writeFileAtomically(destination, '{"format":"paint-linux"}');
  assert.equal(await fs.readFile(destination, 'utf8'), '{"format":"paint-linux"}');
});

test('a partial write failure preserves the old file and removes the owned temporary file', async t => {
  const { directory, destination } = await fixture(t);
  let renamed = false;
  const failure = new Error('simulated disk-full failure after partial write');
  const filesystem = {
    ...fs,
    async open(temporary, flags, mode) {
      const file = await fs.open(temporary, flags, mode);
      return {
        async writeFile(data) { await file.writeFile(data.subarray(0, 4)); throw failure; },
        sync: () => file.sync(),
        close: () => file.close(),
      };
    },
    async rename() { renamed = true; },
  };
  await assert.rejects(writeFileAtomically(destination, Buffer.from('replacement bytes'), filesystem), error => error === failure);
  assert.equal(renamed, false);
  assert.equal(await fs.readFile(destination, 'utf8'), 'previous saved content');
  assert.deepEqual(await fs.readdir(directory), ['drawing.png']);
});

test('a rename failure preserves the destination and cleans up the completed temporary file', async t => {
  const { directory, destination } = await fixture(t);
  await assert.rejects(writeFileAtomically(destination, 'replacement', {
    ...fs, async rename() { throw new Error('simulated rename permission failure'); },
  }), /rename permission failure/);
  assert.equal(await fs.readFile(destination, 'utf8'), 'previous saved content');
  assert.deepEqual(await fs.readdir(directory), ['drawing.png']);
});

test('an exclusive-open failure never removes a file the writer does not own', async t => {
  const { destination } = await fixture(t);
  let unlinked = false;
  await assert.rejects(writeFileAtomically(destination, 'replacement', {
    ...fs,
    async open() { throw Object.assign(new Error('simulated filename collision'), { code: 'EEXIST' }); },
    async unlink() { unlinked = true; },
  }), /filename collision/);
  assert.equal(unlinked, false);
  assert.equal(await fs.readFile(destination, 'utf8'), 'previous saved content');
});
