/**
 * dsh-browser-cdp —— 把 DSH 的 browser seam 接到自建 CDP 浏览器服务（browsersvc）。
 *
 * 只做一件事：注册一个 BrowserProvider。工具面（browser_* 工具）继续由
 * `dsh-builtin-browser/tool-browser` 提供，因此本插件与内置工具层是解耦的。
 */
import { exec } from 'node:child_process';
import Schema from '@deepseek-ai/schemastery';
import { createProvider } from './provider.js';

export const name = 'browser-cdp';

/** seam 服务：`ctx.browser` 由 dsh-builtin-browser/browser 提供。 */
export const inject = ['browser'];

export const Config = Schema.object({
  /** 注册到 seam 的 provider id（配置 browserProvider 时引用它）。 */
  providerId: Schema.string().default('cdp-daemon'),
  /** 守护进程的 CDP 端点（HTTP /json/version 那一侧）。 */
  cdpUrl: Schema.string().default('http://127.0.0.1:9333'),
  /** attach 到 CDP 端点的超时。 */
  connectTimeoutMs: Schema.number().default(10_000),
  /** 元素操作的默认预算（点击/填写/求值）。 */
  actionTimeoutMs: Schema.number().default(30_000),
  /** 导航/刷新预算。 */
  navigationTimeoutMs: Schema.number().default(30_000),
  /** 元素查找与 scrape 的等待预算。 */
  lookupTimeoutMs: Schema.number().default(5_000),
  /** 单次快照最多返回多少个可交互元素。 */
  snapshotMaxElements: Schema.number().default(200),
  /** 单次内容读取的最大字符数。 */
  contentMaxChars: Schema.number().default(200_000),
  /** 会话视口尺寸（坐标点击的空间）。 */
  viewportWidth: Schema.number().default(1440),
  viewportHeight: Schema.number().default(900),
  /** 可选：CDP 端点不可用时执行一次的自启命令（例如 `node .../bin/browsersvc.mjs start`）。 */
  autoStartCommand: Schema.string(),
});

/** 执行一次自启命令；超时或非零退出都视为失败。 */
function runCommand(command, timeoutMs) {
  return new Promise((resolve, reject) => {
    exec(command, { timeout: timeoutMs }, (error, _stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim()));
      else resolve();
    });
  });
}

export async function apply(ctx, config) {
  let chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch (error) {
    ctx.logger?.error?.(`browser-cdp: 无法加载 playwright-core，未注册 provider：${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  let BrowserError;
  try {
    // 与 seam 共用错误类型（同目录安装时必然可解析）；独立测试时退化为内置实现。
    ({ BrowserError } = await import('dsh-builtin-browser/browser'));
  } catch {
    BrowserError = undefined;
  }
  const provider = createProvider({
    chromium,
    BrowserError,
    config,
    log: ctx.logger,
    autoStart: (command, timeoutMs) => runCommand(command, timeoutMs),
  });
  const unregister = ctx.browser.registerBrowserProvider(provider);
  ctx.effect(() => () => {
    unregister();
    void provider.dispose();
  }, 'browser-cdp: owned provider lifecycle');
  ctx.logger?.info?.(`browser-cdp: 已注册 provider "${provider.id}"（${config.cdpUrl}）`);
}
