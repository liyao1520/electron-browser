# Typed IPC

独立的 Electron IPC 库，提供强类型请求、双向事件、按命名空间组织的 Router、全局与模块中间件，以及通过参数注入的应用上下文。库不依赖本项目的业务代码，也不管理窗口。

当前作为 pnpm workspace 本地包 `@electron-browser/typed-ipc` 使用。它有自己的构建配置、JavaScript 和声明文件产物，以及测试；包设置为 private，未发布到 npm。

## 入口

| 导入路径                               | 用途                                |
| -------------------------------------- | ----------------------------------- |
| `@electron-browser/typed-ipc`          | 通用类型，无 Electron 运行时导入    |
| `@electron-browser/typed-ipc/main`     | 主进程 Router、`TypedIpcMain`       |
| `@electron-browser/typed-ipc/renderer` | preload 中使用的 `TypedIpcRenderer` |

主进程和 preload 分别导入自己的入口。页面通过 preload 暴露的业务方法访问 IPC。

## 定义业务协议

协议由使用方维护。请求函数描述业务参数和返回值；事件函数的参数描述载荷。Electron event 和应用上下文不放进协议。

```ts
export type Requests = {
  'app:getVersion': () => string
  'window:updateSize': (width: number, height: number) => void
}

export type ToMain = {
  'app:ready': (id: string) => void
}

export type ToRenderer = {
  'app:progress': (percent: number) => void
}
```

## 初始化上下文和路由

```ts
import { app } from 'electron'
import type { BrowserWindow } from 'electron'
import { initIpcRouter } from '@electron-browser/typed-ipc/main'
import type { Requests, ToMain } from './contracts'

let mainWindow: BrowserWindow | null = null

const context = {
  getMainWindow: () => mainWindow
}

export const createRouter = initIpcRouter<Requests, typeof context, ToMain>({ context })

const appRouter = createRouter('app')
appRouter.handle('app:getVersion', () => app.getVersion())
appRouter.on('app:ready', ({ event }, id) => {
  console.log(event.sender.id, id)
})

const windowRouter = createRouter('window')
windowRouter.handle('window:updateSize', ({ ctx }, width, height) => {
  const win = ctx.getMainWindow()
  if (!win || win.isDestroyed()) throw new Error('主窗口不可用')
  win.setSize(width, height)
})

app.whenReady().then(() => {
  appRouter.register()
  windowRouter.register()
  // 在这里创建主窗口，并在关闭时更新 mainWindow。
})
```

没有入站事件协议时，只需 `initIpcRouter<Requests, typeof context>({ context })`。用 `typeof context` 获取实际依赖对象的类型，无需重复声明 `AppContext`。初始化直接返回普通的 `createRouter(namespace)` 函数。

工厂的泛型顺序为请求协议、上下文类型、入站事件协议。上下文在创建 Router 时绑定，Router 自己管理注册和清理，不需要额外的管理器。

通道使用完整的 `namespace:method` 名称。`createRouter('app')` 只接受协议中 `app:` 开头的请求和入站事件；创建不存在的命名空间也会产生类型错误。`use`、`handle`、`handleOnce`、`on`、`once` 均返回 Router 本身，支持链式调用。

初始化只保存依赖，定义 Router 只保存注册记录；调用 `router.register()` 才连接 Electron IPC。可以先注册路由，再创建窗口。getter 在 handler 执行时获取当前窗口；有异步等待时，应在实际操作窗口前重新检查其状态。

同一工厂创建的 Router 共享传入的 `context`。handler 中的 `ctx` 类型为 `Readonly<Context>`，只提供浅层的编译期只读约束。库保留传入对象的引用，不复制或冻结服务对象。不同工厂可以绑定不同上下文，Router 重新注册时仍使用创建时的上下文。每次请求或事件都会创建独立的调用对象，中间件和 handler 使用同一个对象，不会修改 Electron 原始事件。handler 的公开参数仍为 `{ event, ctx }` 和协议定义的业务参数。业务参数的运行时校验由使用方负责；TypeScript 类型不会校验跨进程输入。

## 全局与模块中间件

