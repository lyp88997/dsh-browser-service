#!/usr/bin/env node
/**
 * 端到端验收 dsh-browser-cdp（provider）+ browsersvc（守护进程）。
 *
 * 不碰外网：本地起一个静态测试站点 + 真去 spawn 守护进程（真 Chromium 内核），
 * 然后按 seam 契约逐项调用 provider 的方法，断言返回值/错误码/副作用。
 *
 *   node scripts/verify-provider.mjs
 *
 * 环境变量：
 *   DSH_BROWSER_SVC_CLI   暴露的 CLI 路径（默认 ../bin/browsersvc.mjs）
 *   BROWSERSVC_PORT       公开端口（默认 9412）
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProvider } from '../plugin/lib/provider.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const CLI = process.env.DSH_BROWSER_SVC_CLI ?? resolve(HERE, '../bin/browsersvc.mjs');
const PORT = Number(process.env.BROWSERSVC_PORT ?? 9412);

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
async function expectCode(name, code, fn) {
  try {
    await fn();
    check(name, false, '未抛出错误');
  } catch (error) {
    check(name, error?.code === code, `code=${error?.code} message=${error?.message}`);
  }
}

// ── 本地测试站点 ────────────────────────────────────────────────────────────
const HOME = (base) => `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>CDP 测试页</title></head>
<body>
  <h1 id="head">标题</h1>
  <a id="link" href="/next">去下一页</a>
  <button id="btn" onclick="document.getElementById('head').textContent='已点击'">点击我</button>
  <input id="q" name="q" placeholder="搜索框">
  <input type="checkbox" id="agree" name="agree">
  <select id="pick" name="pick"><option value="a">甲</option><option value="b">乙</option></select>
  <div id="editable" contenteditable="true">可编辑</div>
  <div class="card"><span class="t">一</span><a href="/next">L1</a></div>
  <div class="card"><span class="t">二</span><a href="/next">L2</a></div>
  <form id="form" action="/submitted"><input name="q2" placeholder="表单框"><input type="checkbox" name="ok"></form>
  <div style="height:4000px" aria-hidden="true"></div>
  <div id="emoji">😀😀😀</div>
  <p id="base">${base}</p>
</body></html>`;
const NEXT = '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>第二页</title></head><body><h1>第二页</h1><div class="card"><span class="t">三</span><a href="/next">L3</a></div></body></html>';
const CAPTCHA = '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>验证</title></head><body><div class="h-captcha" data-sitekey="x"></div></body></html>';

const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  const body = path === '/next' ? NEXT : path === '/captcha' ? CAPTCHA : HOME(`base:${path}`);
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(body);
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const BASE = `http://127.0.0.1:${server.address().port}`;

// ── 守护进程 ────────────────────────────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), 'browsersvc-verify-provider-'));
const daemon = spawn(process.execPath, [CLI, 'run', `--root=${root}`, `--port=${PORT}`, '--idle-ms=120000'], {
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
      } catch { /* 还没写完一行 */ }
    }
    if (daemon.exitCode !== null) throw new Error(`守护进程提前退出（${daemon.exitCode}）：\n${daemonOutput}`);
    await new Promise((ok) => setTimeout(ok, 120));
  }
  throw new Error(`等待守护进程就绪超时：\n${daemonOutput}`);
}

let provider;
const shutdown = async () => {
  try { await provider?.dispose(); } catch { /* 忽略 */ }
  server.close();
  if (daemon.exitCode === null) daemon.kill('SIGTERM');
  await new Promise((ok) => setTimeout(ok, 300));
  if (daemon.exitCode === null) daemon.kill('SIGKILL');
  // F22 用例会 restart 守护进程：重启后的实例不是我们 spawn 的那个子进程，只杀子进程会
  // 漏掉它（占着端口 + 留着内核，下次运行直接 EADDRINUSE）。统一再交给 CLI stop 收一遍，
  // 它带 F3 的 pid 身份校验，不会误杀。
  await new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, 'stop', `--root=${root}`], { stdio: 'ignore' });
    p.on('close', resolve);
    p.on('error', resolve);
  });
  if (process.env.KEEP_ROOT !== '1') rmSync(root, { recursive: true, force: true });
};

