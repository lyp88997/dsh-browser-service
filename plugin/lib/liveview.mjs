/**
 * 实时网页窗口的服务端半边（P4 / 0.7.0）：把一个真实标签页的画面变成 JPEG 帧流，
 * 并把「在画面上点的/滚的/敲的」转发回页面。
 *
 * 为什么是帧流而不是嵌 iframe：跨站网页不允许被别的页面嵌进去（X-Frame-Options / CSP），
 * 而且即便嵌进来也拿不到像素，无法在其上做「同步操作」。所以走 CDP 自带的录屏
 * （`Page.startScreencast`）+ 输入注入（`Input.*`）—— 各种「实时窗口」的通行做法。
 *
 * 只依赖 playwright 的 Page + 一条 CDP 会话：不碰 provider 的其它状态，便于单独测试。
 * 帧只在页面有变化时下发（静止时零流量）。
 */

/** 一帧 JPEG 的质量与尺寸上限：够看清，又不至于每帧几十 KB。 */
const QUALITY = 70;
const MAX_WIDTH = 1280;
const MAX_HEIGHT = 800;

/** 页面 URL/标题的缓存时间（每次取标题是一次 CDP 往返，别每帧都问）。 */
const META_TTL_MS = 500;

/** 命名键表（键盘转发用）：key → CDP 需要的 code / virtualKeyCode / 文本。 */
const KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  ' ': { code: 'Space', keyCode: 32, text: ' ' },
};

