# M2：DSH `ctx.browser` provider 接线

M2 把 M1 的 CDP 守护进程接进 DSH 的 browser seam：**插件只注册 provider，工具面沿用内置 `tool-browser` 的 `browser_*` 工具**（不自己定义工具）。

```
browser_* 工具（dsh-builtin-browser/tool-browser）
   └─ ctx.browser seam（dsh-builtin-browser/browser）
        └─ dsh-browser-cdp（本仓库 plugin/，provider id = cdp-daemon）
             └─ playwright-core connectOverCDP → 127.0.0.1:9333（browsersvc 回环代理）
                  └─ chrome-headless-shell（用户态库 + 包装脚本）
```

## 1. 插件

- 目录：`plugin/`（独立子包，`name: dsh-browser-cdp`，作为 DSH 组合包单独分发，见 `plugin/README.md`）。
- 依赖：`playwright-core`（**不下载浏览器**）+ `@deepseek-ai/schemastery`。
- `plugin/lib/index.js`：`name='browser-cdp'`、`inject=['browser']`；`apply` 动态 `import('playwright-core')`，失败则只记日志不注册；成功则 `ctx.browser.registerBrowserProvider(provider)`，并用 `ctx.effect` 持有 disposer（热加载不留 stale provider）。
- `plugin/lib/provider.js`：`createProvider({chromium, BrowserError, config, log, autoStart})`，实现 seam 的 `BrowserProvider` 全部成员（`open`/`execute`/`snapshot`/`screenshot`/…；契约见 `dsh-builtin-browser/lib/browser/types.d.ts`）。
- `plugin/lib/dom.js`：注入页面的纯函数（snapshot/a11y/content/scrape/fillForm/challenge 检测）。**注入函数不能引用任何外部作用域**（序列化后不存在）。

配置项（`Config`，全部有默认值）：`providerId='cdp-daemon'`、`cdpUrl='http://127.0.0.1:9333'`、`connectTimeoutMs`、`actionTimeoutMs`、`navigationTimeoutMs`、`lookupTimeoutMs`、`snapshotMaxElements`、`contentMaxChars`、`viewportWidth/Height`、可选 `autoStartCommand`。

## 2. 部署（本机现状）

```bash
# 1) 让 profile 能按裸名解析到插件（不改 profile 的 dependencies，避免 reconcileBundles 副作用）
ln -s /home/node/DSH/dsh-browser-service/plugin \
      /home/node/.dsh/profiles/web/node_modules/dsh-browser-cdp

# 2) 让插件解析到 playwright-core（用 profile 里已装的那份，不重复下载）
ln -s /home/node/.dsh/profiles/web/node_modules/playwright-core \
      /home/node/DSH/dsh-browser-service/node_modules/playwright-core
ln -s /home/node/.dsh/profiles/web/node_modules/@deepseek-ai/schemastery \
      /home/node/DSH/dsh-browser-service/node_modules/@deepseek-ai/schemastery

# 3) 把 docs/profile-patch.browser-cdp.yml 追加/替换到
#    $DSH_HOME/profiles/web/cordis.patch.yml 尾部，然后重启 DSH
```

patch 做四件事：注册插件（带 `autoStartCommand`，首次用浏览器时自动拉起守护进程）、seam 选 `cdp-daemon`、关掉内置 `browser-electron`、关掉 `dsh-playwright-browser`。

> **`dsh-playwright-browser` 必须关**：它自带 10 个与内置同名的 `browser_*` 工具，两个 provider 的工具面不能共存。

## 3. 验收

### 3.1 provider 层（86 项，零依赖、不碰外网）

```bash
node scripts/verify-provider.mjs      # 结果：86 通过，0 失败
```

自己起本地 http 站点 + 真实 `browsersvc run`（临时 root/端口），逐项覆盖：`available`、session/tab 生命周期、`navigate` 拒非 http(s)、`execute`（表达式/参数/页面异常/超时）、`snapshot`/`a11y`/`content`（4 种格式）/`scrape`（含 `@attr`）、`waitFor` 三态、`click`/`type`/`setValue`/`check`/`getValue`/`clearField`/`selectOption`/`scroll`/`key`、`fillForm`、`screenshot`（含等比缩小/fullPage-jpeg）、`download`、`back/forward/reload`、`history`/`replay`、`detectChallenge`、`flushAuth`/`restoreAuth`、session 隔离、`reset`/`close`。

