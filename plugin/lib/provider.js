/**
 * CDP 版 BrowserProvider：把 DSH 的 browser seam 接到常驻的 browsersvc（M1 守护进程）
 * 或多实例 chrome-headless-shell 上，用 playwright-core 的 connectOverCDP 消费。
 *
 * 设计约束（来自 seam 契约，见 docs/feasibility.md §类型面）：
 * - `open()` 自己铸造字符串 session id；
 * - `available()` 必须廉价且不发网络请求；
 * - 元素定位语义 css / text / xpath，text 为「精确优先 → 包含，深层优先」；
 * - history 记录在会话内，`result` 是截断后的文本，`at` 是 epoch 毫秒。
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { collectA11y, collectContent, collectScrape, collectSnapshot, detectChallengeMarkers, fillFields, readElementValue } from './dom.js';

const SESSION_UNKNOWN = 'BROWSER_SESSION_UNKNOWN';
const TAB_UNKNOWN = 'BROWSER_TAB_UNKNOWN';
const TARGET_INVALID = 'BROWSER_TARGET_INVALID';
const ATTACH_FAILED = 'BROWSER_CDP_ATTACH_FAILED';

const REPLAYABLE = new Set(['navigate', 'execute', 'click', 'type']);
const NAMED_KEYS = new Set([
  'Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown', 'Space', 'Control', 'Alt', 'Shift', 'Meta',
]);

/**
 * @param {{chromium: unknown, BrowserError?: Function, config: Record<string, unknown>, log?: Record<string, Function>, autoStart?: Function}} deps
 */
