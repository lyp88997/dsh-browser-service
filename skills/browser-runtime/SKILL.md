---
name: browser-runtime
description: 当浏览器工具报错（no usable browser provider / 无法连接 CDP 端点 / 401 / 会话内没有可用标签页）、截图纯白、中文变方块、dsh 重启后浏览器失效，或需要起停/诊断 browsersvc 守护进程、重建/迁移用户态 Chromium 运行时、修改 browser provider 配置或回滚时使用 —— 含 browsersvc CLI 速查、安装/升级（一条命令）、状态文件与凭据门、非 root 重建脚本、排障表与两条必知机制（bundles 与 patch 双注册）
whenToUse: 浏览器不可用 / 渲染异常 / dsh 重启后失效 / 需起停或诊断 browsersvc / 需重建运行时或改 provider 配置时
disable-model-invocation: true
---

# browser-runtime — 浏览器服务、用户态 Chromium 与 dsh 配置运维

> 姊妹技能 `browser` 讲**怎么用**；本技能讲**怎么修、怎么起停、怎么重建、怎么改配置、怎么回滚**。
> 2026-09-30 实测校正：DSH 0.1.5-rc.3 + `dsh-browser-service` **v0.8.1**（仓库 `lyp88997/dsh-browser-service`，public，本地 `/home/node/DSH/dsh-browser-service`）。本技能的**文件本体随包发布**（`skills/browser-runtime/`），装包时由插件自动同步到 `$DSH_HOME/skills/`（带归属台账，你自己改过的那份不会被覆盖，见文末「随包技能」）。
> 同日重启 DSH 后做了**活实例复核**（四条全过）：① 首次用浏览器时自启的守护进程 cmdline 为 `…/profiles/web/node_modules/dsh-browser-service/bin/browsersvc.mjs run --idle-ms=300000`（走 profile 里装的那份 + 插件默认带 idleMs）；② `maxTabs` 默认 5 真的拦：第 6 个 `browser_open {newTab:true}` 报 `BROWSER_TAB_LIMIT`；③ 关闭会话后 CDP 连接立刻断；④ 守护进程在启动后约 298 秒按 `idle-ms=300000` 退出、内核 11 个进程一起回收、cgroup 内存 1814MB → 1181MB。

## 安装 / 升级（v0.4.0 起：一个包装完）

```bash
# 装 / 升级：两种等价来源择一（provider + 33 个工具面 + 守护进程 CLI 全在这一个包里）
dsh plugin --profile web add dsh-browser-service@latest                        # A) npm（0.4.3 起有代码变更、0.4.4 修 F27、0.5.0 收口资源（`maxTabs` 上限 + 无会话时释放连接）、0.5.1 做 DSH 版本适配（启动期能力探测 + 多版本实测矩阵）、0.6.0 加可观测性与网页面板（`ops`/`console`/`network`/`har`/`cookies` 五个 CLI + 右下角浮动看板，**零新增工具**）、0.7.0 加实时交互网页窗口（面板「网页」标签＝实时画面，可点/滚/打字/地址栏跳转，只对本机回环开放，**零新增工具**）、0.8.0 重做窗口与入口（可拖动/可缩放的浮动窗口 + 左侧一竖排入口 + 设置区与只读服务信息 + 取帧画质/最大边随请求透传并被服务端夹取，**零新增工具**）且同版追加一轮界面美化与体验修补（P6：设计令牌跟随主题、胶囊默认左上且可换四角、日志手动/自动清理、地址栏跳转自动开会话并把失败原因显示出来、入口换 SVG 图标 + 键盘导航）；**0.8.1 收口界面与外观**（P6 界面美化与体验修补、P7 分辨率/胶囊坐标可调 + 清理可见化、P8 窗口外观可定制（边框色/不透明度/玻璃效果）+ 设置改成「草稿 + 显式保存」，并把两份全局技能随包发布：`skills/` + `browsersvc skills --install` + 插件启动自动同步）；latest = 0.8.1）
dsh plugin --profile web add https://github.com/lyp88997/dsh-browser-service/releases/latest/download/dsh-browser-service.tgz   # B) Release 资产（永不过期地址）
# 之后必须重启 DSH（插件模块在 boot 时 import）；再校验组合：
dsh --profile web --dump-config | grep -E 'browserProvider|patched by|not found'
```

