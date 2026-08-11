/**
 * Rev4 translate action example plugin (T3, apiVersion 2).
 *
 * Demonstrates the message-actions surface contract only:
 *  - a 'messageActions' surface registered over the kernel port with the
 *    v2 definition fields (icon, order, placement);
 *  - the runner receives the message snapshot (`context.message`) whose
 *    `content` is gated per-plugin by the `chat.read` permission;
 *  - `context.signal` aborts when the host tears the action down.
 *
 * The mock "translation" prefixes the message text and reports it through
 * `api.notify` — no external service is called. The registration is
 * host-tracked; the host disposes it on deactivate/uninstall.
 */

export default {
  async activate(api) {
    // Explicit degradation (rev4 invariant 8): no silent fallback.
    if (!api.runtime || !api.runtime.supports('ui.surfaces', 1)) return;

    await api.surfaces.register(
      'messageActions',
      {
        id: 'rev4-translate',
        title: 'Translate',
        icon: 'translate',
        order: 90,
        placement: 'primary',
      },
      async function (context) {
        const text = context.message && context.message.content;
        if (typeof text !== 'string' || text.length === 0) return;
        // No external service: demonstrate the message-content contract.
        const mock = '[TR] ' + text.slice(0, 400);
        api.notify({
          title: 'Translate',
          description: mock,
          variant: 'info',
          timeoutMs: 6000,
        });
      },
      { kernel: true },
    );
  },
};
