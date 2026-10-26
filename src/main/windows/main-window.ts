import { BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'node:url'
import { is } from '@electron-toolkit/utils'
import icon from '../../../resources/icon.png?asset'
import { sendBrowserShortcut, sendTabSnapshot } from '../ipc/tab-events'
import { TabManager } from '../tabs/tab-manager'
import { createWindowContext } from './window-context'
import { windowRegistry } from './window-registry'

let mainWindow: BrowserWindow | null = null

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

/**
 * 组装一扇浏览器窗口及其专属 TabManager，并连接布局、IPC 身份和状态通知。
 * 本地界面由 BrowserWindow 自带的 webContents 加载；外部网页由 TabManager 另建视图。
 * 所有登记和订阅均在加载本地界面之前完成，保证界面启动后可以立即调用 IPC。
 */
export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: '#ffffff',
    title: 'ebrowser',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#e9edf3', symbolColor: '#48515e', height: 42 },
    trafficLightPosition: { x: 14, y: 14 },
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })
  const rendererFile = join(__dirname, '../renderer/index.html')
  const devUrl = is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined
  const rendererUrl = devUrl || pathToFileURL(rendererFile).href
  // 同一管理器只服务当前 win；其他窗口有各自的标签集合和 activeTabId。
  const tabs = new TabManager(win, (shortcut) => sendBrowserShortcut(win.webContents, shortcut))
  // Context 在窗口层统一计算工具栏、侧栏与原生网页的区域。
  const context = createWindowContext(win, tabs, rendererUrl)
  const updateTabBounds = (): void => {
    context.updateBrowserLayout()
  }
  updateTabBounds()
  win.on('resize', updateTabBounds)
  // Context 保存窗口、管理器和可信界面入口；Registry 供 IPC 根据发送方查找它。
  const unregister = windowRegistry.register(context)
  // 只向本窗口的本地界面发送状态，外部网页不会被登记为有权调用业务 IPC 的发送方。
  const target = win.webContents
  const unsubscribe = tabs.subscribe((snapshot) => sendTabSnapshot(target, snapshot))

  mainWindow = win
  win.once('closed', () => {
    // closed 表示原生窗口已关闭：先撤销布局监听、IPC 身份和通知，再释放所有网页。
    // 不能只注销 Registry，否则独立创建的标签 webContents 仍可能占用资源。
    win.off('resize', updateTabBounds)
    unregister()
    unsubscribe()
    tabs.dispose()
    // 旧窗口延迟关闭时，不能清除后来创建的新窗口。
    if (mainWindow === win) mainWindow = null
  })
  // 可取消的关窗流程待 requestCloseAll 实现后接入。
  win.on('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler((details) => {
    // 这是本地界面的新窗口策略；标签网页有自己的 setWindowOpenHandler。
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // 生命周期连接全部准备好之后，才启动本地浏览器界面的加载。
  if (devUrl) {
    win.loadURL(devUrl)
  } else {
    win.loadFile(rendererFile)
  }
  return win
}
