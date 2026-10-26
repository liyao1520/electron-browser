import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import type { WindowContext } from '../windows/window-context'
import { windowRegistry } from '../windows/window-registry'

export type WindowIpcEvent = IpcMainInvokeEvent | IpcMainEvent

export function resolveWindowContext(event: WindowIpcEvent): WindowContext {
  const context = windowRegistry.getBySender(event.sender)
  if (!context || context.window.isDestroyed() || event.sender.isDestroyed()) {
    throw new Error('IPC 调用方窗口未登记或不可用')
  }

  const frame = event.senderFrame
  if (!frame || frame.isDestroyed() || frame.detached || frame !== event.sender.mainFrame) {
    throw new Error('IPC 仅允许本地界面主 frame 调用')
  }

  if (!isRendererEntry(frame.url, context.rendererUrl)) {
    throw new Error('IPC 调用方页面不受信任')
  }
  return context
}

function isRendererEntry(actualUrl: string, rendererUrl: string): boolean {
  try {
    const actual = new URL(actualUrl)
    const expected = new URL(rendererUrl)
    // 开发服务器与打包入口都精确匹配协议、主机（含端口）及路径。
    // 允许同一入口的 query/hash 路由；不能只比较 file: 的 null origin。
    return (
      ['http:', 'https:', 'file:'].includes(expected.protocol) &&
      actual.protocol === expected.protocol &&
      actual.host === expected.host &&
      actual.pathname === expected.pathname &&
      actual.username === '' &&
      actual.password === ''
    )
  } catch {
    return false
  }
}