try {
  const ready = await waitForReady();
  console.log(`守护进程就绪：${JSON.stringify(ready)}\n`);

  // provider 的真实取 token 路径：读 <root>/service.json（部署时 root 是 $DSH_HOME/browser-service）。
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

  console.log('契约字段');
  check('id 与配置一致', provider.id === 'cdp-daemon', provider.id);
  check('available() 为真', (await provider.available()) === true);

  const wrongToken = createProvider({
    chromium,
    config: {
      providerId: 'cdp-daemon',
      cdpUrl: `http://127.0.0.1:${PORT}`,
      connectTimeoutMs: 3000,
      cdpToken: 'wrong-token',
      actionTimeoutMs: 5000,
      navigationTimeoutMs: 5000,
      lookupTimeoutMs: 3000,
      snapshotMaxElements: 50,
      contentMaxChars: 1000,
      viewportWidth: 800,
      viewportHeight: 600,
    },
  });
  await expectCode('错误 token 无法 attach（凭据门生效）', 'BROWSER_CDP_ATTACH_FAILED', () => wrongToken.open('bad'));
  await wrongToken.dispose();

  console.log('\n会话与导航');
  const session = await provider.open('verify');
  check('open() 返回字符串 session id', typeof session === 'string' && session.length > 0, JSON.stringify(session));
  await provider.openUrl(session, { url: `${BASE}/` });
  let tabs = await provider.listTabs(session);
  check('openUrl 后有一个 tab 且 url 正确', tabs.length === 1 && tabs[0].url === `${BASE}/`, JSON.stringify(tabs));
  await expectCode('navigate 拒绝非 http(s)', 'BROWSER_NAVIGATION_BLOCKED', () => provider.navigate(session, { url: 'file:///etc/passwd' }));
  await expectCode('未知 session 报错', 'BROWSER_SESSION_UNKNOWN', () => provider.snapshot('s-does-not-exist'));
  await expectCode('未知 tab 报错', 'BROWSER_TAB_UNKNOWN', () => provider.switchTab(session, 't-does-not-exist'));

  console.log('\n求值');
  const title = await provider.execute(session, { script: 'document.title' });
  check('execute 返回 ok/value', title.ok === true && title.value === 'CDP 测试页', JSON.stringify(title));
  const sum = await provider.execute(session, { script: 'arguments[0] + arguments[1]', args: [1, 2] });
  check('execute 支持 args（arguments[0..n]）', sum.ok === true && sum.value === 3, JSON.stringify(sum));
  const boom = await provider.execute(session, { script: 'throw new Error("boom")' });
  check('execute 页面异常 → ok:false/exception', boom.ok === false && String(boom.exception).includes('boom'), JSON.stringify(boom));
  const hang = await provider.execute(session, { script: 'while (true) {}', timeoutMs: 700 });
  check('execute 超时被中断（不抛错）', hang.ok === false, JSON.stringify(hang).slice(0, 160));
  check('页面线程被占死时自动重建标签页', String(hang.exception).includes('重建标签页'), String(hang.exception));
  const afterHang = await provider.execute(session, { script: '1 + 1' });
  check('卡死恢复后同一会话仍可用', afterHang.ok === true && afterHang.value === 2, JSON.stringify(afterHang));
  // 恢复后的标签页回到原 url；再显式导航一次，保证后续用例面对干净文档。
  await provider.navigate(session, { url: `${BASE}/` });

  console.log('\n快照 / 可及性 / 内容');
  const snapshot = await provider.snapshot(session);
  const kinds = new Set(snapshot.elements.map((el) => el.kind));
  check('snapshot 返回 url/title/elements', snapshot.url === `${BASE}/` && snapshot.title === 'CDP 测试页' && Array.isArray(snapshot.elements));
  check('snapshot 覆盖 button/link/input/select', ['button', 'link', 'input', 'select'].every((k) => kinds.has(k)), [...kinds].join(','));
  check('snapshot 元素带 ref/selector/坐标', snapshot.elements.every((el) => el.ref && el.selector && Number.isFinite(el.x) && Number.isFinite(el.y)));
  const a11y = await provider.a11y(session, { maxNodes: 80 });
  check('a11y 返回节点与 role', a11y.count > 0 && a11y.nodes.every((n) => n.role && typeof n.depth === 'number'), `count=${a11y.count}`);
  check('a11y 含按钮名', a11y.nodes.some((n) => n.role === 'button' && String(n.name).includes('点击我')));
  const txt = await provider.content(session, { format: 'txt' });
  check('content txt 命中页面文本', txt.content.includes('点击我') && txt.truncated === false);
  const json = await provider.content(session, { format: 'json' });
  const parsedJson = JSON.parse(json.content);
  check('content json 可解析且带 title/links', parsedJson.title === 'CDP 测试页' && parsedJson.links.some((l) => String(l.href ?? l).includes('/next')));
  const md = await provider.content(session, { format: 'markdown' });
  check('content markdown 含标题与链接', md.content.startsWith('# ') && md.content.includes(']('), md.content.split('\n')[0]);
  const html = await provider.content(session, { format: 'html', selector: '#head' });
  check('content html 支持 selector', html.content.includes('id="head"'), html.content.slice(0, 40));
  const capped = await provider.content(session, { format: 'txt', maxChars: 20 });
  check('content maxChars 触发 truncated', capped.truncated === true && capped.content.length <= 20, `len=${capped.content.length}`);
  const emoji = await provider.content(session, { format: 'txt', selector: '#emoji', maxChars: 3 });
  check('maxChars 不从代理对中间切开（F13）', emoji.truncated === true && emoji.content === '😀' && !/[\uD800-\uDBFF]$/.test(emoji.content), JSON.stringify(emoji.content));

  console.log('\n等待');
  const waited = await provider.waitFor(session, { selector: '#link', loaded: true });
  check('waitFor 选择器就绪', waited.ready === true, JSON.stringify(waited));
  const missed = await provider.waitFor(session, { selector: '#nope', timeoutMs: 700 });
  check('waitFor 超时返回 ready:false', missed.ready === false, JSON.stringify(missed));
  const urlWait = await provider.waitFor(session, { url: `${BASE}/`, timeoutMs: 2000 });
  check('waitFor url 命中', urlWait.ready === true, JSON.stringify(urlWait));

  console.log('\n元素操作');
  await provider.click(session, { target: { by: 'text', value: '点击我' } });
  const clicked = await provider.execute(session, { script: "document.getElementById('head').textContent" });
  check('click by text 触发页面行为', clicked.value === '已点击', JSON.stringify(clicked.value));
  await provider.type(session, { target: { by: 'css', value: '#q' }, text: '输入中' });
  const typed = await provider.getValue(session, { target: { by: 'css', value: '#q' } });
  check('type 写入输入框', typed.value === '输入中', JSON.stringify(typed));
  const set = await provider.setValue(session, { target: { by: 'css', value: '#q' }, value: '覆盖' });
  check('setValue 返回 method=input 与 value', set.method === 'input' && set.value === '覆盖', JSON.stringify(set));
  const setContentEditable = await provider.setValue(session, { target: { by: 'css', value: '#editable' }, value: '改写' });
  check('setValue 支持 contenteditable', setContentEditable.method === 'contenteditable' && setContentEditable.value === '改写', JSON.stringify(setContentEditable));
  const checked = await provider.check(session, { target: { by: 'css', value: '#agree' }, checked: true });
  check('check 勾选复选框', checked.checked === true, JSON.stringify(checked));
  const readChecked = await provider.getValue(session, { target: { by: 'css', value: '#agree' } });
  check('getValue 读回 checked', readChecked.checked === true);
  const cleared = await provider.clearField(session, { target: { by: 'css', value: '#agree' } });
  check('clearField 取消勾选', cleared.cleared === true, JSON.stringify(cleared));
  const selected = await provider.selectOption(session, { target: { by: 'css', value: '#pick' }, optionText: '乙' });
  check('selectOption by text', selected.value === 'b' && selected.text === '乙', JSON.stringify(selected));
  const a11yState = await provider.a11y(session, { maxNodes: 80 });
  const boxStates = () => (a11yState.nodes.find((n) => n.role === 'checkbox')?.states ?? []);
  check('a11y 反映未勾选（unchecked，看 IDL 属性而非 checked 特性）', boxStates().includes('unchecked'), JSON.stringify(boxStates()));
  await provider.check(session, { target: { by: 'css', value: '#agree' }, checked: true });
  const a11yChecked = await provider.a11y(session, { maxNodes: 80 });
  const boxStates2 = a11yChecked.nodes.find((n) => n.role === 'checkbox')?.states ?? [];
  check('a11y 反映 JS 勾选（checked）', boxStates2.includes('checked'), JSON.stringify(boxStates2));
  await provider.scroll(session, { deltaY: 1500 });
  const scrolled = await provider.execute(session, { script: 'window.scrollY' });
  check('scroll 生效', Number(scrolled.value) > 0, JSON.stringify(scrolled.value));
  await provider.scroll(session, { toTop: true });
  const backTop = await provider.execute(session, { script: 'window.scrollY' });
  check('scroll toTop 生效', Number(backTop.value) === 0, JSON.stringify(backTop.value));
  await provider.click(session, { x: 5, y: 5 });
  check('click 支持坐标', true);
  const keyed = await provider.key(session, { key: 'Tab' });
  check('key 支持 Tab', keyed === undefined);
  await expectCode('key 不支持时报错', 'BROWSER_KEY_UNSUPPORTED', () => provider.key(session, { key: 'Frobnicate' }));

  console.log('\n抓取 / 表单');
  const scraped = await provider.scrape(session, { item: 'div.card', fields: [{ name: 'title', selector: '.t' }, { name: 'href', selector: 'a@href' }] });
  check('scrape 计数与字段', scraped.count === 2 && scraped.items[0].title === '一' && scraped.items[1].title === '二', JSON.stringify(scraped.items));
  check('scrape @attr href 已绝对化', scraped.items[0].href === `${BASE}/next`, String(scraped.items[0].href));
  const filled = await provider.fillForm(session, { fields: [{ name: 'q2', value: '表单值' }, { name: 'ok', value: true }], submit: false });
  check('fillForm 逐字段结果', filled.fields.length === 2 && filled.fields.every((f) => f.ok === true), JSON.stringify(filled.fields));
  check('fillForm submitted=false 时不提交', filled.submitted === false);

  console.log('\n截图 / 下载');
  const shot = await provider.screenshot(session, { format: 'png' });
  check('screenshot 返回 dataUrl', String(shot.dataUrl).startsWith('data:image/png;base64,'), String(shot.dataUrl).slice(0, 30));
  const savePath = join(root, 'shot.png');
  await provider.screenshot(session, { savePath });
  check('screenshot savePath 落盘', existsSync(savePath) && statSync(savePath).size > 1000, `${existsSync(savePath) ? statSync(savePath).size : 0}B`);
  const scaled = await provider.screenshot(session, { format: 'png', maxWidth: 720, maxHeight: 450 });
  const raw = Buffer.from(String(scaled.dataUrl).split(',')[1], 'base64');
  check('screenshot maxWidth/maxHeight 等比缩小', raw.readUInt32BE(16) <= 720 && raw.readUInt32BE(20) <= 450, `${raw.readUInt32BE(16)}x${raw.readUInt32BE(20)}`);
  const full = await provider.screenshot(session, { format: 'jpeg', fullPage: true, quality: 60 });
  check('screenshot fullPage/jpeg 可用', String(full.dataUrl).startsWith('data:image/jpeg;base64,'));
  const downloaded = await provider.download(session, { url: `${BASE}/next`, savePath: join(root, 'page.html') });
  check('download 落盘', existsSync(downloaded.path) && statSync(downloaded.path).size > 100, downloaded.path);

  console.log('\n保存路径准入');
  await expectCode('截图相对路径被拒', 'BROWSER_SCREENSHOT_BLOCKED', () => provider.screenshot(session, { savePath: 'shot.png' }));
  await expectCode('截图越出 downloadDir 被拒', 'BROWSER_SCREENSHOT_BLOCKED', () => provider.screenshot(session, { savePath: '/tmp/outside-dsh.png' }));
  await expectCode('截图拒绝覆盖已有文件', 'BROWSER_SCREENSHOT_BLOCKED', () => provider.screenshot(session, { savePath }));
  await expectCode('下载相对路径被拒', 'BROWSER_DOWNLOAD_BLOCKED', () => provider.download(session, { url: `${BASE}/next`, savePath: 'page.html' }));
  await expectCode('下载越出 downloadDir 被拒', 'BROWSER_DOWNLOAD_BLOCKED', () => provider.download(session, { url: `${BASE}/next`, savePath: '/tmp/outside-dsh.html' }));
  await provider.screenshot(session, { savePath: join(root, 'shot2.png') });
  check('downloadDir 内的新路径可写入', existsSync(join(root, 'shot2.png')) && statSync(join(root, 'shot2.png')).size > 1000, 'shot2.png');

  console.log('\n标签页 / 历史');
  await provider.openUrl(session, { url: `${BASE}/next`, newTab: true });
  tabs = await provider.listTabs(session);
  check('newTab 打开第二个 tab 且成为活动页', tabs.length === 2 && tabs[1].active === true, JSON.stringify(tabs.map((t) => [t.id, t.active])));
  await provider.switchTab(session, tabs[0].id);
  tabs = await provider.listTabs(session);
  check('switchTab 切换活动页', tabs[0].active === true && tabs[1].active === false);
  await provider.closeTab(session, tabs[1].id);
  tabs = await provider.listTabs(session);
  check('closeTab 关闭标签', tabs.length === 1, JSON.stringify(tabs.map((t) => t.id)));
  await provider.navigate(session, { url: `${BASE}/next` });
  await provider.back(session);
  const afterBack = await provider.execute(session, { script: 'location.pathname' });
  check('back 回到上一页', afterBack.value === '/', JSON.stringify(afterBack.value));
  await provider.forward(session);
  const afterForward = await provider.execute(session, { script: 'location.pathname' });
  check('forward 前进', afterForward.value === '/next', JSON.stringify(afterForward.value));
  await provider.reload(session);
  const reloaded = await provider.execute(session, { script: 'location.pathname' });
  check('reload 保持当前页', reloaded.value === '/next', JSON.stringify(reloaded.value));
  const history = await provider.history(session);
  check('history 记录 seq/action/at', history.length > 0 && history.every((h) => typeof h.seq === 'number' && h.action && typeof h.at === 'number'), `entries=${history.length}`);
  const navigateEntry = history.filter((h) => h.action === 'navigate').at(-1);
  await provider.navigate(session, { url: `${BASE}/` });
  await provider.replay(session, navigateEntry.seq);
  const replayed = await provider.execute(session, { script: 'location.pathname' });
  check('replay 重放 navigate', replayed.value === '/next', JSON.stringify(replayed.value));
  await provider.navigate(session, { url: `${BASE}/captcha` });
  const challenge = await provider.detectChallenge(session);
  check('detectChallenge 识别 hcaptcha', challenge.blocked === true && challenge.kind === 'hcaptcha', JSON.stringify(challenge));
  await provider.navigate(session, { url: `${BASE}/` });
  const noChallenge = await provider.detectChallenge(session);
  check('detectChallenge 正常页为未拦截', noChallenge.blocked === false, JSON.stringify(noChallenge));

  console.log('\n并发 attach');
  const racers = await Promise.all(Array.from({ length: 4 }, (_, i) => provider.open(`race${i}`)));
  check('4 个并发 open 各自拿到会话', new Set(racers).size === 4, JSON.stringify(racers));
  const raceOk = await Promise.all(racers.map((id) => provider.execute(id, { script: '1 + 1' })));
  check('并发 attach 后每个会话都可用（旧连接不会顶掉新连接）', raceOk.every((r) => r.ok === true && r.value === 2), JSON.stringify(raceOk.map((r) => r.value)));
  for (const id of racers) await provider.close(id);

  console.log('\n隔离 / 认证 / 生命周期');
  await provider.execute(session, { script: "document.cookie = 'iso=ctxA; path=/'" });
  const cookies = await provider.flushAuth(session);
  const isoCookie = cookies.find((c) => c.name === 'iso');
  check('flushAuth 导出 cookie（含 url 字段）', Boolean(isoCookie?.url?.startsWith('http://127.0.0.1')), JSON.stringify(cookies));
  const other = await provider.open('other');
  await provider.openUrl(other, { url: `${BASE}/` });
  const otherCookie = await provider.execute(other, { script: 'document.cookie' });
  check('新 session 隔离：看不到 A 的 cookie', !String(otherCookie.value).includes('iso=ctxA'), JSON.stringify(otherCookie.value));
  const restored = await provider.restoreAuth(other, isoCookie ? [isoCookie] : []);
  const restoredCookie = await provider.execute(other, { script: 'document.cookie' });
  check('restoreAuth 注入成功', restored >= 1 && String(restoredCookie.value).includes('iso=ctxA'), `count=${restored} cookie=${restoredCookie.value}`);
  await provider.reset(session);
  tabs = await provider.listTabs(session);
  const resetHistory = await provider.history(session);
  check('reset 清空标签与历史', tabs.length === 1 && resetHistory.length === 0, `tabs=${tabs.length} history=${resetHistory.length}`);
  await provider.close(other);
  await expectCode('close 后 session 失效', 'BROWSER_SESSION_UNKNOWN', () => provider.snapshot(other));
  await provider.close(other);
  check('close 幂等', true);
  await provider.close(session);
  await expectCode('关闭主 session 后失效', 'BROWSER_SESSION_UNKNOWN', () => provider.snapshot(session));

  // ── F22：CDP 连接被换掉（守护进程重启 / F20 拆线 / 内核崩溃）之后，工具层按 task 永久缓存
  // 的 session id 必须仍可用：provider 要在新连接上按原 id 重建会话，而不是让之后每一次
  // browser_* 调用都报「会话内没有可用标签页」直到重启 DSH。顺带覆盖重启后换 token（F19）。
  console.log('\nF22 连接重建后会话复活');
  const revive = await provider.open('f22');
  await provider.openUrl(revive, { url: `${BASE}/` });
  const beforeRestart = await provider.execute(revive, { script: '1 + 1' });
  check('重启前会话可用', beforeRestart.ok === true && beforeRestart.value === 2, JSON.stringify(beforeRestart));
  const tokenOf = () => {
    try {
      return JSON.parse(readFileSync(join(root, 'service.json'), 'utf8')).token;
    } catch {
      return null;
    }
  };
  const tokenBefore = tokenOf();
  // 用异步 spawn 而不是 spawnSync：阻塞事件循环会让客户端没机会观察到掉线，
  // 那是测试自己造出来的假象（真实场景里 DSH 进程一直在跑事件循环）。
  const restarted = await new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, 'restart', `--root=${root}`, `--port=${PORT}`, '--idle-ms=120000'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => {
      stdout += d;
    });
    p.stderr.on('data', (d) => {
      stderr += d;
    });
    p.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  let restartedJson = {};
  try {
    restartedJson = JSON.parse(restarted.stdout ?? '');
  } catch {
    restartedJson = {};
  }
  const tokenAfter = tokenOf();
  check('守护进程 restart 真的重启了实例（F23）', restarted.code === 0 && restartedJson.restarted === true && restartedJson.stopped === true, String(restarted.stdout).trim().slice(0, 160) || String(restarted.stderr).trim().slice(0, 160));
  check('重启后 token 已换新', typeof tokenAfter === 'string' && tokenAfter.length > 0 && tokenAfter !== tokenBefore, `${String(tokenBefore).slice(0, 8)} → ${String(tokenAfter).slice(0, 8)}`);
  let reviveError = null;
  const afterRestart = await provider.execute(revive, { script: '1 + 1' }).catch((error) => {
    reviveError = error;
    return null;
  });
  check('重启后同一个 session id 仍可用（F22）', afterRestart?.ok === true && afterRestart.value === 2, reviveError ? `${reviveError.code ?? ''} ${reviveError.message}` : JSON.stringify(afterRestart));
  await provider.openUrl(revive, { url: `${BASE}/` }).catch((error) => {
    reviveError = error;
  });
  const revived = await provider.execute(revive, { script: 'location.pathname' }).catch((error) => {
    reviveError = error;
    return null;
  });
  check('复活后的会话可以继续导航', revived?.value === '/', reviveError ? `${reviveError.code ?? ''} ${reviveError.message}` : JSON.stringify(revived));
  await provider.close(revive);
} catch (error) {
  check(`未捕获异常：${error?.message}`, false, error?.stack?.split('\n').slice(0, 3).join(' | '));
} finally {
  await shutdown();
}

