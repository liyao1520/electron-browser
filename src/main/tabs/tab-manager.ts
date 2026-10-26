// 尚未实现的标签操作保留参数契约。
/* eslint @typescript-eslint/no-unused-vars: ["error", { "argsIgnorePattern": "^_" }] */
import type { BrowserWindow, Rectangle } from 'electron'
import { WebContentsView } from 'electron'
import { randomUUID } from 'node:crypto'
import type {
  CreateTabOptions,
  ReloadTabOptions,
  TabId,
  TabSnapshot,
  TabState
} from '../../shared/ipc'
import { isHttpUrl } from '../../shared/utils'
import { resolveNavigationInput } from './navigation-input'
import { resolveBrowserShortcut, type BrowserShortcut } from '../../shared/browser-shortcuts'

/** 预留给可取消的批量关闭流程，用来区分关闭窗口与退出应用。 */
export type TabCloseReason = 'window' | 'app'
/** 每次接收当前窗口的完整标签列表，而不是单个标签的局部变化。 */
export type TabSnapshotListener = (snapshot: TabSnapshot) => void

/** 主进程内部的标签记录：把界面数据、原生网页视图和监听清理函数关联起来。 */
type TabEntry = {
  /** 可以通过 IPC 发送的数据；更新后需要发布快照，界面才能收到变化。 */
  state: TabState
  /** 实际承载网页的原生视图，不能通过 IPC 传给渲染进程。 */
  view: WebContentsView
  /** 只移除本管理器绑定的事件；关闭网页前先调用，避免触发多余状态更新。 */
  cleanup: () => void
  /**
   * 此标签发生主框架跨文档导航的次数，初始为 0，第一次开始导航后为 1。
   * 超过 1 表示已经启动后续导航，初次 loadURL 的迟到 Promise 错误应被忽略。
   * 它只用于初次加载的错误兜底，与整个窗口的快照 revision 无关。
   */
  navigationVersion: number
  /** 最近一次主框架导航的目标地址（含重定向），用来筛掉其他 URL 的迟到错误。 */
  navigationUrl: string
}

/**
 * 一个 BrowserWindow 对应一个 TabManager，由窗口创建代码负责实例化和释放。
 *
 * owner.webContents 承载本地浏览器界面；每个标签另建一个 WebContentsView 承载网页。
 * entries 负责按 ID 查标签，order 负责显示顺序，activeTabId 负责当前显示哪个标签。
 * 正常状态下 order 中的每个 ID 都能在 entries 中找到，且最多挂载一个标签视图。
 * 后台标签保留网页对象和加载状态，切换时重新挂载即可，无需重新请求网页。
 *
 * 本类管理网页及状态；窗口布局由窗口层计算，IPC 发送通过 subscribe 由外部接入。
 * move、navigate 等尚未实现的方法仍会明确抛错，不能视为已支持的操作。
 */
export class TabManager {
  /** 释放后的实例不可再次使用；也用于拦截迟到的异步回调。 */
  private disposed = false
  /** 每发布一次快照就递增；它表示状态发布顺序，不是标签数量。 */
  private revision = 0
  /** 窗口层订阅后负责把快照转发给对应的本地界面。 */
  private readonly listeners = new Set<TabSnapshotListener>()
  /** 用业务 ID 查找标签，不依赖 Electron 内部的 webContents.id。 */
  private readonly entries = new Map<TabId, TabEntry>()
  /** 单独保存排列顺序，避免把 Map 的插入顺序当作标签栏顺序。 */
  private order: TabId[] = []
  /** null 表示当前没有活动标签；首次创建时即使 active:false 也会激活。 */
  private activeTabId: TabId | null = null
  /** 相对于 owner.contentView 的网页区域；后台标签在下次激活时应用最新值。 */
  private contentBounds: Rectangle
  /** 本地新标签页或错误页显示时卸下网页，后台资源和状态继续保留。 */
  private contentVisible = true

  public constructor(
    private readonly owner: BrowserWindow,
    private readonly onShortcut?: (shortcut: BrowserShortcut) => void
  ) {
    // 默认使用整个窗口内容区。窗口层随后通过 setContentBounds 扣除工具栏区域。
    const [width, height] = owner.getContentSize()
    this.contentBounds = { x: 0, y: 0, width, height }
  }

