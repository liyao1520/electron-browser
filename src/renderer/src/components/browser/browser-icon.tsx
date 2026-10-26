import ArrowBack from '@material-symbols/svg-400/rounded/arrow_back.svg?react'
import ArrowForward from '@material-symbols/svg-400/rounded/arrow_forward.svg?react'
import ArrowOutward from '@material-symbols/svg-400/rounded/arrow_outward.svg?react'
import Add from '@material-symbols/svg-400/rounded/add.svg?react'
import Bookmarks from '@material-symbols/svg-400/rounded/bookmarks.svg?react'
import ChevronRight from '@material-symbols/svg-400/rounded/chevron_right.svg?react'
import Close from '@material-symbols/svg-400/rounded/close.svg?react'
import Download from '@material-symbols/svg-400/rounded/download.svg?react'
import ErrorOutline from '@material-symbols/svg-400/rounded/error.svg?react'
import ExpandMore from '@material-symbols/svg-400/rounded/keyboard_arrow_down.svg?react'
import History from '@material-symbols/svg-400/rounded/history.svg?react'
import MoreVert from '@material-symbols/svg-400/rounded/more_vert.svg?react'
import ProgressActivity from '@material-symbols/svg-400/rounded/progress_activity.svg?react'
import Public from '@material-symbols/svg-400/rounded/public.svg?react'
import Refresh from '@material-symbols/svg-400/rounded/refresh.svg?react'
import Search from '@material-symbols/svg-400/rounded/search.svg?react'
import Settings from '@material-symbols/svg-400/rounded/settings.svg?react'
import Star from '@material-symbols/svg-400/rounded/star.svg?react'
import Tune from '@material-symbols/svg-400/rounded/tune.svg?react'

// 界面操作统一使用第三方打包的 Google Material Symbols Rounded / weight 400。
// 显式导入需要的 SVG，构建后随应用离线加载，不依赖图标字体或远程 CDN。
const icons = {
  back: ArrowBack,
  forward: ArrowForward,
  open: ArrowOutward,
  add: Add,
  bookmarks: Bookmarks,
  'chevron-right': ChevronRight,
  close: Close,
  download: Download,
  error: ErrorOutline,
  expand: ExpandMore,
  history: History,
  more: MoreVert,
  loading: ProgressActivity,
  globe: Public,
  refresh: Refresh,
  search: Search,
  settings: Settings,
  star: Star,
  tune: Tune
}

export type BrowserIconName = keyof typeof icons

export function BrowserIcon({
  name,
  size = 20,
  className = ''
}: {
  name: BrowserIconName
  size?: 16 | 20 | 24 | 28
  className?: string
}): React.JSX.Element {
  const Icon = icons[name]
  return (
    <Icon
      className={`browser-icon ${className}`}
      data-icon={name}
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    />
  )
}
