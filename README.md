# dsh-browser-service

自建浏览器服务：**一个单例 CDP 守护进程**，给 DSH 的 `browser_*` 工具用，同时把同一个内核以"可执行文件"的形态提供给 `dsh-univer-office` 这类只认 `browserExecutablePath` 的插件。

面向**无 root、无 GUI、host 网络**的服务器容器（本机就是这种：Debian 12 / uid 1000 / cgroup 只读 / `/dev/shm` 64M / 无 Xvfb）。

> 状态：**M1 已完成并验收通过**（守护进程 + 回环代理 + 空闲回收 + 崩溃重启）。**M2 已完成并验收通过**（`ctx.browser` provider 接进内置 `browser_*` 工具面，见 §3 与 `docs/provider-m2.md`）。
>
> **v0.4.0 起只有一个交付物**：`dsh-browser-service` 这一个包既是 DSH 组合包（bundle），也是守护进程 CLI 与 provider——`dsh plugin --profile <name> add <本包>` **一次装完就能用**（接缝 `browser`、33 个 `browser_*` 工具、`cdp-daemon` provider 都由它挂出），不再需要先装第三方接缝包 `dsh-builtin-browser`。

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
- 状态文件 `$ROOT/service.json`（0600）：pid / 端口 / 内核 / 版本 / 本次启动的访问 token（同 uid 可读，故 0600）。

## 3. 快速开始

### 3.1 起守护进程

```bash
# 1) 看本机能用哪个内核（会依次看环境变量、常见落点、PATH）
node bin/browsersvc.mjs detect

# 2) 起服务（默认端口 9333，root 默认 $DSH_HOME/browser-service）
node bin/browsersvc.mjs start --port=9333 --idle-ms=900000

# 3) 验证
node bin/browsersvc.mjs status
TOKEN=$(node -p 'JSON.parse(require("fs").readFileSync(process.env.DSH_HOME+"/browser-service/service.json","utf8")).token')
curl -s -H "Authorization: Bearer $TOKEN" 127.0.0.1:9333/json/version

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

### 3.2 给 `dsh-univer-office` 用

```yaml
- id: univer
  config:
    browserExecutablePath: /home/node/DSH/.browser/chromium-wrapper.sh
```

保持现状即可：univer 用同一份二进制与库，自己起临时实例（它没有 `connectOverCDP` 能力，见 `docs/feasibility.md`）。

### 3.3 给 DSH 的 `browser_*` 工具用（M2）

**一条命令装完**（`--profile` 换成目标 profile；从 [Releases](https://github.com/lyp88997/dsh-browser-service/releases) 下载或直接用下面的 URL）：

```bash
dsh plugin --profile web add https://github.com/lyp88997/dsh-browser-service/releases/download/v0.4.0/dsh-browser-service-0.4.0.tgz
# 然后重启 DSH；校验（应出现 browserProvider: cdp-daemon 与本包层，且本包三行没有 not found）：
#   dsh --profile web --dump-config | grep -E 'browserProvider|# == dsh-browser-service|not found'
```

- **只装这一个包**：接缝 `browser`、33 个 `browser_*` 工具（`id: tool-browser`）与 `cdp-daemon` provider 都由本包挂出。工具面与接缝来自本包的依赖 `dsh-builtin-browser`，经本包的 `./browser` / `./tool-browser` 转出口暴露（`plugin/shims/`）——所以**不要再单独装 `dsh-builtin-browser`**：它若同时是组合包，`browser`/`tool-browser` 两个 id 会被插两次、33 个工具重名挂两遍。已经装过就先 `dsh plugin --profile <name> remove dsh-builtin-browser`。
- **可以重复执行**：装过的包 pnpm 直接跳过，`dsh.profile.bundles` 不会出现重复层。
- **不需要配置 `autoStartCommand`**：端点不通时插件默认用**本包自带的** `bin/browsersvc.mjs start` 拉起一次（`plugin/lib/provider.js` 的 `defaultAutoStartCommand()`）。想换端口/内核，再在 profile 的 `cordis.patch.yml` 里覆盖（patch 是**整行替换** `config`，要重述 `cdpUrl`）：

```yaml
- id: browser-cdp
  config:
    cdpUrl: http://127.0.0.1:9333
    autoStartCommand: node /home/you/dsh-browser-service/bin/browsersvc.mjs start --port=9333
