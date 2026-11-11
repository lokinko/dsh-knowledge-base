import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {chromium, expect} from '@playwright/test';

// Open only the prebuilt standalone artifact. No server, production config,
// globalSetup or build is imported or launched by this test suite.
const root = fileURLToPath(new URL('../../', import.meta.url));
const artifacts = path.join(root, '.build/prototypes');
const entry = path.join(artifacts, 'workbench.html');
let browser;
before(async () => {
  const executablePath = process.env.DSH_TEST_CHROME || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : undefined);
  browser = await chromium.launch({headless: true, ...(executablePath ? {executablePath} : {})});
  await fs.mkdir(artifacts, {recursive: true});
});
after(async () => { await browser?.close(); });

async function withPage(action, {file = entry, storageDisabled = false} = {}) {
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}, acceptDownloads: true, reducedMotion: 'reduce'});
  const errors = [], network = [];
  if (storageDisabled) await context.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {get() { throw new DOMException('Storage disabled for test', 'SecurityError'); }});
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
  await page.route(/^https?:\/\//, route => route.abort());
  try {
    await page.goto(pathToFileURL(file).href);
    await expect(page.locator('#canvas [data-id="workspace"]')).toBeVisible();
    await action(page, context);
    assert.deepEqual(errors, [], 'standalone app must not produce page errors');
    assert.deepEqual(network, [], 'standalone app must not issue HTTP requests');
  } catch (error) {
    console.error('prototype diagnostics', {errors, network, geometry: await page.locator('#designer, .designer-body, #canvas, #canvas [data-id="workspace"], #canvas [data-id="scene-host"], #canvas [data-id="topics-main"]').evaluateAll(nodes => nodes.map(node => ({id: node.dataset.id || node.id || node.className, x: node.getBoundingClientRect().x, y: node.getBoundingClientRect().y, width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height}))).catch(() => [])});
    await page.screenshot({path: path.join(artifacts, 'failure.png')}).catch(() => {});
    throw error;
  } finally { await context.close(); }
}

const node = (page, id) => page.locator(`#canvas [data-id="${id}"]`);
async function select(page, id) {
  await page.locator(`#node-tree [data-node-id="${id}"]`).click();
  await expect(page.locator('#inspector')).toContainText(id);
}
async function field(page, label, value) {
  const control = page.getByLabel(label, {exact: true});
  await control.fill(String(value));
  await control.blur();
}
async function exportJSON(page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', {name: '导出 JSON', exact: true}).click();
  const download = await pending;
  return JSON.parse(await fs.readFile(await download.path(), 'utf8'));
}
const find = (envelope, id) => envelope.layout.nodes.find(item => item.id === id);
async function importJSON(page, value) {
  await page.locator('#import-file').setInputFiles({name: 'private-layout.json', mimeType: 'application/json', buffer: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))});
}
async function saveHTML(page, name) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', {name: '保存 HTML', exact: true}).click();
  const download = await pending, destination = path.join(artifacts, name);
  await download.saveAs(destination);
  return destination;
}
const children = (value, id) => value.layout.nodes.filter(item => item.parentId === id).map(item => item.id);

test('smoke: offline artifact renders design topics with zero runtime errors or HTTP', {timeout: 30000}, async () => {
  await withPage(async page => {
    await expect(page.locator('#mode-button')).toHaveText('▶ 体验模式');
    await expect(page.locator('#scene-select')).toHaveValue('topics');
    await expect(node(page, 'topics-main')).toBeVisible();
    await expect(page.locator('#inspector')).toBeVisible();
    const body = await page.locator('.designer-body').boundingBox(), viewport = page.viewportSize();
    assert.ok(body.height > 300 && body.y < viewport.height && body.y + body.height > 0, 'designer body must have usable height inside the browser viewport');
    const nav = await node(page, 'nav-library').boundingBox(), point = {x: nav.x + nav.width / 2, y: nav.y + nav.height / 2};
    assert.ok(point.x > 0 && point.x < viewport.width && point.y > 0 && point.y < viewport.height, 'canvas control must be on screen before clicking');
    assert.equal(await page.evaluate(({x,y}) => document.elementFromPoint(x,y)?.closest('[data-id]')?.dataset.id, point), 'nav-library', 'canvas must receive real pointer input rather than being clipped behind its parent');
    await node(page, 'nav-library').getByRole('button').click();
    await expect(page.locator('#inspector')).toContainText('nav-library');
    await expect(page.locator('#scene-select')).toHaveValue('topics');
    await select(page, 'topics-main');
    await page.screenshot({path: path.join(artifacts, 'designer.png')});
  });
});

