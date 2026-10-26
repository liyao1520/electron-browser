# ebrower

An Electron application with React and TypeScript

## UI 组件

使用 shadcn/ui（Radix）与 Tailwind CSS，组件源码位于 `src/renderer/src/components/ui`，主题变量在 `src/renderer/src/assets/main.css` 中维护。`components.json` 已适配 Electron renderer 目录和 `@renderer` 别名。

在项目根目录按需添加组件：

```bash
pnpm dlx shadcn@latest add input dropdown-menu tooltip
```

新增组件需遵循项目的显式返回类型规则；组件工具函数统一从 `@renderer/lib/utils` 导入。

### 浏览器界面

界面采用 Chrome 风格的浅色标签栏、地址栏与原生窗口按钮，包含本地新标签页、常用网站入口、加载及错误状态和侧栏。新标签页在提交地址前不创建网页进程。网页标题、图标及加载状态通过现有 IPC 快照同步，支持创建、切换、关闭标签。

操作图标统一使用 `@material-symbols/svg-400` 中的 Google Material Symbols Rounded，集中由 `components/browser/browser-icon.tsx` 提供，标签使用 16px、工具栏使用 20px，并统一按钮中心线。常用网站使用 `simple-icons` 的品牌 SVG；仅应用的 e 品牌标识为自绘。图标按需编译进应用，无需远程字体或图标请求。

快捷键支持 `Ctrl/Cmd+T`、`Ctrl/Cmd+W`、`Ctrl/Cmd+L`、`Ctrl+Tab`、`Ctrl+Shift+Tab` 及 `Ctrl/Cmd+1…9`，网页获得焦点时也有效。地址输入使用已有 `createTab` 能力；当前网页上的输入明确在新标签页打开。前进、后退、刷新、停止、标签搜索和无痕浏览保留禁用入口及 TODO；收藏、历史、下载和设置侧栏保留明确的空状态，等待业务接入。

原生网页与 React 共用 `src/shared/browser-layout.ts` 的尺寸约定：顶部预留 92 DIP，侧栏占用 304 DIP。新标签页和错误页会临时卸下原生网页视图，保持后台资源与状态。打开侧栏或调整窗口大小会同步更新网页区域。

执行 `pnpm build` 后，可运行 `pnpm exec electron tests/browser-ui.electron.cjs` 验证实际构建的界面、表单输入、原生视图布局、快捷键和资源释放。测试使用隐藏窗口、本地 HTTP 服务及独立临时 profile，截图写入被忽略的 `out/ui-*-preview.png`。

## CI/CD

GitHub Actions checks pull requests and builds Windows x64 installers. Push a version tag such as `v1.0.0` to publish the installer to GitHub Releases.

See [CI/CD setup and release instructions](docs/ci-cd.md).

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

## Project Setup

### Typed IPC Library

通用 IPC 能力位于独立 workspace 包 `@electron-brower/typed-ipc`。主进程从 `/main` 入口初始化 Router，preload 从 `/renderer` 入口调用；业务协议保留在 `src/shared/ipc`。

```ts
const context = { getWindowContext: resolveWindowContext }
const createRouter = initIpcRouter<IpcRequests, typeof context>({ context })
const router = createRouter('window')
```

模块通过 `router.register()` 注册；需要提前停用时，调用它返回的取消函数即可。

全局中间件通过 `initIpcRouter({ context, middlewares })` 配置，模块中间件通过 `router.use(...)` 添加；执行顺序为全局、模块、handler，再逆序返回。请求保留原有返回类型，单向事件异常可通过初始化参数 `onError` 统一处理。

使用方式和生命周期约定见 [Typed IPC 文档](packages/typed-ipc/README.md)。`pnpm build:ipc` 单独构建库，`pnpm test:ipc` 运行库及业务接入测试；开发和完整构建命令会先构建库。

### 窗口与标签

- `src/main/windows/main-window.ts` 创建窗口、标签管理器和只读 `WindowContext`，在加载界面前登记窗口，关闭后注销登记、取消订阅并释放管理器。
- `src/main/windows/window-registry.ts` 按窗口 ID 和本地界面的 `WebContents` 对象查找 Context；网页标签不进入发送方登记表。登记返回独立、可重复调用的注销函数。
- `src/main/ipc/resolve-window-context.ts` 校验登记关系、窗口存活、发送方主 frame 和创建时确定的界面入口。开发及打包入口都匹配协议、主机、端口和路径，允许同一入口的 query/hash。
- `src/main/ipc/runtime.ts` 在全局中间件中校验所有业务 IPC。窗口相关 handler 使用 `ctx.getWindowContext(event)` 操作调用方所属窗口。
- `src/main/ipc/tab-events.ts` 负责向指定界面发送快照；通过窗口创建代码连接管理器的订阅，不依赖 Router 工厂。
- `src/main/tabs/tab-manager.ts` 实现标签创建、激活、快照、网页事件同步及视图释放。创建支持 `active` 和 `index`，首个标签始终激活；当前只接受 `default` 工作空间，共享 `persist:default`。`resolveNavigationInput` 统一规范化 URL：完整 HTTP/HTTPS 地址保留协议，无协议域名（如 `baidu.com/path`）补 HTTPS，localhost 和 IP 地址补 HTTP，其余输入使用百度搜索。
- 窗口层计算网页区域（顶部预留 92 DIP，侧栏占用 304 DIP），尺寸变化时更新活动视图。加载失败保留标签并上报错误；视图创建/挂载失败会回滚。窗口关闭后释放所有标签的 `webContents`。
- 界面可调用 `window.api.createTab({ input: 'https://example.com' })`、`getTabState()`、`activateTab(id)`、`closeTab(id)`，并通过 `onTabStateChanged(listener)` 订阅快照（返回取消订阅函数）。应先订阅再查询，并用 `revision` 忽略迟到的旧快照。
- `closeTab(id)` 直接关闭网页并释放资源，销毁后返回 `true`，不执行 `beforeunload` 确认。关闭后台标签不抢焦点；关闭活动标签优先切换到右侧，其次左侧，最后一个标签关闭后保留空窗口。
- 网页触发的普通 HTTP/HTTPS 新窗口请求会在来源标签后创建新标签；后台打开请求保留当前活动标签，Electron 默认原生窗口始终取消。目标地址通过 `isHttpUrl` 校验，不做协议补全或搜索兜底。POST 表单和其他协议暂时拒绝；当前不保留 opener、referrer 上下文，依赖弹窗通信的登录流程尚待支持。
- 标签栏 UI 已接入；恢复/排序/当前标签导航操作及可取消关窗流程尚未实现。

`pnpm test:ipc` 包含标签及窗口接入回归测试。`pnpm exec electron tests/tabs.electron.cjs` 使用隐藏窗口、本地 HTTP 服务和独立临时 profile 验证实际导航、共享存储及资源释放。

### Install

```bash
$ pnpm install
```

### Development

```bash
$ npm run dev
```

### Build

```bash
# For windows
$ npm run build:win

# For macOS
$ npm run build:mac

# For Linux
$ npm run build:linux
```