  /**
   * 读取当前完整状态，不增加 revision，也不触发订阅回调。
   * 深拷贝可以防止调用方修改 load.error 等嵌套对象时影响管理器内部状态。
   */
  public getSnapshot(): TabSnapshot {
    this.assertAvailable()
    return {
      revision: this.revision,
      tabs: this.order.map((id) => structuredClone(this.entries.get(id)!.state)),
      activeTabId: this.activeTabId
    }
  }

  /**
   * 创建并登记标签，启动导航后立即返回当前状态副本，不等待网页加载完成。
   *
   * 顺序：校验参数 → 解析地址 → 创建视图和状态 → 绑定事件 → 登记/激活 → 通知 → 加载。
   * 参数错误、资源创建或挂载失败会抛错；网页加载失败则保留标签，并通过状态上报。
   * 返回对象不会随网页变化自动更新，后续变化需要通过 subscribe / IPC 事件接收。
   */
  public create(options: CreateTabOptions): TabState {
    this.assertAvailable()
    // 1. 在分配原生资源前校验。IPC 的 TypeScript 类型不能替代运行时校验。
    this.validateCreateOptions(options)
    // 输入解析函数统一完成协议补全、百度搜索转换和 URL 格式规范化。
    const url = resolveNavigationInput(options.input)
    // 省略 index 时追加到末尾；指定位置只影响排列，不决定是否激活。
    const index = options.index ?? this.order.length
    // 第一张标签必须显示；已有标签时，active:false 才表示后台创建。
    const shouldActivate = this.activeTabId === null || options.active !== false
    const id = randomUUID()
    // 2. 不传 owner.webContents，让 Electron 为这个标签创建独立的网页对象。
    const view = new WebContentsView({
      webPreferences: {
        // 普通标签共享此持久 Session。同源网页可共享 localStorage，不同源仍然隔离。
        partition: 'persist:default',
        // 外部网页不获得 Node.js 能力。
        nodeIntegration: false,
        // 页面脚本与 preload 的执行上下文隔离；当前标签本身没有配置 preload。
        contextIsolation: true,
        // 使用 Chromium 渲染进程沙箱。
        sandbox: true
      }
    })
    // 3. 在导航开始前准备状态，保证任何网页事件到来时都有对应记录可更新。
    const entry: TabEntry = {
      state: {
        id,
        workspaceId: 'default',
        url: '', // 目标 URL 尚未提交；由主框架导航事件更新。
        title: '新标签页',
        faviconUrl: null,
        // 创建动作即将启动导航，界面收到首份快照时就可以显示加载提示。
        load: { status: 'loading' },
        canGoBack: false,
        canGoForward: false
      },
      view,
      // bindTabEvents 会替换此函数；绑定前出错时也可以安全调用清理入口。
      cleanup: () => undefined,
      navigationVersion: 0,
      navigationUrl: url
    }

    try {
      // 4. 先准备事件和登记关系，再允许加载网页。
      // 普通网页的新窗口请求转成标签；原生窗口始终取消。
      view.webContents.setWindowOpenHandler((details) => {
        if (!this.isLiveEntry(entry)) return { action: 'deny' }
        // create 只按 URL 加载，不能把 POST 表单改成 GET。
        if (details.postBody) return { action: 'deny' }
        // Electron 已解析目标地址；其他协议不能进入地址栏的补全/搜索逻辑。
        if (!isHttpUrl(details.url)) return { action: 'deny' }

        try {
          this.create({
            input: details.url,
            workspaceId: entry.state.workspaceId,
            active: details.disposition !== 'background-tab',
            index: this.order.indexOf(entry.state.id) + 1
          })
        } catch (error) {
          console.error('打开新标签失败', error)
        }
        // 当前按独立标签打开，不保留原请求的 opener、referrer 等上下文。
        return { action: 'deny' }
      })
      this.bindTabEvents(entry)
      this.entries.set(entry.state.id, entry)
      this.order.splice(index, 0, entry.state.id)
      // 后台创建不挂载、不抢焦点，但下面仍然会调用 loadURL 开始加载。
      if (shouldActivate) this.showEntry(entry)
    } catch (error) {
      // 创建/挂载失败才撤销标签；网络失败则保留标签供界面展示错误。
      this.entries.delete(entry.state.id)
      this.order = this.order.filter((id) => id !== entry.state.id)
      try {
        this.releaseEntry(entry)
      } catch (cleanupError) {
        // 清理异常单独记录，仍向调用方抛出最初导致创建失败的错误。
        console.error('撤销标签时释放网页失败', cleanupError)
      }
      throw error
    }

    // 5. 界面先看到标签记录，再接收导航过程中的标题、地址和加载状态变化。
    this.publishSnapshot()
    // 先登记并通知，再启动异步导航；create 不等待网页加载完成。
    // 订阅回调是同步执行的，返回后再确认窗口和标签没有在回调中被释放。
    if (this.isLiveEntry(entry)) {
      try {
        void view.webContents.loadURL(url).catch((error: unknown) => {
          // 常规错误由网页事件处理，这里补上 Promise 拒绝时的兜底。
          this.handleInitialLoadError(entry, error)
        })
      } catch (error) {
        // 同时处理 loadURL 调用本身的同步异常；此时标签已经成功登记。
        this.handleInitialLoadError(entry, error)
      }
    }
    return structuredClone(entry.state)
  }

