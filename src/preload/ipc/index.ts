import type {
  CreateTabOptions,
  IpcRequests,
  RendererToMainEvents,
  MainToRendererEvents,
  TabId,
  TabSnapshot,
  UpdateState
} from '../../shared/ipc'
import type { Unsubscribe } from '@electron-browser/typed-ipc'
import { TypedIpcRenderer } from '@electron-browser/typed-ipc/renderer'
import type { BrowserLayout } from '../../shared/browser-layout'
import type { BrowserShortcut } from '../../shared/browser-shortcuts'

const ipc = new TypedIpcRenderer<IpcRequests, RendererToMainEvents, MainToRendererEvents>()

// 通过 contextBridge 暴露给本地界面的业务 API。invoke 返回 Promise，页面拿不到原生视图对象。
export const api = {
  getAppVersion: () => ipc.invoke('app:getVersion'),
  getUpdateState: () => ipc.invoke('update:getState'),
  checkForUpdates: () => ipc.invoke('update:check'),
  downloadUpdate: () => ipc.invoke('update:download'),
  installUpdate: () => ipc.invoke('update:install'),
  onUpdateStateChanged: (listener: (state: UpdateState) => void): Unsubscribe =>
    ipc.on('update:stateChanged', listener),
  updateWindowSize: (width: number, height: number) =>
    ipc.invoke('window:updateSize', width, height),
  updateBrowserLayout: (layout: BrowserLayout) => ipc.invoke('window:updateBrowserLayout', layout),
  onBrowserShortcut: (listener: (shortcut: BrowserShortcut) => void): Unsubscribe =>
    ipc.on('browser:shortcut', listener),
  /** 创建标签并返回当时的状态；Promise 完成不代表网页已经加载完成。 */
  createTab: (options: CreateTabOptions) => ipc.invoke('tab:create', options),
  /** 获取当前窗口的完整快照，适用于界面初次挂载或重载后恢复标签列表。 */
  getTabState: () => ipc.invoke('tab:getState'),
  /** 切换当前窗口中的活动标签；最新 activeTabId 由状态事件通知。 */
  activateTab: (tabId: TabId) => ipc.invoke('tab:activate', tabId),
  /** 直接关闭标签，网页销毁后返回 true。 */
  closeTab: (tabId: TabId) => ipc.invoke('tab:close', tabId),
  /**
   * 订阅状态并返回取消函数，组件卸载时应调用它。
   * 建议先订阅，再 getTabState；两条通道都只应用不旧于当前 revision 的快照。
   * 回调只收到业务数据，TypedIpcRenderer 不会把 Electron event 暴露给页面。
   */
  onTabStateChanged: (listener: (snapshot: TabSnapshot) => void): Unsubscribe =>
    ipc.on('tab:stateChanged', listener)
}
