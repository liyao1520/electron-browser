import type { WebContents } from 'electron'
import type { WindowContext } from './window-context'

/** 只登记窗口及其本地界面，不登记网页标签，也不负责销毁资源。 */
export class WindowRegistry {
  private readonly byWindowId = new Map<number, WindowContext>()
  private readonly bySender = new Map<WebContents, WindowContext>()

  public register(context: WindowContext): () => void {
    const win = context.window
    if (win.isDestroyed()) throw new Error('不能登记已销毁的窗口')
    const sender = win.webContents
    if (sender.isDestroyed()) throw new Error('不能登记已销毁的界面')
    const windowId = win.id
    if (this.byWindowId.has(windowId) || this.bySender.has(sender)) {
      throw new Error('窗口或界面已登记')
    }

    this.byWindowId.set(windowId, context)
    this.bySender.set(sender, context)
    let registered = true

    return () => {
      if (!registered) return
      registered = false
      // 使用登记时的键，避免窗口关闭后读取 Electron 对象属性。
      if (this.byWindowId.get(windowId) === context) this.byWindowId.delete(windowId)
      if (this.bySender.get(sender) === context) this.bySender.delete(sender)
    }
  }

  public getByWindowId(windowId: number): WindowContext | undefined {
    return this.byWindowId.get(windowId)
  }

  public getBySender(sender: WebContents): WindowContext | undefined {
    return this.bySender.get(sender)
  }

  public list(): readonly WindowContext[] {
    return [...this.byWindowId.values()]
  }
}

// 导入模块只建立空登记表，不访问 Electron 窗口 API。
export const windowRegistry = new WindowRegistry()
