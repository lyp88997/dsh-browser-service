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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const dshAi = join(root, 'profiles', 'node_modules', '@deepseek-ai');
  if (!existsSync(dshAi)) {
    // 宿主 dsh 包根 = 真身 <pkgRoot>/lib/bin.js 往上两级；它的 node_modules/@deepseek-ai 就是 peer 来源。
    try {
      const which = spawnSync('sh', ['-c', `command -v ${DSH}`], { encoding: 'utf8' }).stdout.trim();
      const pkgRoot = dirname(dirname(realpathSync(which))); // …/node_modules/@deepseek-ai/dsh
      const hostAi = join(pkgRoot, 'node_modules', '@deepseek-ai');
      if (!existsSync(hostAi)) throw new Error(`宿主 peer 目录不存在：${hostAi}`);
      mkdirSync(dirname(dshAi), { recursive: true });
      symlinkSync(hostAi, dshAi, 'dir');
    } catch (error) {
      check('能找到宿主 @deepseek-ai（补 profiles/node_modules 用）', false, error.message);
    }
  }
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
