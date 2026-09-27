# 更新记录

本文件记录每个版本的变更与**真实缺陷编号**（F = 代码审查/上线验证发现的缺陷，B = 按官方打包文档核对发现的问题，U = v0.4.0 合并交付物的改动，F26 见 v0.4.0）。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

验收计数随版本推进：`verify-daemon` 13 → 26 → 31 → **32**，`verify-provider` 67 → 77 → 83 → 86 → **88**，`verify-bundle` 16 → **23**。

## [0.4.1] — 2026-09-27

- **只为修正 npm 页面上的 README**（0.4.0 的 tarball 里是发布前的文本，还写着「没有走 npm、名字还空着」）。**代码与 0.4.0 完全相同。**
- `scripts/verify-bundle.mjs` 修掉一处会随版本腐烂的写法：默认 tarball 路径原本把 `0.4.0` 写死在脚本里，改为从根 `package.json` 读 `version`。不改这里，下次改版本号验收就会去打包不存在的文件。

## [0.4.0] — 2026-09-27

起因：插件市场（[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)）的一键安装只能装**一个**包，而 v0.3.3 的形态是「工具包 + 插件子包」两个交付物、且必须先把第三方接缝包 `dsh-builtin-browser` 装成组合包才生效 ⇒ 市场里装到的只是 provider，**装完即坏，且没有任何报错**。v0.4.0 把三者合成一个包。

| # | 项 | 做法 |
| --- | --- | --- |
| U1 | 合并交付物 | 删除 `plugin/package.json`（子包不再存在）；根 `package.json` 声明 `dsh.bundle.patch`，`exports` 暴露 `.`（provider）、`./browser`、`./tool-browser`（转出口）、`./cordis.patch.yml`、`./package.json` |
| U2 | 自己挂接缝 | 新增 `plugin/shims/browser.js` 与 `plugin/shims/tool-browser.js`，从依赖 `dsh-builtin-browser` 转出 seam 插件与 33 个工具；patch 改为 `insert` 三行（`browser` 选 `cdp-daemon`、`tool-browser`、`browser-cdp`），不再依赖别的组合包先插入 |
| U3 | 默认自启 | `plugin/lib/provider.js` 新增 `defaultAutoStartCommand()`：未配 `autoStartCommand` 时用**本包自带的** `bin/browsersvc.mjs`（`new URL('../../bin/browsersvc.mjs', import.meta.url)`），装完重启 DSH 即用 |
| U4 | 转出口形状 bug（自查发现） | `dsh-builtin-browser/tool-browser` **没有 default 导出**（只有具名 `name`/`apply`/`inject`），最初写成 `export { default }` 会在组合期报 `does not provide an export named 'default'`；改为 `export *`（`browser` 侧两个都留），并在 `verify-bundle.mjs` 里加「转出口导出键 ≡ 源模块」断言 |
| U5 | **F26**：`--internal-port-base` 被静默忽略 | `src/config.mjs` 里该键只读 `config.json`，CLI 传了没用（USAGE 却宣传了它）⇒ 改为 `CLI > config.json > 默认`，并补验收（`internalPort === 19700`） |
| U6 | 发布到 npm | 2026-09-27 发布 `dsh-browser-service@0.4.0`，同日重发 `@0.4.1`（见上）。在一次性隔离 `DSH_HOME` 里实测短命令 `dsh plugin --profile np add dsh-browser-service@latest`：bundles 追加本包、`--dump-config` 出 `# == dsh-browser-service` 层与 `browser`（`browserProvider: cdp-daemon`）/`tool-browser`/`browser-cdp` 三行，装进来的 `bin/browsersvc.mjs` 为 755 |

验收：`verify-daemon.mjs` 31 → **32**、`verify-provider.mjs` 86 → **88**、`verify-bundle.mjs` 重写为 **23 项**（+ npm 短命令安装实测）：单一交付物形状、`add` 后 `--dump-config` 四行齐全且无 `not found`、默认自启指向包内 bin、转出口形状比对、`remove` 清理。隔离 web 模板 profile 里跑通了真实的 DSH 内端到端。

## [0.3.3] — 2026-09-27

按 DSH 官方《打包与安装插件》（官方仓库 `deepseek-ai/deepseek-harness` 的 `docs/user/develop/basic/publish.zh.md`）逐条核对本包的打包/安装路径，修掉 4 处不符合、未文档化或写错的地方。

