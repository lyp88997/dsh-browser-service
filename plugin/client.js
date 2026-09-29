/**
 * 浏览器服务面板 —— 客户端半边（P3 / 0.6.0 只读看板，P4 / 0.7.0 实时网页窗口，P5 / 0.8.0 可拖动缩放窗口 + 左侧入口 + 设置区）。
 *
 * 这是 DSH 网页里的一个浮动窗口，左侧一竖排入口，右侧是内容：
 *   - 「网页」（默认）：**实时画面 + 直接操作**——把宿主半边 `/browser-service/live.jpg` 的 JPEG
 *     帧贴成图片流，窗口里的点击/滚动/打字经 `/browser-service/live` 转发给真浏览器，顶部地址栏可跳转。
 *   - 「操作」/「控制台」/「网络」：只读观测数据，来自 `/browser-service/panel.json`。
 *   - 「设置」：取帧画质与最大边（真作用于浏览器取帧）、面板刷新间隔、日志条数、默认入口、
 *     是否打开即取帧、是否记住窗口位置与大小；下面还有一块只读的生效配置。
 *
 * 窗口本身可拖动（标题栏按住拖）、可缩放（右下角手柄拖）、可最大化/还原、可收起成右下角胶囊；
 * 位置与大小记在 localStorage 里（设置里可关）。
 *
 * 手写、零构建：宿主把本文件按 URL 原样吐给浏览器，只要求它是那段固定协议——
 *   `window.__ModuleLoader__.load({ id, factory: (require) => exports })`
 * 并且裸 `require` 只能点平台种子表里的 9 个词（这里有且只有 `react`）。
 * require('@deepseek-ai/dsh-client-ui-layout') 之类不在种子里，会抛 "missed the module table"，
 * 所以样式一律用内联 style，不引第三方 UI 包。
 * 借鉴 dsh-univer-office 的是**观感**（深色半透明圆角卡片、标题栏握把、右下角缩放手柄）：
 * 它自己也是手写的浮动窗口，只 require('react'/'react/jsx-runtime')，没有用 dockkit。
 *
 * 插件身份 = 标准 cordis 插件：必填 `apply(ctx)`，可选 `inject`（**cordis 服务名**）与 `name`。
 * 座位用 `shell.overlay`（kind: list / scope: root）——它是 additive 的：新 id 加在既有条目旁边，
 * 不会替换别人。注意该层是 click-through，条目自己接事件，所以根元素必须自成一个小盒子
 * （position: fixed），否则会盖住整个界面。
 */
