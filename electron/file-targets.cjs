const path = require('node:path');
const { randomUUID } = require('node:crypto');
const PROJECT = require('../src/project-format.json');

const formats = new Map([
  ['png', 'png'], ['jpg', 'jpeg'], ['jpeg', 'jpeg'], ['webp', 'webp'],
  ['bmp', 'bmp'], ['gif', 'gif'], ['tif', 'tiff'], ['tiff', 'tiff'], ['paint', 'paint'],
  ...PROJECT.readableExtensions.map(extension => [extension, PROJECT.extension]),
]);

// Grants belong to one window. Bound retained paths even if many imports fail
// renderer decoding; expired grants fail closed and Save As can select again.
class FileTargets {
  constructor(limit = 64) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid file target capacity.');
    this.limit = limit; this.targets = new Map();
  }
  formatForName(name) { return formats.get(path.extname(name).slice(1).toLowerCase()); }
  grant(filePath, format) {
    if (!path.isAbsolute(filePath) || ![...formats.values()].includes(format)) throw new Error('Invalid file target.');
    const token = randomUUID();
    this.targets.set(token, { filePath, format });
    while (this.targets.size > this.limit) this.targets.delete(this.targets.keys().next().value);
    return token;
  }
  resolve(token, format) {
    const target = typeof token === 'string' && this.targets.get(token);
    if (!target || target.format !== format) throw new Error('This save target is unavailable or uses a different format. Use Save as to choose a destination.');
    // Keep actively used document grants ahead of abandoned decode/import grants.
    this.targets.delete(token); this.targets.set(token, target);
    return target.filePath;
  }
  clear() { this.targets.clear(); }
}

module.exports = { FileTargets };
