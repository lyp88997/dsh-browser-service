# dsh-browser-service

自建浏览器服务：**一个单例 CDP 守护进程**，给 DSH 的 `browser_*` 工具用，同时把同一个内核以"可执行文件"的形态提供给 `dsh-univer-office` 这类只认 `browserExecutablePath` 的插件。

面向**无 root、无 GUI、host 网络**的服务器容器（本机就是这种：Debian 12 / uid 1000 / cgroup 只读 / `/dev/shm` 64M / 无 Xvfb）。

> 状态：**M1 已完成并验收通过**（守护进程 + 回环代理 + 空闲回收 + 崩溃重启）。**M2 已完成并验收通过**（`ctx.browser` provider 接进内置 `browser_*` 工具面，见 §3.3 与 `docs/provider-m2.md`）。

## 1. 它解决什么问题

| 现状问题 | 本项目的做法 |
|---|---|
| DSH 内置 `dsh-builtin-browser` 的 provider 是自托管 Electron：没有 Electron 二进制、没有 GUI 库、seccomp 下 `No usable sandbox!` | 用系统已有的 `chrome-headless-shell`，`--no-sandbox --disable-dev-shm-usage`，库用用户态目录，不需要 root |
| 每个消费方各起一个浏览器（内存重复） | **一个守护进程**，多客户端通过 CDP 连入，会话用隔离 `BrowserContext` 分开 |
| CDP 端口若对外监听 = 把浏览器（含 cookie）交给主机上任意进程 | 内核只绑 `127.0.0.1:<内部随机端口>`，对外只暴露**本机回环代理**；代理顺带精确统计连接数 |
| `dsh-univer-office` 只接受"浏览器可执行文件路径"，无法连远端 CDP | 同一个内核外面套一层包装脚本当 `browserExecutablePath`（同一份二进制与库，不共享进程） |

## 2. 架构

```
                    ┌──────────────── 127.0.0.1:<公开端口> ────────────────┐
客户端（DSH provider /                     │                                  │
 playwrigh/puppeteer / curl）──────────────┤  回环 TCP 代理（本进程）          │
                                          │   · 连接计数 → 空闲回收           │
                                          │   · （预留）一次性 token 校验      │
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
node scripts/verify-daemon.mjs      # M1 守护进程：13/13
node scripts/verify-provider.mjs    # M2 provider：67 通过，0 失败
```

`verify-provider.mjs` 自己起本地站点 + 真实 `browsersvc run`（临时 root/端口），逐项覆盖 session/tab 生命周期、`navigate` 拒非 http(s)、`execute`（表达式/参数/页面异常/超时）、`snapshot`/`a11y`/`content`（4 种格式）/`scrape`（含 `@attr`）、`waitFor` 三态、`click`/`type`/`setValue`/`check`/`getValue`/`clearField`/`selectOption`/`scroll`/`key`、`fillForm`、`screenshot`（含等比缩小/fullPage-jpeg）、`download`、`back`/`forward`/`reload`、`history`/`replay`、`detectChallenge`、`flushAuth`/`restoreAuth`、session 隔离、`reset`/`close`。

`verify-daemon.mjs` 只用 Node 内置能力（`fetch` / `WebSocket` / `http`），自己起本地源，逐项检查：

```
PASS  守护进程启动  — 公开端口 33819 → 内部端口 9300
PASS  CDP /json/version  — Browser=HeadlessChrome/154.0.8037.57
PASS  公开端口只绑 127.0.0.1  — 监听=0100007F(tcp)
PASS  内部端口只绑 127.0.0.1  — 监听=0100007F(tcp)
PASS  两个隔离上下文（不同 browserContextId）
PASS  上下文 A 能写 cookie
PASS  上下文 B 看不到 A 的 cookie（隔离生效）
PASS  页面真实渲染  — title="iso"
PASS  浏览器被杀后自动重启  — browserPid 12219 → 12294
PASS  重启后代理仍可用（自动改指向）
PASS  空闲后自动退出  — exitCode=0
PASS  退出后清理状态文件
PASS  退出后端口释放

13/13 通过
```

## 6. 安全约束（不要动）

1. **只绑回环**：本机是 host 网络，`0.0.0.0` 上的 CDP 端口等于把浏览器完全交给主机上任意进程。内核永远带 `--remote-debugging-address=127.0.0.1`，对外只走回环代理；验收脚本会解析 `/proc/net/tcp` 检查这一点。
2. **`--no-sandbox` 是必需的**（容器 `NoNewPrivs=1` + seccomp 下 Chromium 沙箱起不来），因此**只访问可信站点**；需要更强隔离时把浏览器放进独立容器。
3. **`--disable-dev-shm-usage` 必需**（`/dev/shm` 只有 64M）。
4. 会话隔离必须用 incognito `BrowserContext`，不要复用默认上下文。
5. 状态文件 0600，日志不记录页面内容；后续若加 token 校验，放在代理层。

## 7. 路线图

| 里程碑 | 内容 | 状态 |
|---|---|---|
| **M1** | 守护进程 + 回环代理 + 空闲回收 + 崩溃重启 + 13 项验收 | ✅ 完成 |
| **M2** | DSH provider 插件（`inject=['browser']` + `ctx.browser.registerBrowserProvider`），复用内置 `tool-browser` 的 33 个 `browser_*` 工具；同时 `disabled: true` 掉 `browser-electron` 与 `dsh-playwright-browser` | ✅ 完成（67 项 + DSH 内端到端，见 `docs/provider-m2.md`） |
| **M3** | univer 侧接线（保持包装脚本形态） | 已有可行做法 |
| **M4** | 面向"任何插件"的通用 HTTP 面：`/fetch` `/screenshot` `/eval` | 待做 |
| **M5** | CDP-over-pipe 代理，让 univer 也复用守护进程（进阶，未验证） | 待做 |

设计与可行性分析见 `docs/feasibility.md`。

## 8. 打包与分发

两个包都是纯 ESM、零构建，`npm pack` 即可分发（npm 缓存目录不可写时用 `npm_config_cache=/tmp/npm-cache`，不需要 root）：

```bash
npm pack --pack-destination dist                     # dsh-browser-service-<v>.tgz：守护进程 + plugin + tools + docs + 验收脚本
(cd plugin && npm pack --pack-destination ../dist)   # dsh-browser-cdp-<v>.tgz：provider 插件（含自带 cordis.patch.yml）
```

- 根包 `files` = `bin src plugin tools docs scripts README.md LICENSE`（21 项 / 45 KB，不含 `node_modules`），保持 `private: true`，只走 tarball。
- 插件包**独立可装**：`package.json` 声明 `"dsh": {"bundle": {"patch": "./cordis.patch.yml"}}`，装进 profile 依赖 / `dsh.profile.bundles` 后由 DSH 组合自动插入 provider、把 seam 切到 `cdp-daemon`、关掉 `browser-electron`——实测 `--dump-config` 的组合结果带 `# == dsh-builtin-browser, patched by dsh-browser-cdp`（7 项 / 19 KB）。`publishConfig.access=public`，也可 `npm publish`。
- 运行时依赖只有 `playwright-core`（只做 CDP 客户端，**不下载浏览器**）与 `@deepseek-ai/schemastery`；`@deepseek-ai/cordis` 是可选 peer。
- `dist/` 已 gitignore；插件包的安装方式与配置见 `plugin/README.md`。

## 9. 许可

MIT