window.__ModuleLoader__.load({
  id: 'dsh-browser-service',
  factory: (require) => {
    const exports = {};
    const React = require('react');

    /** 与 plugin/lib/panel.js 的 PANEL_PATH 必须一字不差（服务端路由是 exact 匹配）。 */
    const PANEL_PATH = '/browser-service/panel.json';
    /** 实时窗口的三条路由，同样必须与服务端一字不差。 */
    const LIVE_IMAGE_PATH = '/browser-service/live.jpg';
    const LIVE_STATE_PATH = '/browser-service/live.json';
    const LIVE_INPUT_PATH = '/browser-service/live';

    /** 面板默认拉多少条（服务端上限 200）。 */
    const DEFAULT_LINES = 40;
    /** 默认轮询间隔：数据是本地 JSONL 的尾巴，2.5s 足够新，也不吵。 */
    const DEFAULT_POLL_MS = 2500;
    /** 实时画面：服务端没有新帧（204）时的重试间隔。 */
    const LIVE_RETRY_MS = 250;
    /** 收到一帧之后的最小间隔：动画期间别把主线程和网络占满。 */
    const LIVE_GAP_MS = 40;
    /** 地址栏/状态同步间隔。 */
    const LIVE_STATE_MS = 1000;
    /** 鼠标移动转发节流。 */
    const LIVE_MOVE_MS = 100;
    /** 取帧画质与最大边的允许范围（与服务端 liveview 的夹取边界一致）。 */
    const QUALITY_RANGE = [10, 95];
    const WIDTH_RANGE = [320, 1920];
    const POLL_RANGE = [500, 10_000];
    const LINES_RANGE = [5, 200];

    /** 窗口几何的边界与默认值（x/y 为 null 表示贴在右下角）。 */
    const MIN_W = 320;
    const MIN_H = 240;
    const DEFAULT_WINDOW = { x: null, y: null, w: 560, h: 580 };
    const STORAGE_KEY = 'dsh-browser-service:ui';

    /** 左侧入口：id / 名称 / 图标。 */
    const RAIL = [
      ['live', '网页', '▣'],
      ['ops', '操作', '✓'],
      ['console', '控制台', '⌨'],
      ['network', '网络', '⇄'],
      ['settings', '设置', '⚙'],
    ];
    const TAB_IDS = RAIL.map(([id]) => id);

    const DEFAULT_SETTINGS = {
      quality: 70,
      maxWidth: 1280,
      pollMs: DEFAULT_POLL_MS,
      lines: DEFAULT_LINES,
      tab: 'live',
      autoStream: true,
      remember: true,
    };

    /** 这些键走 CDP 的按键事件（单个可打印字符走文本插入）。 */
    const NAMED_KEYS = new Set([
      'Enter',
      'Tab',
      'Escape',
      'Backspace',
      'Delete',
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'Home',
      'End',
      'PageUp',
      'PageDown',
      ' ',
    ]);

    const tone = {
      card: {
        position: 'fixed',
        zIndex: 40,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        borderRadius: '12px',
        border: '1px solid rgba(255,255,255,0.16)',
        background: 'rgba(20,20,25,0.95)',
        color: '#e8e8ea',
        boxShadow: '0 18px 45px rgba(0,0,0,0.55)',
        backdropFilter: 'blur(6px)',
        font: '12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      },
      pill: {
        position: 'fixed',
        right: '16px',
        bottom: '16px',
        zIndex: 40,
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '7px 12px',
        borderRadius: '999px',
        border: '1px solid rgba(255,255,255,0.16)',
        background: 'rgba(20,20,25,0.92)',
        color: '#e8e8ea',
        boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
        font: '12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        cursor: 'pointer',
      },
      head: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '8px 10px',
        borderBottom: '1px solid rgba(255,255,255,0.13)',
        cursor: 'grab',
        userSelect: 'none',
        background: 'rgba(255,255,255,0.03)',
      },
      title: { flex: 1, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      grip: { color: 'rgba(232,232,234,0.4)', letterSpacing: '1px' },
      btn: {
        padding: '3px 8px',
        borderRadius: '6px',
        border: '1px solid rgba(255,255,255,0.18)',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        cursor: 'pointer',
      },
      btnOn: { background: 'rgba(120,170,255,0.22)', borderColor: 'rgba(120,170,255,0.5)' },
      rail: {
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
        padding: '6px 4px',
        borderRight: '1px solid rgba(255,255,255,0.13)',
        background: 'rgba(255,255,255,0.02)',
        flex: '0 0 auto',
      },
      railBtn: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '2px',
        width: '52px',
        padding: '7px 2px',
        borderRadius: '8px',
        border: '1px solid transparent',
        background: 'transparent',
        color: 'rgba(232,232,234,0.7)',
        font: '10px/1.2 inherit',
        cursor: 'pointer',
      },
      railOn: { background: 'rgba(120,170,255,0.16)', borderColor: 'rgba(120,170,255,0.42)', color: '#e8e8ea' },
      railIcon: { font: '14px/1 ui-monospace, monospace' },
      main: { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 },
      body: { overflow: 'auto', padding: '4px 0', flex: 1, minHeight: 0 },
      row: { display: 'flex', gap: '6px', padding: '2px 10px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' },
      dim: { color: 'rgba(232,232,234,0.55)' },
      ok: { color: '#78d99a' },
      bad: { color: '#ff8b8b' },
      warn: { color: '#e8c57a' },
      foot: {
        padding: '5px 10px',
        borderTop: '1px solid rgba(255,255,255,0.13)',
        color: 'rgba(232,232,234,0.5)',
        display: 'flex',
        gap: '8px',
        alignItems: 'center',
      },
      addrRow: { display: 'flex', gap: '6px', padding: '6px 8px', borderBottom: '1px solid rgba(255,255,255,0.13)' },
      addr: {
        flex: 1,
        minWidth: 0,
        padding: '4px 7px',
        borderRadius: '6px',
        border: '1px solid rgba(255,255,255,0.18)',
        background: 'rgba(255,255,255,0.06)',
        color: 'inherit',
        font: 'inherit',
      },
      stage: {
        position: 'relative',
        margin: '8px',
        borderRadius: '8px',
        border: '1px solid rgba(255,255,255,0.16)',
        background: '#0b0b0e',
        overflow: 'hidden',
        cursor: 'crosshair',
        outline: 'none',
      },
      img: { display: 'block', width: '100%', userSelect: 'none', WebkitUserDrag: 'none' },
      hint: { padding: '4px 10px 8px', color: 'rgba(232,232,234,0.55)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' },
      resize: {
        position: 'absolute',
        right: 0,
        bottom: 0,
        width: '16px',
        height: '16px',
        cursor: 'nwse-resize',
        background: 'linear-gradient(135deg, transparent 45%, rgba(255,255,255,0.35) 45%, rgba(255,255,255,0.35) 55%, transparent 55%, transparent 70%, rgba(255,255,255,0.25) 70%, rgba(255,255,255,0.25) 80%, transparent 80%)',
      },
      section: {
        padding: '8px 10px',
        borderBottom: '1px solid rgba(255,255,255,0.1)',
      },
      sectionTitle: { fontWeight: 600, marginBottom: '6px', color: 'rgba(232,232,234,0.85)' },
      field: { display: 'flex', alignItems: 'center', gap: '8px', padding: '3px 0' },
      fieldLabel: { flex: '0 0 118px', color: 'rgba(232,232,234,0.7)' },
      fieldValue: { flex: 1, minWidth: 0, color: 'rgba(232,232,234,0.9)', wordBreak: 'break-all' },
      select: {
        padding: '2px 6px',
        borderRadius: '6px',
        border: '1px solid rgba(255,255,255,0.18)',
        background: 'rgba(255,255,255,0.06)',
        color: 'inherit',
        font: 'inherit',
      },
    };

    /** 数值夹取：坏值回落默认值。 */
    function clampInt(value, min, max, fallback) {
      const raw = Number(value);
      if (!Number.isFinite(raw)) return fallback;
      return Math.min(max, Math.max(min, Math.floor(raw)));
    }

    /** 设置对象规整（纯函数）：坏值/越界一律拉回安全范围，方便服务端与本地各用一半。 */
    function normalizeSettings(raw) {
      const source = raw && typeof raw === 'object' ? raw : {};
      return {
        quality: clampInt(source.quality, QUALITY_RANGE[0], QUALITY_RANGE[1], DEFAULT_SETTINGS.quality),
        maxWidth: clampInt(source.maxWidth, WIDTH_RANGE[0], WIDTH_RANGE[1], DEFAULT_SETTINGS.maxWidth),
        pollMs: clampInt(source.pollMs, POLL_RANGE[0], POLL_RANGE[1], DEFAULT_SETTINGS.pollMs),
        lines: clampInt(source.lines, LINES_RANGE[0], LINES_RANGE[1], DEFAULT_SETTINGS.lines),
        tab: TAB_IDS.includes(source.tab) ? source.tab : DEFAULT_SETTINGS.tab,
        autoStream: source.autoStream !== false,
        remember: source.remember !== false,
      };
    }

    /**
     * 窗口几何夹取（纯函数）：宽度/高度不小于最小值、不超过视口，
     * x/y 落在视口内；x/y 缺失（null）时贴右下角。
     */
    function clampRect(rect, bounds) {
      const bw = Number(bounds?.w);
      const bh = Number(bounds?.h);
      const maxW = Math.max(MIN_W, Number.isFinite(bw) && bw > 0 ? bw : DEFAULT_WINDOW.w);
      const maxH = Math.max(MIN_H, Number.isFinite(bh) && bh > 0 ? bh : DEFAULT_WINDOW.h);
      const w = Math.min(maxW, Math.max(MIN_W, Number(rect?.w) || DEFAULT_WINDOW.w));
      const h = Math.min(maxH, Math.max(MIN_H, Number(rect?.h) || DEFAULT_WINDOW.h));
      const maxX = Math.max(0, (Number.isFinite(bw) && bw > 0 ? bw : w) - w);
      const maxY = Math.max(0, (Number.isFinite(bh) && bh > 0 ? bh : h) - h);
      // 注意：Number(null) === 0，所以「没记过位置」必须显式判 null/undefined，否则会跑到左上角。
      const rawX = Number(rect?.x);
      const rawY = Number(rect?.y);
      const hasX = rect?.x !== null && rect?.x !== undefined && Number.isFinite(rawX);
      const hasY = rect?.y !== null && rect?.y !== undefined && Number.isFinite(rawY);
      const x = hasX ? Math.min(maxX, Math.max(0, Math.floor(rawX))) : maxX;
      const y = hasY ? Math.min(maxY, Math.max(0, Math.floor(rawY))) : maxY;
      return { x, y, w, h };
    }

    /** localStorage 可能被浏览器策略禁掉：读写一律吞异常，坏了就当没存。 */
    function readStore(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) return fallback;
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
      } catch {
        return fallback;
      }
    }

    function writeStore(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* 存储不可用：只是记不住窗口位置，不影响使用 */
      }
    }

    /** 时间戳 → 本地 HH:MM:SS；脏数据不炸。 */
    function clock(value) {
      const at = new Date(value);
      return Number.isFinite(at.getTime()) ? at.toTimeString().slice(0, 8) : '--:--:--';
    }

    function safeJson(value) {
      try {
        return JSON.stringify(value) ?? String(value);
      } catch {
        return String(value);
      }
    }

    function text(value, max = 240) {
      if (value === undefined || value === null) return '';
      const raw = typeof value === 'string' ? value : safeJson(value);
      return raw.length > max ? `${raw.slice(0, max)}…` : raw;
    }

    function entries(data, kind) {
      const list = data?.[kind]?.entries;
      return Array.isArray(list) ? list : [];
    }

    /** 面板上要醒目提示的异常条数（失败操作 + error/warning 控制台）。 */
    function alarms(data) {
      const failed = entries(data, 'ops').filter((e) => e?.ok === false).length;
      const noisy = entries(data, 'console').filter((e) => e?.type === 'error' || e?.type === 'warning').length;
      return failed + noisy;
    }

    function duration(ms) {
      const value = Number(ms);
      if (!Number.isFinite(value) || value <= 0) return '—';
      if (value < 60_000) return `${Math.round(value / 1000)} 秒`;
      if (value < 3_600_000) return `${Math.round(value / 60_000)} 分钟`;
      return `${(value / 3_600_000).toFixed(1)} 小时`;
    }

    function OpsRow({ entry }) {
      const detail = entry?.error ?? entry?.result ?? entry?.params;
      return React.createElement(
        'div',
        { style: tone.row },
        React.createElement('span', { style: entry?.ok === false ? tone.bad : tone.ok }, entry?.ok === false ? '✗' : '✓'),
        React.createElement('span', { style: tone.dim }, clock(entry?.at)),
        React.createElement('span', null, String(entry?.action ?? '?')),
        React.createElement('span', { style: tone.dim }, Number.isFinite(entry?.ms) ? `${entry.ms}ms` : ''),
        React.createElement('span', { style: tone.dim }, `${entry?.session ?? '?'}/${entry?.tab ?? '?'}`),
        React.createElement('span', null, text(detail, 200)),
      );
    }

    function ConsoleRow({ entry }) {
      const style = entry?.type === 'error' ? tone.bad : entry?.type === 'warning' ? tone.warn : null;
      return React.createElement(
        'div',
        { style: tone.row },
        React.createElement('span', { style: tone.dim }, clock(entry?.at)),
        React.createElement('span', { style: style ?? tone.dim }, String(entry?.type ?? 'log')),
        React.createElement('span', null, text(entry?.text, 240)),
      );
    }

    function NetworkRow({ entry }) {
      const response = entry?.phase === 'response';
      const arrow = entry?.phase === 'requestfailed' ? '✗' : response ? '←' : '→';
      const style = entry?.phase === 'requestfailed' || (response && entry?.status >= 400) ? tone.bad : response ? tone.ok : tone.dim;
      const tail = response
        ? `${entry?.status ?? '?'} ${Number.isFinite(entry?.ms) ? `${entry.ms}ms` : ''}`
        : entry?.phase === 'requestfailed'
          ? text(entry?.error ?? '', 80)
          : String(entry?.resource ?? '');
      return React.createElement(
        'div',
        { style: tone.row },
        React.createElement('span', { style }, arrow),
        React.createElement('span', { style: tone.dim }, String(entry?.method ?? '')),
        React.createElement('span', null, text(entry?.url, 200)),
        React.createElement('span', { style: style === tone.dim ? tone.dim : style }, tail),
      );
    }

    function Empty({ children }) {
      return React.createElement('div', { style: { ...tone.row, ...tone.dim } }, children);
    }

    function Field({ label, children }) {
      return React.createElement(
        'div',
        { style: tone.field },
        React.createElement('span', { style: tone.fieldLabel }, label),
        React.createElement('span', { style: tone.fieldValue }, children),
      );
    }

    function Choice({ value, options, onChange }) {
      return React.createElement(
        'select',
        {
          style: tone.select,
          value: String(value),
          onChange: (event) => onChange(Number(event.target.value)),
        },
        options.map((option) => React.createElement('option', { key: String(option), value: String(option) }, String(option))),
      );
    }

    function Toggle({ value, onText = '开', offText = '关', onChange }) {
      return React.createElement(
        'button',
        { type: 'button', style: { ...tone.btn, ...(value ? tone.btnOn : {}) }, onClick: () => onChange(!value) },
        value ? onText : offText,
      );
    }

    /**
     * 「设置」入口：能调的都能真的作用下去（画质/最大边随取帧请求发给服务端，
     * 刷新间隔/条数/默认入口是本地的），下面再放一块只读的生效配置。
     */
    function SettingsPane({ settings, onChange, service, onReset }) {
      const set = (patch) => onChange(normalizeSettings({ ...settings, ...patch }));
      return React.createElement(
        'div',
        null,
        React.createElement(
          'div',
          { style: tone.section },
          React.createElement('div', { style: tone.sectionTitle }, '实时画面'),
          React.createElement(Field, { label: '画面质量' }, React.createElement(Choice, {
            value: settings.quality,
            options: [40, 55, 70, 85, 95],
            onChange: (quality) => set({ quality }),
          })),
          React.createElement(Field, { label: '最大边（像素）' }, React.createElement(Choice, {
            value: settings.maxWidth,
            options: [480, 800, 1280, 1600, 1920],
            onChange: (maxWidth) => set({ maxWidth }),
          })),
          React.createElement(Field, { label: '打开即取帧' }, React.createElement(Toggle, {
            value: settings.autoStream,
            onChange: (autoStream) => set({ autoStream }),
          })),
        ),
        React.createElement(
          'div',
          { style: tone.section },
          React.createElement('div', { style: tone.sectionTitle }, '面板'),
          React.createElement(Field, { label: '刷新间隔' }, React.createElement(Choice, {
            value: settings.pollMs,
            options: [1000, 2500, 5000, 10000],
            onChange: (pollMs) => set({ pollMs }),
          })),
          React.createElement(Field, { label: '日志条数' }, React.createElement(Choice, {
            value: settings.lines,
            options: [20, 40, 100, 200],
            onChange: (lines) => set({ lines }),
          })),
          React.createElement(Field, { label: '默认入口' }, React.createElement(
            'select',
            {
              style: tone.select,
              value: settings.tab,
              onChange: (event) => set({ tab: event.target.value }),
            },
            RAIL.map(([id, name]) => React.createElement('option', { key: id, value: id }, name)),
          )),
          React.createElement(Field, { label: '记住窗口位置' }, React.createElement(Toggle, {
            value: settings.remember,
            onChange: (remember) => set({ remember }),
          })),
          React.createElement(Field, { label: '窗口' }, React.createElement(
            'button',
            { type: 'button', style: tone.btn, onClick: onReset },
            '恢复默认大小',
          )),
        ),
        React.createElement(
          'div',
          { style: tone.section },
          React.createElement('div', { style: tone.sectionTitle }, '当前生效的服务信息（只读）'),
          React.createElement(Field, { label: '版本' }, service?.version || '—'),
          React.createElement(Field, { label: '会话 / 标签' }, service?.session || '暂无会话'),
          React.createElement(Field, { label: 'CDP 地址' }, service?.cdpUrl || '—'),
          React.createElement(Field, { label: '保存目录' }, service?.downloadDir ? `${service.downloadDir}/` : '—'),
          React.createElement(Field, { label: '标签上限' }, service?.maxTabs == null ? '—' : `${service.maxTabs} 个`),
          React.createElement(Field, { label: '空闲回收' }, service?.idleMs == null ? '—' : duration(service.idleMs)),
          React.createElement(
            Field,
            { label: '录制内容' },
            `${service?.captureConsole === false ? '控制台：关' : '控制台：开'} · ${service?.captureNetwork === false ? '网络：关' : '网络：开'}`,
          ),
          React.createElement(
            Field,
            { label: '取帧参数' },
            service?.live
              ? `质量 ${service.live.quality} · 最大边 ${service.live.maxWidth}×${service.live.maxHeight}`
              : '未取帧',
          ),
          React.createElement(
            'div',
            { style: { ...tone.dim, paddingTop: '6px' } },
            '画质与最大边改完会在下一次取帧时生效；控制台/网络的开关在插件配置里（captureConsole / captureNetwork）。',
          ),
        ),
      );
    }

    /**
     * 「网页」入口：实时画面 + 直接操作。
     * 画面走长轮询（服务端把「等新帧」放在自己那边，静止时零流量），
     * 点击/滚动/打字转发给真浏览器；收起或暂停时告诉服务端停流（省 CPU）。
     */
    function LivePane({ paused, settings, onStreamingChange }) {
      const [frame, setFrame] = React.useState(null); // 当前帧的 object URL
      const [meta, setMeta] = React.useState({ w: 0, h: 0 });
      const [page, setPage] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [addr, setAddr] = React.useState('');
      const [started, setStarted] = React.useState(settings.autoStream !== false);
      const editing = React.useRef(false);
      const stage = React.useRef(null);
      const lastMove = React.useRef(0);
      const quality = settings.quality;
      const maxWidth = settings.maxWidth;

      React.useEffect(() => {
        onStreamingChange?.(started && !paused);
      }, [started, paused, onStreamingChange]);

      React.useEffect(() => {
        if (paused || !started) return undefined;
        let alive = true;
        let since = 0;
        let current = null; // 上一帧的 object URL：换帧时立刻释放，免得内存越滚越大
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const pump = async () => {
          // 每轮都带上当前设置：质量/最大边改了，服务端会在下一帧按新参数重开流。
          const url = `${LIVE_IMAGE_PATH}?since=${since}&quality=${quality}&max=${maxWidth}`;
          while (alive) {
            try {
              const res = await fetch(url, { cache: 'no-store' });
              if (!alive) return;
              if (res.status === 204) {
                await wait(LIVE_RETRY_MS);
                continue;
              }
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              const seq = Number(res.headers.get('x-frame-seq')) || since;
              const w = Number(res.headers.get('x-frame-w')) || 0;
              const h = Number(res.headers.get('x-frame-h')) || 0;
              const blob = await res.blob();
              if (!alive) return;
              const next = URL.createObjectURL(blob);
              if (current) URL.revokeObjectURL(current);
              current = next;
              since = seq;
              setFrame(next);
              setMeta({ w, h });
              setError(null);
              await wait(LIVE_GAP_MS);
            } catch (err) {
              if (!alive) return;
              setError(String(err?.message ?? err));
              await wait(1000);
            }
          }
        };
        void pump();
        return () => {
          alive = false;
          if (current) URL.revokeObjectURL(current);
        };
      }, [paused, started, quality, maxWidth]);

      // 地址栏与状态：每秒问一次服务端（页面自己跳转时也能同步过来）。
      React.useEffect(() => {
        let alive = true;
        const tick = async () => {
          try {
            const res = await fetch(LIVE_STATE_PATH, { cache: 'no-store' });
            if (!res.ok) return;
            const data = await res.json();
            if (!alive) return;
            setPage(data);
            if (!editing.current) setAddr(String(data?.url ?? ''));
          } catch {
            /* 路由不可用时保留上一次状态 */
          }
        };
        void tick();
        const timer = setInterval(() => {
          if (!document.hidden) void tick();
        }, LIVE_STATE_MS);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, []);

      // 收起窗口（卸载）、暂停、或手动停帧时，告诉服务端不用再录屏了。
      React.useEffect(
        () => () => {
          void fetch(LIVE_INPUT_PATH, { method: 'DELETE' }).catch(() => {});
        },
        [],
      );
      React.useEffect(() => {
        if (paused || !started) void fetch(LIVE_INPUT_PATH, { method: 'DELETE' }).catch(() => {});
      }, [paused, started]);

      const send = React.useCallback(async (action) => {
        try {
          const res = await fetch(LIVE_INPUT_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(action),
          });
          if (!res.ok) {
            const detail = await res.json().catch(() => null);
            setError(detail?.error ?? `HTTP ${res.status}`);
            return;
          }
          setError(null);
        } catch (err) {
          setError(String(err?.message ?? err));
        }
      }, []);

      /** 屏幕坐标 → 页面坐标（帧的真实宽高来自响应头）。 */
      const point = (event) => {
        const box = stage.current?.getBoundingClientRect?.();
        if (!box || !meta.w || !meta.h || !box.width || !box.height) return null;
        return {
          x: Math.round(Math.min(meta.w, Math.max(0, ((event.clientX - box.left) * meta.w) / box.width))),
          y: Math.round(Math.min(meta.h, Math.max(0, ((event.clientY - box.top) * meta.h) / box.height))),
        };
      };

      const button = (index) => (index === 1 ? 'middle' : index === 2 ? 'right' : 'left');

      const onDown = (event) => {
        const at = point(event);
        if (!at) return;
        event.preventDefault();
        stage.current?.focus?.();
        void send({ kind: 'down', ...at, button: button(event.button) });
      };

      const onUp = (event) => {
        const at = point(event);
        if (!at) return;
        void send({ kind: 'up', ...at, button: button(event.button) });
      };

      const onMove = (event) => {
        const at = point(event);
        if (!at) return;
        const now = Date.now();
        if (now - lastMove.current < LIVE_MOVE_MS) return;
        lastMove.current = now;
        void send({ kind: 'move', ...at });
      };

      const onWheel = (event) => {
        const at = point(event) ?? { x: 0, y: 0 };
        void send({ kind: 'wheel', ...at, deltaX: Math.round(event.deltaX), deltaY: Math.round(event.deltaY) });
      };

      const onKeyDown = (event) => {
        // 宿主快捷键（Ctrl/Meta/Alt 组合）留给 DSH 自己，别喂给页面。
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        if (event.key.length === 1) {
          event.preventDefault();
          void send({ kind: 'text', text: event.key });
          return;
        }
        if (NAMED_KEYS.has(event.key)) {
          event.preventDefault();
          void send({ kind: 'key', key: event.key });
        }
      };

      const submit = (event) => {
        event.preventDefault();
        const url = addr.trim();
        editing.current = false;
        if (!url) return;
        void send({ kind: 'goto', url });
      };

      const status = page?.live
        ? `● ${page?.title || page?.url || '正在推流'}`
        : (page?.reason ?? (paused ? '已暂停' : started ? '等待浏览器会话' : '未开始取帧'));

      return React.createElement(
        'div',
        null,
        React.createElement(
          'form',
          { style: tone.addrRow, onSubmit: submit },
          React.createElement('input', {
            style: tone.addr,
            value: addr,
            placeholder: '输入网址后回车',
            spellCheck: false,
            'aria-label': '网址',
            onFocus: () => {
              editing.current = true;
            },
            onBlur: () => {
              editing.current = false;
            },
            onChange: (event) => {
              editing.current = true;
              setAddr(event.target.value);
            },
          }),
          React.createElement('button', { type: 'submit', style: tone.btn }, '跳转'),
          React.createElement('button', { type: 'button', style: tone.btn, onClick: () => void send({ kind: 'reload' }) }, '刷新'),
          React.createElement(
            'button',
            { type: 'button', style: tone.btn, onClick: () => setStarted((v) => !v) },
            started ? '停帧' : '开始',
          ),
        ),
        React.createElement(
          'div',
          {
            ref: stage,
            tabIndex: 0,
            style: tone.stage,
            onMouseDown: onDown,
            onMouseUp: onUp,
            onMouseMove: onMove,
            onWheel,
            onKeyDown,
          },
          frame && started && !paused
            ? React.createElement('img', { style: tone.img, src: frame, alt: '浏览器实时画面', draggable: false })
            : React.createElement(
                'div',
                { style: { ...tone.row, padding: '24px 10px' } },
                paused ? '已暂停' : started ? '等待第一帧…' : '未开始取帧（点上面的「开始」）',
              ),
        ),
        React.createElement(
          'div',
          { style: tone.hint },
          `${status}${error ? `\n⚠ ${error}` : page?.session ? `\n会话 ${page.session}` : ''}`,
        ),
      );
    }

    function Panel() {
      const [open, setOpen] = React.useState(false);
      const [settings, setSettings] = React.useState(() => normalizeSettings(readStore(STORAGE_KEY, {}).settings));
      const [geometry, setGeometry] = React.useState(() => clampRect(readStore(STORAGE_KEY, {}).window, {
        w: typeof window === 'undefined' ? 0 : window.innerWidth,
        h: typeof window === 'undefined' ? 0 : window.innerHeight,
      }));
      const [tab, setTab] = React.useState(settings.tab);
      const [paused, setPaused] = React.useState(false);
      const [streaming, setStreaming] = React.useState(false);
      const [snapshot, setSnapshot] = React.useState({ data: null, error: null });
      const card = React.useRef(null);

      // 视口变了（浏览器窗口缩放）就把窗口拉回可见范围。
      React.useEffect(() => {
        const onResize = () => setGeometry((prev) => clampRect(prev, { w: window.innerWidth, h: window.innerHeight }));
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
      }, []);

      // 记住窗口位置与大小（设置里可关）：入场先读，改了就写。
      React.useEffect(() => {
        if (!settings.remember) return;
        writeStore(STORAGE_KEY, { settings, window: geometry });
      }, [settings, geometry]);

      React.useEffect(() => {
        let alive = true;
        let busy = false;
        const load = async () => {
          if (busy) return;
          busy = true;
          try {
            const res = await fetch(`${PANEL_PATH}?lines=${settings.lines}`, { headers: { accept: 'application/json' } });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (alive) setSnapshot({ data, error: null });
          } catch (error) {
            // 路由没挂（例如无头 profile 没有 webServer）时别每几秒刷控制台：只记住最后一次错误。
            if (alive) setSnapshot((prev) => ({ ...prev, error: String(error?.message ?? error) }));
          } finally {
            busy = false;
          }
        };
        void load();
        const timer = setInterval(() => {
          if (!paused && !document.hidden) void load();
        }, settings.pollMs);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, [paused, settings.pollMs, settings.lines]);

      const data = snapshot.data;
      const badge = alarms(data);
      const label = data
        ? `浏览器 · ${data?.ops?.total ?? 0} 操作${badge ? ` · ${badge} 异常` : ''}`
        : snapshot.error
          ? '浏览器 · 不可用'
          : '浏览器 · …';

      /** 拖标题栏移动窗口。 */
      const startDrag = (event) => {
        if (event.button !== 0) return;
        const box = card.current?.getBoundingClientRect?.();
        if (!box) return;
        event.preventDefault();
        const offset = { x: event.clientX - box.left, y: event.clientY - box.top };
        const onMove = (moveEvent) => {
          setGeometry((prev) => clampRect(
            { x: moveEvent.clientX - offset.x, y: moveEvent.clientY - offset.y, w: prev.w, h: prev.h },
            { w: window.innerWidth, h: window.innerHeight },
          ));
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      };

      /** 拖右下角手柄缩放窗口。 */
      const startResize = (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        const box = card.current?.getBoundingClientRect?.();
        if (!box) return;
        const start = { x: event.clientX, y: event.clientY, w: box.width, h: box.height };
        const onMove = (moveEvent) => {
          setGeometry((prev) => clampRect(
            { x: prev.x, y: prev.y, w: start.w + (moveEvent.clientX - start.x), h: start.h + (moveEvent.clientY - start.y) },
            { w: window.innerWidth, h: window.innerHeight },
          ));
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      };

      const maximize = () => {
        setGeometry((prev) => {
          const full = { w: window.innerWidth - 24, h: window.innerHeight - 24 };
          const isFull = Math.abs(prev.w - full.w) < 40 && Math.abs(prev.h - full.h) < 40;
          return isFull
            ? clampRect({ x: null, y: null, w: DEFAULT_WINDOW.w, h: DEFAULT_WINDOW.h }, { w: window.innerWidth, h: window.innerHeight })
            : clampRect({ x: 12, y: 12, ...full }, { w: window.innerWidth, h: window.innerHeight });
        });
      };

      if (!open) {
        return React.createElement(
          'button',
          {
            type: 'button',
            style: tone.pill,
            title: snapshot.error ? `面板数据路由不可用：${snapshot.error}` : '打开浏览器服务面板',
            onClick: () => setOpen(true),
          },
          React.createElement('span', { style: badge ? tone.bad : tone.ok }, '●'),
          React.createElement('span', null, label),
        );
      }

      const rows = tab === 'ops' || tab === 'console' || tab === 'network' ? entries(data, tab).slice(-settings.lines) : [];
      const body = tab === 'live'
        ? [React.createElement(LivePane, {
            key: 'live',
            paused,
            settings,
            onStreamingChange: setStreaming,
          })]
        : tab === 'settings'
          ? [React.createElement(SettingsPane, {
              key: 'settings',
              settings,
              service: data?.service,
              onChange: (next) => setSettings(next),
              onReset: () => setGeometry(clampRect({ x: null, y: null, w: DEFAULT_WINDOW.w, h: DEFAULT_WINDOW.h }, {
                w: window.innerWidth,
                h: window.innerHeight,
              })),
            })]
          : rows.length
            ? rows.map((entry, index) =>
                tab === 'ops'
                  ? React.createElement(OpsRow, { key: `${entry?.seq ?? index}`, entry })
                  : tab === 'console'
                    ? React.createElement(ConsoleRow, { key: `${entry?.at ?? index}-${index}`, entry })
                    : React.createElement(NetworkRow, { key: `${entry?.at ?? index}-${index}`, entry }),
              )
            : [React.createElement(Empty, { key: 'empty' }, snapshot.error ? `面板数据路由不可用：${snapshot.error}` : '暂无数据 —— 用 browser_* 工具操作一次再看看')];

      return React.createElement(
        'div',
        {
          ref: card,
          style: {
            ...tone.card,
            left: `${geometry.x}px`,
            top: `${geometry.y}px`,
            width: `${geometry.w}px`,
            height: `${geometry.h}px`,
          },
        },
        React.createElement(
          'div',
          { style: tone.head, onMouseDown: startDrag, onDoubleClick: maximize },
          React.createElement('span', { style: tone.grip }, '⠿'),
          React.createElement('span', { style: tone.title }, '浏览器服务面板'),
          React.createElement('span', { style: tone.dim }, streaming ? '● 实时' : '○ 停帧'),
          React.createElement(
            'button',
            { type: 'button', style: tone.btn, onClick: () => setPaused((v) => !v), title: '暂停轮询与取帧' },
            paused ? '继续' : '暂停',
          ),
          React.createElement('button', { type: 'button', style: tone.btn, onClick: maximize, title: '最大化 / 还原' }, '⤢'),
          React.createElement('button', { type: 'button', style: tone.btn, onClick: () => setOpen(false), title: '收起到右下角' }, '收起'),
        ),
        React.createElement(
          'div',
          { style: { display: 'flex', flex: 1, minHeight: 0 } },
          React.createElement(
            'div',
            { style: tone.rail },
            RAIL.map(([id, name, icon]) =>
              React.createElement(
                'button',
                {
                  key: id,
                  type: 'button',
                  style: { ...tone.railBtn, ...(tab === id ? tone.railOn : {}) },
                  onClick: () => setTab(id),
                  title: name,
                },
                React.createElement('span', { style: tone.railIcon }, icon),
                React.createElement('span', null, id === 'live' || id === 'settings' ? name : `${name} ${data?.[id]?.total ?? 0}`),
              ),
            ),
          ),
          React.createElement(
            'div',
            { style: tone.main },
            React.createElement('div', { style: tone.body }, body),
            React.createElement(
              'div',
              { style: tone.foot },
              React.createElement('span', null, `更新于 ${data ? clock(data.generatedAt) : '—'}${paused ? ' · 已暂停' : ''}`),
              React.createElement('span', { style: { flex: 1 } }),
              React.createElement('span', null, `质量 ${settings.quality} · 边 ${settings.maxWidth}`),
            ),
          ),
        ),
        React.createElement('div', { style: tone.resize, onMouseDown: startResize, title: '拖动调整大小' }),
      );
    }

    function apply(ctx) {
      // shell.overlay 是 kind:list / scope:root 的 additive 座位；注册新 id 不动别人。
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'browser-service-panel', order: 200 }, Panel));
    }

    exports.name = 'browser-service-panel';
    exports.inject = ['slots'];
    exports.apply = apply;
    // 纯函数导出：给隔离验收脚本断言几何夹取与设置规整（浏览器侧不会用到）。
    exports.internals = { clampInt, clampRect, normalizeSettings, DEFAULT_WINDOW, STORAGE_KEY, DEFAULT_SETTINGS };
    return exports;
  },
});
