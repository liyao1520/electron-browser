/* eslint-disable @typescript-eslint/explicit-function-return-type -- 本地 Node.js 测试工具。 */
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const scenarios = ['available', 'latest', 'check-error', 'download-error']
const { version: currentVersion } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
)

export function createUpdateTestServer(initialScenario = 'available') {
  let scenario
  let file
  let payload
  let sha512

  function setScenario(next) {
    if (!scenarios.includes(next)) throw new Error(`场景必须为：${scenarios.join(', ')}`)
    scenario = next
    // 每次切换重新生成内容，确保下载失败场景不会命中之前的有效缓存。
    file = `ebrowser-dev-${randomUUID()}.exe`
    payload = Buffer.alloc(4 * 1024 * 1024)
    payload.write(`EBROWSER DEVELOPMENT UPDATE FIXTURE ${randomUUID()}\nNOT AN INSTALLER\n`)
    sha512 = createHash('sha512').update(payload).digest('base64')
  }
  setScenario(initialScenario)

  const server = createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname
    response.setHeader('Cache-Control', 'no-store')
    if (pathname === '/latest.yml') {
      if (scenario === 'check-error') {
        response.writeHead(503)
        response.end('Simulated update check failure')
        return
      }
      response.setHeader('Content-Type', 'application/yaml')
      response.end(
        JSON.stringify({
          version: scenario === 'latest' ? currentVersion : '999.0.0',
          files: [{ url: file, sha512, size: payload.length }],
          path: file,
          sha512
        })
      )
      return
    }
    if (pathname !== `/${file}`) {
      response.writeHead(404)
      response.end()
      return
    }
    if (scenario === 'download-error') {
      response.writeHead(503)
      response.end('Simulated update download failure')
      return
    }
    // 返回有正确 SHA-512 的不可执行测试数据，分块发送以验证真实下载进度。
    const data = payload
    response.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': data.length
    })
    let offset = 0
    const timer = setInterval(() => {
      const end = Math.min(offset + 128 * 1024, data.length)
      response.write(data.subarray(offset, end))
      offset = end
      if (offset === data.length) {
        clearInterval(timer)
        response.end()
      }
    }, 100)
    response.once('close', () => clearInterval(timer))
  })
  return { server, setScenario }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const { values } = parseArgs({
    options: { scenario: { type: 'string', default: 'available' } }
  })
  const { server } = createUpdateTestServer(values.scenario)
  server.on('error', (error) => {
    console.error(`更新测试服务器启动失败：${error.message}`)
    process.exitCode = 1
  })
  server.listen(8877, '127.0.0.1', () => {
    console.log(`更新测试服务器：http://127.0.0.1:8877/，场景：${values.scenario}`)
    console.log('请在另一终端运行 pnpm dev:update。下载文件仅用于校验，不是安装包。')
  })
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      server.closeAllConnections()
      server.close()
    })
  }
}