### 3.2 DSH 内端到端（seam → provider → 守护进程 → CDP）

`tools/seam-probe/` 是**诊断用**插件（不是交付特性）：`inject=['browser']`，在 apply 里跑一遍 `open → openUrl → snapshot → content → execute → a11y → listTabs → close` 并写 `/tmp/m2-seam-probe.log`。

用一个**最小隔离 profile**（只装 `@deepseek-ai/dsh-base` + `dsh-builtin-browser`，不启动 web app、不碰运行中的 DSH）跑它：

```bash
H=/tmp/m2check2; P=$H/profiles/m2check
mkdir -p $P/node_modules/@deepseek-ai
cat > $P/package.json <<'JSON'
{ "name": "dsh-profile-m2check", "private": true,
  "dependencies": { "dsh-builtin-browser": "0.1.22", "dsh-browser-cdp": "0.1.0" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-builtin-browser"], "patchReload": "live" } } }
JSON
# cordis.patch.yml：insert browser-cdp + id: browser{browserProvider: cdp-daemon}
#                    + browser-electron disabled + insert m2-seam-probe
ln -s /home/node/DSH/dsh-browser-service/tools/seam-probe $P/node_modules/dsh-m2-seam-probe
ln -s /home/node/DSH/dsh-browser-service/plugin         $P/node_modules/dsh-browser-cdp
ln -s /home/node/.dsh/profiles/web/node_modules/dsh-builtin-browser $P/node_modules/dsh-builtin-browser
ln -s /home/node/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-base $P/node_modules/@deepseek-ai/dsh-base
node /tmp/m2-http.mjs &                 # 127.0.0.1:9413 一个 h1 页
DSH_HOME=$H dsh --profile m2check       # 守护进程由 autoStartCommand 自动拉起
```

实测日志（最终代码）：

```
apply entered
open -> "s1"
snapshot -> url=http://127.0.0.1:9413/ title="M2 探针页" elements=1 first={"ref":1,"kind":"link","label":"下一页",...}
content -> "M2 探针标题\n下一页"
execute -> {"ok":true,"value":"M2 探针标题"}
a11y -> count=2 nodes=2
listTabs -> [{"id":"t1","url":"http://127.0.0.1:9413/","title":"M2 探针页","active":true}]
closed -> DONE
```

同时验证了：插件 `apply` 正常、`autoStartCommand` 把 `browsersvc run` 拉起来（独立 chromium 树）、seam 解析到我们的 provider。

## 4. 已知坑

1. **运行中的完整 web profile 上，patch 热重载会静默回滚**。实测：往 patch 里加一个探针条目，chokidar 触发刷新、探针 `applied` 后 6–7 ms 被 `disposed`，而我们插件的 `apply` 根本没被调用；进程 stdout 归 docker，拿不到报错。同一个 patch 在**干净进程**里 boot 完全正常（`--dump-config` exit 0，隔离实例端到端通过）。⇒ **改完 patch 请重启 DSH**，不要指望 `patchReload: live`。最小 profile 里热重载是生效的（改 `connectTimeoutMs` 后 `apply` 重新执行），所以这是完整 profile 的某个兄弟插件导致的，未定位。
2. **工具重名**：`dsh-playwright-browser` 与内置 `tool-browser` 的 `browser_*` 工具同名，必须二选一（本方案关掉前者）。
3. **守护进程的 root 按 `DSH_HOME` 派生**（默认 `$DSH_HOME/browser-service`）。`browsersvc stop/status` 要用同一个 `DSH_HOME`，否则会报 `not running` 而进程还在。
4. `import('dsh-builtin-browser/browser')` 只在与该包同目录安装时可解析；解析不到时 provider 降级为 `Error` + `name='BrowserError'` + `code`（seam 只依赖 `code` 字符串），功能不受影响。
5. 本方案依赖 M1 的包装脚本（`--wrapper`）与用户态库/字体，卸载包装脚本会退化成白屏/方块。

## 5. 回滚

A1 时期的 profile patch 备份在 `/home/node/DSH/.browser/cordis.patch.yml.a1-backup`；把 `$DSH_HOME/profiles/web/cordis.patch.yml` 还原成它、删掉 `node_modules/dsh-browser-cdp` 软链、重启 DSH 即可回到 Playwright provider。
