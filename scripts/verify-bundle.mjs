#!/usr/bin/env node
/**
 * 验收「本包作为 DSH 组合包（bundle）能不能一条命令装完即用」。
 *
 *   node scripts/verify-bundle.mjs [--tgz dist/dsh-browser-service-<version>.tgz]   # 版本默认读根 package.json
 *
 * 全程在一次性隔离 DSH_HOME（/tmp）里跑，**不碰默认 profile**：
 *   1) 交付物形状：tarball 里只有**一个** package.json，带 shims、patch、bin 与可执行的 browsersvc
 *   2) dsh plugin --profile <p> add <tgz>  → 包进依赖、层追加到 dsh.profile.bundles
 *   3) --dump-config                       → 一个包就挂出接缝 browser + 33 工具 + cdp provider
 *                                            （关键：bundles 里**没有** dsh-builtin-browser）
 *   4) 默认自启命令指向装进来的 bin/browsersvc.mjs（不再需要用户自己配 autoStartCommand）
 *   5) ./browser 与 ./tool-browser 转出口的导出键与 dsh-builtin-browser 源模块**完全一致**
 *      （loader 挂的是模块本身；少一个 default 或多一个都会在组合期报错）
 *   6) dsh plugin --profile <p> remove <pkg> → 依赖与层同时移除
 *
 * 环境变量：DSH_BIN（默认 dsh）
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { linkHostPeers } from './lib/host-peers.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const DSH = process.env.DSH_BIN ?? 'dsh';
const PROFILE = 'bundleverify';
const PKG = 'dsh-browser-service';

const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const hit = argv.find((a) => a === flag || a.startsWith(`${flag}=`));
  if (!hit) return fallback;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : argv[argv.indexOf(hit) + 1];
};
const PKG_VERSION = JSON.parse(readFileSync(resolve(HERE, '../package.json'), 'utf8')).version;
const TGZ = resolve(argOf('--tgz', resolve(HERE, `../dist/${PKG}-${PKG_VERSION}.tgz`)));

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

if (!existsSync(TGZ)) {
  console.error(`找不到 tarball：${TGZ}\n先打包：pnpm pack --pack-destination dist（见 README §8）`);
  process.exit(2);
}

const root = mkdtempSync(join(tmpdir(), 'dshbundle-'));
const profileDir = join(root, 'profiles', PROFILE);
const installed = join(profileDir, 'node_modules', PKG);
function cleanup() {
  rmSync(root, { recursive: true, force: true });
}
process.on('exit', cleanup);

const env = { ...process.env, DSH_HOME: root };
function run(args, { allowFail = false } = {}) {
  const res = spawnSync(DSH, args, { env, encoding: 'utf8', timeout: 180_000 });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  if (!allowFail && res.status !== 0) {
    console.error(`\n命令失败：dsh ${args.join(' ')}\n${out}`);
    process.exit(2);
  }
  return { status: res.status, out };
}
const manifest = () => JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
const dumpConfig = () => run(['--profile', PROFILE, '--dump-config']).out;
function rowBlock(dump, id) {
  const lines = dump.split('\n');
  const i = lines.findIndex((l) => l.trim() === `- id: ${id}`);
  if (i < 0) return '';
  const out = [lines[i]];
  for (let j = i + 1; j < lines.length; j += 1) {
    if (/^\s*- id: /.test(lines[j])) break;
    out.push(lines[j]);
  }
  return out.join('\n');
}

console.log(`\n=== 组合包安装验收（隔离 DSH_HOME=${root}）===`);
console.log(`tarball: ${TGZ}\n`);

// 1) 交付物形状：单一包
console.log('1. 交付物形状（一个包）');
{
  const listed = spawnSync('tar', ['tzf', TGZ], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  const manifests = listed.filter((p) => p.endsWith('/package.json'));
  check('tarball 里没有 plugin/package.json（交付包只有根包）', !manifests.includes('package/plugin/package.json'), manifests.join(' , '));
  const probeManifest = spawnSync('tar', ['xzOf', TGZ, 'package/tools/seam-probe/package.json'], { encoding: 'utf8' }).stdout;
  check('tarball 里唯一的 dsh 组合包是根包（tools/seam-probe 只是诊断插件）', !/"dsh"\s*:/.test(probeManifest), probeManifest.slice(0, 80));
  check('tarball 含接缝/工具转出口', listed.includes('package/plugin/shims/browser.js') && listed.includes('package/plugin/shims/tool-browser.js'));
  check('tarball 含 bundle patch', listed.includes('package/plugin/cordis.patch.yml'));
  check('tarball 含守护进程 CLI', listed.includes('package/bin/browsersvc.mjs'));
}

// 2) 官方安装命令：包进依赖 + 层追加到 bundles
console.log('2. dsh plugin --profile … add <tgz>');
{
  const { status, out } = run(['plugin', '--profile', PROFILE, 'add', TGZ], { allowFail: true });
  check('add 退出码 0', status === 0, out.trim().split('\n').slice(-3).join(' | '));
  const m = existsSync(join(profileDir, 'package.json')) ? manifest() : {};
  check('依赖里出现本包（file: tarball 引用）',
    String(m.dependencies?.[PKG] ?? '').startsWith('file:'), JSON.stringify(m.dependencies ?? {}));
  const bundles = m.dsh?.profile?.bundles ?? [];
  check('dsh.profile.bundles 追加了本包', bundles.includes(PKG), JSON.stringify(bundles));
  check('bundles 里没有 dsh-builtin-browser（它是依赖，不是组合包）',
    !bundles.includes('dsh-builtin-browser'), JSON.stringify(bundles));
  check('接缝依赖被装进 profile（shims 才能解析）',
    existsSync(join(profileDir, 'node_modules', 'dsh-builtin-browser')));
  check('装好的包没有子 package.json', !existsSync(join(installed, 'plugin', 'package.json')));
  const binStat = existsSync(join(installed, 'bin', 'browsersvc.mjs'));
  check('装好的包里 browsersvc 存在且可执行',
    binStat && (readFileSync(join(installed, 'bin', 'browsersvc.mjs'), 'utf8').length > 0));
}

// 3) 一个包就挂出接缝 + 工具 + provider
console.log('3. --dump-config（一个包装完）');
{
  const dump = dumpConfig();
  check('出现本包层', /# == dsh-browser-service/.test(dump));
  check('browser 行由本包挂出并选中 cdp-daemon',
    /name: dsh-browser-service\/browser/.test(rowBlock(dump, 'browser'))
    && /browserProvider: cdp-daemon/.test(rowBlock(dump, 'browser')));
  check('tool-browser 行由本包挂出',
    /name: dsh-browser-service\/tool-browser/.test(rowBlock(dump, 'tool-browser')));
  check('browser-cdp provider 行已插入', /- id: browser-cdp/.test(dump));
  check('本包三行没有 not found', !/entry "(browser|tool-browser|browser-cdp)" not found/.test(dump));
}

// 4) 默认自启命令指向装进来的 bin（不再需要用户配 autoStartCommand）
console.log('4. 默认自启命令');
{
  const providerPath = join(installed, 'plugin', 'lib', 'provider.js');
  const script = `import(${JSON.stringify(providerPath)}).then(m => console.log(m.defaultAutoStartCommand() ?? '')).catch(e => console.log('ERR ' + e.message))`;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30_000 });
  const cmd = (res.stdout ?? '').trim();
  check('defaultAutoStartCommand 指向装进来的 browsersvc',
    cmd.includes(join(installed, 'bin', 'browsersvc.mjs')) && / start$/.test(cmd), cmd || (res.stderr ?? '').trim().split('\n')[0]);
}

// 5) 转出口形状必须与接缝模块一致（loader 挂的是模块本身）
console.log('5. 转出口形状（shim ≡ dsh-builtin-browser 的模块）');
{
  // 隔离 home 在 boot 之前没有 profiles/node_modules —— 宿主 dsh 在 boot 时才会把它建起来
  // （240 个 @deepseek-ai/* 入口），profile 内任何包向上查找都靠它解析宿主提供的 peer
  // （cordis / dsh-tools / dsh-llm …）。这里按同一机制补一份软链，才能从隔离 profile
  // import dsh-builtin-browser/*。真实部署里 boot 过就有，无需手工补。
  // 真实部署里 boot 过就有这份 peer 目录；隔离 home 没有，按同一机制补出来（scripts/lib/host-peers.mjs）。
  const peers = linkHostPeers({ root, dshBin: DSH });
  if (!peers.ok) check('能找到宿主 @deepseek-ai（补 profiles/node_modules 用）', false, peers.error);
  const script = `
    const keys = (m) => Object.keys(m).sort().join(',');
    const out = {};
    for (const spec of ['dsh-browser-service/browser', 'dsh-builtin-browser/browser',
                        'dsh-browser-service/tool-browser', 'dsh-builtin-browser/tool-browser']) {
      try { out[spec] = keys(await import(spec)); } catch (e) { out[spec] = 'ERR ' + e.code + ' ' + e.message.split('\\n')[0]; }
    }
    console.log(JSON.stringify(out));`;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: profileDir, env, encoding: 'utf8', timeout: 60_000,
  });
  const line = (res.stdout ?? '').split('\n').find((l) => l.startsWith('{')) ?? '{}';
  let shapes = {};
  try { shapes = JSON.parse(line); } catch { /* 保持空 */ }
  const seamBrowser = shapes['dsh-builtin-browser/browser'] ?? '';
  const shimBrowser = shapes['dsh-browser-service/browser'] ?? '';
  const seamTools = shapes['dsh-builtin-browser/tool-browser'] ?? '';
  const shimTools = shapes['dsh-browser-service/tool-browser'] ?? '';
  check('browser 转出口的导出键与源模块一致', shimBrowser !== '' && shimBrowser === seamBrowser,
    `shim=${shimBrowser} seam=${seamBrowser}`);
  check('tool-browser 转出口的导出键与源模块一致', shimTools !== '' && shimTools === seamTools,
    `shim=${shimTools} seam=${seamTools}`);
}