通过初始化参数配置全局中间件，使用 `router.use()` 追加模块中间件。两者都作用于 Router 的 `handle`、`handleOnce`、`on`、`once`。原来的 `initIpcRouter({ context })`、`.handle()` 和 `.register()` 写法继续可用。

```ts
import { initIpcRouter } from '@electron-browser/typed-ipc/main'
import type { IpcMiddleware } from '@electron-browser/typed-ipc/main'
import type { Requests, ToMain } from './contracts'

const context = { getMainWindow }

const timing: IpcMiddleware<typeof context> = async ({ kind, channel }, next) => {
  const start = performance.now()
  try {
    return await next()
  } finally {
    console.log(kind, channel, performance.now() - start)
  }
}

export const createRouter = initIpcRouter<Requests, typeof context, ToMain>({
  context,
  middlewares: [timing],
  // 可选：处理单向事件的异常，不接收 invoke 请求的异常。
  onError: (error, { channel }) => {
    console.error(`IPC event failed: ${channel}`, error)
  }
})

const windowRouter = createRouter('window')
windowRouter.use(async ({ ctx }, next) => {
  const win = ctx.getMainWindow()
  if (!win || win.isDestroyed()) throw new Error('主窗口不可用')
  return await next()
})

windowRouter.handle('window:updateSize', ({ ctx }, width, height) => {
  const win = ctx.getMainWindow()
  // 前面的中间件可能有异步等待，实际操作前仍获取并检查当前窗口。
  if (!win || win.isDestroyed()) throw new Error('主窗口不可用')
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError('窗口宽高必须为正整数')
  }
  win.setSize(width, height)
})

windowRouter.register()
```

执行顺序为全局中间件前置 → 模块中间件前置 → handler → 模块中间件后置 → 全局中间件后置。各层按声明顺序进入、逆序返回；`next()` 至多调用一次。中间件应返回 `next()` 的结果；需要后置处理时使用 `return await next()` 配合 `try/finally`，需要阻止调用时抛出异常。共享中间件必须适配任意返回类型，类型检查会拒绝固定的替代返回值和漏写 `return`。

中间件收到的 `call` 包含以下字段：

| 字段      | 含义                                                              |
| --------- | ----------------------------------------------------------------- |
| `ctx`     | 初始化时传入的应用依赖，类型为 `Readonly<Context>`                |
| `kind`    | 请求为 `'invoke'`，单向事件为 `'event'`                           |
| `event`   | 原始 Electron 事件，可通过 `kind` 缩小类型                        |
| `channel` | 本次调用的完整通道名                                              |
| `args`    | 本次调用的参数，类型为 `readonly unknown[]`，使用前自行收窄或校验 |

全局范围仅限于同一个工厂创建的 Router，也包括在其他文件中创建的实例。初始化时会复制全局中间件数组，每个 Router 再持有自己的列表；后续修改原数组、给其他 Router 调用 `.use()`，都不会影响当前 Router。中间件函数本身可以共享，每次调用的数据应保存在调用对象或局部变量中。

`.use(...middlewares)` 对当前 Router 的全部定义生效，与 `.handle()` 的先后书写顺序无关，但必须在 `.register()` 前配置。注册后禁止追加中间件；取消注册后可以追加并重新注册。每次注册固定本次使用的中间件列表，已开始的调用仍会完成，不受后续取消或重新配置的影响。

请求异常会沿中间件链向外传播，并使 renderer 的 `invoke()` 拒绝。单向事件没有响应 Promise；库会等待异步中间件和事件 handler，将未处理异常交给可选的 `onError(error, call)`。未配置时使用 `console.error`；`onError` 自身抛错或拒绝时也会记录原始错误和报告错误。这个处理只适用于 Router，不改变低层 `TypedIpcMain` 的事件行为。

`handleOnce` 和 `once` 在首次调用进入中间件之前就会消耗，包括中间件拒绝本次调用的情况。返回的取消函数只阻止后续调用，不中断正在执行的中间件链。

## 分模块

项目可按下列方向组织，避免循环依赖：

