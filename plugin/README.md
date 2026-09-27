# plugin/ —— dsh-browser-service 的插件侧源码

这里不是独立子包：**v0.4.0 起本仓库只有一个交付物 `dsh-browser-service`**（根 `package.json` 就是它），安装、打包与分发见[根 README](../README.md) §3.3 与 §8。本目录只放插件侧的东西：

```
browser_* 工具（33 个，来自依赖 dsh-builtin-browser 的 tool-browser）
   └─ ctx.browser seam（来自同一个依赖的 browser）
        └─ 本目录的 provider（providerId = cdp-daemon）
             └─ playwright-core connectOverCDP → browsersvc 回环代理
                  └─ chrome-headless-shell（用户态库 + 包装脚本）
```

| 路径 | 作用 |
| --- | --- |
| `lib/index.js` | 插件入口：`inject = ['browser']`，读 Config 后注册 provider |
| `lib/provider.js` | `BrowserProvider` 全部成员（seam 契约见 `dsh-builtin-browser/lib/browser/types.d.ts`）；含默认自启 `defaultAutoStartCommand()` |
| `lib/dom.js` | 页面内取快照 / a11y / 表单操作注入的脚本（含 checked 状态、代理对安全截断） |
| `shims/browser.js` | `export * from 'dsh-builtin-browser/browser'`（含 default）：把接缝挂进 profile |
| `shims/tool-browser.js` | `export * from 'dsh-builtin-browser/tool-browser'`（**源模块没有 default**）：挂 33 个工具 |
| `cordis.patch.yml` | bundle patch：`insert` 接缝 `browser`（选 `cdp-daemon`）、`tool-browser`、`browser-cdp` provider |

转出口的导出键必须与源模块**完全一致**（loader 挂的是模块本身）；少一个 default 或多一个都会在组合期报错，所以 `scripts/verify-bundle.mjs` 会把两者的导出键逐一比对。

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
| `autoStartCommand` | 空 = 用**本包自带**的 `bin/browsersvc.mjs start` | 可选：首次用浏览器时执行的命令；换端口/内核才需要填 |
| `autoStartTimeoutMs` | `60000` | `autoStartCommand` 的执行超时 |
| `cdpToken` | 空 | 一般不用填：留空时自动读 `<DSH_BROWSER_SVC_ROOT 或 $DSH_HOME/browser-service>/service.json` 里的 `token`（每次 attach 重读，守护进程重启换 token 也能跟上）。只有指向自建/非 browsersvc 的 CDP 端点时才需要显式给 |
| `downloadDir` | 空 | 填了就要求 `browser_screenshot` / `browser_download` 的 `savePath` 落在该目录内（未填则只强制「绝对路径 + 不覆盖已有文件」） |

所有键都可写在 profile patch 的 `config:` 下（patch **整行替换** `config`，覆盖时要重述该行需要的每个键）。

> **v0.3.0 起公开端口要求 `Authorization: Bearer <token>`**（token 由 `browsersvc` 生成，落在 0600 的 `service.json`）。插件自动读取它，无需改配置；但 `browsersvc` 与插件必须一起升级——旧插件 + 新守护进程会在 401 上失败。

## 验证

- 插件行为：`node scripts/verify-provider.mjs`（88 项零依赖，真实 `browsersvc` + 本地站点）。
- 组合包安装路径（官方 `dsh plugin` 流程）：`node scripts/verify-bundle.mjs`（23 项，一次性隔离 `DSH_HOME`）。
- 守护进程与 CLI：`node scripts/verify-daemon.mjs`（32 项）。

## 许可

MIT（见仓库根 `LICENSE`）
