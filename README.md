# dsh-browser-service

自建浏览器服务：**一个单例 CDP 守护进程**，给 DSH 的 `browser_*` 工具用，同时把同一个内核以"可执行文件"的形态提供给 `dsh-univer-office` 这类只认 `browserExecutablePath` 的插件。

面向**无 root、无 GUI、host 网络**的服务器容器（本机就是这种：Debian 12 / uid 1000 / cgroup 只读 / `/dev/shm` 64M / 无 Xvfb）。

> 状态：**M1 已完成并验收通过**（守护进程 + 回环代理 + 空闲回收 + 崩溃重启）。**M2 已完成并验收通过**（`ctx.browser` provider 接进内置 `browser_*` 工具面，见 §3.3 与 `docs/provider-m2.md`）。

## 1. 它解决什么问题

| 现状问题 | 本项目的做法 |
|---|---|
| DSH 内置 `dsh-builtin-browser` 的 provider 是自托管 Electron：没有 Electron 二进制、没有 GUI 库、seccomp 下 `No usable sandbox!` | 用系统已有的 `chrome-headless-shell`，`--no-sandbox --disable-dev-shm-usage`，库用用户态目录，不需要 root |
| 每个消费方各起一个浏览器（内存重复） | **一个守护进程**，多客户端通过 CDP 连入，会话用隔离 `BrowserContext` 分开 |
| CDP 端口若对外监听 = 把浏览器（含 cookie）交给主机上任意进程 | 内核只绑 `127.0.0.1:<内部随机端口>`，对外只暴露**本机回环代理**（要求 Bearer token，只放行读元数据与 `/devtools`）；代理顺带精确统计连接数 |
| `dsh-univer-office` 只接受"浏览器可执行文件路径"，无法连远端 CDP | 同一个内核外面套一层包装脚本当 `browserExecutablePath`（同一份二进制与库，不共享进程） |

## 2. 架构

```
                    ┌──────────────── 127.0.0.1:<公开端口> ────────────────┐
客户端（DSH provider /                     │                                  │
 playwrigh/puppeteer / curl）──────────────┤  回环 TCP 代理（本进程）          │
                                          │   · 连接计数 → 空闲回收           │
                                          │   · Bearer token 凭据门            │
                                          │   · 路径白名单 / 改写 ws 地址       │
                                          └──────────────┬───────────────────┘
                                                         │ 127.0.0.1:<内部端口>
                                          ┌──────────────▼───────────────────┐
                                          │ chrome-headless-shell / wrapper  │
                                          │  · 只绑回环                       │
                                          │  · 崩溃 → supervisor 重启         │
                                          └──────────────────────────────────┘
```

- 守护进程（`browsersvc run`）负责：spawn 内核 → 等 CDP 就绪 → 起代理 → 写状态文件 → 空闲自杀 / 崩溃重启。
- 状态文件 `$ROOT/service.json`（0600）只有 pid / 端口 / 内核 / 版本，**不含任何凭据**。

## 3. 快速开始

```bash
# 1) 看本机能用哪个内核（会依次看环境变量、常见落点、PATH）
node bin/browsersvc.mjs detect

# 2) 起服务（默认端口 9333，root 默认 $DSH_HOME/browser-service）
node bin/browsersvc.mjs start --port=9333 --idle-ms=900000

# 3) 验证
node bin/browsersvc.mjs status
curl -s 127.0.0.1:9333/json/version

# 4) 停
node bin/browsersvc.mjs stop
```

本机（DSH 容器）实测可用的一行：

```bash
node bin/browsersvc.mjs start \
  --wrapper=/home/node/DSH/.browser/chromium-wrapper.sh \
  --port=9333 --idle-ms=900000
```

`--wrapper` 指向的包装脚本负责注入 `LD_LIBRARY_PATH`（用户态 43 个包）、`FONTCONFIG_FILE`（中文渲染）、并追加 `--no-sandbox --disable-dev-shm-usage`。没有包装脚本时，用 `--kernel=/path/to/chrome-headless-shell` 直接指定内核，但**必须**保证系统库与字体可用（否则截图纯白、中文变方块）。

### 给 `dsh-univer-office` 用

