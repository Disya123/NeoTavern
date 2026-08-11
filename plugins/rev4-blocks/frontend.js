/**
 * Rev4 message blocks example plugin (T3, apiVersion 2).
 *
 * Demonstrates the message-block lifecycle (rev4 В§G4, contract В§2 blocks.*):
 *  - `api.blocks.registerRenderer(blockType, { title, mount, serialize,
 *    restore })` вЂ” mount receives the plugin-owned clipped container and the
 *    attach descriptor and must return a cleanup function (or a promise of
 *    one); serialize/restore let the host freeze and replay renderer state
 *    when the message scrolls out of view (rev4 В§G5 overscan);
 *  - `api.blocks.attach(messageId, blockType, descriptor)` вЂ” binds an
 *    instance to a chat message; the host stores the attachment and mounts
 *    it through the overlay machinery;
 *  - explicit degradation: without `ui.messageBlock` the plugin does nothing.
 *
 * The host tracks every registration and disposes it on deactivate/uninstall.
 */

export default {
  async activate(api) {
    if (!api.runtime || !api.runtime.supports('ui.messageBlock', 1)) return;

    await api.blocks.registerRenderer('rev4-counter', {
      title: 'Rev4 counter',
      mount(container, descriptor) {
        container.style.padding = '8px';
        container.style.border = '1px dashed var(--neotavern-border, #888)';
        container.style.borderRadius = '6px';
        container.style.margin = '4px 0';
        container.setAttribute('data-state', 'mounted');

        const header = document.createElement('strong');
        header.textContent = 'rev4-counter';
        const body = document.createElement('div');
        const tick = document.createElement('button');
        tick.textContent = '++';

        const state = {
          count: descriptor && typeof descriptor.initial === 'number' ? descriptor.initial : 0,
        };
        const render = () => {
          body.textContent = 'count = ' + state.count;
        };
        render();
        tick.addEventListener('click', () => {
          state.count += 1;
          render();
        });
        container.append(header, body, tick);

        return () => {
          container.setAttribute('data-state', 'frozen');
          tick.remove();
          header.remove();
          body.remove();
        };
      },
      serialize(container) {
        const body = container.querySelector('div');
        const match = body && body.textContent ? /count = (\d+)/.exec(body.textContent) : null;
        return match ? { count: Number(match[1]) } : {};
      },
      restore(container, state) {
        const body = container.querySelector('div');
        const count = state && typeof state.count === 'number' ? state.count : 0;
        if (body) body.textContent = 'count = ' + count;
      },
    });

    const attachToLastMessage = async (api) => {
      const current = await api.chats.current();
      if (!current || !current.chatId) {
        throw new Error('no current chat');
      }
      const page = await api.chats.listMessages({});
      const last = page && page.items && page.items.length > 0 ? page.items[0] : null;
      if (!last || typeof last.id !== 'string') {
        throw new Error('no messages to attach to');
      }
      const attached = await api.blocks.attach(last.id, 'rev4-counter', {
        initial: 3,
      });
      if (api.runtime.supports('ui.notifications', 1)) {
        api.notify({
          title: 'Rev4 blocks',
          description: 'attached ' + attached.blockId + ' to ' + last.id.slice(0, 8),
          variant: 'success',
        });
      }
    };

    if (api.runtime.supports('ui.commands', 1)) {
      await api.commands.register(
        'rev4-blocks.attach',
        { title: 'Rev4 blocks: attach counter to last message', category: 'rev4' },
        () => attachToLastMessage(api),
        { kernel: true },
      );
    }
  },
};
