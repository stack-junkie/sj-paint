const { execFile } = require('node:child_process');
const path = require('node:path');
const { createOwnedQuery } = require('./owned-query.cjs');

// Read-only and independent of PowerShell's default DPI context. No renderer
// input enters the executable, arguments, or native declarations.
const WINDOWS_QUERY = `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PaintDisplayMetrics {
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
}
'@; $previous=[PaintDisplayMetrics]::SetThreadDpiAwarenessContext([IntPtr](-4)); if($previous -eq [IntPtr]::Zero){throw 'Could not establish PerMonitorV2 display query context.'}; try { @{width=[PaintDisplayMetrics]::GetSystemMetrics(0);height=[PaintDisplayMetrics]::GetSystemMetrics(1)} | ConvertTo-Json -Compress } finally { [void][PaintDisplayMetrics]::SetThreadDpiAwarenessContext($previous) }`;

function validateMetrics(value) {
  if (!value || !['width', 'height'].every(axis => Number.isSafeInteger(value[axis]) && value[axis] > 0 && value[axis] <= 0x7fffffff)) {
    throw new Error('The primary display dimensions could not be read.');
  }
  return { width: value.width, height: value.height };
}

function createDisplayMetrics({ platform = process.platform, run = execFile, getPrimaryDisplay,
  systemRoot = process.env.SystemRoot || 'C:\\Windows' } = {}) {
  const processOwner = createOwnedQuery(run);
  let pending = null;
  function load() {
    if (pending) return pending;
    if (platform === 'linux') {
      // Electron exposes DIP bounds, not exact native pixel extents. This is
      // the Linux display boundary; do not represent it as a Win32 measurement.
      return Promise.resolve().then(() => {
        const display = getPrimaryDisplay();
        if (!Number.isFinite(display?.scaleFactor) || display.scaleFactor <= 0) throw new Error('The primary display scale could not be read.');
        return { ...validateMetrics({ width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) }), source: 'electron-primary-display' };
      });
    }
    if (platform !== 'win32') return Promise.reject(new Error('Primary display dimensions are unavailable on this platform.'));
    const command = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    pending = processOwner.query(command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_QUERY],
      { windowsHide: true, encoding: 'utf8', timeout: 15000, maxBuffer: 4096 }).then(stdout => {
      try { return { ...validateMetrics(JSON.parse(stdout.replace(/^\uFEFF/, ''))), source: 'windows-primary-pixels' }; }
      catch (error) { throw new Error('The primary display dimensions could not be read.', { cause: error }); }
    }, error => { throw new Error('The primary display query failed or timed out. Try Default again.', { cause: error }); })
      .finally(() => { pending = null; });
    return pending;
  }
  return { load, get active() { return processOwner.active; }, cancel: processOwner.cancel };
}

module.exports = { createDisplayMetrics, validateMetrics };