- 期望：`browserProvider: cdp-daemon`、`patched by dsh-browser-service`；`browser-electron` / `playwright-browser` 两条守卫行会打印 `not found`（只装本包时这两个 id 不存在，无害）。
- 接缝依赖 `dsh-builtin-browser` 已写进本包 `dependencies`（33 个 `browser_*` 工具经 `./browser`、`./tool-browser` 转出）⇒ **别再单独 `add dsh-builtin-browser`**（会出现两条 `tool-browser` 行、工具重名）。
- **别用旧名 `dsh-browser-cdp`**：npm 上同名包是别人的（drscrewdriver 0.17.4），写了会装到别人家；本包 npm 名就是 `dsh-browser-service`，0.4.0 起已发布，所以能写 `dsh-browser-service@latest`。
- 从源码装：`dsh plugin --profile web add github:lyp88997/dsh-browser-service`（pnpm 现场构建，需 profile 允许构建）。
- 手写 patch 与 bundle 路线**二选一**（见下面「两条必知机制」）。

## 现在是什么结构

```
33 个 browser_* 工具（内置 dsh-builtin-browser/tool-browser）
  └─ ctx.browser seam（browserProvider = cdp-daemon）
      └─ 插件 dsh-browser-service（providerId=cdp-daemon，v0.8.1；一个包＝provider + 守护进程 CLI + 网页面板（含实时窗口）+ 两份随包全局技能）
          └─ playwright-core connectOverCDP → 127.0.0.1:9333（Bearer token）
              └─ browsersvc supervisor（代理 + 门禁 + 内核生命周期）
                  └─ chrome-headless-shell 154.0.8037.57（经 chromium-wrapper.sh）
```

- **为什么不用内置 Electron provider**：`dsh-builtin-browser` 的 Electron 探测路径 `profiles/web/node_modules/electron/dist/electron` 从未下载（目录里只有 cli.js/install.js），报 `no usable browser provider is registered`；本机无 root、无 GUI 库、seccomp 下 Chromium 沙箱也起不来。
- **为什么不用 `dsh-playwright-browser`**：它自带 10 个与内置**同名**的 `browser_*` 工具（工具名冲突），必须停用；停用后内置 33 个工具全回来（含 execute/a11y/scrape/download）。

## browsersvc CLI 速查

`node /home/node/DSH/dsh-browser-service/bin/browsersvc.mjs <cmd>`

| 命令 | 说明 |
| --- | --- |
| `status` | 读状态文件 + 探测公开端口；输出 `running/healthy/port/internalPort/pid/browserPid/kernel/browserVersion/wsEndpoint(带 token)/startedAt/idleMs/logFile` |
| `start` | 起后台单例（幂等）；成功打印 `{started:true,…}`，失败打印 `{started:false,error,…}` 并 exit 2 |
| `stop [--force]` | 先做身份校验（`/proc/<pid>/cmdline` 含 `browsersvc.mjs`、内核含 `--remote-debugging-port=<内部端口>`）；不匹配就拒绝且**保留**状态文件，`--force` 才强杀 |
| `restart` | 停旧起新，输出 `{restarted:true,stopped:true,started:true,…}` |
| `logs [--lines=60]` | 打印日志尾部（`--lines` 必须正整数） |
| `detect` | 列出探测到的内核候选与解析后的配置 |
| `ops [--lines=20] [--json]` | **v0.6.0 起**：最近 N 次浏览器操作（动作 / 耗时 ms / 成败 / 错误原因 / 会话+标签），读 `$ROOT/ops.jsonl` |
| `console [--lines=40] [--json]` | 控制台输出与 `pageerror`（文本截 500 字），读 `console.jsonl` |
| `network [--lines=40] [--json]` | 请求两阶段（request/response，带状态码与耗时；`requestfailed` 单独标），读 `network.jsonl`（不记头与体） |
| `har [--session=s1] [--out=file]` | 会话 HAR（关闭会话时落盘 `$ROOT/har/<时间戳>-<会话>.har`，留最近 10 份）；不带 `--out` 只报路径与字节，带则复制且拒绝覆盖 |
| `cookies [--url=…] [--json\|--export=file\|--import=file]` | cookie/localStorage 导出注入：走浏览器级 CDP 会话 + 真实 `browserContextId` + `Storage.getCookies/setCookies`（**不依赖 DSH 会话**）；导出文件 0600、拒绝覆盖；`--json` 空也 exit 0 |
| `run` | 前台跑 supervisor（`start` 内部用它） |
| `skills [--install] [--force] [--dir=…] [--json]` | **v0.8.1 起**：查看/安装随包全局技能（默认目标 `$DSH_HOME/skills`）。不带 `--install` 只报每个文件的状态（缺失/已最新/可升级/你改过/非本包）与待处理数；`--install` 幂等落盘，被用户改过的副本跳过（`--force` 才覆盖），台账写在目标目录的 `.dsh-browser-service.skills.json` |

