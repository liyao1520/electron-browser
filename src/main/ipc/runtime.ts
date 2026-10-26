import { initIpcRouter } from '@electron-brower/typed-ipc/main'
import type { IpcRequests, RendererToMainEvents } from '../../shared/ipc'
import { resolveWindowContext } from './resolve-window-context'
import type { WindowIpcEvent } from './resolve-window-context'
import type { WindowContext } from '../windows/window-context'

export interface AppIpcContext {
  getWindowContext(event: WindowIpcEvent): WindowContext
}

const context: AppIpcContext = { getWindowContext: resolveWindowContext }

// 工厂绑定上下文；模块导入只定义路由，不注册 Electron 监听。
export const createRouter = initIpcRouter<IpcRequests, AppIpcContext, RendererToMainEvents>({
  context,
  // app 等不访问窗口的 handler 也必须经过调用方校验。
  middlewares: [
    ({ event, ctx }, next) => {
      ctx.getWindowContext(event)
      return next()
    }
  ]
})