| # | 项 | 影响 | 处理 |
| --- | --- | --- | --- |
| B1 | 文档里的安装命令语法错误 | `dsh plugin add <pkg>` 少了必需的 `--profile`（`dsh plugin --help` 里 `--profile <name>` 是 required）⇒ 照抄必然失败 | 改为官方形式 `dsh plugin --profile <name> add <包名\|tarball>`，并写明 tarball 是官方推荐的「免构建授权」交付形式 |
| B2 | 组合包的**安装顺序**是硬要求，但此前只写在内部分析里 | `browser`/`browser-electron`/`tool-browser` 三行由第三方组合包 `dsh-builtin-browser` 插入，当时的插件子包 patch 第 2/3 条按 id 覆盖它们；子包的层若排在 seam 包之前，loader 只打印 `patch: entry "browser" not found` 并静默丢弃覆盖行 ⇒ seam 仍选内置 Electron provider（「装上了但没生效」，没有任何报错） | patch 头注释与安装文档写清前提与校验期望；v0.4.0 起改为**本包自己插入这三行**（见 0.4.0），顺序问题随之消失 |
| B3 | `@deepseek-ai/cordis` 声明为可选 peer，但从未使用 | 官方 peer 规则是「需要与宿主共享实例」才声明；本插件零 import cordis，loader 也不校验范围 ⇒ 纯噪声 | 删除 `peerDependencies` / `peerDependenciesMeta` |
| B4 | 工具数一度被改回 32（**自我回归**） | 数工具的命令 `grep -o "name: 'browser_[a-z_]*'"` 的字符类漏了数字，`browser_a11y` 被静默漏掉 ⇒ 32；照这个数改文档，就把上一轮 `dd45fca` 的正确修正又翻了回去 | 以**运行期**实测为准：用 stub `ctx` 跑 `tool-browser` 的 `apply()`，`ctx.tools.register` 收到 **33** 个 `browser_*` 工具（含 `browser_a11y`）；全文统一为 33，并记下这个陷阱 |

新增验收：`scripts/verify-bundle.mjs`（16 项起）—— 一次性隔离 `DSH_HOME` 里跑官方流程。打包命令改为官方推荐的 `pnpm pack`。

## [0.3.2] — 2026-09-27

v0.3.1 上线后按「停掉守护进程 → 再调用浏览器」验证，发现最后一条只在运行进程里才会暴露的缺陷：

| # | 缺陷 | 复现/影响 | 修复 |
| --- | --- | --- | --- |
| F25 | 自启「每进程只允许一次」的开关连上之后不复位 | 守护进程消失（按 `idleMs` 空闲自杀、崩溃、被 OOM 杀、手动 `browsersvc stop`）而 DSH 还活着时，provider 直接报 `browser: 无法连接 CDP 端点 http://127.0.0.1:9333（… ECONNREFUSED …）；请先运行 browsersvc start`，**再也不自启** ⇒ 浏览器一直不可用，直到重启 DSH | 连接成功后把 `#autoStarted` 复位。防风暴不受影响：同一轮失败仍只自启一次（自启后仍连不上就保持锁定，不会反复拉起） |

新增验收：`verify-provider.mjs` 83 → **86**（冷启动自启一次后连上、守护进程消失后能再次自启、自启仍失败时不反复拉起）。三条断言都先在修复前跑过并确认会失败（旧代码 `autoStart` 只被调用 1 次）。

## [0.3.1] — 2026-09-27

v0.3.0 装进运行实例后按「重启 → 真实调用浏览器」验证，又暴露出 4 条只有活实例才能撞到的缺陷，以及 1 条验收脚本自身的残留：

