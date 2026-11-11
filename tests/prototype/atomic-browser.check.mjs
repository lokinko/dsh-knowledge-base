import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {chromium, expect} from '@playwright/test';

// Isolated, prebuilt local HTML only: no production config, build or server.
const root = fileURLToPath(new URL('../../', import.meta.url));
const artifacts = path.join(root, '.build/prototypes');
const entry = path.join(artifacts, 'workbench-atomic.html');
const userDesign = JSON.parse(await fs.readFile(path.join(root, 'prototypes/workbench/user-design/layout-20261111.json'), 'utf8'));
const sourceNodes = userDesign.layout.nodes, sourceById = new Map(sourceNodes.map(node => [node.id, node]));
const removed = sourceNodes.filter(node => {
  for (let current = node; current; current = sourceById.get(current.parentId)) if (current.props.hidden) return true;
  return false;
}).map(node => node.id);
const survivors = sourceNodes.filter(node => !removed.includes(node.id));
let browser;
before(async () => {
  const executablePath = process.env.DSH_TEST_CHROME || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : undefined);
  browser = await chromium.launch({headless: true, ...(executablePath ? {executablePath} : {})});
  await fs.mkdir(artifacts, {recursive: true});
});
after(async () => { await browser?.close(); });

async function withPage(action, {file = entry} = {}) {
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}, acceptDownloads: true, reducedMotion: 'reduce'});
  const errors = [], network = [], page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
  await page.route(/^https?:\/\//, route => route.abort());
  try {
    await page.goto(pathToFileURL(file).href);
    await expect(page.locator('#canvas [data-id="workspace"]')).toBeVisible();
    await action(page);
    assert.deepEqual(errors, [], 'offline atomic app must have no page errors');
    assert.deepEqual(network, [], 'offline atomic app must make no HTTP requests');
  } catch (error) {
    console.error('atomic diagnostics', {errors, network, geometry: await page.locator('#designer,.designer-body,#canvas,#canvas [data-id="workspace"]').evaluateAll(nodes => nodes.map(node => ({id: node.dataset.id || node.id || node.className, rect: node.getBoundingClientRect().toJSON()}))).catch(() => [])});
    await page.screenshot({path: path.join(artifacts, 'atomic-failure.png')}).catch(() => {});
    throw error;
  } finally { await context.close(); }
}
const node = (page, id) => page.locator(`#canvas [data-id="${id}"]`);
const find = (value, id) => value.layout.nodes.find(node => node.id === id);
const ownText = locator => locator.evaluate(element => [...element.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.data).join(''));
async function cssPixels(locator, property, expected) {
  const actual = await locator.evaluate((element, property) => parseFloat(getComputedStyle(element).getPropertyValue(property)), property);
  assert.ok(Math.abs(actual - expected) < 0.1, `${property}: expected about ${expected}px, got ${actual}px (CSS zoom can quantize subpixels)`);
}
async function select(page, id) {
  const query = page.getByRole('searchbox', {name: '搜索图层', exact: true});
  await query.fill(id);
  await page.locator(`#node-tree [data-node-id="${id}"] > .tree-label`).click();
  await expect(page.locator('#inspector > p').first()).toContainText(id);
  await query.fill('');
}
async function field(page, label, value) {
  const control = page.getByLabel(label, {exact: true});await control.fill(String(value));await control.blur();
}
async function exportJSON(page) {
  const pending = page.waitForEvent('download');await page.getByRole('button', {name: '导出 JSON', exact: true}).click();
  return JSON.parse(await fs.readFile(await (await pending).path(), 'utf8'));
}
async function importJSON(page, value) {
  await page.locator('#import-file').setInputFiles({name: 'private-atomic-layout.json', mimeType: 'application/json', buffer: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))});
}
async function saveHTML(page, name) {
  const pending = page.waitForEvent('download');await page.getByRole('button', {name: '保存 HTML', exact: true}).click();
  const file = path.join(artifacts, name);await (await pending).saveAs(file);return file;
}
async function deleteSelected(page) {
  await page.locator('#inspector .inspector-actions').getByRole('button', {name: '删除', exact: true}).click();
  await page.getByRole('dialog', {name: '删除控件', exact: true}).getByRole('button', {name: '确认删除', exact: true}).click();
}
function assertUserBaseline(value) {
  assert.equal(sourceNodes.length, 59);assert.equal(removed.length, 20);assert.equal(survivors.length, 39);
  assert.equal(value.version, 2);assert.equal(value.layout.version, 2);
  for (const id of removed) assert.equal(find(value, id), undefined, `hidden original ${id} must be truly absent`);
  for (const original of survivors) {
    const actual = find(value, original.id);assert.ok(actual, `preserve original ID ${original.id}`);
    assert.equal(actual.name, original.name);assert.equal(actual.parentId, original.parentId);assert.equal(actual.scene, original.scene);
    assert.equal(actual.type, original.type === 'content' ? 'container' : original.type);
    for (const [key, expected] of Object.entries(original.props)) {
      if (original.type === 'button' && key === 'text') {
        const label = value.layout.nodes.find(node => node.parentId === actual.id && node.type === 'text');
        assert.equal(label?.props.text, expected);continue;
      }
      // Approved restoration of the old mock's internal scrolling and native
      // button defaults. Custom user values and every other field stay exact.
      if (original.id === 'library-grid' && key === 'overflow' && expected === 'visible' && actual.props[key] === 'auto') continue;
      const buttonDefaults = {direction: ['column', 'row'], gap: [12, 6], padding: [0, 6], align: ['stretch', 'center']};
      if (original.type === 'button' && buttonDefaults[key]?.[0] === expected && actual.props[key] === buttonDefaults[key][1]) continue;
      assert.deepEqual(actual.props[key], expected, `${original.id}.props.${key}`);
    }
    for (const [key, expected] of Object.entries(original.mobile || {})) {
      if (original.type === 'button' && key === 'text') continue;
      assert.deepEqual(actual.mobile?.[key], expected, `${original.id}.mobile.${key}`);
    }
  }
  assert.equal(find(value, 'library-sidebar').props.width, 160);
  assert.equal(find(value, 'folder-tree').props.width, 160);
  assert.equal(find(value, 'topics-question-list').props.overflow, 'hidden');
}
async function assertAtomicOwnership(page) {
  const invalid = await page.locator('#canvas').evaluate(canvas => {
    const failures = [], walker = document.createTreeWalker(canvas, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      if (!text.data.trim() || text.parentElement?.closest('[data-designer-only]') || text.parentElement?.closest('input,textarea')) continue;
      const owner = text.parentElement?.closest('[data-id]');
      if (!owner || !['text', 'icon'].includes(owner.dataset.type)) failures.push({text: text.data.slice(0, 80), owner: owner?.dataset.id, type: owner?.dataset.type});
    }
    for (const native of canvas.querySelectorAll('input,textarea,img')) {
      const owner = native.closest('[data-id]'), expected = {INPUT: 'input', TEXTAREA: 'textarea', IMG: 'image'}[native.tagName];
      if (owner?.dataset.type !== expected) failures.push({native: native.tagName, owner: owner?.dataset.id, type: owner?.dataset.type});
    }
    return failures;
  });
  assert.deepEqual(invalid, [], 'every meaningful product glyph and native field must belong to a registered atomic leaf');
}