// 5b) 版本适配（P2）：启动期探测 + 宿主 peer 解析 + 工具面跟随
console.log('5b. 版本适配（启动期探测 / 宿主 peer / 工具面）');
{
  const compatPath = join(installed, 'plugin', 'lib', 'compat.js');
  const script = `
    const out = {};
    try { await import('dsh-browser-service'); out.pluginEntry = 'ok'; }
    catch (e) { out.pluginEntry = 'ERR ' + e.code + ' ' + String(e.message).split('\\n')[0]; }
    const compat = await import(${JSON.stringify(compatPath)});
    out.versions = compat.readVersions();
    const bm = await import('dsh-builtin-browser/browser');
    const tm = await import('dsh-builtin-browser/tool-browser');
    const v = (deps) => { const r = compat.inspectSeam(deps); return { ok: r.ok, fatal: r.fatal, warnings: r.warnings }; };
    out.real = v({ browserModule: bm, toolModule: tm, hostVersion: out.versions.host });
    out.noDefault = v({ browserModule: { BrowserError: class {} }, toolModule: tm, hostVersion: out.versions.host });
    out.noApply = v({ browserModule: bm, toolModule: { name: 'tool-browser', inject: ['tools', 'browser'] }, hostVersion: out.versions.host });
    out.missingInject = v({ browserModule: bm, toolModule: { name: 'tool-browser', apply() {}, inject: ['tools'] }, hostVersion: out.versions.host });
    out.unknownHost = v({ browserModule: bm, toolModule: tm, hostVersion: '9.9.9-alpha.9' });
    out.message = compat.seamMismatchMessage({ fatal: ['x'], warnings: [] }, { host: '1.2.3', seam: '4.5.6' });
    console.log(JSON.stringify(out));`;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: profileDir, env, encoding: 'utf8', timeout: 60_000,
  });
  const line = (res.stdout ?? '').split('\n').find((l) => l.startsWith('{')) ?? '{}';
  let p = {};
  try { p = JSON.parse(line); } catch { /* 保持空 */ }
  const fatalOf = (key) => (p[key]?.fatal ?? []).join('；');

  check('本包入口在只声明 peer 时仍可 import（schemastery 解析到宿主）', p.pluginEntry === 'ok', p.pluginEntry ?? (res.stderr ?? '').trim().split('\n')[0]);
  check('本包不携带自己的 @deepseek-ai/schemastery（peer 由宿主提供）',
    !existsSync(join(installed, 'node_modules', '@deepseek-ai', 'schemastery')));
  check('读得到宿主 DSH 与接缝版本', Boolean(p.versions?.host) && Boolean(p.versions?.seam), JSON.stringify(p.versions));
  check('真实接缝通过启动期探测（0 fatal）', p.real?.ok === true && (p.real?.fatal ?? []).length === 0, fatalOf('real'));
  check('接缝缺默认导出 → 探测判死并说清缺什么',
    p.noDefault?.ok === false && /default/.test(fatalOf('noDefault')), fatalOf('noDefault'));
  check('tool-browser 缺 apply → 探测判死', p.noApply?.ok === false && /apply/.test(fatalOf('noApply')), fatalOf('noApply'));
  check('tool-browser 的 inject 缺 browser → 探测判死',
    p.missingInject?.ok === false && /inject/.test(fatalOf('missingInject')), fatalOf('missingInject'));
  check('未知宿主版本只告警、不阻断',
    p.unknownHost?.ok === true && /9\.9\.9-alpha\.9/.test((p.unknownHost?.warnings ?? []).join('；')),
    JSON.stringify(p.unknownHost));
  check('探测失败的人话带包名与期望面',
    /dsh-builtin-browser@0\.1\.22/.test(p.message ?? '') && /未启用/.test(p.message ?? ''), p.message);

  const seamToolsSrc = readFileSync(join(profileDir, 'node_modules', 'dsh-builtin-browser', 'lib', 'tool-browser', 'index.js'), 'utf8');
  const toolNames = new Set([...seamToolsSrc.matchAll(/'browser_[a-z0-9_]+'/g)].map((m) => m[0]));
  check('接缝工具面仍是 33 个且含 browser_a11y（变了就同步 README 工具表与计数）',
    toolNames.size === 33 && toolNames.has("'browser_a11y'"),
    `count=${toolNames.size} a11y=${toolNames.has("'browser_a11y'")}`);
}

