import { $, component$, useSignal, useTask$ } from '@builder.io/qwik';
import { Link, server$ } from '@builder.io/qwik-city';

import { useForm } from '@modular-forms/qwik';
import type { SubmitHandler } from '@modular-forms/qwik';

import type {
  ApiClientCodeForm,
  ApiClientForm,
} from '~/components/sections/configure';

import { preauthString } from '~/utils/auth/preauth';
import { Receivers } from '~/utils/receiver/types/receivers';
import { SimklClientReceiver } from '~/utils/receivers/simkl/recevier-client';
import type { SimklPreAuth } from '~/utils/receivers/simkl/types/auth';

export interface SimklDeviceStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface SimklTokenResult {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
}

const SIMKL_USER_AGENT = 'syncribullet/2.0';

const resolveClientId = function (
  env: { get: (key: string) => string | undefined },
  client_id?: string,
) {
  return client_id || env.get('PRIVATE_SIMKL_CLIENT_ID') || '';
};

/**
 * Start the Simkl AUTH V2 device flow (POST /oauth2/device).
 * See docs/SIMKL_AUTH.md. No secret and no redirect URI are involved.
 */
export const startDeviceAuth = server$(
  async function (client_id?: string): Promise<SimklDeviceStart | { error: string }> {
    const resolved = resolveClientId(this.env, client_id);
    if (!resolved) {
      return { error: 'No Client Id provided' };
    }
    try {
      const data = await fetch('https://api.simkl.com/oauth2/device', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': SIMKL_USER_AGENT,
        },
        body: new URLSearchParams({
          client_id: resolved,
          scope: 'media:read media:write',
        }),
      });
      return await data.json();
    } catch {
      return { error: 'Could not reach the Simkl API' };
    }
  },
);

/**
 * One poll of the device-flow token endpoint (POST /oauth2/token).
 * Returns the token response on success, or { error } with one of
 * authorization_pending / slow_down / expired_token / invalid_client.
 */
export const pollDeviceAuth = server$(
  async function (
    device_code: string,
    client_id?: string,
  ): Promise<SimklTokenResult> {
    const resolved = resolveClientId(this.env, client_id);
    if (!resolved) {
      return { error: 'invalid_client' };
    }
    try {
      const data = await fetch('https://api.simkl.com/oauth2/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': SIMKL_USER_AGENT,
        },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          client_id: resolved,
          device_code,
        }),
      });
      return await data.json();
    } catch {
      return { error: 'network_error' };
    }
  },
);

