import type { BrowserLayout } from '../browser-layout'
import type { BrowserShortcut } from '../browser-shortcuts'

export type AppRequests = {
  'app:getVersion': () => string
}

/** 只传输更新所需的数据，revision 防止初次查询覆盖较新的推送。 */
export type UpdateState = {
  revision: number
  /** 开发测试只检查和下载，禁止手动安装及退出时自动安装。 */
  testMode?: boolean
  status:
    | 'disabled'
    | 'idle'
    | 'checking'
    | 'latest'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'installing'
    | 'error'
  version?: string
  percent?: number
  message?: string
}

export type UpdateRequests = {
  'update:getState': () => UpdateState
  'update:check': () => void
  'update:download': () => void
  'update:install': () => void
}

export type WindowRequests = {
  'window:updateSize': (width: number, height: number) => void
  /** 仅调整网页显示区域；打开本地新标签页、错误页和侧栏时使用。 */
  'window:updateBrowserLayout': (layout: BrowserLayout) => void
}

/** 主进程生成的稳定业务 ID，不直接使用 webContents.id。 */
export type TabId = string

/** 一次主框架导航失败的信息；不把 iframe 的加载错误作为整个标签的失败。 */
export type TabNavigationError = {
  /** Electron/Chromium 的数字错误码，例如 -105 表示域名无法解析。 */
  code: number
  /** 加载事件提供的错误描述，或异常对象中的 message。 */
  message: string
  /** 失败请求的目标 URL，可能与 state.url 中上一次成功提交的地址不同。 */
  url: string
}

/**
 * idle：当前没有等待加载完成，例如导航被主动停止；不等同于加载成功。
 * loading：导航正在进行；ready：主文档已完成加载。
 * failed：导航发生网络等错误；crashed：渲染进程异常退出。
 * 使用 status 区分不同分支，只有 failed 才有 error，只有 crashed 才有 reason。
 */
export type TabLoadState =
  | { status: 'idle' | 'loading' | 'ready' }
  | { status: 'failed'; error: TabNavigationError }
  | { status: 'crashed'; reason: string }

/** 可通过 IPC 传输的标签状态，不包含 WebContentsView 等主进程对象。 */
export type TabState = {
  /** 标签的稳定业务标识，激活、关闭、查询等操作通过它定位标签。 */
  id: TabId
  /** 所属工作空间；目前仅实现 default，实际 Session 分区由主进程决定。 */
  workspaceId: string
  /** 主框架已提交的 URL；初始为空，导航提交或同文档地址变化后更新。 */
  url: string
  /** 标签栏显示的标题；初始为“新标签页”，之后随网页标题事件更新。 */
  title: string
  /** 网页图标的地址；尚未收到图标或新文档刚提交时为 null。 */
  faviconUrl: string | null
  /** 当前加载状态及对应错误信息，不包含 Promise、Error 实例或原生对象。 */
  load: TabLoadState
  /** 根据该网页自己的 Chromium 导航历史计算，不受其他标签的历史影响。 */
  canGoBack: boolean
  /** 当前历史位置之后是否还有可前进的记录。 */
  canGoForward: boolean
}

/** 当前窗口的一次完整状态；界面可按此对象整体替换自己的标签列表和活动标签。 */
export type TabSnapshot = {
  /** 每次发布时递增，查询不递增；例如已应用版本 5 后收到版本 4，应忽略后者。 */
  revision: number
  /** 当前窗口的标签，数组顺序即标签栏顺序。 */
  tabs: TabState[]
  /** 非空时必须指向 tabs 中的标签；没有标签时为 null。 */
  activeTabId: TabId | null
}

export type CreateTabOptions = {
  /** 必填的地址栏输入；支持完整 HTTP/HTTPS URL、无协议域名、本地地址及搜索词。 */
  input: string
  /** 当前仅支持 default；分区由主进程决定。 */
  workspaceId?: string
  /** 默认 true；空窗口创建首个标签时始终激活。 */
  active?: boolean
  /** 从 0 开始的插入位置，合法范围为 0..tabs.length；省略时追加。 */
  index?: number
}

export type ReloadTabOptions = {
  /** 默认 false；为 true 时忽略缓存刷新。 */
  ignoreCache?: boolean
}

/**
 * 所有操作限定在调用方所属窗口，主进程校验参数、工作空间和目标标签。
 * 无效参数、不存在或无权访问的标签使 invoke reject。
 * 返回值表示操作已处理；导航操作不等待网页加载完成，后续状态通过事件同步。
 * 此处声明业务返回类型，TypedIpcRenderer.invoke 会统一包装为 Promise。
 */
export type TabRequests = {
  /** 查询完整快照，不等待正在加载的网页完成。 */
  'tab:getState': () => TabSnapshot
  /** 创建并启动导航；返回状态副本，后续变化由 tab:stateChanged 发送。 */
  'tab:create': (options: CreateTabOptions) => TabState
  /** 显示指定标签并聚焦，原活动网页保留在后台。 */
  'tab:activate': (tabId: TabId) => void
  /**
   * 直接关闭标签，网页实际销毁后返回 true；不执行 beforeunload 确认。
   * 关闭活动标签后优先激活右侧，其次左侧；最后一个标签关闭后保留空窗口。
   */
  'tab:close': (tabId: TabId) => boolean
  /** toIndex 为移动后的最终下标，合法范围为 0..tabs.length - 1。 */
  'tab:move': (tabId: TabId, toIndex: number) => void
  /** 恢复并激活当前工作空间最近关闭的普通标签；无记录或临时空间返回 null。 */
  'tab:restoreClosed': () => TabState | null
  /** 预留：主进程按统一输入规则解析 URL 或转换搜索词；当前操作入口尚未实现。 */
  'tab:navigate': (tabId: TabId, input: string) => void
  /** 无可后退的历史时不执行操作。 */
  'tab:goBack': (tabId: TabId) => void
  /** 无可前进的历史时不执行操作。 */
  'tab:goForward': (tabId: TabId) => void
  'tab:reload': (tabId: TabId, options?: ReloadTabOptions) => void
  /** 未在加载时不执行操作；主动停止不应记为导航失败。 */
  'tab:stop': (tabId: TabId) => void
}

export type TabEvents = {
  /**
   * 仅向所属窗口发送完整快照，覆盖增删、排序、激活及页面状态变化。
   * renderer 先订阅再 getState，并按 revision 丢弃旧快照。
   */
  'tab:stateChanged': (snapshot: TabSnapshot) => void
}

export type IpcRequests = AppRequests & WindowRequests & TabRequests & UpdateRequests

// 按实际业务添加事件，函数参数表示消息载荷；事件没有返回值。
export type RendererToMainEvents = Record<never, never>
export type MainToRendererEvents = TabEvents & {
  'browser:shortcut': (shortcut: BrowserShortcut) => void
  'update:stateChanged': (state: UpdateState) => void
}
