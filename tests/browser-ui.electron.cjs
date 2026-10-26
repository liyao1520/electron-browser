/* eslint-disable @typescript-eslint/explicit-function-return-type -- Electron UI integration test. */
/* eslint-disable @typescript-eslint/no-require-imports -- Electron CJS test entry. */
// Run after pnpm build: pnpm exec electron tests/browser-ui.electron.cjs
const assert = require('node:assert/strict')
const { mkdtempSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { createServer } = require('node:http')
const { app, BrowserWindow, webContents } = require('electron')

app.setPath('userData', mkdtempSync(join(tmpdir(), 'ebrower-ui-test-')))
// Test the actual built shell in a hidden window with an isolated profile.
BrowserWindow.prototype.show = function () {
  // Keep this automated test from opening a visible application window.
}
app.on('window-all-closed', () => {})
const server = createServer((request, response) => {
  if (request.url === '/fail') return request.socket.destroy()
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  response.end('<!doctype html><title>本地测试页面</title><h1>页面已加载</h1>')
})
require('../out/main/index.js')

async function until(predicate, label) {
  const deadline = Date.now() + 10000
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function run() {
  await app.whenReady()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  await until(() => BrowserWindow.getAllWindows().length, 'shell created')
  const win = BrowserWindow.getAllWindows()[0]
  const renderer = win.webContents
  const evaluate = (source) => renderer.executeJavaScript(source)
  const assertIconAlignment = async (label) => {
    const issues = await evaluate(`(() => {
      const issues = [];
      const center = (element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      };
      const compare = (icon, target, horizontal = true) => {
        const actual = center(icon), expected = center(target);
        if (Math.abs(actual.y - expected.y) > 0.5 || (horizontal && Math.abs(actual.x - expected.x) > 0.5))
          issues.push(icon.dataset.icon || icon.classList.value);
      };
      document.querySelectorAll('.icon-button > svg, .search-submit > svg, .shortcut-icon > svg')
        .forEach((icon) => compare(icon, icon.parentElement));
      document.querySelectorAll('.browser-toolbar .browser-icon')
        .forEach((icon) => compare(icon, document.querySelector('.browser-toolbar'), false));
      document.querySelectorAll('.tab-select > svg, .tab-close > svg, .tab-search > svg, .new-tab-button > svg')
        .forEach((icon) => compare(icon, document.querySelector('.browser-tab'), false));
      return issues;
    })()`)
    assert.deepEqual(issues, [], `${label}: icon centers should match their controls and row`)
  }
  const settlePaint = () =>
    evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  await until(
    () => evaluate('Boolean(document.querySelector(".start-search"))'),
    'start page rendered'
  )
  assert.equal(await evaluate('document.querySelectorAll("[role=tab]").length'), 1)
  assert.equal(
    await evaluate('document.querySelector(".browser-chrome").getBoundingClientRect().height'),
    92
  )
  assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false)
  await assertIconAlignment('start page')
  await settlePaint()
  const image = await win.capturePage()
  writeFileSync(join(__dirname, '../out/ui-preview.png'), image.toPNG())

  await evaluate('document.querySelector("[aria-label=下载内容]").click()')
  await until(
    () => evaluate('Boolean(document.querySelector(".panel-empty"))'),
    'download placeholder'
  )
  assert.equal(
    await evaluate('document.querySelector(".browser-panel").getBoundingClientRect().width'),
    304
  )
  await assertIconAlignment('download sidebar')
  await settlePaint()
  const panelImage = await win.capturePage()
  writeFileSync(join(__dirname, '../out/ui-panel-preview.png'), panelImage.toPNG())
  await evaluate('document.querySelector("[aria-label=关闭侧栏]").click()')

  await evaluate('document.querySelector("[aria-label=浏览器菜单]").click()')
  await until(() => evaluate('Boolean(document.querySelector(".menu-content"))'), 'browser menu')
  assert.equal(
    await evaluate('document.querySelectorAll(".menu-chevron[data-icon=chevron-right]").length'),
    4
  )
  await assertIconAlignment('browser menu')
  await settlePaint()
  writeFileSync(join(__dirname, '../out/ui-menu-preview.png'), (await win.capturePage()).toPNG())
  await evaluate('document.querySelector("[aria-label=关闭侧栏]").click()')

  const origin = `http://127.0.0.1:${server.address().port}`
  // Use the actual search form and React change handler, rather than bypassing the UI via IPC.
  await evaluate(`(() => {
    const input = document.querySelector('.start-search input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '${origin}/page');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await evaluate('document.querySelector(".start-search").requestSubmit()')
  await until(
    () =>
      evaluate(
        'document.querySelector("[role=tab][aria-selected=true]")?.textContent === "本地测试页面"'
      ),
    'search creates tab'
  )
  await until(
    () => win.contentView.children.some((view) => view.webContents !== renderer),
    'native page mounted'
  )
  const native = webContents
    .getAllWebContents()
    .find((contents) => contents.getURL() === `${origin}/page`)
  assert.ok(native)

  await evaluate('document.querySelector("[aria-label=下载内容]").click()')
  await until(() => {
    const view = win.contentView.children.find((child) => child.webContents === native)
    return view?.getBounds().width === win.getContentSize()[0] - 304
  }, 'sidebar reserves native page width')
  await evaluate('document.querySelector("[aria-label=关闭侧栏]").click()')
  await until(
    () =>
      win.contentView.children.find((child) => child.webContents === native)?.getBounds().width ===
      win.getContentSize()[0],
    'page expands'
  )

  // A native page owning keyboard focus must still be able to open a local tab.
  native.sendInputEvent({ type: 'keyDown', keyCode: 'T', modifiers: ['control'] })
  native.sendInputEvent({ type: 'keyUp', keyCode: 'T', modifiers: ['control'] })
  await until(
    () => evaluate('document.querySelectorAll("[role=tab]").length === 2'),
    'native Ctrl+T'
  )
  await until(
    () => !win.contentView.children.some((child) => child.webContents === native),
    'local start page hides native view'
  )
  assert.equal(native.isDestroyed(), false)
  await evaluate('document.querySelectorAll("[role=tab]")[0].click()')
  await until(
    () => win.contentView.children.some((child) => child.webContents === native),
    'switch back restores native view'
  )

  // Load failure is shown by the local shell, with a useful URL and error state.
  await evaluate(`window.api.createTab({ input: '${origin}/fail' })`)
  await until(() => evaluate('Boolean(document.querySelector(".page-failure"))'), 'failure UI')
  await until(
    () => win.contentView.children.every((child) => child.webContents === renderer),
    'failed native page hidden'
  )
  assert.ok(
    (await evaluate('document.querySelector(".failure-detail").textContent')).includes('/fail')
  )

  // Minimum window dimensions must keep the start page and sidebar usable.
  await evaluate('document.querySelectorAll("[role=tab]")[1].click()')
  win.setSize(640, 480)
  await evaluate('document.querySelector("[aria-label=下载内容]").click()')
  await until(
    () => evaluate('Boolean(document.querySelector(".browser-panel"))'),
    'compact sidebar'
  )
  assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false)
  await assertIconAlignment('compact window')
  await settlePaint()
  const compactImage = await win.capturePage()
  writeFileSync(join(__dirname, '../out/ui-compact-preview.png'), compactImage.toPNG())

  // Closing the last real page preserves the local start page without leaking resources.
  const snapshot = await evaluate('window.api.getTabState()')
  for (const tab of snapshot.tabs) await evaluate(`window.api.closeTab(${JSON.stringify(tab.id)})`)
  await until(
    () => evaluate('document.querySelectorAll("[role=tab]").length === 1'),
    'native tabs removed'
  )
  assert.equal(native.isDestroyed(), true)
  assert.equal(await evaluate('Boolean(document.querySelector(".browser-notice"))'), false)
  console.log(
    'Browser UI integration passed: rendering, search, native layout, tabs, shortcuts, failure, compact layout and cleanup.'
  )
  win.destroy()
}

const watchdog = setTimeout(() => {
  console.error('UI test timed out')
  app.exit(1)
}, 45000)
run()
  .then(() => {
    clearTimeout(watchdog)
    server.close()
    app.exit(0)
  })
  .catch((error) => {
    console.error(error)
    clearTimeout(watchdog)
    server.close()
    app.exit(1)
  })