- 参数：`--root`（默认 `$DSH_HOME/browser-service`）、`--port`（默认 9333）、`--idle-ms`（默认 900000，允许 1000..86400000）、`--kernel`、`--wrapper`、`--start-timeout`、`--internal-port-base`、`--user-data-dir`。
- env：`DSH_BROWSER_SVC_ROOT` / `DSH_BROWSER_SVC_PORT` / `DSH_BROWSER_SVC_IDLE_MS` / `DSH_BROWSER_CHROME` / `DSH_BROWSER_WRAPPER`；也可写 `$ROOT/config.json`。优先级 CLI > env > config.json > 自动探测；非整数/越界会被拒。
- 内核只会绑 `127.0.0.1`（本机是 host 网络，**别**把 CDP 端口改到 0.0.0.0）。

## 运行时状态与门禁（默认 root `/home/node/.dsh/browser-service`）

| 项 | 说明 |
| --- | --- |
| 进程 | supervisor（`browsersvc run`）+ 内核；内核 ppid = supervisor。空闲 `idleMs`（默认 15 分钟 = 900000ms）**无客户端连接**时 supervisor **自杀**（正常行为）。⚠️ 0.5.0 起：**最后一个会话关闭后插件主动断开 CDP 连接**，之后 supervisor 才可能按 `idleMs` 空闲自杀（插件自启默认 5 分钟）；下一次调用自动拉起。会话期间不回收（避免每次冷启动 ≈ 3s）；要立刻释放就 `browsersvc stop`（标签页随之清空）。2026-09-28 活证：自启 cmdline 带 `--idle-ms=300000`，关闭会话后实测 ~298s 退出 |
| `service.json` | 状态 + `token` + `listening`，**0600**；token 每次启动随机生成 |
| `ops.jsonl` / `console.jsonl` / `network.jsonl` | v0.6.0 起的观测日志（环形上限 1/1/2 MiB，超限保尾部一半；IO 异常一律吞掉不动浏览器调用），0600 |
| `har/` | 每个会话的 HAR（`<时间戳>-<会话>.har`，留最近 10 份） |
| `service.log` | supervisor/内核日志 + 代理拒绝记录，0600 |
| `profile/` | 内核 userDataDir（0600 目录）；cookie 明文 |

公开端口门禁：必须 `Authorization: Bearer <token>`；只放行 `GET /json/version|/json/list|/json/protocol` 与 `/devtools/*`（`/json/new|close|activate` 一律 403）；`/json/version` 的 `webSocketDebuggerUrl` 被改写成代理地址并附 token，所以调用方绕不开代理；**同一条连接上的后续请求不免检**（只有 CDP WebSocket 保长连接，其余请求按 `connection: close` 转发、响应后即关 —— F27）。

## 自愈行为（v0.3.1/v0.3.2 起，别当故障报）

- 守护进程不在时，插件按 `autoStartCommand` **自启一次**（失败不反复拉起）；连接成功过之后开关复位，所以守护进程空闲自杀/崩溃后**还能再自启**。
- CDP 连接被换掉（守护进程重启、拆线、内核崩溃）后，插件的会话会在新连接上**按原 session id 重建**，工具层的 session id 继续可用。
- token 在每次 attach 时重新读 `service.json` ⇒ 守护进程换 token 后插件能跟上（冷启动第一次调用也不会 401）。
- 长连接不再被 10s 的头部超时误杀（代理只在收全请求头之前计时）。

## dsh 侧配置：两条路线

- **正常安装（bundle 路线）**：此节不用手改。包自带的 `plugin/cordis.patch.yml` 会插入三条行（`browser-cdp` / `browser` / `tool-browser`），并给 `browser-electron`、`playwright-browser` 加 `disabled: true`。
- **手写 patch 路线（只用于改本仓库源码时）**：前提是 profile 的 `node_modules/` 能解析到片段里的 `name` —— 改源码就先 `ln -sfn /home/node/DSH/dsh-browser-service $DSH_HOME/profiles/web/node_modules/dsh-browser-service`；片段写在 `$DSH_HOME/profiles/web/cordis.patch.yml` **尾部**。