```yaml
- id: univer
  config:
    browserExecutablePath: /home/node/DSH/.browser/chromium-wrapper.sh
```

保持现状即可：univer 用同一份二进制与库，自己起临时实例（它没有 `connectOverCDP` 能力，见 `docs/feasibility.md`）。

### 给 DSH 的 `browser_*` 工具用（M2）

把 M1 的守护进程接进 DSH 的 browser seam：插件只注册 provider，工具面沿用内置 `tool-browser` 的 `browser_*` 工具。

```bash
# 1) 让 profile 能按裸名解析到插件（不动 profile 的 dependencies，避免 reconcileBundles 副作用）
ln -s /home/node/DSH/dsh-browser-service/plugin $DSH_HOME/profiles/web/node_modules/dsh-browser-cdp
# 2) 让插件解析到 playwright-core（用 profile 里已装的那份，不重复下载浏览器）
ln -s $DSH_HOME/profiles/web/node_modules/playwright-core  node_modules/playwright-core
# 3) 把 docs/profile-patch.browser-cdp.yml 追加到 $DSH_HOME/profiles/web/cordis.patch.yml 尾部，重启 DSH
```

patch 做四件事：注册 `dsh-browser-cdp`（带 `autoStartCommand`，首次用浏览器时自动拉起守护进程）、seam 选 `cdp-daemon`、关掉内置 `browser-electron`、关掉 `dsh-playwright-browser`（它自带 10 个与内置**同名**的 `browser_*` 工具，两个 provider 的工具面不能共存）。

> ⚠️ 改完 patch **必须重启 DSH**：运行中的完整 web profile 上，`patchReload: live` 会静默回滚（进程 stdout 归 docker，看不到报错）。干净进程里 boot 完全正常。

## 4. CLI

| 命令 | 说明 |
|---|---|
| `detect` | 打印候选内核与已解析配置 |
| `start` | 后台拉起守护进程并等到 CDP 就绪（已运行且健康则直接返回） |
| `stop` | 先停 supervisor，再兜底清理浏览器进程与状态文件 |
| `status` | 打印状态；**健康退出码 0，未运行 1**（便于脚本判断） |
| `restart` | stop + start |
| `run` | 前台运行（`start` 内部用它做后台进程） |
| `logs [--lines=60]` | 打印日志尾部 |

参数：`--root` `--port`（0 = 自动择取）`--idle-ms` `--kernel` `--wrapper` `--user-data-dir` `--max-restarts`，对应环境变量 `DSH_BROWSER_SVC_ROOT` / `DSH_BROWSER_SVC_PORT` / `DSH_BROWSER_SVC_IDLE_MS` / `DSH_BROWSER_CHROME` / `DSH_BROWSER_WRAPPER`，也可写进 `$ROOT/config.json`。优先级：**CLI > 环境变量 > config.json > 自动探测**。

## 5. 验收（零依赖，不依赖外网）

```bash
node scripts/verify-daemon.mjs      # M1 守护进程：31/31
node scripts/verify-provider.mjs    # M2 provider：86 通过，0 失败
node scripts/verify-bundle.mjs      # 组合包安装（官方 dsh plugin 流程）：16/16
```

`verify-bundle.mjs` 在一次性隔离 `DSH_HOME`（`/tmp`）里真实执行官方安装/移除命令，并断言组合层顺序规则：`add <tgz>` 追加依赖与层 → seam 包缺席时 `patch: entry "browser" not found` → 正确顺序（seam → 本包）三条 patch 行全部生效（`browserProvider: cdp-daemon`、`browser-electron: disabled`）→ 装反顺序只警告、覆盖行被静默丢弃 → `remove` 同时清掉依赖与层。不碰默认 profile。

`verify-provider.mjs` 自己起本地站点 + 真实 `browsersvc run`（临时 root/端口），逐项覆盖 session/tab 生命周期、`navigate` 拒非 http(s)、`execute`（表达式/参数/页面异常/超时）、`snapshot`/`a11y`/`content`（4 种格式）/`scrape`（含 `@attr`）、`waitFor` 三态、`click`/`type`/`setValue`/`check`/`getValue`/`clearField`/`selectOption`/`scroll`/`key`、`fillForm`、`screenshot`（含等比缩小/fullPage-jpeg）、`download`、`back`/`forward`/`reload`、`history`/`replay`、`detectChallenge`、`flushAuth`/`restoreAuth`、session 隔离、`reset`/`close`。

