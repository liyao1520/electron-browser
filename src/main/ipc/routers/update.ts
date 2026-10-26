import { checkForUpdates, downloadUpdate, getUpdateState, installUpdate } from '../../updater'
import { createRouter } from '../runtime'

// 沿用统一的调用方校验，网页标签无法检查、下载或安装更新。
export const updateRouter = createRouter('update')
updateRouter.handle('update:getState', getUpdateState)
updateRouter.handle('update:check', checkForUpdates)
updateRouter.handle('update:download', downloadUpdate)
updateRouter.handle('update:install', installUpdate)
