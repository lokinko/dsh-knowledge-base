import {test, expect} from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createFixtureHost} from './fixture-host.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const image = name => fileURLToPath(new URL('../../.build/ui/' + name + '.png', import.meta.url));

async function openWorkspace(page, {theme = 'dark', language = 'zh', width = 1440, height = 1000, colorScheme = theme, shell = false, chatOpen = true, discussions = false} = {}) {
  const host = await createFixtureHost({discussions});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({width, height});
  await page.route('https://notebook.test/**', async route => {
    const request = route.request(), url = request.url();
    if (new URL(url).pathname.startsWith('/api/')) {
      const response = await host.fetch(url, {method: request.method(), headers: request.headers(), body: request.postDataBuffer() || undefined});
      return route.fulfill({status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer())});
    }
    return route.fulfill({contentType: 'text/html; charset=utf-8', body: `<!doctype html><html lang="${language}" data-theme="${theme}" style="color-scheme:${colorScheme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>
      * { box-sizing: border-box; } html, body, #root { height:100%; width:100%; margin:0; } body { font:14px system-ui,sans-serif; overflow:hidden; }
      :root { --dsw-alias-bg-base:${theme === 'dark' ? '#171717' : '#f3f4f6'}; --dsw-alias-bg-layer-1:${theme === 'dark' ? '#222' : '#fff'}; --dsw-alias-bg-layer-2:${theme === 'dark' ? '#292929' : '#eceef1'};
        --dsw-alias-label-primary:${theme === 'dark' ? '#ececec' : '#202124'}; --dsw-alias-label-secondary:${theme === 'dark' ? '#b0b0b0' : '#55585e'}; --dsw-alias-label-tertiary:${theme === 'dark' ? '#969696' : '#686b70'};
        --dsw-alias-border-l1:${theme === 'dark' ? '#383838' : '#d4d6da'}; --dsw-alias-border-l2:${theme === 'dark' ? '#4a4a4a' : '#bbbfc5'}; --dsw-alias-brand-primary:#5b94e8; --dsw-alias-brand-primary-soft:#5b94e81a;
        --dsw-alias-state-error-primary:#e66363; --dsw-alias-state-success-primary:#66ad8b; --dsw-alias-state-business-primary:#8b8cbd; --dsw-alias-state-warn-primary:#bf9b61;
        --dsw-alias-interactive-bg-hover:${theme === 'dark' ? '#ffffff0d' : '#0000000a'}; --dsw-alias-interactive-bg-active:#88888822; --dsw-focus-ring-color:#789aca;
        --dsw-alias-brand-text:#fff; --dsw-alias-button-primary-fill:#435870; --dsw-alias-button-primary-hover:#536a83; }
      .native-fixture { padding:24px; color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-base); height:100%; }
      .native-fixture textarea { display:block; width:100%; border:3px solid rgb(91, 94, 99); border-radius:3px; background:rgb(39, 42, 46); color:white; padding:11px; }
      .native-fixture button { background:rgb(70, 75, 80); color:white; border:3px solid rgb(91, 94, 99); border-radius:3px; padding:11px; }
      ${discussions ? '.native-fixture textarea { font:17px/1.4 monospace; min-height:89px; width:calc(100% - 6px); } .native-fixture button { font:15px/1.4 monospace; min-height:47px; width:137px; }' : ''}
      ${shell ? '#root { position:absolute; left:280px; top:40px; width:calc(100vw - 280px); height:calc(100vh - 40px); } .fixture-shell-nav { position:absolute;left:0;top:40px;width:280px;bottom:0;padding:24px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary); } .fixture-shell-top { position:absolute;top:0;left:0;right:0;height:40px;padding:10px 20px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary); }' : ''}
    </style></head><body>${shell ? '<div class="fixture-shell-top">DeepSeek Harness</div><aside class="fixture-shell-nav">工作区<br><br>对话<br><br>笔记<br><br>待办</aside>' : ''}<div id="root"></div></body></html>`});
  });
  await page.goto(`https://notebook.test/?lang=${language}`);
  await page.evaluate(value => localStorage.setItem('dsh.todo-manager.chat-open', String(value)), chatOpen);
  await page.addScriptTag({path: root + '.build/browser-host.js'});
  await page.addScriptTag({path: root + 'client.js'});
  await expect(page.locator('.nb-note-row')).toHaveCount(6);
  return {host, errors};
}
const sourceContent = page => page.locator('.nb-source-editor .cm-content');
const sourceEditor = page => page.locator('.nb-source-editor .cm-editor');
// Draft replacement may briefly tear down the old view after it was located.
// Polling callers wait for the newly mounted handle and its exact source.
async function sourceRaw(page) { return sourceEditor(page).evaluate(element => element.__noteEditorHandle?.value); }
async function sourceState(page) {
  return sourceEditor(page).evaluate(element => ({raw: element.__noteEditorHandle.value, selection: element.__noteEditorView.state.selection.main.head, length: element.__noteEditorView.state.doc.length}));
}
async function enterSource(page) {
  await expect(sourceContent(page)).toBeVisible();
  await expect.poll(()=>sourceEditor(page).evaluate(element=>!!element.__noteEditorHandle)).toBe(true);
}
async function readDrafts(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('dsh-note-drafts', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, transaction = db.transaction('drafts', 'readonly'), read = transaction.objectStore('drafts').getAll();
      read.onsuccess = () => { resolve(read.result); db.close(); };
      read.onerror = () => { reject(read.error); db.close(); };
    };
  }));
}
async function capture(page, name) {
  await fs.mkdir(new URL('../../.build/ui/', import.meta.url), {recursive: true});
  await page.screenshot({path: image(name), fullPage: true});
}
async function categoryManager(page) {
  await page.locator('.nb-list-actions .nb-category-manage').click();
  const dialog = page.locator('.nb-category-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', {name: '分类名称', exact: true})).toBeEnabled();
  return dialog;
}
async function addCategory(dialog, name, parentId = '') {
  const form = dialog.locator('form').filter({has: dialog.page().getByRole('textbox', {name: '分类名称', exact: true})});
  await form.getByRole('textbox', {name: '分类名称', exact: true}).fill(name);
  await form.getByRole('combobox', {name: '父分类', exact: true}).selectOption(parentId);
  await form.getByRole('button', {name: '新增分类', exact: true}).click();
  await expect(dialog.locator('.nb-cat-select').filter({hasText: name})).toHaveCount(1);
  await expect(form.getByRole('textbox', {name: '分类名称', exact: true})).toHaveValue('');
}
async function categoryTree(host) { return (await host.tool('manage_note_categories', {action: 'list'})).tree; }
const topicsPanel = page => page.locator('.tp-page');
const sourceReferenceKey = reference => JSON.stringify(reference.kind === 'note' ? ['note', reference.atomId] : ['discussion', reference.sessionId, reference.seq]);
async function openTopics(page) {
  await page.locator('.nb-workspace-tab').filter({hasText: '待整理'}).click();
  await expect(topicsPanel(page)).toBeVisible();
  await expect(topicsPanel(page).getByRole('textbox', {name: '新问题', exact: true})).toBeEnabled();
}
async function createTopic(page, host, question) {
  const panel = topicsPanel(page);
  await panel.getByRole('textbox', {name: '新问题', exact: true}).fill(question);
  await panel.getByRole('button', {name: '新建问题', exact: true}).click();
  await expect(panel.locator('.tp-workspace-header h1')).toHaveText(question);
  const saved = (await host.api('topics', {action: 'list'})).topics.find(topic => topic.question === question);
  expect(saved).toBeTruthy();
  return (await host.api('topics', {action: 'get', id: saved.id})).topic;
}
async function getTopicViaBrowserHTTP(page, id) {
  return page.evaluate(async id => {
    const response = await fetch('/api/dsh-note/topics', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({action: 'get', id})});
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || 'Topic HTTP get failed');
    return result.topic;
  }, id);
}
async function searchTopicSources(page, query) {
  const panel = topicsPanel(page),response = page.waitForResponse(value => {
    if (!value.url().endsWith('/api/dsh-note/discussions')) return false;
    try { return value.request().postDataJSON()?.action === 'search'; } catch { return false; }
  });
  await panel.getByRole('searchbox', {name: '查找来源', exact: true}).fill(query);
  await panel.locator('.tp-search-form').getByRole('button', {name: '搜索', exact: true}).click();
  const result = await (await response).json();expect(result.ok).toBe(true);
  await expect(panel.locator('.tp-result')).toHaveCount(result.results.length);
  return result;
}
async function readTopicResult(page, index) {
  const response = page.waitForResponse(value => {
    if (!value.url().endsWith('/api/dsh-note/discussions')) return false;
    try { return value.request().postDataJSON()?.action === 'read'; } catch { return false; }
  });
  await topicsPanel(page).locator('.tp-result').nth(index).click();
  const result = await (await response).json();expect(result.ok).toBe(true);
  await expect(topicsPanel(page).locator('.tp-original')).toBeVisible();
  expect(await topicsPanel(page).locator('.tp-original').textContent()).toBe(result.content);
  return result;
}
async function assertReadableSurface(page, theme, selector = '.nb-note-row', title = '.nb-note-row-title', body = '.nb-note-excerpt') {
  const samples = await page.locator(selector).first().evaluate((card, {title, body}) => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d');
    const rgba = color => { context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data].map(value => value / 255); };
    const composite = (foreground, background) => foreground.slice(0, 3).map((value, index) => value * foreground[3] + background[index] * (1 - foreground[3]));
    const backgroundOf = element => {
      const ancestors = []; for (let node = element; node; node = node.parentElement) ancestors.unshift(node);
      return ancestors.reduce((background, node) => composite(rgba(getComputedStyle(node).backgroundColor), background), [1, 1, 1]);
    };
    const luminance = rgb => rgb.map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
    const contrastOf = element => {
      const background = backgroundOf(element), foreground = composite(rgba(getComputedStyle(element).color), background);
      const a = luminance(foreground), b = luminance(background);
      return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    };
    return {background: luminance(backgroundOf(card)), titleContrast: contrastOf(card.querySelector(title)), excerptContrast: contrastOf(card.querySelector(body))};
  }, {title, body});
  expect(samples.titleContrast).toBeGreaterThanOrEqual(4.5);
  expect(samples.excerptContrast).toBeGreaterThanOrEqual(4.5);
  if (theme === 'dark') expect(samples.background).toBeLessThan(.2);
  else expect(samples.background).toBeGreaterThan(.7);
  const brand = page.locator('.nb-page-title');
  expect(parseFloat(await brand.evaluate(element => getComputedStyle(element).fontSize))).toBeLessThanOrEqual(20);
}
async function assertContained(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const outside = await page.locator('.nb-list-panel, .nb-editor-head, .nb-document-panel, .nb-coauthor').evaluateAll(elements => elements.filter(element => {
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && (box.left < -1 || box.right > innerWidth + 1);
  }).map(element => element.className));
  expect(outside).toEqual([]);
}

