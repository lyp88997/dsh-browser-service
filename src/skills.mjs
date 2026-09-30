/**
 * skills.mjs —— 本包随附的全局技能（`skills/`）与 DSH 技能根目录之间的同步。
 *
 * 为什么需要它：DSH 的技能发现只认磁盘目录（项目 `.dsh/skills`、`$DSH_HOME/skills`、
 * `~/.agents/skills`、宿主自带的 bundled 目录），`package.json` 的 `dsh` 清单里没有技能位
 * （DshManifest 只有 bundle / profile / client / configTrees / sessionFormatMigration /
 * moduleFallback）⇒ 插件想让「装完就有全局技能」，只能把随包文件落到技能根目录。
 *
 * 同步带归属台账（marker），只覆盖**我们自己写过且之后没人动过**的文件：
 *   - 目标不存在           → 装
 *   - 与源逐字节相同       → 不动（记为我们的）
 *   - 与台账里的旧哈希相同 → 是我们的旧版，覆盖（升级）
 *   - 其它（用户改过 / 同名但不在台账里）→ 跳过并说明，除非 force
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

/** 本包版本（技能台账按它记版本）。 */
export const PACKAGE_VERSION = require('../package.json').version;
/** 随包技能源目录：<包根>/skills。 */
export const SKILLS_SOURCE = fileURLToPath(new URL('../skills/', import.meta.url));
/** 技能根目录下的归属台账文件名（非 .md，技能发现会忽略它）。 */
export const MARKER_NAME = '.dsh-browser-service.skills.json';

/** DSH 的用户级技能根目录：`$DSH_HOME/skills`（DSH 未设 HOME 时回落 `~/.dsh/skills`）。 */
export function defaultSkillsRoot({ dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh') } = {}) {
  return join(resolve(dshHome), 'skills');
}

/** 文本的 sha256（技能都是文本；scripts/ 里的脚本也是）。 */
export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** 递归列出技能源里的文件（相对路径用正斜杠，排序稳定）；跳过点开头的项。 */
export function listSkillFiles(source = SKILLS_SOURCE) {
  const out = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  if (existsSync(source)) walk(source, '');
  return out;
}

/** 读技能台账；坏了/没有都当空台账（永不抛）。 */
export function readMarker(root) {
  try {
    const raw = JSON.parse(readFileSync(join(root, MARKER_NAME), 'utf8'));
    return {
      version: typeof raw.version === 'string' ? raw.version : null,
      generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : null,
      files: raw.files && typeof raw.files === 'object' && !Array.isArray(raw.files) ? raw.files : {},
    };
  } catch {
    return { version: null, generatedAt: null, files: {} };
  }
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** 逐个文件给状态：missing / current / update / modified / foreign。 */
export function inspectSkills({ source = SKILLS_SOURCE, root = defaultSkillsRoot() } = {}) {
  const marker = readMarker(root);
  const files = listSkillFiles(source).map((rel) => {
    const text = readText(join(source, rel));
    const sourceHash = text === null ? null : sha256(text);
    const dest = readText(join(root, rel));
    const destHash = dest === null ? null : sha256(dest);
    const owned = marker.files[rel];
    let state = 'foreign';
    if (text === null) state = 'unreadable-source';
    else if (destHash === null) state = 'missing';
    else if (destHash === sourceHash) state = 'current';
    else if (owned !== undefined && destHash === owned) state = 'update';
    else if (owned === undefined) state = 'foreign';
    else state = 'modified';
    return { path: rel, state, sourceHash, destHash, owned };
  });
  return { source, root, version: PACKAGE_VERSION, marker, files };
}

/**
 * 同步随包技能到技能根目录。
 * @param {object} [options]
 * @param {string} [options.source] 技能源目录（默认本包 skills/）
 * @param {string} [options.root] 目标技能根目录（默认 `$DSH_HOME/skills`）
 * @param {string} [options.version] 写进台账的版本
 * @param {boolean} [options.force] 覆盖被用户改过 / 不在台账里的同名文件
 * @returns {{source:string,root:string,version:string,installed:string[],updated:string[],unchanged:string[],skipped:{path:string,reason:string}[],errors:string[],markerWritten:boolean}}
 */
export function syncSkills({ source = SKILLS_SOURCE, root = defaultSkillsRoot(), version = PACKAGE_VERSION, force = false } = {}) {
  const out = {
    source,
    root,
    version,
    installed: [],
    updated: [],
    unchanged: [],
    skipped: [],
    errors: [],
    markerWritten: false,
  };
  const files = listSkillFiles(source);
  if (files.length === 0) {
    out.errors.push(`技能源目录是空的（或不存在）：${source}`);
    return out;
  }
  const marker = readMarker(root);
  const next = { ...marker.files };

  for (const rel of files) {
    let text;
    let mode = 0o644;
    try {
      text = readFileSync(join(source, rel), 'utf8');
      mode = statSync(join(source, rel)).mode & 0o777;
    } catch (error) {
      out.errors.push(`${rel}：读不到源文件（${error.message}）`);
      continue;
    }
    const sourceHash = sha256(text);
    const destPath = join(root, rel);
    const destText = readText(destPath);
    const owned = marker.files[rel];

    const write = () => {
      try {
        mkdirSync(dirname(destPath), { recursive: true });
        writeFileSync(destPath, text, { mode });
        return true;
      } catch (error) {
        out.errors.push(`${rel}：写不进 ${destPath}（${error.message}）`);
        return false;
      }
    };

    if (destText === null) {
      if (write()) {
        out.installed.push(rel);
        next[rel] = sourceHash;
      }
      continue;
    }
    const destHash = sha256(destText);
    if (destHash === sourceHash) {
      out.unchanged.push(rel);
      next[rel] = sourceHash;
      continue;
    }
    if (force || (owned !== undefined && destHash === owned)) {
      if (write()) {
        out.updated.push(rel);
        next[rel] = sourceHash;
      }
      continue;
    }
    out.skipped.push({
      path: rel,
      reason: owned === undefined
        ? '磁盘上已有同名技能，但不是本包装的（没在台账里）'
        : `磁盘上的副本被改过（不是本包 ${version} 写的那份）`,
    });
    if (owned !== undefined) next[rel] = owned;
  }

  const markerPath = join(root, MARKER_NAME);
  const changed = out.installed.length > 0 || out.updated.length > 0;
  if (changed || !existsSync(markerPath)) {
    try {
      mkdirSync(root, { recursive: true });
      const previous = existsSync(markerPath) ? marker.version : null;
      writeFileSync(
        markerPath,
        `${JSON.stringify({ version, previous, generatedAt: new Date().toISOString(), files: next }, null, 2)}\n`,
        { mode: 0o644 },
      );
      out.markerWritten = true;
    } catch (error) {
      out.errors.push(`台账写不进 ${markerPath}（${error.message}）`);
    }
  }
  return out;
}
