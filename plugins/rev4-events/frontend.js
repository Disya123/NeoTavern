/**
 * Rev4 events example plugin (T3, apiVersion 2) — rev4 §J1.
 *
 * Demonstrates the async-iterator event stream with cursor replay:
 *  - `api.events.subscribe(event, {cursor})` returns an async iterator of
 *    `{payload, event, eventId, cursor, sequence}` envelopes;
 *  - the host retains a bounded ring buffer of app events, so resubscribing
 *    with the cursor of the last handled event replays everything that was
 *    missed — at-least-once recovery after a dropped subscription;
 *  - the iterator acks each handled event when the consumer asks for the
 *    next one; a slow consumer pauses delivery (backpressure) and resumes
 *    when acks catch up.
 *
 * The plugin subscribes to `chat.opened` (no capability required), logs
 * every received event to a persistent KV list, and exposes three commands:
 *  - `rev4-events.drop` — closes the stream (keeps the last cursor);
 *  - `rev4-events.replay` — reopens the stream at the saved cursor: the
 *    missed events arrive tagged `(replay)`;
 *  - `rev4-events.log` — shows the last seen entries.
 */

const SEEN_KEY = 'events.seen';
const MAX_LOG_ENTRIES = 32;

const plugin = {
  async activate(api) {
    const kv = api.storage && api.storage.kv;
    const notify = api.notifications && api.notifications.show;

    let iterator = null;
    let replaying = false;
    let replayTimer = null;
    let lastCursor = null;

    const appendSeen = async (entry) => {
      if (!kv) return;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const current = await kv.get('user', SEEN_KEY).catch(() => null);
        const log = Array.isArray(current && current.value) ? current.value : [];
        log.push(entry);
        while (log.length > MAX_LOG_ENTRIES) log.shift();
        try {
          await kv.set(
            'user',
            SEEN_KEY,
            log,
            current && typeof current.revision === 'number' ? current.revision : undefined,
          );
          return;
        } catch (error) {
          if (!error || error.code !== 'REVISION_CONFLICT' || attempt === 2) throw error;
        }
      }
    };

    const consume = async () => {
      try {
        for await (const event of iterator) {
          lastCursor = event.cursor;
          await appendSeen({
            name: event.event,
            seq: event.sequence,
            cursor: event.cursor,
            source: replaying ? 'replay' : 'live',
            at: Date.now(),
          });
        }
      } catch {
        // Stream closed (return()/abort/session teardown) — nothing to do.
      }
    };

    const openStream = (cursor) => {
      if (iterator) return;
      iterator = api.events.subscribe('chat.opened', cursor == null ? {} : { cursor });
      consume();
    };

    openStream();

    await api.commands.register(
      'rev4-events.drop',
      { title: 'Rev4 events: drop the stream', category: 'rev4' },
      async () => {
        if (!iterator) return;
        const toClose = iterator;
        iterator = null;
        await toClose.return();
      },
      { kernel: true },
    );

    await api.commands.register(
      'rev4-events.replay',
      { title: 'Rev4 events: resume with cursor replay', category: 'rev4' },
      async () => {
        if (iterator) {
          const toClose = iterator;
          iterator = null;
          await toClose.return();
        }
        const cursor = lastCursor;
        replaying = true;
        openStream(cursor);
        clearTimeout(replayTimer);
        replayTimer = setTimeout(() => {
          replaying = false;
        }, 2000);
      },
      { kernel: true },
    );

    await api.commands.register(
      'rev4-events.log',
      { title: 'Rev4 events: show seen log', category: 'rev4' },
      async () => {
        const current = await kv.get('user', SEEN_KEY).catch(() => null);
        const log = Array.isArray(current && current.value) ? current.value : [];
        const summary =
          log.length === 0
            ? '(none)'
            : log
                .slice(-4)
                .map((entry) => `${entry.name} #${entry.seq} (${entry.source})`)
                .join(' | ');
        if (notify) {
          notify({
            title: 'Rev4 events',
            description: `seen: ${summary}`,
            variant: 'info',
            timeoutMs: 8000,
          });
        }
      },
      { kernel: true },
    );

    plugin.deactivate = () => {
      clearTimeout(replayTimer);
      if (iterator) {
        const toClose = iterator;
        iterator = null;
        void toClose.return();
      }
    };
  },

  // The per-activation closure installs the stream; this placeholder keeps
  // the plugin definition valid before activate() runs.
  async deactivate() {},
};

export default plugin;