```yaml
- insert:
    - id: browser-cdp
      name: dsh-browser-service
      config:
        cdpUrl: http://127.0.0.1:9333
        connectTimeoutMs: 30000
        # autoStartCommand 可省：v0.4.0 起默认用包内 bin/browsersvc.mjs 自启
- id: browser
  config: { browserProvider: cdp-daemon }
- id: browser-electron
  disabled: true
- id: playwright-browser
  disabled: true
- id: univer
  config: { browserExecutablePath: /home/node/DSH/.browser/chromium-wrapper.sh }
```

插件侧可配键（`dsh-browser-service`；权威定义是 `plugin/lib/index.js` 的 Config，完整表见仓库根 `README.md` 的「配置」节 —— 配置表已从 `plugin/README.md` 上移）：`providerId`、`cdpUrl`、`cdpToken`、`downloadDir`、`connectTimeoutMs`、`autoStartCommand`、`autoStartTimeoutMs`、`actionTimeoutMs`、`navigationTimeoutMs`、`lookupTimeoutMs`、`snapshotMaxElements`、`contentMaxChars`、`viewportWidth`、`viewportHeight`、`captureConsole`/`captureNetwork`（默认都开：是否录控制台与网络；关掉网络捕获就不录 HAR）、`maxTabs`（默认 5，夹 1..50：单会话标签上限，超限报 `BROWSER_TAB_LIMIT`）、`idleMs`（默认 300000＝5 分钟，夹 1000..86400000：自启守护进程的空闲回收窗口，仅默认 `autoStartCommand` 时生效）。`skillsDir`（默认空＝`$DSH_HOME/skills`）与 `syncSkills`（默认 true：插件启动时把随包技能同步过去）。其中 `downloadDir` 未配置时（v0.4.3 起）＝系统 Downloads 目录（`XDG_DOWNLOAD_DIR` → 家目录下存在的 `Downloads`/`下载`/`下載` → `~/Downloads`，首次写入时建目录），截图/下载的 `savePath` 必须落在其中。

### ⚠️ 两条必知机制（踩过）

1. **热加载只重读 patch 文件，不重读 `dsh.profile.bundles`**（`profile-boot-*.js` 的 `composeLive()` 用 boot 时冻结的 bundle patches）。改 `cordis.patch.yml` 才可能热生效；改 `bundles`、改插件代码、升级插件版本**都必须重启 dsh**（完整 web profile 上 patchReload 热重载会静默回滚，别信）。
2. **`insert` 不去重**（`dsh-app-boot/lib/index.js`：无 id 的 insert 直接 push）。若 `bundles` 注册了插件、patch 里又 `insert` 同 id，**下次重启会出现两条同 id 条目**。
   - 现状（本机活 profile，**2026-09-27 起已切 bundle 路线**）：`dsh.profile.bundles` **含** `dsh-browser-service`（`dsh plugin --profile web add dsh-browser-service@latest` 装的 0.4.x）；手写 patch 里的浏览器块已删（`cordis.patch.yml` 只剩 `univer` 一行），`node_modules/dsh-browser-cdp` 软链已删；同时移除了 `dsh-builtin-browser`（改由本包依赖提供）与 `dsh-playwright-browser`。切换前备份：`package.json.bak-pre-bundle`、`cordis.patch.yml.bak-pre-bundle`（回滚见「回滚 / 清理」）。
   - 插件包自带 `"dsh": {"bundle": {"patch": "./cordis.patch.yml"}}`：若改走 bundle 路线（`dsh plugin add`），必须**同时**从手写 patch 里删掉这段 `insert`。二选一，绝不能同时。

## 排障表