test('smoke: user design is visible, pointer-selectable, preserved and fully atomic offline', {timeout: 30000}, async () => {
  await withPage(async page => {
    await expect(page.locator('#scene-select')).toHaveValue('library');await expect(page.locator('#device-select')).toHaveValue('desktop');
    const body = await page.locator('.designer-body').boundingBox(), viewport = page.viewportSize();
    assert.ok(body.height > 300 && body.y < viewport.height && body.y + body.height > 0);
    const title = node(page, 'library-grid--note-0-title'), bounds = await title.boundingBox();
    assert.ok(bounds && bounds.width > 0 && bounds.height > 0);
    const point = {x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2};
    assert.ok(point.x > 0 && point.x < viewport.width && point.y > 0 && point.y < viewport.height);
    assert.equal(await page.evaluate(({x,y}) => document.elementFromPoint(x,y)?.closest('[data-id]')?.dataset.id, point), 'library-grid--note-0-title');
    await title.click();await expect(page.locator('#inspector > p').first()).toContainText('library-grid--note-0-title');
    assertUserBaseline(await exportJSON(page));
    for (const scene of ['library', 'read', 'edit', 'topics']) { await page.locator('#scene-select').selectOption(scene);await assertAtomicOwnership(page); }
    await page.locator('#scene-select').selectOption('library');await select(page, 'library-grid--note-0-title');
    await page.screenshot({path: path.join(artifacts, 'atomic-designer.png')});
  });
});

