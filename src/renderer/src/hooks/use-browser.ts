import { useCallback, useEffect, useReducer, useRef } from 'react'
import type { TabSnapshot, TabState } from '../../../shared/ipc'

export type BrowserTab = { id: string; page: TabState | null }
type BrowserState = {
  tabs: BrowserTab[]
  activeId: string
  snapshot: TabSnapshot
  ready: boolean
  pending: boolean
  error: string | null
}
type Action =
  | { type: 'snapshot'; snapshot: TabSnapshot }
  | { type: 'new'; id: string }
  | { type: 'select'; id: string }
  | { type: 'close'; id: string; fallbackId: string }
  | { type: 'created'; draftId: string | null; page: TabState }
  | { type: 'pending'; pending: boolean }
  | { type: 'error'; error: string | null }

const initialState: BrowserState = {
  tabs: [{ id: 'start-initial', page: null }],
  activeId: 'start-initial',
  snapshot: { revision: -1, tabs: [], activeTabId: null },
  ready: false,
  pending: false,
  error: null
}

function reducer(state: BrowserState, action: Action): BrowserState {
  switch (action.type) {
    case 'snapshot': {
      const snapshot = action.snapshot
      if (snapshot.revision < state.snapshot.revision) return state
      const pages = new Map(snapshot.tabs.map((page) => [page.id, page]))
      const tabs = state.tabs
        .filter((tab) => !tab.page || pages.has(tab.id))
        .map((tab) => (tab.page ? { id: tab.id, page: pages.get(tab.id)! } : tab))
      // window.open 创建的标签也进入标签栏，并保留主进程的相邻插入顺序。
      snapshot.tabs.forEach((page, index) => {
        if (tabs.some((tab) => tab.id === page.id)) return
        const nextIds = new Set(snapshot.tabs.slice(index + 1).map((next) => next.id))
        const nextIndex = tabs.findIndex((tab) => nextIds.has(tab.id))
        tabs.splice(nextIndex < 0 ? tabs.length : nextIndex, 0, { id: page.id, page })
      })
      const active = tabs.find((tab) => tab.id === state.activeId)
      const nativeChanged = snapshot.activeTabId !== state.snapshot.activeTabId
      const newNativeActive = !state.snapshot.tabs.some((tab) => tab.id === snapshot.activeTabId)
      let activeId = state.activeId
      if (
        snapshot.activeTabId &&
        (!active ||
          (!state.ready && snapshot.tabs.length > 0) ||
          (nativeChanged && (active.page || newNativeActive)))
      ) {
        activeId = snapshot.activeTabId
      } else if (!active) activeId = tabs[0]?.id ?? 'start-empty'
      if (!tabs.length) tabs.push({ id: activeId, page: null })
      return { ...state, tabs, activeId, snapshot, ready: true }
    }
    case 'new':
      return {
        ...state,
        tabs: [...state.tabs, { id: action.id, page: null }],
        activeId: action.id,
        error: null
      }
    case 'select':
      return { ...state, activeId: action.id, error: null }
    case 'close': {
      const index = state.tabs.findIndex((tab) => tab.id === action.id)
      const tabs = state.tabs.filter((tab) => tab.id !== action.id)
      if (!tabs.length) tabs.push({ id: action.fallbackId, page: null })
      const activeId =
        state.activeId === action.id ? tabs[Math.min(index, tabs.length - 1)].id : state.activeId
      return { ...state, tabs, activeId, error: null }
    }
    case 'created': {
      const tab = { id: action.page.id, page: action.page }
      const tabs = state.tabs.map((old) => (old.id === action.draftId ? tab : old))
      if (!tabs.some((old) => old.id === tab.id)) tabs.push(tab)
      const activeId =
        state.activeId === action.draftId || !action.draftId ? tab.id : state.activeId
      return { ...state, tabs, activeId, pending: false }
    }
    case 'pending':
      return { ...state, pending: action.pending, error: action.pending ? null : state.error }
    case 'error':
      return { ...state, error: action.error }
  }
}

