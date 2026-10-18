import { writeFile } from 'node:fs/promises';

// CDP Page.captureScreenshot timed out waiting for a Windows compositor frame
// with the native window hidden. Electron owns a capturer that can request
// that frame while explicitly retaining the hidden window state.
export function hiddenDesktopScreenshot(page, main, onCapture = () => {}) {
  return async ({ path, clip, style = '', animations, ...unsupported } = {}) => {
    if (Object.keys(unsupported).length) throw new Error(`Unsupported hidden capture options: ${Object.keys(unsupported)}`);
    await page.evaluate(() => document.fonts.ready);
    const sheet = await page.addStyleTag({ content: `${style}\n*{caret-color:transparent!important}${animations === 'disabled' ? '\n*,*::before,*::after{animation:none!important;transition:none!important}' : ''}` });
    try {
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      const area = clip ?? { x: 0, y: 0, width: viewport.width, height: viewport.height };
      const rect = { x: Math.floor(area.x), y: Math.floor(area.y),
        width: Math.ceil(area.x + area.width) - Math.floor(area.x),
        height: Math.ceil(area.y + area.height) - Math.floor(area.y) };
      const result = await main(`(async () => {
        const electron = process.mainModule.require('electron');
        const windows = electron.BrowserWindow.getAllWindows();
        if (windows.length !== 1 || windows[0].isVisible()) throw new Error('Capture requires one hidden owned window');
        const image = await windows[0].webContents.capturePage(${JSON.stringify(rect)}, { stayHidden: true, stayAwake: true });
        if (windows[0].isVisible() || image.isEmpty()) throw new Error('Hidden capture failed');
        return { png: image.toPNG().toString('base64'), size: image.getSize(),
          scale: electron.screen.getDisplayMatching(windows[0].getBounds()).scaleFactor };
      })()`);
      // Native capture retains physical display pixels even when CDP emulates
      // devicePixelRatio=1. Never resample the exact preview/commit oracle.
      const expected = { width: Math.round(rect.width * result.scale), height: Math.round(rect.height * result.scale) };
      if (result.size.width !== expected.width || result.size.height !== expected.height) {
        throw new Error(`Hidden capture dimensions ${JSON.stringify(result.size)} do not match ${JSON.stringify(expected)} at scale ${result.scale}`);
      }
      const bytes = Buffer.from(result.png, 'base64');
      if (path) await writeFile(path, bytes);
      onCapture({ path, rect, physicalPixels: result.size, nativeScale: result.scale, hidden: true });
      return bytes;
    } finally { await sheet.evaluate(element => element.remove()); }
  };
}
