import type { BrowserWindow } from 'electron'
import type { TabManager } from '../tabs/tab-manager'
import {
  BROWSER_PANEL_WIDTH,
  BROWSER_TOOLBAR_HEIGHT,
  type BrowserLayout
} from '../../shared/browser-layout'

/** 主进程内一个窗口的关联对象，不通过 IPC 传输。 */
export interface WindowContext {
  readonly window: BrowserWindow
  readonly tabs: TabManager
  /** 创建窗口时确定的本地界面入口，不能从请求发送方的当前 URL 推导。 */
  readonly rendererUrl: string
  readonly updateBrowserLayout: (layout?: BrowserLayout) => void
}

export function createWindowContext(
  window: BrowserWindow,
  tabs: TabManager,
  rendererUrl: string
): WindowContext {
  let layout: BrowserLayout = { showPage: true, panelOpen: false }
  const updateBrowserLayout = (next?: BrowserLayout): void => {
    if (next) layout = { ...next }
    const [width, height] = window.getContentSize()
    const top = Math.min(BROWSER_TOOLBAR_HEIGHT, height)
    tabs.setContentBounds({
      x: 0,
      y: top,
      width: Math.max(0, width - (layout.panelOpen ? BROWSER_PANEL_WIDTH : 0)),
      height: height - top
    })
    tabs.setContentVisible(layout.showPage)
  }
  return Object.freeze({ window, tabs, rendererUrl, updateBrowserLayout })
}