export default component$(() => {
  const [, { Form, Field }] = useForm<ApiClientForm>({
    loader: useSignal({
      client_id: '',
    }),
  });

  const client_id = useSignal<string | boolean>(false);
  const device = useSignal<SimklDeviceStart | null>(null);
  const status = useSignal<'idle' | 'waiting' | 'connected' | 'error'>(
    'idle',
  );
  const errorText = useSignal('');

  const [, { Form: FormCode, Field: FieldCode }] =
    useForm<ApiClientCodeForm>({
      loader: useSignal({ user_code: '' }),
    });

  const startPolling = $(async (dev: SimklDeviceStart, cid: string) => {
    const deadline = Date.now() + (dev.expires_in || 900) * 1000;
    let intervalSec = dev.interval || 5;
    while (Date.now() < deadline) {
      await new Promise((resolve) =>
        setTimeout(resolve, intervalSec * 1000),
      );
      const result = await pollDeviceAuth(dev.device_code, cid);
      if (result.access_token) {
        const receiver = new SimklClientReceiver();
        receiver.mergeUserConfig({
          auth: {
            access_token: result.access_token,
            client_id: cid,
            refresh_token: result.refresh_token,
            expires_at: result.expires_in
              ? Date.now() + result.expires_in * 1000
              : undefined,
          },
        });
        localStorage.removeItem(preauthString(Receivers.SIMKL));
        status.value = 'connected';
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
        errorText.value =
          result.error === 'expired_token'
            ? 'The code expired before it was approved. Get a new code.'
            : 'Simkl rejected the Client Id. Check it and try again.';
        status.value = 'error';
        return;
      }
      // authorization_pending / network_error: keep polling.
    }
    errorText.value = 'The code expired before it was approved. Get a new code.';
    status.value = 'error';
  });

  const beginFlow = $(async (start: SimklDeviceStart, cid: string) => {
    device.value = start;
    client_id.value = cid || true;
    localStorage.setItem(
      preauthString(Receivers.SIMKL),
      JSON.stringify({
        device_code: start.device_code,
        user_code: start.user_code,
        client_id: cid,
      } as SimklPreAuth),
    );
    status.value = 'waiting';
    await startPolling(start, cid);
  });

  useTask$(async () => {
    if (!client_id.value) {
      try {
        const data = await startDeviceAuth();
        if ('user_code' in data && data.user_code) {
          await beginFlow(data, '');
        }
      } catch {
        /**/
      }
    }
  });

  const handleSubmit = $<SubmitHandler<ApiClientForm>>(async (values) => {
    const data = await startDeviceAuth(values.client_id);
    if ('error' in data) {
      errorText.value =
        'Simkl did not return a code. Check the Client Id and try again.';
      status.value = 'error';
      return;
    }
    await beginFlow(data, values.client_id);
  });

  return (
    <>
      {status.value === 'connected' ? (
        <p class="text-primary">Simkl connected.</p>
      ) : !client_id.value ? (
        <Form onSubmit$={handleSubmit}>
          <div class="flex flex-col gap-4 items-center">
            <p>
              <Link
                href="https://simkl.com/settings/developer/new/"
                class="text-primary"
                target="_blank"
              >
                Create an app
              </Link>{' '}
              (an AUTH V2 app is fine — no redirect URI is needed for this
              sign-in) and paste its Client Id here.
            </p>
            <Field name="client_id">
              {(field, props) => (
                <input
                  {...props}
                  type="text"
                  value={field.value}
                  placeholder="Client Id"
                  class="py-2.5 px-3 h-10 font-sans text-lg font-normal rounded-lg border transition-all focus:border-2 bg-background/20 text-on-surface outline-solid outline-0"
                />
              )}
            </Field>
            <button
              type="submit"
              class={`inline-flex items-center py-1.5 px-4 text-sm font-medium text-center rounded-full border border-outline bg-primary/30`}
            >
              Get Code
            </button>
            {status.value === 'error' && (
              <p class="text-error">{errorText.value}</p>
            )}
          </div>
        </Form>
      ) : (
        <FormCode>
          <div class="flex flex-col gap-4 items-center">
            <FieldCode name="user_code">
              {(_field, props) => (
                <input
                  {...props}
                  type="text"
                  value={device.value?.user_code || ''}
                  disabled
                  placeholder="Copy Code"
                  class="py-2.5 px-3 w-full h-10 font-sans text-lg font-normal rounded-lg border transition-all focus:border-2 bg-background/20 text-on-surface outline-solid outline-0"
                />
              )}
            </FieldCode>
            <button
              type="button"
              class={`inline-flex items-center py-1.5 px-4 text-sm font-medium text-center rounded-full border border-outline bg-primary/30`}
              onClick$={() => {
                if (device.value) {
                  window.open(
                    device.value.verification_uri_complete ||
                      `${device.value.verification_uri}?user_code=${device.value.user_code}`,
                    '_blank',
                  );
                }
              }}
            >
              Validate
            </button>
            {status.value === 'waiting' && (
              <p>
                Waiting for approval on Simkl… approve there, this page
                finishes on its own.
              </p>
            )}
            {status.value === 'error' && (
              <p class="text-error">{errorText.value}</p>
            )}
          </div>
        </FormCode>
      )}
    </>
  );
});
