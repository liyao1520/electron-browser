import type { UpdateState } from '../../../../shared/ipc'

const messages: Record<UpdateState['status'], string> = {
  disabled: '自动更新仅在 Windows 安装版中可用。',
  idle: '检查是否有新版本。',
  checking: '正在检查更新…',
  latest: '当前已是最新版本。',
  available: '有新版本可供下载。',
  downloading: '正在下载更新…',
  downloaded: '更新已就绪，请先保存网页内容。也可在退出浏览器时自动安装。',
  installing: '正在重启安装…',
  error: '更新失败，请稍后重试。'
}

export function AppUpdate({
  state,
  onError
}: {
  state: UpdateState | null
  onError: (error: unknown) => void
}): React.JSX.Element | null {
  if (!state) return null
  const { status } = state
  const canInstall = status === 'downloaded' && !state.testMode
  const busy = ['checking', 'downloading', 'installing'].includes(status)
  const action =
    status === 'available'
      ? window.api.downloadUpdate
      : canInstall
        ? window.api.installUpdate
        : window.api.checkForUpdates
  const label =
    status === 'available'
      ? '下载更新'
      : canInstall
        ? '重启并安装'
        : status === 'downloaded'
          ? '重新检查'
          : status === 'error'
            ? '重试'
            : '检查更新'

  return (
    <section className="app-update" aria-label="应用更新">
      <strong>
        应用更新{state.testMode ? ' · 开发测试' : ''}
        {state.version ? ` · v${state.version}` : ''}
      </strong>
      {state.testMode && <p>开发测试仅检查和下载，退出时不会安装。</p>}
      <p role="status">
        {state.message ??
          (state.testMode && status === 'downloaded'
            ? '下载校验已完成，可重新检查更新。'
            : messages[status])}
      </p>
      {status === 'downloading' && (
        <div className="update-progress">
          <progress max={100} value={state.percent ?? 0} aria-label="更新下载进度" />
          <span>{Math.floor(state.percent ?? 0)}%</span>
        </div>
      )}
      <div className="update-actions">
        <button
          className="primary-button"
          disabled={busy || status === 'disabled'}
          onClick={() => void action().catch(onError)}
        >
          {busy ? messages[status] : label}
        </button>
        {state.testMode && status === 'available' && (
          <button
            className="primary-button"
            onClick={() => void window.api.checkForUpdates().catch(onError)}
          >
            重新检查
          </button>
        )}
      </div>
    </section>
  )
}
