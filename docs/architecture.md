# 架构：DSH `ctx.browser` provider 接线

本插件把 CDP 守护进程接进 DSH 的 browser seam：**插件只注册 provider，工具面沿用内置 `tool-browser` 的 `browser_*` 工具**（不自己定义工具）。v0.4.0 起接缝与工具面都由依赖 `dsh-builtin-browser` 经本包转出，所以只要装一个包。

```
browser_* 工具（dsh-builtin-browser/tool-browser，经本包 plugin/shims/tool-browser.js 转出）
   └─ ctx.browser seam（dsh-builtin-browser/browser，经本包 plugin/shims/browser.js 转出）
        └─ dsh-browser-service（本仓库 plugin/lib/provider.js，provider id = cdp-daemon）
             └─ playwright-core connectOverCDP → 127.0.0.1:9333（browsersvc 回环代理）
                  └─ chrome-headless-shell（用户态库 + 包装脚本）
```

## 1. 插件

- 目录：`plugin/`（单一交付物 `dsh-browser-service` 的插件侧源码，见 `plugin/README.md`）——**不再是独立子包**，`plugin/package.json` 已删除，`dsh.bundle` 由根 `package.json` 声明。
- 依赖（根 package.json）：`dsh-builtin-browser`（接缝 + 33 个工具）、`playwright-core`（**不下载浏览器**）；`@deepseek-ai/schemastery`（配置 schema）按官方 peer 规则写成 `peerDependencies` + `devDependencies`，与宿主共享同一实例。
- `plugin/lib/index.js`：`name='browser-cdp'`、`inject=['browser']`；`apply` 先做**启动期能力探测**（`plugin/lib/compat.js`：动态 import 两个接缝模块 + `inspectSeam()` 校验导出面与宿主版本，不符就打印一句人话并 return；`ctx.browser.registerBrowserProvider` 不存在也报同一类错），探测通过后再动态 `import('playwright-core')`，然后 `ctx.browser.registerBrowserProvider(provider)`，并用 `ctx.effect` 持有 disposer（热加载不留 stale provider）。
- `plugin/lib/compat.js`：导出 `SEAM_PACKAGE` / `TESTED_SEAM` / `TESTED_HOSTS` 与纯函数 `inspectSeam({browserModule, toolModule, hostVersion})`、`readVersions()`、`seamMismatchMessage()`；只做形状与版本判断，不做任何 I/O。
- `plugin/lib/provider.js`：`createProvider({chromium, BrowserError, config, log, autoStart})`，实现 seam 的 `BrowserProvider` 全部成员（`open`/`execute`/`snapshot`/`screenshot`/…；契约见 `dsh-builtin-browser/lib/browser/types.d.ts`）；`defaultAutoStartCommand()` 指向**本包自带**的 `bin/browsersvc.mjs`。
- `plugin/lib/dom.js`：注入页面的纯函数（snapshot/a11y/content/scrape/fillForm/challenge 检测）。**注入函数不能引用任何外部作用域**（序列化后不存在）。
- `plugin/lib/provider.js` 里的**通用追踪**（P3）：`traced()` 返回一个 `Proxy`，把每个公共方法都包一层「跑完记账」（`seq`/`action`/`params`/`ok`/`error`/`ms`）写进 `<root>/ops.jsonl`，以后新增方法自动覆盖。`open`（会话创建）、`reset`（会清空账本）、`history`（读账本本身）与本来就有 `#record` 的方法在 `TRACED_SKIP` 里，不重复记账。`#instrument(page)` 挂在 `#addTab`（页面创建的**唯一漏斗**）上抓控制台与网络。
- `plugin/lib/panel.js`（P3）：网页面板的**宿主半边**——只读路由 `GET /browser-service/panel.json`（`exact`、只 GET/HEAD、`no-store`、载荷不含本机绝对路径），数据直接读三个 JSONL；通过 `ctx.inject(['webServer'], …)` 挂载，没有 `webServer` 的宿主不挂，插件照常工作。
- `plugin/client.js`（P3）：面板的**客户端半边**——手写、零构建，走 DSH 的 `window.__ModuleLoader__.load({ id, factory })` 协议，只 `require('react')`，`apply` 里 `ctx.slots.inject('shell.overlay', …)` 注册一个右下角浮动胶囊/卡片（2.5 s 轮询同一个路由）。
- `src/opslog.mjs`（P3）：插件与 CLI 共用的观测落盘层——`ops.jsonl`/`console.jsonl`/`network.jsonl` 环形（1/1/2 MiB，超限保尾部一半），`appendEntry` 的任何 IO 异常都吞掉并返回 `false`（**观测不能把浏览器调用搞挂**），文件 0600。

