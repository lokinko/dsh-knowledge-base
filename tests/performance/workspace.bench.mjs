import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

// No HTTP server or real DSH data: the existing browser fixtures run entirely
// through Playwright routes and in-memory Host tables. Only .build/performance
// artifacts are written. Root build products and source files are never changed.
const root = fileURLToPath(new URL('../../', import.meta.url));
const artifactRoot = path.join(root, '.build/performance');
const options = { client: '.build/performance/baseline-client.js', host: '.build/performance/baseline-host.js',
  output: '.build/performance/baseline.json', sizes: '100000,1000000', keys: '30', label: 'baseline' };
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i].replace(/^--/, '');
  if (!(key in options) && !['chrome', 'headful'].includes(key)) throw new Error('Unknown argument: ' + key);
  options[key] = key === 'headful' ? true : process.argv[++i];
}
const sizes = options.sizes.split(',').map(Number), keys = Number(options.keys);
if (!sizes.every(value => Number.isSafeInteger(value) && value > 0) || !Number.isSafeInteger(keys) || keys < 1) throw new Error('Invalid sizes/keys');
const resolve = value => path.resolve(root, value);
const output = resolve(options.output);
if (!output.startsWith(artifactRoot + path.sep)) throw new Error('--output must stay inside .build/performance');
await fs.mkdir(artifactRoot, { recursive: true });
const sha = data => createHash('sha256').update(data).digest('hex');
const client = resolve(options.client), hostEntry = resolve(options.host);
const fixtureSourcePath = path.join(artifactRoot, 'fixture-host.source.mjs');
const fixtureClientPath = path.join(artifactRoot, 'fixture-client.source.js');
// First use freezes fixtures too, so later source edits cannot skew comparisons.
for (const [source, target] of [['tests/browser/fixture-host.mjs', fixtureSourcePath], ['tests/browser/fixture-client.js', fixtureClientPath]]) {
  try { await fs.access(target); } catch { await fs.copyFile(resolve(source), target); }
}
const fixtureSource = await fs.readFile(fixtureSourcePath, 'utf8');
const replacement = `import {apply} from ${JSON.stringify(pathToFileURL(hostEntry).href)};`;
if (!fixtureSource.includes("import {apply} from '../../src/host/index.js';")) throw new Error('Unexpected fixture host import');
const fixtureModule = fixtureSource.replace("import {apply} from '../../src/host/index.js';", replacement);
const { createFixtureHost } = await import('data:text/javascript;base64,' + Buffer.from(fixtureModule).toString('base64'));
const browserHost = path.join(artifactRoot, 'browser-fixture.js');
await build({ absWorkingDir: root, stdin: { contents: await fs.readFile(fixtureClientPath, 'utf8'),
  resolveDir: root, sourcefile: 'frozen-fixture-client.js' }, outfile: browserHost,
  bundle: true, format: 'iife', platform: 'browser', target: 'chrome110', define: { 'process.env.NODE_ENV': '"production"' } });
