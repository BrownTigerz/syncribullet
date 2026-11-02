import { component$, useVisibleTask$ } from '@builder.io/qwik';
import { useNavigate } from '@builder.io/qwik-city';

import { pollDeviceAuth } from '~/components/forms/simkl-login';
import { preauthString } from '~/utils/auth/preauth';
import { SimklClientReceiver } from '~/utils/receivers/simkl/recevier-client';
import type { SimklPreAuth } from '~/utils/receivers/simkl/types/auth';

/**
 * Fallback completion page for the Simkl AUTH V2 device flow.
 *
 * The device flow has no redirect back from Simkl, so the configure page
 * normally finishes the connection by polling on its own. If the user
 * lands here with a pending preauth (for example by opening the return
 * address manually), claim the token here instead.
 */
export default component$(() => {
  const nav = useNavigate();
  useVisibleTask$(async () => {
    const simklReceiver = new SimklClientReceiver();
    const preAuthId = preauthString(simklReceiver.receiverInfo.id);

    let parsedPreAuth: SimklPreAuth | null = null;
    try {
      const preAuth = window.localStorage.getItem(preAuthId);
      if (preAuth) {
        parsedPreAuth = JSON.parse(preAuth);
      }
    } catch (e) {
      console.error(e);
    }

    if (!parsedPreAuth?.device_code) {
      nav('/');
      return;
    }

    const deadline = Date.now() + 2 * 60 * 1000;
    let intervalMs = 5000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      const result = await pollDeviceAuth(
        parsedPreAuth.device_code,
        parsedPreAuth.client_id,
      );
      if (result.access_token) {
        simklReceiver.mergeUserConfig({
          auth: {
            access_token: result.access_token,
            client_id: parsedPreAuth.client_id || '',
            refresh_token: result.refresh_token,
            expires_at: result.expires_in
              ? Date.now() + result.expires_in * 1000
              : undefined,
          },
        });
        window.localStorage.removeItem(preAuthId);
        nav('/');
        return;
      }
      if (result.error === 'slow_down') {
        intervalMs += 5000;
        continue;
      }
      if (
        result.error === 'expired_token' ||
        result.error === 'invalid_client'
      ) {
        window.localStorage.removeItem(preAuthId);
        nav('/');
        return;
      }
    }
    // Still pending: leave the preauth in place; the configure page's own
    // polling can still complete the connection.
    nav('/');
  });
  return <></>;
});
