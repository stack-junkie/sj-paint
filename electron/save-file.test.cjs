const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createFileSaver } = require('./save-file.cjs');
const { FileTargets } = require('./file-targets.cjs');
const { writeFileAtomically } = require('./atomic-write.cjs');

async function fixture(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sj-save-file-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, 'existing.png');
  const original = Buffer.from('existing bytes'), replacement = Buffer.from('replacement bytes');
  await fs.writeFile(destination, original);
  const owner = { isDestroyed: () => false }, state = { window: owner, response: 0, canceled: false };
  const calls = [], targets = new FileTargets();
  const dialog = {
    async showSaveDialog(window, options) { calls.push({ kind: 'chooser', window, options }); return { canceled: state.canceled, filePath: destination }; },
    async showMessageBox(window, options) { calls.push({ kind: 'confirm', window, options }); return { response: state.response }; },
  };
  const save = createFileSaver({ getWindow: () => state.window, dialog, fileTargets: targets, platform: 'linux', ...overrides });
  return { directory, destination, original, replacement, owner, state, calls, targets, dialog, save };
}

test('Linux existing Save As defaults to Cancel and preserves exact bytes without granting a target', async t => {
  const f = await fixture(t);
  assert.equal(await f.save({}, 'png', { title: 'Save image' }, f.replacement), false);
  assert.deepEqual(await fs.readFile(f.destination), f.original);
  assert.deepEqual(f.calls.map(call => call.kind), ['chooser', 'confirm']);
  assert.deepEqual(f.calls[0].options.properties, [], 'The chooser does not also own overwrite confirmation');
  const confirm = f.calls[1];
  assert.equal(confirm.window, f.owner);
  assert.deepEqual(confirm.options.buttons, ['Cancel', 'Replace']);
  assert.equal(confirm.options.defaultId, 0); assert.equal(confirm.options.cancelId, 0);
  assert(confirm.options.message.includes(path.basename(f.destination)));
  assert.equal(f.targets.targets.size, 0);
  assert.deepEqual(await fs.readdir(f.directory), ['existing.png']);
});

test('Linux Replace atomically saves chosen bytes and ordinary granted Save does not prompt again', async t => {
  const f = await fixture(t); f.state.response = 1;
  const result = await f.save({}, 'png', {}, f.replacement);
  assert.equal(result.name, 'existing.png'); assert.equal(f.targets.resolve(result.target, 'png'), f.destination);
  assert.deepEqual(await fs.readFile(f.destination), f.replacement);
  f.calls.length = 0;
  const ordinary = await f.save({ target: result.target }, 'png', {}, f.original);
  assert.deepEqual(ordinary, result); assert.deepEqual(f.calls, []);
  assert.deepEqual(await fs.readFile(f.destination), f.original);
  assert.deepEqual(await fs.readdir(f.directory), ['existing.png']);
});

test('chooser cancellation and a new Linux destination require no replacement confirmation', async t => {
  const f = await fixture(t); f.state.canceled = true;
  assert.equal(await f.save({}, 'png', {}, f.replacement), false);
  assert.deepEqual(f.calls.map(call => call.kind), ['chooser']);
  assert.deepEqual(await fs.readFile(f.destination), f.original);
  f.state.canceled = false; f.calls.length = 0; await fs.unlink(f.destination);
  assert(await f.save({}, 'png', {}, f.replacement));
  assert.deepEqual(f.calls.map(call => call.kind), ['chooser']);
  assert.deepEqual(await fs.readFile(f.destination), f.replacement);
});

test('Windows retains native chooser overwrite handling without an application confirmation', async t => {
  const f = await fixture(t, { platform: 'win32', filesystem: { lstat() { throw new Error('Windows must not use Linux existence check'); } } });
  assert(await f.save({}, 'png', {}, f.replacement));
  assert.deepEqual(f.calls.map(call => call.kind), ['chooser']);
  assert.deepEqual(f.calls[0].options.properties, ['showOverwriteConfirmation']);
  assert.deepEqual(await fs.readFile(f.destination), f.replacement);
});

test('destination inspection errors fail closed and preserve data', async t => {
  for (const code of ['EACCES', 'EIO']) {
    const f = await fixture(t, { filesystem: { async lstat() { throw Object.assign(new Error(code), { code }); } } });
    await assert.rejects(f.save({}, 'png', {}, f.replacement), { code });
    assert.deepEqual(await fs.readFile(f.destination), f.original);
    assert.deepEqual(f.calls.map(call => call.kind), ['chooser']); assert.equal(f.targets.targets.size, 0);
  }
});

test('atomic replacement failure after confirmation preserves the destination and grants no target', async t => {
  const f = await fixture(t, { writeFile: (destination, bytes) => writeFileAtomically(destination, bytes, {
    ...fs, async rename() { throw Object.assign(new Error('replacement denied'), { code: 'EACCES' }); },
  }) });
  f.state.response = 1;
  await assert.rejects(f.save({}, 'png', {}, f.replacement), { code: 'EACCES' });
  assert.deepEqual(await fs.readFile(f.destination), f.original); assert.equal(f.targets.targets.size, 0);
  assert.deepEqual(await fs.readdir(f.directory), ['existing.png']);
});

test('window ownership is rechecked after chooser, destination inspection and replacement confirmation', async t => {
  for (const boundary of ['chooser', 'inspection', 'confirmation']) {
    const f = await fixture(t); f.state.response = 1;
    const loseOwner = () => { f.state.window = { isDestroyed: () => false }; };
    let filesystem = fs;
    if (boundary === 'inspection') filesystem = { async lstat(destination) { const value = await fs.lstat(destination); loseOwner(); return value; } };
    else {
      const method = boundary === 'chooser' ? 'showSaveDialog' : 'showMessageBox', original = f.dialog[method];
      f.dialog[method] = async (...args) => { const value = await original(...args); loseOwner(); return value; };
    }
    const save = createFileSaver({ getWindow: () => f.state.window, dialog: f.dialog, fileTargets: f.targets, platform: 'linux', filesystem });
    assert.equal(await save({}, 'png', {}, f.replacement), false, boundary);
    assert.deepEqual(await fs.readFile(f.destination), f.original, boundary);
    assert.equal(f.calls.filter(call => call.kind === 'confirm').length, boundary === 'confirmation' ? 1 : 0);
    assert.equal(f.targets.targets.size, 0);
  }
});

test('destroyed owner cannot save and a completed write cannot grant a replacement window its target', async t => {
  const f = await fixture(t); f.owner.isDestroyed = () => true;
  assert.equal(await f.save({}, 'png', {}, f.replacement), false); assert.deepEqual(f.calls, []);
  f.owner.isDestroyed = () => false; f.state.response = 1;
  const save = createFileSaver({ getWindow: () => f.state.window, dialog: f.dialog, fileTargets: f.targets, platform: 'linux',
    async writeFile(destination, bytes) { await writeFileAtomically(destination, bytes); f.state.window = null; } });
  assert.equal(await save({}, 'png', {}, f.replacement), false);
  assert.deepEqual(await fs.readFile(f.destination), f.replacement, 'An authorized atomic write may already have completed');
  assert.equal(f.targets.targets.size, 0);
});
