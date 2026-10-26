import { createRouter } from '../runtime'

export const windowRouter = createRouter('window')

windowRouter.handle('window:updateSize', ({ event, ctx }, width, height) => {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError('窗口宽高必须为正整数')
  }
  const { window: win } = ctx.getWindowContext(event)
  win.setSize(width, height)
})

windowRouter.handle('window:updateBrowserLayout', ({ event, ctx }, layout) => {
  if (!layout || typeof layout.showPage !== 'boolean' || typeof layout.panelOpen !== 'boolean') {
    throw new TypeError('浏览器布局参数必须为布尔值')
  }
  ctx.getWindowContext(event).updateBrowserLayout(layout)
})