| 现象 | 根因与处理 |
| --- | --- |
| `no usable browser provider is registered` | provider 没进组合树：查 patch 的 `insert`、插件是否在 `profiles/web/node_modules/`、是否需重启 dsh |
| `browser: 无法连接 CDP 端点 …ECONNREFUSED…；请先运行 browsersvc start` | 守护进程没起且自启失败：`status` → `start`，看 `service.log` 尾部；确认 `autoStartCommand` 路径没写错 |
| `Unexpected status 401`（attach / curl `/json/version`） | token 不匹配：插件与守护进程升级不同步、或两边 root 不一致。先重启 DSH（插件重读状态文件）再 `browsersvc restart`；或显式配 `cdpToken` |
| `EACCES: permission denied, open '…/service.log'` | 从受沙箱限制的 shell 调 `browsersvc start`：写 `$DSH_HOME` 需要一次 `danger-full-access` 提权，或干脆让插件自启 |
| `browser: 会话内没有可用标签页` | 连接被换掉后的旧会话（v0.3.1 起会自愈）。仍报就 `browser_reset_session`，或重启 DSH |
| `EADDRINUSE … 127.0.0.1:9333` / `no free port from 9300` | 端口被占：`status`/`logs` 找残留实例，或 `--port` / `--internal-port-base` 换端口 |
| `浏览器内核不存在 / 不可执行` | `--kernel` 指错，或内核没下全（见重建）；包装器必须可执行 |
| `error while loading shared libraries: libglib-2.0.so.0`（exit 127） | 直接跑了真二进制：必须经 `chromium-wrapper.sh`；或 `libs/` 不全 → 重跑 `setup-libs.sh` |
| `ldd` 有 `not found` | `LD_LIBRARY_PATH` 必须**两个目录都给**：`libs/usr/lib/x86_64-linux-gnu` **和** `libs/lib/x86_64-linux-gnu` |
| `FATAL:…zygote_host_impl_linux.cc] No usable sandbox!` | 容器 `NoNewPrivs=1` + seccomp ⇒ 必须 `--no-sandbox`（包装器已带） |
| 渲染崩溃 / 共享内存错误 | `/dev/shm` 只有 64M ⇒ 必须 `--disable-dev-shm-usage`（包装器已带） |
| 截图纯白 | 没给 fontconfig ⇒ `FONTCONFIG_FILE=/home/node/DSH/.browser/fonts.conf`（包装器已带） |
| 中文全方块；两张等长不同汉字截图指纹完全相同 | 缺 CJK 字体 ⇒ `setup-libs.sh` 种子加 `fonts-noto-cjk` 重跑 |
| 重启 dsh 后浏览器又坏 / 出现两条同 id 条目 | `bundles` 与 patch 双注册，见机制 2 |
| 图片读不出来（`vision engine failed`） | 与浏览器无关：本机 `modlens` 视觉桥 → `npx @liustack/modlens doctor` |

## 改完代码/配置怎么验

```bash
cd /home/node/DSH/dsh-browser-service
node scripts/verify-daemon.mjs     # 守护进程 + CLI：35/35
node scripts/verify-provider.mjs   # provider：116/116（P7 段 6 项：分辨率初值/新会话沿用/真页面重排/越界夹取/非法值报错）
node scripts/verify-bundle.mjs     # 组合包/安装（含客户端半边 5c：19 项几何夹取、面板间距、设置规整、胶囊四角与自定偏移、补协议、写路由引用、外观 CSS 变量与颜色规整；第 6 段随包全局技能 8 项 + tarball 技能文件 1 项）：61/61
node scripts/verify-data.mjs       # 观测面 + 实时窗口（六条路由与三道闸；P5 取帧参数透传/夹取、panel.json 服务信息；P6 日志清理与无会话跳转；P7 分辨率写路由 + 「缺 maxh 不塌到 240」回归）：86/86
node scripts/verify-matrix.mjs --dsh dsh --smoke   # DSH 版本矩阵：4 个宿主版本 × 12 项
node /home/node/DSH/dsh-browser-service/bin/browsersvc.mjs status   # running/healthy + wsEndpoint 带 token
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:9333/json/version   # 期望 401（无 token 必须被拒）
ps -eo pid,ppid,args | grep -m1 '[c]hrome-headless-shel[l]'   # 内核 cmdline 全为 .browser/...，ppid=supervisor
```

两套脚本都用隔离 root/端口，不碰运行中的实例（verify-provider 会临时起自己的守护进程）。插件代码改动必须**重启 DSH** 才会进活实例。

## 运行时目录清单（`/home/node/DSH/.browser/`，2026-09-28 清理后实测 389MB）

| 路径 | 作用 | 大小 |
| --- | --- | --- |
| `chromium-wrapper.sh` | **启动包装器**：export `LD_LIBRARY_PATH` + `FONTCONFIG_FILE`，`exec` 真二进制并追加 `--no-sandbox --disable-dev-shm-usage` | 1KB |
| `chromium/chrome-headless-shell` | 稳定符号链接 → `puppeteer/chrome-headless-shell/linux-154.0.8037.57/chrome-headless-shell-linux64/chrome-headless-shell` | — |
| `libs/` | 用户态系统库前缀（43 个 .deb 解包，含中文字体） | 126MB |
| `fonts.conf` | fontconfig：`<dir>`→`libs/usr/share/fonts`，`<cachedir>`→`fontcache` | 小 |
| `puppeteer/` | `@puppeteer/browsers` 下载的 chrome-headless-shell | 263MB |
| ~~`moli/`~~ | 早期尝试的 `moli` 浏览器二进制（**本服务不引用**）：2026-09-28 已删（-101MB） | 0 |
| ~~`profile/`、`daemon-profile/`、`pw/`~~ | 早期运行时的 userDataDir / 验证依赖残留（现役的在 `$DSH_HOME/browser-service/profile`）：2026-09-28 已删（-16.5MB） | 0 |
| `screenshots/` | 历史截图落盘目录 | 284KB |
| `setup-libs.sh` | **重建脚本**（apt-get download → dpkg-deb -x，非 root） | 2KB |
| `cordis.patch.yml.a1-backup` | 回到旧 A1 方案（`dsh-playwright-browser`）的 patch 备份 | 4.6KB |
| `browse.mjs`、`verify-cjk.mjs`、`verify-daemon.mjs` | 逃生舱与验证脚本（本技能 `scripts/` 下有副本） | 小 |

