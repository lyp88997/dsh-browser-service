#!/usr/bin/env node
/**
 * 端到端验收（零依赖：只用 node 内置 fetch / WebSocket / http）。
 *
 * 覆盖 M1 的全部承诺：
 *   1) CDP 就绪且协议版本正确
 *   2) 只绑回环（host 网络下的硬安全要求）
 *   3) 多客户端 + 隔离上下文（cookie 互不可见）
 *   4) 浏览器崩溃后自动重启、代理自动改指向
 *   5) 无客户端时按 idle 自杀并清理状态
 *
 * 用法：node scripts/verify-daemon.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/browsersvc.mjs', import.meta.url));
const IDLE_MS = 5000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const guard = setTimeout(() => {
  console.error('\n超时（120s），提前退出');
  process.exit(1);
}, 120_000);
guard.unref?.();

async function probe(port, timeoutMs = 2000) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** 解析 /proc/net/tcp{,6}，返回该端口的 LISTEN 条目。 */
function listeners(port) {
  const hex = port.toString(16).toUpperCase().padStart(4, '0');
  const out = [];
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n').slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4) continue;
      const [addr, p] = parts[1].split(':');
      if (p === hex && parts[3] === '0A') out.push({ file, addr });
    }
  }
  return out;
}

const LOOPBACK4 = '0100007F';
const LOOPBACK6 = '00000000000000000000000001000000';
const ANY4 = '00000000';
const ANY6 = '00000000000000000000000000000000';

function assertLoopback(label, port) {
  const ls = listeners(port);
  const exposed = ls.filter((l) => l.addr === ANY4 || l.addr === ANY6);
  const ok = ls.length > 0 && exposed.length === 0;
  check(label, ok, ls.length === 0 ? `端口 ${port} 无监听` : `监听=${ls.map((l) => `${l.addr}(${l.file.split('/').pop()})`).join(',')}`);
  return ok;
}

/** 极简 CDP 客户端（原生 WebSocket）。 */
function connectCdp(port, webSocketDebuggerUrl) {
  const path = new URL(webSocketDebuggerUrl).pathname;
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`));
      else resolve(msg.result);
    }
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', (e) => reject(new Error(`ws error: ${e.message ?? 'unknown'}`)));
  });
  return {
    ready,
    send(method, params = {}, sessionId) {
      return new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`CDP 超时: ${method}`));
          }
        }, 20_000).unref?.();
      });
    },
    close: () => ws.close(),
  };
}

const evalIn = async (cdp, sessionId, expression) => {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
  return r.result?.value;
};

/** 在一个隔离上下文里开页、等加载完成，返回 sessionId。 */
async function openIsolatedContext(cdp, origin) {
  const { browserContextId } = await cdp.send('Target.createBrowserContext', {});
  const { targetId } = await cdp.send('Target.createTarget', { url: origin, browserContextId });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  for (let i = 0; i < 60; i += 1) {
    if ((await evalIn(cdp, sessionId, 'document.readyState')) === 'complete') break;
    await sleep(100);
  }
  return { browserContextId, targetId, sessionId };
}

// ── 1. 本地源（不依赖外网） ────────────────────────────────────────────────
const originServer = http.createServer((_req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end('<!doctype html><title>iso</title><h1>ok</h1>');
});
await new Promise((r) => originServer.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${originServer.address().port}/`;

// ── 2. 起守护进程 ─────────────────────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), 'browsersvc-verify-'));
const child = spawn(process.execPath, [BIN, 'run', `--root=${root}`, '--port=0', `--idle-ms=${IDLE_MS}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
let err = '';
child.stdout.on('data', (d) => {
  out += d.toString();
});
child.stderr.on('data', (d) => {
  err += d.toString();
});

let info = null;
for (let i = 0; i < 150 && !info; i += 1) {
  await sleep(200);
  const line = out.split('\n').find((l) => l.includes('"ready":true'));
  if (line) info = JSON.parse(line);
  if (child.exitCode !== null) break;
}

if (!info) {
  check('守护进程启动', false, `未就绪；stderr=${err.trim().slice(0, 300)} log=${join(root, 'service.log')}`);
  console.log(`\n日志尾部:\n${existsSync(join(root, 'service.log')) ? readFileSync(join(root, 'service.log'), 'utf8').split('\n').slice(-12).join('\n') : '(无)'}`);
  process.exit(1);
}
check('守护进程启动', true, `公开端口 ${info.port} → 内部端口 ${info.internalPort}`);

const port = info.port;
const version = await probe(port);
check('CDP /json/version', version?.['Protocol-Version'] === '1.3', `Browser=${version?.Browser}`);

// ── 3. 只绑回环 ───────────────────────────────────────────────────────────
assertLoopback('公开端口只绑 127.0.0.1', port);
assertLoopback('内部端口只绑 127.0.0.1', info.internalPort);

// ── 4. 隔离上下文 ─────────────────────────────────────────────────────────
try {
  const cdp = connectCdp(port, version.webSocketDebuggerUrl);
  await cdp.ready;
  const a = await openIsolatedContext(cdp, origin);
  const b = await openIsolatedContext(cdp, origin);
  check('两个隔离上下文（不同 browserContextId）', a.browserContextId !== b.browserContextId, `${a.browserContextId?.slice(0, 8)} vs ${b.browserContextId?.slice(0, 8)}`);
  const cookieA = await evalIn(cdp, a.sessionId, "document.cookie='iso=ctx1'; document.cookie");
  const cookieB = await evalIn(cdp, b.sessionId, 'document.cookie');
  check('上下文 A 能写 cookie', cookieA === 'iso=ctx1', `A="${cookieA}"`);
  check('上下文 B 看不到 A 的 cookie（隔离生效）', cookieB === '', `B="${cookieB}"`);
  const title = await evalIn(cdp, a.sessionId, 'document.title');
  check('页面真实渲染', title === 'iso', `title="${title}"`);
  cdp.close();
} catch (e) {
  check('隔离上下文测试', false, e.message);
}

// ── 5. 崩溃自动重启 ───────────────────────────────────────────────────────
const stateFile = join(root, 'service.json');
const before = JSON.parse(readFileSync(stateFile, 'utf8'));
process.kill(before.browserPid, 'SIGKILL');
let after = null;
for (let i = 0; i < 60; i += 1) {
  await sleep(500);
  const v = await probe(port);
  const st = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : null;
  if (v && st && st.browserPid && st.browserPid !== before.browserPid) {
    after = st;
    break;
  }
}
check('浏览器被杀后自动重启', Boolean(after), after ? `browserPid ${before.browserPid} → ${after.browserPid}` : '未在 30s 内恢复');
if (after) check('重启后代理仍可用（自动改指向）', Boolean(await probe(port)), `内部端口 ${after.internalPort}`);

// ── 6. 空闲自杀 ───────────────────────────────────────────────────────────
for (let i = 0; i < 80 && child.exitCode === null; i += 1) await sleep(250);
const gone = child.exitCode !== null;
check('空闲后自动退出', gone, `exitCode=${child.exitCode}`);
check('退出后清理状态文件', !existsSync(stateFile));
check('退出后端口释放', (await probe(port, 800)) === null);

// ── 汇总 ──────────────────────────────────────────────────────────────────
await new Promise((r) => originServer.close(r));
rmSync(root, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
