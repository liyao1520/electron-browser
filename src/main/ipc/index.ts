import { appRouter } from './routers/app'
import { windowRouter } from './routers/window'
import { tabRouter } from './routers/tab'
import { updateRouter } from './routers/update'

export function registerIpcRouters(): void {
  appRouter.register()
  windowRouter.register()
  tabRouter.register()
  updateRouter.register()
}
