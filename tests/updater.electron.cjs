/* eslint-disable @typescript-eslint/explicit-function-return-type -- Electron integration test. */
/* eslint-disable @typescript-eslint/no-require-imports -- Electron CJS test entry. */
// Run pnpm test:update on Windows. Uses real HTTP and electron-updater with inert fixtures.
const assert = require('node:assert/strict')
const { mkdtempSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { app, BrowserWindow } = require('electron')

if (process.platform !== 'win32') {
  console.log('Update integration skipped: Windows only.')
  app.exit(0)
} else {
  const profile = mkdtempSync(join(tmpdir(), 'ebrowser-updater-test-'))
  app.setPath('userData', profile)
  app.getVersion = () => require('../package.json').version
  BrowserWindow.prototype.show = function () {
    // Keep automated update checks from opening a visible window.
  }
  process.argv.push('--test-updates')

  const { autoUpdater } = require('electron-updater')
  let installs = 0
  autoUpdater.quitAndInstall = () => installs++
  let server

  async function until(predicate, label) {
    const deadline = Date.now() + 10000
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${label}`)
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  async function run() {
    const { createUpdateTestServer } = await import('../scripts/update-server.mjs')
    const fixture = createUpdateTestServer()
    server = fixture.server
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const config = join(profile, 'dev-app-update.yml')
    writeFileSync(
      config,
      JSON.stringify({
        provider: 'generic',
        url: `http://127.0.0.1:${server.address().port}/`,
        // 每次独立缓存，确保真实执行下载并与日常开发和正式应用隔离。
        updaterCacheDirName: `ebrowser-update-test-${Date.now()}`
      })
    )
    autoUpdater.updateConfigPath = config
    require('../out/main/index.js')
    await app.whenReady()
    await until(() => BrowserWindow.getAllWindows().length, 'shell created')
    const win = BrowserWindow.getAllWindows()[0]
    const evaluate = (source) => win.webContents.executeJavaScript(source)
    await until(() => evaluate('Boolean(window.api)'), 'preload ready')
    const state = () => evaluate('window.api.getUpdateState()')
    const waitFor = (status) => until(async () => (await state()).status === status, status)
    const click = () => evaluate('document.querySelector(".app-update button").click()')

    await waitFor('available')
    assert.equal((await state()).testMode, true)
    assert.equal(autoUpdater.forceDevUpdateConfig, true)
    assert.equal(autoUpdater.autoInstallOnAppQuit, false)
    await until(
      () => evaluate('document.querySelector(".app-update button")?.textContent === "下载更新"'),
      'update UI ready'
    )
    fixture.setScenario('latest')
    await evaluate('document.querySelectorAll(".app-update button")[1].click()')
    await waitFor('latest')
    fixture.setScenario('available')
    await evaluate('window.api.checkForUpdates()')
    await waitFor('available')
    let progressed = false
    autoUpdater.on('download-progress', ({ percent }) => {
      if (percent > 0 && percent < 100) progressed = true
    })
    await click()
    await waitFor('downloaded')
    assert.equal(progressed, true, 'real HTTP download reports intermediate progress')
    await until(
      () => evaluate('document.querySelector(".app-update button")?.textContent === "重新检查"'),
      'development UI offers recheck instead of installation'
    )
    assert.match(
      await evaluate('document.querySelector(".app-update").textContent'),
      /开发测试.*退出时不会安装/
    )
    await evaluate(
      'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
    )
    writeFileSync(
      join(__dirname, '../out/ui-update-dev-preview.png'),
      (await win.capturePage()).toPNG()
    )
    await evaluate('window.api.installUpdate()')
    await new Promise(setImmediate)
    assert.equal(installs, 0)
    assert.equal((await state()).status, 'downloaded')

    fixture.setScenario('latest')
    await click()
    await waitFor('latest')
    fixture.setScenario('check-error')
    await evaluate('window.api.checkForUpdates()')
    await waitFor('error')
    fixture.setScenario('download-error')
    await evaluate('window.api.checkForUpdates()')
    await waitFor('available')
    await evaluate('window.api.downloadUpdate()')
    await waitFor('error')
    fixture.setScenario('available')
    await evaluate('window.api.checkForUpdates()')
    await waitFor('available')
    await evaluate('window.api.downloadUpdate()')
    await waitFor('downloaded')
    assert.equal((await state()).testMode, true)
    assert.equal(installs, 0)
    assert.equal(autoUpdater.autoInstallOnAppQuit, false)
    console.log(
      'Development updates passed: real HTTP, checksum, progress, latest, failures, retry and installation guard.'
    )
    win.destroy()
  }

  const watchdog = setTimeout(() => {
    console.error('Update integration timed out')
    app.exit(1)
  }, 45000)
  run()
    .then(() => {
      clearTimeout(watchdog)
      server.closeAllConnections()
      server.close()
      app.exit(0)
    })
    .catch((error) => {
      console.error(error)
      clearTimeout(watchdog)
      server?.closeAllConnections()
      server?.close()
      app.exit(1)
    })
}