/** 允许的鼠标按键（其它一律按左键）。 */
const BUTTONS = { left: 'left', middle: 'middle', right: 'right' };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class LiveView {
  #page;

  #cdp = null;

  #listening = false;

  #streaming = false;

  #frame = null;

  #meta = null;

  #seq = 0;

  #at = 0;

  #url = '';

  #title = '';

  #metaAt = 0;

  #startedAt = 0;

  #navigationTimeoutMs;

  #log;

  constructor(page, { log, navigationTimeoutMs = 30_000 } = {}) {
    this.#page = page;
    this.#log = log;
    this.#navigationTimeoutMs = navigationTimeoutMs;
  }

  get page() {
    return this.#page;
  }

  /** 是否正在推帧（输入转发不要求开流）。 */
  get live() {
    return this.#streaming;
  }

  #note(level, message) {
    try {
      this.#log?.[level]?.(message);
    } catch {
      /* 日志失败不影响主流程 */
    }
  }

  /** 建 CDP 会话（幂等）：录屏与输入注入都挂在它上面。 */
  async #session() {
    if (this.#cdp) return this.#cdp;
    const cdp = await this.#page.context().newCDPSession(this.#page);
    try {
      await cdp.send('Page.enable');
    } catch (error) {
      await cdp.detach().catch(() => {});
      throw error;
    }
    this.#cdp = cdp;
    return cdp;
  }

  /** 开流（幂等）。页面已关、或宿主浏览器不支持录屏时抛错，由调用方决定怎么提示。 */
  async start() {
    if (this.#streaming) return this.state();
    const cdp = await this.#session();
    if (!this.#listening) {
      cdp.on('Page.screencastFrame', (event) => {
        this.#frame = event.data;
        this.#meta = event.metadata ?? null;
        this.#seq += 1;
        this.#at = Date.now();
        // 必须逐帧 ack，否则浏览器不再发后续帧。
        cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
      });
      this.#listening = true;
    }
    try {
      await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: QUALITY,
        maxWidth: MAX_WIDTH,
        maxHeight: MAX_HEIGHT,
        everyNthFrame: 1,
      });
    } catch (error) {
      await cdp.detach().catch(() => {});
      this.#cdp = null;
      this.#listening = false;
      throw error;
    }
    this.#streaming = true;
    this.#startedAt = Date.now();
    this.#note('info', 'browser-cdp: 实时窗口已开流');
    return this.state();
  }

  async stop() {
    if (!this.#cdp) return;
    const cdp = this.#cdp;
    this.#cdp = null;
    this.#listening = false;
    this.#streaming = false;
    try {
      await cdp.send('Page.stopScreencast');
    } catch {
      /* 页面已经关了：忽略 */
    }
    await cdp.detach().catch(() => {});
    this.#note('info', 'browser-cdp: 实时窗口已停流');
  }

  /** 当前状态（给 live.json 用）：URL/标题带 500ms 缓存。 */
  async state() {
    const now = Date.now();
    if (now - this.#metaAt > META_TTL_MS) {
      this.#metaAt = now;
      try {
        this.#url = this.#page.url();
        this.#title = await this.#page.title();
      } catch {
        /* 页面正在关闭：保留上一次的值 */
      }
    }
    const meta = this.#meta ?? {};
    return {
      live: this.#streaming,
      seq: this.#seq,
      at: this.#at,
      startedAt: this.#startedAt,
      url: this.#url,
      title: this.#title,
      width: Number(meta.deviceWidth) || 0,
      height: Number(meta.deviceHeight) || 0,
      pageScaleFactor: Number(meta.pageScaleFactor) || 1,
    };
  }

  /**
   * 取「比 since 新」的一帧；没有更新时最多等 timeoutMs（客户端长轮询用）。
   * 返回 null 表示等不到更新的帧（调用方回 204 让客户端稍后再问）。
   */
  async waitFrame({ since = 0, timeoutMs = 0 } = {}) {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      if (this.#frame && this.#seq > since) return this.#payload();
      if (Date.now() >= deadline) return null;
      await sleep(40);
    }
  }

  /** 不等待，直接给当前帧（还没有帧时返回 null）。 */
  frame() {
    return this.#frame ? this.#payload() : null;
  }

  #payload() {
    const meta = this.#meta ?? {};
    return {
      seq: this.#seq,
      at: this.#at,
      jpeg: Buffer.from(this.#frame, 'base64'),
      width: Number(meta.deviceWidth) || 0,
      height: Number(meta.deviceHeight) || 0,
    };
  }

  /**
   * 把一次「窗口里的操作」转发给页面。
   * 允许的动作：down / up / move / wheel / text / key / reload。
   * （goto 交给 provider 的导航通道处理，以便复用 URL 校验与 ops 记账。）
   */
  async input(action = {}) {
    const cdp = await this.#session();
    const kind = String(action.kind ?? '');
    const x = Math.round(Number(action.x) || 0);
    const y = Math.round(Number(action.y) || 0);
    if (kind === 'down' || kind === 'up' || kind === 'move') {
      const type = kind === 'down' ? 'mousePressed' : kind === 'up' ? 'mouseReleased' : 'mouseMoved';
      const button = BUTTONS[String(action.button ?? 'left')] ?? 'left';
      await cdp.send('Input.dispatchMouseEvent', {
        type,
        x,
        y,
        button,
        clickCount: kind === 'move' ? 0 : 1,
        // 拖动要带 buttons 位：1=左、2=右、4=中（mousemove 时哪些键是按下状态）。
        ...(kind === 'move' ? { buttons: Math.max(0, Math.floor(Number(action.buttons) || 0)) } : {}),
      });
      return { ok: true };
    }
    if (kind === 'wheel') {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x,
        y,
        deltaX: Math.round(Number(action.deltaX) || 0),
        deltaY: Math.round(Number(action.deltaY) || 0),
      });
      return { ok: true };
    }
    if (kind === 'text') {
      const value = String(action.text ?? '');
      if (value) await cdp.send('Input.insertText', { text: value });
      return { ok: true };
    }
    if (kind === 'key') {
      const key = String(action.key ?? '');
      const named = KEYS[key];
      if (!named) throw new Error(`实时窗口不认识这个按键："${key}"`);
      const base = { key, code: named.code, windowsVirtualKeyCode: named.keyCode, nativeVirtualKeyCode: named.keyCode };
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(named.text ? { text: named.text } : {}) });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      return { ok: true };
    }
    if (kind === 'reload') {
      await this.#page.reload({ waitUntil: 'domcontentloaded', timeout: this.#navigationTimeoutMs });
      return { ok: true };
    }
    throw new Error(`实时窗口不支持的动作："${kind}"`);
  }

  /** 供 provider 的导航通道复用（地址栏跳转）：只允许 http(s)，与 browser_open 同一套规则。 */
  async goto(url) {
    let parsed;
    try {
      parsed = new URL(String(url));
    } catch {
      throw new Error(`无法解析的 URL "${String(url)}"`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`只允许 http(s) URL，收到 "${parsed.protocol}"`);
    }
    await this.#page.goto(parsed.href, { waitUntil: 'domcontentloaded', timeout: this.#navigationTimeoutMs });
    this.#metaAt = 0;
    return { ok: true, url: parsed.href };
  }
}

export const LIVE_VIEW_LIMITS = { QUALITY, MAX_WIDTH, MAX_HEIGHT, META_TTL_MS };