配置项（`Config`，全部有默认值）：`providerId='cdp-daemon'`、`cdpUrl='http://127.0.0.1:9333'`、`connectTimeoutMs`、`actionTimeoutMs`、`navigationTimeoutMs`、`lookupTimeoutMs`、`snapshotMaxElements`、`contentMaxChars`、`captureConsole`/`captureNetwork`（是否录控制台与网络，默认都开）、`maxTabs`（默认 5，夹 1..50）、`viewportWidth/Height`、`idleMs`（自启的空闲回收窗口，默认 300000）、可选 `autoStartCommand`（默认用包内 bin）、`autoStartTimeoutMs`、可选 `cdpToken`（默认自动读 `service.json`）、可选 `downloadDir`（未配置时由 `defaultDownloadDir()` 取系统 Downloads 目录：`XDG_DOWNLOAD_DIR` → 家目录下存在的 `Downloads`/`下载`/`下載` → `~/Downloads`）。完整表见根 README 的「配置」一节（权威定义是 `plugin/lib/index.js` 的 `Config`）。

## 2. 部署（一条命令）

```bash
dsh plugin --profile <name> add <dsh-browser-service-<v>.tgz 或 Release 资产 URL>
# 校验（应出现本包层、browserProvider: cdp-daemon，且本包三行没有 not found）
dsh --profile <name> --dump-config | grep -E 'patched by|browserProvider|not found'
```

装完重启 DSH 即可：接缝由本包转出，`autoStartCommand` 不需要写（默认用包内 `bin/browsersvc.mjs start`），首次用浏览器时守护进程被自动拉起。

- **不要再装 `dsh-builtin-browser` 组合包**：本包已经把它作为依赖装进 profile 并自己插接缝行；两者同时激活会出现两条 `tool-browser` 行（工具重名）。
- 改源码的临时接线（symlink 工作树 + 手写 patch）见 `docs/profile-patch.browser-service.yml`。
- 本机现状：活 profile（`$DSH_HOME/profiles/web`）自 2026-09-27 起已走 bundle 路线（`dsh plugin --profile web add dsh-browser-service@latest`），手写 patch 块与 `node_modules/dsh-browser-cdp` 软链都已删除，备份留在 profile 目录的 `*.bak-pre-bundle`。

patch 做四件事：insert 接缝 `browser`（选 `cdp-daemon`）、insert `tool-browser`、insert 本 provider、关掉内置 `browser-electron`。

> **`dsh-playwright-browser` 必须关**：它自带 10 个与内置同名的 `browser_*` 工具，两个 provider 的工具面不能共存（本包 patch 里已带该 disable 行，环境里没这个 id 时只会打印 not found 提示）。

## 3. 验收

### 3.1 provider 层（110 项，零依赖、不碰外网）

```bash
node scripts/verify-provider.mjs      # 结果：110 通过，0 失败
```

自己起本地 http 站点 + 真实 `browsersvc run`（临时 root/端口），逐项覆盖：`available`、session/tab 生命周期、`navigate` 拒非 http(s)、`execute`（表达式/参数/页面异常/超时）、`snapshot`/`a11y`/`content`（4 种格式）/`scrape`（含 `@attr`）、`waitFor` 三态、`click`/`type`/`setValue`/`check`/`getValue`/`clearField`/`selectOption`/`scroll`/`key`、`fillForm`、`screenshot`（含等比缩小/fullPage-jpeg）、`download`、`back/forward/reload`、`history`/`replay`、`detectChallenge`、`flushAuth`/`restoreAuth`、session 隔离、`reset`/`close`、保存路径准入（F1）与默认保存目录（D1）、掉线后会话复活（F22）、默认自启命令。