// ── F19：自启之后的重试必须重新读状态文件里的 token ──────────────────────────
// 冷启动时序：第一次 connect 时守护进程还没起（状态文件里没有 token）→ 失败 → autoStart 拉起
// 守护进程并写入新 token → 重试必须带**新**token，否则必然 401，浏览器冷启动后第一次不可用。
{
  console.log('\nF19 自启重试重新读 token');
  const f19Root = mkdtempSync(join(tmpdir(), 'svc-f19-'));
  const prevRoot = process.env.DSH_BROWSER_SVC_ROOT;
  process.env.DSH_BROWSER_SVC_ROOT = f19Root;
  const attempts = [];
  const fakeChromium = {
    async connectOverCDP(_url, options) {
      attempts.push(options?.headers?.authorization ?? null);
      if (attempts.length === 1) throw new Error('connect ECONNREFUSED 127.0.0.1:9419');
      return { isConnected: () => true, on() {}, contexts: () => [] };
    },
  };
  const f19 = createProvider({
    chromium: fakeChromium,
    config: { cdpUrl: 'http://127.0.0.1:9419', connectTimeoutMs: 200, autoStartCommand: 'true', autoStartTimeoutMs: 200 },
    autoStart: async () => {
      writeFileSync(join(f19Root, 'service.json'), JSON.stringify({ token: 'late-token' }));
    },
  });
  try {
    await f19.open('f19');
  } catch {
    /* 假连接之后的流程（contexts 为空）失败与本断言无关 */
  }
  check('自启后重试带上了新 token（第一次尝试无 token）', attempts[0] === null && attempts[1] === 'Bearer late-token', JSON.stringify(attempts));
  if (prevRoot === undefined) delete process.env.DSH_BROWSER_SVC_ROOT;
  else process.env.DSH_BROWSER_SVC_ROOT = prevRoot;
  rmSync(f19Root, { recursive: true, force: true });
}

console.log(`\n结果：${passed} 通过，${failures.length} 失败${failures.length ? ` →\n  - ${failures.join('\n  - ')}` : ''}`);
process.exit(failures.length === 0 ? 0 : 1);
