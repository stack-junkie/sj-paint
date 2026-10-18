const path = require('node:path');
const { createOwnedQuery } = require('./owned-query.cjs');

// Fixed read-only OS queries. No renderer-provided executable, path or arguments.
// One helper per app lifetime, with a 15-second / 1-MiB output budget.
function createFontCatalog({ run } = {}) {
  let result, pending;
  const processOwner = createOwnedQuery(run);
  function load() {
    if (result) return Promise.resolve(result);
    if (pending) return pending;
    let command, args, source;
    if (process.platform === 'win32') {
      command = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      source = 'windows-gdi';
      args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding $false; Add-Type -AssemblyName System.Drawing; $collection=New-Object System.Drawing.Text.InstalledFontCollection; try { $families=$collection.Families; ConvertTo-Json -Compress -InputObject @($families | ForEach-Object { $_.Name }) } finally { if($families){foreach($family in $families){$family.Dispose()}}; $collection.Dispose() }"];
    } else if (process.platform === 'linux') {
      command = 'fc-list'; args = ['--format=%{family[0]}\n']; source = 'fontconfig';
    } else {
      return Promise.resolve({ ok: false, message: 'Installed-font discovery is unavailable on this platform.' });
    }
    pending = processOwner.query(command, args, { windowsHide: true, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 }).then(stdout => {
      try {
        const names = source === 'windows-gdi' ? JSON.parse(stdout.replace(/^\uFEFF/, '')) : stdout.split('\n').filter(Boolean);
        if (!Array.isArray(names) || !names.length || names.some(name => typeof name !== 'string' || !name.trim() || /[\u0000-\u001f\u007f]/.test(name))) throw new Error('Invalid font inventory.');
        result = { ok: true, source, families: [...new Set(names)].sort((a, b) => a.localeCompare(b) || (a < b ? -1 : a > b ? 1 : 0)) };
      } catch { result = { ok: false, message: 'The installed-font list could not be read. The standard list is still available.' }; }
      return result;
    }, error => {
      result = { ok: false, code: error.killed ? 'FONT_QUERY_CANCELED_OR_TIMED_OUT' : error.code || 'FONT_QUERY_FAILED', message: 'Installed fonts could not be loaded. The standard list is still available.' };
      return result;
    }).finally(() => { pending = null; });
    return pending;
  }
  return {
    load,
    get active() { return processOwner.active; },
    cancel: processOwner.cancel,
  };
}

module.exports = { createFontCatalog };
