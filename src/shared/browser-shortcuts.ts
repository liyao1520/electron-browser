export type BrowserShortcut =
  'new-tab' | 'close-tab' | 'focus-address' | 'next-tab' | 'previous-tab' | number

/** 本地界面和原生网页使用同一组按键，输入框中也保留浏览器的常用快捷键。 */
export function resolveBrowserShortcut(input: {
  type: string
  key: string
  control: boolean
  meta: boolean
  alt: boolean
  shift: boolean
}): BrowserShortcut | null {
  if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return null
  const key = input.key.toLowerCase()
  if (key === 't' && !input.shift) return 'new-tab'
  if (key === 'w' && !input.shift) return 'close-tab'
  if (key === 'l') return 'focus-address'
  if (key === 'tab') return input.shift ? 'previous-tab' : 'next-tab'
  if (/^[1-9]$/.test(key)) return Number(key)
  return null
}