for (const theme of ['dark', 'light']) {
  test(`${theme}: library, editable note, saved history and dialogs`, async ({page}) => {
    const {host, errors} = await openWorkspace(page, {theme});
    try {
      await assertContained(page);
      await expect(page.locator('.nb-list-actions .nb-compact-tools')).toBeHidden();
      await assertReadableSurface(page, theme);
      await capture(page, `library-${theme}`);
      await page.getByRole('button', {name: '列表视图', exact: true}).click();
      await expect(page.locator('.nb-workspace')).toHaveClass(/layout-list/);
      await page.getByRole('button', {name: '卡片视图', exact: true}).click();
      await page.locator('.nb-note-row').filter({hasText: '让想法慢慢成形'}).click();
      await expect(page.locator('.nb-title-input')).toHaveValue('让想法慢慢成形');
      await page.locator('.nb-title-input').fill('让想法慢慢成形 · 已整理');
      await expect.poll(async () => (await host.tool('manage_notes', {action: 'get', id: host.notes[0].id})).note.title).toBe('让想法慢慢成形 · 已整理');
      await page.getByRole('button', {name: '保存', exact: true}).click();
      await expect(page.getByText('已保存并创建版本快照', {exact: true})).toBeVisible();
      await assertContained(page);
      await assertReadableSurface(page, theme, '.nb-coauthor-empty', 'h2', 'p');
      expect(await page.locator('.nb-list-panel .nb-note-row').evaluateAll(rows => rows.filter(row => row.querySelector('.nb-note-row-meta').getBoundingClientRect().bottom > row.getBoundingClientRect().bottom + 1).length)).toBe(0);
      await capture(page, `editor-${theme}`);
      if (theme === 'dark') {
        await page.getByRole('button', {name: '进入专注模式', exact: true}).click();
        await page.getByRole('button', {name: '显示文档目录', exact: true}).click();
        await expect(page.locator('.nb-outline-link')).toHaveCount(2);
        await capture(page, 'focus-dark');
        await page.getByRole('button', {name: '收起文档目录', exact: true}).click();
        await page.getByRole('button', {name: '退出专注模式', exact: true}).click();
      }
      await page.getByRole('button', {name: '历史版本', exact: true}).click();
      await expect(page.locator('.nb-history-dialog')).toBeVisible();
      await expect(page.locator('.nb-version').first()).toBeVisible();
      await capture(page, `history-${theme}`);
      await page.keyboard.press('Escape');
      await expect(page.locator('.nb-history-dialog')).toHaveCount(0);
      await page.getByRole('button', {name: '返回列表', exact: true}).click();
      await page.locator('.nb-category-foot').getByRole('button', {name: '设置', exact: true}).click();
      await expect(page.locator('.nb-settings-dialog')).toBeVisible();
      await expect(page.locator('.nb-settings-dialog .em-font-select')).toBeVisible();
      await capture(page, `settings-${theme}`);
      await page.locator('.nb-settings-nav').getByRole('button', {name: '笔记存储位置', exact: true}).click();
      await expect(page.locator('.nb-storage-path')).toBeEnabled();
      expect(await page.locator('.nb-settings-dialog').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1)).toBe(true);
      await capture(page, `storage-${theme}`);
      await page.keyboard.press('Escape');
      await expect(page.locator('.nb-settings-dialog')).toHaveCount(0);
      expect(errors).toEqual([]);
    } finally { await page.evaluate(() => window.__disposeFixture?.()).catch(() => {}); await host.close(); }
  });
}

test('mobile: navigation, note editing, coauthor switching and native isolation', async ({page}) => {
  const {host, errors} = await openWorkspace(page, {width: 390, height: 844});
  try {
    await assertContained(page);
    await page.locator('.nb-list-actions').getByRole('button', {name: '设置', exact: true}).click();
    await expect(page.locator('.nb-settings-dialog')).toBeVisible();
    await page.locator('.nb-settings-nav').getByRole('button', {name: '笔记存储位置', exact: true}).click();
    await expect(page.locator('.nb-storage-path')).toBeEnabled();
    await page.keyboard.press('Escape');
    await expect(page.locator('.nb-settings-dialog')).toHaveCount(0);
    await capture(page, 'mobile-library');
    await page.locator('.nb-note-row').filter({hasText: '让想法慢慢成形'}).click();
    await expect(page.locator('.nb-title-input')).toBeVisible();
    await expect(page.locator('.nb-editor-head').getByRole('button', {name: '目录', exact: true})).toBeVisible();
    await assertContained(page);
    await capture(page, 'mobile-editor');
    await page.getByRole('button', {name: '进入专注模式', exact: true}).click();
    await expect(page.getByRole('button', {name: '退出专注模式', exact: true})).toBeVisible();
    await expect(page.locator('.nb-title-input')).toBeVisible();
    await page.getByRole('button', {name: '退出专注模式', exact: true}).click();
    await page.getByRole('button', {name: '打开 / 收起共创', exact: true}).click();
    await expect(page.locator('.nb-coauthor')).toBeVisible();
    await expect(page.locator('.nb-main-left')).toBeHidden();
    await page.getByRole('button', {name: '开始共创', exact: true}).click();
    await expect(page.getByTestId('native-conversation')).toBeVisible();
    const native = page.getByRole('textbox', {name: 'Native conversation input'});
    await expect(native).toHaveCSS('border-top-width', '3px');
    await expect(native).toHaveCSS('border-radius', '3px');
    await expect(native).toHaveCSS('background-color', 'rgb(39, 42, 46)');
    await native.fill('保留这段会话草稿');
    await native.evaluate(element => { window.__retainedNativeInput = element; });
    await page.getByRole('button', {name: '收起共创', exact: true}).click();
    await expect(page.locator('.nb-title-input')).toBeVisible();
    await page.getByRole('button', {name: '进入专注模式', exact: true}).click();
    await expect(page.getByTestId('native-conversation')).toBeHidden();
    await page.getByRole('button', {name: '打开 / 收起共创', exact: true}).click();
    await expect(native).toBeVisible();
    await expect(native).toHaveValue('保留这段会话草稿');
    expect(await native.evaluate(element => window.__retainedNativeInput === element)).toBe(true);
    await page.getByRole('button', {name: '收起共创', exact: true}).click();
    await page.locator('.nb-editor-head').getByRole('button', {name: '目录', exact: true}).click();
    await page.getByRole('button', {name: '返回列表', exact: true}).click();
    await expect(page.locator('.nb-note-row')).toHaveCount(6);
    expect(errors).toEqual([]);
  } finally { await page.evaluate(() => window.__disposeFixture?.()).catch(() => {}); await host.close(); }
});

test('new note, Markdown editing and typography keep working', async ({page}) => {
  const {host, errors} = await openWorkspace(page);
  try {
    await page.locator('.nb-new').click();
    await expect(page.locator('.nb-title-input')).toHaveValue('未命名笔记');
    await page.locator('.nb-title-input').fill('新写下的一页');
    await sourceContent(page).click();
    await page.keyboard.insertText('# 新的一页\n\n保留这段想法。');
    await expect.poll(async () => (await host.tool('manage_notes', {action: 'list', query: '新写下的一页'})).total).toBe(1);
    const saved = (await host.tool('manage_notes', {action: 'list', query: '新写下的一页'})).notes[0];
    await expect.poll(async () => (await host.tool('manage_notes', {action: 'get', id: saved.id})).note.content).toBe('# 新的一页\n\n保留这段想法。');
    await page.getByRole('button', {name: '返回列表', exact: true}).click();
    await expect(page.locator('.nb-note-row')).toHaveCount(7);
    await page.locator('.nb-category-foot').getByRole('button', {name: '设置', exact: true}).click();
    await page.locator('.nb-settings-dialog .em-font-select').selectOption('serif');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('dsh-note.appearance.v1')).fontFamily)).toBe('serif');
    await page.locator('.nb-settings-segment').getByRole('button', {name: '列表视图'}).click();
    await expect(page.locator('.nb-workspace')).toHaveClass(/layout-list/);
    await page.keyboard.press('Escape');
    await expect(page.locator('.nb-settings-dialog')).toHaveCount(0);
    await page.locator('.nb-note-row').filter({hasText: '新写下的一页'}).click();
    await expect(sourceContent(page)).toHaveCSS('font-family', /Noto Serif SC/);
    await expect(page.locator('.nb-title-input')).toHaveCSS('font-family', /Noto Serif SC/);
    expect(errors).toEqual([]);
  } finally { await page.evaluate(() => window.__disposeFixture?.()).catch(() => {}); await host.close(); }
});