test('design: all scenes, editable properties, precise reparenting and undo/redo', {timeout: 60000}, async () => {
  await withPage(async page => {
    await node(page, 'nav-library').getByRole('button').click();
    await expect(page.locator('#scene-select')).toHaveValue('topics');
    await expect(page.locator('#inspector')).toContainText('nav-library');
    for (const scene of ['library', 'read', 'edit', 'topics']) {
      await page.locator('#scene-select').selectOption(scene);
      await expect(node(page, 'scene-' + scene)).toBeVisible();
    }
    await select(page, 'topics-title');
    await field(page, '显示文字', '手动决定如何整理🙂\n保留第二行');
    await field(page, '控件名称', '可调整的问题标题');
    await field(page, '字号', 29);
    await field(page, '内边距', 9);
    await field(page, '外边距', 5);
    await field(page, '给实现者的备注', '标题可以多行，先读来源再手动整理。');
    const title = find(await exportJSON(page), 'topics-title');
    assert.equal(title.name, '可调整的问题标题');
    assert.equal(title.props.text, '手动决定如何整理🙂\n保留第二行');
    assert.equal(title.props.fontSize, 29);assert.equal(title.props.padding, 9);assert.equal(title.props.margin, 5);
    assert.equal(title.props.note, '标题可以多行，先读来源再手动整理。');
    await expect(node(page, 'topics-title')).toHaveCSS('font-size', '29px');
    assert.equal(await node(page, 'topics-title').locator('.mock-text').textContent(), title.props.text);
    await select(page, 'topics-main');await field(page, '子项间距', 25);
    assert.equal(find(await exportJSON(page), 'topics-main').props.gap, 25);
    await select(page, 'topics-reader');
    await page.getByRole('button', {name: '↑ 上移', exact: true}).click();
    assert.deepEqual(children(await exportJSON(page), 'topics-evidence'), ['topics-reader', 'topics-sources']);
    await page.getByRole('button', {name: '↓ 下移', exact: true}).click();
    assert.deepEqual(children(await exportJSON(page), 'topics-evidence'), ['topics-sources', 'topics-reader']);
    await page.getByLabel('所在容器', {exact: true}).selectOption('topics-body');
    assert.equal(find(await exportJSON(page), 'topics-reader').parentId, 'topics-body');
    await page.locator('#undo-button').click();
    assert.equal(find(await exportJSON(page), 'topics-reader').parentId, 'topics-evidence');
    await page.locator('#redo-button').click();
    assert.equal(find(await exportJSON(page), 'topics-reader').parentId, 'topics-body');
  });
});

test('design: actual drag moves nodes and resize divides pointer delta by canvas zoom', {timeout: 60000}, async () => {
  await withPage(async page => {
    await page.locator('#zoom-select').selectOption('50');
    await select(page, 'topics-reader');
    await node(page, 'topics-reader').locator('.drag-grip').dragTo(node(page, 'topics-chat'));
    assert.equal(find(await exportJSON(page), 'topics-reader').parentId, 'topics-body');
    await page.locator('#undo-button').click();
    assert.equal(find(await exportJSON(page), 'topics-reader').parentId, 'topics-evidence');
    await select(page, 'topics-main');
    await page.getByLabel('宽度模式', {exact: true}).selectOption('fixed');
    await field(page, '宽度像素', 600);
    const bounds = await node(page, 'topics-main').boundingBox();
    assert.ok(Math.abs(bounds.width - 300) < 2, '600 layout px must render as 300 at 50%');
    const handle = await node(page, 'topics-main').locator('.resize-handle').boundingBox();
    const x = handle.x + handle.width / 2, y = handle.y + Math.min(15, handle.height / 2);
    await page.mouse.move(x, y);await page.mouse.down();
    await page.mouse.move(x + 70, y, {steps: 8});await page.mouse.up();
    const width = find(await exportJSON(page), 'topics-main').props.width;
    assert.ok(Math.abs(width - 740) <= 2, `70 screen px must add 140 layout px, got ${width}`);
    await page.locator('#undo-button').click();assert.equal(find(await exportJSON(page), 'topics-main').props.width, 600);
    await page.locator('#redo-button').click();assert.equal(find(await exportJSON(page), 'topics-main').props.width, width);
  });
});

