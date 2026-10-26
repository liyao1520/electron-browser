/* eslint-disable @typescript-eslint/explicit-function-return-type -- node:test 使用 JavaScript。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

const require = createRequire(import.meta.url)

test('package exports resolve built JavaScript and keep main, renderer and type entries separate', () => {
  for (const entry of ['', '/main', '/renderer']) {
    const files = new Map()
    let electronImports = 0
    function load(filename) {
      if (files.has(filename)) return files.get(filename).exports
      const module = { exports: {} }
      files.set(filename, module)
      vm.runInNewContext(
        readFileSync(filename, 'utf8'),
        {
          module,
          exports: module.exports,
          require: (name) => {
            if (name === 'electron') {
              electronImports++
              return {}
            }
            assert.ok(name.startsWith('.'), `Unexpected runtime dependency: ${name}`)
            return load(path.resolve(path.dirname(filename), `${name}.js`))
          }
        },
        { filename }
      )
      return module.exports
    }
    const exports = load(require.resolve(`@electron-browser/typed-ipc${entry}`))
    const relativeFiles = [...files.keys()].map((file) => file.split(path.sep).join('/'))
    if (!entry) {
      assert.deepEqual(Object.keys(exports), [])
      assert.equal(electronImports, 0)
    } else if (entry === '/main') {
      assert.deepEqual(Object.keys(exports).sort(), ['IpcRouter', 'TypedIpcMain', 'initIpcRouter'])
      assert.ok(relativeFiles.every((file) => !file.includes('/renderer/')))
    } else {
      assert.equal(typeof exports.TypedIpcRenderer, 'function')
      assert.equal(exports.TypedIpcMain, undefined)
      assert.ok(relativeFiles.every((file) => !file.includes('/main/')))
    }
  }
})
