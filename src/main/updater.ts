import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import { TypedIpcMain } from '@electron-browser/typed-ipc/main'
import type {
  IpcRequests,
  MainToRendererEvents,
  RendererToMainEvents,
  UpdateState
} from '../shared/ipc'
import { windowRegistry } from './windows/window-registry'

const ipc = new TypedIpcMain<IpcRequests, RendererToMainEvents, MainToRendererEvents>()
let state: UpdateState = { revision: 0, status: 'disabled' }
let testMode = false

function publish(next: Omit<UpdateState, 'revision'>): void {
  state = { ...next, ...(testMode ? { testMode: true } : {}), revision: state.revision + 1 }
  // 更新状态由所有窗口共享，只通知已登记的本地界面。
  for (const { window } of windowRegistry.list()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      ipc.send(window.webContents, 'update:stateChanged', state)
    }
  }
}

function fail(error: unknown): void {
  // updater 可能既发出 error 事件又 reject Promise，只处理一次。
  if (state.status === 'error') return
  console.error('[updater]', error)
  publish({
    status: 'error',
    message: testMode
      ? '开发更新测试失败，请检查测试服务器、dev-app-update.yml 和主进程日志后重试。'
      : '更新失败，请检查网络后重试。'
  })
}

export function getUpdateState(): UpdateState {
  return { ...state }
}

export async function checkForUpdates(): Promise<void> {
  // 下载中不重复检查；安装版保留等待安装的状态，开发测试允许重新检查。
  const checkable = ['idle', 'latest', 'error']
  if (testMode) checkable.push('available', 'downloaded')
  if (!checkable.includes(state.status)) return
  publish({ status: 'checking' })
  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
    fail(error)
  }
}

export async function downloadUpdate(): Promise<void> {
  if (state.status !== 'available') return
  publish({ status: 'downloading', version: state.version, percent: 0 })
  try {
    await autoUpdater.downloadUpdate()
  } catch (error) {
    fail(error)
  }
}

export function installUpdate(): void {
  // 开发模式即使直接调用 IPC，也不能运行安装器。
  if (!app.isPackaged || state.status !== 'downloaded') return
  publish({ status: 'installing', version: state.version })
  // 先让 IPC 返回，再关闭应用并交给 NSIS 安装。
  setImmediate(() => autoUpdater.quitAndInstall())
}

export function initializeUpdates(): void {
  if (process.platform !== 'win32') return
  // 显式启动开发测试才读取 dev-app-update.yml，安装版始终使用正式更新源。
  testMode = !app.isPackaged && process.argv.includes('--test-updates')
  if (!app.isPackaged && !testMode) return
  autoUpdater.forceDevUpdateConfig = testMode
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = !testMode
  // 与 nsis.differentialPackage: false 配套，先使用全量下载。
  autoUpdater.disableDifferentialDownload = true
  autoUpdater.on('update-available', (info) => {
    publish({ status: 'available', version: info.version })
  })
  autoUpdater.on('update-not-available', () => publish({ status: 'latest' }))
  autoUpdater.on('download-progress', (progress) => {
    publish({ status: 'downloading', version: state.version, percent: progress.percent })
  })
  autoUpdater.on('update-downloaded', (info) => {
    publish({ status: 'downloaded', version: info.version })
  })
  autoUpdater.on('error', fail)
  publish({ status: 'idle' })
  void checkForUpdates()
}
