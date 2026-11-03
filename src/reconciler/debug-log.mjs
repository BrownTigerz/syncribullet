// Debug log writer for SimklStremio.
//
// Appends timestamped plain-text lines to <dataDir>/debug.log, using the
// exact same data-directory resolution as the pairs store (DATA_DIR env
// override, otherwise ./data under the working directory — /app/data in
// the container). The file lives next to pairs.json and status.json so TK
// can open it in Notepad and send it when a watch does not land.
//
// Line format:  2026-11-02T19:30:00.000Z [scope] message
// Scopes: reconciler, pair:<name>, mirror:<name>, live.
//
// Rules:
// - Default ON. DEBUG_LOG=0 disables it.
// - Rotation: before a write, if the file is over ~5 MB it is renamed to
//   debug.log.1 (replacing any previous .1) and a fresh file is started.
// - Fail-silent: every operation is wrapped so a logging failure can
//   NEVER throw into the caller. No data dir, a read-only dir, or a full
//   disk all degrade to a no-op.
// - NEVER log secrets: no Simkl access/refresh tokens, no Stremio
//   authKeys, no encrypted pair blobs, no addon config strings. Callers
//   log IMDb IDs, item IDs, counts, HTTP status codes, and pair names
//   only. (Simkl client IDs are public by design.)

import {
  appendFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';

import { getDataDir } from './pairs-store.mjs';

export const DEBUG_LOG_MAX_BYTES = 5 * 1024 * 1024;

export function debugLogEnabled() {
  return process.env.DEBUG_LOG !== '0';
}

export function debugLogPath(dataDir = getDataDir()) {
  return join(dataDir, 'debug.log');
}

function rotateIfNeeded(file) {
  try {
    const stat = statSync(file);
    if (stat.size > DEBUG_LOG_MAX_BYTES) {
      const rotated = `${file}.1`;
      try {
        rmSync(rotated, { force: true });
      } catch {
        // ignore — rename below may still succeed
      }
      renameSync(file, rotated);
    }
  } catch {
    // Missing file (the common case) or any fs error: nothing to rotate.
  }
}

/**
 * Append one line to debug.log. Never throws.
 * `dataDir` may be undefined, in which case the pairs-store resolution
 * (DATA_DIR / ./data) is used.
 */
export function writeDebugLog(scope, message, dataDir) {
  try {
    if (!debugLogEnabled()) {
      return;
    }
    const dir = dataDir || getDataDir();
    const file = debugLogPath(dir);
    rotateIfNeeded(file);
    const line = `${new Date().toISOString()} [${scope}] ${message}\n`;
    appendFileSync(file, line, 'utf8');
  } catch {
    // Logging must never break the caller. Silent by design.
  }
}

/**
 * Convenience logger bound to a data dir:
 *   const dbg = createDebugLogger(dataDir);
 *   dbg('pair:TK', 'run started');
 *   dbg.forScope('pair:TK')('run started');
 */
export function createDebugLogger(dataDir) {
  const write = (scope, message) => writeDebugLog(scope, message, dataDir);
  write.forScope = (scope) => (message) => writeDebugLog(scope, message, dataDir);
  return write;
}
