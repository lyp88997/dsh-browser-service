# dsh-browser-cdp

DSH（DeepSeek Harness）的浏览器 provider 插件：把内核接到**自建的单例 CDP 浏览器服务**（[`dsh-browser-service`](../README.md) 的 `browsersvc`），**复用内置 `dsh-builtin-browser/tool-browser` 的 33 个 `browser_*` 工具**——插件本身不注册任何工具。

```
browser_* 工具（内置 tool-browser）
   └─ ctx.browser seam
        └─ 本插件（providerId = cdp-daemon）
             └─ playwright-core connectOverCDP → browsersvc 回环代理
                  └─ chrome-headless-shell（用户态库 + 包装脚本）
```

适合**无 root、无 GUI、无沙箱**的服务器容器：内置 Electron provider 装不起来时用它。

## 依赖

- DSH ≥ 0.1.5
- Node `^22.19.0 || >=24.0.0`
- **`dsh-builtin-browser` 组合包**：`ctx.browser` seam 与 33 个 `browser_*` 工具都由它提供（DSH 自身不含）。本包 `inject = ['browser']`，patch 里有两条按 id 覆盖它插入的行 —— 所以它有**安装顺序**要求，见下。
- 运行时依赖：`playwright-core`（**不下载浏览器**，只做 CDP 客户端）、`@deepseek-ai/schemastery`
- 一个已起的 `browsersvc`（找内核、起守护进程的活由它做，见仓库根 README）

## 安装（二选一，**不要同时做**）

方式都会产生同样三条 profile 改动：插入 `browser-cdp`、seam 选 `cdp-daemon`、关掉 `browser-electron`。

### A. 作为 bundle（推荐）

`dsh plugin --profile <name> <args>` 只是在 profile 目录里转发给 pnpm，所以 `add` 的既可以是包名，也可以是 tarball / Release 资产 URL（官方文档推荐的「免构建授权」交付形式）。**本包必须按 tarball 或 URL 装，不能写裸包名**——npm 上的 `dsh-browser-cdp` 是别人的同名包：

```bash
dsh plugin --profile <name> add dsh-builtin-browser   # 1) 先装 seam 包（npm 上有这个包）
dsh plugin --profile <name> add https://github.com/lyp88997/dsh-browser-service/releases/download/v0.3.3/dsh-browser-cdp-0.3.3.tgz   # 2) 再装本包
# 有本地文件就用 ./dsh-browser-cdp-<v>.tgz（版本号按 Releases 页最新改）
dsh --profile <name> --dump-config | grep -E 'browserProvider|patched by|not found'
# 期望：出现 "# == dsh-builtin-browser, patched by dsh-browser-cdp" 与 browserProvider: cdp-daemon，且没有 not found
# 3) 重启 DSH 才生效（插件在 boot 时 import，热重载不可靠）
```

第 1 步会顺带装上 `electron` 包（seam 包的硬依赖），但 pnpm ≥10 默认用 profile 的 `allowBuilds` 拦下它的 postinstall、不下载二进制；本包不走 electron，拦下正好。

**顺序是硬要求。** 官方层顺序是 `dsh.profile.bundles` 按列表顺序叠加、后层按行胜出，而本包 patch 的第 2、3 条覆盖的是 `dsh-builtin-browser` 插入的行。本包若排在它前面，loader 只会打印

```
dsh: [dsh-browser-cdp] patch: entry "browser" not found
dsh: [dsh-browser-cdp] patch: entry "browser-electron" not found
```

并静默丢掉这两条 —— seam 仍选内置 Electron provider，等于「装上了但没生效」。装反了这样恢复（`remove` 会同时移除依赖与 `dsh.profile.bundles` 里的层，`add` 追加到末尾）：

```bash
dsh plugin --profile <name> remove dsh-browser-cdp     # 裸名在这里指 profile 的依赖键，不是 npm 包名
dsh plugin --profile <name> add ./dsh-browser-cdp-<v>.tgz
```

手工等价做法：在 `$DSH_HOME/profiles/<name>/package.json` 的 `dependencies` 里加本包，由 dsh-config-manager 的 `reconcileBundles` 按依赖顺序补进 `dsh.profile.bundles`（追加在尾部）。

> 本包**不**把 `dsh-builtin-browser` 写进自己的 `dependencies`/`peerDependencies`：`reconcileBundles` 只看 profile 自己声明的依赖，间接依赖不会进 `dsh.profile.bundles`，那样只会装下包、不激活层。

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

- 插件行为：仓库 `scripts/verify-provider.mjs` 有 86 项零依赖验收（真实 `browsersvc` + 本地站点）：`cd ../ && node scripts/verify-provider.mjs`。
- **打包/安装路径（官方文档流程）**：仓库 `scripts/verify-bundle.mjs` 在一次性隔离 `DSH_HOME` 里真实执行 `dsh plugin --profile … add <tgz>` → `--dump-config` → `remove`，断言「层已追加 / 三条 patch 行生效 / 顺序装反会报 `entry "browser" not found` / remove 同时清掉依赖与层」，且不碰你的默认 profile。

## 许可

MIT