`verify-daemon.mjs` 只用 Node 内置能力（`fetch` / `WebSocket` / `http`），自己起本地源，逐项检查：

```
PASS  守护进程启动  — 公开端口 34301 → 内部端口 9301
PASS  状态文件含 token 且不对外开放  — mode=600
PASS  无 token 访问公开端口被拒 (401)  — status=401
PASS  白名单外的路径被拒 (403)  — status=403
PASS  CDP /json/version  — Browser=HeadlessChrome/154.0.8037.57
PASS  元数据 ws 地址被改写为走代理并带 token
PASS  公开端口只绑 127.0.0.1  — 监听=0100007F(tcp)
PASS  内部端口只绑 127.0.0.1  — 监听=0100007F(tcp)
PASS  两个隔离上下文（不同 browserContextId）
PASS  上下文 A 能写 cookie
PASS  上下文 B 看不到 A 的 cookie（隔离生效）
PASS  页面真实渲染  — title="iso"
PASS  浏览器被杀后自动重启  — browserPid 5381 → 5454
PASS  重启后代理仍可用（自动改指向）
PASS  空闲后自动退出  — exitCode=0
PASS  退出后清理状态文件
PASS  退出后端口释放
PASS  越界 --port 被配置校验拒绝 (exit 2)
PASS  --lines=0 被拒 (exit 2)
PASS  内核不存在时启动失败且不留状态文件  — code=2
PASS  内核不可执行时启动失败且不留状态文件  — code=2
PASS  内核未就绪时启动失败（不静默成功）  — code=2
PASS  启动失败后不留孤儿内核  — kernelPid=5559 alive=false
PASS  启动失败后不留状态文件
PASS  stop 身份校验：拒绝杀不匹配的进程  — code=1
PASS  stop --force 可强制清理  — code=0
PASS  restart 前置：隔离实例可启动  — code=0
PASS  restart 真的停旧起新（F23）  — code=0
PASS  restart 后 token 换新  — e033d630 → 8efe1748
PASS  restart 后的实例可正常 stop  — code=0

31/31 通过
```

## 6. 安全约束（不要动）

1. **只绑回环**：本机是 host 网络，`0.0.0.0` 上的 CDP 端口等于把浏览器完全交给主机上任意进程。内核永远带 `--remote-debugging-address=127.0.0.1`，对外只走回环代理；验收脚本会解析 `/proc/net/tcp` 检查这一点。
2. **`--no-sandbox` 是必需的**（容器 `NoNewPrivs=1` + seccomp 下 Chromium 沙箱起不来），因此**只访问可信站点**；需要更强隔离时把浏览器放进独立容器。
3. **`--disable-dev-shm-usage` 必需**（`/dev/shm` 只有 64M）。
4. 会话隔离必须用 incognito `BrowserContext`，不要复用默认上下文。
5. **公开端口要求凭据**：`Authorization: Bearer <token>`（每次守护进程启动随机生成，落在 0600 的 `service.json`）。代理只放行读元数据（`GET /json/version|/json/list|/json/protocol`）与 `/devtools/*`，挡掉 `/json/new|close|activate` 这类控制接口；`/json/version` 里的 `webSocketDebuggerUrl` 会被改写成代理自己的地址并附上 token，所以调用方（provider）不需要额外配置，也绕不开代理。内部内核端口仍只绑回环。
6. **保存路径准入**：`browser_screenshot` / `browser_download` 的 `savePath` 必须是绝对路径、不得覆盖已有文件；配了 `downloadDir` 时还必须落在该目录内（与内置 browser provider 同语义）。
7. 状态文件 0600、日志 0600，日志不记录页面内容。

## 7. 路线图