export function useBrowser(): {
  state: BrowserState
  activeTab: BrowserTab
  newTab: () => void
  selectTab: (id: string) => void
  closeTab: (id: string) => void
  openInput: (input: string) => Promise<void>
  dismissError: () => void
  reportError: (error: unknown) => void
} {
  const [state, dispatch] = useReducer(reducer, initialState)
  const creating = useRef(false)
  const deferredSnapshot = useRef<TabSnapshot | null>(null)
  const latestRevision = useRef(-1)
  const activeTab = state.tabs.find((tab) => tab.id === state.activeId) ?? state.tabs[0]
  const reportError = useCallback((error: unknown): void => {
    dispatch({ type: 'error', error: error instanceof Error ? error.message : String(error) })
  }, [])

  useEffect(() => {
    if (!window.api) return
    let disposed = false
    const receive = (snapshot: TabSnapshot): void => {
      if (disposed || snapshot.revision < latestRevision.current) return
      latestRevision.current = snapshot.revision
      if (creating.current) deferredSnapshot.current = snapshot
      else dispatch({ type: 'snapshot', snapshot })
    }
    // 先订阅再查询，revision 防止初次查询覆盖更晚的网页事件。
    const unsubscribe = window.api.onTabStateChanged(receive)
    void window.api
      .getTabState()
      .then(receive)
      .catch((error: unknown) => {
        if (!disposed) reportError(error)
      })
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [reportError])

  const newTab = useCallback((): void => {
    // 空白页只在本地渲染；提交地址后才通过已有 createTab 分配网页资源。
    dispatch({ type: 'new', id: crypto.randomUUID() })
  }, [])

  const selectTab = useCallback(
    (id: string): void => {
      const tab = state.tabs.find((item) => item.id === id)
      if (!tab) return
      dispatch({ type: 'select', id })
      if (tab.page && window.api) {
        void window.api.activateTab(id).catch((error: unknown) => {
          reportError(error)
          void window.api
            .getTabState()
            .then((snapshot) => {
              dispatch({ type: 'select', id: snapshot.activeTabId ?? id })
              dispatch({ type: 'snapshot', snapshot })
            })
            .catch(reportError)
        })
      }
    },
    [state.tabs, reportError]
  )

  const closeTab = useCallback(
    (id: string): void => {
      const tab = state.tabs.find((item) => item.id === id)
      if (!tab || (creating.current && id === state.activeId)) return
      if (tab.page && window.api) void window.api.closeTab(id).catch(reportError)
      else {
        const index = state.tabs.findIndex((item) => item.id === id)
        const remaining = state.tabs.filter((item) => item.id !== id)
        const next = remaining[Math.min(index, remaining.length - 1)]
        dispatch({ type: 'close', id, fallbackId: crypto.randomUUID() })
        if (state.activeId === id && next?.page && window.api)
          void window.api.activateTab(next.id).catch(reportError)
      }
    },
    [state.tabs, state.activeId, reportError]
  )

  const openInput = useCallback(
    async (input: string): Promise<void> => {
      if (!input.trim() || creating.current) return
      if (!window.api) {
        reportError('请在 ebrowser 桌面应用中打开网页。')
        return
      }
      creating.current = true
      const draftId = activeTab.page ? null : activeTab.id
      dispatch({ type: 'pending', pending: true })
      try {
        // navigate 尚未实现：已有网页上的地址输入明确以新标签打开。
        const page = await window.api.createTab({ input: input.trim() })
        dispatch({ type: 'created', draftId, page })
      } catch (error) {
        reportError(error)
      } finally {
        creating.current = false
        dispatch({ type: 'pending', pending: false })
        if (deferredSnapshot.current) {
          dispatch({ type: 'snapshot', snapshot: deferredSnapshot.current })
          deferredSnapshot.current = null
        }
      }
    },
    [activeTab, reportError]
  )

  const dismissError = useCallback((): void => dispatch({ type: 'error', error: null }), [])
  return { state, activeTab, newTab, selectTab, closeTab, openInput, dismissError, reportError }
}
