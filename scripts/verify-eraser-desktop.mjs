import { writePaint } from '../src/paint-format.js';

// Reuses the caller's owned native chooser fixture. Renderer checks use public
// controls and canvas pixels, without development globals or clipboard access.
export async function verifyEraserDesktop(page, check, { main }) {
  const originalFile = await main('__sjPaintVerification.file');
  const pixels = () => page.locator('#canvas').evaluate(canvas => canvas.toDataURL());
  const blank = await pixels();
  const width = 160, height = 120, lower = new Uint8Array(width * height * 4), upper = new Uint8Array(lower.length);
  for (let p = 0; p < lower.length; p += 4) {
    lower.set([255, 242, 0, 255], p); upper.set([237, 28, 36, 255], p);
  }
  for (let y = 15; y < 50; y++) for (let x = 100; x < 145; x++) upper.set([0, 255, 0, 255], (y * width + x) * 4);
  const bytes = Buffer.from(await writePaint({ width, height, background: [0, 0, 0, 0], layers: [
    { name: 'Yellow lower layer', visible: true, opacity: 1, rgba: lower },
    { name: 'Red and green upper layer', visible: true, opacity: 1, rgba: upper },
  ] }));
  const move = async (x, y) => {
    const box = await page.locator('#overlay').boundingBox();
    const zoom = await page.locator('#overlay').evaluate(canvas => canvas.getBoundingClientRect().width / canvas.width);
    await page.mouse.move(box.x + x * zoom, box.y + y * zoom);
  };
  const waitPixels = expected => page.waitForFunction(value => document.querySelector('#canvas').toDataURL() === value,
    expected, { polling: 100 });
  try {
    await main(`(() => { const q = __sjPaintVerification; q.file = q.path.join(q.directory, 'desktop-eraser.paint');
      q.fs.writeFileSync(q.file, Buffer.from(${JSON.stringify(bytes.toString('base64'))}, 'base64')); })()`);
    await page.locator('#overlay').focus(); await page.keyboard.press('Control+o');
    await page.waitForFunction(() => document.title.startsWith('desktop-eraser - ') && document.querySelector('#canvas').width === 160,
      null, { polling: 100 });
    await page.locator('#zoom-presets').selectOption({ label: '100%' });
    await page.waitForFunction(() => Math.abs(document.querySelector('#canvas').getBoundingClientRect().width - 160) < 0.01,
      null, { polling: 100 });
    await page.locator('[data-tool="eraser"]').click(); await move(30, 80);
    check('desktop eraser defaults to eight pixels with a matching square cursor',
      await page.locator('#size-number').inputValue() === '8' && await page.locator('#eraser-cursor').evaluate(cursor =>
        !cursor.hidden && parseFloat(cursor.style.width) === 8 && parseFloat(cursor.style.height) === 8) &&
      !await page.locator('#opacity-control').isVisible());
    const original = await pixels(); await page.mouse.down(); await page.mouse.up();
    await page.waitForFunction(value => document.querySelector('#canvas').toDataURL() !== value, original, { polling: 100 });
    const square = await pixels();
    check('desktop left eraser exposes exactly an eight-by-eight square of the lower yellow layer', await page.locator('#canvas').evaluate(canvas => {
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data; let count = 0;
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
        const p = (y * canvas.width + x) * 4;
        if (data[p] === 255 && data[p + 1] === 242 && data[p + 2] === 0 && data[p + 3] === 255) {
          if (x < 26 || x >= 34 || y < 76 || y >= 84) return false; count++;
        }
      }
      return count === 64;
    }));
    await page.keyboard.press('Control+z'); await waitPixels(original); await page.keyboard.press('Control+y'); await waitPixels(square);
    check('desktop square erasure is restored by one Undo and Redo', await pixels() === square);
    await page.keyboard.press('Control+z'); await waitPixels(original);
    await page.locator('[data-color="#ed1c24"]').click(); await page.locator('[data-color="#00a2e8"]').click({ button: 'right' });
    await move(30, 30); await page.mouse.down({ button: 'right' }); await move(130, 30); await page.mouse.up({ button: 'right' });
    await page.waitForFunction(() => document.querySelector('#canvas').getContext('2d').getImageData(50, 30, 1, 1).data[0] === 0,
      null, { polling: 100 });
    const replaced = await pixels();
    check('desktop right eraser replaces red with Color 2 and preserves unmatched green', await page.locator('#canvas').evaluate(canvas => {
      const c = canvas.getContext('2d'); return [...c.getImageData(50, 30, 1, 1).data].join(',') === '0,162,232,255' &&
        [...c.getImageData(120, 30, 1, 1).data].join(',') === '0,255,0,255' && [...c.getImageData(50, 45, 1, 1).data].join(',') === '237,28,36,255';
    }));
    await page.keyboard.press('Control+z'); await waitPixels(original); await page.keyboard.press('Control+y'); await waitPixels(replaced);
    check('desktop right replacement is restored by one Undo and Redo', await pixels() === replaced);
    const visibility = await main(`({ platform: process.platform, hidden: process.mainModule.require('electron').BrowserWindow.getAllWindows().every(window => !window.isVisible()) })`);
    if (visibility.platform === 'win32') check('desktop eraser verification keeps the Windows instance hidden', visibility.hidden);
  } finally {
    await page.locator('#overlay').focus(); await page.keyboard.press('Control+n');
    await page.waitForFunction(() => document.title === 'Untitled - Stack Junkie Paint' && document.querySelector('#canvas').width === 1152,
      null, { polling: 100 });
    await page.locator('[data-color="#000000"]').click(); await page.locator('[data-color="#ffffff"]').click({ button: 'right' });
    await page.locator('[data-menu="brushes"]').click(); await page.locator('[data-command="tool:brush"]').click();
    await main(`__sjPaintVerification.file = ${JSON.stringify(originalFile)}`);
  }
  check('desktop eraser fixture restores the original blank canvas', await pixels() === blank);
}