test('search, source navigation and binary attachment remain functional', async ({page}) => {
  const {host, errors} = await openWorkspace(page);
  try {
    await page.getByRole('button', {name: '检索', exact: true}).click();
    await page.getByPlaceholder('输入关键词或原文片段…').fill('想法');
    await expect(page.locator('.nb-context-result').first()).toBeVisible();
    await page.locator('.nb-context-result').filter({hasText: '让想法慢慢成形'}).first().click();
    await expect(page.locator('.nb-context-raw')).toContainText('想法');
    await capture(page, 'search-dark');
    await page.getByRole('button', {name: '打开原文', exact: true}).click();
    await expect(page.locator('.nb-title-input')).toHaveValue('让想法慢慢成形');
    await page.locator('.tm-attachments input[type=file]').setInputFiles({name: '阅读片段.txt', mimeType: 'text/plain', buffer: Buffer.from('Exact attachment\r\n原文')});
    await expect(page.locator('.att-name')).toHaveText('阅读片段.txt');
    const list = await host.tool('manage_note_attachments', {action: 'list', ownerId: host.notes[0].id});
    expect(list.total).toBe(1);
    const response = await host.fetch('https://notebook.test' + list.attachments[0].url);
    expect(await response.text()).toBe('Exact attachment\r\n原文');
    const beforeInsert = await sourceRaw(page);
    await sourceEditor(page).evaluate(element => { window.__attachmentSourceDOM = element; });
    await page.locator('.att-row').getByRole('button', {name: /插入/}).click();
    await expect.poll(async () => (await host.tool('manage_notes', {action: 'get', id: host.notes[0].id})).note.content).toContain('阅读片段.txt');
    const inserted = await sourceRaw(page);
    await enterSource(page);await sourceContent(page).focus();await page.keyboard.press('Control+z');
    await expect.poll(() => sourceRaw(page)).toBe(beforeInsert);
    await page.keyboard.press('Control+Shift+Z');
    await expect.poll(() => sourceRaw(page)).toBe(inserted);
    expect(await sourceEditor(page).evaluate(element => element === window.__attachmentSourceDOM)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await page.evaluate(() => window.__disposeFixture?.()).catch(() => {}); await host.close(); }
});

test('collection sections and category navigation preserve page records', async ({page}) => {
  const {host, errors} = await openWorkspace(page);
  try {
    await expect(page.locator('[data-section=pinned] .nb-note-row')).toHaveCount(1);
    await expect(page.locator('[data-section=recent] .nb-note-row')).toHaveCount(5);
    const width = await page.locator('.nb-note-row').first().evaluate(element => element.getBoundingClientRect().width);
    expect(width).toBeGreaterThanOrEqual(300);
    await page.locator('.nb-categories .nb-directory-folder').getByRole('button',{name:'阅读笔记',exact:true}).click();
    await expect(page.locator('.nb-note-row')).toHaveCount(2);
    await page.locator('.nb-categories').getByRole('button', {name: '全部笔记', exact: true}).click();
    await expect(page.locator('.nb-note-row')).toHaveCount(6);
    await assertContained(page);
    expect(errors).toEqual([]);
  } finally { await page.evaluate(() => window.__disposeFixture?.()).catch(() => {}); await host.close(); }
});

test('focus mode and document outline navigate preview and raw CRLF source without losing edits', async ({page}) => {
  const {host, errors} = await openWorkspace(page);
  try {
    const content = '# 开始🙂\r\n\r\n' + '留一段阅读的空白。\r\n\r\n'.repeat(35) + '这是一段会自动折行的长正文。'.repeat(400) + '\r\n\r\n## 第二节\r\n\r\n' + '继续记录。\r\n\r\n'.repeat(35) + '## 最后的问题\r\n\r\n慢慢想。';
    await host.tool('manage_notes', {action: 'update', id: host.notes[0].id, revision: 1, content});
    await page.locator('.nb-note-row').filter({hasText: '让想法慢慢成形'}).click();
    await page.getByRole('button', {name: '进入专注模式', exact: true}).click();
    await expect(page.locator('.nb-workspace')).toHaveClass(/is-focused/);
    await expect(page.locator('.nb-list-panel')).toBeHidden();
    await expect(page.locator('.nb-categories')).toBeHidden();
    await expect(page.locator('.nb-coauthor')).toBeHidden();
    await expect(page.locator('.nb-document-outline')).toBeHidden();
    await page.getByRole('button', {name: '显示文档目录', exact: true}).click();
    await expect(page.locator('.nb-document-outline')).toBeVisible();
    await expect(page.locator('.nb-outline-link')).toHaveCount(3);
    await page.locator('.nb-outline-link').getByText('最后的问题', {exact: true}).click();
    await expect(sourceContent(page)).toBeFocused();
    expect((await sourceState(page)).selection).toBe(content.slice(0, content.indexOf('## 最后的问题')).replace(/\r\n?/g, '\n').length);
    await capture(page, 'outline-long-document');
      await page.locator('.nb-outline-link').getByText('第二节', {exact: true}).click();
    const source = sourceContent(page);
    await expect(source).toBeFocused();
    expect((await sourceState(page)).selection).toBe(content.slice(0, content.indexOf('## 第二节')).replace(/\r\n?/g, '\n').length);
    expect(await page.locator('.nb-document-stage').evaluate(element => element.scrollTop / element.scrollHeight)).toBeGreaterThan(.4);
    expect(await sourceRaw(page)).toBe(content);
    expect((await host.tool('manage_notes', {action: 'get', id: host.notes[0].id})).note.content).toBe(content);
    const edited = content + '\r\n本地补充';
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.insertText('本地补充');
    await page.getByRole('button', {name: '退出专注模式', exact: true}).click();
    await expect.poll(() => sourceRaw(page)).toBe(edited);
    await expect(page.locator('.nb-list-panel')).toBeVisible();
    await expect.poll(async () => (await host.tool('manage_notes', {action: 'get', id: host.notes[0].id})).note.content).toBe(edited);
    await assertContained(page);
    expect(errors).toEqual([]);
  } finally { await page.evaluate(() => window.__disposeFixture?.()).catch(() => {}); await host.close(); }
});

test('normal host window gives actual note rows and document the available width', async ({page}) => {
  const {host, errors} = await openWorkspace(page, {theme: 'light', width: 1919, height: 1033, shell: true, chatOpen: false});
  try {
    const content = '# 阅读与整理\n\n把正文、笔记摘要和操作放到真正可用的位置。\n\n## 符号与含义\n\n| 符号 | 含义 | 用途 | 核对方式 |\n| --- | --- | --- | --- |\n| $q$ | 当前采样分布 | 行为概率、有效样本统计 | 对照实际采样记录 |\n| $p_0$ | 参考检查点 | 比较训练前后的变化 | 明确保存的版本 |\n| $p_\\theta$ | 正在更新的模型 | 当前优化对象 | 对照训练状态 |\n\n## 关键关系\n\n$$r=\\frac{p_\\theta}{q}, \\quad r_0=\\frac{p_\\theta}{p_0}$$\n\n正文直接使用剩余宽度；表格、公式和长段落不会被额外的居中容器挤在中间。\n\n## 继续阅读\n\n' + '保持内容连续，按需展开辅助信息。\n\n'.repeat(12);
    await host.tool('manage_notes', {action: 'update', id: host.notes[0].id, revision: 1, content});
    await page.locator('.nb-note-row').filter({hasText: '让想法慢慢成形'}).click();
    await expect(page.locator('.nb-title-input')).toBeVisible();
    await expect(page.locator('.nb-categories')).toBeHidden();
    await expect(page.locator('.nb-document-outline')).toBeHidden();
    await expect(page.locator('.nb-title-input')).toHaveValue('让想法慢慢成形');
    await expect(page.locator('.nb-directory-panel')).toBeVisible();
    await capture(page, 'normal-host-window');
    const geometry = await page.evaluate(() => {
      const rect = selector => document.querySelector(selector).getBoundingClientRect();
      const list = rect('.nb-list-panel'), stage = rect('.nb-document-stage'), documentBox = rect('.nb-document');
      return {list: list.width, stage: stage.width, editor: rect('.nb-editor').width, document: documentBox.width, inset: documentBox.left - stage.left};
    });
    console.log('Normal host geometry', geometry);
    expect(geometry.list).toBeGreaterThan(240);
    expect(geometry.document / geometry.stage).toBeGreaterThan(.9);
    expect(geometry.inset).toBeLessThan(8);
    expect(geometry.document / geometry.editor).toBeGreaterThan(.9);
    await page.getByRole('button', {name: '显示文档目录', exact: true}).click();
    await expect(page.locator('.nb-document-outline')).toBeVisible();
    await capture(page, 'normal-host-outline');
    await page.keyboard.press('Escape');
    await expect(page.locator('.nb-document-outline')).toBeHidden();
    await page.setViewportSize({width: 1180, height: 850});
    const widthBefore = await page.locator('.nb-document-stage').evaluate(element => element.clientWidth);
    await page.getByRole('button', {name: '显示文档目录', exact: true}).click();
    await expect(page.locator('.nb-document-outline')).toBeVisible();
    expect(await page.locator('.nb-document-stage').evaluate(element => element.clientWidth)).toBe(widthBefore);
    await page.keyboard.press('Escape');
    await assertContained(page);
    expect(errors).toEqual([]);
  } finally { await page.evaluate(() => window.__disposeFixture?.()).catch(() => {}); await host.close(); }
});

test('custom parent and child categories classify notes, rename safely and survive a page reload', async ({page}) => {
  const {host, errors} = await openWorkspace(page, {chatOpen: false});
  try {
    let dialog = await categoryManager(page);
    await addCategory(dialog, '研究');
    const parent = (await categoryTree(host)).items.find(item => item.name === '研究');
    await dialog.getByRole('button', {name: '新增子分类 研究', exact: true}).click();
    await addCategory(dialog, '论文', parent.id);
    const child = (await categoryTree(host)).items.find(item => item.name === '论文');
    expect(child.parentId).toBe(parent.id);
    await capture(page, 'categories-desktop');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    const original = (await host.tool('manage_notes', {action: 'get', id: host.notes[0].id})).note;
    await host.tool('manage_notes', {action: 'update', id: host.notes[0].id, revision: original.revision, category: child.id});
    const assigned = (await host.tool('manage_notes', {action: 'get', id: host.notes[0].id})).note;
    expect(assigned.category).toBe(child.id);
    expect(assigned.content).toBe(original.content);
    dialog = await categoryManager(page);
    await dialog.locator('.nb-cat-select').filter({hasText: /^论文$/}).click();
    await dialog.getByRole('textbox', {name: '重命名', exact: true}).fill('论文阅读');
    await dialog.locator('form').filter({has: dialog.page().getByRole('textbox', {name: '重命名', exact: true})}).getByRole('button', {name: '保存', exact: true}).click();
    await expect(dialog.locator('.nb-cat-select').filter({hasText: /^论文阅读$/})).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.nb-note-row').filter({hasText: '让想法慢慢成形'})).toContainText('论文阅读');
    expect((await host.tool('manage_notes', {action: 'get', id: host.notes[0].id})).note.revision).toBe(assigned.revision);
    await page.locator('.nb-sidebar-directory .nb-directory-folder').getByRole('button',{name:'研究',exact:true}).click();
    await expect(page.locator('.nb-note-row')).toHaveCount(1);
    await expect(page.locator('.nb-list-heading')).toContainText('研究');
    await page.evaluate(() => window.__disposeFixture?.());
    await page.reload();
    await page.addScriptTag({path: root + '.build/browser-host.js'});
    await page.addScriptTag({path: root + 'client.js'});
    await expect(page.locator('.nb-note-row')).toHaveCount(6);
    await page.locator('.nb-categories').getByRole('button',{name:'展开分类 研究',exact:true}).click();
    await expect(page.locator('.nb-categories .nb-directory-panel')).toContainText('论文阅读');
    await expect(page.locator('.nb-note-row').filter({hasText: '让想法慢慢成形'})).toContainText('论文阅读');
    dialog = await categoryManager(page);
    const longName = '深度研究'.repeat(18);
    await addCategory(dialog, longName);
    await page.keyboard.press('Escape');
    await page.locator('.nb-categories .nb-directory-folder').getByRole('button',{name:longName,exact:true}).click();
    await expect(page.locator('.nb-note-row')).toHaveCount(0);
    await page.locator('.nb-list-actions').getByRole('button', {name: '新建笔记', exact: true}).click();
    await expect(page.locator('.nb-title-input')).toHaveValue('未命名笔记');
    const longId = (await categoryTree(host)).items.find(item => item.name === longName).id;
    await expect.poll(async () => (await host.tool('manage_notes', {action: 'list', category: longId})).total).toBe(1);
    const overflow = await page.locator('.nb-editor-head, .nb-properties, .nb-list-heading h2').evaluateAll(nodes => nodes.filter(node => node.scrollWidth > node.clientWidth + 1).length);
    expect(overflow).toBe(0);
    await assertContained(page);
    expect(errors).toEqual([]);
  } finally { await page.evaluate(() => window.__disposeFixture?.()).catch(() => {}); await host.close(); }
});

test('native category dragging reorders siblings, nests subtrees and moves them to root', async ({page}) => {
  const {host, errors} = await openWorkspace(page);
  try {
    const dialog = await categoryManager(page);
    await addCategory(dialog, '收集');
    await addCategory(dialog, '项目');
    const a = (await categoryTree(host)).items.find(item => item.name === '收集');
    const b = (await categoryTree(host)).items.find(item => item.name === '项目');
    await addCategory(dialog, '子项', a.id);
    const child = (await categoryTree(host)).items.find(item => item.name === '子项');
    const row = name => dialog.locator('.nb-cat-manager-row').filter({has: page.getByRole('button', {name, exact: true})});
    await dialog.getByRole('button', {name: '拖动分类 项目', exact: true}).dragTo(row('收集'), {targetPosition: {x: 80, y: 2}});
    await expect.poll(async () => {
      const items = (await categoryTree(host)).items;
      return items.find(item => item.id === b.id).order < items.find(item => item.id === a.id).order;
    }).toBe(true);
    const target = await row('项目').boundingBox();
    await dialog.getByRole('button', {name: '拖动分类 收集', exact: true}).dragTo(row('项目'), {targetPosition: {x: 80, y: target.height / 2}});
    await expect.poll(async () => (await categoryTree(host)).items.find(item => item.id === a.id).parentId).toBe(b.id);
    expect((await categoryTree(host)).items.find(item => item.id === child.id).parentId).toBe(a.id);
    await dialog.getByRole('button', {name: '拖动分类 收集', exact: true}).dragTo(dialog.locator('.nb-cat-root-drop'));
    await expect.poll(async () => (await categoryTree(host)).items.find(item => item.id === a.id).parentId).toBe(null);
    await capture(page, 'categories-dragged');
    await assertContained(page);
    expect(errors).toEqual([]);
  } finally { await page.evaluate(() => window.__disposeFixture?.()).catch(() => {}); await host.close(); }
});

test('mobile category management supports non-drag moves and recovers concurrent edits', async ({page}) => {
  const {host, errors} = await openWorkspace(page, {width: 390, height: 844});
  try {
    const dialog = await categoryManager(page);
    await host.tool('manage_note_categories', {action: 'create', revision: 0, name: '外部分类', parentId: null});
    await dialog.getByRole('textbox', {name: '分类名称', exact: true}).fill('本地分类');
    const form = dialog.locator('form').filter({has: dialog.page().getByRole('textbox', {name: '分类名称', exact: true})});
    await form.getByRole('button', {name: '新增分类', exact: true}).click();
    await expect(dialog.getByRole('alert')).toContainText('其他窗口');
    await expect(form.getByRole('textbox', {name: '分类名称', exact: true})).toHaveValue('本地分类');
    await form.getByRole('button', {name: '新增分类', exact: true}).click();
    await expect(dialog.locator('.nb-cat-select').filter({hasText: /^本地分类$/})).toBeVisible();
    await dialog.locator('.nb-cat-select').filter({hasText: /^本地分类$/}).click();
    await dialog.getByRole('button', {name: '上移', exact: true}).click();
    const local = (await categoryTree(host)).items.find(item => item.name === '本地分类');
    const selected = dialog.locator('.nb-cat-selected');
    await selected.getByRole('combobox', {name: '父分类', exact: true}).selectOption('reading');
    await selected.getByRole('button', {name: '移至所选父分类末尾', exact: true}).click();
    await expect.poll(async () => (await categoryTree(host)).items.find(item => item.id === local.id).parentId).toBe('reading');
    await expect(dialog.locator('.nb-cat-header').getByRole('button', {name: '关闭', exact: true})).toBeInViewport({ratio: 1});
    await expect(dialog.locator('.nb-cat-footer').getByRole('button', {name: '关闭', exact: true})).toBeInViewport({ratio: 1});
    await capture(page, 'categories-mobile');
    const box = await dialog.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(391);
    await page.keyboard.press('Escape');
    await expect(page.locator('.nb-mobile-category option[value="' + local.id + '"]')).toContainText('本地分类');
    await assertContained(page);
    expect(errors).toEqual([]);
  } finally { await page.evaluate(() => window.__disposeFixture?.()).catch(() => {}); await host.close(); }
});

test('host theme markers work without a color-scheme declaration', async ({page}) => {
  const {host, errors} = await openWorkspace(page, {theme: 'dark', colorScheme: 'normal'});
  try {
    await assertReadableSurface(page, 'dark');
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await assertReadableSurface(page, 'light');
    expect(errors).toEqual([]);
  } finally { await page.evaluate(() => window.__disposeFixture?.()).catch(() => {}); await host.close(); }
});

test('forced colors keeps selected tabs and keyboard focus identifiable', async ({page}) => {
  const {host, errors} = await openWorkspace(page, {width: 1024, height: 768});
  try {
    await page.emulateMedia({forcedColors: 'active'});
    const selected = page.locator('.nb-workspace-tab[aria-pressed=true]');
    await expect(selected).toHaveCSS('outline-style', 'solid');
    await selected.focus();
    await expect(selected).toBeFocused();
    await assertContained(page);
    await capture(page, 'library-forced-colors');
    expect(errors).toEqual([]);
  } finally { await page.evaluate(() => window.__disposeFixture?.()).catch(() => {}); await host.close(); }
});

test('CodeMirror keeps raw mixed newlines, view identity, native search and slash commands', async ({page}) => {
  const {host, errors} = await openWorkspace(page, {chatOpen: false});
  try {
    const raw = '# 原始🙂\r\n\r\n- [ ] 原始任务\r\nfirst line\nsecond line\rfinal';
    await host.tool('manage_notes', {action: 'update', id: host.notes[0].id, revision: 1, content: raw});
    await page.locator('.nb-note-row').filter({hasText: '让想法慢慢成形'}).click();
    await enterSource(page);
    await sourceEditor(page).evaluate(element => { window.__originalSourceView = element.__noteEditorView; window.__originalSourceDOM = element; });
    await sourceContent(page).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('X');
    await expect.poll(() => sourceRaw(page)).toBe(raw + 'X');
    await page.keyboard.press('Control+z');
    await expect.poll(() => sourceRaw(page)).toBe(raw);
    await page.keyboard.press('Control+y');
    await expect.poll(() => sourceRaw(page)).toBe(raw + 'X');
    expect(await sourceEditor(page).evaluate(element => element === window.__originalSourceDOM && element.__noteEditorView === window.__originalSourceView)).toBe(true);
    // Synthetic events exercise our composition guards; this is not an OS IME test.
    const composition = await sourceContent(page).evaluate(element => {
      element.dispatchEvent(new CompositionEvent('compositionstart', {bubbles: true, data: '中'}));
      const key = new KeyboardEvent('keydown', {key: 'b', code: 'KeyB', ctrlKey: true, isComposing: true, bubbles: true, cancelable: true});
      element.dispatchEvent(key);
      element.dispatchEvent(new CompositionEvent('compositionend', {bubbles: true, data: '中'}));
      return {prevented: key.defaultPrevented, raw: element.closest('.cm-editor').__noteEditorHandle.value};
    });
    expect(composition).toEqual({prevented: false, raw: raw + 'X'});
    await page.keyboard.press('Control+b');
    await expect.poll(() => sourceRaw(page)).toBe(raw + 'X****');
    await page.keyboard.press('Control+b');
    await expect.poll(() => sourceRaw(page)).toBe(raw + 'X');
    await page.keyboard.press('Tab');
    await expect.poll(() => sourceRaw(page)).toMatch(/\r[ \t]+finalX$/);
    await page.keyboard.press('Shift+Tab');
    await expect.poll(() => sourceRaw(page)).toBe(raw + 'X');
    await page.keyboard.press('Control+f');
    const find = page.locator('.cm-search input[name=search]');
    await expect(find).toBeFocused();
    await find.fill('second');
    await find.press('ArrowRight');
    await page.locator('.cm-search button[name=next]').click();
    expect(await sourceEditor(page).evaluate(element => { const {state} = element.__noteEditorView, selection = state.selection.main; return state.sliceDoc(selection.from, selection.to); })).toBe('second');
    await expect(page.locator('.cm-search input[name=replace]')).toBeVisible();
    await page.locator('.cm-search button[name=close]').click();
    await sourceContent(page).focus();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('/');
    await expect(page.locator('.cm-tooltip-autocomplete')).toBeVisible();
    await page.locator('.cm-tooltip-autocomplete [role=option]').filter({hasText: 'Heading 2'}).click();
    await expect.poll(() => sourceRaw(page)).toBe(raw + 'X\r## ');
    expect(await sourceEditor(page).evaluate(element => element === window.__originalSourceDOM)).toBe(true);
    const completed = await sourceRaw(page);
    await sourceContent(page).focus();await page.keyboard.press('Control+z');
    await expect.poll(() => sourceRaw(page)).not.toBe(completed);
    // Uppercase Z mirrors the physical Shift+Z event. Lowercase z here makes
    // Playwright send key='z' with shiftKey=true, which CM treats as Ctrl+Z.
    await page.keyboard.press('Control+Shift+Z');
    await expect.poll(() => sourceRaw(page)).toBe(completed);
    await expect(page.locator('.em-md-modes')).toHaveCount(0);
    await expect(sourceContent(page)).toBeVisible();
    await expect(page.locator('.nb-preview-pane')).toHaveCount(0);
    await sourceContent(page).focus();await page.keyboard.press('Control+End');await page.keyboard.type('LIVE');
    await expect(page.locator('.nb-live-h2')).toHaveText('LIVE');
    await page.locator('.nb-source-editor input.task-list-item-checkbox').check();
    await expect.poll(() => sourceRaw(page)).toBe((completed + 'LIVE').replace('- [ ] 原始任务', '- [x] 原始任务'));
    expect(await sourceEditor(page).evaluate(element => element === window.__originalSourceDOM)).toBe(true);
    const live = completed + 'LIVE', checked = live.replace('- [ ] 原始任务', '- [x] 原始任务');
    await expect(sourceContent(page)).not.toBeFocused();
    await expect(page.locator('.nb-source-editor input.task-list-item-checkbox')).toBeFocused();
    await page.keyboard.press('Control+z');
    await expect.poll(() => sourceRaw(page)).toBe(live);
    await expect(page.locator('.nb-source-editor input.task-list-item-checkbox')).toBeFocused();
    await expect(page.locator('.nb-source-editor input.task-list-item-checkbox')).not.toBeChecked();
    await page.keyboard.press('Control+Shift+Z');
    await expect.poll(() => sourceRaw(page)).toBe(checked);
    await page.keyboard.press('Control+z');await page.keyboard.press('Control+z');
    await expect.poll(() => sourceRaw(page)).toBe(completed);
    await page.keyboard.press('Control+Shift+Z');await page.keyboard.press('Control+Shift+Z');
    await expect.poll(() => sourceRaw(page)).toBe(checked);
    await expect(page.locator('.nb-source-editor input.task-list-item-checkbox')).toBeChecked();
    expect(await sourceEditor(page).evaluate(element => element === window.__originalSourceDOM)).toBe(true);
    await capture(page, 'codemirror-source');
    expect(errors).toEqual([]);
  } finally { await page.evaluate(() => window.__disposeFixture?.()).catch(() => {}); await host.close(); }
});

test('workspace shortcuts capture app commands and exclude native conversation and dialogs', async ({page}) => {
  const {host, errors} = await openWorkspace(page);
  try {
    await page.locator('.nb-search').focus();
    await page.keyboard.press('Control+p');
    const quick = page.getByRole('dialog', {name: '快速打开', exact: true});
    await expect(quick).toBeVisible();
    await quick.getByRole('searchbox').fill('异步任务的几个约定');
    // Enter is intentionally sent while the new query is still pending.
    await quick.getByRole('searchbox').press('Enter');
    await expect(page.locator('.nb-title-input')).toHaveValue('异步任务的几个约定');
    await page.locator('.nb-title-input').focus();
    await page.keyboard.press('Control+Shift+p');
    const commands = page.getByRole('dialog', {name: '命令面板', exact: true});
    await expect(commands).toBeVisible();
    await capture(page, 'commands-desktop');
    await commands.getByRole('searchbox').fill('快速打开');
    await commands.getByRole('searchbox').press('Enter');
    await expect(quick).toBeVisible();
    await expect(quick.getByRole('searchbox')).toHaveValue('');
    await page.keyboard.press('Escape');
    await page.locator('.nb-title-input').focus();
    await page.keyboard.press('Control+Shift+p');
    await expect(commands).toBeVisible();
    await expect(commands.getByRole('option').filter({hasText: '切换编辑与预览'})).toHaveCount(0);
    await commands.getByRole('searchbox').fill('文档内查找与替换');
    await commands.getByRole('searchbox').press('Enter');
    await expect(sourceContent(page)).toBeVisible();
    await sourceContent(page).focus();
    await page.keyboard.press('Control+/');
    const help = page.getByRole('dialog', {name: '快捷键', exact: true});
    await expect(help).toBeVisible();
    expect(await help.evaluate(element => {
      const event = new KeyboardEvent('keydown', {key: 'p', code: 'KeyP', ctrlKey: true, bubbles: true, cancelable: true});element.dispatchEvent(event);return event.defaultPrevented;
    })).toBe(false);
    await expect(page.locator('.nb-command-dialog')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await sourceContent(page).focus();
    const content = await sourceRaw(page);
    await page.route('https://notebook.test/api/**', async route => {
      let data;try { data = route.request().postDataJSON(); } catch {}
      if (data?.action === 'checkpoint') await new Promise(resolve => setTimeout(resolve, 200));
      return route.fallback();
    });
    const checkpoint = page.waitForRequest(request => {
      try { return request.postDataJSON()?.action === 'checkpoint'; } catch { return false; }
    });
    await page.keyboard.press('Control+s');await checkpoint;
    await page.keyboard.press('Control+End');await page.keyboard.type(' INFLIGHT');
    const edited = content + ' INFLIGHT';
    await expect.poll(() => sourceRaw(page)).toBe(edited);
    await expect(page.getByText('已保存并创建版本快照', {exact: true})).toBeVisible();
    expect(await sourceRaw(page)).toBe(edited);
    await expect.poll(async () => (await host.tool('manage_notes', {action: 'get', id: host.notes[3].id})).note.content).toBe(edited);
    await sourceContent(page).focus();
    await page.keyboard.press('Control+e');
    await expect(page.locator('.nb-writing-field')).toHaveClass(/is-live/);
    await page.locator('.nb-title-input').focus();
    await page.keyboard.press('Control+e');
    await expect(sourceContent(page)).toBeVisible();
    await page.getByRole('button', {name: '开始共创', exact: true}).click();
    const native = page.getByRole('textbox', {name: 'Native conversation input'});
    await native.fill('native draft');
    expect(await native.evaluate(element => {
      const event = new KeyboardEvent('keydown', {key: 'p', code: 'KeyP', ctrlKey: true, bubbles: true, cancelable: true});element.dispatchEvent(event);return event.defaultPrevented;
    })).toBe(false);
    await expect(page.locator('.nb-command-dialog')).toHaveCount(0);
    await expect(native).toHaveValue('native draft');
    expect(errors).toEqual([]);
  } finally { await page.evaluate(() => window.__disposeFixture?.()).catch(() => {}); await host.close(); }
});

test('library sidebar reuses the directory for categories, note opening, dragging and deletion',async({page})=>{
 const {host,errors}=await openWorkspace(page,{width:915,height:789,chatOpen:false});
 try{
  const panel=page.locator('.nb-directory-panel');
  await expect(panel).toHaveCount(1);await expect(page.locator('.nb-categories .nb-directory-panel')).toBeVisible();
  await expect(page.locator('.nb-category-navigation')).toHaveCount(0);
  await panel.getByRole('button',{name:'文档',exact:true}).click();
  await expect(page.locator('.nb-list-heading')).toContainText('文档');await expect(page.locator('.nb-note-row')).toHaveCount(2);
  await expect(panel.locator('.nb-directory-file')).toHaveCount(2);
  await panel.getByRole('button',{name:'分类操作 文档',exact:true}).click();
  await panel.getByRole('menuitem',{name:'新增子分类',exact:true}).click();
  await panel.locator('.nb-directory-form input').fill('共享目录子分类');
  await panel.locator('.nb-directory-form').getByRole('button',{name:'保存',exact:true}).click();
  const child=(await categoryTree(host)).items.find(item=>item.name==='共享目录子分类');
  const reading=panel.locator('.nb-directory-folder').filter({has:page.getByRole('button',{name:'阅读笔记',exact:true})});
  await panel.getByRole('button',{name:'拖动分类 共享目录子分类',exact:true}).dragTo(reading,{targetPosition:{x:95,y:16}});
  await expect.poll(async()=>(await categoryTree(host)).items.find(item=>item.id===child.id).parentId).toBe('reading');
  await expect(panel.getByRole('button',{name:'折叠分类 阅读笔记',exact:true})).toBeVisible();
  await panel.getByRole('button',{name:'分类操作 共享目录子分类',exact:true}).click();
  await panel.getByRole('menuitem',{name:'删除分类',exact:true}).click();
  await page.getByRole('dialog',{name:'删除分类 · 共享目录子分类',exact:true}).getByRole('button',{name:'确认删除分类',exact:true}).click();
  await expect(panel.getByRole('button',{name:'分类操作 共享目录子分类',exact:true})).toHaveCount(0);
  await panel.locator('.nb-directory-file').getByRole('button',{name:'让想法慢慢成形',exact:true}).click();
  await expect(page.locator('.nb-title-input')).toHaveValue('让想法慢慢成形');await expect(panel).toHaveCount(1);
  await expect(panel.getByRole('button',{name:'折叠分类 阅读笔记',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'返回列表',exact:true}).click();
  await expect(page.locator('.nb-categories .nb-directory-panel')).toBeVisible();await expect(panel).toHaveCount(1);
  await expect(panel.getByRole('button',{name:'折叠分类 阅读笔记',exact:true})).toBeVisible();
  await capture(page,'library-shared-directory');await assertContained(page);expect(errors).toEqual([]);
 }finally{await page.evaluate(()=>window.__disposeFixture?.()).catch(()=>{});await host.close();}
});

test('directory lazy loading, note/category dragging, guarded undo and mobile navigation retain the editor', async ({page}) => {
  const {host, errors} = await openWorkspace(page, {chatOpen: false});
  try {
    await page.locator('.nb-note-row').filter({hasText: '让想法慢慢成形'}).click();
    await enterSource(page);
    const original = await sourceRaw(page);
    await sourceEditor(page).evaluate(element => { window.__directorySourceDOM = element; });
    const panel = page.locator('.nb-directory-panel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.nb-directory-file')).toHaveCount(0);
    await panel.getByRole('button', {name: '展开分类 文档', exact: true}).click();
    await expect(panel.locator('.nb-directory-file')).toHaveCount(2);
    const addRoot = async name => {
      await panel.getByRole('button', {name: '新增根分类', exact: true}).click();
      await panel.locator('.nb-directory-form input').fill(name);
      await panel.locator('.nb-directory-form').getByRole('button', {name: '保存', exact: true}).click();
      await expect(panel.locator('.nb-directory-folder .nb-directory-title').filter({hasText: name})).toHaveCount(1);
    };
    await addRoot('验收项目');await addRoot('验收归档');
    const first = (await categoryTree(host)).items.find(item => item.name === '验收项目');
    const second = (await categoryTree(host)).items.find(item => item.name === '验收归档');
    await panel.getByRole('button', {name: '分类操作 验收项目', exact: true}).click();
    await panel.getByRole('menuitem', {name: '新增子分类', exact: true}).click();
    await panel.locator('.nb-directory-form input').fill('验收子项');
    await panel.locator('.nb-directory-form').getByRole('button', {name: '保存', exact: true}).click();
    await expect(panel.locator('.nb-directory-title').filter({hasText: '验收子项'})).toBeVisible();
    const child = (await categoryTree(host)).items.find(item => item.name === '验收子项');
    const folder = name => panel.locator('.nb-directory-folder').filter({has: page.locator('.nb-directory-name').filter({hasText: new RegExp('^' + name + '$')})});
    await panel.getByRole('button', {name: '拖动笔记到分类 让想法慢慢成形', exact: true}).dragTo(folder('验收项目'));
    await expect.poll(async () => (await host.tool('manage_notes', {action: 'get', id: host.notes[0].id})).note.category).toBe(first.id);
    await expect(page.locator('.nb-title-input')).toHaveValue('让想法慢慢成形');
    const archive = await folder('验收归档').boundingBox();
    await panel.getByRole('button', {name: '拖动分类 验收项目', exact: true}).dragTo(folder('验收归档'), {targetPosition: {x: 100, y: archive.height / 2}});
    await expect.poll(async () => (await categoryTree(host)).items.find(item => item.id === first.id).parentId).toBe(second.id);
    const beforeCycle = await categoryTree(host), target = await folder('验收子项').boundingBox();
    await panel.getByRole('button', {name: '拖动分类 验收归档', exact: true}).dragTo(folder('验收子项'), {targetPosition: {x: 100, y: target.height / 2}});
    expect((await categoryTree(host)).revision).toBe(beforeCycle.revision);
    expect((await categoryTree(host)).items.find(item => item.id === child.id).parentId).toBe(first.id);
    await panel.getByRole('button', {name: '撤销上次分类移动', exact: true}).click();
    await expect.poll(async () => (await categoryTree(host)).items.find(item => item.id === first.id).parentId).toBe(null);
    await capture(page, 'directory-desktop');
    await page.setViewportSize({width: 390, height: 844});
    await page.locator('.nb-editor-head').getByRole('button', {name: '目录', exact: true}).click();
    await expect(page.locator('.nb-workspace')).toHaveClass(/navigation-open/);
    await expect(panel).toBeVisible();
    await capture(page, 'directory-mobile');
    await page.getByRole('button', {name: '返回正文', exact: true}).click();
    await expect(sourceContent(page)).toBeVisible();
    expect(await sourceEditor(page).evaluate(element => element === window.__directorySourceDOM)).toBe(true);
    expect(await sourceRaw(page)).toBe(original);
    await assertContained(page);
    expect(errors).toEqual([]);
  } finally { await page.evaluate(() => window.__disposeFixture?.()).catch(() => {}); await host.close(); }
});

test('real IndexedDB retains exact offline drafts across stale-list opening and reload recovery', async ({page}) => {
  const {host, errors} = await openWorkspace(page, {chatOpen: false});
  try {
    const content = '# 离线🙂\r\n\r\n第一行\n第二行\r末尾';
    await host.tool('manage_notes', {action: 'update', id: host.notes[0].id, revision: 1, content});
    await page.route('https://notebook.test/api/**', route => {
      let data;try { data = route.request().postDataJSON(); } catch {}
      if (data?.action === 'update') return route.fulfill({status: 503, contentType: 'application/json', body: JSON.stringify({error: {code: 'UNAVAILABLE', message: 'Fixture offline'}})});
      return route.fallback();
    });
    await page.locator('.nb-note-row').filter({hasText: '让想法慢慢成形'}).click();
    await enterSource(page);await sourceContent(page).focus();await page.keyboard.press('Control+End');await page.keyboard.type(' OFFLINE');
    const first = content + ' OFFLINE';
    await expect.poll(async () => (await readDrafts(page)).find(record => record.noteId === host.notes[0].id)?.fields.content).toBe(first);
    await expect(page.locator('.nb-save-state')).toContainText('保存暂时失败');
    await expect(page.locator('.nb-drafts')).toBeVisible();
    await page.locator('.nb-drafts summary').click();
    await sourceContent(page).focus();await page.keyboard.press('Control+End');await page.keyboard.type(' LATEST');
    const latest = first + ' LATEST';
    await expect.poll(async () => (await readDrafts(page)).find(record => record.noteId === host.notes[0].id)?.fields.content).toBe(latest);
    // The title/list record has not changed with the body; reopening must read
    // the cache by identity instead of applying that old rendered record.
    await page.locator('.nb-drafts').getByRole('button', {name: '让想法慢慢成形', exact: true}).click();
    await enterSource(page);await expect.poll(() => sourceRaw(page)).toBe(latest);
    expect((await host.tool('manage_notes', {action: 'get', id: host.notes[0].id})).note.content).toBe(content);
    await page.evaluate(() => window.__disposeFixture?.());await page.reload();
    await page.addScriptTag({path: root + '.build/browser-host.js'});await page.addScriptTag({path: root + 'client.js'});
    await expect(page.locator('.nb-drafts')).toBeVisible();
    await page.locator('.nb-drafts summary').click();
    await page.locator('.nb-drafts').getByRole('button', {name: '让想法慢慢成形', exact: true}).click();
    await enterSource(page);await expect.poll(() => sourceRaw(page)).toBe(latest);
    expect((await readDrafts(page)).find(record => record.noteId === host.notes[0].id).fields.content).toBe(latest);
    expect(errors).toEqual([]);
  } finally { await page.evaluate(() => window.__disposeFixture?.()).catch(() => {}); await host.close(); }
});

test('topics: manual cross-note and discussion selection reads exact originals, orders links and preserves sources on deletion', async ({page}) => {
  const {host, errors} = await openWorkspace(page, {chatOpen: false, discussions: true});
  try {
    const seed = host.discussionSeed, question = '青岚校验灯的两份材料，哪些说明值得放在一起？';
    expect(host.notes).toHaveLength(6);expect((await host.api('topics', {action: 'list'})).total).toBe(0);
    const initialWrites = host.mutations.length, initialSessions = host.sessionCreations.length;
    await openTopics(page);
    await expect(topicsPanel(page).locator('.tp-topic-button')).toHaveCount(0);
    await expect(topicsPanel(page).getByText('从一个问题开始', {exact: true})).toBeVisible();
    expect(host.mutations.length).toBe(initialWrites);expect(host.sessionCreations.length).toBe(initialSessions);
    expect(host.native.queryCalls).toEqual([]);expect(host.native.readCalls).toEqual([]);
    const created = await createTopic(page, host, question), writesAfterCreate = host.mutations.length;
    expect(created.references).toEqual([]);expect(created.sessionId).toBeUndefined();
    const results = await searchTopicSources(page, seed.query);
    expect(results.discussionAvailable).toBe(true);
    expect(results.results.filter(result => result.reference.kind === 'note')).toHaveLength(2);
    const discussions = results.results.filter(result => result.reference.kind === 'discussion');
    expect(discussions).toHaveLength(4);
    expect(new Set(discussions.map(result => result.reference.sessionId)).size).toBe(2);
    expect(discussions.map(result => result.speaker).sort()).toEqual(['assistant', 'assistant', 'user', 'user']);
    expect(JSON.stringify(results.results)).not.toMatch(/PRIVATE|UNTRUSTED/);
    for (const [index, candidate] of results.results.entries()) {
      const read = await readTopicResult(page, index);
      expect(sourceReferenceKey(read.reference)).toBe(sourceReferenceKey(candidate.reference));
      if (candidate.reference.kind === 'discussion') {
        expect(read.content).toBe(seed.sourceTexts.get(`${candidate.reference.sessionId}:${candidate.reference.seq}`));
        expect(read.speaker).toBe(candidate.speaker);
        await expect(topicsPanel(page).locator('.tp-source-meta')).toContainText(candidate.speaker);
        await expect(topicsPanel(page).locator('.tp-source-meta')).toContainText(candidate.reference.sessionId + ' · #' + candidate.reference.seq);
      } else {
        expect([...seed.originals.values()].some(content => content.includes(read.content))).toBe(true);
      }
    }
    expect(host.mutations.length).toBe(writesAfterCreate);
    expect((await host.api('topics', {action: 'get', id: created.id})).topic.references).toEqual([]);
    const noteIndex = results.results.findIndex(candidate => candidate.reference.kind === 'note');
    await readTopicResult(page, noteIndex);
    await topicsPanel(page).getByRole('button', {name: '打开原笔记', exact: true}).click();
    await expect(page.locator('.nb-title-input')).toHaveValue(results.results[noteIndex].title);
    await openTopics(page);
    await expect(topicsPanel(page).locator('.tp-workspace-header h1')).toHaveText(question);
    await expect(topicsPanel(page).locator('.tp-reference')).toHaveCount(0);
    const indices = results.results.map((result, index) => ({result, index})).filter(({result}) => result.reference.kind === 'note' ||
      result.reference.sessionId === seed.bindings[0].sessionId && result.speaker === 'user' ||
      result.reference.sessionId === seed.bindings[1].sessionId && result.speaker === 'assistant');
    const expected = [];
    for (const {result, index} of indices) {
      await readTopicResult(page, index);
      await topicsPanel(page).getByRole('button', {name: '添加这个来源', exact: true}).click();
      expected.push(sourceReferenceKey(result.reference));
      await expect(topicsPanel(page).locator('.tp-reference')).toHaveCount(expected.length);
    }
    expect(expected).toHaveLength(4);
    let saved = (await host.api('topics', {action: 'get', id: created.id})).topic;
    expect(saved.references.map(sourceReferenceKey)).toEqual(expected);
    await topicsPanel(page).locator('.tp-reference').last().getByRole('button', {name: '上移', exact: true}).click();
    [expected[2], expected[3]] = [expected[3], expected[2]];
    await expect.poll(async () => (await host.api('topics', {action: 'get', id: created.id})).topic.references.map(sourceReferenceKey)).toEqual(expected);
    const discussionForShot = results.results.findIndex(candidate => candidate.reference.kind === 'discussion' && candidate.speaker === 'assistant');
    await readTopicResult(page, discussionForShot);
    await assertContained(page);
    await capture(page, 'topics-workspace');
    await page.setViewportSize({width: 390, height: 844});
    await capture(page, 'topics-workspace-mobile');
    await assertContained(page);
    expect(await topicsPanel(page).locator('.tp-sidebar, .tp-workspace, .tp-content, .tp-source-reader, .tp-source-meta').evaluateAll(nodes => nodes.filter(node => node.getBoundingClientRect().width > 0 && node.scrollWidth > node.clientWidth + 1).map(node => ({className: node.className, width: node.clientWidth, scrollWidth: node.scrollWidth})))).toEqual([]);
    await page.setViewportSize({width: 1440, height: 1000});
    await page.evaluate(() => window.__disposeFixture?.());await page.reload();
    await page.addScriptTag({path: root + '.build/browser-host.js'});await page.addScriptTag({path: root + 'client.js'});
    await openTopics(page);
    await expect(topicsPanel(page).locator('.tp-topic-button').filter({hasText: question})).toContainText('4 个来源');
    await topicsPanel(page).locator('.tp-topic-button').filter({hasText: question}).click();
    await expect(topicsPanel(page).locator('.tp-reference')).toHaveCount(4);
    saved = (await host.api('topics', {action: 'get', id: created.id})).topic;
    expect(saved.references.map(sourceReferenceKey)).toEqual(expected);
    await topicsPanel(page).locator('.tp-reference').first().getByRole('button', {name: /^移除 /}).click();expected.shift();
    await expect.poll(async () => (await host.api('topics', {action: 'get', id: created.id})).topic.references.map(sourceReferenceKey)).toEqual(expected);
    saved = (await host.api('topics', {action: 'get', id: created.id})).topic;
    const deniedIndex = saved.references.findIndex(reference => reference.kind === 'discussion' && reference.sessionId === seed.bindings[0].sessionId);
    expect(deniedIndex).toBeGreaterThanOrEqual(0);
    host.native.denied.add(seed.bindings[0].sessionId);
    const readsBeforeDeny = host.native.readCalls.filter(call => call.sessionId === seed.bindings[0].sessionId).length;
    await topicsPanel(page).locator('.tp-reference').nth(deniedIndex).locator('.tp-reference-open').click();
    await expect(topicsPanel(page).locator('.tp-source-reader [role=alert]')).toContainText('暂时无法读取此来源');
    await expect(topicsPanel(page).locator('.tp-original')).toHaveCount(0);
    expect(host.native.readCalls.filter(call => call.sessionId === seed.bindings[0].sessionId).length).toBe(readsBeforeDeny);
    expect((await host.api('topics', {action: 'get', id: created.id})).topic.references.map(sourceReferenceKey)).toEqual(expected);
    host.native.denied.clear();
    await topicsPanel(page).getByRole('button', {name: '删除问题', exact: true}).click();
    await expect(topicsPanel(page).locator('.tp-confirm')).toContainText('不会删除原笔记或原生对话');
    await topicsPanel(page).getByRole('button', {name: '确认删除问题', exact: true}).click();
    await expect(topicsPanel(page).locator('.tp-topic-button')).toHaveCount(0);
    expect((await host.api('topics', {action: 'list'})).total).toBe(0);
    expect((await host.tool('manage_notes', {action: 'list'})).total).toBe(6);
    for (const binding of seed.bindings) {
      expect((await host.tool('manage_note_chat', {action: 'get', noteId: binding.noteId})).binding.sessionId).toBe(binding.sessionId);
      expect(host.native.events.get(binding.sessionId)).toHaveLength(9);
    }
    for (const [id, content] of seed.originals) expect((await host.tool('manage_notes', {action: 'get', id})).note.content).toBe(content);
    expect(host.sessionCreations.length).toBe(initialSessions);
    expect(errors).toEqual([]);
  } finally { await page.evaluate(() => window.__disposeFixture?.()).catch(() => {});await host.close(); }
});

test('topics: blank native coauthoring and manual blank formal notes preserve the active source draft across tabs', async ({page}) => {
  const {host, errors} = await openWorkspace(page, {chatOpen: false, discussions: true});
  try {
    const original = host.discussionSeed.originals.get(host.notes[0].id), question = '只手工整理青岚材料，不自动生成正文';
    await page.route('https://notebook.test/api/**', route => {
      let input;try { input = route.request().postDataJSON(); } catch {}
      if (input?.action === 'update' && route.request().url().endsWith('/notes')) return route.fulfill({status: 503, contentType: 'application/json', body: JSON.stringify({ok: false, code: 'UNAVAILABLE', error: 'Private fixture is offline'})});
      return route.fallback();
    });
    await page.locator('.nb-note-row').filter({hasText: '让想法慢慢成形'}).click();await enterSource(page);
    await sourceEditor(page).evaluate(element => { window.__topicRetainedSource = element; });
    await sourceContent(page).focus();await page.keyboard.press('Control+End');await page.keyboard.insertText(' 本机保留段落');
    const draft = original + ' 本机保留段落';
    await expect.poll(() => sourceRaw(page)).toBe(draft);
    await expect.poll(async () => (await readDrafts(page)).find(record => record.noteId === host.notes[0].id)?.fields.content).toBe(draft);
    await openTopics(page);const topic = await createTopic(page, host, question), sessionsBefore = host.sessionCreations.length;
    const openChat = topicsPanel(page).getByRole('button', {name: '原生共创', exact: true});
    const beforeOpen = await openChat.boundingBox();
    expect(beforeOpen.y).toBeLessThan(page.viewportSize().height);
    expect(beforeOpen.y + beforeOpen.height).toBeGreaterThan(0);
    await openChat.click();
    const chat = topicsPanel(page).locator('.tp-chat');
    // Bounding-box reads do not scroll. Assert visibility before any locator
    // clicks inside the chat could mask a missing on-open reveal.
    await expect.poll(async () => {
      const bounds = await chat.boundingBox(), viewport = page.viewportSize();
      if (!bounds || bounds.x >= viewport.width || bounds.x + bounds.width <= 0) return 0;
      return Math.min(bounds.y + bounds.height, viewport.height) - Math.max(bounds.y, 0);
    }).toBeGreaterThan(0);
    await expect(openChat).toHaveAttribute('aria-expanded', 'true');
    await chat.getByRole('button', {name: '开始共创', exact: true}).click();
    await expect(chat.getByTestId('native-conversation')).toBeVisible();
    const native = chat.getByRole('textbox', {name: 'Native conversation input'});
    await expect(native).toHaveValue('');
    await expect(native).toHaveCSS('border-top-width', '3px');
    await expect(native).toHaveCSS('border-radius', '3px');
    await expect(native).toHaveCSS('background-color', 'rgb(39, 42, 46)');
    await expect(native).toHaveCSS('padding-top', '11px');
    await expect(native).toHaveCSS('font-family', 'monospace');
    await expect(native).toHaveCSS('font-size', '17px');
    await expect(native).toHaveCSS('min-height', '89px');
    expect(await native.evaluate(element => {
      const parent = element.parentElement, style = getComputedStyle(parent);
      const expected = parent.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 6;
      return Math.abs(element.getBoundingClientRect().width - expected);
    })).toBeLessThan(1);
    const nativeSend = chat.getByTestId('native-conversation').getByRole('button', {name: '发送', exact: true});
    await expect(nativeSend).toHaveCSS('border-top-width', '3px');
    await expect(nativeSend).toHaveCSS('border-radius', '3px');
    await expect(nativeSend).toHaveCSS('background-color', 'rgb(70, 75, 80)');
    await expect(nativeSend).toHaveCSS('padding-top', '11px');
    await expect(nativeSend).toHaveCSS('font-family', 'monospace');
    await expect(nativeSend).toHaveCSS('font-size', '15px');
    await expect(nativeSend).toHaveCSS('min-height', '47px');
    await expect(nativeSend).toHaveCSS('width', '137px');
    let current = (await host.api('topics', {action: 'get', id: topic.id})).topic;
    expect(current.sessionId).toBeTruthy();expect(current.references).toEqual([]);
    expect(host.sessionCreations.length).toBe(sessionsBefore + 1);
    expect(host.sessionCreations.at(-1).input).toEqual({});
    expect(host.native.events.get(current.sessionId)).toEqual([]);
    const sessionId = current.sessionId;
    await chat.getByRole('button', {name: '收起共创', exact: true}).click();
    await topicsPanel(page).getByRole('button', {name: '原生共创', exact: true}).click();
    await expect(chat.getByTestId('native-conversation')).toBeVisible();
    expect((await host.api('topics', {action: 'get', id: topic.id})).topic.sessionId).toBe(sessionId);
    expect(host.sessionCreations.length).toBe(sessionsBefore + 1);
    await native.fill('仅保留的私有会话草稿，不发送');
    await page.locator('.nb-workspace-tab').filter({hasText: '笔记库'}).click();
    await expect(sourceContent(page)).toBeVisible();
    expect(await sourceRaw(page)).toBe(draft);
    expect(await sourceEditor(page).evaluate(element => element === window.__topicRetainedSource)).toBe(true);
    await openTopics(page);
    await expect(topicsPanel(page).locator('.tp-workspace-header h1')).toHaveText(question);
    await expect(native).toHaveValue('仅保留的私有会话草稿，不发送');
    expect((await host.tool('manage_notes', {action: 'list'})).total).toBe(6);
    expect(host.native.events.get(sessionId)).toEqual([]);
    await topicsPanel(page).getByRole('button', {name: '新建正式笔记', exact: true}).click();
    await expect(page.locator('.nb-title-input')).toHaveValue('未命名笔记');
    await expect(sourceContent(page)).toBeVisible();expect(await sourceRaw(page)).toBe('');
    await expect.poll(async () => (await host.tool('manage_notes', {action: 'list'})).total).toBe(7);
    const notes = (await host.tool('manage_notes', {action: 'list'})).notes, created = notes.find(note => !host.notes.some(seed => seed.id === note.id));
    expect(created).toBeTruthy();expect((await host.tool('manage_notes', {action: 'get', id: created.id})).note.content).toBe('');
    for (const [id, content] of host.discussionSeed.originals) expect((await host.tool('manage_notes', {action: 'get', id})).note.content).toBe(content);
    current = (await host.api('topics', {action: 'get', id: topic.id})).topic;
    expect(current.references).toEqual([]);expect(current.sessionId).toBe(sessionId);
    expect(host.native.events.get(sessionId)).toEqual([]);
    expect(host.native.queryCalls).toEqual([]);expect(host.native.readCalls).toEqual([]);
    expect((await readDrafts(page)).find(record => record.noteId === host.notes[0].id)?.fields.content).toBe(draft);
    expect(errors).toEqual([]);
  } finally { await page.evaluate(() => window.__disposeFixture?.()).catch(() => {});await host.close(); }
});

test('topics: note-only search, explicit retry and revision conflicts preserve manual inputs and sources', async ({page}) => {
  const {host, errors} = await openWorkspace(page, {chatOpen: false});
  try {
    const originalQuestion = '需要手工核对的想法\n第二行问题🙂';
    const externalQuestion = '另一个窗口修改的问题\n保留外部第二行';
    const renamedQuestion = '我手动保留的新问题\n保留换行🙂';
    await openTopics(page);const topic = await createTopic(page, host, originalQuestion);
    expect((await getTopicViaBrowserHTTP(page, topic.id)).question).toBe(originalQuestion);
    const rename = topicsPanel(page).getByRole('textbox', {name: '修改问题', exact: true});
    await expect(rename).toHaveValue(originalQuestion);
    const result = await searchTopicSources(page, '想法');
    expect(result.discussionAvailable).toBe(false);expect(result.results.length).toBeGreaterThan(0);
    expect(result.results.every(candidate => candidate.reference.kind === 'note')).toBe(true);
    await expect(topicsPanel(page).getByText('当前无法检索讨论；仍可查找笔记来源。', {exact: true})).toBeVisible();
    await readTopicResult(page, 0);
    let unavailable = true;
    await page.route('https://notebook.test/api/dsh-note/topics', route => {
      const input = route.request().postDataJSON();
      if (input.action === 'update' && unavailable) return route.fulfill({status: 503, contentType: 'application/json', body: JSON.stringify({ok: false, code: 'UNAVAILABLE', error: 'Explicit failure fixture'})});
      return route.fallback();
    });
    await topicsPanel(page).getByRole('button', {name: '添加这个来源', exact: true}).click();
    await expect(topicsPanel(page).locator('[role=alert]')).toContainText('问题未能保存');
    await expect(topicsPanel(page).locator('.tp-candidate')).toBeVisible();
    expect((await host.api('topics', {action: 'get', id: topic.id})).topic.references).toEqual([]);
    unavailable = false;
    await topicsPanel(page).getByRole('button', {name: '重试保存来源调整', exact: true}).click();
    await expect(topicsPanel(page).locator('.tp-reference')).toHaveCount(1);
    const before = (await host.api('topics', {action: 'get', id: topic.id})).topic, libraryId = (await host.api('topics', {action: 'list'})).libraryId;
    await host.api('topics', {action: 'update', id: topic.id, revision: before.revision, libraryId, question: externalQuestion});
    await rename.fill(renamedQuestion);
    await topicsPanel(page).locator('.tp-rename-form').getByRole('button', {name: '保存', exact: true}).click();
    await expect(topicsPanel(page).locator('[role=alert]')).toContainText('其他窗口更新');
    await expect(rename).toHaveValue(renamedQuestion);
    await expect(topicsPanel(page).locator('.tp-workspace-header h1')).toHaveText(externalQuestion);
    await topicsPanel(page).locator('.tp-rename-form').getByRole('button', {name: '保存', exact: true}).click();
    await expect(topicsPanel(page).locator('.tp-workspace-header h1')).toHaveText(renamedQuestion);
    const saved = await getTopicViaBrowserHTTP(page, topic.id);
    expect(saved.references.map(sourceReferenceKey)).toEqual(before.references.map(sourceReferenceKey));
    // Compare the actual HTTP get value, without locator whitespace normalization.
    expect(saved.question).toBe(renamedQuestion);
    expect((await host.tool('manage_notes', {action: 'list'})).total).toBe(6);
    expect(host.sessionCreations).toEqual([]);expect(errors).toEqual([]);
  } finally { await page.evaluate(() => window.__disposeFixture?.()).catch(() => {});await host.close(); }
});

test('English, reduced motion and filter-free surfaces retain layout', async ({page}) => {
  const {host, errors} = await openWorkspace(page, {theme: 'light', language: 'en', width: 1024, height: 768});
  try {
    await expect(page.locator('.nb-list-heading')).toContainText('All notes');
    await page.addStyleTag({content: '.dn-workspace, .dn-workspace * { backdrop-filter:none !important; -webkit-backdrop-filter:none !important; }'});
    await assertContained(page);
    await capture(page, 'library-light-no-blur');
    await page.keyboard.press('Tab');
    await expect(page.locator(':focus')).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await page.evaluate(() => window.__disposeFixture?.()).catch(() => {}); await host.close(); }
});

for (const theme of ['dark','light']) test(theme + ': live document renders and edits math, code, tables and images without modes', async ({page}) => {
 const {host,errors}=await openWorkspace(page,{theme,chatOpen:false,height:1400});
 await page.route('https://notebook.test/api/dsh-note/attachment-file?id=fixture',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="320" height="72"><rect width="320" height="72" rx="8" fill="#334155"/><text x="20" y="43" fill="#e2e8f0" font-family="sans-serif">Live image</text></svg>'}));
 try {
  const raw=['# 即时文稿','','**粗体** 与 *斜体* 和 [链接](https://example.com)','','行内 $x^2$。','','$$','\\frac{a}{b}','$$','','```js','const answer = 42;','```','','- [ ] 保留任务','','| A | B |','| --- | --- |','| 1 | 2 |','','![test](/api/dsh-note/attachment-file?id=fixture)','','结束'].join('\r\n');
  await host.tool('manage_notes',{action:'update',id:host.notes[0].id,revision:1,content:raw});
  await page.locator('.nb-note-row').filter({hasText:'让想法慢慢成形'}).click();
  await expect(page.locator('.em-md-modes')).toHaveCount(0);
  await expect(page.locator('.nb-preview-pane')).toHaveCount(0);
  await expect(sourceContent(page)).toBeVisible();
  expect(errors).toEqual([]);
  expect(await sourceRaw(page)).toBe(raw);
  await sourceEditor(page).evaluate((element,offset)=>element.__noteEditorHandle.revealOffset(offset),raw.indexOf('行内'));
  await expect(page.locator('.nb-source-editor .katex')).toHaveCount(2);
  await expect(page.locator('.nb-live-strong')).toHaveText('粗体');
  await expect(page.locator('.nb-live-code .hljs-keyword')).toContainText('const');
  await expect(page.locator('.nb-source-editor table')).toBeVisible();
  await expect(page.locator('.nb-source-editor img[alt=test]')).toHaveAttribute('src','/api/dsh-note/attachment-file?id=fixture');
  expect(await sourceRaw(page)).toBe(raw);
  const inline=page.locator('.nb-live-math').filter({has:page.locator('.katex')}).first();
  await inline.getByRole('button',{name:'公式',exact:true}).click();
  const input=inline.getByRole('textbox',{name:'公式',exact:true});
  await expect(input).toBeFocused();
  await input.fill('y^3');
  await expect.poll(()=>sourceRaw(page)).toBe(raw.replace('$x^2$','$y^3$'));
  await expect(inline.locator('.katex annotation')).toHaveText('y^3');
  await expect(input).toBeFocused();
  await input.press('Control+z');
  await expect.poll(()=>sourceRaw(page)).toBe(raw);
  await sourceContent(page).focus();await page.keyboard.press('Control+End');await page.keyboard.insertText(' 新输入 $z^4$');
  await expect(page.locator('.nb-source-editor .katex')).toHaveCount(3);
  const changed=raw+' 新输入 $z^4$';
  await expect.poll(()=>sourceRaw(page)).toBe(changed);
  await expect.poll(async()=>(await host.tool('manage_notes',{action:'get',id:host.notes[0].id})).note.content).toBe(changed);
  await page.locator('.nb-title-input').focus();
  await capture(page,'live-document-'+theme);
  await sourceContent(page).focus();await page.keyboard.press('Control+End');await page.keyboard.insertText(' ');
  await page.locator('.nb-format-actions').getByRole('button',{name:'公式',exact:true}).click();
  const inserted=page.locator('.nb-live-math-input:visible');
  await expect(inserted).toBeFocused();await inserted.fill('a+b');
  await expect.poll(()=>sourceRaw(page)).toBe(changed+' $a+b$');
  await inserted.press('Enter');await expect(inserted).toHaveCount(0);
  // Wide tables must scroll within the rendered block, without widening the
  // editable document or preventing ordinary paragraphs from wrapping.
  await sourceContent(page).focus();await page.keyboard.press('Control+End');
  const wide='\n\n| '+Array(8).fill('Long_column_heading').join(' | ')+' |\n| '+Array(8).fill('---').join(' | ')+' |\n| '+Array(8).fill('wide_cell_content').join(' | ')+' |\n\n正文继续自然换行。';
  await page.keyboard.insertText(wide);
  await page.setViewportSize({width:890,height:789});
  await expect.poll(()=>page.locator('.nb-document-stage').evaluate(element=>element.scrollWidth<=element.clientWidth+1)).toBe(true);
  await expect.poll(()=>sourceContent(page).evaluate(element=>element.scrollWidth<=element.clientWidth+1)).toBe(true);
  expect(errors).toEqual([]);
 }finally{await page.evaluate(()=>window.__disposeFixture?.()).catch(()=>{});await host.close();}
});

test('live rendering preserves widget DOM during caret moves and commits composed widget edits without changing untouched newlines',async({page})=>{
 const {host,errors}=await openWorkspace(page,{chatOpen:false,height:1200});
 try{
  const raw='# Live editing\r\n\r\nSelection stays smooth next to $x^2$.\n\n$$\r\n\\begin{aligned}\na&=1\\\\\rb&=2\r\n\\end{aligned}\n$$\r\n\r\n```js\nconst html = "<img src=x onerror=alert(1)>";\nconsole.log(html);\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nEnd';
  await host.tool('manage_notes',{action:'update',id:host.notes[0].id,revision:1,content:raw});
  await page.locator('.nb-note-row').filter({hasText:'让想法慢慢成形'}).click();await enterSource(page);
  await expect(page.locator('.nb-source-editor .katex')).toHaveCount(2);
  await expect(page.locator('.nb-live-code .hljs-keyword')).toContainText('const');
  await expect(page.locator('.nb-source-editor img[onerror]')).toHaveCount(0);
  await sourceEditor(page).evaluate((element,at)=>element.__noteEditorHandle.revealOffset(at),raw.indexOf('Selection')+10);
  await page.evaluate(()=>new Promise(requestAnimationFrame));
  await sourceEditor(page).evaluate(element=>{
   window.__liveStableNodes=[...element.querySelectorAll('.katex,table')];window.__liveRenderMutations=0;
   window.__liveRenderObserver=new MutationObserver(changes=>{window.__liveRenderMutations+=changes.length;});
   for(const node of element.querySelectorAll('.nb-live-math-result'))window.__liveRenderObserver.observe(node,{childList:true,subtree:true,characterData:true});
  });
  for(let i=0;i<15;i++){await page.keyboard.press('ArrowRight');await page.keyboard.press('ArrowLeft');}
  expect(await sourceEditor(page).evaluate(element=>window.__liveStableNodes.every(node=>node.isConnected&&element.contains(node)))).toBe(true);
  expect(await page.evaluate(()=>window.__liveRenderMutations)).toBe(0);expect(await sourceRaw(page)).toBe(raw);
  await page.evaluate(()=>window.__liveRenderObserver.disconnect());
  const block=page.locator('.nb-live-math-block').filter({has:page.locator('.katex')}).first();
  await block.getByRole('button',{name:'公式',exact:true}).click();const input=block.getByRole('textbox',{name:'公式',exact:true});
  const body=await input.inputValue();await input.fill(body.replace('b&=2','b&=3'));
  await expect.poll(()=>sourceRaw(page)).toBe(raw.replace('b&=2','b&=3'));await input.press('Control+z');
  await expect.poll(()=>sourceRaw(page)).toBe(raw);
  await input.dispatchEvent('compositionstart');
  await input.evaluate(element=>{element.value=element.value.replace('b&=2','b&=中文');element.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertCompositionText',isComposing:true}));});
  expect(await sourceRaw(page)).toBe(raw);
  await input.dispatchEvent('compositionend');
  await expect.poll(()=>sourceRaw(page)).toBe(raw.replace('b&=2','b&=中文'));
  await expect(input).toBeFocused();await input.press('Escape');await expect(input).toBeHidden();
  await expect.poll(async()=>(await host.tool('manage_notes',{action:'get',id:host.notes[0].id})).note.content).toBe(raw.replace('b&=2','b&=中文'));
  expect(errors).toEqual([]);
 }finally{await page.evaluate(()=>window.__disposeFixture?.()).catch(()=>{});await host.close();}
});

for(const width of [933,390]) test('storage folder picker: browse, recover errors and choose without switching at '+width,async({page})=>{
 const {host,errors}=await openWorkspace(page,{width,height:789});
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-folder-picker-ui-'));
  const selected=path.join(temp,'资料库 A');await fs.mkdir(selected);await fs.mkdir(path.join(temp,'空目录'));
 try{
  await page.locator(width<600?'.nb-list-actions':'.nb-category-foot').getByRole('button',{name:'设置',exact:true}).click();
  const settings=page.locator('.nb-settings-dialog');
  await settings.getByRole('button',{name:'笔记存储位置',exact:true}).click();
  const input=settings.locator('.nb-storage-path');await expect(input).toBeEnabled();await input.fill(temp);
  await settings.getByRole('button',{name:'选择文件夹',exact:true}).click();
  const picker=settings.locator('.nb-folder-picker');await expect(picker.getByRole('button',{name:'资料库 A',exact:true})).toBeVisible();
  await expect(picker.getByRole('textbox',{name:'文件夹路径',exact:true})).toBeFocused();
  await picker.getByRole('button',{name:'资料库 A',exact:true}).click();
  await expect(picker.getByRole('textbox',{name:'文件夹路径',exact:true})).toHaveValue(selected);
  await expect(picker.getByText('此目录下没有子文件夹。',{exact:true})).toBeVisible();
  await picker.getByRole('button',{name:'上一级',exact:true}).click();
  await expect(picker.getByRole('button',{name:'空目录',exact:true})).toBeVisible();
  const address=picker.getByRole('textbox',{name:'文件夹路径',exact:true});await address.fill(path.join(temp,'missing'));await address.press('Enter');
  await expect(picker.getByRole('alert')).toContainText('无法读取文件夹');await expect(picker.getByRole('button',{name:'选择当前文件夹',exact:true})).toBeDisabled();
  await address.fill(temp);await address.press('Enter');await expect(picker.getByRole('button',{name:'资料库 A',exact:true})).toBeVisible();
  await picker.getByRole('button',{name:'资料库 A',exact:true}).click();await expect(address).toHaveValue(selected);
  await picker.getByRole('button',{name:'选择当前文件夹',exact:true}).click();await expect(picker).toHaveCount(0);await expect(input).toHaveValue(selected);
  const status=await host.api('note-storage',{action:'status'});expect(status.directory).toBe('');expect(status.revision).toBe(0);expect(status.counts.notes).toBe(6);
  await settings.getByRole('button',{name:'选择文件夹',exact:true}).click();await expect(picker.getByRole('textbox',{name:'文件夹路径',exact:true})).toBeEnabled();
  await picker.getByRole('textbox',{name:'文件夹路径',exact:true}).press('Escape');await expect(picker).toHaveCount(0);await expect(settings).toBeVisible();await expect(input).toHaveValue(selected);
  await settings.getByRole('button',{name:'选择文件夹',exact:true}).click();await expect(picker.getByRole('textbox',{name:'文件夹路径',exact:true})).toBeEnabled();
  await picker.getByRole('button',{name:'上一级',exact:true}).click();await expect(picker.getByRole('button',{name:'资料库 A',exact:true})).toBeVisible();
  await capture(page,'storage-folder-picker-'+width);await assertContained(page);expect(errors).toEqual([]);
 }finally{
  await page.evaluate(()=>window.__disposeFixture?.()).catch(()=>{});await host.close();const target=path.resolve(temp);expect(path.dirname(target)).toBe(await fs.realpath(os.tmpdir()));expect(path.basename(target)).toMatch(/^dsh-folder-picker-ui-/);await fs.rm(target,{recursive:true,force:true});
 }
});

test('storage unavailable displays a service error instead of a JSON parsing failure',async({page})=>{
 const {host,errors}=await openWorkspace(page);
 try{
  await page.route('https://notebook.test/api/dsh-note/note-storage',route=>route.fulfill({status:404,contentType:'text/html',body:'Not found'}));
  await page.locator('.nb-category-foot').getByRole('button',{name:'设置',exact:true}).click();
  const settings=page.locator('.nb-settings-dialog');await settings.getByRole('button',{name:'笔记存储位置',exact:true}).click();
  await expect(settings.locator('.nb-storage-current').getByRole('alert')).toContainText('笔记服务尚未就绪');
  await expect(settings.getByRole('button',{name:'保存并切换',exact:true})).toBeDisabled();expect(errors).toEqual([]);
 }finally{await page.evaluate(()=>window.__disposeFixture?.()).catch(()=>{});await host.close();}
});

for(const width of [933,390]) test('category actions add children and delete categories while preserving the editor at '+width,async({page})=>{
 const {host,errors}=await openWorkspace(page,{width,height:789,chatOpen:false});
 try{
  await host.tool('manage_notes',{action:'update',id:host.notes[0].id,revision:1,category:'reading'});
  await page.locator('.nb-note-row').filter({hasText:'让想法慢慢成形'}).click();await enterSource(page);
  const raw=await sourceRaw(page);await sourceEditor(page).evaluate(element=>{window.__categoryMenuEditor=element;});
  if(width<600)await page.locator('.nb-editor-head').getByRole('button',{name:'目录',exact:true}).click();
  const panel=page.locator('.nb-directory-panel');
  const actions=label=>panel.getByRole('button',{name:'分类操作 '+label,exact:true});
  await actions('阅读笔记').click();const menu=panel.getByRole('menu',{name:'分类操作 阅读笔记',exact:true});
  await expect(menu.getByRole('menuitem',{name:'新增子分类',exact:true})).toBeVisible();await expect(menu.getByRole('menuitem',{name:'删除分类',exact:true})).toBeEnabled();
  async function expectAnchoredMenu(label){
   const box=await panel.getByRole('menu').boundingBox(),anchor=await actions(label).boundingBox();
   expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(width+1);
   expect(box.y).toBeGreaterThanOrEqual(0);expect(box.y+box.height).toBeLessThanOrEqual(790);
   expect(Math.min(Math.abs(box.y-anchor.y-anchor.height-4),Math.abs(box.y+box.height-anchor.y+4))).toBeLessThan(2);
  }
  await expectAnchoredMenu('阅读笔记');
  await menu.getByRole('menuitem',{name:'删除分类',exact:true}).click();const confirmation=page.getByRole('dialog',{name:'删除分类 · 阅读笔记',exact:true});
  await expect(confirmation).toContainText('文档');await expect(confirmation.getByRole('button',{name:'取消',exact:true})).toBeFocused();
  const revision=(await categoryTree(host)).revision;await confirmation.getByRole('button',{name:'取消',exact:true}).click();expect((await categoryTree(host)).revision).toBe(revision);
  await expect(actions('阅读笔记')).toBeFocused();await actions('阅读笔记').click();await menu.getByRole('menuitem',{name:'新增子分类',exact:true}).click();
  await panel.locator('.nb-directory-form input').fill('要删除的分类');await panel.locator('.nb-directory-form').getByRole('button',{name:'保存',exact:true}).click();
  const created=(await categoryTree(host)).items.find(item=>item.name==='要删除的分类');
  await actions('要删除的分类').click();await panel.getByRole('menuitem',{name:'新增子分类',exact:true}).click();
  await panel.locator('.nb-directory-form input').fill('保留的子分类');await panel.locator('.nb-directory-form').getByRole('button',{name:'保存',exact:true}).click();
  const seeded=await host.tool('manage_notes',{action:'create',category:created.id,title:'分类中的笔记',content:'keep\r\nexact'});
  await actions('要删除的分类').click();await panel.getByRole('menuitem',{name:'删除分类',exact:true}).click();
  await page.getByRole('dialog',{name:'删除分类 · 要删除的分类',exact:true}).getByRole('button',{name:'确认删除分类',exact:true}).click();
  await expect(actions('要删除的分类')).toHaveCount(0);
  expect((await categoryTree(host)).items.find(item=>item.name==='保留的子分类').parentId).toBe('reading');
  expect((await host.tool('manage_notes',{action:'get',id:seeded.note.id})).note.category).toBe('reading');
  const readingNotes=(await host.tool('manage_notes',{action:'list',category:'reading',includeDescendants:false})).notes;
  await actions('阅读笔记').click();await panel.getByRole('menuitem',{name:'删除分类',exact:true}).click();
  await page.getByRole('dialog',{name:'删除分类 · 阅读笔记',exact:true}).getByRole('button',{name:'确认删除分类',exact:true}).click();await expect(actions('阅读笔记')).toHaveCount(0);
  for(const note of readingNotes)expect((await host.tool('manage_notes',{action:'get',id:note.id})).note.category).toBe('document');
  if(width<600)await page.getByRole('button',{name:'返回正文',exact:true}).click();
  expect(await sourceRaw(page)).toBe(raw);expect(await sourceEditor(page).evaluate(element=>element===window.__categoryMenuEditor)).toBe(true);
  await sourceContent(page).focus();await page.keyboard.press('Control+End');await page.keyboard.insertText(' AFTER DELETE');
  await expect.poll(async()=>(await host.tool('manage_notes',{action:'get',id:host.notes[0].id})).note.content).toBe(raw+' AFTER DELETE');
  expect((await host.tool('manage_notes',{action:'get',id:host.notes[0].id})).note.category).toBe('document');
  await page.locator('.nb-title-input').focus();await page.keyboard.press('Control+Shift+O');await page.keyboard.press('Control+Shift+O');
  if(width<600)await page.locator('.nb-editor-head').getByRole('button',{name:'目录',exact:true}).click();
  await actions('文档').click();await capture(page,'category-actions-'+width);
  await expectAnchoredMenu('文档');expect(errors).toEqual([]);
 }finally{await page.evaluate(()=>window.__disposeFixture?.()).catch(()=>{});await host.close();}
});
