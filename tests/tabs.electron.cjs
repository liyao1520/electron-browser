/* eslint-disable @typescript-eslint/explicit-function-return-type -- Electron 集成测试使用 JavaScript。 */
/* eslint-disable @typescript-eslint/no-require-imports -- CJS 入口通过 require.extensions 加载项目 TypeScript。 */
// pnpm exec electron tests/tabs.electron.cjs
// 使用隐藏窗口、本地 HTTP 服务及独立临时 profile，不访问外部网站或用户数据。
const assert = require('node:assert/strict')
const { readFileSync, mkdtempSync } = require('node:fs')
const { createServer } = require('node:http')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const ts = require('typescript')
const { app, BrowserWindow, webContents } = require('electron')

require.extensions['.ts'] = (module, filename) => {
  const { outputText } = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  })
  module._compile(outputText, filename)
}
const { TabManager } = require('../src/main/tabs/tab-manager.ts')
app.setPath('userData', mkdtempSync(join(tmpdir(), 'ebrowser-tab-test-')))
// 最后一个隐藏窗口关闭后仍要完成资源释放断言，再由测试主动退出。
app.on('window-all-closed', () => {})

async function until(predicate, label) {
  const deadline = Date.now() + 10000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function withTimeout(promise, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 10000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

const server = createServer((request, response) => {
  if (request.url === '/redirect') {
    response.writeHead(302, { Location: '/redirected' })
    response.end()
  } else if (request.url === '/fail') {
    request.socket.destroy()
  } else {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.write(`<!doctype html><title>${request.url}</title><p>Tab test</p>`)
    if (request.url === '/slow') return
    if (request.url === '/iframe') response.write('<iframe src="/fail"></iframe>')
    response.end()
  }
})

async function run() {
  await app.whenReady()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const win = new BrowserWindow({ show: false, width: 900, height: 670 })
  const tabs = new TabManager(win)
  win.once('closed', () => tabs.dispose())
  const snapshots = []
  tabs.subscribe((snapshot) => snapshots.push(snapshot))
  tabs.setContentBounds({ x: 0, y: 80, width: 900, height: 590 })
  const current = (id) => tabs.getSnapshot().tabs.find((tab) => tab.id === id)
  const contentsAt = (url) =>
    webContents.getAllWebContents().find((contents) => contents.getURL() === url)

  const first = tabs.create({ input: `${origin}/first`, active: false })
  assert.equal(first.load.status, 'loading')
  await until(() => current(first.id)?.load.status === 'ready', 'first tab ready')
  assert.equal(current(first.id).title, '/first')
  const firstContents = contentsAt(`${origin}/first`)
  assert.notEqual(firstContents, win.webContents)
  await firstContents.executeJavaScript('localStorage.setItem("tab-test", "shared")')
  const second = tabs.create({ input: `${origin}/second`, active: false, index: 0 })
  await until(() => current(second.id)?.load.status === 'ready', 'background tab ready')
  const secondContents = contentsAt(`${origin}/second`)
  assert.equal(firstContents.session, secondContents.session)
  assert.equal(await secondContents.executeJavaScript('localStorage.getItem("tab-test")'), 'shared')
  assert.equal(tabs.getSnapshot().activeTabId, first.id)
  assert.deepEqual(
    tabs.getSnapshot().tabs.map((tab) => tab.id),
    [second.id, first.id]
  )
  tabs.activate(second.id)
  tabs.setContentBounds({ x: 0, y: 80, width: 800, height: 500 })
  const secondView = win.contentView.children.find((view) => view.webContents === secondContents)
  assert.deepEqual(secondView.getBounds(), { x: 0, y: 80, width: 800, height: 500 })
  assert.equal(
    win.contentView.children.some((view) => view.webContents === firstContents),
    false
  )
  assert.equal(firstContents.isDestroyed(), false)

  await firstContents.loadURL(`${origin}/redirect`)
  await until(() => current(first.id)?.load.status === 'ready', 'redirect ready')
  assert.equal(current(first.id).url, `${origin}/redirected`)
  assert.equal(current(first.id).canGoBack, true)
  await firstContents.executeJavaScript('history.pushState({}, "", "#section")')
  await until(() => current(first.id)?.url.endsWith('#section'), 'same document navigation')

  const iframe = tabs.create({ input: `${origin}/iframe`, active: false })
  await until(
    () => current(iframe.id)?.load.status === 'ready',
    'iframe failure does not fail main frame'
  )
  const failed = tabs.create({ input: `${origin}/fail`, active: false })
  await until(() => current(failed.id)?.load.status === 'failed', 'network failure state')
  assert.equal(current(failed.id).load.error.url, `${origin}/fail`)
  assert.ok(current(failed.id).load.error.code < 0)

  const slow = tabs.create({ input: `${origin}/slow`, active: false })
  await until(() => !!contentsAt(`${origin}/slow`), 'slow document committed')
  contentsAt(`${origin}/slow`).stop()
  await until(() => current(slow.id)?.load.status !== 'loading', 'stop loading')
  assert.equal(current(slow.id).load.status, 'idle')

  const beforeOpen = tabs.getSnapshot()
  await firstContents.executeJavaScript("window.open('/opened', '_blank'); undefined")
  await until(
    () =>
      tabs
        .getSnapshot()
        .tabs.some((tab) => tab.url === `${origin}/opened` && tab.load.status === 'ready'),
    'window open loads a new tab'
  )
  const afterOpen = tabs.getSnapshot()
  const sourceIndex = afterOpen.tabs.findIndex((tab) => tab.id === first.id)
  const opened = afterOpen.tabs[sourceIndex + 1]
  assert.equal(afterOpen.tabs.length, beforeOpen.tabs.length + 1)
  assert.equal(opened.url, `${origin}/opened`)
  assert.equal(opened.workspaceId, first.workspaceId)
  assert.equal(afterOpen.activeTabId, opened.id)
  assert.equal(contentsAt(opened.url).session, firstContents.session)
  assert.equal(BrowserWindow.getAllWindows().length, 1)

  const iframeContents = contentsAt(`${origin}/iframe`)
  assert.equal(await withTimeout(tabs.close(iframe.id), 'close background tab'), true)
  assert.equal(iframeContents.isDestroyed(), true)
  assert.equal(current(iframe.id), undefined)
  assert.equal(tabs.getSnapshot().activeTabId, opened.id)
  assert.equal(await withTimeout(tabs.close(opened.id), 'close active tab'), true)
  assert.equal(tabs.getSnapshot().activeTabId, failed.id)

  const protectedTab = tabs.create({ input: `${origin}/protected`, active: false })
  await until(() => current(protectedTab.id)?.load.status === 'ready', 'protected tab ready')
  const protectedContents = contentsAt(`${origin}/protected`)
  await protectedContents.executeJavaScript('window.onbeforeunload = () => false; undefined', true)
  assert.equal(
    await withTimeout(tabs.close(protectedTab.id), 'close directly without beforeunload'),
    true
  )
  assert.equal(protectedContents.isDestroyed(), true)
  assert.equal(current(protectedTab.id), undefined)

  // 独立窗口验证最后一个标签关闭后的空窗口状态。
  const emptyWin = new BrowserWindow({ show: false })
  const emptyTabs = new TabManager(emptyWin)
  emptyWin.once('closed', () => emptyTabs.dispose())
  const last = emptyTabs.create({ input: `${origin}/last` })
  await until(() => emptyTabs.getSnapshot().tabs[0]?.load.status === 'ready', 'last tab ready')
  assert.equal(await withTimeout(emptyTabs.close(last.id), 'close last tab'), true)
  assert.equal(emptyTabs.getSnapshot().activeTabId, null)
  assert.equal(emptyTabs.getSnapshot().tabs.length, 0)
  assert.equal(emptyWin.isDestroyed(), false)
  emptyWin.destroy()

  const ownedContents = webContents
    .getAllWebContents()
    .filter((contents) => contents !== win.webContents)
  win.destroy()
  await until(
    () => ownedContents.every((contents) => contents.isDestroyed()),
    'all tabs disposed with window'
  )
  assert.ok(
    snapshots.every(
      (snapshot, index) => index === 0 || snapshot.revision > snapshots[index - 1].revision
    )
  )
  console.log(
    'PASS: native Electron creation, background loading, activation, layout, shared session, redirects, history, failure, cancellation, window open, direct close and disposal'
  )
}

run()
  .then(() => {
    server.closeAllConnections()
    server.close()
    app.exit(0)
  })
  .catch((error) => {
    console.error(error)
    server.closeAllConnections()
    server.close()
    app.exit(1)
  })
