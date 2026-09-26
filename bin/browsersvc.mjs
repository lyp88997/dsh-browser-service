#!/usr/bin/env node
/**
 * browsersvc —— 单例浏览器 CDP 守护进程的 CLI。
 *
 *   browsersvc start|stop|status|restart|run|logs|detect [--port=9333] [--idle-ms=900000]
 *              [--kernel=/path/to/chrome] [--wrapper=/path/to/wrapper.sh] [--root=/path/to/state]
 *
 * 约定：CDP 只监听 127.0.0.1；对外端口由本地代理暴露，代理同时负责空闲回收。
 */
import { spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { detectKernels, ensureRoot, logFile, readConfigFile, resolveConfig, stateFile } from '../src/config.mjs';
import { isAlive, probeVersion, readState, runSupervisor } from '../src/daemon.mjs';

const BIN = fileURLToPath(new URL('./browsersvc.mjs', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parse(argv) {
  const out = { cmd: argv[0] ?? 'status', flags: {} };
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) out.flags[a.slice(2, eq)] = a.slice(eq + 1);
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out.flags[a.slice(2)] = argv[++i];
    else out.flags[a.slice(2)] = true;
  }
  return out;
}

const toCfg = (flags) => resolveConfig({
  root: flags.root,
  port: flags.port,
  idleMs: flags['idle-ms'],
  kernel: flags.kernel,
  wrapper: flags.wrapper,
  maxRestarts: flags['max-restarts'],
  userDataDir: flags['user-data-dir'],
});

function print(obj, code = 0) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
  process.exit(code);
}

async function status(cfg, { quiet = false } = {}) {
  const st = readState(cfg.root);
  if (!st || !st.supervisorPid || !isAlive(st.supervisorPid)) {
    if (!quiet) print({ running: false, root: cfg.root, stateFile: stateFile(cfg.root) }, 1);
    return { running: false };
  }
  const version = st.port ? await probeVersion(st.port) : null;
  const info = {
    running: true,
    healthy: Boolean(version),
    port: st.port,
    internalPort: st.internalPort,
    pid: st.supervisorPid,
    browserPid: st.browserPid,
    kernel: st.kernel,
    kernelKind: st.kernelKind,
    browserVersion: version?.Browser ?? st.browserVersion,
    protocolVersion: version?.['Protocol-Version'] ?? st.protocolVersion,
    wsEndpoint: version?.webSocketDebuggerUrl ?? null,
    startedAt: st.startedAt,
    idleMs: st.idleMs,
    logFile: logFile(cfg.root),
  };
  if (!quiet) print(info, version ? 0 : 1);
  return info;
}

const toFlagArgs = (flagsIn) => Object.entries(flagsIn).map(([k, v]) => (v === true ? `--${k}` : `--${k}=${v}`));

async function start(cfg) {
  ensureRoot(cfg.root);
  const existing = await status(cfg, { quiet: true });
  if (existing.running && existing.healthy) print({ alreadyRunning: true, ...existing });

  const out = openSync(logFile(cfg.root), 'a');
  const child = spawn(process.execPath, [BIN, 'run', ...toFlagArgs(flags)], {
    detached: true,
    stdio: ['ignore', out, out],
    env: process.env,
  });
  child.unref();

  const until = Date.now() + cfg.startTimeoutMs;
  while (Date.now() < until) {
    await sleep(200);
    const st = readState(cfg.root);
    if (st?.port) {
      const version = await probeVersion(st.port);
      if (version) print({ started: true, pid: st.supervisorPid, browserPid: st.browserPid, port: st.port, browserVersion: version.Browser, protocolVersion: version['Protocol-Version'], kernel: st.kernel, root: cfg.root, logFile: logFile(cfg.root) });
    }
    if (child.exitCode !== null) print({ started: false, reason: `supervisor exited early (code ${child.exitCode})，见 ${logFile(cfg.root)}` }, 1);
  }
  print({ started: false, reason: `在 ${cfg.startTimeoutMs}ms 内未就绪，见 ${logFile(cfg.root)}` }, 1);
}

async function stop(cfg) {
  const st = readState(cfg.root);
  if (!st) print({ stopped: true, reason: 'not running' });
  const kill = async (pid, sig) => {
    if (!pid || !isAlive(pid)) return;
    try {
      process.kill(pid, sig);
    } catch {
      /* 已退出 */
    }
  };
  await kill(st.supervisorPid, 'SIGTERM');
  for (let i = 0; i < 100 && isAlive(st.supervisorPid); i += 1) await sleep(100);
  if (isAlive(st.supervisorPid)) await kill(st.supervisorPid, 'SIGKILL');
  await kill(st.browserPid, 'SIGTERM');
  for (let i = 0; i < 30 && isAlive(st.browserPid); i += 1) await sleep(100);
  if (isAlive(st.browserPid)) await kill(st.browserPid, 'SIGKILL');
  rmSync(stateFile(cfg.root), { force: true });
  print({ stopped: true, supervisorPid: st.supervisorPid, browserPid: st.browserPid });
}

function logs(cfg, flags) {
  const file = logFile(cfg.root);
  if (!existsSync(file)) print({ logs: [], reason: 'no log file yet', file });
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const n = Number(flags.lines ?? 60);
  print({ file, lines: lines.slice(-n) });
}

function detect(cfg) {
  print({
    candidates: detectKernels(),
    configFile: readConfigFile(cfg.root),
    resolved: { kernel: cfg.kernel, kernelKind: cfg.kernelKind, port: cfg.port, idleMs: cfg.idleMs, root: cfg.root },
  });
}

const { cmd, flags } = parse(process.argv.slice(2));
const cfg = toCfg(flags);

switch (cmd) {
  case 'run':
    await runSupervisor(cfg);
    break;
  case 'start':
    await start(cfg);
    break;
  case 'stop':
    await stop(cfg);
    break;
  case 'restart':
    await stop(cfg).catch(() => {});
    await start(cfg);
    break;
  case 'status':
    await status(cfg);
    break;
  case 'logs':
    logs(cfg, flags);
    break;
  case 'detect':
    detect(cfg);
    break;
  default:
    print({ error: `unknown command: ${cmd}`, usage: 'browsersvc start|stop|status|restart|run|logs|detect' }, 2);
}
