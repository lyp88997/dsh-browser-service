/**
 * 配置与内核解析。
 * 优先级：CLI 参数 > 环境变量 > $ROOT/config.json > 自动探测。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULTS = {
  port: 9333,            // 公开 CDP 端口（0 = 自动择取）
  idleMs: 15 * 60_000,   // 无客户端连接多久后自杀
  maxRestarts: 5,        // 窗口内最大重启次数
  restartWindowMs: 60_000,
  startTimeoutMs: 25_000,
  internalPortBase: 9300,
};

export function dshHome(env = process.env) {
  const v = env.DSH_HOME?.trim();
  return v && v.length ? v : join(homedir(), '.dsh');
}

export function defaultRoot(env = process.env) {
  const v = env.DSH_BROWSER_SVC_ROOT?.trim();
  return v && v.length ? v : join(dshHome(env), 'browser-service');
}

/** 读 $ROOT/config.json（缺失/损坏返回 {}）。 */
export function readConfigFile(root) {
  const file = join(root, 'config.json');
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 自动探测候选内核。返回 { kind: 'wrapper' | 'chrome', path } 列表，按优先级排列。
 * wrapper = 负责注入 LD_LIBRARY_PATH / FONTCONFIG_FILE / 沙箱参数的包装脚本。
 */
export function detectKernels(env = process.env, found = existsSync) {
  const out = [];
  const add = (kind, path) => {
    if (typeof path === 'string' && path.length > 0 && found(path) && !out.some((c) => c.path === path)) out.push({ kind, path });
  };
  add('wrapper', env.DSH_BROWSER_WRAPPER);
  add('chrome', env.DSH_BROWSER_CHROME);
  // 本机（非 root 容器）常见落点，纯属便利，找不到就跳过
  add('wrapper', '/home/node/DSH/.browser/chromium-wrapper.sh');
  add('chrome', '/home/node/DSH/.browser/chromium/chrome-headless-shell');
  for (const dir of (env.PATH ?? '').split(':')) {
    if (!dir) continue;
    for (const name of ['chrome-headless-shell', 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'msedge']) {
      add('chrome', join(dir, name));
    }
  }
  return out;
}

/** 合并出最终配置。 */
export function resolveConfig(cli = {}, env = process.env) {
  const root = cli.root ?? defaultRoot(env);
  const file = readConfigFile(root);
  const num = (v) => (v === undefined || v === null || v === '' ? undefined : Number(v));
  const cfg = {
    root,
    port: num(cli.port) ?? num(env.DSH_BROWSER_SVC_PORT) ?? num(file.port) ?? DEFAULTS.port,
    idleMs: num(cli.idleMs) ?? num(env.DSH_BROWSER_SVC_IDLE_MS) ?? num(file.idleMs) ?? DEFAULTS.idleMs,
    maxRestarts: num(cli.maxRestarts) ?? num(file.maxRestarts) ?? DEFAULTS.maxRestarts,
    restartWindowMs: DEFAULTS.restartWindowMs,
    startTimeoutMs: num(cli.startTimeoutMs) ?? DEFAULTS.startTimeoutMs,
    internalPortBase: num(file.internalPortBase) ?? DEFAULTS.internalPortBase,
    userDataDir: cli.userDataDir ?? file.userDataDir ?? join(root, 'profile'),
    kernel: null,
    kernelKind: null,
  };
  const want = cli.wrapper ?? file.wrapper;
  const wantChrome = cli.kernel ?? file.kernel;
  const candidates = detectKernels(env);
  if (want) cfg.kernel = want, cfg.kernelKind = 'wrapper';
  else if (wantChrome) cfg.kernel = wantChrome, cfg.kernelKind = 'chrome';
  else if (candidates.length) ({ path: cfg.kernel, kind: cfg.kernelKind } = candidates[0]);
  // 显式指定的路径不做 existsSync 校验之外的检查，交给 spawn 报错
  return cfg;
}

/** 内核启动参数（CDP 只绑回环！host 网络下这是硬要求）。 */
export function browserArgs(cfg, internalPort) {
  return [
    '--headless',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${internalPort}`,
    `--user-data-dir=${cfg.userDataDir}`,
    'about:blank',
  ];
}

export function ensureRoot(root) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(join(root, 'profile'), { recursive: true, mode: 0o700 });
  return root;
}

export function stateFile(root) {
  return join(root, 'service.json');
}

export function logFile(root) {
  return join(root, 'service.log');
}
