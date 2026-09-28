# 验收与测试

三条脚本**零依赖**（只用 Node 内置的 `fetch` / `WebSocket` / `http` 与真实 `browsersvc` + 本地站点；`verify-matrix.mjs` 的 `--smoke` 需要能解析外网的 `example.com`）：

```bash
node scripts/verify-daemon.mjs      # M1 守护进程 + CLI 防御：35/35
node scripts/verify-provider.mjs    # M2 provider：110 通过，0 失败
node scripts/verify-bundle.mjs      # 组合包安装（官方 dsh plugin 流程）：33/33
node scripts/verify-matrix.mjs --dsh <bin> --dsh <bin> --smoke   # DSH 版本矩阵：4 个宿主版本 × 12 项
```

> ⚠️ **不要在默认 root 上跑**：脚本会按 pid 收敛自己起的实例并清理临时 root（`rmSync`）。它们默认使用 `/tmp` 下的一次性 `DSH_BROWSER_SVC_ROOT`，请保持默认，不要指向 `$DSH_HOME/browser-service`。

## 各套覆盖什么

**`verify-bundle.mjs`（33 项）** —— 在一次性隔离 `DSH_HOME`（`/tmp`）里真实执行官方安装/移除命令：交付物里只有一个包 → `add <tgz>` 追加依赖与层 → `--dump-config` 里本包层挂出 `browser`（`browserProvider: cdp-daemon`）、`tool-browser` 与 `browser-cdp`，且**三行都没有 not found** → 默认自启命令指向装进来的 `bin/browsersvc.mjs` → `./browser` / `./tool-browser` 转出口的导出键与 `dsh-builtin-browser` 源模块**完全一致** → 补出宿主 peer 目录（`scripts/lib/host-peers.mjs`，隔离 home 不会自动生成）后，包入口可 `import`、启动期探测（`plugin/lib/compat.js`）对真实接缝给出 0 error、四种坏形状各报对人、错误文案命中宿主与接缝版本，并静态数出接缝工具面 33 个且含 `browser_a11y` → `remove` 同时清掉依赖与层。不碰默认 profile。

**`verify-matrix.mjs`（4 个宿主版本 × 12 项）** —— 把**同一个 tarball** 分别装进 `--dsh <bin>` 指定的多个 DSH（本机全局 + `npm install --prefix` 装的备版本），每行验 12 项：`add` 退出码 0、依赖指向该 tarball、`dsh.profile.bundles` 追加本包、`--dump-config` 退出码 0、本包层存在且 `browser` 行选中 `cdp-daemon`、`tool-browser` 行存在、没有预期外的 `not found`（只允许 `browser-electron` / `playwright-browser`）、补出宿主 peer、入口可加载并注册出 `cdp-daemon`、启动期探测无 error、探测到的宿主版本与该行一致、`--smoke` 时真开 `example.com` 读回正文。**逐版本串行**（每行一个无头内核，约 600 MB）。

**`verify-provider.mjs`（110 项）** —— 自己起本地站点 + 真实 `browsersvc run`（临时 root/端口），逐项覆盖 session/tab 生命周期、`navigate` 拒非 http(s)、`execute`（表达式/参数/页面异常/超时）、`snapshot`/`a11y`/`content`（4 种格式）/`scrape`（含 `@attr`）、`waitFor` 三态、`click`/`type`/`setValue`/`check`/`getValue`/`clearField`/`selectOption`/`scroll`/`key`、`fillForm`、`screenshot`（含等比缩小/fullPage-jpeg）、`download`、`back`/`forward`/`reload`、`history`/`replay`、`detectChallenge`、`flushAuth`/`restoreAuth`、session 隔离、`reset`/`close`、连接被换掉后会话复活（F22）、自启开关复位（F25）、保存路径准入、默认保存目录（D1：`XDG_DOWNLOAD_DIR` → 本地化 `Downloads` → `~/Downloads` 回落、目录首次写入时建出来、未配置时默认目录之外一律拒绝）、代理对截断、**P1：`maxTabs` 上限与拒绝后不留半开页、无会话时释放连接（守护进程按 `idleMs` 回收 + 自愈）、配置默认值**。

**`verify-daemon.mjs`（35 项）** —— 只用 Node 内置能力，自己起本地源。凭据门一段额外覆盖「同一条连接上的后续请求不免检」（F27），F20 改在真实 CDP WebSocket 上验证。完整输出：

