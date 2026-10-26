import { useState, type FormEvent } from 'react'
import { siBaidu, siGithub, siBilibili, siZhihu, siMdnwebdocs, siWikipedia } from 'simple-icons'
import type { TabState } from '../../../../shared/ipc'
import { BrandMark } from './browser-chrome'
import { IconButton } from './icon-button'
import { BrowserIcon } from './browser-icon'

const shortcuts = [
  { label: '百度', url: 'https://www.baidu.com', icon: siBaidu },
  { label: 'GitHub', url: 'https://github.com', icon: siGithub },
  { label: '哔哩哔哩', url: 'https://www.bilibili.com', icon: siBilibili },
  { label: '知乎', url: 'https://www.zhihu.com', icon: siZhihu },
  { label: 'MDN', url: 'https://developer.mozilla.org/zh-CN/', icon: siMdnwebdocs },
  { label: 'Wikipedia', url: 'https://www.wikipedia.org', icon: siWikipedia }
]

export function NewTabPage({
  pending,
  onOpen
}: {
  pending: boolean
  onOpen: (input: string) => Promise<void>
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    void onOpen(query)
  }
  return (
    <main className="new-tab-page">
      <section className="start-content" aria-label="新标签页">
        <div className="wordmark">
          <BrandMark />
          <h1>
            ebrower<span>.</span>
          </h1>
        </div>
        <p className="start-description">让浏览，简单一点。</p>
        <form className="start-search" onSubmit={submit}>
          <BrowserIcon name="search" size={24} className="start-search-icon" />
          <input
            aria-label="搜索或输入网址"
            placeholder="搜索或输入网址"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <IconButton label="清空搜索" className="clear-search" onClick={() => setQuery('')}>
              <BrowserIcon name="close" size={16} />
            </IconButton>
          )}
          <button
            className="search-submit"
            type="submit"
            disabled={pending || !query.trim()}
            aria-label="打开地址或搜索"
          >
            <BrowserIcon name="forward" />
          </button>
        </form>
        <div className="search-note">
          <span>使用百度搜索</span>
          <span className="note-dot">·</span>
          <span>或直接输入网址</span>
        </div>
        <nav className="shortcuts" aria-label="常用网站">
          {shortcuts.map((shortcut) => {
            return (
              <button
                key={shortcut.label}
                className="shortcut"
                disabled={pending}
                onClick={() => {
                  void onOpen(shortcut.url)
                }}
                title={shortcut.url}
              >
                <span className="shortcut-icon">
                  <svg
                    className="shortcut-brand-icon"
                    viewBox="0 0 24 24"
                    width="24"
                    height="24"
                    fill={`#${shortcut.icon.hex}`}
                    aria-hidden="true"
                    focusable="false"
                  >
                    <path d={shortcut.icon.path} />
                  </svg>
                </span>
                <span>{shortcut.label}</span>
              </button>
            )
          })}
        </nav>
        {/* TODO: 自定义快捷方式与持久化尚未实现，当前只提供固定的网站入口。 */}
      </section>
      <footer className="start-footer">
        <span>
          <span className="status-dot" /> 少一点打扰，多一点专注
        </span>
        <span>
          新建标签 <kbd>Ctrl</kbd> + <kbd>T</kbd>
        </span>
      </footer>
    </main>
  )
}

export function PageFailure({
  page,
  pending,
  onOpen
}: {
  page: TabState
  pending: boolean
  onOpen: (input: string) => Promise<void>
}): React.JSX.Element {
  const failed = page.load.status === 'failed' ? page.load.error : null
  const url = failed?.url || page.url
  return (
    <main className="page-failure">
      <div className="failure-icon">
        <BrowserIcon name="globe" size={28} />
      </div>
      <h1>{failed ? '暂时无法访问此网站' : '此页面意外停止了'}</h1>
      <p>
        {failed
          ? '请检查网址或网络连接，然后重新打开页面。'
          : '你可以在新标签页中重新打开这个页面。'}
      </p>
      <div className="failure-detail">
        <span>{url || page.title}</span>
        <code>{failed?.message || (page.load.status === 'crashed' ? page.load.reason : '')}</code>
      </div>
      <button
        className="primary-button"
        disabled={pending || !url}
        onClick={() => {
          void onOpen(url)
        }}
      >
        在新标签页重试
        <BrowserIcon name="open" size={16} />
      </button>
    </main>
  )
}