包装器可被覆盖：`DSH_BROWSER_PREFIX` / `DSH_BROWSER_FONTCONF` / `DSH_BROWSER_CHROME`。
内核 userDataDir 归守护进程管（`$ROOT/profile`，默认 `~/.dsh/browser-service/profile`），不再是 `.browser/profile`。

## 重建 / 迁移（无 root）

```bash
cd /home/node/DSH/.browser
./setup-libs.sh                       # 1) 用户态系统库（42–43 包，约 124MB，含中文）
cd /home/node/.dsh/profiles/web/node_modules/.bin
./browsers install chrome-headless-shell@stable --path /home/node/DSH/.browser/puppeteer   # 2) 内核（.bin/browsers = @puppeteer/browsers 的 CLI，已核实存在）
ln -sfn /home/node/DSH/.browser/puppeteer/chrome-headless-shell/linux-<版本>/chrome-headless-shell-linux64/chrome-headless-shell \
        /home/node/DSH/.browser/chromium/chrome-headless-shell
# 3) 校验
W=/home/node/DSH/.browser
LD_LIBRARY_PATH=$W/libs/usr/lib/x86_64-linux-gnu:$W/libs/lib/x86_64-linux-gnu \
  ldd $W/chromium/chrome-headless-shell | grep -c 'not found'      # 期望 0
$W/chromium-wrapper.sh --dump-dom https://example.com | grep -o '<title>.*</title>'
node $W/verify-cjk.mjs                                             # 期望「纯汉字截图互不相同」
```

`setup-libs.sh` 要点：非 root 走 `apt-get -o Dir::State::Lists=/tmp/aptl/lists -o Dir::Cache=… -o Dir::Cache::archives=… download` + `dpkg-deb -x`；种子含 `libnss3/libgbm1/libglib2.0-0/libX11…` + `fonts-liberation` + **`fonts-noto-cjk`（必需，否则中文是豆腐块）**；`PRUNE_RE` 排除 `libc6/libgcc-s1/libstdc++6` 等，**避免 LD_LIBRARY_PATH 覆盖系统 ABI**。

## 回滚 / 清理

```bash
# 回到旧 A1 方案（dsh-playwright-browser + 用户态内核）
cp /home/node/DSH/.browser/cordis.patch.yml.a1-backup /home/node/.dsh/profiles/web/cordis.patch.yml
# 从 bundle 路线退回手写 patch 路线（用 2026-09-27 切换前的备份；两条路线二选一）
cd /home/node/.dsh/profiles/web
cp -a package.json.bak-pre-bundle package.json
cp -a cordis.patch.yml.bak-pre-bundle cordis.patch.yml
dsh plugin --profile web add dsh-builtin-browser && dsh plugin --profile web add dsh-playwright-browser
ln -sfn /home/node/DSH/dsh-browser-service node_modules/dsh-browser-service

# 彻底移除自建 provider
node /home/node/DSH/dsh-browser-service/bin/browsersvc.mjs stop
dsh plugin --profile web remove dsh-browser-service
```

`libs/`、`chromium/`、`chromium-wrapper.sh`、`fonts.conf` 是运行必需；`pw/`（仅验证用）、`univer-probe*.univer` 可删。

## 安全与边界