```

- **不能写裸包名 `dsh-browser-cdp`**（v0.4.0 之前子包的名字）：npm 上的 `dsh-browser-cdp` 是别人的同名包（0.17.4）。本包统一叫 `dsh-browser-service`，当前用 tarball / Release 资产 URL 安装（npm 上这个名字还空着，见 §8）。
- 组合自动做四件事：插入接缝 `browser`（选 `cdp-daemon`）、插入 `tool-browser`、插入 `browser-cdp` provider、关掉内置 `browser-electron` 与 `dsh-playwright-browser`（后者自带 10 个与内置**同名**的 `browser_*` 工具，两个 provider 的工具面不能共存）。后两个 id 在本包单独安装的环境里不存在，loader 只打印一条 not found 提示，不影响组合。
- `browsersvc` 默认空闲 15 分钟自杀（`--idle-ms`，上限 24 小时）；DSH 侧仍在的话，下次调用浏览器会自动把它拉回来（F25）。

> ⚠️ 改完**必须重启 DSH**（插件在 boot 时 import，热重载不可靠）：运行中的完整 web profile 上 `patchReload: live` 会静默回滚（进程 stdout 归 docker，看不到报错），干净进程里 boot 完全正常。
>
> 旧的「symlink 进 profile + 手写 `cordis.patch.yml`」只适合改源码时的临时接线（写法见 `docs/provider-m2.md`），**不要与 bundle 路线同时用**（`insert` 行会重复）。

## 4. CLI

| 命令 | 说明 |
|---|---|
| `detect` | 打印候选内核与已解析配置 |
| `start` | 后台拉起守护进程并等到 CDP 就绪（已运行且健康则直接返回） |
| `stop` | 先停 supervisor，再兜底清理浏览器进程与状态文件（动手前校验 pid 身份，`--force` 跳过） |
| `status` | 打印状态；**健康退出码 0，未运行 1**（便于脚本判断） |
| `restart` | stop + start |
| `run` | 前台运行（`start` 内部用它做后台进程） |
| `logs [--lines=60]` | 打印日志尾部 |

参数：`--root` `--port`（0 = 自动择取）`--idle-ms` `--kernel` `--wrapper` `--user-data-dir` `--max-restarts` `--start-timeout` `--internal-port-base`，对应环境变量 `DSH_BROWSER_SVC_ROOT` / `DSH_BROWSER_SVC_PORT` / `DSH_BROWSER_SVC_IDLE_MS` / `DSH_BROWSER_CHROME` / `DSH_BROWSER_WRAPPER`，也可写进 `$ROOT/config.json`。优先级：**CLI > 环境变量 > config.json > 自动探测**。

## 5. 验收（零依赖，不依赖外网）

```bash
node scripts/verify-daemon.mjs      # M1 守护进程 + CLI 防御：32/32
node scripts/verify-provider.mjs    # M2 provider：88 通过，0 失败
node scripts/verify-bundle.mjs      # 组合包安装（官方 dsh plugin 流程）：23/23
```

`verify-bundle.mjs` 在一次性隔离 `DSH_HOME`（`/tmp`）里真实执行官方安装/移除命令：交付物里只有一个包 → `add <tgz>` 追加依赖与层 → `--dump-config` 里本包层挂出 `browser`（`browserProvider: cdp-daemon`）、`tool-browser` 与 `browser-cdp`，且**三行都没有 not found** → 默认自启命令指向装进来的 `bin/browsersvc.mjs` → `./browser` / `./tool-browser` 转出口的导出键与 `dsh-builtin-browser` 源模块**完全一致** → `remove` 同时清掉依赖与层。不碰默认 profile。

`verify-provider.mjs` 自己起本地站点 + 真实 `browsersvc run`（临时 root/端口），逐项覆盖 session/tab 生命周期、`navigate` 拒非 http(s)、`execute`（表达式/参数/页面异常/超时）、`snapshot`/`a11y`/`content`（4 种格式）/`scrape`（含 `@attr`）、`waitFor` 三态、`click`/`type`/`setValue`/`check`/`getValue`/`clearField`/`selectOption`/`scroll`/`key`、`fillForm`、`screenshot`（含等比缩小/fullPage-jpeg）、`download`、`back`/`forward`/`reload`、`history`/`replay`、`detectChallenge`、`flushAuth`/`restoreAuth`、session 隔离、`reset`/`close`、连接被换掉后会话复活（F22）、自启开关复位（F25）、保存路径准入、代理对截断。

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
PASS  --internal-port-base 覆盖默认 9300  — internalPort=19700
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

32/32 通过
```

