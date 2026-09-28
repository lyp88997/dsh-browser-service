/**
 * 浏览器服务面板 —— 客户端半边（P3 / 0.6.0）。
 *
 * 这是 DSH 网页里的一个**只读**浮动看板：把宿主半边 `plugin/lib/panel.js` 挂在
 * `/browser-service/panel.json` 上的观测数据（最近的操作、控制台输出、网络请求）画出来。
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
    /** 每次拉的条数（服务端上限 200）。 */
    const LINES = 40;
    /** 轮询间隔：数据是本地 JSONL 的尾巴，2.5s 足够新，也不吵。 */
    const POLL_MS = 2500;
    const TABS = [
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

    function Panel() {
      const [open, setOpen] = React.useState(false);
      const [tab, setTab] = React.useState('ops');
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

      const rows = entries(data, tab).slice(-LINES);
      const body = rows.length
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
              `${name} ${data?.[id]?.total ?? 0}`,
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
