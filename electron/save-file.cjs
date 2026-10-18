const fs = require('node:fs/promises');
const path = require('node:path');
const { writeFileAtomically } = require('./atomic-write.cjs');

// The main-process save owner chooses and confirms a destination before the
// atomic writer sees it. Callers serialize this whole operation with withDialog.
function createFileSaver({ getWindow, dialog, fileTargets, platform = process.platform,
  filesystem = fs, writeFile = writeFileAtomically }) {
  return async function saveFile(request, format, options, bytes) {
    const owner = getWindow();
    const ownsWindow = () => owner && getWindow() === owner && !owner.isDestroyed();
    if (!ownsWindow()) return false;
    let destination;
    if (request.target !== undefined) destination = fileTargets.resolve(request.target, format);
    else {
      // GTK did not honor Electron's overwrite flag in the installed app.
      // Linux confirmation therefore has exactly one explicit main-process owner.
      const result = await dialog.showSaveDialog(owner, { ...options,
        properties: platform === 'linux' ? [] : ['showOverwriteConfirmation'] });
      if (!ownsWindow() || result.canceled || !result.filePath) return false;
      destination = result.filePath;
      if (platform === 'linux') {
        let existing;
        try { existing = await filesystem.lstat(destination); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (!ownsWindow()) return false;
        if (existing) {
          const answer = await dialog.showMessageBox(owner, { type: 'warning',
            title: 'Replace existing file?', message: `Replace "${path.basename(destination)}"?`,
            detail: 'A file already exists at this destination. Replacing it will overwrite its contents.',
            buttons: ['Cancel', 'Replace'], defaultId: 0, cancelId: 0, noLink: true });
          if (!ownsWindow() || answer.response !== 1) return false;
        }
      }
    }
    if (!ownsWindow()) return false;
    await writeFile(destination, bytes);
    if (!ownsWindow()) return false;
    return { name: path.basename(destination), target: request.target ?? fileTargets.grant(destination, format) };
  };
}

module.exports = { createFileSaver };
