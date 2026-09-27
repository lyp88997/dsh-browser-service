/**
 * dsh-browser-service 的 provider 插件 —— 把 DSH 的 browser seam 接到自建 CDP 浏览器服务（browsersvc）。
 *
 * 只做一件事：注册一个 BrowserProvider。接缝（ctx.browser）与工具面（33 个 browser_* 工具）
 * 由本包的依赖 dsh-builtin-browser 提供，经本包 ./browser、./tool-browser 转出后由 bundle patch 挂上。
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
  /**
   * 可选：CDP 端点不可用时执行一次的自启命令。
   * 默认（不配置）用本包自带的 `bin/browsersvc.mjs start`，即装完本包就能自启（一个包装完）。
   */
  autoStartCommand: Schema.string(),
  /** 自启命令（`browsersvc start` 内含内核冷启动 + 健康检查）的预算，与 attach 超时分开。 */
  autoStartTimeoutMs: Schema.number().default(60_000),
  /**
   * 访问代理端口的 Bearer token。默认（不配置）时自动读 `$DSH_BROWSER_SVC_ROOT|$DSH_HOME/browser-service/service.json`
   * 里的 token（每次守护进程启动随机生成）。
   */
  cdpToken: Schema.string(),
  /**
   * 可选：截图/下载落盘的目录边界。不配置 = 只强制绝对路径且不覆盖已有文件（与内置 provider 同语义）。
   */
  downloadDir: Schema.string(),
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
