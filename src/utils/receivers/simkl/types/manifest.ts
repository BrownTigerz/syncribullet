import type { DeepWriteable } from '~/utils/helpers/types';
import type { ManifestCatalogItemType } from '~/utils/manifest';
import type { ReceiverServerConfig } from '~/utils/receiver/receiver-server';
import type { Receivers } from '~/utils/receiver/types/receivers';

import type { internalIds, syncIds } from '../constants';
import type { SimklCatalogStatus } from './catalog/catalog-status';
import type { SimklCatalogType } from './catalog/catalog-type';
import type { SimklLibraryListEntry } from './simkl/library';

type SimklCatalog = ManifestCatalogItemType<
  Receivers.SIMKL,
  SimklCatalogStatus,
  SimklCatalogType
>;

export type SimklMCIT = SimklCatalog & {
  auth?: {
    access_token: string;
    client_id: string;
    /** AUTH V2 only: refresh token (180 days, sliding) from the device flow. */
    refresh_token?: string;
    /** AUTH V2 only: epoch ms when the access token expires (7 days). */
    expires_at?: number;
  };
  internalIds: DeepWriteable<typeof internalIds>;
  syncIds: DeepWriteable<typeof syncIds>;
  receiverServerConfig: ReceiverServerConfig<
    SimklLibraryListEntry,
    SimklLibraryListEntry
  >;
};
