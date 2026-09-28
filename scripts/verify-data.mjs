#!/usr/bin/env node
/**
 * 端到端验收 P3 数据层：观测文件 + `browsersvc` 的 ops / console / network / har / cookies。
 *
 * 不碰外网：本地起测试站点（set-cookie、console、fetch），真 spawn 守护进程（真 Chromium 内核），
 * 用真 provider（plugin/lib/provider.js）跑出记录，再用 bin/browsersvc.mjs 的 CLI 读回/注入。
 *
 *   node scripts/verify-data.mjs
 *
 * 环境变量：
 *   DSH_BROWSER_SVC_CLI   暴露的 CLI 路径（默认 ../bin/browsersvc.mjs）
 *   BROWSERSVC_PORT       公开端口（默认 9414）
 *   KEEP_ROOT=1           保留临时 root（排错用）
 */
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendOp, readOps } from '../src/opslog.mjs';
import { PANEL_PATH, registerPanel } from '../plugin/lib/panel.js';
import { createProvider } from '../plugin/lib/provider.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const CLI = process.env.DSH_BROWSER_SVC_CLI ?? resolve(HERE, '../bin/browsersvc.mjs');
const PORT = Number(process.env.BROWSERSVC_PORT ?? 9414);

let passed = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ── 本地测试站点 ────────────────────────────────────────────────────────────
const HOME = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>观测页</title></head><body>
<h1 id="head">标题</h1>
<script>
  localStorage.setItem('demo', 'x');
  console.log('hello from page');
  console.error('bad thing');
  fetch('/api').then((r) => r.json()).then((d) => console.log('api', d.ok));
</script>
</body></html>`;
const CLEAN = '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>干净页</title></head><body>clean</body></html>';

const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  if (path === '/api') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  if (path === '/clean') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(CLEAN);
    return;
  }
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'set-cookie': ['probe=1; Path=/', 'secret=s3cr3t; Path=/; HttpOnly'],
  });
  response.end(HOME);
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const BASE = `http://127.0.0.1:${server.address().port}`;

// ── 守护进程 ────────────────────────────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), 'browsersvc-verify-data-'));
const daemon = spawn(process.execPath, [CLI, 'run', `--root=${root}`, `--port=${PORT}`, '--idle-ms=3600000'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let daemonOutput = '';
daemon.stdout.on('data', (chunk) => { daemonOutput += chunk; });
daemon.stderr.on('data', (chunk) => { daemonOutput += chunk; });

async function waitForReady(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const line of daemonOutput.split('\n')) {
      if (!line.trim().startsWith('{')) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.ready === true) return parsed;
      } catch { /* 行还没写完 */ }
    }
    if (daemon.exitCode !== null) throw new Error(`守护进程提前退出（${daemon.exitCode}）：\n${daemonOutput}`);
    await new Promise((ok) => setTimeout(ok, 120));
  }
  throw new Error(`等待守护进程就绪超时：\n${daemonOutput}`);
}