另有一条**真实的 DSH 内端到端**证明（不属于自动验收，手动跑）：在隔离 `DSH_HOME` 里建一个 web 模板 profile → `dsh plugin add` 本包 → 重启该实例，`tools/seam-probe` 会通过 `ctx.browser` 跑完 open → openUrl → snapshot → content → execute → a11y → listTabs → close，日志落在 `/tmp/m2-seam-probe.log`：

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
| **M1** | 守护进程 + 回环代理 + 空闲回收 + 崩溃重启 + 32 项验收 | ✅ 完成 |
| **M2** | DSH provider 插件（`inject=['browser']` + `ctx.browser.registerBrowserProvider`），复用接缝包的 33 个 `browser_*` 工具；同时 `disabled: true` 掉 `browser-electron` 与 `dsh-playwright-browser` | ✅ 完成（88 项 + DSH 内端到端，见 `docs/provider-m2.md`） |
| **M6** | 代码审查 18 条缺陷修复：公开端口凭据门、启动失败不留孤儿、stop 身份校验、保存路径准入、并发握手/连接计数、代理对截断…（见 §9–§12） | ✅ 完成（v0.3.0 → v0.3.3） |
| **M7** | 「一个包装完」：把工具包与插件子包合成单一交付物 `dsh-browser-service`，接缝与工具面由依赖 `dsh-builtin-browser` 转出 | ✅ 完成（v0.4.0，见 §13） |
| **M3** | univer 侧接线（保持包装脚本形态） | 已有可行做法 |
| **M4** | 面向"任何插件"的通用 HTTP 面：`/fetch` `/screenshot` `/eval` | 待做 |
| **M5** | CDP-over-pipe 代理，让 univer 也复用守护进程（进阶，未验证） | 待做 |

设计与可行性分析见 `docs/feasibility.md`。

## 8. 打包与分发

**一个包、零构建**（纯 ESM），`pnpm pack` 即可分发——这是 DSH 官方文档《打包与安装插件》推荐的 tarball 交付形式：用户拿到 `.tgz` 直接 `dsh plugin add` 安装，**既不用发 npm、也不需要在 profile 里给构建脚本授权**（从 GitHub 装拉的是源码，才需要 `prepare` + `allowBuilds`）。`npm pack` 等价，npm 缓存不可写时加 `npm_config_cache=/tmp/npm-cache`：

```bash
chmod 755 bin/browsersvc.mjs                          # bin 必须可执行（POSIX 下 npm 全局 shim 是指向它的符号链接）
chmod -R u+rwX,go+rX .                                # 交付物里的文件权限由本机 umask 决定，打包前统一（F12）
pnpm pack --pack-destination dist                     # dsh-browser-service-<v>.tgz：唯一交付物
```

- **单一交付物**：根 `package.json` 里声明 `"dsh": {"bundle": {"patch": "./plugin/cordis.patch.yml"}}`，同一个包同时提供 `bin/browsersvc.mjs`（守护进程 CLI）、`plugin/lib/*`（provider）与 `plugin/shims/*`（接缝/工具面转出口）。安装就是 `dsh plugin --profile <name> add ./dsh-browser-service-<v>.tgz`，或者给 Release 资产 URL。装完这一个包，`--dump-config` 里就出现 `# == dsh-browser-service` 层、`browser`（`browserProvider: cdp-daemon`）、`tool-browser`、`browser-cdp` 四行。
- 依赖：`dsh-builtin-browser`（提供 seam 与 33 个工具，转出后面向 profile 生效）、`playwright-core`（只做 CDP 客户端，**不下载浏览器**）、`@deepseek-ai/schemastery`（配置 schema）。它们由 profile 的 pnpm 解析；接缝包需要的宿主 peer（`@deepseek-ai/cordis` / `dsh-tools` / `dsh-llm` …）由 DSH 在 boot 时建立的 `$DSH_HOME/profiles/node_modules/@deepseek-ai/*`（240 个入口）提供——profile 内任何包向上查找都能命中，所以不需要把它们写进本包依赖。
- 每个版本在 GitHub Release 挂两份资产：**不带版本号**的 `dsh-browser-service.tgz`（供 `releases/latest/download/dsh-browser-service.tgz` 这类**永不过期**的固定地址引用——插件市场条目就用它）与带版本号的 `dsh-browser-service-<v>.tgz`（文档里建议钉版本用）。
- `dist/` 已 gitignore。**没有走 npm**：本包历史名字 `dsh-browser-cdp` 已被同名第三方包占用（drscrewdriver 的 `dsh-browser-cdp`，0.17.4）；`dsh-browser-service` 这个名字在 npm 上还空着，要发的话登录后 `pnpm publish` 即可（届时 `dsh plugin add dsh-browser-service` 这种裸包名形式才成立）。
- 官方文档提到的 `dsh.engines` / `dsh.compatibility` 元数据本包**没写**：宿主只认 `dsh.bundle`（`@deepseek-ai/dsh-package-manifest` 的 `DshManifest` 里没有这两个字段），它们只被插件市场的发现逻辑读取，宿主既不读也不校验。
- 验收：`node scripts/verify-bundle.mjs` —— 一次性隔离 `DSH_HOME` 里跑官方 `add` → `--dump-config` → 转出口形状比对 → `remove`，不碰默认 profile。

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

