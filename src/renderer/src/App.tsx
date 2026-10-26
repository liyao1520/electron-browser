import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { BROWSER_PANEL_WIDTH, BROWSER_TOOLBAR_HEIGHT } from '../../shared/browser-layout'
import { resolveBrowserShortcut, type BrowserShortcut } from '../../shared/browser-shortcuts'
import type { UpdateState } from '../../shared/ipc'
import { BrowserPanel, TabStrip, Toolbar, type Panel } from './components/browser/browser-chrome'
import { IconButton } from './components/browser/icon-button'
import { BrowserIcon } from './components/browser/browser-icon'
import { NewTabPage, PageFailure } from './components/browser/new-tab-page'
import { useBrowser } from './hooks/use-browser'

function App(): React.JSX.Element {
  const { state, activeTab, newTab, selectTab, closeTab, openInput, dismissError, reportError } =
    useBrowser()
  const [panel, setPanel] = useState<Panel | null>(null)
  const [version, setVersion] = useState<string | null>(null)
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const addressRef = useRef<HTMLInputElement>(null)
  const page = activeTab.page
  const failed = page?.load.status === 'failed' || page?.load.status === 'crashed'
  const showPage = Boolean(page && !failed)
  const isStartPage = !page
  const togglePanel = useCallback((next: Panel): void => {
    setPanel((current) => (current === next ? null : next))
  }, [])

  useEffect(() => {
    if (!window.api) return
    void window.api.updateBrowserLayout({ showPage, panelOpen: Boolean(panel) }).catch(reportError)
  }, [showPage, panel, reportError])

  useEffect(() => {
    if (isStartPage) addressRef.current?.focus()
  }, [activeTab.id, isStartPage])

  useEffect(() => {
    if (!window.api) return
    let disposed = false
    void window.api
      .getAppVersion()
      .then((value) => {
        if (!disposed) setVersion(value)
      })
      .catch(reportError)
    return () => {
      disposed = true
    }
  }, [reportError])

  useEffect(() => {
    if (!window.api) return
    let disposed = false
    let revision = -1
    const receive = (next: UpdateState): void => {
      if (disposed || next.revision < revision) return
      revision = next.revision
      setUpdate(next)
      if (next.status === 'available' || next.status === 'downloaded') setPanel('menu')
    }
    // 先订阅再查询，窗口重载后也能找回正在下载或等待安装的状态。
    const unsubscribe = window.api.onUpdateStateChanged(receive)
    void window.api.getUpdateState().then(receive).catch(reportError)
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [reportError])

  useEffect(() => {
    const handleShortcut = (shortcut: BrowserShortcut): void => {
      if (shortcut === 'new-tab') newTab()
      if (shortcut === 'close-tab') closeTab(state.activeId)
      if (shortcut === 'focus-address') {
        addressRef.current?.focus()
        addressRef.current?.select()
      }
      if (shortcut === 'next-tab' || shortcut === 'previous-tab' || typeof shortcut === 'number') {
        const index = state.tabs.findIndex((tab) => tab.id === state.activeId)
        const target =
          typeof shortcut !== 'number'
            ? (index + (shortcut === 'previous-tab' ? -1 : 1) + state.tabs.length) %
              state.tabs.length
            : shortcut === 9
              ? state.tabs.length - 1
              : shortcut - 1
        if (state.tabs[target]) selectTab(state.tabs[target].id)
      }
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setPanel(null)
      const shortcut = resolveBrowserShortcut({
        type: 'keyDown',
        key: event.key,
        control: event.ctrlKey,
        meta: event.metaKey,
        alt: event.altKey,
        shift: event.shiftKey
      })
      if (shortcut !== null) {
        event.preventDefault()
        handleShortcut(shortcut)
      }
    }
    const unsubscribe = window.api?.onBrowserShortcut(handleShortcut)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      unsubscribe?.()
    }
  }, [newTab, closeTab, selectTab, state.activeId, state.tabs])

  const platform = /Mac/.test(navigator.userAgent) ? 'mac' : 'windows'
  return (
    <div
      className={`browser-shell platform-${platform} ${panel ? 'has-panel' : ''}`}
      style={
        {
          '--toolbar-height': `${BROWSER_TOOLBAR_HEIGHT}px`,
          '--panel-width': `${BROWSER_PANEL_WIDTH}px`
        } as CSSProperties
      }
    >
      <header className="browser-chrome">
        <TabStrip
          tabs={state.tabs}
          activeId={state.activeId}
          pending={state.pending}
          onNew={newTab}
          onSelect={selectTab}
          onClose={closeTab}
        />
        <Toolbar
          key={activeTab.id}
          activeTab={activeTab}
          addressRef={addressRef}
          pending={state.pending}
          panel={panel}
          onOpen={openInput}
          onPanel={togglePanel}
        />
        {page?.load.status === 'loading' && (
          <div className="loading-indicator" role="progressbar" aria-label="网页正在加载" />
        )}
      </header>
      <div className="browser-body">
        {page ? (
          failed ? (
            <PageFailure page={page} pending={state.pending} onOpen={openInput} />
          ) : (
            <div className="web-page-placeholder" aria-label="网页内容区域">
              <BrowserIcon name="loading" className="spinner" />
              <span>正在打开页面…</span>
            </div>
          )
        ) : (
          <NewTabPage key={activeTab.id} pending={state.pending} onOpen={openInput} />
        )}
        {panel && (
          <BrowserPanel
            panel={panel}
            version={version}
            update={update}
            onUpdateError={reportError}
            onPanel={setPanel}
            onClose={() => setPanel(null)}
            onNew={newTab}
          />
        )}
      </div>
      {state.error && (
        <div className="browser-notice" role="alert">
          <BrowserIcon name="error" size={16} />
          <span>{state.error}</span>
          <IconButton label="关闭提示" onClick={dismissError}>
            <BrowserIcon name="close" size={16} />
          </IconButton>
        </div>
      )}
    </div>
  )
}

export default App