test('files: edited atomic leaves, deletion, notes and phone styles survive JSON and two fresh-context HTML round trips', {timeout: 90000}, async () => {
  const titleId = 'library-grid--note-0-title', labelId = 'library-grid--note-0-open-label', buttonId = 'library-grid--note-0-open';
  const text = '原子文字 < > & 🙂\n保留第二行', mobileText = '手机原子覆盖🙂', noteText = '给实现者：手机与桌面独立🙂\n备注逐字保留。';
  let saved;
  await withPage(async page => {
    await select(page, titleId);await field(page, '显示文字', text);await field(page, '给实现者的备注', noteText);
    await select(page, labelId);await deleteSelected(page);
    await expect(node(page, labelId)).toHaveCount(0);await expect(node(page, buttonId)).toHaveCount(1);
    await page.locator('#device-select').selectOption('mobile');await select(page, titleId);
    await field(page, '显示文字', mobileText);await field(page, '文字颜色', '#123456');
    await page.getByLabel('字号模式', {exact: true}).selectOption('number');await field(page, '字号数值', 17);
    saved = await exportJSON(page);
    assert.equal(saved.format, 'dsh-workbench-prototype');assert.equal(saved.version, 2);assert.equal(saved.layout.version, 2);assert.equal(saved.baseline.version, 2);
    assert.equal(find(saved, labelId), undefined);assert.ok(find(saved, buttonId));
    assert.equal(find(saved, titleId).props.text, text);assert.equal(find(saved, titleId).props.note, noteText);
    assert.equal(find(saved, titleId).mobile.text, mobileText);assert.equal(find(saved, titleId).mobile.color, '#123456');
    await page.reload();
    assert.equal(find(await exportJSON(page), labelId), undefined, 'reload must never synthesize a deleted button label');
    assert.equal(await ownText(node(page, titleId)), mobileText);
  });
  let firstHTML;
  await withPage(async page => {
    await importJSON(page, saved);await expect(page.locator('#toast')).toContainText('原子布局已导入');
    assert.deepEqual((await exportJSON(page)).layout, saved.layout);
    assert.equal(await ownText(node(page, titleId)), mobileText);
    await expect(node(page, titleId)).toHaveCSS('color', 'rgb(18, 52, 86)');
    await expect(node(page, titleId)).toHaveCSS('font-size', '17px');
    firstHTML = await saveHTML(page, 'atomic-roundtrip-first.html');
  });
  let secondHTML;
  await withPage(async page => {
    await expect(page.locator('#device-select')).toHaveValue('mobile');
    assert.equal(await ownText(node(page, titleId)), mobileText);
    let value = await exportJSON(page);
    assert.equal(find(value, labelId), undefined);assert.ok(find(value, buttonId));
    assert.equal(find(value, titleId).props.text, text);assert.equal(find(value, titleId).props.note, noteText);
    assert.deepEqual(value.baseline, saved.baseline, 'standalone HTML must carry the cleaned user baseline');
    for (const id of removed) assert.equal(value.layout.nodes.some(node => node.id === id), false);
    await select(page, titleId);await field(page, '显示文字', 'HTML 冷开后继续编辑🙂');
    await field(page, '给实现者的备注', '手机备注再次保存\n保持离线');
    secondHTML = await saveHTML(page, 'atomic-roundtrip-second.html');
  }, {file: firstHTML});
  await withPage(async page => {
    const value = await exportJSON(page);
    assert.equal(await ownText(node(page, titleId)), 'HTML 冷开后继续编辑🙂');
    assert.equal(find(value, titleId).mobile.note, '手机备注再次保存\n保持离线');
    assert.equal(find(value, titleId).props.text, text);assert.equal(find(value, titleId).props.note, noteText);
    assert.equal(find(value, labelId), undefined);assert.ok(find(value, buttonId));
    await page.locator('#device-select').selectOption('desktop');
    assert.equal(await ownText(node(page, titleId)), text);
    await select(page, titleId);await field(page, '文字颜色', '#654321');
    await expect(node(page, titleId)).toHaveCSS('color', 'rgb(101, 67, 33)');
    await assertAtomicOwnership(page);
  }, {file: secondHTML});
});