| 里程碑 | 内容 | 状态 |
|---|---|---|
| **M1** | 守护进程 + 回环代理 + 空闲回收 + 崩溃重启 + 31 项验收 | ✅ 完成 |
| **M2** | DSH provider 插件（`inject=['browser']` + `ctx.browser.registerBrowserProvider`），复用内置 `tool-browser` 的 33 个 `browser_*` 工具；同时 `disabled: true` 掉 `browser-electron` 与 `dsh-playwright-browser` | ✅ 完成（86 项 + DSH 内端到端，见 `docs/provider-m2.md`） |
| **M6** | 代码审查 18 条缺陷修复：公开端口凭据门、启动失败不留孤儿、stop 身份校验、保存路径准入、并发握手/连接计数、代理对截断…（见 §9–§12） | ✅ 完成（v0.3.0 / v0.3.1 / v0.3.2 / v0.3.3） |
| **M3** | univer 侧接线（保持包装脚本形态） | 已有可行做法 |
| **M4** | 面向"任何插件"的通用 HTTP 面：`/fetch` `/screenshot` `/eval` | 待做 |
| **M5** | CDP-over-pipe 代理，让 univer 也复用守护进程（进阶，未验证） | 待做 |

设计与可行性分析见 `docs/feasibility.md`。

## 8. 打包与分发

两个包都是纯 ESM、零构建，`pnpm pack` 即可分发——这是 DSH 官方文档《打包与安装插件》推荐的 tarball 交付形式：用户拿到 `.tgz` 直接 `dsh plugin add` 安装，**既不用发 npm、也不需要在 profile 里给构建脚本授权**（从 GitHub 装拉的是源码，才需要 `prepare` + `allowBuilds`）。`npm pack` 等价，npm 缓存不可写时加 `npm_config_cache=/tmp/npm-cache`：

```bash
chmod 755 bin/browsersvc.mjs                          # bin 必须可执行（POSIX 下 npm 全局 shim 是指向它的符号链接）
pnpm pack --pack-destination dist                     # dsh-browser-service-<v>.tgz：守护进程 CLI + 插件源码 + tools + docs + 验收脚本
(cd plugin && pnpm pack --pack-destination ../dist)   # dsh-browser-cdp-<v>.tgz：**可安装的 DSH 组合包（bundle）**
```

- **两个交付物角色不同，别装错**：
  - `dsh-browser-cdp-<v>.tgz`（7 项 / 约 24 KB）是**组合包**：`package.json` 里声明 `"dsh": {"bundle": {"patch": "./cordis.patch.yml"}}`，用 `dsh plugin --profile <name> add ./dsh-browser-cdp-<v>.tgz` 安装（GitHub Release 也挂了同样两个 tarball，可以直接给资产 URL 安装，实测可用），装完由 DSH 组合自动插入 provider、把 seam 切到 `cdp-daemon`、关掉 `browser-electron`。**前置条件**：`dsh-builtin-browser` 必须先装（`browser`/`browser-electron`/`tool-browser` 三行由它插入，本包按 id 覆盖它们），且 `dsh plugin` 只在 `dsh.profile.bundles` 里**按列表顺序**叠加、后层按行胜出。顺序反了不报错，只打印 `patch: entry "browser" not found` 并静默丢掉覆盖行（等于没生效）——安装/恢复命令、`--dump-config` 校验期望、以及「手写 patch 与 bundle 不要同时用」都写在 `plugin/README.md`。
  - `dsh-browser-service-<v>.tgz`（22 项 / 约 69 KB）是**守护进程工具包**，没有 `dsh.bundle`（`private: true`，按官方说明装进 profile 只会当普通依赖、不激活任何层）：解包后直接 `node bin/browsersvc.mjs start`，或 `npm i -g` 取 CLI。
  - `files` 都不含 `node_modules`；插件的运行时依赖（`playwright-core` 只做 CDP 客户端、**不下载浏览器**，以及 `@deepseek-ai/schemastery`）由 profile 的 pnpm 解析——实测两者都解析到 profile 里已有的那一份，不会重复副本。
- 官方文档提到的 `dsh.engines` / `dsh.compatibility` 元数据本包**没写**：宿主只认 `dsh.bundle`（`@deepseek-ai/dsh-package-manifest` 的 `DshManifest` 里没有这两个字段），它们只被插件市场的发现逻辑读取，宿主既不读也不校验。
- 验收：`node scripts/verify-bundle.mjs` —— 在一次性隔离 `DSH_HOME` 里真实执行 `add` → `--dump-config` → 顺序反例 → `remove`，断言层已追加、三条 patch 行生效、装反会警告、`remove` 同时清掉依赖与层；不碰默认 profile。
- `dist/` 已 gitignore；每个版本另在 GitHub Release 挂上这两个 tarball（可从 Release 页直接下载或按 URL 安装）。`publishConfig.access=public`，需要时也可 `pnpm publish` 发 npm。

