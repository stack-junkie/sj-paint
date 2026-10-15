const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

async function writeFileAtomically(destination, data, filesystem = fs) {
  const temporary = path.join(path.dirname(destination), `.paint-save-${randomUUID()}.tmp`);
  let file;
  let owned = false;
  try {
    file = await filesystem.open(temporary, 'wx', 0o600);
    owned = true;
    await file.writeFile(data);
    await file.sync();
    await file.close();
    file = null;
    await filesystem.rename(temporary, destination);
    owned = false;
  } catch (failure) {
    const cleanupFailures = [];
    if (file) {
      try { await file.close(); file = null; }
      catch (error) { cleanupFailures.push(error); }
    }
    if (owned) {
      try { await filesystem.unlink(temporary); owned = false; }
      catch (error) {
        if (error.code === 'ENOENT') owned = false;
        else cleanupFailures.push(error);
      }
    }
    if (cleanupFailures.length) {
      const error = new AggregateError([failure, ...cleanupFailures],
        `Saving failed, and temporary-file cleanup was incomplete: ${temporary}`, { cause: failure });
      // Preserve ownership information if cleanup needs another attempt.
      error.temporaryPath = owned ? temporary : null;
      error.fileHandle = file;
      throw error;
    }
    throw failure;
  }
}

module.exports = { writeFileAtomically };
