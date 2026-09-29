/**
 * 浏览器服务面板 —— 客户端半边（P3 / 0.6.0 只读看板，P4 / 0.7.0 加实时网页窗口）。
 *
 * 这是 DSH 网页里的一个浮动面板，两个用途：
 *   1. 「网页」标签（默认）：**实时画面 + 直接操作**——把宿主半边 `/browser-service/live.jpg`
 *      的 JPEG 帧贴成图片流，窗口里的点击/滚动/打字经 `/browser-service/live` 转发给真浏览器，
 *      顶部地址栏可跳转（走 provider 的导航通道）。
 *   2. 其余标签：只读观测数据（最近的操作、控制台输出、网络请求），来自 `/browser-service/panel.json`。
 *
 * 手写、零构建：宿主把本文件按 URL 原样吐给浏览器，只要求它是那段固定协议——
 *   `window.__ModuleLoader__.load({ id, factory: (require) => exports })`
 * 并且裸 `require` 只能点平台种子表里的 9 个词（这里有且只有 `react`）。
 * require('@deepseek-ai/dsh-client-ui-layout') 之类不在种子里，会抛 "missed the module table"，
 * 所以样式一律用内联 style，不引第三方 UI 包。
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
    /** 每次拉的条数（服务端上限 200）。 */
    const LINES = 40;
    /** 轮询间隔：数据是本地 JSONL 的尾巴，2.5s 足够新，也不吵。 */
    const POLL_MS = 2500;
    /** 实时画面：服务端没有新帧（204）时的重试间隔。 */
    const LIVE_RETRY_MS = 250;
    /** 收到一帧之后的最小间隔：动画期间别把主线程和网络占满。 */
    const LIVE_GAP_MS = 40;
    /** 地址栏/状态同步间隔。 */
    const LIVE_STATE_MS = 1000;
    /** 鼠标移动转发节流。 */
    const LIVE_MOVE_MS = 100;
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
    const TABS = [
      ['live', '网页'],
      ['ops', '操作'],
      ['console', '控制台'],
      ['network', '网络'],
    ];

    const tone = {
      card: {
        position: 'fixed',
        right: '16px',
        bottom: '16px',
        zIndex: 40,
        width: 'min(460px, calc(100vw - 32px))',
        maxHeight: 'min(56vh, 520px)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        borderRadius: '10px',
        border: '1px solid rgba(255,255,255,0.16)',
        background: 'rgba(18,18,22,0.94)',
        color: '#e8e8ea',
        boxShadow: '0 10px 30px rgba(0,0,0,0.45)',
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
        padding: '6px 10px',
        borderRadius: '999px',
        border: '1px solid rgba(255,255,255,0.16)',
        background: 'rgba(18,18,22,0.9)',
        color: '#e8e8ea',
        font: '12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        cursor: 'pointer',
      },
      btn: {
        padding: '2px 7px',
        borderRadius: '6px',
        border: '1px solid rgba(255,255,255,0.18)',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        cursor: 'pointer',
      },
      btnOn: {
        background: 'rgba(120,170,255,0.22)',
        borderColor: 'rgba(120,170,255,0.5)',
      },
      head: { display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 10px', borderBottom: '1px solid rgba(255,255,255,0.13)' },
      title: { flex: 1, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      tabs: { display: 'flex', gap: '4px', padding: '6px 10px', borderBottom: '1px solid rgba(255,255,255,0.13)' },
      body: { overflow: 'auto', padding: '4px 0' },
      row: { display: 'flex', gap: '6px', padding: '2px 10px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' },
      dim: { color: 'rgba(232,232,234,0.55)' },
      ok: { color: '#78d99a' },
      bad: { color: '#ff8b8b' },
      warn: { color: '#e8c57a' },
      foot: { padding: '5px 10px', borderTop: '1px solid rgba(255,255,255,0.13)', color: 'rgba(232,232,234,0.5)' },
      addrRow: { display: 'flex', gap: '6px', padding: '6px 10px', borderBottom: '1px solid rgba(255,255,255,0.13)' },
      addr: {
        flex: 1,
        minWidth: 0,
        padding: '3px 6px',
        borderRadius: '6px',
        border: '1px solid rgba(255,255,255,0.18)',
        background: 'rgba(255,255,255,0.06)',
        color: 'inherit',
        font: 'inherit',
      },
      stage: {
        position: 'relative',
        margin: '8px 10px',
        borderRadius: '8px',
        border: '1px solid rgba(255,255,255,0.16)',
        background: '#0b0b0e',
        overflow: 'hidden',
        cursor: 'crosshair',
        outline: 'none',
      },
      img: { display: 'block', width: '100%', userSelect: 'none', WebkitUserDrag: 'none' },
      hint: { padding: '4px 10px 8px', color: 'rgba(232,232,234,0.55)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' },
    };

    /** 时间戳 → 本地 HH:MM:SS；脏数据不炸。 */
    function clock(value) {
      const at = new Date(value);
      return Number.isFinite(at.getTime()) ? at.toTimeString().slice(0, 8) : '--:--:--';
    }

    function text(value, max = 240) {
      if (value === undefined || value === null) return '';
      const raw = typeof value === 'string' ? value : safeJson(value);
      return raw.length > max ? `${raw.slice(0, max)}…` : raw;
    }

    function safeJson(value) {
      try {
        return JSON.stringify(value) ?? String(value);
      } catch {
        return String(value);
      }
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

    /**
     * 「网页」标签：实时画面 + 直接操作。
     * 画面走长轮询（服务端把「等新帧」放在自己那边，静止时零流量），
     * 点击/滚动/打字转发给真浏览器，收起或暂停时告诉服务端停流（省 CPU）。
     */
    function LivePane({ paused }) {
      const [frame, setFrame] = React.useState(null); // 当前帧的 object URL
      const [meta, setMeta] = React.useState({ w: 0, h: 0 });
      const [page, setPage] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [addr, setAddr] = React.useState('');
      const editing = React.useRef(false);
      const stage = React.useRef(null);
      const lastMove = React.useRef(0);

      React.useEffect(() => {
        if (paused) return undefined;
        let alive = true;
        let since = 0;
        let current = null; // 上一帧的 object URL：换帧时立刻释放，免得内存越滚越大
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const pump = async () => {
          while (alive) {
            try {
              const res = await fetch(`${LIVE_IMAGE_PATH}?since=${since}`, { cache: 'no-store' });
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
      }, [paused]);

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

      // 收起面板（卸载）或暂停时，告诉服务端不用再录屏了。
      React.useEffect(
        () => () => {
          void fetch(LIVE_INPUT_PATH, { method: 'DELETE' }).catch(() => {});
        },
        [],
      );
      React.useEffect(() => {
        if (paused) void fetch(LIVE_INPUT_PATH, { method: 'DELETE' }).catch(() => {});
      }, [paused]);

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
        : (page?.reason ?? (paused ? '已暂停' : '等待浏览器会话'));

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
          frame
            ? React.createElement('img', { style: tone.img, src: frame, alt: '浏览器实时画面', draggable: false })
            : React.createElement('div', { style: { ...tone.row, padding: '24px 10px' } }, paused ? '已暂停' : '等待第一帧…'),
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
      const [tab, setTab] = React.useState('live');
      const [paused, setPaused] = React.useState(false);
      const [snapshot, setSnapshot] = React.useState({ data: null, error: null });

      React.useEffect(() => {
        let alive = true;
        let busy = false;
        const load = async () => {
          if (busy) return;
          busy = true;
          try {
            const res = await fetch(`${PANEL_PATH}?lines=${LINES}`, { headers: { accept: 'application/json' } });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (alive) setSnapshot({ data, error: null });
          } catch (error) {
            // 路由没挂（例如无头 profile 没有 webServer）时别每 2.5s 刷控制台：只记住最后一次错误。
            if (alive) setSnapshot((prev) => ({ ...prev, error: String(error?.message ?? error) }));
          } finally {
            busy = false;
          }
        };
        void load();
        const timer = setInterval(() => {
          if (!paused && !document.hidden) void load();
        }, POLL_MS);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, [paused]);

      const data = snapshot.data;
      const badge = alarms(data);
      const label = data
        ? `浏览器 · ${data?.ops?.total ?? 0} 操作${badge ? ` · ${badge} 异常` : ''}`
        : snapshot.error
          ? '浏览器 · 不可用'
          : '浏览器 · …';

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

      const rows = tab === 'live' ? [] : entries(data, tab).slice(-LINES);
      const body = tab === 'live'
        ? [React.createElement(LivePane, { key: 'live', paused })]
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
        { style: tone.card },
        React.createElement(
          'div',
          { style: tone.head },
          React.createElement('span', { style: tone.title }, '浏览器服务面板'),
          React.createElement('button', { type: 'button', style: tone.btn, onClick: () => setPaused((v) => !v) }, paused ? '继续' : '暂停'),
          React.createElement('button', { type: 'button', style: tone.btn, onClick: () => setOpen(false) }, '收起'),
        ),
        React.createElement(
          'div',
          { style: tone.tabs },
          TABS.map(([id, name]) =>
            React.createElement(
              'button',
              { key: id, type: 'button', style: { ...tone.btn, ...(tab === id ? tone.btnOn : {}) }, onClick: () => setTab(id) },
              id === 'live' ? name : `${name} ${data?.[id]?.total ?? 0}`,
            ),
          ),
        ),
        React.createElement('div', { style: tone.body }, body),
        React.createElement('div', { style: tone.foot }, `更新于 ${data ? clock(data.generatedAt) : '—'}${paused ? ' · 已暂停' : ''}`),
      );
    }

    function apply(ctx) {
      // shell.overlay 是 kind:list / scope:root 的 additive 座位；注册新 id 不动别人。
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'browser-service-panel', order: 200 }, Panel));
    }

    exports.name = 'browser-service-panel';
    exports.inject = ['slots'];
    exports.apply = apply;
    return exports;
  },
});
