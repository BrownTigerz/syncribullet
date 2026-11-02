/**
 * Shared types for the SimklStremio pair store.
 * The runtime implementation is pairs-store.mjs (plain ESM, shared with
 * the headless reconciler process); these interfaces describe its data.
 */
export interface SimklStremioPairAuth {
  access_token: string;
  client_id: string;
  refresh_token?: string;
  expires_at?: number;
}

export interface SimklStremioPair {
  name: string;
  stremioAuthKey: string;
  simkl: SimklStremioPairAuth;
  watchTogether?: boolean;
  mirrorSimkl?: SimklStremioPairAuth | null;
  updatedAt?: string;
}