| # | 缺陷 | 复现/影响 | 修复 |
| --- | --- | --- | --- |
| F19 | provider 自启后重试不带新 token | 冷启动（状态文件里还没有 token）时第一次 `connectOverCDP` 失败 → `autoStartCommand` 拉起守护进程并写入新 token → 重试仍用**旧**（空）token ⇒ 必 401，浏览器冷启动后第一次调用不可用 | token 读取移进每次 `connectOverCDP` 尝试内部（`#attach` 的 `attach()` 闭包），每次重试重读状态文件 |
| F20 | 请求头超时定时器未撤，10s 后拆掉长连接 | 连接建立 10s 后 `proxy: 408 request headers timeout` → `settle()` → `destroyBoth()`，CDP WebSocket 长连接被误杀；表现为「会话内没有可用标签页」、`/json/list` 只剩 about:blank | 请求头解析成功后立刻 `clearTimeout(headTimer)` |
| F22 | 连接被换掉后会话永久失效 | 守护进程重启 / F20 拆线 / 内核崩溃后，旧 context/page 随旧连接失效，而内置工具层按 task **永久缓存** session id 且从不重开（`ensureSession`）⇒ 之后每一次 `browser_*` 调用都报「会话内没有可用标签页」，直到人工 `browser_reset_session` 或重启 DSH | 所有会话操作前先走 `#liveSession(id)`：连接不是同一条、或当前标签页已死时，在新连接上按原 session id 重建 context+page（审计历史 `history` 保留） |
| F23 | `browsersvc restart` 变成「只停不起」 | `print()` 内部 `process.exit()`，`restart` 里 `await stop(...)` 打完 JSON 就退出，`start` 永不执行：实例被停掉却报 `stopped: true` 收场 | `start`/`stop` 增 `quiet` 模式（返回结果而不打印/退出，成功后**立即返回**而不是继续轮询到超时），`restart` 用 quiet 跑两步再统一输出 `{restarted, stopped, started}` |
| F24 | 验收脚本 restart 后收不干净 | `verify-provider.mjs` 的 `shutdown()` 只杀自己 spawn 的子进程，F22 用例重启出来的实例不是它 ⇒ 残留守护进程占着端口（下次运行 `EADDRINUSE`）+ 残留内核 | `shutdown()` 末尾再走一次 CLI `stop --root=<root>`（带 F3 身份校验），覆盖重启出来的实例 |

新增验收：`verify-provider.mjs` 77 → **83**（守护进程 restart 真的停旧起新、token 换新、重启后同一个 session id 仍可 execute/导航、连接重建后会话复活），`verify-daemon.mjs` 26 → **31**（隔离 root 真实跑 `start → restart → stop`、restart 后 token 换新、restart 后的实例可正常 stop）。

## [0.3.0] — 2026-09-27

独立代码审查（隔离脚本 + 复核）逐条复现后修复，按严重度：

| # | 缺陷 | 复现/影响 | 修复 |
| --- | --- | --- | --- |
| F1 | `savePath` 无准入门（严重） | 任意绝对路径写入、`../` 逃逸并自动建目录、静默覆盖已有文件 | provider 加 `#admitSavePath`（镜像内置语义：绝对路径 / `downloadDir` 内 / 不覆盖），截图与下载都走它 |
| F2 | 启动失败泄漏内核（严重） | `EADDRINUSE` 后孤儿 chromium 存活、无状态文件可回收 | 启动主流程包 `try/catch` → `shutdown('startup-failed')`；`spawn` error 钩子；未就绪先杀内核再抛 |
| F3 | `stop` 无身份校验（严重） | pid 复用/陈旧状态文件时可向陌生进程发 SIGKILL | `stop` 先读 `/proc/<pid>/cmdline` 校验（supervisor 含 `browsersvc.mjs`、内核含 `--remote-debugging-port=<内部端口>`），不匹配则拒绝并保留状态文件，`--force` 才强杀 |
| F4 | 内核不可执行时行为不明 | 崩栈/静默 | `assertKernelExecutable`（存在 + 普通文件 + `X_OK`），在 spawn 之前 |
| F5 | 连接计数被半关连接卡住 | 上游 `allowHalfOpen` 时 `connections` 恒 ≥1 ⇒ 空闲回收永不触发 | 计数改由首次认证通过时 +1、任一侧 close/error 一次性释放（幂等）+ 5s 兜底强拆 |
| F6 | 并发 `open` 重复握手 | 旧连接被覆盖后不再关闭；旧连接迟到的 `disconnected` 会清掉新连接 | `#connecting` 单飞 + `#conns` 集合，`disconnected` 只清自己那条，`dispose` 关闭全部 |
| F7 | 公开端口无凭据、无路径白名单（中等） | 同机任意进程可完全操控浏览器、读 cookie | Bearer token 门 + 方法/路径白名单（`/json/new\|close\|activate` 一律 403）+ 改写 `webSocketDebuggerUrl` 走代理 |
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

## 0.3.0 之前

0.1.x / 0.2.x 是本项目自己的内部迭代（守护进程雏形 → 回环代理与空闲回收），没有对外发布，未在此记录。
