/* eslint-disable @typescript-eslint/explicit-function-return-type -- node:test 使用 JavaScript。 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'
import { setup, root as libraryRoot } from '../packages/typed-ipc/tests/helpers.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))

function loadApplication({
  contextIsolated = true,
  platform = 'win32',
  isDev = false,
  isPackaged = false,
  argv = [],
  rendererUrl = 'http://localhost:5173/'
} = {}) {
  const ipc = setup()
  const app = new EventEmitter()
  app.isPackaged = isPackaged
  app.whenReady = () => Promise.resolve()
  app.getVersion = () => '1.2.3'
  app.quit = () => app.emit('will-quit')
  const windows = []
  const views = []
  const errors = []
  const updateCalls = []
  const updater = Object.assign(new EventEmitter(), {
    checkForUpdates: async () => {
      updateCalls.push('check')
    },
    downloadUpdate: async () => {
      updateCalls.push('download')
    },
    quitAndInstall: () => updateCalls.push('install')
  })
  class WebContentsView {
    constructor(options) {
      this.options = options
      this.destroyed = false
      this.url = ''
      this.title = ''
      this.focusCount = 0
      this.loads = []
      this.closeCalls = []
      this.back = false
      this.forward = false
      this.webContents = Object.assign(new EventEmitter(), {
        isDestroyed: () => this.destroyed,
        getURL: () => this.url,
        getTitle: () => this.title,
        navigationHistory: {
          canGoBack: () => this.back,
          canGoForward: () => this.forward
        },
        setWindowOpenHandler: (handler) => {
          this.openHandler = handler
        },
        focus: () => {
          this.focusCount++
        },
        loadURL: (url) => {
          this.loads.push(url)
          this.webContents.emit('did-start-navigation', {
            url,
            isMainFrame: true,
            isSameDocument: false
          })
          return new Promise((resolve, reject) => {
            this.resolveLoad = resolve
            this.rejectLoad = reject
          })
        },
        close: (options) => {
          if (this.destroyed) return
          this.closeCalls.push(options)
          this.destroyed = true
          this.webContents.emit('destroyed')
        }
      })
      views.push(this)
    }
    setBounds(bounds) {
      this.bounds = { ...bounds }
    }
  }
  function useWindow(win) {
    ipc.mainEvent.sender = win.webContents
    ipc.mainEvent.senderFrame = win.webContents.mainFrame
  }
  class BrowserWindow extends EventEmitter {
    static getAllWindows() {
      return windows.filter((win) => !win.destroyed)
    }
    constructor(options) {
      super()
      this.id = windows.length + 1
      this.options = options
      this.destroyed = false
      this.sizes = []
      this.contentSize = [options.width ?? 900, options.height ?? 670]
      this.contentView = {
        children: [],
        addChildView: (view) => {
          this.contentView.removeChildView(view)
          this.contentView.children.push(view)
        },
        removeChildView: (view) => {
          const index = this.contentView.children.indexOf(view)
          if (index !== -1) this.contentView.children.splice(index, 1)
        }
      }
      this.webContents = Object.assign(new EventEmitter(), {
        id: this.id + 100,
        isDestroyed: () => this.destroyed,
        setWindowOpenHandler: () => {},
        focus: () => {},
        send: (channel, ...args) => ipc.ipcRenderer.emit(channel, ipc.rendererEvent, ...args),
        mainFrame: {
          url: '',
          detached: false,
          isDestroyed: () => this.destroyed
        }
      })
      windows.push(this)
      app.emit('browser-window-created', {}, this)
    }
    show() {
      this.visible = true
    }
    loadURL(url) {
      this.url = url
      this.webContents.mainFrame.url = url
      useWindow(this)
    }
    loadFile(file) {
      this.file = file
      this.webContents.mainFrame.url = pathToFileURL(file).href
      useWindow(this)
    }
    isDestroyed() {
      return this.destroyed
    }
    setSize(width, height) {
      this.sizes.push([width, height])
      this.contentSize = [width, height]
      this.emit('resize')
    }
    getContentSize() {
      return this.contentSize
    }
    close() {
      this.destroyed = true
      this.emit('closed')
    }
  }
  const exposed = {}
  const page = {}
  const modules = new Map()
  function load(filename) {
    if (modules.has(filename)) return modules.get(filename).exports
    const module = { exports: {} }
    modules.set(filename, module)
    const { outputText } = ts.transpileModule(readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    })
    vm.runInNewContext(
      outputText,
      {
        exports: module.exports,
        module,
        __dirname: path.dirname(filename),
        process: {
          argv,
          platform,
          env: isDev ? { ELECTRON_RENDERER_URL: rendererUrl } : {},
          contextIsolated
        },
        URL,
        structuredClone,
        setImmediate,
        window: page,
        console: { ...console, error: (...args) => errors.push(args) },
        require: (name) => {
          if (name === 'electron-updater') return { autoUpdater: updater }
          if (name === 'electron')
            return {
              app,
              BrowserWindow,
              WebContentsView,
              ipcMain: ipc.ipcMain,
              ipcRenderer: ipc.ipcRenderer,
              shell: { openExternal: () => {} },
              contextBridge: {
                exposeInMainWorld: (key, value) => {
                  exposed[key] = value
                }
              }
            }
          if (name === '@electron-toolkit/utils')
            return {
              electronApp: { setAppUserModelId: () => {} },
              optimizer: { watchWindowShortcuts: () => {} },
              is: { dev: isDev }
            }
          if (name === '@electron-toolkit/preload') return { electronAPI: {} }
          if (name === '@electron-browser/typed-ipc/main')
            return ipc.load(path.join(libraryRoot, 'dist/main/index.js'))
          if (name === '@electron-browser/typed-ipc/renderer')
            return ipc.load(path.join(libraryRoot, 'dist/renderer/index.js'))
          if (name === 'path' || name === 'node:path') return path
          if (name === 'node:url') return { pathToFileURL }
          if (name === 'node:crypto') return { randomUUID }
          if (name === 'node:net') return { isIP }
          if (name.endsWith('?asset')) return { default: 'icon.png' }
          const target = path.resolve(path.dirname(filename), name)
          return load(existsSync(`${target}.ts`) ? `${target}.ts` : path.join(target, 'index.ts'))
        }
      },
      { filename }
    )
    return module.exports
  }
  return {
    ...ipc,
    app,
    windows,
    views,
    errors,
    updater,
    updateCalls,
    exposed,
    page,
    load,
    BrowserWindow,
    useWindow
  }
}

for (const contextIsolated of [true, false]) {
  test(`business routers connect the preload API to the calling window (isolation=${contextIsolated})`, async () => {
    const env = loadApplication({ contextIsolated, platform: 'darwin' })
    env.load(path.join(root, 'src/main/index.ts'))
    await Promise.resolve()
    env.load(path.join(root, 'src/preload/index.ts'))
    const api = (contextIsolated ? env.exposed : env.page).api
    assert.equal(await api.getAppVersion(), '1.2.3')
    assert.deepEqual([...env.handlers.keys()].sort(), [
      'app:getVersion',
      'tab:activate',
      'tab:close',
      'tab:create',
      'tab:getState',
      'update:check',
      'update:download',
      'update:getState',
      'update:install',
      'window:updateBrowserLayout',
      'window:updateSize'
    ])
    await api.updateWindowSize(1000, 700)
    assert.deepEqual(env.windows[0].sizes, [[1000, 700]])
    for (const dimensions of [
      [0, 1],
      [-1, 1],
      [1.5, 1],
      [1, NaN],
      ['10', 20]
    ]) {
      await assert.rejects(api.updateWindowSize(...dimensions), /正整数/)
    }
    env.windows[0].close()
    await assert.rejects(api.updateWindowSize(900, 600), /未登记或不可用/)
    env.app.emit('activate')
    assert.equal(env.windows.length, 2)
    await api.updateWindowSize(900, 600)
    assert.deepEqual(env.windows[1].sizes, [[900, 600]])
    assert.equal(env.handlers.size, 11)
    env.windows[1].destroyed = true
    await assert.rejects(api.updateWindowSize(900, 600), /未登记或不可用/)
  })
}

test('updates are disabled outside packaged Windows apps', async () => {
  for (const options of [
    { isPackaged: false },
    { isPackaged: true, platform: 'darwin' },
    { platform: 'darwin', argv: ['--test-updates'] }
  ]) {
    const env = loadApplication(options)
    env.load(path.join(root, 'src/main/index.ts'))
    await Promise.resolve()
    env.load(path.join(root, 'src/preload/index.ts'))
    const api = env.exposed.api
    await api.checkForUpdates()
    await api.downloadUpdate()
    await api.installUpdate()
    assert.equal((await api.getUpdateState()).status, 'disabled')
    assert.deepEqual(env.updateCalls, [])
  }
})

test('development update testing uses its feed and never installs, including on quit', async () => {
  const env = loadApplication({ isDev: true, argv: ['--test-updates'] })
  env.load(path.join(root, 'src/main/index.ts'))
  await Promise.resolve()
  env.load(path.join(root, 'src/preload/index.ts'))
  const api = env.exposed.api
  assert.equal(env.updater.forceDevUpdateConfig, true)
  assert.equal(env.updater.autoDownload, false)
  assert.equal(env.updater.autoInstallOnAppQuit, false)
  assert.equal((await api.getUpdateState()).testMode, true)
  assert.deepEqual(env.updateCalls, ['check'])
  env.updater.emit('update-available', { version: '999.0.0' })
  await api.downloadUpdate()
  env.updater.emit('download-progress', { percent: 42 })
  assert.equal((await api.getUpdateState()).testMode, true)
  env.updater.emit('update-downloaded', { version: '999.0.0' })
  await api.installUpdate()
  await new Promise(setImmediate)
  assert.equal((await api.getUpdateState()).status, 'downloaded')
  assert.deepEqual(env.updateCalls, ['check', 'download'])
  await api.checkForUpdates()
  assert.equal((await api.getUpdateState()).status, 'checking')
  assert.deepEqual(env.updateCalls, ['check', 'download', 'check'])
  env.updater.emit('error', new Error('test server offline'))
  assert.equal((await api.getUpdateState()).testMode, true)
  await api.checkForUpdates()
  assert.deepEqual(env.updateCalls, ['check', 'download', 'check', 'check'])
  assert.equal(env.updater.autoInstallOnAppQuit, false)
})

test('packaged apps ignore the development update flag', async () => {
  const env = loadApplication({ isPackaged: true, argv: ['--test-updates'] })
  env.load(path.join(root, 'src/main/index.ts'))
  await Promise.resolve()
  assert.equal(env.updater.forceDevUpdateConfig, false)
  assert.equal(env.updater.autoInstallOnAppQuit, true)
  assert.equal(
    env.load(path.join(root, 'src/main/updater.ts')).getUpdateState().testMode,
    undefined
  )
})

test('update IPC guards each stage and preserves pending downloads across windows', async () => {
  const env = loadApplication({ isPackaged: true })
  env.load(path.join(root, 'src/main/index.ts'))
  await Promise.resolve()
  env.load(path.join(root, 'src/preload/index.ts'))
  const api = env.exposed.api
  assert.deepEqual(env.updateCalls, ['check'])
  assert.equal(env.updater.autoDownload, false)
  assert.equal(env.updater.autoInstallOnAppQuit, true)
  assert.equal(env.updater.disableDifferentialDownload, true)
  await api.checkForUpdates()
  await api.downloadUpdate()
  await api.installUpdate()
  assert.deepEqual(env.updateCalls, ['check'])

  const received = []
  const unsubscribe = api.onUpdateStateChanged((state) => received.push(state))
  env.updater.emit('update-available', { version: '1.3.0' })
  await Promise.all([api.downloadUpdate(), api.downloadUpdate()])
  await api.checkForUpdates()
  assert.deepEqual(env.updateCalls, ['check', 'download'])
  env.updater.emit('download-progress', { percent: 42 })
  assert.equal(received.at(-1).percent, 42)

  const { createMainWindow } = env.load(path.join(root, 'src/main/windows/main-window.ts'))
  createMainWindow()
  assert.equal((await api.getUpdateState()).status, 'downloading')
  env.updater.emit('update-downloaded', { version: '1.3.0' })
  const ready = await api.getUpdateState()
  ready.status = 'idle'
  assert.equal((await api.getUpdateState()).status, 'downloaded')
  await api.checkForUpdates()
  await api.installUpdate()
  await api.installUpdate()
  assert.deepEqual(env.updateCalls, ['check', 'download'])
  await new Promise(setImmediate)
  assert.deepEqual(env.updateCalls, ['check', 'download', 'install'])
  assert.equal((await api.getUpdateState()).status, 'installing')
  assert.ok(
    received.every((state, index) => index === 0 || state.revision >= received[index - 1].revision)
  )
  unsubscribe()
})

test('update failures can be retried and untrusted callers cannot install', async () => {
  const env = loadApplication({ isPackaged: true })
  env.load(path.join(root, 'src/main/index.ts'))
  await Promise.resolve()
  env.load(path.join(root, 'src/preload/index.ts'))
  const api = env.exposed.api
  env.updater.emit('update-not-available')
  env.updater.checkForUpdates = async () => {
    const error = new Error('network unavailable')
    env.updater.emit('error', error)
    throw error
  }
  await api.checkForUpdates()
  assert.equal((await api.getUpdateState()).status, 'error')
  assert.equal(env.errors.length, 1)
  env.updater.checkForUpdates = async () =>
    env.updater.emit('update-available', { version: '1.3.0' })
  await api.checkForUpdates()
  env.updater.downloadUpdate = async () => {
    throw new Error('download interrupted')
  }
  await api.downloadUpdate()
  assert.equal((await api.getUpdateState()).status, 'error')
  await api.checkForUpdates()
  assert.equal((await api.getUpdateState()).status, 'available')
  env.updater.emit('update-downloaded', { version: '1.3.0' })
  env.mainEvent.senderFrame.url = 'https://untrusted.example/'
  for (const invoke of [
    api.getUpdateState,
    api.checkForUpdates,
    api.downloadUpdate,
    api.installUpdate
  ]) {
    await assert.rejects(invoke(), /不受信任/)
  }
  await new Promise(setImmediate)
  assert.equal(env.updateCalls.includes('install'), false)
})

test('closing an older window does not clear the current main window', () => {
  const env = loadApplication()
  const { createMainWindow, getMainWindow } = env.load(
    path.join(root, 'src/main/windows/main-window.ts')
  )
  const first = createMainWindow()
  const second = createMainWindow()
  first.close()
  assert.equal(getMainWindow(), second)
  second.close()
  assert.equal(getMainWindow(), null)
})

test('business router imports do not register handlers before the application mounts them', () => {
  const env = loadApplication()
  const { registerIpcRouters } = env.load(path.join(root, 'src/main/ipc/index.ts'))
  assert.equal(env.handlers.size, 0)
  registerIpcRouters()
  assert.equal(env.handlers.size, 11)
})

test('duplicate startup preserves the active business handlers', async () => {
  const env = loadApplication()
  const { registerIpcRouters } = env.load(path.join(root, 'src/main/ipc/index.ts'))
  registerIpcRouters()
  assert.throws(() => registerIpcRouters(), /already registered/)
  assert.equal(env.handlers.size, 11)
  const { createMainWindow } = env.load(path.join(root, 'src/main/windows/main-window.ts'))
  createMainWindow()
  assert.equal(await env.renderer.invoke('app:getVersion'), '1.2.3')
})

test('window contexts route requests to their owner and release independently', async () => {
  const env = loadApplication()
  const { registerIpcRouters } = env.load(path.join(root, 'src/main/ipc/index.ts'))
  const { createMainWindow } = env.load(path.join(root, 'src/main/windows/main-window.ts'))
  const { windowRegistry } = env.load(path.join(root, 'src/main/windows/window-registry.ts'))
  registerIpcRouters()
  const first = createMainWindow()
  const second = createMainWindow()
  const context = windowRegistry.getByWindowId(first.id)
  assert.equal(context.window, first)
  assert.ok(Object.isFrozen(context))
  assert.equal(context.rendererUrl, pathToFileURL(first.file).href)
  assert.equal(windowRegistry.getBySender(first.webContents), context)
  assert.notEqual(context.tabs, windowRegistry.getByWindowId(second.id).tabs)

  env.useWindow(first)
  await env.renderer.invoke('window:updateSize', 1100, 750)
  assert.deepEqual(first.sizes, [[1100, 750]])
  assert.deepEqual(second.sizes, [])
  await assert.rejects(env.renderer.invoke('tab:create'), /options 对象/)
  const state = await env.renderer.invoke('tab:create', { input: 'https://example.com' })
  assert.equal(context.tabs.getSnapshot().activeTabId, state.id)
  assert.equal(windowRegistry.getByWindowId(second.id).tabs.getSnapshot().tabs.length, 0)
  assert.equal(windowRegistry.getBySender(env.views[0].webContents), undefined)

  let disposed = 0
  const dispose = context.tabs.dispose.bind(context.tabs)
  context.tabs.dispose = () => {
    disposed++
    dispose()
  }
  first.close()
  assert.equal(disposed, 1)
  assert.equal(windowRegistry.getByWindowId(first.id), undefined)
  assert.equal(windowRegistry.getBySender(first.webContents), undefined)
  assert.equal(windowRegistry.list().length, 1)
  context.tabs.dispose()
  assert.throws(() => context.tabs.subscribe(() => {}), /已释放/)
  await assert.rejects(env.renderer.invoke('app:getVersion'), /未登记或不可用/)
  env.useWindow(second)
  await env.renderer.invoke('window:updateSize', 900, 600)
  assert.deepEqual(second.sizes, [[900, 600]])
})

test('registry rejects duplicates and its cleanup cannot unregister a later registration', () => {
  const env = loadApplication()
  const { WindowRegistry } = env.load(path.join(root, 'src/main/windows/window-registry.ts'))
  const { createWindowContext } = env.load(path.join(root, 'src/main/windows/window-context.ts'))
  const registry = new WindowRegistry()
  const win = new env.BrowserWindow({})
  const context = createWindowContext(win, {}, 'http://localhost:5173/')
  const unregister = registry.register(context)
  assert.throws(() => registry.register(context), /已登记/)
  assert.throws(
    () => registry.register({ window: { ...win, isDestroyed: () => false, id: win.id + 1 } }),
    /已登记/
  )
  assert.throws(
    () =>
      registry.register({
        window: { ...win, isDestroyed: () => false, webContents: { isDestroyed: () => false } }
      }),
    /已登记/
  )
  const snapshot = registry.list()
  snapshot.pop()
  assert.equal(registry.list().length, 1)
  unregister()
  const unregisterAgain = registry.register(context)
  unregister()
  assert.equal(registry.getBySender(win.webContents), context)
  assert.equal(registry.getByWindowId(win.id), context)
  unregisterAgain()
  win.close()
  assert.throws(() => registry.register(context), /已销毁/)
})

for (const isDev of [true, false]) {
  test(`IPC requires a registered, live main frame at the configured entry (dev=${isDev})`, async () => {
    const env = loadApplication({ isDev, rendererUrl: 'http://localhost:5173/app/' })
    const { registerIpcRouters } = env.load(path.join(root, 'src/main/ipc/index.ts'))
    const { createMainWindow } = env.load(path.join(root, 'src/main/windows/main-window.ts'))
    registerIpcRouters()
    const win = createMainWindow()
    const sender = win.webContents
    const frame = sender.mainFrame
    const entry = frame.url
    const invoke = () => env.renderer.invoke('app:getVersion')

    assert.equal(await invoke(), '1.2.3')
    frame.url = `${entry}?mode=test#/settings`
    assert.equal(await invoke(), '1.2.3')
    frame.url = entry

    env.mainEvent.sender = { ...sender }
    await assert.rejects(invoke(), /未登记或不可用/)
    env.useWindow(win)
    for (const senderFrame of [null, { ...frame }, { ...frame, url: 'https://example.com/' }]) {
      env.mainEvent.senderFrame = senderFrame
      await assert.rejects(invoke(), /主 frame/)
    }
    env.useWindow(win)
    frame.detached = true
    await assert.rejects(invoke(), /主 frame/)
    frame.detached = false
    frame.isDestroyed = () => true
    await assert.rejects(invoke(), /主 frame/)
    frame.isDestroyed = () => false

    const untrustedUrls = [
      '',
      'not a URL',
      'about:blank',
      'https://example.com/',
      `${entry}other`,
      isDev
        ? 'http://localhost:5174/app/'
        : pathToFileURL(path.join(win.file, '../other.html')).href,
      isDev ? 'http://localhost.evil.test:5173/app/' : `file://evil.test${new URL(entry).pathname}`,
      isDev
        ? 'http://localhost:5173@evil.test/app/'
        : `https://example.com${new URL(entry).pathname}`,
      isDev ? 'http://user:password@localhost:5173/app/' : 'file:///C:/other/index.html'
    ]
    for (const url of untrustedUrls) {
      frame.url = url
      await assert.rejects(invoke(), /不受信任/)
    }
    frame.url = entry

    // 界面重载后切换到新的主 frame；旧 frame 的请求不能再使用窗口权限。
    sender.mainFrame = { ...frame }
    await assert.rejects(invoke(), /主 frame/)
    env.useWindow(win)
    assert.equal(await invoke(), '1.2.3')
    sender.isDestroyed = () => true
    await assert.rejects(invoke(), /未登记或不可用/)
  })
}

test('tab snapshots are sent only to the supplied live target', () => {
  const env = loadApplication()
  const { sendTabSnapshot } = env.load(path.join(root, 'src/main/ipc/tab-events.ts'))
  const received = []
  const target = { isDestroyed: () => false, send: (...args) => received.push(args) }
  const snapshot = { revision: 0, tabs: [], activeTabId: null }
  sendTabSnapshot(target, snapshot)
  assert.deepEqual(received, [['tab:stateChanged', snapshot]])
  target.isDestroyed = () => true
  sendTabSnapshot(target, snapshot)
  assert.equal(received.length, 1)
})

test('navigation input normalizes explicit URLs and completes domain addresses with HTTPS', () => {
  const env = loadApplication()
  const { resolveNavigationInput } = env.load(path.join(root, 'src/main/tabs/navigation-input.ts'))
  for (const [input, expected] of [
    [' HTTPS://EXAMPLE.COM:443/path ', 'https://example.com/path'],
    ['http://example.com:80', 'http://example.com/'],
    ['https://localhost:3000/path', 'https://localhost:3000/path'],
    ['baidu.com', 'https://baidu.com/'],
    ['  WWW.BAIDU.COM  ', 'https://www.baidu.com/'],
    ['baidu.com/path?a=1&b=2#section', 'https://baidu.com/path?a=1&b=2#section'],
    ['baidu.com:8080/path', 'https://baidu.com:8080/path'],
    ['baidu.com:80/path', 'https://baidu.com:80/path'],
    ['baidu.com:443', 'https://baidu.com/'],
    ['example.co.uk/path', 'https://example.co.uk/path'],
    ['example.com./path', 'https://example.com./path'],
    ['例子.中国/你好', new URL('https://例子.中国/你好').href]
  ]) {
    assert.equal(resolveNavigationInput(input), expected, input)
  }
})

test('navigation input uses HTTP for localhost and literal IP addresses while preserving ports', () => {
  const env = loadApplication()
  const { resolveNavigationInput } = env.load(path.join(root, 'src/main/tabs/navigation-input.ts'))
  for (const [input, expected] of [
    ['localhost', 'http://localhost/'],
    ['LOCALHOST:3000/path', 'http://localhost:3000/path'],
    ['app.localhost:3000', 'http://app.localhost:3000/'],
    ['localhost:443', 'http://localhost:443/'],
    ['127.0.0.1:3000/path', 'http://127.0.0.1:3000/path'],
    ['192.168.1.1', 'http://192.168.1.1/'],
    ['192.168.1.1:443', 'http://192.168.1.1:443/'],
    ['8.8.8.8', 'http://8.8.8.8/'],
    ['[::1]:3000/path', 'http://[::1]:3000/path'],
    ['[::1]:443', 'http://[::1]:443/'],
    ['::1', 'http://[::1]/'],
    ['2001:db8::1', 'http://[2001:db8::1]/']
  ]) {
    assert.equal(resolveNavigationInput(input), expected, input)
  }
})

test('navigation input searches ordinary text, email and invalid or unsupported addresses', () => {
  const env = loadApplication()
  const { resolveNavigationInput } = env.load(path.join(root, 'src/main/tabs/navigation-input.ts'))
  for (const input of [
    '',
    '  ',
    'hello',
    '中文 搜索 & a+b#片段',
    'baidu.com 怎么用',
    'user@baidu.com',
    'ftp://baidu.com',
    'javascript:alert(1)',
    'mailto:user@baidu.com',
    'file:///C:/test.txt',
    'https://',
    'https://bad host',
    'https://example.com:99999',
    'baidu.com:99999',
    'baidu.com:abc',
    '-bad.com',
    'bad-.com',
    'a..com',
    'bad_name.com',
    'bad_name.localhost',
    '-bad.localhost',
    `${'a'.repeat(64)}.com`,
    '123',
    '127.1',
    '999.999.999.999',
    '[::gg]',
    '/baidu.com/path',
    'C:\\temp\\file.txt',
    'baidu.com\\path'
  ]) {
    const result = new URL(resolveNavigationInput(input))
    assert.equal(result.origin, 'https://www.baidu.com', input)
    assert.equal(result.pathname, '/s', input)
    assert.equal(result.searchParams.get('wd'), input.trim(), input)
    assert.equal(result.searchParams.size, 1, input)
    assert.equal(result.hash, '', input)
  }
})

function createTabs() {
  const env = loadApplication()
  const { TabManager } = env.load(path.join(root, 'src/main/tabs/tab-manager.ts'))
  const win = new env.BrowserWindow({ width: 900, height: 670 })
  return { ...env, win, tabs: new TabManager(win) }
}

test('create registers an independent persistent view before loading and activates the first tab', () => {
  const { tabs, views, win } = createTabs()
  assert.deepEqual(structuredClone(tabs.getSnapshot()), {
    revision: 0,
    tabs: [],
    activeTabId: null
  })
  const snapshots = []
  tabs.subscribe((snapshot) => snapshots.push(snapshot))
  const state = tabs.create({ input: ' https://example.com ', active: false })
  assert.equal(typeof state.id, 'string')
  assert.equal(state.workspaceId, 'default')
  assert.equal(state.url, '')
  assert.equal(state.load.status, 'loading')
  assert.equal(state.canGoBack, false)
  assert.equal(state.canGoForward, false)
  assert.notEqual(views[0].webContents, win.webContents)
  assert.deepEqual(structuredClone(views[0].options), {
    webPreferences: {
      partition: 'persist:default',
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  })
  assert.deepEqual(views[0].loads, ['https://example.com/'])
  assert.deepEqual(win.contentView.children, [views[0]])
  assert.equal(tabs.getSnapshot().activeTabId, state.id)
  assert.equal(snapshots[0].tabs[0].id, state.id)
  assert.ok(snapshots.every((snapshot) => snapshot.tabs.length === 1))
  assert.ok(
    snapshots.every(
      (snapshot, index) => index === 0 || snapshot.revision > snapshots[index - 1].revision
    )
  )
  tabs.dispose()
})

for (const disposition of ['foreground-tab', 'background-tab']) {
  test(`window open creates a ${disposition} after its source without a native window`, () => {
    const { tabs, views, win, windows } = createTabs()
    const source = tabs.create({ input: 'https://example.com/source' })
    const current = tabs.create({ input: 'https://example.com/current' })
    const snapshots = []
    tabs.subscribe((snapshot) => snapshots.push(snapshot))

    const result = views[0].openHandler({ url: 'https://example.com/opened', disposition })

    assert.equal(result.action, 'deny')
    assert.equal(windows.length, 1)
    assert.equal(views.length, 3)
    assert.deepEqual(views[2].loads, ['https://example.com/opened'])
    const snapshot = tabs.getSnapshot()
    const opened = snapshot.tabs[1]
    assert.deepEqual(
      Array.from(snapshot.tabs, (tab) => tab.id),
      [source.id, opened.id, current.id]
    )
    assert.equal(opened.workspaceId, source.workspaceId)
    const background = disposition === 'background-tab'
    assert.equal(snapshot.activeTabId, background ? current.id : opened.id)
    assert.deepEqual(win.contentView.children, [views[background ? 1 : 2]])
    assert.equal(views[2].focusCount, background ? 0 : 1)
    assert.ok(snapshots.some((value) => value.tabs.length === 3))
    tabs.dispose()
  })
}

test('unsupported window URLs and POST forms do not create tabs or become searches', () => {
  const { tabs, views } = createTabs()
  tabs.create({ input: 'https://example.com/source' })
  const before = tabs.getSnapshot()
  for (const details of [
    ...[
      'about:blank',
      'mailto:user@example.com',
      'file:///test.html',
      'javascript:1',
      'example.com',
      'localhost:3000',
      '/relative',
      '搜索词',
      ''
    ].map((url) => ({ url })),
    {
      url: 'https://example.com/submit',
      postBody: {
        data: [{ bytes: Buffer.from('value=1') }],
        contentType: 'application/x-www-form-urlencoded'
      }
    }
  ]) {
    assert.equal(views[0].openHandler(details).action, 'deny')
  }
  assert.equal(views.length, 1)
  assert.deepEqual(tabs.getSnapshot(), before)
  tabs.dispose()
})

test('window open remains denied after mounting failure, source destruction or disposal', () => {
  const { tabs, views, win, errors } = createTabs()
  tabs.create({ input: 'https://example.com/source' })
  const before = tabs.getSnapshot()
  const open = () => views[0].openHandler({ url: 'https://example.com/opened' })
  const add = win.contentView.addChildView
  win.contentView.addChildView = (view) => {
    if (view !== views[0]) throw new Error('mount failed')
    add(view)
  }
  assert.equal(open().action, 'deny')
  assert.deepEqual(tabs.getSnapshot(), before)
  assert.deepEqual(win.contentView.children, [views[0]])
  assert.equal(views[1].destroyed, true)
  assert.equal(views[1].loads.length, 0)
  assert.equal(errors.length, 1)
  views[0].webContents.close()
  assert.equal(open().action, 'deny')
  tabs.dispose()
  assert.equal(open().action, 'deny')
  assert.equal(views.length, 2)
})

test('background creation, insertion, activation and layout preserve existing pages', () => {
  const { tabs, views, win } = createTabs()
  const bounds = { x: 0, y: 80, width: 900, height: 590 }
  tabs.setContentBounds(bounds)
  const first = tabs.create({ input: 'https://example.com/first' })
  const background = tabs.create({ input: '中文 & a+b', active: false, index: 0 })
  assert.equal(new URL(views[1].loads[0]).searchParams.get('wd'), '中文 & a+b')
  assert.equal(tabs.getSnapshot().activeTabId, first.id)
  assert.deepEqual(win.contentView.children, [views[0]])
  assert.equal(views[1].focusCount, 0)
  const third = tabs.create({ input: 'https://example.com/third', index: 1 })
  assert.deepEqual(
    Array.from(tabs.getSnapshot().tabs, (tab) => tab.id),
    [background.id, third.id, first.id]
  )
  assert.deepEqual(win.contentView.children, [views[2]])
  assert.equal(views[0].destroyed, false)
  assert.deepEqual(views[2].bounds, bounds)
  bounds.width = 1
  tabs.activate(background.id)
  assert.equal(views[1].bounds.width, 900)
  assert.deepEqual(win.contentView.children, [views[1]])
  tabs.setContentBounds({ x: 0, y: 80, width: 1000, height: 620 })
  assert.equal(views[1].bounds.width, 1000)
  tabs.activate(first.id)
  assert.equal(views[0].bounds.width, 1000)
  assert.equal(views[0].loads.length, 1)
  assert.throws(() => tabs.activate('missing'), /不存在/)
  assert.throws(() => tabs.setContentBounds({ x: 0, y: 0, width: -1, height: 10 }), /非负/)
  tabs.dispose()
})

test('invalid create arguments fail before allocating views or publishing state', () => {
  const { tabs, views } = createTabs()
  const snapshots = []
  tabs.subscribe((snapshot) => snapshots.push(snapshot))
  for (const options of [
    undefined,
    null,
    [],
    'url',
    {},
    { input: 1 },
    { input: null },
    { input: 'x', workspaceId: 'other' },
    { input: 'x', workspaceId: null },
    { input: 'x', active: 1 },
    { input: 'x', active: null },
    ...[-1, 1, 0.5, NaN, Infinity, '0', null].map((index) => ({ input: 'x', index }))
  ]) {
    assert.throws(() => tabs.create(options))
  }
  assert.equal(views.length, 0)
  assert.equal(snapshots.length, 0)
  assert.equal(tabs.getSnapshot().revision, 0)
  tabs.dispose()
  assert.throws(() => tabs.create({ input: 'x' }), /已释放/)
})

test('main frame events synchronize committed URL, title, favicon and navigation history', () => {
  const { tabs, views } = createTabs()
  tabs.create({ input: 'https://example.com/' })
  const view = views[0]
  const current = () => tabs.getSnapshot().tabs[0]
  view.webContents.emit('did-redirect-navigation', {
    url: 'https://example.com/final',
    isMainFrame: true
  })
  assert.equal(current().url, '')
  view.title = 'Redirected page'
  view.back = true
  view.webContents.emit('did-navigate', {}, 'https://example.com/final')
  view.webContents.emit('page-title-updated', {}, '页面标题')
  view.webContents.emit('page-favicon-updated', {}, ['https://example.com/favicon.ico'])
  assert.equal(current().url, 'https://example.com/final')
  assert.equal(current().title, '页面标题')
  assert.equal(current().faviconUrl, 'https://example.com/favicon.ico')
  assert.equal(current().canGoBack, true)
  view.webContents.emit('did-navigate-in-page', {}, 'https://iframe.test/', false)
  assert.equal(current().url, 'https://example.com/final')
  view.forward = true
  view.webContents.emit('did-navigate-in-page', {}, 'https://example.com/final#section', true)
  assert.equal(current().url, 'https://example.com/final#section')
  assert.equal(current().canGoForward, true)
  view.webContents.emit('did-finish-load')
  view.webContents.emit('did-stop-loading')
  assert.equal(current().load.status, 'ready')
  view.webContents.emit('did-start-navigation', {
    url: 'https://iframe.test/',
    isMainFrame: false,
    isSameDocument: false
  })
  assert.equal(current().load.status, 'ready')
  tabs.dispose()
})

test('failure and crash states survive stop/finish events; cancellation and iframe errors are ignored', async () => {
  const { tabs, views } = createTabs()
  tabs.create({ input: 'https://example.com/' })
  const view = views[0]
  const current = () => tabs.getSnapshot().tabs[0]
  view.webContents.emit('did-fail-load', {}, -105, 'DNS error', 'https://iframe.test/', false)
  assert.equal(current().load.status, 'loading')
  view.webContents.emit(
    'did-fail-provisional-load',
    {},
    -3,
    'ERR_ABORTED',
    'https://example.com/',
    true
  )
  view.webContents.emit('did-stop-loading')
  view.rejectLoad(Object.assign(new Error('ERR_ABORTED'), { errno: -3 }))
  await Promise.resolve()
  assert.equal(current().load.status, 'idle')
  view.webContents.emit('did-start-navigation', {
    url: 'https://example.com/retry',
    isMainFrame: true,
    isSameDocument: false
  })
  view.webContents.emit(
    'did-fail-load',
    {},
    -105,
    'ERR_NAME_NOT_RESOLVED',
    'https://example.com/retry',
    true
  )
  view.webContents.emit('did-stop-loading')
  view.webContents.emit('did-finish-load')
  assert.deepEqual(current().load, {
    status: 'failed',
    error: { code: -105, message: 'ERR_NAME_NOT_RESOLVED', url: 'https://example.com/retry' }
  })
  view.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
  view.webContents.emit('did-stop-loading')
  view.webContents.emit('did-finish-load')
  assert.equal(current().load.status, 'crashed')
  view.webContents.emit('did-start-navigation', {
    url: 'https://example.com/recovered',
    isMainFrame: true,
    isSameDocument: false
  })
  view.webContents.emit('did-finish-load')
  assert.equal(current().load.status, 'ready')
  tabs.dispose()
})

test('late failures from the initial request cannot overwrite a subsequent navigation', async () => {
  const { tabs, views } = createTabs()
  tabs.create({ input: 'https://example.com/first' })
  const view = views[0]
  view.webContents.emit('did-start-navigation', {
    url: 'https://example.com/second',
    isMainFrame: true,
    isSameDocument: false
  })
  view.webContents.emit('did-navigate', {}, 'https://example.com/second')
  view.webContents.emit('did-finish-load')
  view.webContents.emit('did-fail-load', {}, -105, 'old failure', 'https://example.com/first', true)
  view.rejectLoad(Object.assign(new Error('old failure'), { errno: -105 }))
  await Promise.resolve()
  assert.equal(tabs.getSnapshot().tabs[0].url, 'https://example.com/second')
  assert.equal(tabs.getSnapshot().tabs[0].load.status, 'ready')
  tabs.dispose()
})

test('Promise-only load failure retains the tab and snapshots do not expose mutable state', async () => {
  const { tabs, views, errors } = createTabs()
  const snapshots = []
  tabs.subscribe((snapshot) => {
    snapshot.tabs[0].title = 'subscriber mutation'
  })
  tabs.subscribe(() => {
    throw new Error('broken subscriber')
  })
  tabs.subscribe((snapshot) => snapshots.push(snapshot))
  const created = tabs.create({ input: 'https://example.com/' })
  created.title = 'caller mutation'
  created.load.status = 'ready'
  assert.equal(tabs.getSnapshot().tabs[0].title, '新标签页')
  assert.equal(snapshots[0].tabs[0].title, '新标签页')
  views[0].rejectLoad(Object.assign(new Error('connection refused'), { errno: -102 }))
  await Promise.resolve()
  const snapshot = tabs.getSnapshot()
  assert.equal(snapshot.tabs[0].load.status, 'failed')
  snapshot.tabs[0].load.error.message = 'caller mutation'
  assert.equal(tabs.getSnapshot().tabs[0].load.error.message, 'connection refused')
  assert.equal(views[0].destroyed, false)
  assert.ok(errors.length > 0)
  tabs.dispose()
})

test('failed mounting rolls back the new tab, closes its contents and restores the previous view', () => {
  const { tabs, views, win } = createTabs()
  const first = tabs.create({ input: 'https://example.com/first' })
  const before = tabs.getSnapshot()
  const add = win.contentView.addChildView
  win.contentView.addChildView = (view) => {
    add(view)
    if (view !== views[0]) throw new Error('mount failed')
  }
  assert.throws(
    () => tabs.create({ input: 'https://example.com/second', index: 0 }),
    /mount failed/
  )
  assert.deepEqual(tabs.getSnapshot(), before)
  assert.equal(tabs.getSnapshot().activeTabId, first.id)
  assert.deepEqual(win.contentView.children, [views[0]])
  assert.equal(views[1].destroyed, true)
  assert.equal(views[1].webContents.eventNames().length, 0)
  assert.equal(views[1].loads.length, 0)
  tabs.dispose()
})

test('destroyed tabs are removed and an adjacent tab becomes active', () => {
  const { tabs, views, win } = createTabs()
  tabs.create({ input: 'https://example.com/first' })
  tabs.create({ input: 'https://example.com/second' })
  const third = tabs.create({ input: 'https://example.com/third', active: false })
  views[1].webContents.close()
  assert.equal(tabs.getSnapshot().activeTabId, third.id)
  assert.deepEqual(win.contentView.children, [views[2]])
  assert.equal(views[1].webContents.eventNames().length, 0)
  views[0].webContents.close()
  assert.equal(tabs.getSnapshot().activeTabId, third.id)
  views[2].webContents.close()
  assert.equal(tabs.getSnapshot().activeTabId, null)
  assert.equal(tabs.getSnapshot().tabs.length, 0)
  assert.equal(win.contentView.children.length, 0)
  tabs.dispose()
})

test('close removes background tabs without changing focus and activates the right then left neighbour', async () => {
  const { tabs, views, win } = createTabs()
  const first = tabs.create({ input: 'example.com/first' })
  const middle = tabs.create({ input: 'example.com/middle' })
  const right = tabs.create({ input: 'example.com/right', active: false })
  const background = tabs.create({ input: 'example.com/background', active: false })
  const snapshots = []
  tabs.subscribe((snapshot) => snapshots.push(snapshot))
  const focusCount = views[1].focusCount
  assert.equal(await tabs.close(background.id), true)
  assert.equal(tabs.getSnapshot().activeTabId, middle.id)
  assert.equal(views[1].focusCount, focusCount)
  assert.equal(await tabs.close(middle.id), true)
  assert.equal(tabs.getSnapshot().activeTabId, right.id)
  assert.deepEqual(win.contentView.children, [views[2]])
  assert.equal(await tabs.close(right.id), true)
  assert.equal(tabs.getSnapshot().activeTabId, first.id)
  assert.equal(await tabs.close(first.id), true)
  assert.equal(tabs.getSnapshot().activeTabId, null)
  assert.equal(tabs.getSnapshot().tabs.length, 0)
  assert.equal(win.contentView.children.length, 0)
  assert.equal(win.isDestroyed(), false)
  assert.equal(snapshots.length, 4)
  for (const view of views) {
    assert.equal(view.destroyed, true)
    assert.equal(view.closeCalls.length, 1)
    assert.equal(view.closeCalls[0], undefined)
    assert.equal(view.webContents.eventNames().length, 0)
    view.rejectLoad(new Error('late rejection after close'))
  }
  await Promise.resolve()
  assert.equal(snapshots.length, 4)
  tabs.dispose()
})

test('close waits for destruction and respects activation changes while pending', async () => {
  const { tabs, views, win } = createTabs()
  const first = tabs.create({ input: 'example.com/first' })
  const second = tabs.create({ input: 'example.com/second' })
  const contents = views[1].webContents
  const nativeClose = contents.close
  let calls = 0
  contents.close = () => {
    calls++
  }
  let settled = false
  const pending = tabs.close(second.id).then((result) => {
    settled = true
    return result
  })
  await Promise.resolve()
  assert.equal(settled, false)
  assert.equal(calls, 1)
  assert.equal(tabs.getSnapshot().tabs.length, 2)
  tabs.activate(first.id)
  const focusCount = views[0].focusCount
  nativeClose()
  assert.equal(await pending, true)
  assert.equal(tabs.getSnapshot().activeTabId, first.id)
  assert.equal(views[0].focusCount, focusCount)
  assert.deepEqual(win.contentView.children, [views[0]])
  tabs.dispose()
})

test('close validates IDs and manager lifecycle', async () => {
  const { tabs } = createTabs()
  const first = tabs.create({ input: 'example.com' })
  for (const id of [undefined, null, 12, {}, '']) {
    await assert.rejects(tabs.close(id), /tabId/)
  }
  await assert.rejects(tabs.close('missing'), /不存在/)
  assert.equal(await tabs.close(first.id), true)
  await assert.rejects(tabs.close(first.id), /不存在/)
  tabs.dispose()
  await assert.rejects(tabs.close(first.id), /已释放/)
})

test('native close errors preserve the tab and allow retry without leaking listeners', async () => {
  const { tabs, views } = createTabs()
  const first = tabs.create({ input: 'example.com' })
  const contents = views[0].webContents
  const before = tabs.getSnapshot()
  const nativeClose = contents.close
  contents.close = () => {
    throw new Error('native close failed')
  }
  await assert.rejects(tabs.close(first.id), /native close failed/)
  assert.deepEqual(tabs.getSnapshot(), before)
  assert.equal(contents.listenerCount('destroyed'), 1)
  contents.close = nativeClose
  assert.equal(await tabs.close(first.id), true)
  assert.equal(contents.eventNames().length, 0)
  tabs.dispose()
})

test('layout failure after destruction still completes close and publishes the removal', async () => {
  const { tabs, views, errors } = createTabs()
  const first = tabs.create({ input: 'example.com' })
  tabs.create({ input: 'example.com/background', active: false })
  views[1].setBounds = () => {
    throw new Error('layout failed')
  }
  const snapshots = []
  tabs.subscribe((snapshot) => snapshots.push(snapshot))
  assert.equal(await tabs.close(first.id), true)
  assert.equal(snapshots.length, 1)
  assert.equal(snapshots[0].tabs.length, 1)
  assert.equal(views[0].webContents.eventNames().length, 0)
  assert.equal(errors.length, 1)
  tabs.dispose()
})

test('preload close API only closes tabs owned by the caller', async () => {
  const env = loadApplication()
  env.load(path.join(root, 'src/main/index.ts'))
  await Promise.resolve()
  env.load(path.join(root, 'src/preload/index.ts'))
  const api = env.exposed.api
  const first = await api.createTab({ input: 'example.com/first' })
  const { createMainWindow } = env.load(path.join(root, 'src/main/windows/main-window.ts'))
  createMainWindow()
  await assert.rejects(api.closeTab(first.id), /不存在/)
  env.useWindow(env.windows[0])
  assert.equal(await api.closeTab(first.id), true)
  assert.equal((await api.getTabState()).tabs.length, 0)
  await assert.rejects(api.closeTab(first.id), /不存在/)
  for (const win of env.windows) win.close()
})

test('preload create/state/activate APIs work and window resize/close manage all tab resources', async () => {
  const env = loadApplication()
  env.load(path.join(root, 'src/main/index.ts'))
  await Promise.resolve()
  env.load(path.join(root, 'src/preload/index.ts'))
  const api = env.exposed.api
  const snapshots = []
  const unsubscribe = api.onTabStateChanged((snapshot) => snapshots.push(snapshot))
  const first = await api.createTab({ input: 'example.com/first' })
  assert.deepEqual(env.views[0].loads, ['https://example.com/first'])
  const second = await api.createTab({ input: 'https://example.com/second', active: false })
  assert.equal((await api.getTabState()).activeTabId, first.id)
  await api.activateTab(second.id)
  assert.equal((await api.getTabState()).activeTabId, second.id)
  await api.updateWindowSize(1000, 700)
  assert.deepEqual(env.views[1].bounds, { x: 0, y: 92, width: 1000, height: 608 })
  env.windows[0].contentSize = [600, 40]
  env.windows[0].emit('resize')
  assert.deepEqual(env.views[1].bounds, { x: 0, y: 40, width: 600, height: 0 })
  assert.ok(snapshots.length > 0)
  unsubscribe()
  const count = snapshots.length
  await api.activateTab(first.id)
  assert.equal(snapshots.length, count)
  env.windows[0].close()
  assert.equal(env.windows[0].listenerCount('resize'), 0)
  for (const view of env.views) {
    assert.equal(view.destroyed, true)
    assert.equal(view.webContents.eventNames().length, 0)
    view.rejectLoad(new Error('late failure after dispose'))
  }
  await Promise.resolve()
  assert.equal(snapshots.length, count)
  assert.equal(env.errors.length, 0)
})

test('browser layout hides native pages, preserves hidden activation and remembers sidebar size on resize', async () => {
  const env = loadApplication()
  env.load(path.join(root, 'src/main/index.ts'))
  await Promise.resolve()
  env.load(path.join(root, 'src/preload/index.ts'))
  const api = env.exposed.api
  const win = env.windows[0]
  const first = await api.createTab({ input: 'example.com/first' })
  const second = await api.createTab({ input: 'example.com/second', active: false })
  assert.equal(win.contentView.children.length, 1)

  await api.updateBrowserLayout({ showPage: false, panelOpen: true })
  assert.equal(win.contentView.children.length, 0)
  await api.activateTab(second.id)
  assert.equal(win.contentView.children.length, 0)
  assert.equal(env.views[0].destroyed, false)
  assert.equal(env.views[1].destroyed, false)
  await api.updateWindowSize(1000, 700)
  assert.deepEqual(env.views[1].bounds, { x: 0, y: 92, width: 696, height: 608 })

  await api.updateBrowserLayout({ showPage: true, panelOpen: true })
  assert.deepEqual(win.contentView.children, [env.views[1]])
  await api.updateBrowserLayout({ showPage: true, panelOpen: false })
  assert.deepEqual(env.views[1].bounds, { x: 0, y: 92, width: 1000, height: 608 })
  await api.updateBrowserLayout({ showPage: false, panelOpen: false })
  await api.closeTab(second.id)
  assert.equal((await api.getTabState()).activeTabId, first.id)
  assert.equal(win.contentView.children.length, 0)
  win.close()
  assert.equal(env.errors.length, 0)
})

test('browser layout rejects invalid arguments before changing native content', async () => {
  const env = loadApplication()
  env.load(path.join(root, 'src/main/index.ts'))
  await Promise.resolve()
  env.load(path.join(root, 'src/preload/index.ts'))
  const api = env.exposed.api
  await api.createTab({ input: 'example.com' })
  for (const layout of [
    null,
    {},
    { showPage: true },
    { showPage: 'true', panelOpen: false },
    { showPage: false, panelOpen: 1 }
  ]) {
    await assert.rejects(api.updateBrowserLayout(layout), /布尔值/)
    assert.equal(env.windows[0].contentView.children.length, 1)
  }
  env.windows[0].close()
})

// 显式启用，确保只在完成本次构建后验证产物，避免误用旧 bundle。
if (process.env.IPC_TEST_BUNDLE === '1') {
  for (const contextIsolated of [true, false]) {
    test(`production bundles include the local library and work together (isolation=${contextIsolated})`, async () => {
      const mainFile = path.join(root, 'out/main/index.js')
      const preloadFile = path.join(root, 'out/preload/index.js')
      const mainSource = readFileSync(mainFile, 'utf8')
      const preloadSource = readFileSync(preloadFile, 'utf8')
      assert.doesNotMatch(mainSource, /require\(["']@electron-browser\/typed-ipc/)
      assert.doesNotMatch(preloadSource, /require\(["']@electron-browser\/typed-ipc/)
      assert.doesNotMatch(mainSource, /TypedIpcRenderer/)
      assert.doesNotMatch(mainSource, /IpcRouterManager/)
      assert.doesNotMatch(preloadSource, /TypedIpcMain|IpcRouterManager/)
      const env = loadApplication({ contextIsolated, platform: 'darwin' })
      env.load(mainFile)
      await Promise.resolve()
      env.load(preloadFile)
      const api = (contextIsolated ? env.exposed : env.page).api
      assert.equal(await api.getAppVersion(), '1.2.3')
      await api.updateWindowSize(1000, 700)
      assert.deepEqual(env.windows[0].sizes, [[1000, 700]])
      assert.equal(
        env.windows[0].options.webPreferences.preload,
        path.join(root, 'out/preload/index.js')
      )
      env.windows[0].close()
      env.app.emit('activate')
      await api.updateWindowSize(900, 600)
      assert.deepEqual(env.windows[1].sizes, [[900, 600]])
    })
  }
}