test('mobile: overrides are independent, can be cleared and hidden nodes remain selectable in tree', {timeout: 60000}, async () => {
  await withPage(async page => {
    await select(page, 'topics-title');
    await field(page, '显示文字', '桌面基础问题');await field(page, '字号', 28);
    await page.locator('#device-select').selectOption('mobile');
    await field(page, '显示文字', '手机单独的问题');await field(page, '字号', 19);
    let value = find(await exportJSON(page), 'topics-title');
    assert.equal(value.props.text, '桌面基础问题');assert.equal(value.mobile.text, '手机单独的问题');
    assert.equal(value.props.fontSize, 28);assert.equal(value.mobile.fontSize, 19);
    assert.equal(await node(page, 'topics-title').locator('.mock-text').textContent(), '手机单独的问题');
    await page.screenshot({path: path.join(artifacts, 'mobile.png')});
    await page.locator('#device-select').selectOption('desktop');
    assert.equal(await node(page, 'topics-title').locator('.mock-text').textContent(), '桌面基础问题');
    await page.locator('#device-select').selectOption('mobile');
    await page.getByRole('button', {name: '清除此控件的手机覆盖', exact: true}).click();
    value = find(await exportJSON(page), 'topics-title');
    assert.equal(value.mobile?.text, undefined);assert.equal(value.mobile?.fontSize, undefined);
    assert.equal(await node(page, 'topics-title').locator('.mock-text').textContent(), '桌面基础问题');
    await select(page, 'topic-new');await page.getByLabel('隐藏控件', {exact: true}).check();
    await expect(node(page, 'topic-new')).toHaveCount(0);
    await expect(page.locator('#node-tree [data-node-id="topic-new"]')).toHaveClass(/is-hidden/);
    await select(page, 'topic-new');await page.getByLabel('隐藏控件', {exact: true}).uncheck();
    await expect(node(page, 'topic-new')).toBeVisible();
    await page.locator('#device-select').selectOption('desktop');
    assert.equal(find(await exportJSON(page), 'topic-new').props.hidden, false);
  });
});

test('preview: sample notes, reading/editing, sources and chat work without a model', {timeout: 60000}, async () => {
  await withPage(async page => {
    await page.locator('#mode-button').click();
    await expect(page.locator('#tree-panel')).toBeHidden();await expect(page.locator('#inspector-panel')).toBeHidden();
    await node(page, 'nav-library').getByRole('button').click();
    await expect(page.locator('#scene-select')).toHaveValue('library');
    await page.getByRole('searchbox', {name: '搜索笔记', exact: true}).fill('论文');
    await expect(page.locator('.mock-card')).toHaveCount(1);
    await page.locator('.mock-card').click();
    await expect(page.locator('#scene-select')).toHaveValue('read');
    await expect(node(page, 'read-title')).toContainText('论文阅读：怎样提出一个好问题');
    await node(page, 'read-edit').getByRole('button').click();
    const editor = page.getByRole('textbox', {name: '样例正文', exact: true});
    await editor.fill('# 私有样例草稿\n\n只在页面里编辑🙂');
    await node(page, 'edit-save').getByRole('button').click();
    await expect(page.locator('#toast')).toContainText('不会写入任何资料库');
    await node(page, 'edit-preview').getByRole('button').click();
    await node(page, 'read-source').getByRole('button').click();
    await expect(node(page, 'read-coauthor')).toBeVisible();
    await node(page, 'read-edit').getByRole('button').click();
    await expect(page.getByRole('textbox', {name: '样例正文', exact: true})).toHaveValue('# 私有样例草稿\n\n只在页面里编辑🙂');
    await node(page, 'nav-topics').getByRole('button').click();
    await page.getByRole('button', {name: '＋ 查找并选择来源', exact: true}).click();
    await page.getByRole('dialog', {name: '查找来源', exact: true}).getByRole('button', {name: '添加这段来源', exact: true}).click();
    await expect(page.locator('.source-item')).toHaveCount(4);
    await page.locator('.source-item').nth(1).click();
    await expect(page.locator('.mock-reader')).toContainText('话题不够相关时，不需要强行回顾');
    const chat = node(page, 'topics-chat');
    await chat.getByRole('textbox', {name: '模拟会话输入', exact: true}).fill('离线会话样例，不发给模型');
    await chat.getByRole('button', {name: '发送', exact: true}).click();
    await expect(chat.locator('.bubble.user').last()).toHaveText('离线会话样例，不发给模型');
    await expect(chat.locator('.bubble.assistant').last()).toContainText('不会调用模型');
    await page.screenshot({path: path.join(artifacts, 'preview.png')});
    await node(page, 'topic-new-note').getByRole('button').click();
    await expect(page.locator('#scene-select')).toHaveValue('edit');
  });
});