  /** 显示指定标签并发布活动标签变化；保留原标签的网页对象和导航历史。 */
  public activate(tabId: TabId): void {
    this.assertAvailable()
    const entry = this.entries.get(tabId)
    if (!entry || entry.view.webContents.isDestroyed()) throw new Error('标签不存在或已销毁')
    if (this.activeTabId === tabId) {
      // 已经是活动标签时只恢复键盘焦点，不制造一次没有状态变化的快照。
      this.focusActive()
      return
    }
    this.showEntry(entry)
    this.publishSnapshot()
  }

  /** 直接关闭网页；销毁事件负责移除记录、切换相邻标签并发布快照。 */
  public async close(tabId: TabId): Promise<boolean> {
    this.assertAvailable()
    if (typeof tabId !== 'string' || tabId.length === 0) throw new Error('tabId 必须是非空字符串')
    const entry = this.entries.get(tabId)
    if (!entry || entry.view.webContents.isDestroyed()) throw new Error('标签不存在或已销毁')
    const contents = entry.view.webContents
    return new Promise<boolean>((resolve, reject) => {
      const onDestroyed = (): void => resolve(true)
      contents.once('destroyed', onDestroyed)
      try {
        contents.close()
      } catch (error) {
        contents.off('destroyed', onDestroyed)
        reject(error)
      }
    })
  }

  /** 预留：调整已有标签的排列位置；create 的 index 只处理创建时插入。 */
  public move(_tabId: TabId, _toIndex: number): void {
    this.notImplemented('move')
  }

  /** 预留：从已关闭记录恢复标签；当前尚未维护关闭历史。 */
  public restoreClosed(): TabState | null {
    return this.notImplemented('restoreClosed')
  }

  /** 预留：在已有标签中打开新输入；当前创建后的页面自行导航已由事件监听同步。 */
  public navigate(_tabId: TabId, _input: string): void {
    this.notImplemented('navigate')
  }

  /** 预留：执行后退；canGoBack 已由事件维护，但操作入口尚未实现。 */
  public goBack(_tabId: TabId): void {
    this.notImplemented('goBack')
  }

  /** 预留：执行前进；canGoForward 已由事件维护，但操作入口尚未实现。 */
  public goForward(_tabId: TabId): void {
    this.notImplemented('goForward')
  }

  /** 预留：普通刷新或忽略缓存刷新；当前尚未实现。 */
  public reload(_tabId: TabId, _options?: ReloadTabOptions): void {
    this.notImplemented('reload')
  }

  /** 预留：主动停止加载；事件监听已能识别取消，但操作入口尚未实现。 */
  public stop(_tabId: TabId): void {
    this.notImplemented('stop')
  }

