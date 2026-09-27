# dsh-browser-cdp

DSH（DeepSeek Harness）的浏览器 provider 插件：把内核接到**自建的单例 CDP 浏览器服务**（[`dsh-browser-service`](../README.md) 的 `browsersvc`），**复用内置 `dsh-builtin-browser/tool-browser` 的 32 个 `browser_*` 工具**——插件本身不注册任何工具。

```
browser_* 工具（内置 tool-browser）
   └─ ctx.browser seam
        └─ 本插件（providerId = cdp-daemon）
             └─ playwright-core connectOverCDP → browsersvc 回环代理
                  └─ chrome-headless-shell（用户态库 + 包装脚本）
```

适合**无 root、无 GUI、无沙箱**的服务器容器：内置 Electron provider 装不起来时用它。

## 依赖

- DSH ≥ 0.1.5（提供 `ctx.browser` seam 与 `tool-browser`）
- Node `^22.19.0 || >=24.0.0`
- 运行时依赖：`playwright-core`（**不下载浏览器**，只做 CDP 客户端）、`@deepseek-ai/schemastery`
- 一个已起的 `browsersvc`（找内核、起守护进程的活由它做，见仓库根 README）

## 安装（二选一，**不要同时做**）

方式都会产生同样三条 profile 改动：插入 `browser-cdp`、seam 选 `cdp-daemon`、关掉 `browser-electron`。

### A. 作为 bundle（推荐）

把本包放进 profile 依赖，让它自带的 `cordis.patch.yml` 生效：

```bash
DSH_HOME=... dsh plugin add dsh-browser-cdp      # 装进 profile，并写进 dsh.profile.bundles
# 或者手工：在 $DSH_HOME/profiles/web/package.json 的 dependencies 加本包，
#          由 dsh-config-manager 的 reconcileBundles 补进 dsh.profile.bundles
```

### B. 手工 patch

把仓库的 `docs/profile-patch.browser-cdp.yml` 追加到 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 尾部；此时**不要**把本包放进 `dsh.profile.bundles`（会导致 `insert` 重复）。

> 改完 profile **必须重启 DSH**：运行中的完整 profile 上 `patchReload: live` 会静默回滚（详见仓库 `docs/provider-m2.md`）。
> 也不要和 `dsh-playwright-browser` 同时启用——它的 10 个 `browser_*` 工具与内置工具**重名**。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `providerId` | `cdp-daemon` | seam 里注册的 provider 名，要和 patch 里 `browser.browserProvider` 一致 |
| `cdpUrl` | `http://127.0.0.1:9333` | browsersvc 的公开（回环）端点 |
| `connectTimeoutMs` | `30000` | 连 CDP / 首次用浏览器时等守护进程起来的超时 |
| `actionTimeoutMs` / `navigationTimeoutMs` / `lookupTimeoutMs` | `15000` / `30000` / `5000` | 单次动作 / 导航 / 找元素超时 |
| `snapshotMaxElements` | `200` | `browser_snapshot` 返回的元素上限 |
| `contentMaxChars` | `200000` | `browser_content` 截断长度 |
| `viewportWidth` / `viewportHeight` | `1440` / `900` | 新页面视口 |
| `autoStartCommand` | 空 | 可选：首次用浏览器时执行的命令（如 `node /path/to/dsh-browser-service/bin/browsersvc.mjs start`），需要内置/外部的 `browsersvc` 路径，按机器填 |
| `autoStartTimeoutMs` | `60000` | `autoStartCommand` 的执行超时 |
| `cdpToken` | 空 | 一般不用填：留空时自动读 `<DSH_BROWSER_SVC_ROOT 或 $DSH_HOME/browser-service>/service.json` 里的 `token`（每次 attach 重读，守护进程重启换 token 也能跟上）。只有指向自建/非 browsersvc 的 CDP 端点时才需要显式给 |
| `downloadDir` | 空 | 填了就要求 `browser_screenshot` / `browser_download` 的 `savePath` 落在该目录内（未填则只强制「绝对路径 + 不覆盖已有文件」） |

所有键都可写在 patch 的 `config:` 下。

> **v0.3.0 起，公开端口要求 `Authorization: Bearer <token>`**（token 由 `browsersvc` 生成，落在 0600 的 `service.json`）。
> 插件会自动读取它，**无需改 profile 配置**；但 `browsersvc` 与插件必须一起升级 —— 旧插件 + 新守护进程会在 401 上失败。

## 验证

仓库 `scripts/verify-provider.mjs` 有 86 项零依赖验收（真实 `browsersvc` + 本地站点）：`cd ../ && node scripts/verify-provider.mjs`。

## 许可

MIT