test('files: JSON and self-contained HTML round trips preserve layout, notes and mobile edits without local storage', {timeout: 90000}, async () => {
  const desktopText = '往返文字🙂\n</script><img src="https://must-not-load.invalid/pixel">';
  const mobileText = '手机覆盖独立保留🙂', comment = '给实现者：保留 < > & 符号🙂\n第二行备注。';
  let envelope;
  await withPage(async page => {
    await select(page, 'topics-title');await field(page, '显示文字', desktopText);
    await field(page, '给实现者的备注', comment);await field(page, '字号', 26);
    await page.locator('#device-select').selectOption('mobile');
    await field(page, '显示文字', mobileText);await field(page, '字号', 18);
    await page.locator('#device-select').selectOption('desktop');
    envelope = await exportJSON(page);
    assert.equal(envelope.format, 'dsh-workbench-prototype');assert.equal(envelope.version, 1);assert.equal(envelope.layout.version, 1);
    await page.reload();await select(page, 'topics-title');
    assert.equal(await node(page, 'topics-title').locator('.mock-text').textContent(), desktopText);
    assert.deepEqual((await exportJSON(page)).layout, envelope.layout, 'reload must restore the browser-local layout');
  });
  let firstHTML;
  await withPage(async page => {
    await importJSON(page, envelope);
    await expect(page.locator('#toast')).toContainText('布局已导入');
    assert.deepEqual((await exportJSON(page)).layout, envelope.layout, 'fresh browser context must import the downloaded JSON');
    const beforeInvalid = (await exportJSON(page)).layout;
    for (const invalid of ['{not json', {...envelope, version: 2}, {...envelope, layout: {version: 2, nodes: []}}]) {
      await importJSON(page, invalid);
      await expect(page.locator('#toast')).toContainText('导入失败');
      assert.deepEqual((await exportJSON(page)).layout, beforeInvalid, 'invalid import must preserve the existing layout');
    }
    await select(page, 'topics-title');
    await expect(page.getByLabel('给实现者的备注', {exact: true})).toHaveValue(comment);
    await page.locator('#device-select').selectOption('mobile');
    assert.equal(await node(page, 'topics-title').locator('.mock-text').textContent(), mobileText);
    firstHTML = await saveHTML(page, 'roundtrip-first.html');
  });
  let secondHTML;
  await withPage(async page => {
    await expect(page.locator('#device-select')).toHaveValue('mobile');
    assert.equal(await node(page, 'topics-title').locator('.mock-text').textContent(), mobileText);
    let value = find(await exportJSON(page), 'topics-title');
    assert.equal(value.props.text, desktopText);assert.equal(value.props.note, comment);
    assert.equal(value.mobile.text, mobileText);assert.equal(value.mobile.fontSize, 18);
    await select(page, 'topics-title');
    await field(page, '显示文字', 'HTML 打开后仍可修改🙂');
    await field(page, '给实现者的备注', '手机备注仍可编辑\n保持离线');
    value = find(await exportJSON(page), 'topics-title');
    assert.equal(value.props.note, comment);assert.equal(value.mobile.note, '手机备注仍可编辑\n保持离线');
    secondHTML = await saveHTML(page, 'roundtrip-second.html');
  }, {file: firstHTML});
  await withPage(async page => {
    assert.equal(await node(page, 'topics-title').locator('.mock-text').textContent(), 'HTML 打开后仍可修改🙂');
    const value = find(await exportJSON(page), 'topics-title');
    assert.equal(value.props.text, desktopText);assert.equal(value.props.note, comment);
    assert.equal(value.mobile.text, 'HTML 打开后仍可修改🙂');assert.equal(value.mobile.note, '手机备注仍可编辑\n保持离线');
    await page.locator('#device-select').selectOption('desktop');
    assert.equal(await node(page, 'topics-title').locator('.mock-text').textContent(), desktopText);
    await select(page, 'topics-title');await field(page, '字号', 31);
    assert.equal(find(await exportJSON(page), 'topics-title').props.fontSize, 31);
  }, {file: secondHTML});
});

test('storage: localStorage denial retains a working designer and allows exporting changes', {timeout: 30000}, async () => {
  await withPage(async page => {
    await expect(page.locator('#save-status')).toHaveText('本地保存不可用 · 请导出文件');
    await expect(node(page, 'topics-main')).toBeVisible();
    await select(page, 'topics-title');await field(page, '显示文字', '无法本地保存时仍可调整');
    assert.equal(find(await exportJSON(page), 'topics-title').props.text, '无法本地保存时仍可调整');
    const html = await saveHTML(page, 'storage-disabled.html');
    assert.ok((await fs.stat(html)).size > 1000);
    await expect(page.locator('#save-status')).toHaveText('本地保存不可用 · 请导出文件');
  }, {storageDisabled: true});
});