  /**
   * 由窗口层在布局变化时传入网页区域，坐标相对于窗口内容区，单位为 DIP。
   * 立即更新活动视图；后台视图不显示，在 showEntry 时应用保存的最新尺寸。
   * 布局数据不属于 TabState，因此只调整原生视图，不发布标签快照。
   */
  public setContentBounds(bounds: Rectangle): void {
    this.assertAvailable()
    if (
      !bounds ||
      ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isInteger) ||
      bounds.width < 0 ||
      bounds.height < 0
    ) {
      throw new Error('网页区域必须使用整数坐标和非负整数尺寸')
    }
    const active = this.activeTabId ? this.entries.get(this.activeTabId) : undefined
    active?.view.setBounds(bounds)
    // 保存副本，避免窗口层之后修改同一个 bounds 对象时悄悄改变内部布局。
    this.contentBounds = { ...bounds }
  }

  /** 把键盘输入焦点交给当前网页；没有活动标签时不做操作。 */
  public focusActive(): void {
    this.assertAvailable()
    if (!this.contentVisible) return
    const active = this.activeTabId ? this.entries.get(this.activeTabId) : undefined
    if (active && !active.view.webContents.isDestroyed()) active.view.webContents.focus()
  }

  public setContentVisible(visible: boolean): void {
    this.assertAvailable()
    if (this.contentVisible === visible) return
    const active = this.activeTabId ? this.entries.get(this.activeTabId) : undefined
    if (active) {
      if (visible) {
        active.view.setBounds(this.contentBounds)
        this.owner.contentView.addChildView(active.view)
      } else {
        this.owner.contentView.removeChildView(active.view)
      }
    }
    this.contentVisible = visible
    if (!visible) this.owner.webContents.focus()
  }

  /**
   * 订阅后续快照，不立即推送现有状态；调用方可在订阅后再调用 getSnapshot。
   * 返回取消函数，窗口关闭或界面组件卸载时调用；重复取消不会影响其他订阅。
   */
  public subscribe(listener: TabSnapshotListener): () => void {
    this.assertAvailable()
    // 每次订阅独立取消，即使调用方传入了同一个回调。
    const subscription: TabSnapshotListener = (snapshot) => listener(snapshot)
    this.listeners.add(subscription)
    return () => {
      this.listeners.delete(subscription)
    }
  }

  /** 预留：在窗口 close 阶段协商是否可以关闭全部标签；不同于 closed 后的 dispose。 */
  public async requestCloseAll(_reason: TabCloseReason): Promise<boolean> {
    return this.notImplemented('requestCloseAll')
  }

  /**
   * 最终释放入口，由窗口 closed 回调调用，也可用于管理器主动退出。
   * 不执行可取消的关闭协商：先停用实例和订阅，再解除监听、关闭全部网页。
   * 一个标签清理失败时继续处理其他标签；重复调用直接返回。
   */
  public dispose(): void {
    if (this.disposed) return
    this.disposed = true
    // 先阻止状态通知，避免关闭过程中把不完整的清理状态发送给界面。
    this.listeners.clear()
    for (const entry of this.entries.values()) {
      try {
        this.releaseEntry(entry)
      } catch (error) {
        console.error('释放标签网页失败', error)
      }
    }
    this.entries.clear()
    this.order = []
    this.activeTabId = null
  }

  /** 校验会影响资源创建、会话归属及排列位置的参数，不在这里创建任何原生对象。 */
  private validateCreateOptions(options: CreateTabOptions): void {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new Error('创建标签必须提供 options 对象')
    }
    if (typeof options.input !== 'string') throw new Error('input 必须是字符串')
    // 目前只有一个固定分区。拒绝未支持的工作空间，避免状态声明与实际 Session 不一致。
    if (options.workspaceId !== undefined && options.workspaceId !== 'default') {
      throw new Error('当前仅支持 default 工作空间')
    }
    if (options.active !== undefined && typeof options.active !== 'boolean') {
      throw new Error('active 必须是布尔值')
    }
    if (
      options.index !== undefined &&
      (!Number.isInteger(options.index) || options.index < 0 || options.index > this.order.length)
    ) {
      throw new Error('index 必须是 0 到当前标签数量之间的整数')
    }
  }

  /**
   * 只负责视图切换，不发快照，供 create / activate / 销毁后的相邻标签切换复用。
   * 成功后才修改 activeTabId，使它与实际挂载的视图保持一致。
   */
  private showEntry(entry: TabEntry): void {
    const previous = this.activeTabId ? this.entries.get(this.activeTabId) : undefined
    // 先设置尺寸；若布局失败，旧视图仍保持原样。
    entry.view.setBounds(this.contentBounds)
    if (!this.contentVisible) {
      this.activeTabId = entry.state.id
      return
    }
    try {
      this.owner.contentView.addChildView(entry.view)
      // 移出窗口只改变显示关系，不销毁旧网页，也不会清空它的历史或页面状态。
      if (previous) this.owner.contentView.removeChildView(previous.view)
      entry.view.webContents.focus()
    } catch (error) {
      // 新视图挂载或聚焦失败时，尝试还原此前的显示关系。
      this.owner.contentView.removeChildView(entry.view)
      if (previous) this.owner.contentView.addChildView(previous.view)
      throw error
    }
    this.activeTabId = entry.state.id
  }

  /**
   * 将 Electron 的网页事件转换为 TabState 更新，并生成对应的解除监听函数。
   * 必须在首次 loadURL 前调用，否则可能漏掉最早的导航或加载失败事件。
   * 每个回调先检查标签是否仍有效，避免已释放网页的迟到事件修改状态。
   */
  private bindTabEvents(entry: TabEntry): void {
    const contents = entry.view.webContents
    const onBeforeInput = (event: Electron.Event, input: Electron.Input): void => {
      if (!this.onShortcut || !this.contentVisible || this.activeTabId !== entry.state.id) return
      const shortcut = resolveBrowserShortcut(input)
      if (shortcut === null) return
      event.preventDefault()
      // 仅转发已识别的浏览器按键，不把网页输入作为通用 IPC 暴露出去。
      this.owner.webContents.focus()
      this.onShortcut(shortcut)
    }
    const updateHistory = (): void => {
      // 前进/后退能力以 Chromium 的真实历史为准，不自行用 URL 数量推断。
      entry.state.canGoBack = contents.navigationHistory.canGoBack()
      entry.state.canGoForward = contents.navigationHistory.canGoForward()
    }
    const onStart = (
      details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>
    ): void => {
      // iframe 导航不代表整个标签换页；hash / pushState 等同文档导航也不重新加载。
      if (!this.isLiveEntry(entry) || !details.isMainFrame || details.isSameDocument) return
      entry.navigationVersion++
      entry.navigationUrl = details.url
      entry.state.load = { status: 'loading' }
      this.publishSnapshot()
    }
    const onRedirect = (
      details: Electron.Event<Electron.WebContentsDidRedirectNavigationEventParams>
    ): void => {
      // 重定向仍在请求阶段，只更新错误匹配用的目标地址；尚不写入已提交的 state.url。
      if (this.isLiveEntry(entry) && details.isMainFrame) entry.navigationUrl = details.url
    }
    const onNavigate = (_event: Electron.Event, url: string): void => {
      if (!this.isLiveEntry(entry)) return
      // did-navigate 只针对主框架，此时新文档已提交，但并不代表资源全部加载完成。
      entry.navigationUrl = url
      entry.state.url = url
      entry.state.title = contents.getTitle() || url
      // 新文档的图标等待后续事件提供，先清除上个页面的图标。
      entry.state.faviconUrl = null
      updateHistory()
      this.publishSnapshot()
    }
    const onNavigateInPage = (_event: Electron.Event, url: string, isMainFrame: boolean): void => {
      if (!this.isLiveEntry(entry) || !isMainFrame) return
      entry.state.url = url
      // 同文档导航也可能改变历史记录，但不应清除标题、图标或重新设置 loading。
      updateHistory()
      this.publishSnapshot()
    }
    const onTitle = (_event: Electron.Event, title: string): void => {
      if (!this.isLiveEntry(entry)) return
      const nextTitle = title || entry.state.url || '新标签页'
      // 相同标题不重复通知，避免界面收到没有内容变化的标题更新。
      if (entry.state.title === nextTitle) return
      entry.state.title = nextTitle
      this.publishSnapshot()
    }
    const onFavicon = (_event: Electron.Event, favicons: string[]): void => {
      if (!this.isLiveEntry(entry)) return
      const favicon = favicons[0] ?? null
      // 当前选取第一个候选地址；这里只传递地址，不在主进程下载图标。
      if (entry.state.faviconUrl === favicon) return
      entry.state.faviconUrl = favicon
      this.publishSnapshot()
    }
    const onFinish = (): void => {
      if (!this.isLiveEntry(entry)) return
      // Chromium 的错误页也可能结束加载，不能覆盖 failed / crashed。
      if (entry.state.load.status === 'failed' || entry.state.load.status === 'crashed') return
      entry.state.load = { status: 'ready' }
      updateHistory()
      this.publishSnapshot()
    }
    const onStop = (): void => {
      if (!this.isLiveEntry(entry)) return
      // 停止旋转不代表加载成功；主动取消留在 idle。
      if (entry.state.load.status === 'loading') entry.state.load = { status: 'idle' }
      updateHistory()
      this.publishSnapshot()
    }
    const onFail = (
      _event: Electron.Event,
      code: number,
      message: string,
      url: string,
      isMainFrame: boolean
    ): void => {
      // -3 是 ERR_ABORTED，例如主动停止或新导航替代旧导航，不能展示为网络故障。
      if (!isMainFrame || code === -3 || !this.isLiveEntry(entry)) return
      // URL 不匹配时是其他导航的错误；这个过滤不提供相同 URL 请求之间的唯一身份。
      if (url !== entry.navigationUrl) return
      if (entry.state.load.status === 'crashed') return
      entry.state.load = { status: 'failed', error: { code, message, url } }
      updateHistory()
      this.publishSnapshot()
    }
    const onGone = (_event: Electron.Event, details: Electron.RenderProcessGoneDetails): void => {
      if (!this.isLiveEntry(entry)) return
      entry.state.load = { status: 'crashed', reason: details.reason }
      // 渲染进程崩溃与标签被销毁不同：保留标签记录，供界面展示原因及后续恢复。
      this.publishSnapshot()
    }
    // 例如网页自行关闭时，原生对象已不可用，需要同步移除管理器中的记录。
    const onDestroyed = (): void => this.forgetDestroyedEntry(entry)

    // 先准备清理函数，再逐个绑定；即使绑定途中出错，已绑定的监听也能被撤销。
    // 使用对应函数引用逐一 off，避免 removeAllListeners 误删其他模块的监听。
    entry.cleanup = (): void => {
      contents.off('before-input-event', onBeforeInput)
      contents.off('did-start-navigation', onStart)
      contents.off('did-redirect-navigation', onRedirect)
      contents.off('did-navigate', onNavigate)
      contents.off('did-navigate-in-page', onNavigateInPage)
      contents.off('page-title-updated', onTitle)
      contents.off('page-favicon-updated', onFavicon)
      contents.off('did-finish-load', onFinish)
      contents.off('did-stop-loading', onStop)
      contents.off('did-fail-load', onFail)
      contents.off('did-fail-provisional-load', onFail)
      contents.off('render-process-gone', onGone)
      contents.off('destroyed', onDestroyed)
    }
    contents.on('did-start-navigation', onStart)
    contents.on('before-input-event', onBeforeInput)
    contents.on('did-redirect-navigation', onRedirect)
    contents.on('did-navigate', onNavigate)
    contents.on('did-navigate-in-page', onNavigateInPage)
    contents.on('page-title-updated', onTitle)
    contents.on('page-favicon-updated', onFavicon)
    contents.on('did-finish-load', onFinish)
    contents.on('did-stop-loading', onStop)
    contents.on('did-fail-load', onFail)
    contents.on('did-fail-provisional-load', onFail)
    contents.on('render-process-gone', onGone)
    contents.on('destroyed', onDestroyed)
  }

  /**
   * 首次 loadURL 的同步异常 / Promise 拒绝兜底。
   * 正常情况下 did-fail-load 已写入失败状态，这里不再重复覆盖，也不覆盖崩溃原因。
   */
  private handleInitialLoadError(entry: TabEntry, error: unknown): void {
    // 初次 loadURL 的 Promise 可能晚于下一次页面导航才拒绝。
    if (!this.isLiveEntry(entry) || entry.navigationVersion > 1) return
    if (entry.state.load.status === 'failed' || entry.state.load.status === 'crashed') return
    const failure = error as { errno?: number; code?: string; message?: string } | null
    if (failure?.errno === -3 || failure?.code === 'ERR_ABORTED') return
    entry.state.load = {
      status: 'failed',
      error: {
        // Electron 通常提供 errno；普通异常没有错误码时使用通用失败码 -2。
        code: typeof failure?.errno === 'number' ? failure.errno : -2,
        message: typeof failure?.message === 'string' ? failure.message : String(error),
        url: entry.navigationUrl
      }
    }
    this.publishSnapshot()
  }

  /**
   * 处理已经被销毁的网页，只整理记录和显示关系，不再对该 webContents 调用 close。
   * 当前标签消失时优先显示原位置右侧的标签；若它已是末尾，则选左侧标签。
   */
  private forgetDestroyedEntry(entry: TabEntry): void {
    if (this.disposed || this.entries.get(entry.state.id) !== entry) return
    entry.cleanup()
    const index = this.order.indexOf(entry.state.id)
    this.entries.delete(entry.state.id)
    this.order.splice(index, 1)
    const wasActive = this.activeTabId === entry.state.id
    if (wasActive) this.activeTabId = null
    // 窗口也已销毁时不能再操作原生视图；其 closed 回调会继续清理剩余标签。
    if (this.owner.isDestroyed()) return
    try {
      this.owner.contentView.removeChildView(entry.view)
      if (wasActive && this.order.length > 0) {
        this.showEntry(this.entries.get(this.order[Math.min(index, this.order.length - 1)])!)
      }
    } catch (error) {
      // 网页已经销毁，布局异常不能阻止后续 destroyed 监听完成关闭请求。
      console.error('关闭标签后更新视图失败', error)
    }
    this.publishSnapshot()
  }

  /** 主动释放单个记录的原生资源；entries / order 由调用方负责维护。 */
  private releaseEntry(entry: TabEntry): void {
    // 先解除 destroyed 等事件，避免 close 引发 forgetDestroyedEntry 再次修改集合。
    entry.cleanup()
    try {
      if (!this.owner.isDestroyed()) this.owner.contentView.removeChildView(entry.view)
    } finally {
      // 即使从窗口移除视图失败，也要尝试关闭网页，避免只隐藏视图却遗留渲染资源。
      // 窗口已关闭或创建已撤销时，不再等待网页 beforeunload。
      if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close()
    }
  }

  /** 异步回调的有效性检查；对象引用比较确保回调仍属于当前登记的这条记录。 */
  private isLiveEntry(entry: TabEntry): boolean {
    return (
      !this.disposed &&
      !this.owner.isDestroyed() &&
      !entry.view.webContents.isDestroyed() &&
      this.entries.get(entry.state.id) === entry
    )
  }

  /**
   * 发布一次完整状态并递增版本；读取快照本身不会递增版本。
   * 例如界面先收到事件 revision=5，后收到查询响应 revision=4，应忽略后者。
   * 每个订阅者收到独立副本；某个订阅者修改数据或抛错不会影响其他订阅者。
   */
  private publishSnapshot(): void {
    if (this.disposed || this.owner.isDestroyed()) return
    this.revision++
    const snapshot = this.getSnapshot()
    for (const listener of this.listeners) {
      try {
        listener(structuredClone(snapshot))
      } catch (error) {
        console.error('标签状态订阅回调失败', error)
      }
    }
  }

  /** 对外操作统一检查管理器和所属窗口的生命周期，防止使用已释放的原生对象。 */
  private assertAvailable(): void {
    if (this.disposed || this.owner.isDestroyed())
      throw new Error('标签管理器已释放或所属窗口不可用')
  }

  /** 未完成业务显式报错，避免调用方误以为操作已经执行成功。 */
  private notImplemented(method: string): never {
    this.assertAvailable()
    throw new Error(`TabManager.${method} 尚未实现`)
  }
}
