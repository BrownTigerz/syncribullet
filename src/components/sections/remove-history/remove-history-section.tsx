import { $, component$, useSignal, useVisibleTask$ } from '@builder.io/qwik';

interface ServerPairSummary {
  name: string;
  hasMirror: boolean;
}

/**
 * "Remove From Simkl History" — the manual undo (POST
 * /api/remove-history). Removes ONE item from a saved pair's own
 * Simkl history, or from its Watch Together mirror history. A mirror
 * removal also adds the item to the pair's Watch Together starting
 * point on the server, so the reconciler never copies it again; an
 * own removal does not touch the starting point, and an item still
 * flagged watched in Stremio will be re-added by the reconciler.
 * Deliberate and per-item: no batch form exists.
 */
export default component$(() => {
  const serverPairs = useSignal<ServerPairSummary[]>([]);
  const pairName = useSignal('');
  const target = useSignal<'own' | 'mirror'>('own');
  const imdb = useSignal('');
  const season = useSignal('');
  const episode = useSignal('');
  const resultMessage = useSignal('');
  const busy = useSignal(false);

  const refreshPairs = $(async () => {
    try {
      const response = await fetch('/api/pairs');
      const data = await response.json();
      if (data?.ok) {
        serverPairs.value = (data.pairs || []).map(
          (pair: { name: string; hasMirror?: boolean }) => ({
            name: pair.name,
            hasMirror: !!pair.hasMirror,
          }),
        );
        if (
          !serverPairs.value.some((pair) => pair.name === pairName.value)
        ) {
          pairName.value = serverPairs.value[0]?.name || '';
        }
      }
    } catch {
      /**/
    }
  });

  useVisibleTask$(async () => {
    await refreshPairs();
  });

  const mirrorAvailable = () =>
    !!serverPairs.value.find((pair) => pair.name === pairName.value)
      ?.hasMirror;

  const removeItem = $(async () => {
    resultMessage.value = '';
    const id = imdb.value.trim();
    if (!pairName.value) {
      resultMessage.value = 'Pick a pair first.';
      return;
    }
    if (!/^tt\d+$/.test(id)) {
      resultMessage.value = 'IMDb Id must look like tt0121955.';
      return;
    }
    const seasonText = season.value.trim();
    const episodeText = episode.value.trim();
    if ((seasonText === '') !== (episodeText === '')) {
      resultMessage.value =
        'Give Season and Episode together for an episode, or leave both blank for a movie.';
      return;
    }
    const body: Record<string, unknown> = {
      pairName: pairName.value,
      target: target.value,
      imdb: id,
    };
    if (seasonText !== '') {
      if (!/^\d+$/.test(seasonText) || !/^\d+$/.test(episodeText)) {
        resultMessage.value = 'Season and Episode must be whole numbers.';
        return;
      }
      body.season = parseInt(seasonText, 10);
      body.episode = parseInt(episodeText, 10);
    }
    busy.value = true;
    try {
      const response = await fetch('/api/remove-history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.ok) {
        resultMessage.value = `Removed ${data.label}. ${data.note}`;
      } else {
        resultMessage.value = `Remove failed: ${data.error || response.status}`;
      }
    } catch (e) {
      resultMessage.value = `Remove failed: ${(e as Error).message}`;
    } finally {
      busy.value = false;
    }
  });

  const inputClass =
    'py-2.5 px-3 h-10 font-sans text-lg font-normal rounded-lg border transition-all focus:border-2 bg-background/20 text-on-surface outline-solid outline-0';
  const buttonClass =
    'inline-flex items-center py-1.5 px-4 text-sm font-medium text-center rounded-full border border-outline bg-primary/30';

  return (
    <div class="flex flex-col gap-4 px-4 sm:px-6 lg:px-[10%]">
      <div class="flex flex-col gap-1">
        <h2 class="font-bold text-3xl">Remove From Simkl History</h2>
        <span class="text-on-surface-variant text-start max-w-full">
          Undo a single wrong mark — for example an episode that was
          only started, or a copy that landed on the Watch Together
          mirror by mistake. One item at a time, removed by hand;
          nothing in this build removes anything on its own. Removing
          from the mirror also adds the item to the pair's Watch
          Together starting point, so it is never copied again.
          Removing from the pair's own Simkl leaves the starting point
          alone — and if the item is still flagged watched in Stremio,
          the reconciler will add it back on its next run.
        </span>
      </div>

      {serverPairs.value.length === 0 ? (
        <p>No saved pairs on this server yet.</p>
      ) : (
        <div class="flex flex-col gap-3 items-start">
          <label class="flex flex-col gap-1">
            <span>Pair</span>
            <select
              class={inputClass}
              value={pairName.value}
              onChange$={(event) => {
                const name = (event.target as HTMLSelectElement).value;
                pairName.value = name;
                const pair = serverPairs.value.find(
                  (entry) => entry.name === name,
                );
                if (target.value === 'mirror' && !pair?.hasMirror) {
                  target.value = 'own';
                }
              }}
            >
              {serverPairs.value.map((pair) => (
                <option key={pair.name} value={pair.name}>
                  {pair.name}
                </option>
              ))}
            </select>
          </label>

          <label class="flex flex-col gap-1">
            <span>Remove From</span>
            <select
              class={inputClass}
              value={target.value}
              onChange$={(event) => {
                target.value = (event.target as HTMLSelectElement)
                  .value as 'own' | 'mirror';
              }}
            >
              <option value="own">Own Simkl</option>
              {mirrorAvailable() && (
                <option value="mirror">Mirror (Watch Together)</option>
              )}
            </select>
          </label>

          <label class="flex flex-col gap-1">
            <span>IMDb Id</span>
            <input
              type="text"
              value={imdb.value}
              placeholder="tt0121955"
              class={inputClass}
              onInput$={(event) => {
                imdb.value = (event.target as HTMLInputElement).value;
              }}
            />
          </label>

          <div class="flex flex-row gap-3">
            <label class="flex flex-col gap-1">
              <span>Season</span>
              <input
                type="text"
                value={season.value}
                placeholder="29"
                class={inputClass}
                onInput$={(event) => {
                  season.value = (event.target as HTMLInputElement).value;
                }}
              />
            </label>
            <label class="flex flex-col gap-1">
              <span>Episode</span>
              <input
                type="text"
                value={episode.value}
                placeholder="4"
                class={inputClass}
                onInput$={(event) => {
                  episode.value = (event.target as HTMLInputElement).value;
                }}
              />
            </label>
          </div>
          <span class="text-on-surface-variant">
            Leave Season and Episode both blank for a movie.
          </span>

          <button
            type="button"
            class={buttonClass}
            disabled={busy.value}
            onClick$={removeItem}
          >
            Remove
          </button>
          {resultMessage.value && <p>{resultMessage.value}</p>}
        </div>
      )}
    </div>
  );
});
