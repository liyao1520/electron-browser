import { isHttpUrl } from '../../shared/utils'
import { isIP } from 'node:net'

/**
 * 将地址栏输入转换为可交给 loadURL 的地址，输入类型由上层入口校验。
 * 完整 HTTP/HTTPS URL 保留协议；不带协议的域名补 https://，localhost 和 IP 补 http://。
 * 普通文字、邮箱、无法识别的地址及空输入交给百度搜索。
 * 所有分支统一返回 URL.href，调用方不必再次解析或规范化。
 * URL 格式有效只代表可以尝试导航，是否能连接、证书是否有效等由实际加载结果决定。
 */
export function resolveNavigationInput(text: string): string {
  const input = text.trim()
  if (isHttpUrl(input)) return new URL(input).href

  const address = resolveAddressWithoutProtocol(input)
  if (address !== null) return address

  const searchUrl = new URL('https://www.baidu.com/s')
  // 交给 URLSearchParams 编码，避免输入中的 &、+、# 等字符改变搜索参数含义。
  searchUrl.searchParams.set('wd', input)
  return searchUrl.href
}

/**
 * 判断无协议输入是否像网页地址；不能只尝试 new URL('https://' + input)，
 * 因为“hello”等普通搜索词也能被 URL 构造器当作单段主机名接受。
 */
function resolveAddressWithoutProtocol(input: string): string | null {
  // 含空白、反斜杠、相对路径或其他显式协议的输入不做域名补全。
  if (!input || /[\s\\]/u.test(input) || /^[/?#]/u.test(input)) return null
  if (/^[a-z][a-z\d+.-]*:\/\//iu.test(input)) return null

  // 纯 IPv6 地址可以直接输入；带路径或端口时使用 [::1]:3000/path 形式。
  if (isIP(input) === 6) return new URL(`http://[${input}]`).href

  try {
    const candidate = new URL(`https://${input}`)
    // user@example.com 应作为邮箱搜索；带认证信息的 URL 需要明确写出 http(s)://。
    if (candidate.username || candidate.password) return null

    // URL 已完成大小写和国际化域名转换；末尾的根域点不参与域名结构判断。
    const hostname = candidate.hostname.replace(/\.$/u, '')
    const rawHostname = input.split(/[/:?#]/u, 1)[0]
    const labels = hostname.split('.')
    const validLabels =
      hostname.length <= 253 &&
      labels.every((label) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/iu.test(label))
    const isLocalhost = validLabels && (hostname === 'localhost' || hostname.endsWith('.localhost'))
    // IPv4 校验原始主机名，避免把 123、127.1 等输入自动改写成另一种 IPv4 表示。
    const isIpv4 = isIP(rawHostname) === 4
    const isIpv6 = hostname.startsWith('[') && hostname.endsWith(']')
    if (isLocalhost || isIpv4 || isIpv6) {
      // 从原输入重建，避免先按 HTTPS 解析后丢失用户显式填写的 :443 端口。
      return new URL(`http://${input}`).href
    }

    // 只检查域名结构，不查询 DNS 或维护顶级域名列表；可达性由后续加载结果决定。
    const validSuffix = /^(?:[a-z]{2,63}|xn--[a-z\d-]+)$/iu.test(labels.at(-1) ?? '')
    if (labels.length >= 2 && validLabels && validSuffix) {
      return candidate.href
    }
  } catch {
    // 非法端口、错误的 IP/域名语法等交回搜索分支，不让地址栏输入导致调用失败。
  }
  return null
}
