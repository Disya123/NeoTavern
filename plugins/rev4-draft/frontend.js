/**
 * Rev4 draft example (rev4 stage 3 — chat CAS + draft-commit + outbox).
 *
 * Demonstrates the server-side streaming draft contract:
 *  - `api.chats.draft.start/append/commit` (capability `chats.draft`): the
 *    sandbox streams text chunks; the host coalesces flushes at 10Hz into
 *    the server draft (an internal policy — the plugin never sees it), and
 *    `commit` materializes the final `assistant` message atomically. A
 *    crash mid-stream leaves a swept draft, never a half-written message.
 *  - `api.chats.append` with `idempotencyKey` (outbox): the same key
 *    replayed returns the original message instead of duplicating it.
 */

export default {
  async activate(api) {
    if (!api.runtime || !api.runtime.supports('ui.commands', 1)) return;
    const notify = api.notifications.show;

    await api.commands.register(
      'rev4-draft.stream',
      { title: 'Rev4 draft: stream & commit', category: 'rev4' },
      async () => {
        if (!api.chats || !api.chats.draft) return;
        const { draftId } = await api.chats.draft.start({});
        await api.chats.draft.append(draftId, 'Hello from a ');
        await new Promise(function (resolve) {
          setTimeout(resolve, 150);
        });
        await api.chats.draft.append(draftId, 'streaming draft.');
        await new Promise(function (resolve) {
          setTimeout(resolve, 150);
        });
        await api.chats.draft.append(draftId, ' Committed by rev4-draft.');
        const { messageId } = await api.chats.draft.commit(draftId);
        notify({
          title: 'Rev4 draft',
          description: 'committed ' + messageId,
          variant: 'success',
          timeoutMs: 4000,
        });
      },
      { kernel: true },
    );

    await api.commands.register(
      'rev4-draft.append',
      { title: 'Rev4 draft: idempotent append', category: 'rev4' },
      async () => {
        if (!api.chats) return;
        const first = await api.chats.append({
          content: 'outbox probe',
          idempotencyKey: 'rev4-draft-outbox-1',
        });
        const replay = await api.chats.append({
          content: 'outbox probe',
          idempotencyKey: 'rev4-draft-outbox-1',
        });
        notify({
          title: 'Rev4 draft',
          description: 'same=' + (first.messageId === replay.messageId),
          variant: 'info',
          timeoutMs: 4000,
        });
      },
      { kernel: true },
    );
  },
};