守护进程/CLI 层：`node scripts/verify-daemon.mjs`（35 项）；组合包安装路径：`node scripts/verify-bundle.mjs`（40 项）；观测面与面板：`node scripts/verify-data.mjs`（45 项）；DSH 版本矩阵：`node scripts/verify-matrix.mjs --dsh <bin> … --smoke`（4 个宿主版本 × 12 项）。

### 3.2 DSH 内端到端（seam → provider → 守护进程 → CDP）

`tools/seam-probe/` 是**诊断用**插件（不是交付特性）：`inject=['browser']`，在 apply 里跑一遍 `open → openUrl → snapshot → content → execute → a11y → listTabs → close` 并写 `/tmp/m2-seam-probe.log`。

做法：一次性的隔离 home + 真实 web 模板 profile（`dsh --profile e2ew --from-default-profile web` 创建，之后 `dsh --profile e2ew --no-open --port 3099` 启动），`dsh plugin --profile e2ew add dist/dsh-browser-service-<v>.tgz`，再把 `tools/seam-probe` symlink 成 profile 里的 `dsh-m2-seam-probe` 并在 profile 的 `cordis.patch.yml` 里 insert 它、给 `browser-cdp` 配一个独立端口（避开活实例的 9333）。实测日志：

```
apply entered
open -> "s1"
snapshot -> url=http://127.0.0.1:9413/ title="M2 夹具" elements=0 first=undefined
content -> "接缝端到端\n\nhi"
execute -> {"ok":true,"value":"接缝端到端"}
a11y -> count=1 nodes=1
listTabs -> [{"id":"t1","url":"http://127.0.0.1:9413/","title":"M2 夹具","active":true}]
closed -> DONE
```

这次实测暴露并修掉了 **F26**：`--internal-port-base`（CLI）被 `src/config.mjs` 静默忽略（只看 config.json），表现为守护进程仍用默认 9300 起（实测 internalPort 9301，因为 9300 被活实例占着）。修复后 CLI 值优先、其次 config.json、最后默认值。

## 4. 已知坑

1. **运行中的完整 web profile 上，patch 热重载会静默回滚**。实测：往 patch 里加一个探针条目，chokidar 触发刷新、探针 `applied` 后 6–7 ms 被 `disposed`，而我们插件的 `apply` 根本没被调用；进程 stdout 归 docker，拿不到报错。同一个 patch 在**干净进程**里 boot 完全正常（`--dump-config` exit 0，隔离实例端到端通过）。⇒ **改完 patch 请重启 DSH**，不要指望 `patchReload: live`。最小 profile 里热重载是生效的（改 `connectTimeoutMs` 后 `apply` 重新执行），所以这是完整 profile 的某个兄弟插件导致的，未定位。
2. **工具重名**：`dsh-playwright-browser` 与内置 `tool-browser` 的 `browser_*` 工具同名，必须二选一（本包 patch 关掉前者）。
3. **不要与 `dsh-builtin-browser` 组合包同时装**（见 §2）。
4. **接缝包的 peer 不在 profile 自己的 `node_modules` 里**：`@deepseek-ai/cordis` 等由 DSH 在 boot 时挂到 `$DSH_HOME/profiles/node_modules/@deepseek-ai/*`（活 home 实测 240 项），profile 内任何包向上查找都能命中。所以「只 `dsh plugin add` 而没有 boot 过」的静止隔离 home 里 import `dsh-builtin-browser/browser` 会报 `Cannot find package '@deepseek-ai/cordis'` —— 不是设计问题。
5. **守护进程的 root 按 `DSH_HOME` 派生**（默认 `$DSH_HOME/browser-service`）。`browsersvc stop/status` 要用同一个 `DSH_HOME`，否则会报 `not running` 而进程还在。
6. 公开端口（默认 9333）**要求 `Authorization: Bearer <token>`**；token 由守护进程生成、写在 0600 的 `service.json` 里，插件自动读取（每次 attach 重读），不要手工在 patch 里配 token。
7. 本方案依赖守护进程的包装脚本与用户态库/字体，卸载包装脚本会退化成白屏/方块。

## 5. 回滚

早期（Playwright provider）方案的 profile patch 备份在 `/home/node/DSH/.browser/cordis.patch.yml.a1-backup`；把 `$DSH_HOME/profiles/web/cordis.patch.yml` 还原成它、`dsh plugin --profile web remove dsh-browser-service`、重启 DSH 即可回到 Playwright provider。
