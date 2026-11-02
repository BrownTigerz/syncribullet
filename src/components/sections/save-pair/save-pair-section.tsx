import { $, component$, useSignal, useVisibleTask$ } from '@builder.io/qwik';

import {
  pollDeviceAuth,
  startDeviceAuth,
} from '~/components/forms/simkl-login';
import type { SimklDeviceStart } from '~/components/forms/simkl-login';
import type { SimklStremioPairAuth } from '~/reconciler/types';

interface ServerPairSummary {
  name: string;
  updatedAt?: string;
  watchTogether: boolean;
  hasMirror: boolean;
  hasWatchTogetherBaseline: boolean;
  watchTogetherBaselineCapturedAt: string | null;
  status: {
    lastRunAt?: string;
    lastSuccessAt?: string;
    lastError?: string;
    needsReauth?: boolean;
    needsBaseline?: boolean;
    addedMovies?: number;
    addedEpisodes?: number;
  } | null;
}

const readJson = function (key: string) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

const readStremioAuthKey = function (): string | null {
  const settings = readJson('importer-settings-stremio');
  if (settings?.auth?.authKey) {
    return settings.auth.authKey;
  }
  const preauth = readJson('preauth_stremio');
  if (preauth?.authKey) {
    return preauth.authKey;
  }
  return null;
};

const readSimklAuth = function (): SimklStremioPairAuth | null {
  const settings = readJson('user-settings-simkl');
  const auth = settings?.auth;
  if (auth?.access_token && auth?.client_id) {
    return {
      access_token: auth.access_token,
      client_id: auth.client_id,
      refresh_token: auth.refresh_token,
      expires_at: auth.expires_at,
    };
  }
  return null;
};

/**
 * "Save Pair To Server" — registers the browser's current Stremio + Simkl
 * connections with the server-side reconciler (POST /api/pairs). The
 * reconciler then keeps Simkl in sync even while no browser is open.
 * TK's pair can also carry a Watch Together mirror Simkl connection:
 * a second device-flow sign-in captured here, labelled as the mirror
 * account (it must be a different Simkl app/account, e.g. Ange's).
 * Saving with Watch Together on makes the server snapshot the pair's
 * current watched set as the starting point; only later watches mirror.
 */
