const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { FileTargets } = require('./file-targets.cjs');

test('opaque grants bind the selected destination to its encoded format', () => {
  const targets = new FileTargets(), destination = path.resolve('renamed image.png');
  const token = targets.grant(destination, 'png');
  assert.match(token, /^[0-9a-f-]{36}$/);
  assert.equal(token.includes(destination), false);
  assert.equal(targets.resolve(token, 'png'), destination);
  assert.throws(() => targets.resolve(token, 'jpeg'), /different format/);
  assert.throws(() => targets.resolve(destination, 'png'), /unavailable/);
  assert.throws(() => targets.resolve({ target: token }, 'png'), /unavailable/);
  assert.throws(() => targets.resolve(null, 'png'), /unavailable/);
  assert.equal(targets.resolve(token, 'png'), destination);
});

test('import aliases use canonical encoding identities and unknown extensions have no grant format', () => {
  const targets = new FileTargets();
  for (const [name, format] of [['A.JPG', 'jpeg'], ['b.jpeg', 'jpeg'], ['c.tif', 'tiff'], ['d.TIFF', 'tiff'],
    ['e.linuxpaint', 'sjpaint'], ['f.sjpaint', 'sjpaint'], ['g.paint', 'paint'], ['h.png', 'png']]) {
    assert.equal(targets.formatForName(name), format);
  }
  assert.equal(targets.formatForName('unrecognized.raw'), undefined);
  assert.equal(targets.formatForName('noextension'), undefined);
  assert.throws(() => targets.grant('relative.png', 'png'), /Invalid file target/);
  assert.throws(() => targets.grant(path.resolve('file.raw'), 'raw'), /Invalid file target/);
});

test('bounded grants expire unused targets and window cleanup revokes all targets', () => {
  const targets = new FileTargets(2);
  const first = targets.grant(path.resolve('first.png'), 'png');
  const second = targets.grant(path.resolve('second.png'), 'png');
  targets.resolve(first, 'png');
  const third = targets.grant(path.resolve('third.png'), 'png');
  assert.throws(() => targets.resolve(second, 'png'), /unavailable/);
  assert.equal(targets.resolve(first, 'png'), path.resolve('first.png'));
  assert.equal(targets.resolve(third, 'png'), path.resolve('third.png'));
  const otherWindow = new FileTargets();
  assert.throws(() => otherWindow.resolve(first, 'png'), /unavailable/);
  targets.clear();
  assert.throws(() => targets.resolve(first, 'png'), /unavailable/);
  assert.throws(() => targets.resolve(third, 'png'), /unavailable/);
  assert.throws(() => new FileTargets(0), /capacity/);
});