- 窗口管理模块：创建窗口，提供 `getMainWindow()`。
- IPC runtime 模块：导入窗口管理模块，导出绑定上下文的 `createRouter`。
- Router 模块：导入 `createRouter`，直接调用 `createRouter('app')` 并导出路由实例。
- IPC 入口：导入各 Router，在应用启动时分别调用 `appRouter.register()`、`windowRouter.register()`。

本仓库的实际示例位于应用的 `src/main/ipc` 和 `src/main/windows`。

## preload 调用

```ts
import { contextBridge } from 'electron'
import { TypedIpcRenderer } from '@electron-browser/typed-ipc/renderer'
import type { Requests, ToMain, ToRenderer } from './contracts'

const ipc = new TypedIpcRenderer<Requests, ToMain, ToRenderer>()

contextBridge.exposeInMainWorld('api', {
  getAppVersion: () => ipc.invoke('app:getVersion'),
  updateWindowSize: (width: number, height: number) =>
    ipc.invoke('window:updateSize', width, height),
  ready: (id: string) => ipc.send('app:ready', id),
  onProgress: (listener: (percent: number) => void) => ipc.on('app:progress', listener)
})
```

`invoke` 返回 `Promise<Awaited<ReturnType<协议函数>>>`。处理函数可以同步返回或异步返回结果。renderer 的事件回调仅接收业务载荷，不会向页面传递 Electron event。`on` / `once` 返回幂等取消函数，也可以通过原始回调调用 `off`。

主进程主动推送可以使用低层封装：

```ts
import { TypedIpcMain } from '@electron-browser/typed-ipc/main'
import type { Requests, ToMain, ToRenderer } from './contracts'

const ipc = new TypedIpcMain<Requests, ToMain, ToRenderer>()
ipc.send(webContents, 'app:progress', 50)
```

`TypedIpcMain` 的 `handle` / `handleOnce` / `on` / `once` 仍返回取消函数，可独立用于直接 IPC 调用。

## 注册和清理

- `router.register()` 是唯一的 Router 注册入口，不接受参数，返回该次挂载的取消函数。
- 单个 Router 注册失败时，回滚这个 Router 本次已经注册的请求和事件；其他已经注册成功的 Router 保持有效。
- 需要提前停止某个 Router 时，调用其 `register()` 返回的取消函数。取消函数可重复调用，并且只影响本次注册。
- 取消时按定义的相反顺序清理该 Router 的请求和事件。清理某项失败时继续处理其他项，最后抛出 `AggregateError`。
- 同一个 Router 不能同时挂载两次；挂载期间禁止追加定义；取消后可以再次挂载。
- 同一 Router 的 `handle` 和 `handleOnce` 共享请求通道冲突检查；事件允许多个订阅。跨 Router 的请求冲突在挂载时由 Electron 检查，失败会触发回滚。
- 旧的取消函数不会删除通过本库后来注册的同名请求。需要修改注册时使用本库的生命周期接口，避免绕过封装直接修改 Electron 监听。

```ts
const unregisterApp = appRouter.register()

// 测试结束、模块停用等需要提前清理的场景。
unregisterApp()
```

应用启动后一直使用到主进程退出的 Router，直接调用 `.register()` 即可，无需额外挂载退出清理。窗口关闭和重建时，通过上下文 getter 获取当前窗口，不需要重新注册 Router。

## 构建和验证

从仓库根目录执行：

```sh
pnpm build:ipc
pnpm test:ipc
pnpm build
```

库自身也可以独立执行 `npm run build` 和 `npm test`，依赖自己的 `package.json` / `tsconfig.json`。产物位于 `dist`，包含 CommonJS JavaScript 和 `.d.ts`，支持 Electron 构建工具通过 package exports 导入。库测试运行实际构建产物，使用模拟 Electron 接口验证生命周期，并编译消费端代码检查公开类型。

应用通过 `workspace:*` 引入此包，并在 electron-vite 中将其打入 main/preload 产物。`pnpm dev` 会先构建库；修改库源码进行开发时，可以另开终端执行 `pnpm --dir packages/typed-ipc exec tsc -p tsconfig.json --watch` 更新产物。
