# dsh-browser-service

[![npm version](https://img.shields.io/npm/v/dsh-browser-service)](https://www.npmjs.com/package/dsh-browser-service)
![license](https://img.shields.io/badge/license-MIT-blue)
![node](https://img.shields.io/badge/node-%3E%3D22.19-brightgreen)

**给 DSH 一个能跑在无 root、无 GUI 容器里的浏览器**：一个单例 CDP 守护进程 + 完整的 33 个 `browser_*` 工具面 + `ctx.browser` 接缝的 `cdp-daemon` provider，**一个包装完**（不再需要 Electron、不再需要先装第三方接缝包）。同一个内核也能以「浏览器可执行文件」的形态给 `dsh-univer-office` 这类只认 `browserExecutablePath` 的插件用。

> **English TL;DR** — A single-package browser backend for DSH. One tarball ships a singleton CDP daemon (user-space `chrome-headless-shell`, bound to loopback behind a Bearer-token proxy), the full 33-tool `browser_*` surface and the `ctx.browser` seam provider `cdp-daemon`. No root, no GUI libraries, no Electron, no build step.
> ```bash
> dsh plugin --profile web add dsh-browser-service@latest   # then restart DSH
> ```

## 这是什么 / 它解决什么问题

| 现状问题 | 本项目的做法 |
|---|---|
| DSH 内置 `dsh-builtin-browser` 的 provider 是自托管 Electron：没有 Electron 二进制、没有 GUI 库、seccomp 下 `No usable sandbox!` | 用系统已有的 `chrome-headless-shell`，`--no-sandbox --disable-dev-shm-usage`，库用用户态目录，不需要 root |
| 每个消费方各起一个浏览器（内存重复） | **一个守护进程**，多客户端通过 CDP 连入，会话用隔离 `BrowserContext` 分开 |
| CDP 端口若对外监听 = 把浏览器（含 cookie）交给主机上任意进程 | 内核只绑 `127.0.0.1:<内部随机端口>`，对外只暴露**本机回环代理**（要求 Bearer token，只放行读元数据与 `/devtools`）；代理顺带精确统计连接数 |
| `dsh-univer-office` 只接受「浏览器可执行文件路径」，无法连远端 CDP | 同一个内核外面套一层包装脚本当 `browserExecutablePath`（同一份二进制与库，不共享进程） |

## 快速开始

### 1) 装进 DSH（一条命令）

```bash
dsh plugin --profile web add dsh-browser-service@latest
# 也可以钉版本 / 离线分发（同一个包）：
#   dsh plugin --profile web add https://github.com/lyp88997/dsh-browser-service/releases/download/v0.7.0/dsh-browser-service-0.7.0.tgz
#   dsh plugin --profile web add ./dsh-browser-service-0.7.0.tgz

# 然后重启 DSH，再校验（应出现 browserProvider: cdp-daemon 与本包层，且本包三行没有 not found）：
dsh --profile web --dump-config | grep -E 'browserProvider|# == dsh-browser-service|not found'
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

- **别用旧名 `dsh-browser-cdp` 当裸包名**（v0.4.0 之前子包的名字）：npm 上的 `dsh-browser-cdp` 是别人的同名包（drscrewdriver，0.17.4），写了就装到别人家。本包自 2026-09-27 起以 `dsh-browser-service` 发布（当前 0.4.1）。
- 组合自动做四件事：插入接缝 `browser`（选 `cdp-daemon`）、插入 `tool-browser`、插入 `browser-cdp` provider、关掉内置 `browser-electron` 与 `dsh-playwright-browser`（后者自带 10 个与内置**同名**的 `browser_*` 工具，两个 provider 的工具面不能共存）。后两个 id 在本包单独安装的环境里不存在，loader 只打印一条 not found 提示，不影响组合。
- `browsersvc` 默认空闲 15 分钟自杀（`--idle-ms`，上限 24 小时）；插件自启时默认用 5 分钟（配置键 `idleMs`）。**最后一个会话关闭后插件会主动断开 CDP 连接**（P1），守护进程才可能真的空闲退出；下一次调用浏览器会自动把它拉回来（F25，见 [CHANGELOG](https://github.com/lyp88997/dsh-browser-service/blob/main/CHANGELOG.md)）。

> ⚠️ 改完**必须重启 DSH**（插件在 boot 时 import，热重载不可靠）：运行中的完整 web profile 上 `patchReload: live` 会静默回滚（进程 stdout 归 docker，看不到报错），干净进程里 boot 完全正常。
>
> 旧的「symlink 进 profile + 手写 `cordis.patch.yml`」只适合改源码时的临时接线（写法见 [`docs/profile-patch.browser-service.yml`](https://github.com/lyp88997/dsh-browser-service/blob/main/docs/profile-patch.browser-service.yml)），**不要与 bundle 路线同时用**（`insert` 行会重复）。

### 2) 起守护进程（也可以不管它）

装上之后首次调用浏览器时插件会自动拉起守护进程，所以这一步通常可以跳过；想手动起、或要固定端口/内核时：

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

**守护进程 CLI**

| 命令 | 说明 |
|---|---|
| `detect` | 打印候选内核与已解析配置 |
| `start` | 后台拉起守护进程并等到 CDP 就绪（已运行且健康则直接返回） |
| `stop` | 先停 supervisor，再兜底清理浏览器进程与状态文件（动手前校验 pid 身份，`--force` 跳过） |
| `status` | 打印状态；**健康退出码 0，未运行 1**（便于脚本判断） |
| `restart` | stop + start |
| `run` | 前台运行（`start` 内部用它做后台进程） |
| `logs [--lines=60]` | 打印日志尾部 |
| `ops [--lines=20] [--json]` | **最近的操作**（工具动作、耗时、成败、会话/标签、错误原因）——数据来自 `<root>/ops.jsonl` |
| `console [--lines=40] [--json]` | **页面控制台**输出（log/error/warning + `pageerror`）——`<root>/console.jsonl` |
| `network [--lines=40] [--json]` | **网络请求**（method/url/状态码/耗时，不记头与体）——`<root>/network.jsonl` |
| `har [--session=s1] [--out=file]` | 会话关闭后落盘的 **HAR**（`<root>/har/`，只留最近 10 份），`--out` 复制出去 |
| `cookies [--url=…] [--json\|--export=file\|--import=file]` | **cookie + localStorage** 导出/注入到文件（`--export` 0600 且拒绝覆盖；`--import` 需有活会话） |

参数：`--root` `--port`（0 = 自动择取）`--idle-ms` `--kernel` `--wrapper` `--user-data-dir` `--max-restarts` `--start-timeout` `--internal-port-base`，对应环境变量 `DSH_BROWSER_SVC_ROOT` / `DSH_BROWSER_SVC_PORT` / `DSH_BROWSER_SVC_IDLE_MS` / `DSH_BROWSER_CHROME` / `DSH_BROWSER_WRAPPER`，也可写进 `$ROOT/config.json`。优先级：**CLI > 环境变量 > config.json > 自动探测**。

### 3) 给 `dsh-univer-office` 用

```yaml
- id: univer
  config:
    browserExecutablePath: /home/node/DSH/.browser/chromium-wrapper.sh
```

保持现状即可：univer 用同一份二进制与库，自己起临时实例（它没有 `connectOverCDP` 能力，分析见 [`docs/design-notes.md`](https://github.com/lyp88997/dsh-browser-service/blob/main/docs/design-notes.md)）。

## 环境要求与兼容性

| 项 | 要求 |
|---|---|
| DSH | 支持 `dsh plugin` / `dsh.bundle` 的版本（本机在 `0.1.5-rc.3` 实测） |
| Node.js | **≥ 22.19**（`package.json` 的 `engines`；守护进程只用 Node 内置模块，零第三方运行时依赖） |
| 操作系统 | **Linux x86_64**。本项目在 Debian 12 容器（uid 1000、cgroup 只读、`/dev/shm` 64M、无 Xvfb）实测；**macOS / Windows 未测试** |
| 浏览器内核 | 系统已有的 `chrome-headless-shell` / Chromium / Chrome，或用户态目录里的 `chrome-headless-shell` + 包装脚本（注入 `LD_LIBRARY_PATH` 与 `FONTCONFIG_FILE`，见 `bin/browsersvc.mjs detect`） |
| 权限 | **不需要 root**；不需要 GUI 库，不需要 Xvfb。容器里 `NoNewPrivs=1` + seccomp 时 Chromium 沙箱起不来，因此固定加 `--no-sandbox --disable-dev-shm-usage` |
| 网络 | 只监听 **127.0.0.1**（默认公开端口 9333，内核用内部端口）；不依赖外网 |
| 磁盘 | 一个 profile 里的包体量 ≈ 依赖（`playwright-core` 约 14M，只做 CDP 客户端、**不下载浏览器**）；运行时数据在 `$DSH_HOME/browser-service` |

### DSH 兼容矩阵（实测）

`node scripts/verify-matrix.mjs --dsh <bin> … --smoke` 把**同一个 tarball** 分别装进不同版本的 DSH，逐版本验 12 项（`add` → `--dump-config` → 入口可加载 → `apply(桩 ctx)` 注册出 `cdp-daemon` 且启动期探测无 error → 用装进来的 bin 自启守护进程、真开 `example.com` 读回正文）：

| 宿主 DSH | 结果 | 说明 |
|---|---|---|
| `0.1.5-rc.3` | **12/12** ✅ | 本机当前宿主（全局装） |
| `0.1.7-rc.2` | **12/12** ✅ | npm `latest` / `next` |
| `0.1.7-rc.1` | **12/12** ✅ | |
| `0.1.6-alpha.2` | **12/12** ✅ | alpha 通道也验证过 |

- 矩阵用的备版本是 `npm install --prefix /tmp/dsh-mat/<ver> @deepseek-ai/dsh@<ver>` 装的（npm 会把 peer 提升到 `<prefix>/node_modules/@deepseek-ai`，与全局装的层内布局不同，`scripts/lib/host-peers.mjs` 两种都认）。逐版本**串行**跑：一个无头内核约 600 MB，并行会顶到容器内存上限。
- 接缝（依赖 `dsh-builtin-browser`）实测面为 **0.1.22**：`browser` 导出 `default`（函数）/`BrowserError`/`BrowserRuntime`，`tool-browser` 导出 `name`/`apply`/`inject`/`internals`（**无** `default`）。启动期探测就在 boot 时校验这些形状——不符只会打印一句「插件未启用 —— 浏览器接缝与预期不符（接缝 X，宿主 Y）：…」并安静退出，不再抛上游的模块错。
- **不写 `dsh.engines`、也不写 `@deepseek-ai/dsh` 的 semver peer**：前者字段不存在（宿主不读），后者在预发布版本上会给出错误的兼容信号（`>=0.1.5-rc.1 <0.2.0` 只解锁 0.1.5 的预发布，`0.1.7-rc.2` 会被判不符）。版本适配靠「探测 + 人话报错 + 上面这张实测表」。

字体/库缺失的症状：截图纯白、中文变方块——用带 `FONTCONFIG_FILE` 的包装脚本，或安装系统字体。

## 工具参考（33 个 `browser_*`）

工具面与内置 `dsh-builtin-browser` **完全一致**（同一份 `tool-browser` 模块，经本包转出口挂出），所以 `browser_*` 的语义、参数与 `target {by: css|text|xpath}` 定位方式都沿用内置文档。按用途分组：

**打开与导航**

| 工具 | 说明 |
|---|---|
| `browser_open` | 打开 URL（只接受 http(s)；首次调用会按需自启守护进程） |
| `browser_wait` | 等到页面就绪：load complete，可等期望 URL 或某个 CSS 选择器出现 |
| `browser_back` / `browser_forward` | 历史后退 / 前进（无历史时是 no-op） |
| `browser_refresh` | 重新加载当前页 |
| `browser_challenge` | 检测人机校验（Cloudflare / reCAPTCHA / hCaptcha / Turnstile）是否挡住当前页 |

**读取页面**

| 工具 | 说明 |
|---|---|
| `browser_a11y` | 读无障碍树（语义角色 / 名称 / 状态，穿透同源 iframe 与 shadow root）——理解页面结构的首选 |
| `browser_snapshot` | 可交互元素快照（带编号，供视觉/文本驱动） |
| `browser_content` | 取页面内容：`html` / `markdown` / `txt` / `json`，可按选择器限定范围 |
| `browser_scrape` | 列表页结构化提取：给容器选择器 + 字段映射（`sel@attr`，`a@href` 取绝对地址）。**`item` 必须是容器**：字段选择器是在 `item` **内部**查找的，所以 `item: img` + `img@src` 取不到值，要写 `item: body` |
| `browser_screenshot` | 截屏（PNG/JPEG、fullPage、等比缩小、可落盘） |
| `browser_get_value` | 读单个输入/文本域/下拉/可编辑区的当前值 |

**操作与表单**

| 工具 | 说明 |
|---|---|
| `browser_click` | 点击：语义定位（css/text/xpath）或视口坐标（配 `browser_screenshot` 用） |
| `browser_type` | 向聚焦元素插入文本（`browser_key` 发 Enter/Tab/方向键等） |
| `browser_set_value` | 设值（原生 setter + input 事件，React/Vue 受控组件也生效） |
| `browser_fill` | 一次填一张表单（`fields[]` 支持 selector / name / label / placeholder，可提交） |
| `browser_check` | 勾选/取消 checkbox、radio |
| `browser_select` | `<select>` 选一项（按 value / 可见文本 / 序号） |
| `browser_clear` | 清空输入框，或取消勾选 |
| `browser_scroll` | 滚动（像素增量 / 滚到某元素 / 到顶到底） |
| `browser_execute` | 在页面里执行 JS（传表达式或函数，可带参数）——驱动页面的主力 |
| `browser_key` | 发送单个命名按键 |

**标签页与会话**

| 工具 | 说明 |
|---|---|
| `browser_list_tabs` | 列出标签页（id / url / title / 是否活动） |
| `browser_switch_tab` | 按 id 切换标签页 |
| `browser_close_tab` | 按 id 关标签页（关活动页会激活下一个） |
| `browser_reset` | 关掉全部标签页，开一个空白页重来 |
| `browser_session` | 查看本任务的浏览器会话（id 与标签页） |
| `browser_reset_session` | 重置本任务的浏览器会话（进程坏了/连不上时的兜底） |

**文件、凭据与调试**

| 工具 | 说明 |
|---|---|
| `browser_download` | 下载 URL 到本地文件（保留会话 cookie 与登录态） |
| `browser_auth` | 导出/恢复 cookies（登录态可保存到私有文件、重启后恢复） |
| `browser_history` | 列出本会话已执行的操作（navigate/execute/click/type，含成功与错误） |
| `browser_replay` | 按历史序号重放某一步 |
| `browser_restrict` | 限制允许的浏览器动作（软护栏，防误点误导航） |

## 配置

配置写在 profile patch 的 `browser-cdp` 行 `config:` 下（patch **整行替换** `config`，覆盖时要重述该行需要的每个键）。

| 键 | 默认 | 说明 |
|---|---|---|
| `providerId` | `cdp-daemon` | seam 里注册的 provider 名，要和 patch 里 `browser.browserProvider` 一致 |
| `cdpUrl` | `http://127.0.0.1:9333` | browsersvc 的公开（回环）端点 |
| `connectTimeoutMs` | `10000` | 连 CDP / 首次用浏览器时等守护进程起来的超时 |
| `actionTimeoutMs` | `30000` | 单次元素操作（点击/填写/求值）预算 |
| `navigationTimeoutMs` | `30000` | 导航/刷新预算 |
| `lookupTimeoutMs` | `5000` | 元素查找与 scrape 的等待预算 |
| `snapshotMaxElements` | `200` | `browser_snapshot` 返回的元素上限 |
| `contentMaxChars` | `200000` | `browser_content` 截断长度 |
| `captureConsole` | `true` | 是否把页面控制台（`console.*` / `pageerror`）记进 `<root>/console.jsonl` |
| `captureNetwork` | `true` | 是否把网络请求记进 `<root>/network.jsonl`，并按会话录 HAR（关掉就不录 HAR） |
| `maxTabs` | `5` | 单个会话允许的最大标签页数（夹在 `1..50`）。超过时 `browser_open {newTab:true}` 报 `BROWSER_TAB_LIMIT`——每个标签页是一个独立渲染进程，实测约 +93 MB |
| `viewportWidth` / `viewportHeight` | `1440` / `900` | 新页面视口（坐标点击的空间） |
| `idleMs` | `300000`（5 分钟） | 本包**自启**守护进程时的空闲回收窗口（夹在 `1000..86400000`）。最后一个会话关闭后插件主动断开连接，守护进程再空闲这么久就退出、把内存还给系统。仅在使用默认 `autoStartCommand` 时生效 |
| `autoStartCommand` | 空 = 用**本包自带**的 `bin/browsersvc.mjs start` | 可选：首次用浏览器时执行的命令；换端口/内核才需要填（自己填的话，`idleMs` 不会自动带上，要自己写 `--idle-ms`） |
| `autoStartTimeoutMs` | `60000` | `autoStartCommand` 的执行超时 |
| `cdpToken` | 空 | 一般不用填：留空时自动读 `<DSH_BROWSER_SVC_ROOT 或 $DSH_HOME/browser-service>/service.json` 里的 `token`（每次 attach 重读，守护进程重启换 token 也能跟上）。只有指向自建/非 browsersvc 的 CDP 端点时才需要显式给 |
| `downloadDir` | 系统 Downloads 目录 | 截图/下载的 `savePath` 必须落在该目录内。不配置时与内置 provider 同语义：`XDG_DOWNLOAD_DIR`（存在才用）→ 家目录下存在的 `Downloads`/`下载`/`下載` → `~/Downloads`（首次写入时建出来）。要存进工作区/别处就显式填一个目录 |

这些键的权威定义在 `plugin/lib/index.js` 的 `Config`（schemastery schema）——**改默认值必须同时改这里和本表**。

> **v0.3.0 起公开端口要求 `Authorization: Bearer <token>`**（token 由 `browsersvc` 生成，落在 0600 的 `service.json`）。插件自动读取它，无需改配置；但 `browsersvc` 与插件必须一起升级——旧插件 + 新守护进程会在 401 上失败（见「升级与卸载」）。

## 网页面板与实时窗口（0.7.0）

同一个包还带一个网页浮动面板（右下角的小胶囊，点开是四标签卡片：**网页 / 操作 / 控制台 / 网络**）。它不新增任何工具，也不改 33 个 `browser_*` 的行为：

- **「网页」标签是实时窗口**（0.7.0 起，默认打开）：直接把浏览器当前标签的画面流到卡片里，**你能看到的那个页面就是真页面**——在窗口里点按钮、滚轮滚动、键盘输入、地址栏回车跳转，都会被原样打进真浏览器；窗口外面（对话里）的助手调用与你在窗口里的操作作用在同一个页面上。
  - 取帧走 [`plugin/lib/liveview.mjs`](https://github.com/lyp88997/dsh-browser-service/blob/main/plugin/lib/liveview.mjs)：`Page.startScreencast`（JPEG，质量 70，最长边 1280）经我们的回环代理下发，**只在画面变化时发帧**（静止时零流量，实测一帧约 6.8 KB）；操作走 `Input.dispatchMouseEvent`/`insertText`/`dispatchKeyEvent`/`mouseWheel`。
  - 三条路由（都在 `plugin/lib/panel.js`，与面板同源、`exact` 匹配）：`GET /browser-service/live.jpg?since=N`（长轮询，最多等 1.5 s，只回比 `since` 新的帧，没有新帧回 204）、`GET /browser-service/live.json`（地址栏/标题/推流状态每秒同步）、`POST /browser-service/live`（`down`/`up`/`move`/`wheel`/`text`/`key`/`reload`/`goto`，`DELETE` 停流）。
  - **只对本机回环请求开放**：非回环来源 403，跨站 POST 403（校验 `origin`/`referer` 与 Host 同源），方法白名单 405。若你从别的机器直连 DSH Web，日志标签照常、实时窗口会被拦。
  - 省电：卡片收起/切换/暂停/页面不可见时客户端发 `DELETE` 停流；宿主半边 30 s 没收到取帧也自动停（`setInterval` 已 `unref`）。
- 客户端半边是 [`plugin/client.js`](https://github.com/lyp88997/dsh-browser-service/blob/main/plugin/client.js)——手写、零构建，走 DSH 的 `window.__ModuleLoader__` 协议，只 `require('react')`（平台种子表内的包），样式全内联，不引第三方 UI 库。
- 宿主半边是 [`plugin/lib/panel.js`](https://github.com/lyp88997/dsh-browser-service/blob/main/plugin/lib/panel.js)——在 `ctx.webServer` 上挂四条 `exact` 路由（`/browser-service/panel.json`、`live.jpg`、`live.json`、`live`）；`panel.json` 只允许 GET/HEAD、`no-store`、载荷里不含本机绝对路径。没有 `webServer` 的宿主不会挂这些路由，插件照常工作。
- 日志三标签的数据就是上面那三个 JSONL 的尾巴（`?lines=` 默认 40，上限 200），所以 CLI 与面板看到的是同一份真相；轮询 2.5 s，页面不可见时停轮询，卡片上有「暂停/继续」与「收起」。
- 需要在 DSH 里**重启一次**才会出现（客户端插件在启动时收集），改 `plugin/client.js` 后不必重启（客户端入口支持热替换），改宿主半边要重启。

## 架构与工作原理

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
- provider 侧：`inject=['browser']` → 读 Config → 向 `ctx.browser` 注册 `cdp-daemon`；`playwright-core` 的 `connectOverCDP` 连到回环代理，会话用隔离 `BrowserContext`。

工作方式与设计取舍（含实测到的热重载失效、seccomp/`/dev/shm` 约束）见 [`docs/architecture.md`](https://github.com/lyp88997/dsh-browser-service/blob/main/docs/architecture.md) 与 [`docs/design-notes.md`](https://github.com/lyp88997/dsh-browser-service/blob/main/docs/design-notes.md)。

## 已知限制

1. **一个 root 一个守护进程**（单例）。多个 profile 想共用内核要显式给同一个 `--root`；否则各自拉起一个。
2. **只监听回环**，同 uid 的其它进程读得到 `service.json` 里的 token（文档权限 0600，但同 uid 可读）。这是本机隔离，不是跨用户隔离。
3. **`--no-sandbox` 是必需项**（容器里 Chromium 沙箱起不来）⇒ 只访问可信站点；需要更强隔离就把浏览器放进独立容器。
4. **改插件代码或 profile patch 后必须重启 DSH**：完整 web profile 上 `patchReload: live` 会静默回滚（实测：探针条目 `applied` 后 6–7 ms 被 `disposed`，插件的 `apply` 根本没被调用；最小 profile 里热重载正常）。
5. **插件与 `browsersvc` 必须同版本升级**：v0.3.0 起公开端口要 Bearer token，旧插件 + 新守护进程会 401（F19 修的是冷启动重读 token）。
6. **工具面取决于依赖版本**：33 个 `browser_*` 来自 `dsh-builtin-browser`，上游增删工具时本包跟着变（本包只保证转出口形状一致、并把它写进验收）。
7. **守护进程会空闲自杀**（守护进程自身默认 15 分钟；本包自启默认 5 分钟，见配置表 `idleMs`；`--idle-ms` 允许 `1000..86400000`，即最长 24 小时）。**只有代理端口上没有任何连接时才会空闲**：所以 0.5.0 起插件在最后一个会话关闭后会**主动断开** CDP 连接——否则那条约 600 MB 的常驻浏览器永远不回收（P1）。DSH 侧下一次调用会自动把它拉回（F25），所以这是省内存的设计而不是故障；连「被下次调用拉起」也不想要，就 `dsh plugin remove` 卸载本包。
8. **`browser_execute` 传的是表达式语境**：传函数体会被当表达式求值并报 `page.evaluate: SyntaxError: Illegal return statement`，请传 `(...) => {...}` 或纯表达式。
9. **`browser_fill` 的 `fields[].selector` 是作用域不是定位器**：定位某个控件请用 `browser_click` / `browser_set_value` / `browser_check` 的 `target`。
10. **macOS / Windows 未测试**；仅 Linux（Debian 12 容器）实测。
11. **截图/下载默认只能写进系统 Downloads 目录**（`XDG_DOWNLOAD_DIR` → 家目录下存在的 `Downloads`/`下载`/`下載` → `~/Downloads`，对齐内置 provider）。要写进工作区或别处，就在 profile patch 的 `browser-cdp` 行 `config` 里显式配 `downloadDir`（patch **整行替换** `config`，覆盖时该行其它键要重述）。
12. **单个会话默认最多 5 个标签页**（配置 `maxTabs`，夹 `1..50`）。每个标签页是独立渲染进程，实测约 +93 MB；超限时 `browser_open {newTab:true}` 报 `BROWSER_TAB_LIMIT`，文案会列出当前标签，用 `browser_close_tab` 关掉不用的、或 `browser_reset_session` 清空本会话（P1）。

## 安全模型

1. **只绑回环**：本机是 host 网络，`0.0.0.0` 上的 CDP 端口等于把浏览器完全交给主机上任意进程。内核永远带 `--remote-debugging-address=127.0.0.1`，对外只走回环代理；验收脚本会解析 `/proc/net/tcp` 检查这一点。
2. **`--no-sandbox` 是必需的**（容器 `NoNewPrivs=1` + seccomp 下 Chromium 沙箱起不来），因此**只访问可信站点**；需要更强隔离时把浏览器放进独立容器。
3. **`--disable-dev-shm-usage` 必需**（`/dev/shm` 只有 64M）。
4. 会话隔离必须用 incognito `BrowserContext`，不要复用默认上下文。
5. **公开端口要求凭据**：`Authorization: Bearer <token>`（每次守护进程启动随机生成，落在 0600 的 `service.json`）。代理只放行读元数据（`GET /json/version|/json/list|/json/protocol`）与 `/devtools/*`，挡掉 `/json/new|close|activate` 这类控制接口；`/json/version` 里的 `webSocketDebuggerUrl` 会被改写成代理自己的地址并附上 token，所以调用方（provider）不需要额外配置，也绕不开代理。内部内核端口仍只绑回环。**每条连接只认首个请求**：代理只在连接建立时解析一次请求头，所以非 WebSocket 请求一律按 `connection: close` 转发、响应后立刻关闭（否则同一连接上的后续请求就是免检的裸管道，F27）。
6. **保存路径准入**：`browser_screenshot` / `browser_download` 的 `savePath` 必须是绝对路径、不得覆盖已有文件，并且必须落在 `downloadDir` 内（不配置时＝系统 Downloads 目录，见配置表；违规报 `BROWSER_SCREENSHOT_BLOCKED` / `BROWSER_DOWNLOAD_BLOCKED`）。这样接缝工具 schema 里那句「默认写进系统 Downloads 目录」才是真的，提示注入也没法让浏览器工具写任意路径。
7. 状态文件 0600、日志 0600，日志不记录页面内容。

维护约定（改动这些是安全回归）：上面的 1–4 与 6 请不要为了「能跑通」而放宽；验收脚本里对应断言就是为了拦住这种改动。

## 验收与测试

**零依赖、不依赖外网**，三条脚本直接在仓库里跑：

```bash
node scripts/verify-daemon.mjs      # M1 守护进程 + CLI 防御：35/35
node scripts/verify-provider.mjs    # M2 provider：110 通过，0 失败
node scripts/verify-bundle.mjs      # 组合包安装（官方 dsh plugin 流程）：41/41
node scripts/verify-data.mjs        # P3 数据层 + P4 实时窗口：61 通过，0 失败
node scripts/verify-matrix.mjs --dsh <bin> --dsh <bin> --smoke   # 多版本 DSH 兼容矩阵（见「环境要求与兼容性」）
```

| 套件 | 项数 | 覆盖 |
|---|---|---|
| `verify-daemon.mjs` | **35/35** | 守护进程启停/重启、token 与 401/403 凭据门、只绑回环、上下文隔离、崩溃重启、空闲退出、配置校验、启动失败不留孤儿、`stop` 身份校验、同一连接上的后续请求不免检（F27） |
| `verify-provider.mjs` | **110 通过 / 0 失败** | 33 个工具的行为与边界（含 `execute`/`a11y`/`scrape`/`form`/`screenshot`/`download`/`auth`）、会话隔离与复活、保存路径准入与默认保存目录（D1）、代理对截断、**P1：`maxTabs` 上限（拒绝后不留半开页）、无会话时释放连接（守护进程按 `idleMs` 回收 + 自愈）、配置默认值** |
| `verify-bundle.mjs` | **41/41** | 在一次性隔离 `DSH_HOME` 里跑官方 `add` → `--dump-config` → 转出口形状比对 → **P2：宿主 peer 解析、启动期探测（好/坏形状）、工具面计数 == 33** → **P3：客户端半边（loader 协议、cordis 插件形状、`apply` 注册到 `shell.overlay`、只点平台种子表）** → **P4：客户端引用的三条实时路由与服务端一字不差** → `remove`，不碰默认 profile |
| `verify-data.mjs` | **61 通过 / 0 失败** | **P3：`ops`/`console`/`network`/`har`/`cookies` 五个观测面 + 只读面板路由**——操作日志（含通用追踪覆盖 `snapshot`/`content`/`screenshot`/`listTabs`、失败记 `ok:false` 与原因）、控制台两类、网络两阶段、HAR 落盘与复制、cookie/localStorage 导出注入与权限、`panel.json` 的形状/行数/405/卸载、IO 失败不抛 → **P4：实时窗口四条路由与三道闸**（取帧 JPEG 与帧序号头、无新帧 204、打字/点击/goto 转发、未知动作 400、非本机 403、跨站 403、方法 405、DELETE 停流、无 provider 503、dispose 一起摘掉） |
| `verify-matrix.mjs` | **4 个宿主版本 × 12 项** | 把同一个 tarball 装进不同版本的 DSH：`add` → `--dump-config` → 入口可加载 → `apply(桩 ctx)` 注册出 provider 且探测无 error → `--smoke` 用装进来的 bin 自启守护进程、真开页面读回正文 |

完整输出（35 条 PASS 原文、DSH 内端到端日志、npm 短命令实测、未自动化覆盖的部分）见 [`docs/verification.md`](https://github.com/lyp88997/dsh-browser-service/blob/main/docs/verification.md)。

## FAQ

**装完市场里显示「安装并启用」，但调用浏览器就报「会话内没有可用标签页」？**
重启 DSH。插件只在 boot 时 import，热重载在完整 web profile 上会静默回滚（见「已知限制」4）。

**报 401 / 连接被拒？**
① 旧插件配新守护进程 ⇒ 升级插件后重启 DSH，再 `browsersvc restart`。② 若不配 `cdpToken`，插件会每次 attach 重读 `service.json` 的 token（F19 起），所以冷启动第一次调用也能用。

**报 `browser: 无法连接 CDP 端点 … ECONNREFUSED`？**
守护进程空闲自杀了；下一次调用会自动拉回（F25）。一直失败就手动 `node bin/browsersvc.mjs start` 看 `logs`。

**浏览器占着约 600 MB 内存，什么时候还回来？**
① 单个会话超过 `maxTabs`（默认 5）会报 `BROWSER_TAB_LIMIT` 而不是继续吃内存；② 最后一个会话关闭后插件主动断开连接，守护进程再空闲 `idleMs`（默认 5 分钟）就退出——内核、渲染进程一起收走；③ 想立刻收，`node bin/browsersvc.mjs stop`。会话期间不会回收（这是为了不每次都冷启动 3 秒）。

**`browser_open {newTab:true}` 报 `BROWSER_TAB_LIMIT`？**
本会话标签页到上限了（默认 5）。文案里有当前标签列表；`browser_close_tab` 关掉不用的，或 `browser_reset_session` 清空；确需更多就调大配置 `maxTabs`（上限 50，每个约 +93 MB）。

**要不要单独装 `dsh-builtin-browser`？**
不要。它是本包的依赖，同时当组合包会让 `browser`/`tool-browser` 插两次、33 个工具重名。已装过就 `dsh plugin --profile <name> remove dsh-builtin-browser`。

**能写 `dsh plugin add dsh-browser-cdp` 吗？**
不能，npm 上那是别人的同名包（drscrewdriver 0.17.4）。用 `dsh-browser-service`。

**`browser_execute` 报 `Illegal return statement`？**
它按表达式求值，别传函数体字符串。传 `({title: document.title})` 或 `() => document.title`。

**`browser_fill` 里 `selector` 没起定位作用？**
`fields[].selector` 是**作用域**，不是定位器；定位控件用 `browser_click` / `browser_set_value` 的 `target {by: css|text|xpath}`。

**`browser_open` 报「只允许 http(s) URL」？**
`data:` / `file:` / `about:` 会被拒绝。本地页面起个 HTTP 服务再用 `http://127.0.0.1:<port>/` 打开。

**截图/下载报 `BROWSER_SCREENSHOT_BLOCKED` / `BROWSER_DOWNLOAD_BLOCKED`？**
`savePath` 必须是绝对路径、不能是已有文件，而且必须落在 `downloadDir` 内。**默认目录＝系统 Downloads**（`XDG_DOWNLOAD_DIR` → 家目录下存在的 `Downloads`/`下载`/`下載` → `~/Downloads`），所以 `savePath: /tmp/x.png` 这类写法默认会被拒——必须显式配 `downloadDir`（见「配置」与「已知限制」11）。

**改了 patch 没生效？**
重启 DSH。另外手写 patch 与 bundle 路线不要同时用（`insert` 行会重复）。

## 升级与卸载

```bash
# 升级（@latest；钉版本就用 Release 资产 URL 或本地 tgz）
dsh plugin --profile web add dsh-browser-service@latest
# 卸载（依赖与层一起清）
dsh plugin --profile web remove dsh-browser-service
# 顺手停掉守护进程（可选）
node "$(dsh --profile web --dump-config >/dev/null 2>&1; echo ~/.dsh/profiles/web/node_modules/dsh-browser-service)/bin/browsersvc.mjs" stop
```

**版本兼容**：插件与 `browsersvc` 必须同版本升级。v0.3.0 起公开端口要求 `Authorization: Bearer <token>`，旧插件对新守护进程会在 401 上失败。升级顺序：**先换插件（重启 DSH），再 `browsersvc restart`**。

**从 0.3.x 升到 0.4.x**：交付物从「工具包 + 插件子包」变成**一个包**，所以旧装法留下的两个包要清掉：

```bash
dsh plugin --profile web remove dsh-browser-cdp      # 旧子包名（本地 tarball 装的话）
dsh plugin --profile web remove dsh-builtin-browser  # 现在由本包依赖提供
dsh plugin --profile web add dsh-browser-service@latest
```

若你之前用「symlink + 手写 patch」接线，先删掉 `cordis.patch.yml` 里的浏览器块再走 bundle 路线（两套同时用会重复 `insert`）。

## 打包与分发

**一个包、零构建**（纯 ESM），三条分发路径都实测过：**npm**（`dsh plugin add dsh-browser-service@latest`）、**GitHub Release 资产**（`dsh plugin add <tgz URL>`）、**本地 tarball**（`dsh plugin add ./dsh-browser-service-<v>.tgz`）。**都不需要**用户给构建脚本授权——只有从 GitHub 装**源码**才要 `prepare` + `allowBuilds`（见 DSH 官方《打包与安装插件》）。

```bash
chmod 755 bin/browsersvc.mjs                          # bin 必须可执行（POSIX 下 npm 全局 shim 是指向它的符号链接）
chmod -R u+rwX,go+rX .                                # 交付物里的文件权限由本机 umask 决定，打包前统一（F12）
pnpm pack --pack-destination dist                     # dsh-browser-service-<v>.tgz：唯一交付物（挂 Release 用）
# 发布到 npm（package.json 不能有 "private": true；token 必须是勾了 Bypass 2FA 的 granular token）：
npm publish --access public
```

- **单一交付物**：根 `package.json` 里声明 `"dsh": {"bundle": {"patch": "./plugin/cordis.patch.yml"}}`，同一个包同时提供 `bin/browsersvc.mjs`（守护进程 CLI）、`plugin/lib/*`（provider）与 `plugin/shims/*`（接缝/工具面转出口）。装完这一个包，`--dump-config` 里就出现 `# == dsh-browser-service` 层、`browser`（`browserProvider: cdp-daemon`）、`tool-browser`、`browser-cdp` 四行。
- 依赖：`dsh-builtin-browser`（提供 seam 与 33 个工具，转出后面向 profile 生效）、`playwright-core`（只做 CDP 客户端，**不下载浏览器**）。配置 schema 用的 `@deepseek-ai/schemastery` 按官方 peer 规则写成 `peerDependencies` + `devDependencies`（**与宿主共享同一实例**，不再进 `dependencies`）；接缝包需要的其它宿主 peer（`@deepseek-ai/cordis` / `dsh-tools` / `dsh-llm` …）由 DSH 在 boot 时建立的 `$DSH_HOME/profiles/node_modules/@deepseek-ai/*`（240 个入口）提供——profile 内任何包向上查找都能命中，所以不需要把它们写进本包依赖。
- 每个版本在 GitHub Release 挂两份资产：**不带版本号**的 `dsh-browser-service.tgz`（供 `releases/latest/download/dsh-browser-service.tgz` 这类**永不过期**的固定地址引用——插件市场条目就用它）与带版本号的 `dsh-browser-service-<v>.tgz`（文档里建议钉版本用）。
- `dist/` 已 gitignore。**npm 已发布**：`dsh-browser-service@0.4.0`（首版）、`@0.4.1`、`@0.4.2`、`@0.4.3`、`@0.4.4`、`@0.5.0`、`@0.5.1`、`@0.6.0`、`@0.7.0`（2026-09-29；`npm view dsh-browser-service` 可见 tarball 与 shasum）。0.4.1 与 0.4.2 是**只为刷新 npm 页面上的 README**（前者修 0.4.0 tarball 里的发布前文本，后者带上对齐生态后的 README），这两版**代码分别与 0.4.0 / 0.4.1 完全相同**；0.4.3 起有真实代码变更（默认 `downloadDir` 对齐内置 provider，见 CHANGELOG 的 D1），0.4.4 修掉代理的 keep-alive 免检缺陷（F27），0.5.0 收口资源问题（`maxTabs` 上限 + 无会话时释放连接，见 CHANGELOG 的 P1），0.5.1 做 DSH 版本适配（启动期能力探测 + 多版本实测矩阵，见 CHANGELOG 的 P2），0.6.0 加可观测性与网页面板（五个观测面 CLI + 只读浮动看板，见 CHANGELOG 的 P3），0.7.0 把面板升级成**实时交互网页窗口**（帧流 + 点击/滚动/打字/地址栏，只对本机回环开放，见 CHANGELOG 的 P4）。
- 踩坑：发布 token 必须是勾了 **Bypass 2FA** 的 granular token 且权限为 Read and write，否则 `npm publish` 报 `403 Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages`。旧名 `dsh-browser-cdp` 不能用：npm 上已被 drscrewdriver 的同名包占用（0.17.4）。
- 官方文档提到的 `dsh.engines` / `dsh.compatibility` 元数据本包**没写**：宿主只认 `dsh.bundle`（`@deepseek-ai/dsh-package-manifest` 的 `DshManifest` 里没有这两个字段），它们只被插件市场的发现逻辑读取，宿主既不读也不校验。也**刻意不给 `@deepseek-ai/dsh` 写 semver peer 范围**——semver 的预发布规则下 `>=0.1.5-rc.1 <0.2.0` 这类范围只解锁 `0.1.5` 的预发布，同范围的 `0.1.7-rc.2` 会被判为不符，写了反而给出**错误的兼容信号**；DSH 版本的适配改成「启动期探测 + 人话报错 + 多版本实测矩阵」（见「环境要求与兼容性」）。

## 进度

| 里程碑 | 内容 | 状态 |
|---|---|---|
| **M1** | 守护进程 + 回环代理 + 空闲回收 + 崩溃重启 + 35 项验收 | ✅ 完成 |
| **M2** | DSH provider 插件（`inject=['browser']` + `ctx.browser.registerBrowserProvider`），复用接缝包的 33 个 `browser_*` 工具 | ✅ 完成（110 项 + DSH 内端到端） |
| **M6** | 代码审查 18 条缺陷修复（F1–F18） | ✅ 完成（v0.3.0 → v0.3.3） |
| **M7** | 「一个包装完」：单一交付物，接缝与工具面由依赖 `dsh-builtin-browser` 转出 | ✅ 完成（v0.4.0） |
| **P2** | DSH 版本适配：启动期能力探测 + 人话报错（`plugin/lib/compat.js`）、`schemastery` 改 peer、多版本实测矩阵 | ✅ 完成（v0.5.1） |
| **P3** | 可观测性与交互：`ops`/`console`/`network`/`har`/`cookies` 五个 CLI 观测面 + 只读网页面板（`plugin/lib/panel.js` + `plugin/client.js`） | ✅ 完成（v0.6.0） |
| **P4** | 实时交互网页窗口：面板「网页」标签把真页面帧流进 DSH 网页，点击/滚动/打字/地址栏直接作用于真浏览器（`plugin/lib/liveview.mjs` + 三条 live 路由 + 客户端 `LivePane`），零新增工具 | ✅ 完成（v0.7.0） |

未来可能做：面向「任何插件」的通用 HTTP 面（`/fetch` `/screenshot` `/eval`，M4）；CDP-over-pipe 代理，让 univer 也复用守护进程（M5，进阶、未验证）。

## 更新记录

- **[CHANGELOG.md](https://github.com/lyp88997/dsh-browser-service/blob/main/CHANGELOG.md)** —— v0.7.0 / 0.6.0 / 0.5.1 / 0.5.0 / 0.4.4 / 0.4.3 / 0.4.2 / 0.4.1 / 0.4.0 / 0.3.3 / 0.3.2 / 0.3.1 / 0.3.0，含每条真实缺陷（F1–F27、P1–P4、B1–B4、U1–U6、D1）的复现与修复。
- 摘要：`0.7.0` 实时交互网页窗口（面板「网页」标签帧流 + 点击/滚动/打字/地址栏直接作用于真浏览器，只对本机回环开放，零新增工具）；`0.6.0` 可观测性与交互（`ops`/`console`/`network`/`har`/`cookies` 五个 CLI 观测面 + 只读网页面板，零新增工具）；`0.5.1` DSH 版本适配（启动期能力探测 + 人话报错、`schemastery` 改 peer、多版本实测矩阵）；`0.5.0` 资源收口（`maxTabs` 上限 + 无会话时释放连接，让守护进程能按 `idleMs` 回收）；`0.4.4` 修掉代理 keep-alive 免检（F27）；`0.4.3` 默认 `downloadDir` 对齐内置 provider（系统 Downloads，保存路径默认就有范围）；`0.4.2` 按热门插件共性重写 README（纯文档，代码同 0.4.1）；`0.4.1` 修正 npm 页面上的 README（代码同 0.4.0）；`0.4.0` 合并成单一交付物（一个包装完）；`0.3.0`–`0.3.3` 代码审查与按官方文档核对打包（26 条修复）。

## 文档

| 文件 | 内容 |
|---|---|
| [`docs/architecture.md`](https://github.com/lyp88997/dsh-browser-service/blob/main/docs/architecture.md) | 守护进程 + provider 的设计与实现细节（进程模型、代理、状态文件、接缝契约） |
| [`docs/design-notes.md`](https://github.com/lyp88997/dsh-browser-service/blob/main/docs/design-notes.md) | 可行性分析与取舍：为什么不用 Electron、用户态库、seccomp/`/dev/shm`、univer 的接线方式 |
| [`docs/verification.md`](https://github.com/lyp88997/dsh-browser-service/blob/main/docs/verification.md) | 验收输出原文、DSH 内端到端日志、未自动化覆盖的部分 |
| [`docs/profile-patch.browser-service.yml`](https://github.com/lyp88997/dsh-browser-service/blob/main/docs/profile-patch.browser-service.yml) | 手写 patch 路线（只有改源码时才用；不要与 bundle 路线同时用） |
| [`plugin/README.md`](https://github.com/lyp88997/dsh-browser-service/blob/main/plugin/README.md) | 插件侧源码结构与不变量（转出口形状、token 读取时机、patch 语义） |
| [`CHANGELOG.md`](https://github.com/lyp88997/dsh-browser-service/blob/main/CHANGELOG.md) | 版本变更与缺陷编号 |

## 贡献

欢迎 issue / PR。提 PR 前请：

1. 跑完三条验收脚本（`node scripts/verify-daemon.mjs && node scripts/verify-provider.mjs && node scripts/verify-bundle.mjs`），并在 PR 里贴计数；改动行为时**同时补断言**，不要只改实现。
2. 不要把「安全模型」里的约束放宽来让某个用例通过（回环绑定、Bearer token、路径白名单、`--no-sandbox` + `--disable-dev-shm-usage`）。
3. 改 `plugin/lib/index.js` 的 `Config` 默认值时必须同步 README 的配置表。
4. 提交信息写清「修的是什么、怎么复现」——本项目的 `CHANGELOG` 就是按这个格式维护的。

## 许可

MIT © 2026 lyp88997 —— 见 [`LICENSE`](https://github.com/lyp88997/dsh-browser-service/blob/main/LICENSE)。
