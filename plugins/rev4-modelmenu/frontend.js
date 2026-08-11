/**
 * Rev4 model menu example plugin (T3, apiVersion 2).
 *
 * Demonstrates the rev4 models surface only:
 *  - `api.models.list(providerId?)` — provider model discovery; an omitted
 *    providerId resolves to the active provider on the host;
 *  - `api.ui.modelMenu(container, options)` — a ready-to-use model picker
 *    (searchable list + load action + status line) mounted into a settings
 *    panel; every pick is echoed to `document.documentElement.dataset` so
 *    the e2e can observe it through the opaque iframe boundary.
 *
 * The settings panel registration is host-tracked; the host disposes the
 * registration and the widget on deactivate/uninstall, so the plugin keeps
 * no cleanup state of its own beyond the widget handle.
 */

export default {
  async activate(api) {
    // Explicit degradation (rev4 invariant 8): no silent fallback.
    if (!api.runtime || !api.runtime.supports('models.list', 1)) return;

    api.ui.settingsPanels.register({
      id: 'rev4-modelmenu-panel',
      title: 'Model menu',
      mount(root) {
        const host = document.createElement('div');
        root.append(host);
        const handle = api.ui.modelMenu(host, {
          value: 'echo',
          ariaLabel: 'Model',
          onValueChange(value) {
            document.documentElement.dataset.modelMenuValue = value;
          },
        });
        return () => {
          handle.dispose();
          host.remove();
        };
      },
    });
  },
};