/** 跑 CLI：命令必须在标志之前（parse() 把 argv[0] 当命令）。 */
function cli(...args) {
  const stdout = execFileSync(process.execPath, [CLI, ...args, `--root=${root}`, `--port=${PORT}`], { encoding: 'utf8' });
  return JSON.parse(stdout);
}
const cliFails = (...args) => {
  try {
    cli(...args);
    return false;
  } catch {
    return true;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let provider;
const shutdown = async () => {
  try { await provider?.dispose(); } catch { /* 忽略 */ }
  server.close();
  if (daemon.exitCode === null) daemon.kill('SIGTERM');
  await sleep(300);
  if (daemon.exitCode === null) daemon.kill('SIGKILL');
  await new Promise((done) => {
    const p = spawn(process.execPath, [CLI, 'stop', `--root=${root}`], { stdio: 'ignore' });
    p.on('close', done);
    p.on('error', done);
  });
  if (process.env.KEEP_ROOT !== '1') rmSync(root, { recursive: true, force: true });
};

const EXPORT = join(root, '..', `verify-data-export-${process.pid}.json`);

try {
  const ready = await waitForReady();
  console.log(`守护进程就绪：port=${ready.port} kernel=${ready.kernelKind}\n`);

  process.env.DSH_BROWSER_SVC_ROOT = root;
  const { chromium } = await import('playwright-core');
  provider = createProvider({
    chromium,
    config: {
      providerId: 'cdp-daemon',
      cdpUrl: `http://127.0.0.1:${PORT}`,
      connectTimeoutMs: 10_000,
      actionTimeoutMs: 15_000,
      navigationTimeoutMs: 15_000,
      lookupTimeoutMs: 5_000,
      snapshotMaxElements: 200,
      contentMaxChars: 200_000,
      viewportWidth: 1440,
      viewportHeight: 900,
      downloadDir: root,
    },
  });

  // ── 观测：ops / console / network ─────────────────────────────────────────
  console.log('P3 数据层：ops');
  const session = await provider.open('data');
  await provider.openUrl(session, { url: `${BASE}/` });
  await provider.execute(session, { script: 'document.title' });
  await sleep(400);

  const ops = cli('ops', '--json');
  const opsEntries = ops.entries ?? [];
  check('ops.jsonl 记下了 navigate 与 execute', opsEntries.some((e) => e.action === 'navigate') && opsEntries.some((e) => e.action === 'execute'), JSON.stringify(opsEntries.map((e) => e.action)));
  check('ops 每条带耗时/成败/会话与标签', opsEntries.length > 0 && opsEntries.every((e) => Number.isFinite(e.ms) && typeof e.ok === 'boolean' && e.session === session && typeof e.tab === 'string'));
  check('ops 记录了目标 URL 与结果摘要', opsEntries.some((e) => String(e.params ?? '').includes('/')) && opsEntries.some((e) => e.action === 'execute' && String(e.result ?? '').includes('观测页')), JSON.stringify(opsEntries.slice(-2)));
  check('open 不记入 ops（会话创建不是一次操作）', !opsEntries.some((e) => e.action === 'open'), JSON.stringify(opsEntries.map((e) => e.action)));
  const opsLines = execFileSync(process.execPath, [CLI, 'ops', `--root=${root}`, `--port=${PORT}`], { encoding: 'utf8' });
  check('ops 人话表格带汇总行', opsLines.includes('共 ') && opsLines.includes('ops.jsonl'));
  check('ops --lines 生效', (cli('ops', '--json', '--lines=1').entries ?? []).length === 1);

  // P3：通用追踪 —— 不带 #record 的读操作（snapshot/content/screenshot/listTabs…）也要进 ops，
  // 否则面板时间线只看得见点击与导航，读操作全丢。
  await provider.snapshot(session);
  await provider.content(session, { format: 'txt' });
  await provider.screenshot(session);
  await provider.listTabs(session);
  await provider.execute(session, { script: 'throw new Error("观测失败")' });
  await sleep(300);
  const traced = cli('ops', '--json').entries ?? [];
  const tracedActions = traced.map((e) => e.action);
  check('通用追踪覆盖 snapshot/content/screenshot/listTabs', ['snapshot', 'content', 'screenshot', 'listTabs'].every((a) => tracedActions.includes(a)), JSON.stringify(tracedActions));
  const tracedEntry = traced.filter((e) => ['snapshot', 'content', 'screenshot', 'listTabs'].includes(e.action));
  check('追踪条目也带耗时/会话/标签', tracedEntry.length >= 4 && tracedEntry.every((e) => Number.isFinite(e.ms) && e.session === session && e.tab === 't1' && e.ok === true), JSON.stringify(tracedEntry));
  const failedEntry = traced.find((e) => e.action === 'execute' && e.ok === false);
  check('失败操作记为 ok:false 并带错误原因', Boolean(failedEntry && String(failedEntry.error ?? '').includes('观测失败')), JSON.stringify(failedEntry));

  console.log('\nP3 数据层：console');
  const consoleLog = cli('console', '--json');
  const consoleEntries = consoleLog.entries ?? [];
  check('console.jsonl 抓到页面 log 与 error', consoleEntries.some((e) => e.type === 'log' && String(e.text).includes('hello from page')) && consoleEntries.some((e) => e.type === 'error' && String(e.text).includes('bad thing')), JSON.stringify(consoleEntries.map((e) => e.type)));
  check('console 记录带 URL 与所属标签', consoleEntries.every((e) => typeof e.url === 'string' && typeof e.session === 'string' && typeof e.tab === 'string'));

  console.log('\nP3 数据层：network');
  const network = cli('network', '--json');
  const networkEntries = network.entries ?? [];
  check('network.jsonl 记下 request/response 两个阶段', networkEntries.some((e) => e.phase === 'request') && networkEntries.some((e) => e.phase === 'response'), JSON.stringify(networkEntries.map((e) => `${e.phase}:${e.url}`)));
  check('response 带状态码与耗时', networkEntries.some((e) => e.phase === 'response' && e.status === 200 && Number.isFinite(e.ms)), JSON.stringify(networkEntries.filter((e) => e.phase === 'response')));
  check('抓到页面发起的 /api 请求', networkEntries.some((e) => String(e.url).endsWith('/api')));
  check('network 不记请求头与响应体（只记元数据）', networkEntries.every((e) => !('headers' in e) && !('body' in e)));

  console.log('\nP3 数据层：cookies 导出');
  const cookieJson = cli('cookies', '--json');
  const allCookies = (cookieJson.contexts ?? []).flatMap((c) => c.cookies ?? []);
  check('读到页面 cookie（probe=1）', allCookies.some((c) => c.name === 'probe' && c.value === '1'), JSON.stringify(allCookies));
  check('httpOnly cookie 也能读到（document.cookie 读不到）', allCookies.some((c) => c.name === 'secret' && c.httpOnly === true));
  check('读到 localStorage origin 快照', (cookieJson.origins ?? []).some((o) => o.origin === BASE && o.items.demo === 'x'), JSON.stringify(cookieJson.origins));
  check('cookie 只带稳定字段', allCookies.every((c) => Object.keys(c).every((k) => ['name', 'value', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite'].includes(k))));
  check('--url 过滤命中本站', (cli('cookies', '--json', `--url=${BASE}/`).contexts ?? []).flatMap((c) => c.cookies).some((c) => c.name === 'probe'));
  const other = cli('cookies', '--json', '--url=https://other.example/');
  check('--url 过滤不含本站时导出为空（--json 仍退出 0）', (other.contexts ?? []).length === 0 && (other.origins ?? []).length === 0);
  const exported = cli('cookies', `--export=${EXPORT}`);
  check('--export 写文件并回报条数', exported.exported === EXPORT && exported.cookies >= 2, JSON.stringify(exported));
  check('导出文件权限 0600', (statSync(EXPORT).mode & 0o777) === 0o600, `mode=${(statSync(EXPORT).mode & 0o777).toString(8)}`);
  check('--export 拒绝覆盖已有文件', cliFails('cookies', `--export=${EXPORT}`));

  // ── HAR：只在会话关闭后落盘 ───────────────────────────────────────────────
  console.log('\nP3 数据层：har');
  await provider.close(session);
  let harFiles = [];
  for (let i = 0; i < 20 && harFiles.length === 0; i += 1) {
    await sleep(150);
    const dir = join(root, 'har');
    harFiles = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.har')) : [];
  }
  check('会话关闭后写出 HAR', harFiles.length === 1 && harFiles[0].endsWith(`-${session}.har`), JSON.stringify(harFiles));
  const harInfo = cli('har');
  check('har 命令报出路径与字节', typeof harInfo.har === 'string' && harInfo.bytes > 0, JSON.stringify(harInfo));
  const harJson = JSON.parse(readFileSync(harInfo.har, 'utf8'));
  check('HAR 里含本次请求', (harJson.log?.entries ?? []).some((e) => String(e.request?.url).startsWith(BASE)), `${(harJson.log?.entries ?? []).length} 条`);
  const harOut = join(root, '..', `verify-data-copy-${process.pid}.har`);
  check('har --out 复制到指定文件', cli('har', `--out=${harOut}`).har === harOut && statSync(harOut).size > 0);
  check('har --out 拒绝覆盖已有文件', cliFails('har', `--out=${harOut}`));
  check('har --session 能按会话挑文件', cli('har', `--session=${session}`).har.endsWith(`-${session}.har`));
  rmSync(harOut, { force: true });

  // ── cookies 注入 ─────────────────────────────────────────────────────────
  console.log('\nP3 数据层：cookies 注入');
  const fresh = await provider.open('fresh');
  await provider.openUrl(fresh, { url: `${BASE}/clean` });
  const before = (await provider.execute(fresh, { script: 'document.cookie' })).value;
  const beforeLs = (await provider.execute(fresh, { script: 'JSON.stringify(Object.fromEntries(Object.entries(localStorage)))' })).value;
  check('新会话起始是干净的', before === '' && beforeLs === '{}', `cookie="${before}" ls=${beforeLs}`);
  const imported = cli('cookies', `--import=${EXPORT}`);
  check('--import 把 cookie 写进活会话上下文', imported.cookies >= 2 && imported.contexts === 1, JSON.stringify(imported));
  check('--import 恢复 localStorage', imported.items >= 1, `items=${imported.items}`);
  const after = (await provider.execute(fresh, { script: 'document.cookie' })).value;
  const afterLs = (await provider.execute(fresh, { script: 'JSON.stringify(Object.fromEntries(Object.entries(localStorage)))' })).value;
  check('页面 document.cookie 看到注入的普通 cookie', after.includes('probe=1'), after);
  check('页面 localStorage 看到注入的键', afterLs.includes('"demo":"x"'), afterLs);
  check('httpOnly cookie 注入到 Storage 层', (cli('cookies', '--json').contexts ?? []).flatMap((c) => c.cookies).some((c) => c.name === 'secret'));
  await provider.close(fresh);

  // ── 网页面板：宿主半边的只读 JSON 路由 ───────────────────────────────────
  console.log('\nP3 面板：宿主只读路由');
  let route = null;
  const panelEffects = [];
  const fakeCtx = {
    webServer: {
      register: (entry) => {
        route = entry;
        return () => {
          route = null;
        };
      },
    },
    effect: (fn) => panelEffects.push(fn()),
    logger: { info() {}, warn() {}, error() {} },
  };
  const disposePanel = registerPanel(fakeCtx);
  check('路由注册成 exact + PANEL_PATH', route?.kind === 'exact' && route.path === PANEL_PATH);
  const panelServer = createServer((request, response) => route.handler(request, response));
  await new Promise((r) => panelServer.listen(0, '127.0.0.1', r));
  const panelUrl = `http://127.0.0.1:${panelServer.address().port}${PANEL_PATH}`;
  const payload = await (await fetch(`${panelUrl}?lines=1`)).json();
  check('GET 返回 ops/console/network 三份', Boolean(payload.ops && payload.console && payload.network));
  check('--lines 生效（?lines=1 只回 1 条）', payload.ops.entries.length === 1, `entries=${payload.ops.entries.length} total=${payload.ops.total}`);
  check('面板条目就是观测到的真实操作', payload.ops.entries.every((e) => typeof e.action === 'string' && typeof e.ms === 'number'));
  check('面板载荷不含本机绝对路径', !JSON.stringify(payload).includes(root));
  const rejected = await fetch(panelUrl, { method: 'POST' });
  await rejected.text();
  check('非 GET 报 405', rejected.status === 405, `status=${rejected.status}`);
  await new Promise((r) => panelServer.close(r));
  disposePanel();
  check('dispose 后路由被摘掉', route === null);

  // ── 观测落盘不能把浏览器调用搞挂 ─────────────────────────────────────────
  console.log('\nP3 数据层：观测容错');
  const notADir = join(root, 'ops.jsonl'); // 拿一个普通文件当 root：mkdir 必然失败
  check('写不进去时 appendOp 返回 false（不抛）', appendOp({ at: Date.now(), action: 'x' }, { root: notADir }) === false);
  check('没有记录时 readOps 给空列表', readOps({ root: join(root, '不存在这个目录') }).entries.length === 0);
  rmSync(EXPORT, { force: true });
} catch (error) {
  check('验收脚本自身未抛异常', false, `${error?.stack ?? error}`);
} finally {
  await shutdown();
}

console.log(`\n结果：${passed} 通过，${failures.length} 失败`);
if (failures.length > 0) console.log(`失败项：${failures.join('、')}`);
process.exit(failures.length === 0 ? 0 : 1);
