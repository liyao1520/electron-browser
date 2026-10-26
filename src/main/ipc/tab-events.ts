import type { WebContents } from 'electron'
import type { BrowserShortcut } from '../../shared/browser-shortcuts'
import { TypedIpcMain } from '@electron-brower/typed-ipc/main'
import type {
  IpcRequests,
  MainToRendererEvents,
  RendererToMainEvents,
  TabSnapshot
} from '../../shared/ipc'

// 此实例只负责类型安全的事件发送，不注册 Router，也不自行寻找“当前窗口”。
const ipc = new TypedIpcMain<IpcRequests, RendererToMainEvents, MainToRendererEvents>()

/**
 * 将完整快照发给窗口创建代码指定的本地界面。
 * 管理器通过订阅与此函数连接，从而不必直接依赖 IPC 或窗口登记表。
 * 若界面已经销毁则直接跳过；界面收到数据后按 revision 判断是否需要应用。
 */
export function sendTabSnapshot(target: WebContents, snapshot: TabSnapshot): void {
  if (target.isDestroyed()) return
  ipc.send(target, 'tab:stateChanged', snapshot)
}

export function sendBrowserShortcut(target: WebContents, shortcut: BrowserShortcut): void {
  if (!target.isDestroyed()) ipc.send(target, 'browser:shortcut', shortcut)
}
