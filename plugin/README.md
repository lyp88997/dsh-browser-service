# plugin/ —— dsh-browser-service 的插件侧源码

这里不是独立子包：**v0.4.0 起本仓库只有一个交付物 `dsh-browser-service`**（根 `package.json` 就是它），安装、打包与分发见[根 README](../README.md) §3.3 与 §8（npm 短命令：`dsh plugin --profile <name> add dsh-browser-service@latest`）。本目录只放插件侧的东西：

```
browser_* 工具（33 个，来自依赖 dsh-builtin-browser 的 tool-browser）
   └─ ctx.browser seam（来自同一个依赖的 browser）
        └─ 本目录的 provider（providerId = cdp-daemon）
             └─ playwright-core connectOverCDP → browsersvc 回环代理
                  └─ chrome-headless-shell（用户态库 + 包装脚本）
```

| 路径 | 作用 |
| --- | --- |
| `lib/index.js` | 插件入口：`inject = ['browser']`，先做启动期能力探测（`lib/compat.js`）再注册 provider |
| `lib/compat.js` | 启动期探测：校验接缝导出面（`browser` 的函数默认导出 / `tool-browser` 的 `name`+`apply`+`inject`）、读宿主与接缝版本，不符时打一句人话并安静退出 |
| `lib/provider.js` | `BrowserProvider` 全部成员（seam 契约见 `dsh-builtin-browser/lib/browser/types.d.ts`）；含默认自启 `defaultAutoStartCommand()` |
| `lib/dom.js` | 页面内取快照 / a11y / 表单操作注入的脚本（含 checked 状态、代理对安全截断） |
| `shims/browser.js` | `export * from 'dsh-builtin-browser/browser'`（含 default）：把接缝挂进 profile |
| `shims/tool-browser.js` | `export * from 'dsh-builtin-browser/tool-browser'`（**源模块没有 default**）：挂 33 个工具 |
| `cordis.patch.yml` | bundle patch：`insert` 接缝 `browser`（选 `cdp-daemon`）、`tool-browser`、`browser-cdp` provider |

转出口的导出键必须与源模块**完全一致**（loader 挂的是模块本身）；少一个 default 或多一个都会在组合期报错，所以 `scripts/verify-bundle.mjs` 会把两者的导出键逐一比对。

## 配置

配置表的权威位置是**根 README 的「配置」一节**（npm 页面只渲染根 README）；键与默认值的权威定义是 `lib/index.js` 的 `Config`（schemastery schema）。改默认值必须**同时**改 schema 与根 README 的配置表——本文件不再复制那张表，以免再出现「文档写 `30000`、代码是 `10000`」这类漂移。

所有键都可写在 profile patch 的 `config:` 下（patch **整行替换** `config`，覆盖时要重述该行需要的每个键）。

> **v0.3.0 起公开端口要求 `Authorization: Bearer <token>`**（token 由 `browsersvc` 生成，落在 0600 的 `service.json`）。插件自动读取它，无需改配置；但 `browsersvc` 与插件必须一起升级——旧插件 + 新守护进程会在 401 上失败。

## 验证

- 插件行为：`node scripts/verify-provider.mjs`（110 项零依赖，真实 `browsersvc` + 本地站点）。
- 组合包安装路径（官方 `dsh plugin` 流程）：`node scripts/verify-bundle.mjs`（33 项，一次性隔离 `DSH_HOME`；含启动期探测的四类坏形状与工具面静态计数）。
- 守护进程与 CLI：`node scripts/verify-daemon.mjs`（35 项）。
- DSH 版本矩阵：`node scripts/verify-matrix.mjs --dsh <bin> … --smoke`（4 个宿主版本 × 12 项）。

## 许可

MIT（见仓库根 `LICENSE`）