- 公开端口只绑回环并要求 Bearer token；但同机同 uid 仍能读 `service.json` 拿 token ⇒ token 是防误连/防盗用，**不是**多租户边界。
- `--no-sandbox` ⇒ 页面以 dsh 进程权限运行；只访问可信站点，别在共享 `profile/` 里登录敏感账号（cookie 明文）。
- 写 `$DSH_HOME` / `/home/node/DSH/.browser` 超出默认 workspace-write 沙箱 ⇒ 需要一次 `danger-full-access` 提权；且**不能从承载当前会话的进程里重启 dsh 自己**。
- 版本适配实测边界：启动期会校验接缝导出面（`plugin/lib/compat.js`），不符只打印一句人话并安静退出。已实测矩阵（`scripts/verify-matrix.mjs`，每版本 12 项、含真开 example.com）：**0.1.5-rc.3 / 0.1.7-rc.1 / 0.1.7-rc.2 / 0.1.6-alpha.2 全 12/12**；接缝 `dsh-builtin-browser` 实测面 0.1.22。**并在活实例复核过**（DSH 0.1.5-rc.3 + 本包 0.5.1，2026-09-28）。未复测：更早的 0.1.0-rc.x、macOS / Windows。
- **网页面板是可选件**（v0.6.0 起）：宿主半边用 `ctx.inject(["webServer"], …)` 挂一条只读 JSON 路由，没有 `webServer` 或 ctx 上没有 `inject` 时只打一行 info 就跳过，**provider 不受影响**（隔离矩阵会把「无 inject 的 ctx」也跑一遍）。挂载要**重启 DSH**；之后只改 `plugin/client.js`（客户端半边）不必重启，刷新页面即可。v0.7.0 起同一个 `plugin/lib/panel.js` 还挂三条**实时窗口路由**（`live.jpg` / `live.json` / `live`），走三道闸：只认回环地址（非本机 403）、方法白名单（405）、`POST`/`DELETE` 要求同源（跨站 403）；面板客户端因此多一个默认打开的「网页」入口，帧流是长轮询（静止页面不产生帧）。v0.8.0 起窗口可拖动/可缩放（右下角手柄）/双击标题栏最大化，位置大小记 localStorage（设置里可关）；入口改成左侧一竖排（网页/操作/控制台/网络/设置）；设置区可调取帧**质量**（10–95）与**最大边**（320–1920 / 240–1200），随 `live.jpg?quality=&max=&maxh=` 下发、服务端越界夹取，**改完不用重启**（下一次取帧生效，响应头 `x-frame-quality` / `x-frame-max` 回执），`live.json` 多一个 `options` 字段、`panel.json` 多一个只读 `service` 块（版本/会话/CDP 地址/下载目录名/标签上限/空闲回收/录制开关/生效取帧参数，**不含绝对路径**）。P6 追加：同一个 `plugin/lib/panel.js` 多挂第**五**条路由 `POST /browser-service/logs`（`{action:'clear'|'trim', kind, keep}`，走同一套闸），清/裁三类观测日志（`src/opslog.mjs` 新增 `clearEntries(kind, {root, keep})`，未知类型抛错）；没有任何会话时 `live.json` 仍回 200 并给可操作提示，地址栏 `goto` 会先 `provider.open('面板地址栏')` 再 `openUrl()`（客户端补 `https://`，空串 400，失败原因显示在地址栏下方）。**这两处都在宿主半边（`panel.js` / `opslog.mjs`）⇒ 必须重启 DSH**；客户端半边的其余改动（胶囊四角、图标、失败提示）刷新页面即可。P7 追加：同一个 `panel.js` 再挂第**六**条路由 `POST /browser-service/viewport`（`{width,height}` → `provider.setViewport()`，夹在 640×360 ~ 3840×2160，对**已打开的每个页面** `page.setViewportSize` 并回 `applied`，之后新建的会话沿用；非法值 400），`panel.json.service.viewport` 回读当前值；设置区因此多「浏览器窗口分辨率」分段，胶囊多「水平/垂直偏移」（默认 15/48）、窗口多「面板间距」（默认 10，同时是 `clampRect` 的边距）与「层级基准」（内联 `z-index`：胶囊 = `zBase`、窗口 = `zBase + 1`）。**「自动清理没生效」的真因就是宿主半边还是旧版**：实测 `POST /browser-service/logs` 返回 405、`GET` 同路径 404（新路由压根没挂）⇒ 必须重启 DSH；客户端也不再静默——清理与自动清理的成功/失败都在窗口顶部出条提示，404/405 会明说「宿主半边是旧版，重启 DSH 后生效」。同批还修掉**画面糊**的真缺陷（用户报「分辨率调了，但画面还是很模糊」）：客户端取帧过去只发 `?quality=&max=`、**没发 `maxh`**，而 `clampInt` 里 `Number(null) === 0` 被当成「给了值」⇒ 高度上限算成下限 **240**；CDP 的 `Page.startScreencast` 是「等比缩到 `max × maxh` 的框里」，于是 1920×1080 的页面被压成 384×240 再由界面放大 ⇒ 糊。现在：`clampInt` 把 `null`/空串一律当**没给**（宿主与客户端同一份语义）、客户端改发 `maxh=最大边`（「最大边」＝长边上限，宽高同时封顶）、默认画质 70 → **85**、默认高度上限 800 → 1200。
P8 追加（**全在客户端半边 `plugin/client.js`，刷新页面即可，不用重启**）：设置页第一段「窗口外观」＝**边框颜色**（跟随主题 / 无边框 / 蓝紫绿琥珀红青六预设 / 取色器自定 `#rrggbb`，别的值回落主题色——值会进 CSS 变量所以先卡一道）、**背景不透明度**（40/60/80/95/100%，用 `color-mix(in srgb, 主题底色 N%, transparent)`，底色仍随暗/亮主题）、**玻璃效果**（关 / 毛玻璃＝blur(10px) saturate(1.15) / 液态玻璃＝blur(18px) saturate(1.65) + 斜向高光 + 内圈描边光，纯 CSS 近似），窗口与胶囊共用；纯函数 `appearanceStyle(settings, kind)` 算 `--bsp-*` 变量、`borderOf` 规整颜色；**内部分区也跟着透明**（标题栏/左侧入口/底栏/吸顶条用 `--bsp-surface`＝抬升层底色、列表吸顶条与分组标题用 `--bsp-card`＝外壳底色，分隔线 `--bsp-divider` 在自定义边框色时是同色调 45% 的浅色、跟随主题/无边框时保持宿主细线，`无边框` 只去掉最外圈那条）——否则外壳透了里面还是实心，看着就像「只有边框线在变」。设置同时从「即时落盘」改成**草稿 + 显式保存**：改动先按新值预览，点吸顶栏「保存」才写 `localStorage`（成功绿字「✓ 已保存：窗口外观立即生效，刷新页面也保留。」，写失败红字说明原因且草稿保留），未保存时琥珀提示 + 入口/胶囊小圆点，「恢复默认」同样要先保存；设置的写入通道是**补丁**（`onPatch` + 函数式更新），避免同一拍连点两个按钮时后者覆盖前者。验收：`verify-bundle` 50 → **52**（5c 段 17 → 19 项）；provider 116 / data 86 / daemon 35 / 矩阵 4×12 不变。**0.8.1 收口时 bundle 总数已到 61**（再加第 6 段「随包全局技能」8 项与 tarball 技能文件 1 项），其余四套计数不变。