## 9. v0.3.0 变更（代码审查 18 条缺陷修复）

独立代码审查（隔离脚本 + 复核）逐条复现后修复，按严重度：

| # | 缺陷 | 复现/影响 | 修复 |
| --- | --- | --- | --- |
| F1 | `savePath` 无准入门（严重） | 任意绝对路径写入、`../` 逃逸并自动建目录、静默覆盖已有文件 | provider 加 `#admitSavePath`（镜像内置语义：绝对路径 / `downloadDir` 内 / 不覆盖），截图与下载都走它 |
| F2 | 启动失败泄漏内核（严重） | `EADDRINUSE` 后孤儿 chromium 存活、无状态文件可回收 | 启动主流程包 `try/catch` → `shutdown('startup-failed')`；`spawn` error 钩子；未就绪先杀内核再抛 |
| F3 | `stop` 无身份校验（严重） | pid 复用/陈旧状态文件时可向陌生进程发 SIGKILL | `stop` 先读 `/proc/<pid>/cmdline` 校验（supervisor 含 `browsersvc.mjs`、内核含 `--remote-debugging-port=<内部端口>`），不匹配则拒绝并保留状态文件，`--force` 才强杀 |
| F4 | 内核不可执行时行为不明 | 崩栈/静默 | `assertKernelExecutable`（存在 + 普通文件 + `X_OK`），在 spawn 之前 |
| F5 | 连接计数被半关连接卡住 | 上游 `allowHalfOpen` 时 `connections` 恒 ≥1 ⇒ 空闲回收永不触发 | 计数改由首次认证通过时 +1、任一侧 close/error 一次性释放（幂等）+ 5s 兜底强拆 |
| F6 | 并发 `open` 重复握手 | 旧连接被覆盖后不再关闭；旧连接迟到的 `disconnected` 会清掉新连接 | `#connecting` 单飞 + `#conns` 集合，`disconnected` 只清自己那条，`dispose` 关闭全部 |
| F7 | 公开端口无凭据、无路径白名单（中等） | 同机任意进程可完全操控浏览器、读 cookie | Bearer token 门 + 方法/路径白名单（`/json/new|close|activate` 一律 403）+ 改写 `webSocketDebuggerUrl` 走代理 |
| F8 | `#terminate` 泄漏 CDPSession | 每次卡死重建标签页都漏一个 session | `.finally(() => cdp.detach())` |
| F9 | 数值配置无校验 | `--port=99999` / 负数 / 非整数静默生效 | `src/config.mjs` 的 `LIMITS` + `num(v, key)`，越界即报错并回 JSON+exit 2 |
| F10 | `start` 成功判据不严 | 陈旧状态文件可被误报为「已启动」 | 判据同时要求 `listening === true && supervisorPid === child.pid && port` |
| F11 | `logs --lines` 未校验 | `--lines=0`/负数行为未定义 | 必须正整数，否则 JSON 报错 + exit 2 |
| F12 | 打包保留本机 umask 权限 | 仓库里是 100644，打出的 tgz 里出现 0600（`bin/browsersvc.mjs` 还会因为不可执行而让 POSIX 下的全局 shim 失效） | 打包前 `chmod -R u+rwX,go+rX`，并把 `bin/browsersvc.mjs` 置为 100755 |
| F13 | `content` 截断切开代理对 | `maxChars` 落在 emoji 中间时输出半个字符 | 截断点回退一个 UTF-16 单位（不在高代理处切） |
| F14 | `open()` 失败泄漏 BrowserContext | `newPage()` 抛错时上下文不关 | 失败路径 `await context.close()` |
| F15 | `autoStartCommand` 超时不可配 / 经 shell | 超时写死，命令经 shell 解释 | `autoStartTimeoutMs`（默认 60s）+ `shell: false` |
| F16 | 日志文件随 umask | 可能 0644 | `openSync(logFile,'a',0o600)`；`ensureRoot` 对已存在目录/日志显式 `chmod` |
| F17 | CLI 未透传 `--start-timeout` / `--internal-port-base` | 只能靠环境变量 | `toCfg` 补两个参数 |
| F18 | 验收脚本失败时留进程/临时目录 | 中断即留残余 | `process.on('exit')` 清理（内核 + 所有临时 root） |

