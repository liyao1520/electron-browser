# GitHub CI/CD

当前交付 Windows x64 NSIS 安装包，后续再增加其他平台。

## 工作流

| 文件                            | 触发方式                       | 行为                                                                                 |
| ------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------ |
| `.github/workflows/ci.yml`      | PR、推送 main/master、手动运行 | 安装锁定依赖 → lint → 类型检查与构建 → 打包 → 上传 Actions 产物                      |
| `.github/workflows/release.yml` | 推送版本标签                   | 校验标签与 package.json 版本 → 执行相同构建 → 创建草稿 → 上传全部产物 → 发布 Release |
| `.github/workflows/build.yml`   | 由上述工作流调用               | 统一 Windows 构建过程                                                                |

Node.js 版本由 `.node-version` 固定，pnpm 版本由 package.json 的 `packageManager` 固定。Action 使用提交 SHA 固定，由 Dependabot 提交更新。

## 首次启用

1. 将项目提交并推送到 GitHub 仓库，确保 `.github`、配置文件和 `pnpm-lock.yaml` 一并提交。
2. 在仓库 Actions 中确认工作流可运行；组织策略需要允许发布任务使用 `contents: write`。
3. 合并目标分支为 main/master 时自动执行 CI；其他长期分支可修改 `ci.yml`。
4. 在分支保护中将 CI 的 Windows 构建检查设为必需检查。

同仓库发布使用 GitHub 自动提供的 `GITHUB_TOKEN`，无需配置 PAT。

## 发布版本

先在 package.json 修改版本并提交，通过 CI 后推送对应标签。例如发布下一版：

```bash
pnpm version 1.0.2 --no-git-tag-version
git add package.json
git commit -m "chore: release 1.0.2"
git push origin main
git tag v1.0.2
git push origin v1.0.2
```

使用 master 分支时替换示例中的 main。当前版本以 `package.json` 为准，发布标签必须与它完全对应；已发布版本的修复需提高版本号后重新发布。

- 正式版：`1.0.1` 对应 `v1.0.1`。
- 预发布：如 `1.1.0-beta.1` 对应 `v1.1.0-beta.1`，标记为 prerelease；同样支持 alpha、rc。
- 标签与版本号不一致时构建失败；已公开发布的版本不会被覆盖，修复需提高版本号。
- 上传失败会保留草稿，修复后重新运行失败工作流可继续上传并发布。
- Actions 中可下载保存 14 天的产物；Release 附件包含 Windows 安装包及对应渠道的更新元数据。

## 应用内更新

Windows 安装版启动后自动检查 GitHub Releases；也可在浏览器菜单的“应用更新”中手动检查。
发现新版本后，用户确认下载，界面显示进度；完成后可重启安装，也可在正常退出时自动安装。
更新会关闭网页，请先保存网页内容。当前使用全量下载，不启用差分更新。

- `electron-updater` 从打包生成的 `resources/app-update.yml` 读取更新源，不需要额外更新服务器。
- 正式版读取 `latest.yml`；测试版使用 `alpha.yml`、`beta.yml` 或 `rc.yml`，正式版不会自动升级到测试版。
- 构建仍使用 `--publish never` 生成文件，再由发布任务统一上传到草稿，文件齐全后公开 Release。
- 当前更新源需允许客户端公开读取 Release 附件；客户端不内置 GitHub Token。
- 普通开发模式和其他平台不检查更新；Windows 可显式启用下述开发测试。此前未集成更新器的版本，需要手动安装一次包含此功能的新版。

验证完整升级需准备两个递增版本：安装旧版，发布新版，再检查下载、失败重试及重启安装。
检查 Release 中存在对应的更新元数据，且其中引用的安装包可以下载。

### Windows 开发环境测试

在两个终端分别运行：

```powershell
# 终端 1：启动仅监听本机的测试更新源
pnpm update:serve

# 终端 2：启动浏览器，显式启用开发更新测试
pnpm dev:update
```

在浏览器菜单的“应用更新 · 开发测试”中检查、下载。默认会发现 `999.0.0`，下载约 4 MB 测试数据，展示真实进度并执行 SHA-512 校验。下载完成显示“重新检查”，便于反复测试。
该文件不是安装包；开发模式禁止调用安装器，正常退出时也不会自动安装。

测试服务器支持以下场景。停止终端 1 的服务器，换场景重启，再在浏览器中点击“检查更新”“重试”或“重新检查”：

| 命令                                          | 场景                            |
| --------------------------------------------- | ------------------------------- |
| `pnpm update:serve`                           | 发现新版本，正常下载和校验      |
| `pnpm update:serve --scenario=latest`         | 当前已是最新版本                |
| `pnpm update:serve --scenario=check-error`    | 检查更新返回 HTTP 503           |
| `pnpm update:serve --scenario=download-error` | 发现新版本，但下载返回 HTTP 503 |

如果当前已显示“下载更新”，可点击旁边的“重新检查”切换场景，或直接下载验证该场景。恢复默认服务器后点击“重试”验证恢复流程。
每次启动或切换场景会生成不同测试内容，避免失败场景命中之前的下载缓存。

`pnpm dev:update` 通过 `--test-updates` 参数启用 `autoUpdater.forceDevUpdateConfig`，读取根目录的 `dev-app-update.yml`；普通 `pnpm dev` 保持禁用。
该配置默认指向 `http://127.0.0.1:8877/`，可改为自建更新服务器，或使用下面的配置验证真实 GitHub Release（需要有高于 package.json 版本的公开版本）：

```yaml
provider: github
owner: liyao1520
repo: electron-browser
updaterCacheDirName: ebrowser-dev-updater
```

开发缓存使用独立目录；`dev-app-update.yml` 和测试服务器不会打进安装包，安装版会忽略开发参数，继续读取正式更新源。
开发测试失败时，主进程终端输出原始错误，界面保留重试入口。端口占用时先停止占用 8877 的旧测试服务。

执行 `pnpm test:update` 可自动构建并用真实 Electron、HTTP 更新源验证检查、下载进度、校验、失败重试和安装拦截，窗口隐藏，测试使用独立 profile 和缓存。
完整的安装及重启流程仍需用上述两个 Windows 安装版本验证。

## 签名

默认构建未签名的学习版。正式签名时，在仓库 Secrets 配置：

| Secret                 | 用途                                                           |
| ---------------------- | -------------------------------------------------------------- |
| `WIN_CSC_LINK`         | electron-builder 支持的 Windows 签名证书，如 Base64 编码的 PFX |
| `WIN_CSC_KEY_PASSWORD` | 证书密码                                                       |

签名凭据只传给版本发布构建的打包步骤，PR 构建不接收这些 Secrets。证书、私钥和密码不得提交到仓库。

## 本地检查

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm build
pnpm exec electron-builder --win nsis --x64 --publish never
```

本地检查只验证代码与安装包；真实 GitHub 权限、上传和发布须在仓库 Actions 中验证。

参考：[GitHub Actions Node.js 工作流](https://docs.github.com/en/actions/tutorials/build-and-test-code/nodejs)、[electron-builder 发布配置](https://www.electron.build/v26/docs/publish/)。
