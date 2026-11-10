/**
 * Project trust.
 *
 * Two things under a project directory make cgraph do more than read files:
 *
 *   - language packs (`.cgraph/packs/*`, `node_modules/cgraph-pack-*`) are
 *     JavaScript that is `import()`ed, and so executed, on every index
 *   - `.cgraph/config.json` can turn on embeddings, which names a URL to send
 *     symbol text to and an environment variable whose value goes with it
 *
 * Both are fine in a repository you wrote and both are a problem in one you
 * just cloned: an agent that opens the repo starts the MCP server, the server
 * refreshes the index, and whatever the repo committed runs — or your
 * `OPENAI_API_KEY` is posted to a host the repo chose. Nothing about that
 * requires the developer to do anything but open the project.
 *
 * So neither happens until the user says so, once, with `cgraph trust`. The
 * record lives in the user's own cache directory and never inside the project,
 * because a list the repository can write to is a list it can add itself to.
 * For the same reason there is deliberately no config-file key for this.
 */

import fs from 'node:fs';
import path from 'node:path';
import { userCacheDir } from './config.js';

function trustFile() {
  return path.join(userCacheDir(), 'trusted.json');
}

/**
 * One canonical spelling per directory, so trusting `C:\Repo` also covers
 * `c:/repo/` and a symlink that points at it.
 */
function canonical(root) {
  let abs = path.resolve(root);
  try { abs = fs.realpathSync.native(abs); } catch { /* does not exist yet */ }
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

function readList() {
  try {
    const list = JSON.parse(fs.readFileSync(trustFile(), 'utf8'));
    return Array.isArray(list) ? list.filter((p) => typeof p === 'string') : [];
  } catch {
    // Missing or corrupt reads as "nothing is trusted" — the safe direction.
    return [];
  }
}

function writeList(list) {
  const file = trustFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify([...new Set(list)].sort(), null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/**
 * May this project run its own packs and use its embeddings config?
 *
 * `CGRAPH_TRUST=1` is the escape hatch for CI and containers, where the
 * checkout is the only thing on the machine and there is no home directory
 * worth persisting a decision into. It comes from the environment, which the
 * repository does not control.
 */
export function isTrusted(root) {
  if (process.env.CGRAPH_TRUST === '1') return true;
  return readList().includes(canonical(root));
}

export function trustProject(root) {
  const key = canonical(root);
  const list = readList();
  if (list.includes(key)) return false;
  writeList([...list, key]);
  return true;
}

export function untrustProject(root) {
  const key = canonical(root);
  const list = readList();
  if (!list.includes(key)) return false;
  writeList(list.filter((p) => p !== key));
  return true;
}