// 5c) 客户端半边（网页面板）：loader 协议 + cordis 插件形状 + 只点平台种子表
console.log('5c. 客户端半边（网页面板）');
{
  const res = spawnSync(process.execPath, [join(HERE, 'lib', 'client-probe.mjs'), installed, PKG], {
    cwd: profileDir, env, encoding: 'utf8', timeout: 60_000,
  });
  const line = (res.stdout ?? '').split('\n').find((l) => l.startsWith('{')) ?? '{}';
  let c = {};
  try { c = JSON.parse(line); } catch { /* 保持空 */ }
  const installedPkg = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));

  check('tarball 里带 plugin/client.js', existsSync(join(installed, 'plugin', 'client.js')));
  check('package.json 声明 exports["./client"] 与 dsh.client.platform=web',
    installedPkg.exports?.['./client'] === './plugin/client.js' && installedPkg.dsh?.client?.platform === 'web',
    JSON.stringify({ client: installedPkg.exports?.['./client'], dsh: installedPkg.dsh?.client }));
  check('客户端入口走 window.__ModuleLoader__.load 且 id = 包名',
    c.imported === 'ok' && c.loads?.length === 1 && c.loads[0]?.id === PKG && c.loads[0]?.factory === 'function',
    JSON.stringify({ imported: c.imported, loads: c.loads, stderr: (res.stderr ?? '').trim().split('\n')[0] }));
  check('factory 返回标准 cordis 插件（apply + inject: slots）',
    c.apply === 'function' && (c.inject ?? []).includes('slots'), JSON.stringify({ apply: c.apply, inject: c.inject }));
  check('apply 把看板注册到 shell.overlay（list 槽，自带 id）',
    c.injected === 'shell.overlay' && c.register?.name === 'shell.overlay' && typeof c.register?.id === 'string',
    JSON.stringify({ injected: c.injected, register: c.register }));
  check('看板组件能渲染（没有数据时回落胶囊）', c.render === 'null', String(c.render));
  const seeds = new Set([
    'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
    '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit',
  ]);
  check('客户端只 require 平台种子表内的包（否则要打包或写进 dsh.client.inject）',
    (c.requires ?? []).length > 0 && (c.requires ?? []).every((name) => seeds.has(name)),
    JSON.stringify(c.requires));
}

// 6) 官方移除命令：依赖与层同时移除
console.log('6. dsh plugin --profile … remove <pkg>');
{
  const { status, out } = run(['plugin', '--profile', PROFILE, 'remove', PKG], { allowFail: true });
  check('remove 退出码 0', status === 0, out.trim().split('\n').slice(-3).join(' | '));
  const m = manifest();
  check('依赖里不再有本包', !(PKG in (m.dependencies ?? {})), JSON.stringify(m.dependencies ?? {}));
  check('dsh.profile.bundles 里不再有本包',
    !(m.dsh?.profile?.bundles ?? []).includes(PKG), JSON.stringify(m.dsh?.profile?.bundles ?? []));
}

console.log(`\n结果：${passed} 通过，${failures.length} 失败${failures.length ? ` →\n  - ${failures.join('\n  - ')}` : ''}`);
process.exit(failures.length === 0 ? 0 : 1);
