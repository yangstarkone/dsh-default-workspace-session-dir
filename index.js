/**
 * Per-session output directories for the default workspace.
 *
 * Why: the default workspace is the temporary session area. A session that
 * actually runs keeps the files it generates in its own timestamped folder, and
 * that folder must disappear when the user archives the session — but NOT when
 * the application quits. A model cannot run after its session ends, so a Host
 * plugin owns the folder lifecycle.
 *
 * Seams:
 * - `agent/pre-step`: the session is about to take a step, i.e. it has real
 *   work. Assign (or reuse) its directory then, so merely browsing sessions in
 *   the sidebar never leaves empty folders behind. The per-agent prompt context
 *   is registered before that step assembles its request.
 * - `workspace/session-stop`: the user archived the session with activity stop.
 * - `domain/changed`: durable archive-set writes; catches an archive whose stop
 *   event did not dispatch.
 * - Deliberately not `agent/disposed` / `session/disposed`: quitting the app
 *   also disposes agents, and the directories must survive a quit.
 *
 * Safety: a directory is removed only when it sits directly under the default
 * workspace, its name matches the timestamp pattern, and its marker file names
 * the exact session and workspace. Anything else is left untouched.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

/** Stable identity written into every marker file. */
const PLUGIN_ID = 'default-workspace-session-dir';

export const name = PLUGIN_ID;

/** Marker file written inside every directory this plugin owns. */
const MARKER_FILE = '.dsh-session-dir.json';
/** Directory names this plugin may remove: `2026-10-24-11-09` or `...-2`. */
const STAMP_PATTERN = /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}(?:-\d+)?$/;
/** Stable prompt-context name; a scoped entry shadows a global one. */
const PROMPT_NAME = 'default-workspace-output-dir';
/** Late placement in the assembled context list. */
const PROMPT_ORDER = 1000;
/** Sub-agent directories live under their parent session's directory. */
const SUBAGENT_DIR = 'subagents';
/** Collision search limit for one minute. */
const COLLISION_LIMIT = 50;
/**
 * Removed folders are first renamed here, still outside the workspace but no
 * longer listed in it: deleting a directory that a GUI file panel or watcher
 * has open on Windows leaves a delete-pending ghost that reports "permission
 * denied" until the handle closes. A rename leaves no such ghost. The copies
 * are purged on the next plugin load, when no old handle can be open.
 */
const TRASH_DIR_NAME = 'session-trash';

function logger() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const dir = join(home, 'logs');
  const file = join(dir, 'default-workspace-session-dir.log');
  return {
    file,
    write(event, detail = {}) {
      try {
        mkdirSync(dir, { recursive: true });
        appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), event, ...detail })}\n`, 'utf8');
      } catch {
        // A diagnostic that cannot be written must never disturb a session.
      }
    },
  };
}

const log = logger();

/** `2026-10-24-11-09` — local wall clock, minute precision. */
function directoryStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}-${pad(date.getMinutes())}`;
}

