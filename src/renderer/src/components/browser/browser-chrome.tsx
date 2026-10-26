import { useRef, useState, type FormEvent, type RefObject } from 'react'
import type { BrowserTab } from '../../hooks/use-browser'
import { IconButton } from './icon-button'
import { BrowserIcon, type BrowserIconName } from './browser-icon'
import type { UpdateState } from '../../../../shared/ipc'
import { AppUpdate } from './app-update'

export type Panel = 'menu' | 'bookmarks' | 'history' | 'downloads' | 'settings'

export function BrandMark({ className = '' }: { className?: string }): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 40 40" fill="none" aria-hidden="true">
      <rect width="40" height="40" rx="13" fill="currentColor" />
      <path
        d="M28.4 20H12.2a7.8 7.8 0 0 1 15-3.1M12.3 20a7.8 7.8 0 0 0 13.5 5.3"
        stroke="white"
        strokeWidth="3.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function TabIcon({ tab }: { tab: BrowserTab }): React.JSX.Element {
  if (!tab.page) return <BrandMark className="tab-brand" />
  if (tab.page.load.status === 'loading')
    return <BrowserIcon name="loading" size={16} className="spinner" />
  if (['failed', 'crashed'].includes(tab.page.load.status))
    return <BrowserIcon name="error" size={16} className="tab-error" />
  const favicon = tab.page.faviconUrl
  const safeFavicon = favicon && /^https?:\/\//i.test(favicon)
  return (
    <span className="favicon">
      <BrowserIcon name="globe" size={16} />
      {safeFavicon && (
        <img
          key={favicon}
          src={favicon}
          alt=""
          referrerPolicy="no-referrer"
          onError={(event) => {
            event.currentTarget.style.display = 'none'
          }}
        />
      )}
    </span>
  )
}

export function TabStrip({
  tabs,
  activeId,
  pending,
  onSelect,
  onClose,
  onNew
}: {
  tabs: BrowserTab[]
  activeId: string
  pending: boolean
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
}): React.JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)
  return (
    <div className="tab-strip">
      <IconButton label="标签搜索（暂未接入）" className="tab-search" disabled>
        <BrowserIcon name="expand" />
      </IconButton>
      {/* TODO: 标签搜索、拖动排序与恢复关闭标签，待对应业务能力实现后接入。 */}
      <div
        ref={listRef}
        className="tabs"
        role="tablist"
        aria-label="浏览器标签"
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const index = tabs.findIndex((tab) => tab.id === activeId)
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? tabs.length - 1
                : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
          onSelect(tabs[next].id)
          listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
        }}
      >
        {tabs.map((tab) => {
          const active = activeId === tab.id
          const title = tab.page?.title || '新标签页'
          return (
            <div className={`browser-tab ${active ? 'is-active' : ''}`} key={tab.id}>
              <button
                type="button"
                className="tab-select"
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                title={title}
                onClick={() => onSelect(tab.id)}
                onAuxClick={(event) => {
                  if (event.button === 1) onClose(tab.id)
                }}
              >
                <TabIcon tab={tab} />
                <span className="tab-title">{title}</span>
              </button>
              <IconButton
                label={`关闭 ${title}`}
                className="tab-close"
                disabled={active && pending}
                onClick={() => onClose(tab.id)}
              >
                <BrowserIcon name="close" size={16} />
              </IconButton>
            </div>
          )
        })}
      </div>
      <IconButton label="新建标签页 (Ctrl+T)" className="new-tab-button" onClick={onNew}>
        <BrowserIcon name="add" />
      </IconButton>
      <div className="titlebar-drag-space" />
    </div>
  )
}

export function Toolbar({
  activeTab,
  addressRef,
  pending,
  panel,
  onOpen,
  onPanel
}: {
  activeTab: BrowserTab
  addressRef: RefObject<HTMLInputElement | null>
  pending: boolean
  panel: Panel | null
  onOpen: (input: string) => Promise<void>
  onPanel: (panel: Panel) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [focused, setFocused] = useState(false)
  const page = activeTab.page
  const url = page?.load.status === 'failed' ? page.load.error.url : (page?.url ?? '')
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (!draft.trim()) return
    void onOpen(draft)
    addressRef.current?.blur()
  }
  return (
    <div className="browser-toolbar" role="toolbar" aria-label="浏览器工具栏">
      <div className="navigation-buttons">
        {/* TODO: goBack / goForward / reload / stop 只有协议与占位方法，不调用。 */}
        <IconButton label="后退（暂未接入）" disabled>
          <BrowserIcon name="back" />
        </IconButton>
        <IconButton label="前进（暂未接入）" disabled>
          <BrowserIcon name="forward" />
        </IconButton>
        <IconButton
          label={page?.load.status === 'loading' ? '停止加载（暂未接入）' : '刷新（暂未接入）'}
          disabled
        >
          <BrowserIcon name={page?.load.status === 'loading' ? 'close' : 'refresh'} />
        </IconButton>
      </div>
      <form className={`address-bar ${focused ? 'is-focused' : ''}`} onSubmit={submit}>
        <span className="address-leading-icon">
          <BrowserIcon name={page ? 'tune' : 'search'} />
        </span>
        <input
          ref={addressRef}
          aria-label="地址栏"
          placeholder="搜索或输入网址"
          spellCheck={false}
          autoComplete="off"
          value={focused ? draft : url}
          onFocus={() => {
            setDraft(url)
            setFocused(true)
            addressRef.current?.select()
          }}
          onBlur={() => setFocused(false)}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') addressRef.current?.blur()
          }}
        />
        {focused && page ? (
          <button className="address-open" type="submit" disabled={pending} title="在新标签页打开">
            <span>新标签页打开</span>
            <BrowserIcon name="open" size={16} />
          </button>
        ) : (
          <IconButton label="收藏此页（暂未接入）" className="bookmark-button" disabled>
            <BrowserIcon name="star" />
          </IconButton>
        )}
      </form>
      <div className="toolbar-actions">
        <IconButton
          label="收藏夹"
          aria-pressed={panel === 'bookmarks'}
          onClick={() => onPanel('bookmarks')}
        >
          <BrowserIcon name="bookmarks" />
        </IconButton>
        <IconButton
          label="下载内容"
          aria-pressed={panel === 'downloads'}
          onClick={() => onPanel('downloads')}
        >
          <BrowserIcon name="download" />
        </IconButton>
        <span className="toolbar-divider" />
        <IconButton
          label="浏览器菜单"
          aria-pressed={panel === 'menu'}
          onClick={() => onPanel('menu')}
        >
          <BrowserIcon name="more" />
        </IconButton>
      </div>
    </div>
  )
}