test('design: atomic card parts style independently, inherit real fonts, move and support tree, duplicate, delete and add tools', {timeout: 90000}, async () => {
  await withPage(async page => {
    const card = 'library-grid--note-0', title = card + '-title', tag = card + '-tag-0', date = card + '-updated', icon = card + '-icon';
    const original = await exportJSON(page), siblings = [tag, date, icon].map(id => structuredClone(find(original, id)));
    for (const id of [title, tag, date, icon]) {
      await node(page, id).click();await expect(page.locator('#inspector > p').first()).toContainText(id);
    }
    await select(page, title);
    await field(page, '文字颜色', '#123456');await field(page, '背景颜色', '#ddeeff');await field(page, '边框颜色', '#998877');
    await field(page, '边框宽度', 2);await field(page, '圆角', 9);
    await page.getByLabel('字号模式', {exact: true}).selectOption('number');await field(page, '字号数值', 28);
    await page.getByLabel('字重', {exact: true}).selectOption('600');
    await page.getByLabel('宽度模式', {exact: true}).selectOption('fixed');await field(page, '宽度像素', 240);
    await page.getByLabel('高度模式', {exact: true}).selectOption('fixed');await field(page, '高度像素', 80);
    await field(page, '统一内边距', 6);await field(page, '统一外边距', 3);
    for (const [property, value] of Object.entries({color:'rgb(18, 52, 86)', 'background-color':'rgb(221, 238, 255)', 'border-color':'rgb(153, 136, 119)', 'border-top-style':'solid', 'font-size':'28px', 'font-weight':'600'})) await expect(node(page, title)).toHaveCSS(property, value);
    for (const [property, value] of Object.entries({'border-radius':9, width:240, height:80, 'padding-top':6, 'margin-top':3})) await cssPixels(node(page, title), property, value);
    let current = await exportJSON(page);
    for (const sibling of siblings) assert.deepEqual(find(current, sibling.id), sibling, 'styling the title cannot mutate tag/date/icon siblings');
    await page.getByLabel('字号模式', {exact: true}).selectOption('inherit');
    await select(page, card);await page.getByLabel('字号模式', {exact: true}).selectOption('number');await field(page, '字号数值', 31);
    await expect(node(page, title)).toHaveCSS('font-size', '31px');await expect(node(page, tag)).toHaveCSS('font-size', '12px');
    const treeCard = page.locator(`#node-tree [data-node-id="${card}"]`);
    await treeCard.locator('> .tree-toggle').click();await expect(page.locator(`#node-tree [data-node-id="${title}"]`)).toHaveCount(0);
    await select(page, title);await page.getByLabel('隐藏控件', {exact: true}).check();
    await expect(node(page, title)).toHaveCount(0);await expect(page.locator(`#node-tree [data-node-id="${title}"]`)).toHaveClass(/is-hidden/);
    await select(page, title);await page.getByLabel('隐藏控件', {exact: true}).uncheck();await expect(node(page, title)).toBeVisible();
    const label = card + '-open-label', tags = card + '-tags';
    await select(page, label);await page.getByLabel('所在容器', {exact: true}).selectOption(tags);
    assert.equal(find(await exportJSON(page), label).parentId, tags);
    assert.equal(await node(page, label).evaluate(element => element.parentElement.closest('[data-id]').dataset.id), tags);
    await page.locator('#undo-button').click();assert.equal(find(await exportJSON(page), label).parentId, card + '-open');
    await page.locator('#redo-button').click();assert.equal(find(await exportJSON(page), label).parentId, tags);
    await select(page, label);const beforeCopy = new Set((await exportJSON(page)).layout.nodes.map(node => node.id));
    await page.locator('#inspector .inspector-actions').getByRole('button', {name: '复制', exact: true}).click();
    const copies = (await exportJSON(page)).layout.nodes.filter(node => !beforeCopy.has(node.id));assert.equal(copies.length, 1);
    await field(page, '显示文字', '副本单独修改');assert.equal(await ownText(node(page, label)), '打开');
    await deleteSelected(page);assert.equal(find(await exportJSON(page), copies[0].id), undefined);
    const beforeAdd = new Set((await exportJSON(page)).layout.nodes.map(node => node.id));
    await page.getByRole('button', {name: '新增控件', exact: true}).click();
    const dialog = page.getByRole('dialog', {name: '新增原子控件', exact: true});
    await dialog.getByLabel('新增控件类型', {exact: true}).selectOption('button');
    await dialog.getByLabel('新增所在容器', {exact: true}).selectOption(card);
    await dialog.getByRole('button', {name: '新增', exact: true}).click();
    current = await exportJSON(page);const added = current.layout.nodes.filter(node => !beforeAdd.has(node.id));
    const addedButton = added.find(node => node.type === 'button'), addedLabel = added.find(node => node.type === 'text');
    assert.ok(addedButton && addedLabel);assert.equal(addedLabel.parentId, addedButton.id);
    await select(page, addedLabel.id);await field(page, '显示文字', '新增工具');assert.equal(await ownText(node(page, addedLabel.id)), '新增工具');
    await assertAtomicOwnership(page);
  });
});