同批新增/加强的验收断言（`verify-daemon.mjs` 13 → **26**（v0.3.1 起 **31**），`verify-provider.mjs` 67 → **77**（v0.3.2 起 **86**））：401/403 凭据门、ws 地址改写、状态文件权限、越界 `--port`、`--lines=0`、内核不存在/不可执行/未就绪三种启动失败 + 不留孤儿与状态文件、`stop` 身份校验与 `--force`、错误 token 无法 attach、`savePath` 准入 6 项、4 路并发 attach、代理对截断。

## 10. v0.3.1 变更（上线验证发现的 5 条缺陷）

v0.3.0 装进运行实例后按「重启 → 真实调用浏览器」验证，又暴露出 4 条只有活实例才能撞到的缺陷，以及 1 条验收脚本自身的残留：

| # | 缺陷 | 复现/影响 | 修复 |
| --- | --- | --- | --- |
| F19 | provider 自启后重试不带新 token | 冷启动（状态文件里还没有 token）时第一次 `connectOverCDP` 失败 → `autoStartCommand` 拉起守护进程并写入新 token → 重试仍用**旧**（空）token ⇒ 必 401，浏览器冷启动后第一次调用不可用 | token 读取移进每次 `connectOverCDP` 尝试内部（`#attach` 的 `attach()` 闭包），每次重试重读状态文件 |
| F20 | 请求头超时定时器未撤，10s 后拆掉长连接 | 连接建立 10s 后 `proxy: 408 request headers timeout` → `settle()` → `destroyBoth()`，CDP WebSocket 长连接被误杀；表现为「会话内没有可用标签页」、`/json/list` 只剩 about:blank | 请求头解析成功后立刻 `clearTimeout(headTimer)` |
| F22 | 连接被换掉后会话永久失效 | 守护进程重启 / F20 拆线 / 内核崩溃后，旧 context/page 随旧连接失效，而内置工具层按 task **永久缓存** session id 且从不重开（`ensureSession`）⇒ 之后每一次 `browser_*` 调用都报「会话内没有可用标签页」，直到人工 `browser_reset_session` 或重启 DSH | 所有会话操作前先走 `#liveSession(id)`：连接不是同一条、或当前标签页已死时，在新连接上按原 session id 重建 context+page（审计历史 `history` 保留） |
| F23 | `browsersvc restart` 变成「只停不起」 | `print()` 内部 `process.exit()`，`restart` 里 `await stop(...)` 打完 JSON 就退出，`start` 永不执行：实例被停掉却报 `stopped: true` 收场 | `start`/`stop` 增 `quiet` 模式（返回结果而不打印/退出，成功后**立即返回**而不是继续轮询到超时），`restart` 用 quiet 跑两步再统一输出 `{restarted, stopped, started}` |
| F24 | 验收脚本 restart 后收不干净 | `verify-provider.mjs` 的 `shutdown()` 只杀自己 spawn 的子进程，F22 用例重启出来的实例不是它 ⇒ 残留守护进程占着端口（下次运行 `EADDRINUSE`）+ 残留内核 | `shutdown()` 末尾再走一次 CLI `stop --root=<root>`（带 F3 身份校验），覆盖重启出来的实例 |

对应新增验收：`verify-provider.mjs` 77 → **83**（守护进程 restart 真的停旧起新、token 换新、重启后同一个 session id 仍可 execute/导航、连接重建后会话复活），`verify-daemon.mjs` 26 → **31**（隔离 root 真实跑 `start → restart → stop`、restart 后 token 换新、restart 后的实例可正常 stop）。

## 11. v0.3.2 变更（F25：自启开关不会复位）

v0.3.1 上线后按「停掉守护进程 → 再调用浏览器」验证，发现最后一条只会在运行进程里暴露的缺陷：