## 随包技能（v0.8.1 起）

- 本技能与姊妹技能 `browser` **随包发布**在仓库 `skills/` 里（`browser/SKILL.md`、`browser-runtime/SKILL.md` + 后者 `scripts/` 的 5 个脚本，共 7 个文件）。
- 为什么非得落盘：DSH 的技能发现只认磁盘目录（项目 `.dsh/skills`、`$DSH_HOME/skills`、`~/.agents/skills`、宿主 bundled 目录），`package.json` 的 `dsh` 清单里**没有技能位**（`DshManifest` 只有 bundle/profile/client/configTrees/sessionFormatMigration/moduleFallback）⇒ 插件想让"装完就有全局技能"，只能把随包文件写进技能根目录。写的是 `$DSH_HOME/skills`（用户级根，rank 400，仅次于宿主自带 bundled），所以装完对所有工作区生效。
- 机制（`src/skills.mjs`）：目标不存在→装；与源逐字节相同→记为我们的；与台账里的旧哈希相同→我们的旧版，覆盖升级；**用户改过的 / 同名但不在台账里的→跳过并记一行 warn**，要覆盖得 `browsersvc skills --install --force`。幂等：内容一致时一个字节都不写。
- 插件启动时自动同步（`apply` 顶部，早于 provider 注册；整段失败只记日志、绝不影响 provider）。关掉用配置 `syncSkills: false`，换目录用 `skillsDir`。
- 手查/手装：`browsersvc skills`（状态）、`browsersvc skills --install [--force] [--dir=…] [--json]`。改完技能内容后不必重启 DSH 才生效（技能按需读取 + 文件监视）；但**新装**建议重启一次最稳。
- ⚠️ 你如果在本机直接改 `$DSH_HOME/skills/browser*/SKILL.md`，升级时会被台账识别为"你改过"而跳过——要么把改动提回仓库 `skills/`，要么用 `--force` 覆盖（丢弃本地改动）。
