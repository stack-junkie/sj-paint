import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVerificationResults } from './verification-results.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const names = process.argv.slice(2);
if (!names.length) names.push('text-session', 'text-layout', 'text-interactions', 'text-focus', 'text-pan-focus', 'text-controls');
if (names.some(name => !/^[a-z-]+$/.test(name))) throw new Error('Expected focused workflow names.');
const errors = [];
const { checks, check, summary } = createVerificationResults();
let browser, server;
try {
  server = await createServer({ root, server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/output/**', '**/release/**', '**/dist/**'] } } });
  await server.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.PAINT_CHROME_PATH ?
    { executablePath: process.env.PAINT_CHROME_PATH } : { channel: process.env.PAINT_CHROME_CHANNEL || 'chrome' }) });
  for (const name of names) {
    const context = await browser.newContext({ viewport: { width: 1364, height: 820 }, deviceScaleFactor: 1 });
    try {
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
      await page.locator('#overlay').waitFor();
      const module = await import(`./verify-${name}.mjs`);
      const entry = `verify${name.split('-').map(part => part[0].toUpperCase() + part.slice(1)).join('')}`;
      await module[entry](page, check);
      console.log(`${name}: completed`);
    } finally { await context.close(); }
  }
  check('focused workflows have no page errors', errors.length === 0, errors);
} catch (error) {
  if (!checks.some(result => result.ok === false)) checks.push({ name: 'focused workflow failure', ok: false, detail: error.stack || String(error) });
  errors.push(error.stack || String(error)); process.exitCode = 1;
  console.error(error.message);
} finally {
  await browser?.close(); await server?.close();
  await fs.mkdir(path.join(root, 'output'), { recursive: true });
  const result = summary();
  await fs.writeFile(path.join(root, 'output', 'text-workflows.json'), JSON.stringify({ timestamp: new Date().toISOString(), names, ...result, checks, errors }, null, 2));
  console.log(`${result.passed} passed, ${result.skipped.length} skipped, ${result.failed.length} failed`);
}
