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

export declare function getDataDir(): string;
export declare function pairsFilePath(dataDir?: string): string;
export declare function statusFilePath(dataDir?: string): string;
export declare function loadPairs(
  secret: string,
  dataDir?: string,
): SimklStremioPair[];
export declare function savePairs(
  pairs: SimklStremioPair[],
  secret: string,
  dataDir?: string,
): void;
export declare function upsertPair(
  pair: SimklStremioPair,
  secret: string,
  dataDir?: string,
): SimklStremioPair[];
export declare function readStatus(dataDir?: string): {
  updatedAt: string | null;
  pairs: Record<string, Record<string, unknown>>;
};
export declare function writeStatus(
  status: unknown,
  dataDir?: string,
): void;
