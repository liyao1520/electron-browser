import { appRouter } from './routers/app'
import { windowRouter } from './routers/window'
import { tabRouter } from './routers/tab'

export function registerIpcRouters(): void {
  appRouter.register()
  windowRouter.register()
  tabRouter.register()
}