| # | 缺陷 | 复现/影响 | 修复 |
| --- | --- | --- | --- |
| F25 | 自启「每进程只允许一次」的开关连上之后不复位 | 守护进程消失（按 `idleMs` 空闲自杀、崩溃、被 OOM 杀、手动 `browsersvc stop`）而 DSH 还活着时，provider 直接报 `browser: 无法连接 CDP 端点 http://127.0.0.1:9333（… ECONNREFUSED …）；请先运行 browsersvc start`，**再也不自启** ⇒ 浏览器一直不可用，直到重启 DSH | 连接成功后把 `#autoStarted` 复位。防风暴不受影响：同一轮失败仍只自启一次（自启后仍连不上就保持锁定，不会反复拉起） |

对应新增验收：`verify-provider.mjs` 83 → **86**（冷启动自启一次后连上、守护进程消失后能再次自启、自启仍失败时不反复拉起）。三条断言都先在修复前跑过并确认会失败（旧代码 `autoStart` 只被调用 1 次）。

## 12. v0.3.3 变更（按官方插件文档核对打包与安装）

v0.3.2 上线后，按 DSH 官方《打包与安装插件》（官方仓库 `deepseek-ai/deepseek-harness` 的 `docs/user/develop/basic/publish.zh.md`）逐条核对本包的打包/安装路径，修掉 4 处不符合、未文档化或写错的地方，并补上一条真正跑官方安装流程的验收：

| # | 项 | 影响 | 处理 |
| --- | --- | --- | --- |
| B1 | 文档里的安装命令语法错误 | `dsh plugin add <pkg>` 少了必需的 `--profile`（`dsh plugin --help` 里 `--profile <name>` 是 required）⇒ 照抄必然失败 | 改为官方形式 `dsh plugin --profile <name> add <包名\|tarball>`，并写明 tarball 是官方推荐的「免构建授权」交付形式 |
| B2 | 组合包的**安装顺序**是硬要求，但此前只写在内部分析里 | `browser`/`browser-electron`/`tool-browser` 三行由第三方组合包 `dsh-builtin-browser` 插入，本包 patch 的第 2/3 条按 id 覆盖它们；本包的层若排在 seam 包之前，loader 只打印 `patch: entry "browser" not found` 并静默丢弃覆盖行 ⇒ seam 仍选内置 Electron provider（「装上了但没生效」，没有任何报错） | `plugin/cordis.patch.yml` 头注释与 `plugin/README.md` 写清前提、先 seam 后本包的两条命令、`--dump-config` 校验期望、装反的恢复步骤；并说明为何不把 seam 写进本包依赖（`reconcileBundles` 只看 profile 自己声明的依赖，间接依赖不会进 `dsh.profile.bundles`） |
| B3 | `@deepseek-ai/cordis` 声明为可选 peer，但从未使用 | 官方 peer 规则是「需要与宿主共享实例」才声明；本插件零 import cordis，loader 也不校验范围 ⇒ 纯噪声 | 删除 `peerDependencies` / `peerDependenciesMeta` |
| B4 | 工具数一度被改回 32（**本轮的自我回归**） | 数工具的命令 `grep -o "name: 'browser_[a-z_]*'"` 的字符类漏了数字，`browser_a11y` 被静默漏掉 ⇒ 32；照这个数改文档，就把上一轮 `dd45fca` 的正确修正又翻了回去 | 以**运行期**实测为准：用 stub `ctx` 跑 `tool-browser` 的 `apply()`，`ctx.tools.register` 收到 **33** 个 `browser_*` 工具（含 `browser_a11y`）；README §7、`plugin/README.md`(×2)、`docs/feasibility.md`(×4) 统一为 33，并在此记下这个陷阱 |

对应新增验收：`scripts/verify-bundle.mjs`（**16 项**）—— 一次性隔离 `DSH_HOME` 里跑官方流程：`add <tgz>` 追加依赖与层 → seam 缺席时确实报 not found → 正确顺序（seam → 本包）三条 patch 行全部生效 → 装反顺序只警告不报错且 seam 不被切走 → `remove` 同时清掉依赖与层。三套验收合计 31 + 86 + 16。

打包命令同时改为官方推荐的 `pnpm pack`（见 §8）；交付物分工与 `dsh.engines` / `dsh.compatibility` 的取舍也记在那里。

## 13. 许可

MIT