同批新增/加强的验收断言（`verify-daemon.mjs` 13 → **26**，`verify-provider.mjs` 67 → **77**）：401/403 凭据门、ws 地址改写、状态文件权限、越界 `--port`、`--lines=0`、内核不存在/不可执行/未就绪三种启动失败 + 不留孤儿与状态文件、`stop` 身份校验与 `--force`、错误 token 无法 attach、`savePath` 准入 6 项、4 路并发 attach、代理对截断。

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
| B2 | 组合包的**安装顺序**是硬要求，但此前只写在内部分析里 | `browser`/`browser-electron`/`tool-browser` 三行由第三方组合包 `dsh-builtin-browser` 插入，当时的插件子包 patch 第 2/3 条按 id 覆盖它们；子包的层若排在 seam 包之前，loader 只打印 `patch: entry "browser" not found` 并静默丢弃覆盖行 ⇒ seam 仍选内置 Electron provider（「装上了但没生效」，没有任何报错） | patch 头注释与安装文档写清前提与校验期望；v0.4.0 起改为**本包自己插入这三行**（见 §13），顺序问题随之消失 |
| B3 | `@deepseek-ai/cordis` 声明为可选 peer，但从未使用 | 官方 peer 规则是「需要与宿主共享实例」才声明；本插件零 import cordis，loader 也不校验范围 ⇒ 纯噪声 | 删除 `peerDependencies` / `peerDependenciesMeta` |
| B4 | 工具数一度被改回 32（**自我回归**） | 数工具的命令 `grep -o "name: 'browser_[a-z_]*'"` 的字符类漏了数字，`browser_a11y` 被静默漏掉 ⇒ 32；照这个数改文档，就把上一轮 `dd45fca` 的正确修正又翻了回去 | 以**运行期**实测为准：用 stub `ctx` 跑 `tool-browser` 的 `apply()`，`ctx.tools.register` 收到 **33** 个 `browser_*` 工具（含 `browser_a11y`）；全文统一为 33，并记下这个陷阱 |

对应新增验收：`scripts/verify-bundle.mjs`（16 项起）—— 一次性隔离 `DSH_HOME` 里跑官方流程。打包命令改为官方推荐的 `pnpm pack`（见 §8）。

## 13. v0.4.0 变更（一个包装完）

起因：插件市场（[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)）的一键安装只能装**一个**包，而 v0.3.3 的形态是「工具包 + 插件子包」两个交付物、且必须先把第三方接缝包 `dsh-builtin-browser` 装成组合包才生效 ⇒ 市场里装到的只是 provider，装完即坏。v0.4.0 把三者合成一个包：

| # | 项 | 做法 |
| --- | --- | --- |
| U1 | 合并交付物 | 删除 `plugin/package.json`（子包不再存在）；根 `package.json` 声明 `dsh.bundle.patch`，`exports` 暴露 `.`（provider）、`./browser`、`./tool-browser`（转出口）、`./cordis.patch.yml`、`./package.json` |
| U2 | 自己挂接缝 | 新增 `plugin/shims/browser.js` 与 `plugin/shims/tool-browser.js`，从依赖 `dsh-builtin-browser` 转出 seam 插件与 33 个工具；patch 改为 `insert` 三行（`browser` 选 `cdp-daemon`、`tool-browser`、`browser-cdp`），不再依赖别的组合包先插入 |
| U3 | 默认自启 | `plugin/lib/provider.js` 新增 `defaultAutoStartCommand()`：未配 `autoStartCommand` 时用**本包自带的** `bin/browsersvc.mjs`（`new URL('../../bin/browsersvc.mjs', import.meta.url)`），装完重启 DSH 即用 |
| U4 | 转出口形状 bug（自查发现） | `dsh-builtin-browser/tool-browser` **没有 default 导出**（只有具名 `name`/`apply`/`inject`），最初写成 `export { default }` 会在组合期报 `does not provide an export named 'default'`；改为 `export *`（`browser` 侧两个都留），并在 `verify-bundle.mjs` 里加「转出口导出键 ≡ 源模块」断言 |
| U5 | F26：`--internal-port-base` 被静默忽略 | `src/config.mjs` 里该键只读 `config.json`，CLI 传了没用（USAGE 却宣传了它）⇒ 改为 `CLI > config.json > 默认`，并补验收（`internalPort === 19700`） |

对应验收：`verify-daemon.mjs` 31 → **32**、`verify-provider.mjs` 86 → **88**、`verify-bundle.mjs` 重写为 **23 项**（含单一交付物形状、`add` 后 `--dump-config` 四行齐全且无 not found、默认自启指向包内 bin、转出口形状比对、`remove` 清理）。隔离 web 模板 profile 里跑通了真实的 DSH 内端到端（§5 末尾）。

## 14. 许可

MIT
