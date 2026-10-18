import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { verifyPrintLayout } from './verify-print-layout.mjs';
import { createVerificationResults } from './verification-results.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = new URL('../output/pdf/', import.meta.url);
const python = process.env.PAINT_PYTHON_PATH || 'python';
const { checks, check, summary } = createVerificationResults();
const errors = [];
let browser, server;
await mkdir(output, { recursive: true });
try {
  server = await createServer({ root, server: { host: '127.0.0.1', port: 0,
    watch: { ignored: ['**/release/**', '**/dist/**', '**/output/**'] } } });
  await server.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.PAINT_CHROME_PATH ?
    { executablePath: process.env.PAINT_CHROME_PATH } : { channel: process.env.PAINT_CHROME_CHANNEL || 'chrome' }) });
  const page = await browser.newPage({ viewport: { width: 1364, height: 820 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
  await page.waitForFunction(() => window.paintApp);
  await verifyPrintLayout(page, check, { inspectPdf: async (pdf, name) => {
    await writeFile(new URL(`print-${name}.pdf`, output), pdf);
    return new Promise((resolve, reject) => {
      const child = spawn(python, [fileURLToPath(new URL('./inspect-print-pdf.py', import.meta.url))],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 });
      let stdout = '', stderr = '';
      child.stdout.on('data', bytes => { stdout += bytes; });
      child.stderr.on('data', bytes => { stderr += bytes; });
      child.on('error', reject);
      child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
      child.on('close', code => {
        if (code !== 0) return reject(new Error(`Independent PDF inspection failed (${code}). Use PAINT_PYTHON_PATH for an existing PyMuPDF installation. ${stderr}`));
        try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
      });
      child.stdin.end(pdf);
    });
  } });
  check('PDF workflows have no renderer errors', errors.length === 0, errors);
} catch (error) {
  checks.push({ name: 'PDF verification failure', ok: false, detail: error.stack });
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server?.close();
  await writeFile(new URL('print-report.json', output), JSON.stringify({ timestamp: new Date().toISOString(), checks, errors,
    limitations: 'Headless Chromium PDFs and independent PyMuPDF raster inspection. Deferred desktop print bridge; no native dialog, physical printer or Microsoft pagination acceptance.' }, null, 2));
  console.log(JSON.stringify(summary()));
}
