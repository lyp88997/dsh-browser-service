#!/usr/bin/env node
/**
 * 多版本矩阵的探测脚本（由 scripts/verify-matrix.mjs 在**隔离 profile 里**调用）。
 *
 * 为什么单独成文件：模块解析按文件位置走，不按 cwd —— 放进 profile 里每次都带一份会把 tarball
 * 弄脏，所以这里用**绝对路径** import 装进去的包，探测脚本自己不需要解析任何宿主包。
 *
 * 用法：node matrix-probe.mjs --pkg-dir <装好的包目录> [--smoke-root <目录> --port <端口>]
 * 输出：一行 `MATRIX_JSON {…}`
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const pkgDir = argOf('--pkg-dir');
const smokeRoot = argOf('--smoke-root');
const port = argOf('--port');
const smoke = Boolean(smokeRoot && port);
const at = (rel) => pathToFileURL(join(pkgDir, rel)).href;

const logs = { info: [], warn: [], error: [] };
const registered = [];
const disposers = [];
const ctx = {
  logger: {
    info: (m) => logs.info.push(String(m)),
    warn: (m) => logs.warn.push(String(m)),
    error: (m) => logs.error.push(String(m)),
  },
  browser: { registerBrowserProvider: (p) => { registered.push(p); return () => {}; } },
  effect: (fn) => { disposers.push(fn); return () => {}; },
};

const entry = await import(at('plugin/lib/index.js'));
const compat = await import(at('plugin/lib/compat.js'));
const versions = compat.readVersions();
const config = entry.Config(smoke
  ? {
    cdpUrl: `http://127.0.0.1:${port}`,
    autoStartCommand: `node ${join(pkgDir, 'bin', 'browsersvc.mjs')} start --root=${smokeRoot} --port=${port}`,
  }
  : {});
await entry.apply(ctx, config);

const out = {
  name: entry.name,
  inject: entry.inject,
  versions,
  registered: registered.map((p) => p.id),
  logs,
  config: { providerId: config.providerId, cdpUrl: config.cdpUrl, maxTabs: config.maxTabs, idleMs: config.idleMs },
};
// 先打印核心探测结果：后面的真实浏览若失败，也不该丢掉「加载 + 注册 + 探测」的证据。
console.log(`MATRIX_JSON ${JSON.stringify(out)}`);

if (smoke && registered.length === 1) {
  const provider = registered[0];
  const page = {};
  try {
    const id = await provider.open('matrix');
    await provider.openUrl(id, { url: 'https://example.com/' });
    const snapshot = await provider.snapshot(id);
    const text = await provider.content(id, { maxChars: 4000 });
    Object.assign(page, {
      id,
      url: snapshot?.url,
      title: snapshot?.title,
      hasHeading: /Example Domain/.test(String(text?.content ?? '')),
    });
  } catch (error) {
    Object.assign(page, { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
  }
  console.log(`MATRIX_PAGE ${JSON.stringify(page)}`);
}
await registered[0]?.dispose?.();
for (const fn of disposers) {
  try { fn(); } catch { /* 已经释放过 */ }
}
