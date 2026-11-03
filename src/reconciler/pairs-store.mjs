// Pair storage for the SimklStremio reconciler.
//
// Pairs live in <dataDir>/pairs.json, encrypted at rest with AES-256-GCM.
// The encryption key is derived from PRIVATE_ENCRYPTION_KEY with scrypt.
// This module is plain ESM JavaScript with no dependencies so it can be
// used both by the Qwik server route (src/routes/api/pairs) and by the
// headless reconciler process (scripts/reconciler.mjs).
//
// Plain-text pair shape (never written to disk unencrypted):
// {
//   name: string,
//   stremioAuthKey: string,
//   simkl: { access_token, client_id, refresh_token?, expires_at? },
//   watchTogether?: boolean,
//   mirrorSimkl?: { access_token, client_id, refresh_token?, expires_at? } | null,
//   watchTogetherAppliedMode?: 'on' | 'off',
//     // The effective Watch Together mode the reconciler last applied
//     // (see watch-together-baseline.mjs effectiveWatchTogether). The
//     // reconciler maintains it so a fresh baseline is captured only on
//     // a real off->on switch, never on a plain restart. Absent on
//     // pairs saved before the .env switch existed; the reconciler
//     // adopts the stored baseline for those. A configure-page save
//     // rebuilds the record without this field, resetting it to
//     // "unset" for the reconciler to re-derive on its next run.
//   watchTogetherBaseline?: {
//     version: 1,
//     capturedAt: string (ISO),
//     movies: string[],
//     shows: { [imdb: string]: string[] } // episode keys "season:episode"
//   } | null,
//   updatedAt: string (ISO)
// }

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const STORE_VERSION = 1;
const SALT = 'simklstremio-pairs-v1';

export function getDataDir() {
  return process.env.DATA_DIR || join(process.cwd(), 'data');
}

export function pairsFilePath(dataDir = getDataDir()) {
  return join(dataDir, 'pairs.json');
}

export function statusFilePath(dataDir = getDataDir()) {
  return join(dataDir, 'status.json');
}

function deriveKey(secret) {
  if (!secret) {
    throw new Error('PRIVATE_ENCRYPTION_KEY is not set');
  }
  return scryptSync(String(secret), SALT, 32);
}

export function encryptPairs(pairs, secret) {
  const key = deriveKey(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = JSON.stringify({ version: STORE_VERSION, pairs });
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    version: STORE_VERSION,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: data.toString('base64'),
  });
}

export function decryptPairs(fileContent, secret) {
  const key = deriveKey(secret);
  const parsed = JSON.parse(fileContent);
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(parsed.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(parsed.data, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  const doc = JSON.parse(plaintext);
  return Array.isArray(doc.pairs) ? doc.pairs : [];
}

/** Returns [] when no pairs file exists yet. Throws on decrypt failure. */
export function loadPairs(secret, dataDir = getDataDir()) {
  const file = pairsFilePath(dataDir);
  if (!existsSync(file)) {
    return [];
  }
  return decryptPairs(readFileSync(file, 'utf8'), secret);
}

export function savePairs(pairs, secret, dataDir = getDataDir()) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(pairsFilePath(dataDir), encryptPairs(pairs, secret), 'utf8');
}

/** Insert or replace the pair with the same name. Returns the full list. */
export function upsertPair(pair, secret, dataDir = getDataDir()) {
  const pairs = loadPairs(secret, dataDir);
  const idx = pairs.findIndex((p) => p.name === pair.name);
  const stamped = { ...pair, updatedAt: new Date().toISOString() };
  if (idx >= 0) {
    pairs[idx] = stamped;
  } else {
    pairs.push(stamped);
  }
  savePairs(pairs, secret, dataDir);
  return pairs;
}

/** Replace the stored Simkl auth for one target ('simkl' | 'mirrorSimkl'). */
export function updatePairAuth(name, target, auth, secret, dataDir = getDataDir()) {
  const pairs = loadPairs(secret, dataDir);
  const pair = pairs.find((p) => p.name === name);
  if (!pair) {
    return false;
  }
  if (target === 'mirrorSimkl') {
    pair.mirrorSimkl = auth;
  } else {
    pair.simkl = auth;
  }
  pair.updatedAt = new Date().toISOString();
  savePairs(pairs, secret, dataDir);
  return true;
}

/**
 * Replace only the Watch Together fields of a stored pair: the
 * starting-point baseline and/or the last applied mode. Reloads the
 * store and mutates just those fields, so a token refreshed moments
 * earlier (updatePairAuth) is never clobbered by a stale in-memory
 * pair object. Fields left undefined are untouched. Returns false
 * when no pair with that name is stored.
 */
export function updatePairWatchTogether(
  name,
  { baseline, appliedMode } = {},
  secret,
  dataDir = getDataDir(),
) {
  const pairs = loadPairs(secret, dataDir);
  const pair = pairs.find((p) => p.name === name);
  if (!pair) {
    return false;
  }
  if (baseline !== undefined) {
    pair.watchTogetherBaseline = baseline;
  }
  if (appliedMode !== undefined) {
    pair.watchTogetherAppliedMode = appliedMode;
  }
  pair.updatedAt = new Date().toISOString();
  savePairs(pairs, secret, dataDir);
  return true;
}

/**
 * Which mirror Simkl credentials a pair save stores — the parked
 * sign-in rule. Freshly supplied credentials (a completed mirror
 * approval on the configure page) always win. When the save supplies
 * none, the credentials already stored on the pair are KEPT, so
 * saving with Watch Together off parks the mirror sign-in instead of
 * discarding it, and a later save or the .env switch can turn Watch
 * Together back on without a new approval round-trip. Returns null
 * only when neither source has credentials.
 */
export function resolveMirrorForSave(suppliedMirror, existingPair) {
  if (suppliedMirror?.access_token && suppliedMirror?.client_id) {
    return {
      access_token: suppliedMirror.access_token,
      client_id: suppliedMirror.client_id,
      refresh_token: suppliedMirror.refresh_token,
      expires_at: suppliedMirror.expires_at,
    };
  }
  return existingPair?.mirrorSimkl ?? null;
}

export function readStatus(dataDir = getDataDir()) {
  const file = statusFilePath(dataDir);
  if (!existsSync(file)) {
    return { updatedAt: null, pairs: {} };
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { updatedAt: null, pairs: {} };
  }
}

export function writeStatus(status, dataDir = getDataDir()) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    statusFilePath(dataDir),
    JSON.stringify({ ...status, updatedAt: new Date().toISOString() }, null, 2),
    'utf8',
  );
}
