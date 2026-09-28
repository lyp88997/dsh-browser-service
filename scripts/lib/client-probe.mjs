/**
 * 客户端半边探针（verify-bundle 用）：在隔离 profile 里真的执行 `plugin/client.js`，
 * 验证三件事——① 它发出的是宿主认的那段 loader 协议（`window.__ModuleLoader__.load`，id = 包名）；
 * ② factory 返回标准 cordis 插件（`apply` + `inject: ['slots']`）；③ `apply(fakeCtx)` 会把看板
 * 注册到 `shell.overlay`，且组件能被调用而不炸（没有会话数据时回落到胶囊）。
 *
 * 用法：node client-probe.mjs <installedDir> <pkgName>
 * 只读：不写任何文件，最后把结果以一行 JSON 打到 stdout。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [installed, pkgName] = process.argv.slice(2);
const out = {};
const loaded = [];

// 宿主在浏览器里先装好这个全局，再用它收每个插件包的入口声明——这里用桩替代宿主。
globalThis.window = { __ModuleLoader__: { load: (spec) => loaded.push(spec) } };

try {
  await import(pathToFileURL(join(installed, 'plugin', 'client.js')).href);
  out.imported = 'ok';
} catch (error) {
  out.imported = `ERR ${String(error?.message ?? error).split('\n')[0]}`;
}

out.loads = loaded.map((spec) => ({ id: spec?.id, factory: typeof spec?.factory }));

const spec = loaded[0];
if (spec) {
  // 种子表只给命名空间，不真需要 React 实现：这些桩够走完注册与一次渲染。
  const react = { useState: (value) => [value, () => {}], useEffect: () => {}, createElement: () => null };
  try {
    const plugin = spec.factory((name) => {
      if (name === 'react') return react;
      throw new Error(`unexpected require: ${name}`);
    });
    out.apply = typeof plugin?.apply;
    out.inject = Array.isArray(plugin?.inject) ? plugin.inject : null;
    const registrations = [];
    const ctx = {
      slots: {
        inject: (slot, callback) => {
          out.injected = slot;
          return callback();
        },
        register: (options, component) => {
          registrations.push({ options, type: typeof component, render: component });
          return () => {
            out.disposed = true;
          };
        },
      },
    };
    plugin.apply(ctx);
    out.register = registrations[0]?.options ?? null;
    out.component = registrations[0]?.type ?? null;
    try {
      const element = registrations[0]?.render?.();
      out.render = element === null ? 'null' : typeof element;
    } catch (error) {
      out.render = `ERR ${String(error?.message ?? error).split('\n')[0]}`;
    }
  } catch (error) {
    out.factory = `ERR ${String(error?.message ?? error).split('\n')[0]}`;
  }
}

// 裸 require 只能点平台种子表里的 9 个词，否则浏览器侧会抛 "missed the module table"。
// 只看代码、不看注释（注释里会举例提到别的包名）。
const source = readFileSync(join(installed, 'plugin', 'client.js'), 'utf8');
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
out.requires = [...new Set((code.match(/require\(['"]([^'"]+)['"]\)/g) ?? []).map((hit) => hit.replace(/^require\(['"]/, '').replace(/['"]\)$/, '')))];
out.pkgName = pkgName;

console.log(JSON.stringify(out));
