# 验收与测试

三条脚本**零依赖、不依赖外网**（只用 Node 内置的 `fetch` / `WebSocket` / `http` 与真实 `browsersvc` + 本地站点）：

```bash
node scripts/verify-daemon.mjs      # M1 守护进程 + CLI 防御：32/32
node scripts/verify-provider.mjs    # M2 provider：88 通过，0 失败
node scripts/verify-bundle.mjs      # 组合包安装（官方 dsh plugin 流程）：23/23
```

> ⚠️ **不要在默认 root 上跑**：脚本会按 pid 收敛自己起的实例并清理临时 root（`rmSync`）。它们默认使用 `/tmp` 下的一次性 `DSH_BROWSER_SVC_ROOT`，请保持默认，不要指向 `$DSH_HOME/browser-service`。

## 各套覆盖什么

**`verify-bundle.mjs`（23 项）** —— 在一次性隔离 `DSH_HOME`（`/tmp`）里真实执行官方安装/移除命令：交付物里只有一个包 → `add <tgz>` 追加依赖与层 → `--dump-config` 里本包层挂出 `browser`（`browserProvider: cdp-daemon`）、`tool-browser` 与 `browser-cdp`，且**三行都没有 not found** → 默认自启命令指向装进来的 `bin/browsersvc.mjs` → `./browser` / `./tool-browser` 转出口的导出键与 `dsh-builtin-browser` 源模块**完全一致** → `remove` 同时清掉依赖与层。不碰默认 profile。

**`verify-provider.mjs`（88 项）** —— 自己起本地站点 + 真实 `browsersvc run`（临时 root/端口），逐项覆盖 session/tab 生命周期、`navigate` 拒非 http(s)、`execute`（表达式/参数/页面异常/超时）、`snapshot`/`a11y`/`content`（4 种格式）/`scrape`（含 `@attr`）、`waitFor` 三态、`click`/`type`/`setValue`/`check`/`getValue`/`clearField`/`selectOption`/`scroll`/`key`、`fillForm`、`screenshot`（含等比缩小/fullPage-jpeg）、`download`、`back`/`forward`/`reload`、`history`/`replay`、`detectChallenge`、`flushAuth`/`restoreAuth`、session 隔离、`reset`/`close`、连接被换掉后会话复活（F22）、自启开关复位（F25）、保存路径准入、代理对截断。

**`verify-daemon.mjs`（32 项）** —— 只用 Node 内置能力，自己起本地源。完整输出：

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