function documentFor(length) {
  let seed = 0x51a7, text = '# Reproducible Markdown workspace\n\n', i = 0;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  while (text.length < length) {
    if (i % 12 === 0) text += `## Section ${i / 12 + 1}\n\n`;
    text += `Paragraph ${i}: 笔记用于保留思考，编辑与阅读应该连续。 Sample ${random().toString(16)} with **emphasis**, [reference](https://example.test/), and inline \`code\`.\n\n`;
    if (i % 20 === 0) text += '- [ ] Review this paragraph\n- [x] Keep exact source\n\n```js\nconst sample = 42;\nconsole.log(sample);\n```\n\n';
    i++;
  }
  return text.slice(0, length);
}
const summary = values => {
  const ordered = [...values].sort((a, b) => a - b);
  const percentile = p => ordered.length ? ordered[Math.min(ordered.length - 1, Math.ceil(p * ordered.length) - 1)] : null;
  return { n: values.length, p50: percentile(.5), p95: percentile(.95), max: ordered.at(-1) ?? null };
};
const chrome = options.chrome || process.env.DSH_TEST_CHROME || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : undefined);
const browser = await chromium.launch({ headless: !options.headful, ...(chrome ? { executablePath: chrome } : {}) });
const report = { label: options.label, timestamp: new Date().toISOString(), artifacts: {
  client: path.relative(root, client), clientSha256: sha(await fs.readFile(client)),
  host: path.relative(root, hostEntry), hostSha256: sha(await fs.readFile(hostEntry)),
  fixtureHostSha256: sha(fixtureSource), fixtureClientSha256: sha(await fs.readFile(fixtureClientPath)),
}, environment: { chrome: browser.version(), executable: chrome || 'Playwright Chromium', node: process.version,
  platform: process.platform, arch: process.arch, cpus: os.cpus()[0]?.model, viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1,
  headless: !options.headful, reducedMotion: 'reduce', reactMode: 'production' },
method: {
  version: 2,
  seed: 'xorshift32 0x51a7; fixed Markdown paragraphs/headings/lists/code; exact UTF-16 lengths',
  typing: `${keys} trusted single-character Playwright keyboard presses at document end after 5 warmup presses; every press followed by first rAF and an additional rAF`,
  commitProxy: 'keydown capture → window input listener queueMicrotask. React root event handlers have run; this is an event/commit checkpoint proxy, not a React Profiler commit timestamp or physical input latency.',
  frame: 'keydown capture → first requestAnimationFrame after input (before paint, not presentation latency)',
  scrolling: '30 trusted wheel events (500 CSS px) over editor/preview center; one rAF between events; rAF intervals sampled continuously during each scroll phase',
  preview: 'trusted Preview click capture → preview data-md-preview-state=ready (legacy no-marker DOM accepted) → element count unchanged across two consecutive rAFs; includes async worker/render/layout opportunities; excludes actual presentation',
  limitations: ['Isolated fixture rather than full DSH shell', 'Headless Chrome on this Windows machine; no comparison to Quiet native M5 numbers',
    'Single run per size, 30 key samples; P95 is descriptive rather than a statistical guarantee', 'No CPU throttling; OS scheduling and autosave can affect measurements',
    'Window input microtask is explicitly a commit proxy; longtasks cover only observed main-thread tasks >=50ms', 'DOM node counts are elements, not total text nodes'],
}, results: [] };
const html = `<!doctype html><html lang="zh" data-theme="dark" style="color-scheme:dark"><head><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body,#root{height:100%;width:100%;margin:0}body{font:14px system-ui,sans-serif;overflow:hidden}
:root{--dsw-alias-bg-base:#171717;--dsw-alias-bg-layer-1:#222;--dsw-alias-bg-layer-2:#292929;--dsw-alias-label-primary:#ececec;--dsw-alias-label-secondary:#b0b0b0;--dsw-alias-label-tertiary:#969696;--dsw-alias-border-l1:#383838;--dsw-alias-border-l2:#4a4a4a;--dsw-alias-brand-primary:#5b94e8;--dsw-alias-brand-primary-soft:#5b94e81a;--dsw-alias-state-error-primary:#e66363;--dsw-alias-interactive-bg-hover:#ffffff0d;--dsw-alias-interactive-bg-active:#88888822;--dsw-focus-ring-color:#789aca;--dsw-alias-brand-text:#fff;--dsw-alias-button-primary-fill:#435870;--dsw-alias-button-primary-hover:#536a83}
</style></head><body><div id="root"></div></body></html>`;
async function installMeasurement(page) {
  await page.evaluate(() => {
    const bench = window.__workspaceBench = { keys: [], longtasks: [], phase: 'idle', current: null, scrollFrames: [], scroll: false };
    const editorEvent = event => event.target.closest?.('.nb-content-input, .cm-content');
    document.addEventListener('keydown', event => {
      if (editorEvent(event) && event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
        bench.current = { key: event.key, start: performance.now(), trusted: event.isTrusted, phase: bench.phase };
      }
    }, true);
    window.addEventListener('input', event => {
      if (!editorEvent(event) || !bench.current) return;
      const sample = bench.current;
      sample.input = performance.now();
      queueMicrotask(() => {
        sample.windowMicrotask = performance.now();
        requestAnimationFrame(() => { sample.frame = performance.now(); bench.keys.push(sample); });
      });
      bench.current = null;
    });
    if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
      new PerformanceObserver(list => {
        for (const item of list.getEntries()) bench.longtasks.push({ start: item.startTime, duration: item.duration, phase: bench.phase });
      }).observe({ type: 'longtask', buffered: false });
    }
    let previous;
    const frame = time => {
      if (bench.scroll && previous !== undefined) bench.scrollFrames.push(time - previous);
      previous = bench.scroll ? time : undefined;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}
async function scroll(page, selector, phase) {
  const box = await page.locator(selector).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 300));
  await page.evaluate(phase => { const b = window.__workspaceBench; b.phase = phase; b.scrollFrames = []; b.scroll = true; }, phase);
  for (let i = 0; i < 30; i++) {
    await page.mouse.wheel(0, 500);
    await page.evaluate(() => new Promise(requestAnimationFrame));
  }
  return page.evaluate(() => { const b = window.__workspaceBench; b.scroll = false; return b.scrollFrames; });
}
try {
  for (const length of sizes) {
    const context = await browser.newContext({ viewport: report.environment.viewport, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    const page = await context.newPage(), host = await createFixtureHost(), errors = [];
    page.setDefaultTimeout(120_000);
    page.on('pageerror', error => errors.push(error.message));
    const content = documentFor(length), id = host.notes[0].id;
    await host.tool('manage_notes', { action: 'update', id, revision: host.notes[0].revision, content });
    try {
      await page.route('https://notebook.test/**', async route => {
        const request = route.request(), url = request.url();
        if (new URL(url).pathname.startsWith('/api/')) {
          const response = await host.fetch(url, { method: request.method(), headers: request.headers(), body: request.postDataBuffer() || undefined });
          return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
        }
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
      });
      await page.goto('https://notebook.test/?lang=zh');
      await page.evaluate(() => localStorage.setItem('dsh.todo-manager.chat-open', 'false'));
      await page.addScriptTag({ path: browserHost });
      await page.addScriptTag({ path: client });
      await page.locator('.nb-note-row').first().waitFor();
      await installMeasurement(page);
      const openStart = performance.now();
      await page.locator('.nb-note-row').filter({ hasText: '让想法慢慢成形' }).click();
      await page.locator('.nb-title-input').waitFor();
      const editing = page.locator('.em-md-modes').getByRole('button', { name: '编辑', exact: true });
      await editing.waitFor();
      const initialMode = await editing.getAttribute('aria-pressed') === 'true' ? 'source' : 'preview';
      if (initialMode !== 'source') await editing.click();
      const editor = page.locator('.cm-content, .nb-content-input').first();
      await editor.waitFor();
      await editor.click();
      await page.keyboard.press('Control+End');
      const openToSourceMs = performance.now() - openStart;
      await page.evaluate(() => { window.__workspaceBench.phase = 'warmup'; });
      for (let i = 0; i < 5; i++) {
        await page.keyboard.press('x');
        await page.evaluate(() => new Promise(requestAnimationFrame));
      }
      await page.evaluate(() => { const b = window.__workspaceBench; b.phase = 'typing'; b.keys = []; b.longtasks = []; });
      for (let i = 0; i < keys; i++) {
        await page.keyboard.press(String.fromCharCode(97 + i % 26));
        await page.waitForFunction(count => window.__workspaceBench.keys.length >= count, i + 1, { polling: 'raf' });
        await page.evaluate(() => new Promise(requestAnimationFrame));
      }
      const typed = await page.evaluate(() => {
        const cm = document.querySelector('.cm-editor'), native = document.querySelector('.nb-content-input');
        const raw = cm?.__noteEditorHandle?.value ?? native?.value;
        return { keys: window.__workspaceBench.keys, nodes: document.querySelectorAll('*').length,
          editorNodes: cm?.querySelectorAll('*').length ?? 1,
          rawLength: typeof raw === 'string' ? raw.length : null,
          normalizedLength: cm?.__noteEditorView?.state.doc.length ?? native?.value.length,
          rawSuffix: typeof raw === 'string' ? raw.slice(-35) : null,
          userAgent: navigator.userAgent, devicePixelRatio, editorKind: cm ? 'CodeMirror' : 'textarea' };
      });
      report.environment.userAgent = typed.userAgent;
      const sourceFrames = await scroll(page, '.cm-scroller, .nb-content-input', 'source-scroll');
      await page.evaluate(() => {
        window.__workspaceBench.phase = 'preview';
        document.addEventListener('click', function capture(event) {
          if (event.target.closest('.em-md-modes button')?.textContent.includes('预览')) {
            window.__workspaceBench.previewStart = performance.now();
            document.removeEventListener('click', capture, true);
          }
        }, true);
      });
      await page.locator('.em-md-modes').getByRole('button', { name: '预览', exact: true }).click();
      await page.locator('.em-markdown').waitFor();
      await page.waitForFunction(() => {
        const preview = document.querySelector('.em-markdown');
        const state = preview?.getAttribute('data-md-preview-state');
        if (state === 'error') throw new Error('Markdown preview entered error state');
        return preview && (state === null || state === 'ready');
      });
      const preview = await page.evaluate(() => new Promise(resolve => {
        let previous = -1, same = 0;
        const frame = () => {
          const element = document.querySelector('.em-markdown'), nodes = element?.querySelectorAll('*').length ?? 0;
          const state = element?.getAttribute('data-md-preview-state');
          if (nodes > 0 && nodes === previous && (state === null || state === 'ready')) same++; else same = 0;
          previous = nodes;
          if (same >= 2) resolve({ ms: performance.now() - window.__workspaceBench.previewStart,
            nodes, readyState: state ?? 'legacy-unmarked', totalNodes: document.querySelectorAll('*').length });
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }));
      const previewFrames = await scroll(page, '.nb-document-stage', 'preview-scroll');
      await page.evaluate(() => new Promise(requestAnimationFrame));
      const longtasks = await page.evaluate(() => window.__workspaceBench.longtasks);
      const saved = (await host.tool('manage_notes', { action: 'get', id })).note;
      const result = { length, contentSha256: sha(content), initialMode, openToSourceMs, editorKind: typed.editorKind,
        typing: { keydownToInputMs: summary(typed.keys.map(sample => sample.input - sample.start)),
          keydownToWindowMicrotaskMs: summary(typed.keys.map(sample => sample.windowMicrotask - sample.start)),
          inputToWindowMicrotaskMs: summary(typed.keys.map(sample => sample.windowMicrotask - sample.input)),
          keydownToRafMs: summary(typed.keys.map(sample => sample.frame - sample.start)),
          allTrusted: typed.keys.every(sample => sample.trusted), raw: typed.keys },
        source: { domElements: typed.nodes, editorElements: typed.editorNodes, rawLength: typed.rawLength,
          normalizedLength: typed.normalizedLength, rawSuffix: typed.rawSuffix, scrollRafIntervalMs: summary(sourceFrames) },
        preview: { ...preview, scrollRafIntervalMs: summary(previewFrames) },
        longtasks: { count: longtasks.length, totalMs: longtasks.reduce((sum, item) => sum + item.duration, 0), entries: longtasks },
        savedReadWindowLengthAtEnd: saved.content.length, savedContentLengthAtEnd: saved.contentLength ?? saved.content.length, errors };
      report.results.push(result);
      console.log(JSON.stringify({ label: options.label, length, initialMode, editor: typed.editorKind,
        inputMs: result.typing.keydownToWindowMicrotaskMs, frameMs: result.typing.keydownToRafMs,
        previewMs: preview.ms, domElements: preview.totalNodes, longtasks: result.longtasks.count }));
      await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
    } finally {
      await page.evaluate(() => window.__disposeFixture?.()).catch(() => {});
      await host.close();
      await context.close();
    }
  }
} finally {
  await browser.close();
  await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
}
console.log('Wrote ' + path.relative(root, output));