```
PASS  守护进程启动  — 公开端口 34535 → 内部端口 9300
PASS  状态文件含 token 且不对外开放  — mode=600
PASS  无 token 访问公开端口被拒 (401)  — status=401
PASS  白名单外的路径被拒 (403)  — status=403
PASS  CDP /json/version  — Browser=HeadlessChrome/154.0.8037.57
PASS  元数据 ws 地址被改写为走代理并带 token  — ws://127.0.0.1:34535/devtools/browser/eac5b966-e72e-4afa-9b7e-f543aa5332f2?token=04f61976-84af-470a-9f75-2c55556b07c1
PASS  首个请求正常 200（同一条连接复用前的基线）  — first="HTTP/1.1 200 OK"
PASS  同一连接上的第二个请求（无凭据 PUT /json/new）拿不到 200（F27）  — 未收到第二个响应
PASS  代理在响应后主动收掉非升级连接（不悬挂、不占连接计数）  — closed=true
PASS  CDP WebSocket 空闲 11s 后仍可用（F20，真正长连接路径）  — HeadlessChrome/154.0.8037.57
PASS  公开端口只绑 127.0.0.1  — 监听=0100007F(tcp)
PASS  内部端口只绑 127.0.0.1  — 监听=0100007F(tcp)
PASS  两个隔离上下文（不同 browserContextId）  — 6509AA01 vs 9200BE45
PASS  上下文 A 能写 cookie  — A="iso=ctx1"
PASS  上下文 B 看不到 A 的 cookie（隔离生效）  — B=""
PASS  页面真实渲染  — title="iso"
PASS  浏览器被杀后自动重启  — browserPid 3812 → 3884
PASS  重启后代理仍可用（自动改指向）  — 内部端口 9300
PASS  空闲后自动退出  — exitCode=0
PASS  退出后清理状态文件
PASS  退出后端口释放
PASS  越界 --port 被配置校验拒绝 (exit 2)  — code=2 out={
  "error": "无效的 port：99999（允许 0..65535）",
  "usage": "browsersvc start|stop|status|restart|run|logs|detect [--port=933
PASS  --internal-port-base 覆盖默认 9300  — internalPort=19700 期望=19700
PASS  --lines=0 被拒 (exit 2)  — code=2
PASS  内核不存在时启动失败且不留状态文件  — code=2 out={
  "error": "浏览器内核不存在：/nonexistent/chrome",
  "usage": "browsersvc start|stop|status|restart|run|logs|detect [--port=9333] [--idle-ms=90000
PASS  内核不可执行时启动失败且不留状态文件  — code=2 out={
  "error": "浏览器内核不可执行：/tmp/browsersvc-verify-stuck-mnDyHl/fake-kernel.mjs",
  "usage": "browsersvc start|stop|status|restart|run|logs|dete
PASS  内核未就绪时启动失败（不静默成功）  — code=2 out={
  "error": "浏览器在 1500ms 内未就绪（见 /tmp/browsersvc-verify-stuck-mnDyHl/service.log）",
  "usage": "browsersvc start|stop|status|restart|run|log
PASS  启动失败后不留孤儿内核  — kernelPid=4055 alive=false
PASS  启动失败后不留状态文件
PASS  stop 身份校验：拒绝杀不匹配的进程  — code=1 alive=true
PASS  stop --force 可强制清理  — code=0
PASS  restart 前置：隔离实例可启动  — code=0 {
  "started": true,
  "pid": 4091,
  "browserPid": 4098,
  "port": 32985,
  "browserVersion": "HeadlessChrome/154.0.803
PASS  restart 真的停旧起新（F23）  — code=0 {
  "restarted": true,
  "stopped": true,
  "started": true,
  "pid": 4160,
  "browserPid": 4167,
  "port": 44693,
  "browserVersion": "HeadlessChrome/154.0.803
PASS  restart 后 token 换新  — f73cc755 → a14e7475
PASS  restart 后的实例可正常 stop  — code=0

35/35 通过
```

## 真实 DSH 内端到端（手动，不属于自动验收）

在隔离 `DSH_HOME` 里建一个 web 模板 profile → `dsh plugin add` 本包 → 重启该实例，`tools/seam-probe` 会通过 `ctx.browser` 跑完 open → openUrl → snapshot → content → execute → a11y → listTabs → close，日志落在 `/tmp/m2-seam-probe.log`：

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

## npm 短命令实测

`dsh plugin --profile <n> add dsh-browser-service@latest` 同样在一次性隔离 `DSH_HOME` 里实测通过：pnpm 直连 registry 安装最新版，`dsh.profile.bundles` 追加本包，`--dump-config` 出现 `# == dsh-browser-service` 层与 `browserProvider: cdp-daemon`。

## 未被自动化覆盖的部分

- `/proc` 身份校验类断言只在 Linux 上有意义（本项目的目标平台就是 Linux 容器）。
- `EADDRINUSE` 分支需要一个真实的端口占位者；代理半关闭时序、tgz 内文件模式（依赖 npm/pnpm 版本）、孤儿进程断言（依赖 `pgrep`/`ps` 行为）都没有进自动验收集。
- macOS / Windows 完全未测试。