/** Windows path comparison is case-insensitive. */
function normalized(path) {
  const resolved = resolve(path);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function sameDirectory(left, right) {
  return typeof left === 'string' && left !== '' && normalized(left) === normalized(right);
}

function readMarker(directory) {
  try {
    const parsed = JSON.parse(readFileSync(join(directory, MARKER_FILE), 'utf8'));
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writeMarker(directory, marker) {
  writeFileSync(join(directory, MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
}

/** Collect the archived session ids out of an unknown storage snapshot. */
function findArchivedIds(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findArchivedIds(item, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (Array.isArray(value.archivedSessionIds)) return value.archivedSessionIds;
  for (const key of Object.keys(value)) {
    const found = findArchivedIds(value[key], depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function shortSessionId(sessionId) {
  return String(sessionId).replace(/^session-/, '').slice(0, 8);
}

function promptText(directory) {
  return [
    '## 会话输出目录',
    `本会话输出目录：\`${directory}\``,
    '- 所有新生成的文件（文档、表格、图片、脚本、下载与临时数据）都写入该目录，不要写到默认工作区根目录。',
    '- 需要读取工作区里已有的文件时使用绝对路径。',
    '- 除非用户明确要求删除，否则不要删除该目录或其中的文件；会话被归档时该目录会自动删除。',
  ].join('\n');
}

/**
 * The default workspace this profile owns. The durable workspace registry is
 * authoritative; `workingDirectory.defaultDirectory` is only the deployment
 * fallback for sessions with no recorded directory, so it must not win here.
 */
function resolveDefaultWorkspace(ctx, config) {
  const configured = typeof config?.workspacePath === 'string' ? config.workspacePath.trim() : '';
  if (configured !== '') return configured;
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  try {
    const registry = JSON.parse(readFileSync(join(home, 'storages', 'workspace.json'), 'utf8'));
    const defaultId = registry?.global?.defaultWorkspaceId;
    const path = registry?.tables?.workspaces?.[defaultId]?.path;
    if (typeof path === 'string' && path !== '') return path;
  } catch {
    // Fall through to the deployment fallback below.
  }
  try {
    const fallback = ctx.get('workingDirectory')?.defaultDirectory;
    if (typeof fallback === 'string' && fallback !== '') return fallback;
  } catch {
    // No usable directory.
  }
  return undefined;
}

export function apply(ctx, config) {
  const defaultWorkspace = resolveDefaultWorkspace(ctx, config);
  if (typeof defaultWorkspace !== 'string' || defaultWorkspace === '') {
    log.write('inactive', { reason: 'default workspace directory is unavailable' });
    return;
  }
  const root = resolve(defaultWorkspace);
  log.write('loaded', { root });
  purgeTrash();

  /** sessionId -> { dir: string } for sessions handled by this host process. */
  const entries = new Map();
  /** sessionId -> disposer of that session's prompt context. */
  const prompts = new Map();

  ctx.effect(() => () => {
    for (const dispose of prompts.values()) {
      try {
        dispose();
      } catch {
        // Already disposed with its agent scope.
      }
    }
    prompts.clear();
    entries.clear();
  });

  function isTargetSession(header) {
    return header !== undefined && header !== null && sameDirectory(header.cwd, root);
  }

  /** Find a directory this plugin already created for the session. */
  function findSessionDirectory(sessionId) {
    let names;
    try {
      names = readdirSync(root);
    } catch {
      return undefined;
    }
    for (const entryName of names) {
      if (!STAMP_PATTERN.test(entryName)) continue;
      const directory = join(root, entryName);
      const marker = readMarker(directory);
      if (marker?.sessionId === sessionId && sameDirectory(marker.workspacePath, root)) return directory;
    }
    return undefined;
  }

  /** Create the directory for one session, avoiding name collisions. */
  function claimSessionDirectory(sessionId) {
    const stamp = directoryStamp();
    for (let index = 1; index <= COLLISION_LIMIT; index += 1) {
      const dirName = index === 1 ? stamp : `${stamp}-${index}`;
      const directory = join(root, dirName);
      if (existsSync(directory)) {
        const marker = readMarker(directory);
        if (marker?.sessionId === sessionId) return directory;
        continue;
      }
      try {
        mkdirSync(directory, { recursive: false });
        writeMarker(directory, {
          plugin: PLUGIN_ID,
          sessionId,
          workspacePath: root,
          createdAt: new Date().toISOString(),
        });
        return directory;
      } catch (error) {
        log.write('create-failed', { sessionId, directory, error: String(error) });
        return undefined;
      }
    }
    log.write('create-exhausted', { sessionId, stamp });
    return undefined;
  }

  function ensureSessionDirectory(agent) {
    const header = agent.session.header;
    if (header.origin !== 'subagent') {
      return findSessionDirectory(header.id) ?? claimSessionDirectory(header.id);
    }
    const parentId = header.parentSession;
    const parent = typeof parentId === 'string' ? entries.get(parentId) : undefined;
    if (parent === undefined) {
      // The parent session is not managed here (closed, archived, or created
      // before this plugin loaded): never scatter sub-agent output at the root.
      return undefined;
    }
    const directory = join(parent.dir, SUBAGENT_DIR, shortSessionId(header.id));
    try {
      if (!existsSync(directory)) {
        mkdirSync(directory, { recursive: true });
        writeMarker(directory, {
          plugin: PLUGIN_ID,
          sessionId: header.id,
          workspacePath: root,
          parentSession: parentId,
          createdAt: new Date().toISOString(),
        });
      }
    } catch (error) {
      log.write('subagent-create-failed', { sessionId: header.id, directory, error: String(error) });
      return undefined;
    }
    return directory;
  }

  /** Where removed folders wait for a purge that no old file handle can block. */
  function trashDirectory() {
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
    return join(home, TRASH_DIR_NAME);
  }

  /** Delete everything quarantined by an earlier process (no handle can block it). */
  function purgeTrash() {
    const trash = trashDirectory();
    let names;
    try {
      names = readdirSync(trash);
    } catch {
      return;
    }
    let purged = 0;
    for (const name of names) {
      try {
        rmSync(join(trash, name), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        purged += 1;
      } catch (error) {
        log.write('trash-purge-failed', { name, error: String(error) });
      }
    }
    if (purged > 0) log.write('trash-purged', { purged, trash });
  }

  /** Move an owned directory out of the workspace, then delete the copy. */
  function quarantineSessionDirectory(directory, sessionId) {
    const resolved = resolve(directory);
    if (normalized(dirname(resolved)) !== normalized(root)) {
      log.write('delete-refused', { sessionId, directory: resolved, reason: 'not directly under the workspace' });
      return false;
    }
    if (!STAMP_PATTERN.test(basename(resolved))) {
      log.write('delete-refused', { sessionId, directory: resolved, reason: 'name is not a timestamp' });
      return false;
    }
    const marker = readMarker(resolved);
    if (marker?.sessionId !== sessionId) {
      log.write('delete-refused', { sessionId, directory: resolved, reason: 'marker does not name this session' });
      return false;
    }
    if (!sameDirectory(marker.workspacePath, root)) {
      log.write('delete-refused', { sessionId, directory: resolved, reason: 'marker names another workspace' });
      return false;
    }
    let target;
    try {
      const trash = trashDirectory();
      mkdirSync(trash, { recursive: true });
      target = join(trash, `${directoryStamp()}-${basename(resolved)}-${shortSessionId(sessionId)}`);
      renameSync(resolved, target);
    } catch (error) {
      // A sharing violation can block the rename too; fall back to deleting in
      // place so an unshared folder still disappears immediately.
      log.write('quarantine-failed', { sessionId, directory: resolved, error: String(error) });
      try {
        rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        return true;
      } catch (fallbackError) {
        log.write('delete-failed', { sessionId, directory: resolved, error: String(fallbackError) });
        return false;
      }
    }
    try {
      rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (error) {
      // A GUI watcher may still hold the moved folder. It is already outside
      // the workspace, and the next plugin load purges the trash.
      log.write('trash-deferred', { sessionId, directory: target, error: String(error) });
    }
    return true;
  }

  function deleteSessionDirectory(sessionId, reason) {
    if (typeof sessionId !== 'string' || sessionId === '') return;
    const candidates = new Set();
    const known = entries.get(sessionId)?.dir;
    if (typeof known === 'string') candidates.add(known);
    const found = findSessionDirectory(sessionId);
    if (found !== undefined) candidates.add(found);
    let removed = 0;
    for (const directory of candidates) {
      if (quarantineSessionDirectory(directory, sessionId)) removed += 1;
    }
    for (const [childId, entry] of entries) {
      if (typeof entry.dir === 'string' && [...candidates].some((parent) => entry.dir.startsWith(`${parent}\\`))) {
        entries.delete(childId);
      }
    }
    entries.delete(sessionId);
    log.write('delete', { sessionId, reason, directories: [...candidates], removed });
  }

  function installPrompt(agent, directory) {
    const sessionId = agent.session.header.id;
    const previous = prompts.get(sessionId);
    if (previous !== undefined) {
      prompts.delete(sessionId);
      try {
        previous();
      } catch {
        // Already disposed with its agent scope.
      }
    }
    try {
      const prompt = agent.ctx?.systemPrompt;
      if (prompt === undefined || typeof prompt.context !== 'function') {
        log.write('prompt-skipped', { sessionId });
        return;
      }
      const dispose = prompt.context({ name: PROMPT_NAME, order: PROMPT_ORDER, text: promptText(directory) });
      prompts.set(sessionId, dispose);
      agent.ctx.effect(() => () => {
        if (prompts.get(sessionId) === dispose) prompts.delete(sessionId);
        dispose();
      });
    } catch (error) {
      log.write('prompt-failed', { sessionId, error: String(error) });
    }
  }

  function setupAgent(agent) {
    try {
      const header = agent?.session?.header;
      if (header === undefined || header === null || !isTargetSession(header)) return;
      if (entries.has(header.id)) return;
      const directory = ensureSessionDirectory(agent);
      if (directory === undefined) return;
      entries.set(header.id, { dir: directory });
      installPrompt(agent, directory);
      log.write(header.origin === 'subagent' ? 'subagent-dir' : 'session-dir', { sessionId: header.id, directory });
    } catch (error) {
      log.write('setup-failed', { error: String(error) });
    }
  }

  // Folder assignment happens on real work, not on opening a session: browsing
  // the sidebar never leaves empty folders behind.
  ctx.on('agent/pre-step', async (payload, next) => {
    try {
      setupAgent(payload?.agent);
    } catch (error) {
      log.write('pre-step-failed', { error: String(error) });
    }
    return next();
  });

  ctx.on('workspace/session-stop', (request) => {
    try {
      deleteSessionDirectory(request?.sessionId, 'archive');
    } catch (error) {
      log.write('delete-failed', { error: String(error) });
    }
  });

  const seenDomains = new Set();
  ctx.on('domain/changed', (change) => {
    try {
      if (change === undefined || change === null || change.operation !== 'put') return;
      const archivedIds = findArchivedIds(change.value);
      if (archivedIds === undefined) {
        if (!seenDomains.has(change.domain)) {
          seenDomains.add(change.domain);
          log.write('domain-ignored', { domain: change.domain, table: change.table });
        }
        return;
      }
      if (!seenDomains.has(change.domain)) {
        seenDomains.add(change.domain);
        log.write('domain-archive-set', { domain: change.domain });
      }
      for (const sessionId of archivedIds) {
        if (typeof sessionId === 'string') deleteSessionDirectory(sessionId, 'archive-set');
      }
    } catch (error) {
      log.write('domain-failed', { error: String(error) });
    }
  });
}