export default component$(() => {
  const pairName = useSignal('TK');
  const watchTogether = useSignal(false);
  const stremioConnected = useSignal<boolean | null>(null);
  const simklConnected = useSignal<boolean | null>(null);
  const serverPairs = useSignal<ServerPairSummary[]>([]);
  const saveMessage = useSignal('');

  const mirrorClientId = useSignal('');
  const mirrorDevice = useSignal<SimklDeviceStart | null>(null);
  const mirrorAuth = useSignal<SimklStremioPairAuth | null>(null);
  const mirrorStatus = useSignal<'idle' | 'waiting' | 'connected' | 'error'>(
    'idle',
  );
  const mirrorError = useSignal('');

  const refreshState = $(async () => {
    stremioConnected.value = !!readStremioAuthKey();
    simklConnected.value = !!readSimklAuth();
    try {
      const response = await fetch('/api/pairs');
      const data = await response.json();
      if (data?.ok) {
        serverPairs.value = data.pairs || [];
      }
    } catch {
      /**/
    }
  });

  useVisibleTask$(async () => {
    await refreshState();
  });

  const startMirrorPolling = $(async (dev: SimklDeviceStart, cid: string) => {
    const deadline = Date.now() + (dev.expires_in || 900) * 1000;
    let intervalSec = dev.interval || 5;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, intervalSec * 1000));
      const result = await pollDeviceAuth(dev.device_code, cid);
      if (result.access_token) {
        mirrorAuth.value = {
          access_token: result.access_token,
          client_id: cid,
          refresh_token: result.refresh_token,
          expires_at: result.expires_in
            ? Date.now() + result.expires_in * 1000
            : undefined,
        };
        mirrorStatus.value = 'connected';
        return;
      }
      if (result.error === 'slow_down') {
        intervalSec += 5;
        continue;
      }
      if (
        result.error === 'expired_token' ||
        result.error === 'invalid_client'
      ) {
        mirrorError.value =
          result.error === 'expired_token'
            ? 'The code expired before it was approved. Get a new code.'
            : 'Simkl rejected the Client Id. Check it and try again.';
        mirrorStatus.value = 'error';
        return;
      }
    }
    mirrorError.value = 'The code expired before it was approved. Get a new code.';
    mirrorStatus.value = 'error';
  });

  const getMirrorCode = $(async () => {
    mirrorError.value = '';
    const data = await startDeviceAuth(mirrorClientId.value);
    if ('error' in data) {
      mirrorError.value =
        'Simkl did not return a code. Check the Client Id and try again.';
      mirrorStatus.value = 'error';
      return;
    }
    mirrorDevice.value = data;
    mirrorStatus.value = 'waiting';
    await startMirrorPolling(data, mirrorClientId.value);
  });

  const savePair = $(async () => {
    saveMessage.value = '';
    const stremioAuthKey = readStremioAuthKey();
    const simkl = readSimklAuth();
    if (!stremioAuthKey) {
      saveMessage.value =
        'Connect Stremio first (the Stremio section at the top of this page).';
      return;
    }
    if (!simkl) {
      saveMessage.value =
        'Connect Simkl first (the Simkl send target on this page).';
      return;
    }
    if (!pairName.value.trim()) {
      saveMessage.value = 'Give the pair a name first.';
      return;
    }
    if (watchTogether.value && !mirrorAuth.value) {
      saveMessage.value =
        'Watch Together is on: connect the mirror Simkl account first.';
      return;
    }
    try {
      const response = await fetch('/api/pairs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: pairName.value.trim(),
          stremioAuthKey,
          simkl,
          watchTogether: watchTogether.value,
          mirrorSimkl: watchTogether.value ? mirrorAuth.value : null,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.ok) {
        saveMessage.value =
          'Pair saved. The server reconciler will keep this pair in sync from now on.';
        await refreshState();
      } else {
        saveMessage.value = `Save failed: ${data.error || response.status}`;
      }
    } catch (e) {
      saveMessage.value = `Save failed: ${(e as Error).message}`;
    }
  });

  const inputClass =
    'py-2.5 px-3 h-10 font-sans text-lg font-normal rounded-lg border transition-all focus:border-2 bg-background/20 text-on-surface outline-solid outline-0';
  const buttonClass =
    'inline-flex items-center py-1.5 px-4 text-sm font-medium text-center rounded-full border border-outline bg-primary/30';

  return (
    <div class="flex flex-col gap-4 px-4 sm:px-6 lg:px-[10%]">
      <div class="flex flex-col gap-1">
        <h2 class="font-bold text-3xl">Save Pair To Server</h2>
        <span class="text-on-surface-variant text-start max-w-full">
          Send the Stremio and Simkl connections from this browser to the
          server. The server then reconciles watched movies and episodes on
          a schedule — even while this page is closed — and nothing is ever
          removed from Simkl.
        </span>
      </div>

      <div class="flex flex-col gap-3 items-start">
        <p>
          Stremio:{' '}
          {stremioConnected.value === null
            ? 'Checking…'
            : stremioConnected.value
              ? 'Connected'
              : 'Not Connected'}
          {' · '}Simkl:{' '}
          {simklConnected.value === null
            ? 'Checking…'
            : simklConnected.value
              ? 'Connected'
              : 'Not Connected'}
        </p>

        <label class="flex flex-col gap-1">
          <span>Pair Name</span>
          <input
            type="text"
            value={pairName.value}
            placeholder="Pair Name (e.g. TK)"
            class={inputClass}
            onInput$={(event) => {
              pairName.value = (event.target as HTMLInputElement).value;
            }}
          />
        </label>

        <label class="flex flex-row gap-2 items-center">
          <input
            type="checkbox"
            checked={watchTogether.value}
            onChange$={(event) => {
              watchTogether.value = (
                event.target as HTMLInputElement
              ).checked;
            }}
          />
          <span>
            Watch Together — Also Write Things Watched From Now On To A
            Second Simkl Account
          </span>
        </label>

        {watchTogether.value && (
          <div class="flex flex-col gap-3 items-start border border-outline rounded-lg p-4">
            <h3 class="font-bold text-xl">Mirror Simkl Account</h3>
            <span class="text-on-surface-variant">
              Switching Watch Together on starts from that moment. When
              this pair is saved, the server records what has already been
              watched as the starting point. Only things watched after
              that are mirrored; nothing from before is copied. Sign in
              with the second person's Simkl app Client Id (their own app,
              created under their Simkl account).
            </span>
            {mirrorStatus.value === 'connected' ? (
              <p class="text-primary">Mirror Simkl account connected.</p>
            ) : !mirrorDevice.value ? (
              <>
                <input
                  type="text"
                  value={mirrorClientId.value}
                  placeholder="Mirror Client Id"
                  class={inputClass}
                  onInput$={(event) => {
                    mirrorClientId.value = (
                      event.target as HTMLInputElement
                    ).value;
                  }}
                />
                <button type="button" class={buttonClass} onClick$={getMirrorCode}>
                  Get Code
                </button>
              </>
            ) : (
              <>
                <input
                  type="text"
                  value={mirrorDevice.value.user_code}
                  disabled
                  class={inputClass}
                />
                <button
                  type="button"
                  class={buttonClass}
                  onClick$={() => {
                    if (mirrorDevice.value) {
                      window.open(
                        mirrorDevice.value.verification_uri_complete,
                        '_blank',
                      );
                    }
                  }}
                >
                  Validate
                </button>
                {mirrorStatus.value === 'waiting' && (
                  <p>
                    Waiting for approval on Simkl… approve there, this
                    finishes on its own.
                  </p>
                )}
              </>
            )}
            {mirrorStatus.value === 'error' && (
              <p class="text-error">{mirrorError.value}</p>
            )}
          </div>
        )}

        <button type="button" class={buttonClass} onClick$={savePair}>
          Save Pair
        </button>
        {saveMessage.value && <p>{saveMessage.value}</p>}

        {serverPairs.value.length > 0 && (
          <div class="flex flex-col gap-1">
            <h3 class="font-bold text-xl">Pairs On This Server</h3>
            {serverPairs.value.map((pair) => (
              <p key={pair.name}>
                {pair.name}
                {pair.watchTogether ? ' · Watch Together On' : ''}
                {pair.hasMirror ? ' · Mirror Connected' : ''}
                {pair.hasWatchTogetherBaseline
                  ? ` · Starting Point Saved ${pair.watchTogetherBaselineCapturedAt || ''}`
                  : ''}
                {pair.status?.needsBaseline
                  ? ' · Watch Together Paused: No Starting Point Saved'
                  : ''}
                {pair.status?.needsReauth
                  ? ' · Needs Reconnect (Simkl Token Rejected)'
                  : pair.status?.lastSuccessAt
                    ? ` · Last Reconciled ${pair.status.lastSuccessAt}`
                    : ' · Not Reconciled Yet'}
                {pair.status?.lastError && !pair.status?.needsReauth
                  ? ` · Last Error: ${pair.status.lastError}`
                  : ''}
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});