export function createProvider({ chromium, BrowserError, config, log, autoStart }) {
  const fail = (message, code, cause) => {
    if (BrowserError) return new BrowserError(message, code, cause === undefined ? undefined : { cause });
    const error = new Error(message);
    error.name = 'BrowserError';
    error.code = code;
    if (cause !== undefined) error.cause = cause;
    return error;
  };
  const describe = (error) => (error instanceof Error ? error.message : String(error));
  const note = (level, message) => {
    try {
      log?.[level]?.(message);
    } catch {
      /* 日志失败不影响主流程 */
    }
  };

  // 保存路径准入的范围限制（F1）：与内置 browser provider 同语义 —— downloadDir 未配置时
  // 只强制「绝对路径 + 不覆盖已有文件」，配置了才额外要求落在该目录内。
  const downloadDir = typeof config.downloadDir === 'string' && config.downloadDir ? resolve(config.downloadDir) : undefined;

  class CdpProvider {
    id = config.providerId;

    #conn = null;

    #connecting = null;

    #conns = new Set();

    #sessions = new Map();

    #sessionSeq = 0;

    #autoStarted = false;

    /** 廉价可用性：只反映依赖是否就绪，不做任何网络探测（daemon 未起时由 open() 报错）。 */
    available() {
      return Boolean(chromium);
    }

    /**
     * 公开端口要求 `Authorization: Bearer <token>`（每次守护进程启动随机生成，落在 0600 的状态文件里）。
     * 显式配置 cdpToken 优先；否则每次都重新读状态文件，因为守护进程重启后 token 会变。
     */
    #cdpToken() {
      if (typeof config.cdpToken === 'string' && config.cdpToken) return config.cdpToken;
      const root = process.env.DSH_BROWSER_SVC_ROOT || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'browser-service');
      try {
        const state = JSON.parse(readFileSync(join(root, 'service.json'), 'utf8'));
        if (typeof state?.token === 'string' && state.token) return state.token;
      } catch {
        /* 没有状态文件（例如指向非 browsersvc 的 CDP 端点）就不带凭据 */
      }
      return null;
    }

    /**
     * 保存路径准入：必须绝对路径；配了 downloadDir 必须落在其内；拒绝覆盖已有文件。
     * 返回解析后的绝对路径。语义与内置 provider 的 admitSavePath 一致。
     */
    #admitSavePath(savePath, kind) {
      const code = kind === 'download' ? 'BROWSER_DOWNLOAD_BLOCKED' : 'BROWSER_SCREENSHOT_BLOCKED';
      const raw = typeof savePath === 'string' ? savePath : '';
      if (!isAbsolute(raw)) throw fail(`browser: ${kind} savePath must be an absolute path（收到 "${raw}"）`, code);
      const file = resolve(raw);
      if (downloadDir !== undefined) {
        const fileLower = file.toLowerCase();
        const dirLower = downloadDir.toLowerCase();
        if (fileLower !== dirLower && !fileLower.startsWith(dirLower + sep.toLowerCase())) {
          throw fail(`browser: ${kind} savePath must be inside downloadDir "${downloadDir}"`, code);
        }
      }
      if (existsSync(file)) throw fail(`browser: refusing to overwrite existing file "${file}" — use another name`, code);
      return file;
    }

    async #browser() {
      if (this.#conn?.isConnected?.()) return this.#conn;
      // 并发调用只允许一次握手（F6）：否则两个调用各自 connectOverCDP，后到的覆盖前者，
      // 前一条连接再没人关。
      if (!this.#connecting) this.#connecting = this.#attach().finally(() => { this.#connecting = null; });
      return this.#connecting;
    }

    async #attach() {
      const url = config.cdpUrl;
      // token 必须在每次尝试时重新读（F19）：自启前的状态文件里没有 token，若在这里读一次就被
      // 自启后的重试沿用，重试必然 401，浏览器在冷启动后第一次不可用。
      const attach = () => {
        const token = this.#cdpToken();
        return chromium.connectOverCDP(url, {
          timeout: config.connectTimeoutMs,
          ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
        });
      };
      try {
        this.#conn = await attach();
      } catch (first) {
        if (!config.autoStartCommand || this.#autoStarted) {
          throw fail(`browser: 无法连接 CDP 端点 ${url}（${describe(first)}）；请先运行 browsersvc start`, ATTACH_FAILED, first);
        }
        this.#autoStarted = true;
        note('info', `browser-cdp: CDP 端点不可用，按 autoStartCommand 自启：${config.autoStartCommand}`);
        try {
          await autoStart?.(config.autoStartCommand, config.autoStartTimeoutMs);
          this.#conn = await attach();
        } catch (second) {
          throw fail(`browser: 自启后仍无法连接 CDP 端点 ${url}（${describe(second)}）`, ATTACH_FAILED, second);
        }
      }
      const conn = this.#conn;
      this.#conns.add(conn);
      conn.on('disconnected', () => {
        // 只清掉自己这一条：旧连接迟到的 disconnected 不能把新连接也抹掉（F6）。
        this.#conns.delete(conn);
        if (this.#conn === conn) this.#conn = null;
      });
      note('info', `browser-cdp: 已连接 CDP 端点 ${url}`);
      return conn;
    }

    #session(id) {
      const session = this.#sessions.get(String(id));
      if (!session || session.closed) throw fail(`browser: 会话 "${String(id)}" 不存在或已关闭`, SESSION_UNKNOWN);
      return session;
    }

    /**
     * 取会话并自愈连接（F22）：CDP 连接一旦被换掉（守护进程重启、F20 拆线、内核崩溃），
     * 旧 context/page 全部失效。工具层按 task 永久缓存 session id 且从不重开
     * （dsh-builtin-browser/lib/tool-browser/index.js ensureSession），所以这里必须按原 id
     * 把会话重建在新连接上，否则之后每次 browser_* 调用都只会报「会话内没有可用标签页」，
     * 直到人工 browser_reset_session 或重启 DSH。
     */
    async #liveSession(id) {
      const session = this.#session(id);
      const conn = await this.#browser();
      const active = session.tabs.get(session.active);
      // 连接还是同一条、当前标签页也还活着 ⇒ 无需处理。否则（连接被换掉，或当前标签页已死）
      // 都要在新连接上按原 id 重建。
      if (session.conn === conn && active && !active.isClosed()) return session;
      // 并发调用不能各建一个 context（会把后建的顶掉，泄漏前一个）：每个会话只允许一次重建。
      if (!session.reviving) {
        session.reviving = this.#revive(session, conn).finally(() => {
          session.reviving = null;
        });
      }
      return session.reviving;
    }

    async #revive(session, conn) {
      const stale = session.context;
      try {
        const context = await conn.newContext({
          viewport: { width: config.viewportWidth, height: config.viewportHeight },
        });
        const page = await context.newPage();
        session.conn = conn;
        session.context = context;
        session.tabs = new Map();
        session.active = this.#addTab(session, page);
      } catch (error) {
        throw fail(`browser: 会话 "${session.id}" 的连接已失效且无法恢复（${describe(error)}）`, ATTACH_FAILED, error);
      }
      await stale?.close?.().catch(() => {});
      note('info', `browser-cdp: 连接已重建，会话 ${session.id} 已恢复`);
      return session;
    }

    #page(session) {
      const page = session.tabs.get(session.active);
      if (!page || page.isClosed()) throw fail('browser: 会话内没有可用标签页', TAB_UNKNOWN);
      return page;
    }

    #addTab(session, page) {
      const tabId = `t${(session.tabSeq += 1)}`;
      session.tabs.set(tabId, page);
      return tabId;
    }

    #assertUrl(raw) {
      let parsed;
      try {
        parsed = new URL(String(raw));
      } catch {
        throw fail(`browser: 无法解析的 URL "${String(raw)}"`, 'BROWSER_NAVIGATION_BLOCKED');
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw fail(`browser: 只允许 http(s) URL，收到 "${parsed.protocol}"`, 'BROWSER_NAVIGATION_BLOCKED');
      }
      return parsed.href;
    }

    #checkSignal(signal) {
      if (signal?.aborted) {
        const error = fail('browser: 操作已取消', 'BROWSER_ABORTED');
        error.name = 'AbortError';
        throw error;
      }
    }

    /** 用 CDP 尝试打断页面里跑飞的脚本（只发不等：线程真卡住时该命令也不会回应）。 */
    #terminate(page) {
      void page
        .context()
        .newCDPSession(page)
        // 每个 CDPSession 都要显式 detach，否则卡死恢复每触发一次就漏一个会话（F8）。
        .then((cdp) => cdp.send('Runtime.terminateExecution').catch(() => {}).finally(() => cdp.detach().catch(() => {})))
        .catch(() => {});
    }

    /**
     * 页面被 `while(true)` 这类脚本占死 JS 线程时，同页后续调用会一直超时；
     * 实测同 context 里新建标签页、关闭卡死页都仍然可用，所以按需重建该 tab 并回到原 url。
     * 先用短探针确认是否真的卡死，避免慢请求超时也误伤标签页。
     */
    async #recoverIfWedged(session, page) {
      this.#terminate(page);
      const alive = await Promise.race([
        page.evaluate('1').then(() => true).catch(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 400)),
      ]);
      if (alive) return false;
      const url = page.url();
      const tabId = [...session.tabs].find(([, candidate]) => candidate === page)?.[0];
      if (tabId) session.tabs.delete(tabId);
      await Promise.race([
        page.close().catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
      const fresh = await this.#newTab(session);
      if (/^https?:/i.test(url)) await this.#goto(fresh, url, config.navigationTimeoutMs).catch(() => {});
      return true;
    }

    async #withTimeout(promise, ms, code) {
      let timer;
      const expiry = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(fail(`browser: 执行超时（${ms}ms）`, code)), ms);
      });
      try {
        return await Promise.race([promise, expiry]);
      } finally {
        clearTimeout(timer);
      }
    }

    async #goto(page, url, timeoutMs) {
      const target = this.#assertUrl(url);
      try {
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      } catch (error) {
        throw fail(`browser: 导航到 "${target}" 失败：${describe(error)}`, 'BROWSER_NAVIGATION_FAILED', error);
      }
    }

    async #locator(page, target) {
      if (!target || typeof target.value !== 'string') throw fail('browser: 缺少元素定位信息（target.by / target.value）', TARGET_INVALID);
      const by = target.by === 'text' || target.by === 'xpath' ? target.by : 'css';
      const index = Number.isInteger(target.index) && target.index >= 0 ? target.index : 0;
      const value = String(target.value);
      if (by === 'css') return page.locator(value).nth(index);
      if (by === 'xpath') return page.locator(`xpath=${value}`).nth(index);
      // text：精确优先 → 包含；DOM 顺序里祖先在前，因此取靠后的「最深」命中。
      const pick = async (locator) => {
        const count = await locator.count();
        if (count === 0) return null;
        return locator.nth(Math.max(0, count - 1 - index));
      };
      const exact = await pick(page.getByText(value, { exact: true }));
      if (exact) return exact;
      const loose = await pick(page.getByText(value));
      if (loose) return loose;
      return page.getByText(value).nth(index);
    }

    /** 统一包装：记录 history + 错误码归一。 */
    async #record(session, action, params, run) {
      const seq = ++session.seq;
      const at = Date.now();
      try {
        const result = await run();
        const failedScript = result !== null && typeof result === 'object' && result.ok === false && typeof result.exception === 'string';
        const entry = { seq, action, params: params ?? {}, ok: !failedScript, at };
        if (failedScript) entry.error = result.exception;
        else {
          const summary = this.#summarize(result);
          if (summary !== undefined) entry.result = summary;
        }
        session.history.push(entry);
        return result;
      } catch (error) {
        session.history.push({ seq, action, params: params ?? {}, ok: false, error: describe(error), at });
        throw error;
      }
    }

    #summarize(value) {
      if (value === undefined || value === null) return undefined;
      if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}…` : value;
      if (typeof value !== 'object') return String(value);
      try {
        const json = JSON.stringify(value, (key, item) => {
          if (key === 'dataUrl') return '(base64 省略)';
          if (typeof item === 'string' && item.length > 200) return `${item.slice(0, 200)}…`;
          return item;
        });
        if (json === undefined) return undefined;
        return json.length > 500 ? `${json.slice(0, 500)}…` : json;
      } catch {
        return undefined;
      }
    }

    async #challenge(page) {
      try {
        return await page.evaluate(detectChallengeMarkers);
      } catch (error) {
        throw fail(`browser: 人机校验检测失败：${describe(error)}`, 'BROWSER_CHALLENGE_DETECT_FAILED', error);
      }
    }

    // ---- 会话 ----

    async open(label) {
      const browser = await this.#browser();
      let context;
      try {
        context = await browser.newContext({ viewport: { width: config.viewportWidth, height: config.viewportHeight } });
      } catch (error) {
        throw fail(`browser: 无法创建隔离上下文：${describe(error)}`, ATTACH_FAILED, error);
      }
      // newPage 失败必须把刚建的隔离上下文关掉，否则每次失败都漏一个 context（F14）。
      let page;
      try {
        page = await context.newPage();
      } catch (error) {
        await context.close().catch(() => {});
        throw fail(`browser: 无法在隔离上下文里新建标签页：${describe(error)}`, ATTACH_FAILED, error);
      }
      const id = `s${(this.#sessionSeq += 1)}`;
      const session = { id, label: label ?? id, conn: browser, reviving: null, context, tabs: new Map(), active: '', tabSeq: 0, history: [], seq: 0, closed: false };
      session.active = this.#addTab(session, page);
      this.#sessions.set(id, session);
      note('info', `browser-cdp: 打开会话 ${id}${label ? `（${label}）` : ''}`);
      return id;
    }

    async close(id) {
      const session = this.#sessions.get(String(id));
      if (!session) return;
      this.#sessions.delete(session.id);
      session.closed = true;
      await session.context.close().catch(() => {});
    }

    async dispose() {
      for (const id of [...this.#sessions.keys()]) await this.close(id);
      // 关闭全部曾建立的连接，而不只是「当前这条」：并发握手/重连可能留下旧连接（F6）。
      const conns = [...this.#conns];
      this.#conns.clear();
      this.#conn = null;
      for (const conn of conns) await conn?.close?.().catch(() => {});
    }

    async openUrl(id, request, signal) {
      const session = await this.#liveSession(id);
      this.#checkSignal(signal);
      const page = request?.newTab ? await this.#newTab(session) : this.#page(session);
      await this.#record(session, 'navigate', { url: request?.url, newTab: Boolean(request?.newTab) }, async () => {
        await this.#goto(page, request?.url, config.navigationTimeoutMs);
        return page.url();
      });
    }

    async #newTab(session) {
      const page = await session.context.newPage();
      session.active = this.#addTab(session, page);
      return page;
    }

    async listTabs(id) {
      const session = await this.#liveSession(id);
      const tabs = [];
      for (const [tabId, page] of session.tabs) {
        let url = '';
        let title;
        if (!page.isClosed()) {
          try {
            url = page.url();
            title = await page.title();
          } catch {
            url = '';
          }
        }
        tabs.push({ id: tabId, url, title, active: tabId === session.active });
      }
      return tabs;
    }

    async switchTab(id, tabId) {
      const session = await this.#liveSession(id);
      const page = session.tabs.get(String(tabId));
      if (!page) {
        throw fail(`browser: 标签页 "${String(tabId)}" 不在本会话（现有：${[...session.tabs.keys()].join(', ')}）`, TAB_UNKNOWN);
      }
      session.active = String(tabId);
      if (!page.isClosed()) await page.bringToFront().catch(() => {});
    }

    async closeTab(id, tabId) {
      const session = await this.#liveSession(id);
      const tabIdStr = String(tabId);
      const page = session.tabs.get(tabIdStr);
      if (!page) throw fail(`browser: 标签页 "${tabIdStr}" 不在本会话`, TAB_UNKNOWN);
      session.tabs.delete(tabIdStr);
      if (!page.isClosed()) await page.close().catch(() => {});
      if (session.tabs.size === 0) {
        const fresh = await session.context.newPage();
        session.active = this.#addTab(session, fresh);
      } else if (session.active === tabIdStr) {
        session.active = session.tabs.keys().next().value;
      }
    }

    async reset(id) {
      const session = await this.#liveSession(id);
      for (const page of session.tabs.values()) {
        if (!page.isClosed()) await page.close().catch(() => {});
      }
      session.tabs.clear();
      session.history = [];
      session.seq = 0;
      const page = await session.context.newPage();
      session.active = this.#addTab(session, page);
    }

    // ---- 页面操作 ----

    async navigate(id, request, signal) {
      const session = await this.#liveSession(id);
      const page = this.#page(session);
      this.#checkSignal(signal);
      await this.#record(session, 'navigate', { url: request?.url }, async () => {
        await this.#goto(page, request?.url, config.navigationTimeoutMs);
        return page.url();
      });
    }

    async execute(id, request, signal) {
      const session = await this.#liveSession(id);
      const page = this.#page(session);
      this.#checkSignal(signal);
      const script = String(request?.script ?? '');
      const args = Array.isArray(request?.args) ? request.args : [];
      const timeoutMs = request?.timeoutMs ?? config.actionTimeoutMs;
      // 页面内直接 eval 兑现 Runtime.evaluate 语义：表达式与语句都接受（语句取完成值），
      // 且 `arguments[0..n]` 拿到入参（与 seam 契约一致）。
      const expression = `(function(){ return eval(${JSON.stringify(script)}); }).apply(null, ${JSON.stringify(args)})`;
      return this.#record(session, 'execute', { script, args }, async () => {
        try {
          const value = await this.#withTimeout(page.evaluate(expression), timeoutMs, 'BROWSER_EXECUTE_TIMEOUT');
          return { ok: true, value };
        } catch (error) {
          // 契约里 execute 不抛错：超时与页面异常都落在 ok:false/exception 上。
          const message = describe(error).replace(/^Error:\s*/, '');
          if (error?.code === 'BROWSER_EXECUTE_TIMEOUT') {
            const recovered = await this.#recoverIfWedged(session, page);
            return { ok: false, exception: recovered ? `${message}（页面线程被占死，已重建标签页）` : message };
          }
          return { ok: false, exception: message };
        }
      });
    }

    async waitFor(id, request, signal) {
      const session = await this.#liveSession(id);
      const page = this.#page(session);
      const timeoutMs = request?.timeoutMs ?? config.actionTimeoutMs;
      const hasUrl = typeof request?.url === 'string' && request.url.length > 0;
      const hasSelector = typeof request?.selector === 'string' && request.selector.length > 0;
      // 给了 url/selector 就等它们；没给才退化成“等加载完成”。显式 loaded 与其它条件同时成立才算就绪。
      const wantLoaded = request?.loaded ?? (!hasUrl && !hasSelector);
      const deadline = Date.now() + timeoutMs;
      let miss = '条件未满足';
      for (;;) {
        this.#checkSignal(signal);
        const unmet = [];
        if (hasUrl) {
          const current = page.url();
          if (!(current === request.url || current.startsWith(request.url))) unmet.push(`URL 未匹配（当前 ${current}）`);
        }
        if (hasSelector) {
          let count = 0;
          try {
            count = await page.locator(request.selector).count();
          } catch (error) {
            unmet.push(`选择器求值失败：${describe(error)}`);
          }
          if (count === 0) unmet.push(`选择器 ${request.selector} 未出现`);
        }
        if (wantLoaded) {
          let state = 'loading';
          try {
            state = await page.evaluate(() => document.readyState);
          } catch {
            state = 'loading';
          }
          if (state !== 'complete') unmet.push(`页面仍在加载（readyState=${state}）`);
        }
        if (unmet.length === 0) {
          const conditions = [hasUrl ? `url=${request.url}` : null, hasSelector ? `selector=${request.selector}` : null, wantLoaded ? 'readyState=complete' : null].filter(Boolean);
          return { ready: true, reason: `等待条件已满足（${conditions.join(' + ') || '无条件'}）` };
        }
        miss = unmet.join('；');
        if (Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return { ready: false, reason: `等待 ${timeoutMs}ms 超时：${miss}` };
    }

    async snapshot(id, signal) {
      const session = await this.#liveSession(id);
      const page = this.#page(session);
      this.#checkSignal(signal);
      try {
        const raw = await page.evaluate(collectSnapshot, { maxElements: config.snapshotMaxElements });
        const challenge = await this.#challenge(page);
        const result = { url: raw.url, title: raw.title, elements: raw.elements, truncated: raw.truncated };
        if (challenge.blocked) result.challenge = challenge;
        return result;
      } catch (error) {
        if (error?.name === 'BrowserError') throw error;
        throw fail(`browser: 快照失败：${describe(error)}`, 'BROWSER_SNAPSHOT_FAILED', error);
      }
    }

    async a11y(id, request, signal) {
      const session = await this.#liveSession(id);
      const page = this.#page(session);
      this.#checkSignal(signal);
      const requested = Number.isFinite(request?.maxNodes) ? request.maxNodes : 500;
      const maxNodes = Math.min(5000, Math.max(10, Math.trunc(requested)));
      try {
        const raw = await page.evaluate(collectA11y, { maxNodes, includeHidden: Boolean(request?.includeHidden) });
        return { url: raw.url, title: raw.title, count: raw.nodes.length, nodes: raw.nodes, truncated: raw.truncated };
      } catch (error) {
        throw fail(`browser: 无障碍树读取失败：${describe(error)}`, 'BROWSER_CONTENT_FAILED', error);
      }
    }

    async reload(id, signal) {
      const session = await this.#liveSession(id);
      const page = this.#page(session);
      this.#checkSignal(signal);
      try {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: config.navigationTimeoutMs });
      } catch (error) {
        throw fail(`browser: 刷新失败：${describe(error)}`, 'BROWSER_NAVIGATION_FAILED', error);
      }
    }

    async detectChallenge(id, signal) {
      const session = await this.#liveSession(id);
      const page = this.#page(session);
      this.#checkSignal(signal);
      return this.#challenge(page);
    }

    async content(id, request, signal) {
      const session = await this.#liveSession(id);
      const page = this.#page(session);
      this.#checkSignal(signal);
      const format = ['html', 'markdown', 'txt', 'json'].includes(request?.format) ? request.format : 'txt';
      const maxChars = Number.isFinite(request?.maxChars) ? request.maxChars : config.contentMaxChars;
      try {
        const raw = await page.evaluate(collectContent, { format, selector: request?.selector, maxChars });
        if (raw.missing) throw new Error(`选择器无匹配：${request.selector}`);
        return { content: raw.content, truncated: raw.truncated };
      } catch (error) {
        if (error?.name === 'BrowserError') throw error;
        throw fail(`browser: 内容读取失败：${describe(error)}`, 'BROWSER_CONTENT_FAILED', error);
      }
    }

    async click(id, request, signal) {
      const session = await this.#liveSession(id);
      const page = this.#page(session);
      this.#checkSignal(signal);
      await this.#record(session, 'click', { ...(request ?? {}) }, async () => {
        try {
          if (typeof request?.x === 'number' && typeof request?.y === 'number') {
            await page.mouse.click(request.x, request.y);
            return `坐标点击 (${request.x}, ${request.y})`;
          }
          if (request?.target) {
            const locator = await this.#locator(page, request.target);
            await locator.click({ timeout: config.actionTimeoutMs });
            return `元素点击 ${request.target.by}="${request.target.value}"`;
          }
          throw fail('browser: click 需要坐标 {x,y} 或 {target}', 'BROWSER_CLICK_FAILED');
        } catch (error) {
          if (error?.name === 'BrowserError') throw error;
          throw fail(`browser: 点击失败：${describe(error)}`, 'BROWSER_CLICK_FAILED', error);
        }
      });
    }

    async type(id, request, signal) {
      const session = await this.#liveSession(id);
      const page = this.#page(session);
      this.#checkSignal(signal);
      const value = String(request?.text ?? '');
      await this.#record(session, 'type', { text: value, ...(request?.target ? { target: request.target } : {}) }, async () => {
        try {
          if (request?.target) {
            const locator = await this.#locator(page, request.target);
            await locator.click({ timeout: config.actionTimeoutMs });
            await locator.pressSequentially(value, { timeout: config.actionTimeoutMs });
            return `已向 ${request.target.by}="${request.target.value}" 输入 ${value.length} 个字符`;
          }
          await page.keyboard.type(value);
          return `已输入 ${value.length} 个字符`;
        } catch (error) {
          if (error?.name === 'BrowserError') throw error;
          throw fail(`browser: 输入失败：${describe(error)}`, 'BROWSER_TYPE_FAILED', error);
        }
      });
    }

    async setValue(id, request, signal) {
      const session = await this.#liveSession(id);
      const page = this.#page(session);
      this.#checkSignal(signal);
      const timeoutMs = request?.timeoutMs ?? config.actionTimeoutMs;
      try {
        const locator = await this.#locator(page, request?.target);
        const element = await locator.evaluate((el) => ({ tag: el.tagName.toLowerCase(), type: (el.getAttribute('type') ?? '').toLowerCase(), editable: el.isContentEditable }));
        if (element.tag === 'select') {
          const wanted = String(request.value);
          const options = await locator.evaluate((el) => Array.from(el.options).map((option) => ({ value: option.value, text: (option.textContent ?? '').trim() })));
          const match = options.find((option) => option.value === wanted) ?? options.find((option) => option.text === wanted);
          if (!match) throw fail(`browser: <select> 没有匹配 "${wanted}" 的 option`, 'BROWSER_SET_VALUE_FAILED');
          await locator.selectOption({ value: match.value }, { timeout: timeoutMs });
          const read = await locator.evaluate(readElementValue);
          return { method: 'select', value: String(read.value ?? match.value) };
        }
        if (element.tag === 'input' && (element.type === 'checkbox' || element.type === 'radio')) {
          await locator.setChecked(String(request.value) !== 'false' && String(request.value) !== '0' && String(request.value) !== '', { timeout: timeoutMs });
          return { method: element.type, value: String(await locator.isChecked()) };
        }
        await locator.fill(String(request.value), { timeout: timeoutMs });
        const method = element.tag === 'textarea' ? 'textarea' : element.editable ? 'contenteditable' : 'input';
        const read = await locator.evaluate(readElementValue);
        return { method, value: String(read.value ?? request.value) };
      } catch (error) {
        if (error?.name === 'BrowserError') throw error;
        throw fail(`browser: 设置值失败：${describe(error)}`, 'BROWSER_SET_VALUE_FAILED', error);
      }
    }

    async check(id, request, signal) {
      const session = await this.#liveSession(id);
      const page = this.#page(session);
      this.#checkSignal(signal);
      try {
        const locator = await this.#locator(page, request?.target);
        await locator.setChecked(request?.checked !== false, { timeout: request?.timeoutMs ?? config.actionTimeoutMs });
        return { checked: await locator.isChecked() };
      } catch (error) {
        if (error?.name === 'BrowserError') throw error;
        throw fail(`browser: 勾选失败：${describe(error)}`, 'BROWSER_CHECK_FAILED', error);
      }
    }

    async selectOption(id, request, signal) {
      const session = await this.#liveSession(id);
      const page = this.#page(session);
      this.#checkSignal(signal);
      try {
        const locator = await this.#locator(page, request?.target);
        const option = {};
        if (typeof request?.optionValue === 'string') option.value = request.optionValue;
        else if (typeof request?.optionText === 'string') option.label = request.optionText;
        else if (Number.isInteger(request?.optionIndex)) option.index = request.optionIndex;
        else throw fail('browser: selectOption 需要 optionValue / optionText / optionIndex 之一', 'BROWSER_SELECT_FAILED');
        await locator.selectOption(option, { timeout: request?.timeoutMs ?? config.actionTimeoutMs });
        const read = await locator.evaluate(readElementValue);
        return { value: String(read.value ?? ''), text: String(read.selectedText ?? '') };
      } catch (error) {
        if (error?.name === 'BrowserError') throw error;
        throw fail(`browser: 选择选项失败：${describe(error)}`, 'BROWSER_SELECT_FAILED', error);
      }
    }

    async clearField(id, request, signal) {
      const session = await this.#liveSession(id);
      const page = this.#page(session);
      this.#checkSignal(signal);
      try {
        const locator = await this.#locator(page, request?.target);
        const element = await locator.evaluate((el) => ({ tag: el.tagName.toLowerCase(), type: (el.getAttribute('type') ?? '').toLowerCase() }));
        if (element.tag === 'input' && (element.type === 'checkbox' || element.type === 'radio')) {
          await locator.setChecked(false, { timeout: request?.timeoutMs ?? config.actionTimeoutMs });
        } else {
          await locator.fill('', { timeout: request?.timeoutMs ?? config.actionTimeoutMs });
        }
        const read = await locator.evaluate(readElementValue);
        const empty = (read.value ?? '') === '';
        return { cleared: element.tag === 'select' ? false : empty || read.checked === false };
      } catch (error) {
        if (error?.name === 'BrowserError') throw error;
        throw fail(`browser: 清空失败：${describe(error)}`, 'BROWSER_CLEAR_FAILED', error);
      }
    }

    async getValue(id, request, signal) {
      const session = await this.#liveSession(id);
      const page = this.#page(session);
      this.#checkSignal(signal);
      try {
        const locator = await this.#locator(page, request?.target);
        const read = await locator.evaluate(readElementValue);
        const result = { value: read.value ?? null };
        if (typeof read.checked === 'boolean') result.checked = read.checked;
        if (typeof read.selectedText === 'string') result.selectedText = read.selectedText;
        return result;
      } catch (error) {
        if (error?.name === 'BrowserError') throw error;
        throw fail(`browser: 读取值失败：${describe(error)}`, 'BROWSER_GET_VALUE_FAILED', error);
      }
    }

    async scrape(id, request, signal) {
      const session = await this.#liveSession(id);
      const page = this.#page(session);
      this.#checkSignal(signal);
      const timeoutMs = request?.timeoutMs ?? config.lookupTimeoutMs;
      try {
        if (request?.item) await page.waitForSelector(request.item, { timeout: timeoutMs }).catch(() => {});
        const raw = await page.evaluate(collectScrape, { item: request?.item, fields: request?.fields ?? [] });
        return { count: raw.count, items: raw.items };
      } catch (error) {
        throw fail(`browser: 结构化抽取失败：${describe(error)}`, 'BROWSER_SCRAPE_FAILED', error);
      }
    }

    async scroll(id, request, signal) {
      const session = await this.#liveSession(id);
      const page = this.#page(session);
      this.#checkSignal(signal);
      try {
        const outcome = await page.evaluate((req) => {
          if (req.toTop) {
            window.scrollTo(0, 0);
            return 'top';
          }
          if (req.toBottom) {
            window.scrollTo(0, document.body.scrollHeight);
            return 'bottom';
          }
          if (req.selector) {
            const el = document.querySelector(req.selector);
            if (!el) return null;
            el.scrollIntoView({ block: 'center', inline: 'nearest' });
            return 'element';
          }
          window.scrollBy(req.deltaX ?? 0, req.deltaY ?? 0);
          return 'delta';
        }, request ?? {});
        if (outcome === null) throw fail(`browser: 滚动目标不存在：${request.selector}`, 'BROWSER_SCROLL_FAILED');
      } catch (error) {
        if (error?.name === 'BrowserError') throw error;
        throw fail(`browser: 滚动失败：${describe(error)}`, 'BROWSER_SCROLL_FAILED', error);
      }
    }

    async back(id, signal) {
      const session = await this.#liveSession(id);
      const page = this.#page(session);
      this.#checkSignal(signal);
      try {
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: config.navigationTimeoutMs });
      } catch (error) {
        throw fail(`browser: 后退失败：${describe(error)}`, 'BROWSER_NAVIGATION_FAILED', error);
      }
    }

    async forward(id, signal) {
      const session = await this.#liveSession(id);
      const page = this.#page(session);
      this.#checkSignal(signal);
      try {
        await page.goForward({ waitUntil: 'domcontentloaded', timeout: config.navigationTimeoutMs });
      } catch (error) {
        throw fail(`browser: 前进失败：${describe(error)}`, 'BROWSER_NAVIGATION_FAILED', error);
      }
    }

    async key(id, request, signal) {
      const session = await this.#liveSession(id);
      const page = this.#page(session);
      this.#checkSignal(signal);
      const name = String(request?.key ?? '');
      if (name.length > 1 && !NAMED_KEYS.has(name)) {
        throw fail(`browser: 不支持的按键 "${name}"（可用：${[...NAMED_KEYS].join(', ')} 或单个字符）`, 'BROWSER_KEY_UNSUPPORTED');
      }
      try {
        await page.keyboard.press(name);
      } catch (error) {
        throw fail(`browser: 按键失败：${describe(error)}`, 'BROWSER_KEY_FAILED', error);
      }
    }

    async fillForm(id, request, signal) {
      const session = await this.#liveSession(id);
      const page = this.#page(session);
      this.#checkSignal(signal);
      return this.#record(session, 'fill', { fields: request?.fields, submit: Boolean(request?.submit) }, async () => {
        try {
          const raw = await page.evaluate(fillFields, { fields: request?.fields ?? [], submit: Boolean(request?.submit) });
          return { fields: raw.fields, submitted: raw.submitted };
        } catch (error) {
          throw fail(`browser: 表单填写失败：${describe(error)}`, 'BROWSER_FILL_FAILED', error);
        }
      });
    }

    async screenshot(id, request, signal) {
      const session = await this.#liveSession(id);
      const page = this.#page(session);
      this.#checkSignal(signal);
      const format = request?.format === 'jpeg' ? 'jpeg' : 'png';
      const quality = format === 'jpeg' ? (Number.isFinite(request?.quality) ? request.quality : 80) : undefined;
      // 准入放在下面 try 之外：路径不合法要报 BROWSER_SCREENSHOT_BLOCKED，
      // 而不是被统一重包成 BROWSER_SCREENSHOT_FAILED（F1）。
      const savePath = typeof request?.savePath === 'string' && request.savePath ? this.#admitSavePath(request.savePath, 'screenshot') : null;
      let buffer;
      try {
        const wantsScale = (Number.isFinite(request?.maxWidth) || Number.isFinite(request?.maxHeight)) && !request?.fullPage;
        if (wantsScale) {
          const viewport = page.viewportSize() ?? { width: config.viewportWidth, height: config.viewportHeight };
          const scale = Math.min(
            1,
            Number.isFinite(request?.maxWidth) ? request.maxWidth / viewport.width : 1,
            Number.isFinite(request?.maxHeight) ? request.maxHeight / viewport.height : 1,
          );
          const client = await page.context().newCDPSession(page);
          try {
            const shot = await client.send('Page.captureScreenshot', {
              format,
              ...(quality === undefined ? {} : { quality }),
              captureBeyondViewport: false,
              clip: { x: 0, y: 0, width: viewport.width, height: viewport.height, scale },
            });
            buffer = Buffer.from(shot.data, 'base64');
          } finally {
            await client.detach().catch(() => {});
          }
        } else {
          buffer = await page.screenshot({ fullPage: Boolean(request?.fullPage), type: format, ...(quality === undefined ? {} : { quality }) });
        }
      } catch (error) {
        throw fail(`browser: 截图失败：${describe(error)}`, 'BROWSER_SCREENSHOT_FAILED', error);
      }
      const result = { dataUrl: `data:image/${format};base64,${buffer.toString('base64')}` };
      if (savePath) {
        try {
          await mkdir(dirname(savePath), { recursive: true });
          await writeFile(savePath, buffer);
        } catch (error) {
          throw fail(`browser: 截图写入失败：${describe(error)}`, 'BROWSER_SCREENSHOT_SAVE_FAILED', error);
        }
        result.path = savePath;
      }
      return result;
    }

    async download(id, request, signal) {
      const session = await this.#liveSession(id);
      this.#checkSignal(signal);
      const url = this.#assertUrl(request?.url);
      const savePath = this.#admitSavePath(request?.savePath, 'download');
      return this.#record(session, 'download', { url, savePath }, async () => {
        let response;
        try {
          response = await session.context.request.get(url, { timeout: config.actionTimeoutMs });
        } catch (error) {
          throw fail(`browser: 下载请求失败：${describe(error)}`, 'BROWSER_DOWNLOAD_BLOCKED', error);
        }
        if (!response.ok()) throw fail(`browser: 下载返回 HTTP ${response.status()}`, 'BROWSER_DOWNLOAD_BLOCKED');
        const body = await response.body();
        try {
          await mkdir(dirname(savePath), { recursive: true });
          await writeFile(savePath, body);
        } catch (error) {
          throw fail(`browser: 下载写入失败：${describe(error)}`, 'BROWSER_DOWNLOAD_SAVE_FAILED', error);
        }
        return { path: savePath };
      });
    }

    async flushAuth(id) {
      const session = await this.#liveSession(id);
      return this.#record(session, 'flushAuth', {}, async () => {
        const cookies = await session.context.cookies();
        return cookies.map((cookie) => {
          const domain = String(cookie.domain ?? '').replace(/^\./, '');
          const path = cookie.path || '/';
          const exported = {
            url: `${cookie.secure ? 'https' : 'http'}://${domain}${path}`,
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path,
            secure: cookie.secure,
            httpOnly: cookie.httpOnly,
          };
          if (typeof cookie.expires === 'number' && cookie.expires > 0) exported.expirationDate = cookie.expires;
          return exported;
        });
      });
    }

    async restoreAuth(id, cookies) {
      const session = await this.#liveSession(id);
      return this.#record(session, 'restoreAuth', { count: cookies?.length ?? 0 }, async () => {
        const list = (cookies ?? []).map((cookie) => {
          const base = {
            name: cookie.name,
            value: cookie.value,
            ...(cookie.secure === undefined ? {} : { secure: cookie.secure }),
            ...(cookie.httpOnly === undefined ? {} : { httpOnly: cookie.httpOnly }),
            ...(typeof cookie.expirationDate === 'number' ? { expires: cookie.expirationDate } : {}),
          };
          // Playwright 只接受两种形状：{url} 或 {domain,path}（混给会被拒），这里 url 优先。
          if (cookie.url) return { ...base, url: cookie.url };
          if (cookie.domain) return { ...base, domain: String(cookie.domain).replace(/^\./, ''), path: cookie.path ?? '/' };
          throw fail('browser: cookie 需要带 url 或 domain 才能注入', 'BROWSER_RESTORE_AUTH_FAILED');
        });
        await session.context.addCookies(list);
        return list.length;
      });
    }

    async history(id) {
      const session = this.#session(id);
      return session.history.map((entry) => ({ ...entry }));
    }

    async replay(id, seq) {
      const session = await this.#liveSession(id);
      const entry = session.history.find((item) => item.seq === seq);
      if (!entry) throw fail(`browser: 历史序号 ${seq} 不存在`, 'BROWSER_HISTORY_UNKNOWN');
      if (!REPLAYABLE.has(entry.action)) throw fail(`browser: 操作 "${entry.action}" 不可回放（可回放：${[...REPLAYABLE].join(', ')}）`, 'BROWSER_HISTORY_NOT_REPLAYABLE');
      if (entry.action === 'navigate') await this.navigate(session.id, { url: entry.params.url });
      else if (entry.action === 'execute') await this.execute(session.id, { script: entry.params.script, args: entry.params.args });
      else if (entry.action === 'click') await this.click(session.id, entry.params);
      else await this.type(session.id, entry.params);
    }
  }

  return new CdpProvider();
}