test('baseline: resets never revive removed originals, v1/v2 imports preserve state and imported reset targets survive reload', {timeout: 90000}, async () => {
  await withPage(async page => {
    const baseline = await exportJSON(page), title = 'library-grid--note-0-title';
    await select(page, title);await field(page, '显示文字', '场景内临时修改');
    await page.getByRole('button', {name: '重置场景', exact: true}).click();
    await page.getByRole('dialog', {name: '重置当前场景', exact: true}).getByRole('button', {name: '确认重置', exact: true}).click();
    assert.deepEqual((await exportJSON(page)).layout.nodes.filter(node => node.scene === 'library'), baseline.baseline.nodes.filter(node => node.scene === 'library'));
    await page.getByRole('button', {name: '重置全部', exact: true}).click();
    await page.getByRole('dialog', {name: '重置全部原子布局', exact: true}).getByRole('button', {name: '确认重置', exact: true}).click();
    let current = await exportJSON(page);assert.deepEqual(current.layout, baseline.baseline);assertUserBaseline(current);
    for (const invalid of ['{not json', {...current, version: 1}]) {
      const before = await exportJSON(page);await importJSON(page, invalid);await expect(page.locator('#toast')).toContainText('导入失败');
      const after = await exportJSON(page);assert.deepEqual(after.layout, before.layout);assert.deepEqual(after.baseline, before.baseline);
    }
    await importJSON(page, userDesign);await expect(page.locator('#toast')).toContainText('原子布局已导入');
    current = await exportJSON(page);assertUserBaseline(current);
    const custom = structuredClone(current);
    find(custom, title).props.text = '导入后的当前文字';custom.baseline.nodes.find(node => node.id === title).props.text = '导入专属重置基线';
    await importJSON(page, custom);await expect(page.locator('#toast')).toContainText('原子布局已导入');
    await page.reload();assert.equal(await ownText(node(page, title)), '导入后的当前文字');
    assert.equal((await exportJSON(page)).baseline.nodes.find(node => node.id === title).props.text, '导入专属重置基线');
    await page.getByRole('button', {name: '重置全部', exact: true}).click();
    await page.getByRole('dialog', {name: '重置全部原子布局', exact: true}).getByRole('button', {name: '确认重置', exact: true}).click();
    assert.equal(await ownText(node(page, title)), '导入专属重置基线');assertUserBaseline(await exportJSON(page));
  });
});

test('preview: registered sample actions do not create deleted nodes; mobile retains user overrides and atomic ownership', {timeout: 90000}, async () => {
  await withPage(async page => {
    const original = await exportJSON(page);
    await cssPixels(node(page, 'library-sidebar'), 'width', 160);await cssPixels(node(page, 'folder-tree'), 'width', 160);
    await page.locator('#mode-button').click();
    await node(page, 'library-grid--note-0-title').click();await expect(page.locator('#scene-select')).toHaveValue('read');
    await expect(node(page, 'read-coauthor')).toHaveCount(0);
    if (find(original, 'read-source')) { await node(page, 'read-source').click();await expect(page.locator('#scene-select')).toHaveValue('topics'); }
    else await page.locator('#scene-select').selectOption('topics');
    const input = node(page, 'topics-chat--chat-input').locator('textarea');
    await input.fill('只体验原子布局，不调用模型');await node(page, 'topics-chat--chat-send').click();
    await expect(page.locator('#toast')).toContainText('不调用模型');await expect(page.locator('#toast')).toContainText('不生成未注册消息');
    assert.deepEqual((await exportJSON(page)).layout, original.layout, 'preview actions must not synthesize product nodes or resurrect deleted groups');
    await assertAtomicOwnership(page);await page.screenshot({path: path.join(artifacts, 'atomic-preview.png')});
    await page.locator('#device-select').selectOption('mobile');await page.locator('#scene-select').selectOption('library');
    await cssPixels(page.locator('#viewport'), 'width', 390);await cssPixels(node(page, 'folder-tree'), 'width', 160);
    const widthDifference = await node(page, 'library-sidebar').evaluate(element => {
      const parent = element.parentElement, style = getComputedStyle(parent);
      return Math.abs(element.getBoundingClientRect().width - (parent.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)));
    });
    assert.ok(widthDifference < 1, 'mobile sidebar must fill its original parent while folder tree retains its explicit 160px width');
    await page.locator('#scene-select').selectOption('topics');await expect(node(page, 'topics-question-list')).toHaveCSS('overflow', 'hidden');
    await expect(node(page, 'topics-question-list')).toHaveCSS('height', '100px');
    assertUserBaseline(await exportJSON(page));await assertAtomicOwnership(page);
    await page.locator('#mode-button').click();await page.locator('#scene-select').selectOption('library');await select(page, 'library-grid--note-0-title');
    await page.screenshot({path: path.join(artifacts, 'atomic-mobile.png')});
  });
});
