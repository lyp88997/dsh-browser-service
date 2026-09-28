/**
 * 网页面板的宿主半边：一个**只读** JSON 路由。
 *
 * 数据全部来自观测日志文件（`src/opslog.mjs` 写的 ops/console/network.jsonl），
 * 所以这里不需要碰浏览器、不需要会话、也不给宿主添任何写入口 —— 面板坏了也不会
 * 影响浏览器工具本身。
 *
 * 客户端半边（`plugin/client.js`）轮询这个路由，把最近的操作/控制台/网络渲染成
 * 浮动看板。
 */
import { readConsole, readNetwork, readOps } from '../../src/opslog.mjs';
import { defaultRoot } from '../../src/config.mjs';

export const PANEL_PATH = '/browser-service/panel.json';

/** 面板一次最多拉多少条：够看，又不至于把网页拖垮。 */
const MAX_LINES = 200;
const DEFAULT_LINES = 40;

function linesOf(reqUrl) {
  let raw;
  try {
    raw = new URL(reqUrl, 'http://127.0.0.1').searchParams.get('lines');
  } catch {
    return DEFAULT_LINES;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_LINES;
  return Math.min(MAX_LINES, Math.max(1, Math.floor(value)));
}

/** 面板载荷：只给条目数与条目，不回传本机绝对路径。 */
export function panelPayload({ root = defaultRoot(), lines = DEFAULT_LINES } = {}) {
  const shape = ({ total, entries }) => ({ total, entries });
  return {
    generatedAt: new Date().toISOString(),
    ops: shape(readOps({ root, lines })),
    console: shape(readConsole({ root, lines })),
    network: shape(readNetwork({ root, lines })),
  };
}

/** 注册只读路由；返回 disposer。宿主没有 webServer 服务时由调用方跳过。 */
export function registerPanel(ctx) {
  const handler = (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'GET' });
      res.end('{"error":"只支持 GET"}');
      return;
    }
    let body;
    try {
      body = JSON.stringify(panelPayload({ lines: linesOf(req.url) }));
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  };

  const dispose = ctx.webServer.register({ kind: 'exact', path: PANEL_PATH, handler });
  return () => {
    try {
      dispose();
    } catch {
      /* 路由已经跟着宿主一起没了：忽略 */
    }
  };
}