const panelInfo = {
  bookmarks: {
    icon: 'star',
    title: '收藏夹',
    description: '把喜欢的网站，留在手边。',
    empty: '收藏的网站会显示在这里',
    todo: 'TODO: 接入收藏读取、新增、编辑与删除。'
  },
  history: {
    icon: 'history',
    title: '历史记录',
    description: '轻松找回走过的每一站。',
    empty: '浏览记录会显示在这里',
    todo: 'TODO: 接入浏览历史查询与清除。'
  },
  downloads: {
    icon: 'download',
    title: '下载内容',
    description: '文件与进度，尽在一处。',
    empty: '下载的文件会显示在这里',
    todo: 'TODO: 接入下载事件、进度与文件操作。'
  },
  settings: {
    icon: 'settings',
    title: '设置',
    description: '让浏览器更合你的习惯。',
    empty: '个性化选项会显示在这里',
    todo: 'TODO: 接入主题、搜索引擎与启动设置。'
  }
} satisfies Record<
  Exclude<Panel, 'menu'>,
  { icon: BrowserIconName; title: string; description: string; empty: string; todo: string }
>

export function BrowserPanel({
  panel,
  version,
  update,
  onUpdateError,
  onPanel,
  onClose,
  onNew
}: {
  panel: Panel
  version: string | null
  update: UpdateState | null
  onUpdateError: (error: unknown) => void
  onPanel: (panel: Panel) => void
  onClose: () => void
  onNew: () => void
}): React.JSX.Element {
  const info = panel === 'menu' ? null : panelInfo[panel]
  return (
    <aside className="browser-panel" aria-label={info?.title ?? '浏览器菜单'}>
      <div className="panel-header">
        <h2>{info?.title ?? '浏览器菜单'}</h2>
        <IconButton label="关闭侧栏" onClick={onClose}>
          <BrowserIcon name="close" />
        </IconButton>
      </div>
      {info ? (
        <>
          <p className="panel-description">{info.description}</p>
          {/* 各功能尚无业务能力，保留空状态；接入说明放在源码中。 */}
          <div className="panel-empty" data-todo={info.todo}>
            <div className="empty-icon">
              <BrowserIcon name={info.icon} size={24} />
            </div>
            <h3>{info.empty}</h3>
            <p>此功能暂未接入</p>
          </div>
        </>
      ) : (
        <div className="menu-content">
          <button
            className="menu-item"
            onClick={() => {
              onNew()
              onClose()
            }}
          >
            <BrowserIcon name="add" />
            <span>新建标签页</span>
            <kbd>Ctrl T</kbd>
          </button>
          <div className="menu-separator" />
          <button className="menu-item" onClick={() => onPanel('history')}>
            <BrowserIcon name="history" />
            <span>历史记录</span>
            <BrowserIcon name="chevron-right" className="menu-chevron" />
          </button>
          <button className="menu-item" onClick={() => onPanel('bookmarks')}>
            <BrowserIcon name="star" />
            <span>收藏夹</span>
            <BrowserIcon name="chevron-right" className="menu-chevron" />
          </button>
          <button className="menu-item" onClick={() => onPanel('downloads')}>
            <BrowserIcon name="download" />
            <span>下载内容</span>
            <BrowserIcon name="chevron-right" className="menu-chevron" />
          </button>
          <div className="menu-separator" />
          {/* TODO: 临时工作空间、多窗口、缩放和打印未实现，暂不提供可执行入口。 */}
          <button className="menu-item" disabled>
            <BrowserIcon name="globe" />
            <span>无痕浏览</span>
            <small>暂未接入</small>
          </button>
          <button className="menu-item" onClick={() => onPanel('settings')}>
            <BrowserIcon name="settings" />
            <span>设置</span>
            <BrowserIcon name="chevron-right" className="menu-chevron" />
          </button>
        </div>
      )}
      {panel === 'menu' && <AppUpdate state={update} onError={onUpdateError} />}
      <div className="panel-footer">
        <BrandMark />
        <span>ebrowser</span>
        {version && <span className="app-version">v{version}</span>}
      </div>
    </aside>
  )
}
