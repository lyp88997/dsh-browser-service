#!/usr/bin/env node
/**
 * 验收「本包作为 DSH 组合包（bundle）能不能按官方文档装对」。
 *
 *   node scripts/verify-bundle.mjs [--tgz dist/dsh-browser-cdp-0.3.3.tgz]
 *
 * 全程在一次性隔离 DSH_HOME（/tmp）里跑，**不碰默认 profile**：
 *   1) dsh plugin --profile <p> add <tgz>      → 包进依赖、层追加到 dsh.profile.bundles 末尾
 *   2) --dump-config（还没装 seam 包）        → 证明顺序风险的现实性：patch 第 2/3 条被丢弃
 *   3) bundles = [base, seam, 本包]           → 三条 patch 行全部生效（browserProvider: cdp-daemon）
 *   4) bundles = [base, 本包, seam]（装反）   → 只警告 entry "browser" not found 并静默失效
 *   5) dsh plugin --profile <p> remove <pkg>  → 依赖与层同时移除
 *
 * 第 3/4 步的 seam 包（dsh-builtin-browser）默认用**符号链接**从已装好的 profile 里链过来：
 * 官方流程是 `add dsh-builtin-browser`，但它会把 electron（数十 MB）也拉下来，没必要——
 * 本脚本验的是「层顺序」这条组合规则，不是 seam 包自己的安装。要真走 registry 就用 --real-seam。
 *
 * 环境变量：DSH_BIN（默认 dsh）、DSH_BUILTIN_BROWSER_DIR（符号链接源，默认 $DSH_HOME/profiles/web/node_modules/dsh-builtin-browser）
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const DSH = process.env.DSH_BIN ?? 'dsh';
const PROFILE = 'bundleverify';

const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const hit = argv.find((a) => a === flag || a.startsWith(`${flag}=`));
  if (!hit) return fallback;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : argv[argv.indexOf(hit) + 1];
};
const TGZ = resolve(argOf('--tgz', resolve(HERE, '../dist/dsh-browser-cdp-0.3.3.tgz')));
const REAL_SEAM = argv.includes('--real-seam');
const SEAM_SRC = process.env.DSH_BUILTIN_BROWSER_DIR
  ?? join(homedir(), '.dsh', 'profiles', 'web', 'node_modules', 'dsh-builtin-browser');

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
const extraRoots = [];
function cleanup() {
  for (const dir of [root, ...extraRoots]) rmSync(dir, { recursive: true, force: true });
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

// 1) 官方安装命令：包进依赖 + 层追加到 bundles 末尾
console.log('1. dsh plugin --profile … add <tgz>');
{
  const { status, out } = run(['plugin', '--profile', PROFILE, 'add', TGZ], { allowFail: true });
  check('add 退出码 0', status === 0, out.trim().split('\n').slice(-3).join(' | '));
  check('add 输出确认装了本包', /dsh-browser-cdp/.test(out));
  const m = existsSync(join(profileDir, 'package.json')) ? manifest() : {};
  check('依赖里出现本包（file: tarball 引用）',
    String(m.dependencies?.['dsh-browser-cdp'] ?? '').startsWith('file:'),
    JSON.stringify(m.dependencies ?? {}));
  const bundles = m.dsh?.profile?.bundles ?? [];
  check('dsh.profile.bundles 追加了本包且排在末尾',
    bundles[bundles.length - 1] === 'dsh-browser-cdp', JSON.stringify(bundles));
}

// 2) 还没装 seam 包：patch 第 2/3 条无处可覆盖 ⇒ 必须出现 not found（顺序风险的现实性）
console.log('2. seam 包缺席时的组合（预期出现 not found）');
{
  const dump = dumpConfig();
  check('缺 seam 时报 entry "browser" not found',
    /patch: entry "browser" not found/.test(dump));
  check('缺 seam 时 seam 未被切到 cdp-daemon', !/browserProvider: cdp-daemon/.test(dump));
}

// 3) 正确顺序：seam 在前、本包在后 ⇒ 三条 patch 行全部生效
console.log('3. 正确顺序（seam → 本包）');
{
  if (REAL_SEAM) {
    run(['plugin', '--profile', PROFILE, 'add', 'dsh-builtin-browser']);
  } else {
    if (!existsSync(SEAM_SRC)) {
      console.error(`找不到 seam 包：${SEAM_SRC}\n（用 --real-seam 走 registry 安装，或设 DSH_BUILTIN_BROWSER_DIR）`);
      process.exit(2);
    }
    const nm = join(profileDir, 'node_modules');
    const link = join(nm, 'dsh-builtin-browser');
    if (!existsSync(link)) symlinkSync(SEAM_SRC, link, 'dir');
    const m = manifest();
    const bundles = m.dsh.profile.bundles.filter((b) => b !== 'dsh-builtin-browser');
    bundles.splice(bundles.length - 1, 0, 'dsh-builtin-browser'); // 插到本包之前
    m.dsh.profile.bundles = bundles;
    writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify(m, null, 2)}\n`);
  }
  const dump = dumpConfig();
  check('无 not found 警告', !/entry "browser" not found/.test(dump));
  check('dump 出现 "patched by dsh-browser-cdp"', /patched by dsh-browser-cdp/.test(dump));
  check('browser 行被切到 cdp-daemon', /browserProvider: cdp-daemon/.test(rowBlock(dump, 'browser')));
  check('browser-electron 行被 disabled', /disabled: true/.test(rowBlock(dump, 'browser-electron')));
  check('browser-cdp provider 行已插入', /- id: browser-cdp/.test(dump));
}

// 4) 顺序装反：不报错、只警告，覆盖行被静默丢弃
console.log('4. 装反顺序（本包 → seam）');
{
  const m = manifest();
  const base = m.dsh.profile.bundles.filter((b) => b !== 'dsh-builtin-browser' && b !== 'dsh-browser-cdp');
  m.dsh.profile.bundles = [...base, 'dsh-browser-cdp', 'dsh-builtin-browser']; // 本包排在 seam 之前
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify(m, null, 2)}\n`);
  const dump = dumpConfig();
  check('装反时给出 not found（不是报错退出）', /patch: entry "browser" not found/.test(dump));
  check('装反时 seam 没被切走（静默失效）', !/browserProvider: cdp-daemon/.test(dump));
}

// 5) 官方移除命令：依赖与层同时移除
console.log('5. dsh plugin --profile … remove <pkg>');
{
  const { status, out } = run(['plugin', '--profile', PROFILE, 'remove', 'dsh-browser-cdp'], { allowFail: true });
  check('remove 退出码 0', status === 0, out.trim().split('\n').slice(-3).join(' | '));
  const m = manifest();
  check('依赖里不再有本包', !('dsh-browser-cdp' in (m.dependencies ?? {})), JSON.stringify(m.dependencies ?? {}));
  check('dsh.profile.bundles 里不再有本包',
    !(m.dsh?.profile?.bundles ?? []).includes('dsh-browser-cdp'), JSON.stringify(m.dsh?.profile?.bundles ?? []));
}

console.log(`\n结果：${passed} 通过，${failures.length} 失败${failures.length ? ` →\n  - ${failures.join('\n  - ')}` : ''}`);
process.exit(failures.length === 0 ? 0 : 1);
