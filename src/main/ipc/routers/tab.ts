import { createRouter } from '../runtime'

// Router 仅负责把请求交给调用方窗口的管理器，标签状态和原生视图都由管理器维护。
// getWindowContext 会校验发送方登记、主 frame 及本地界面地址，不能用前端传入的窗口 ID 选窗口。
export const tabRouter = createRouter('tab')

// 查询完整状态用于首次渲染或界面重载恢复；读取不会增加 revision。
tabRouter.handle('tab:getState', ({ event, ctx }) => ctx.getWindowContext(event).tabs.getSnapshot())

// 返回代表标签已创建、导航已启动；网页加载成功或失败由后续 tab:stateChanged 通知。
// create 内部仍会校验 options，因为运行时 IPC 参数不受 TypeScript 类型约束。
tabRouter.handle('tab:create', ({ event, ctx }, options) => {
  return ctx.getWindowContext(event).tabs.create(options)
})

// 只能激活调用方窗口中已登记的标签；标签不存在时由管理器明确报错。
tabRouter.handle('tab:activate', ({ event, ctx }, tabId) => {
  ctx.getWindowContext(event).tabs.activate(tabId)
})

tabRouter.handle('tab:close', ({ event, ctx }, tabId) => {
  return ctx.getWindowContext(event).tabs.close(tabId)
})
