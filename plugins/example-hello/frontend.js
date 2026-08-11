/**
 * Example frontend plugin (ТЗ §7.2). Demonstrates the registration API:
 * a toolbar action, a command-palette entry and a slash command. Every
 * register() call returns a cleanup the host applies on deactivate — the
 * plugin keeps no state of its own.
 */
export default {
  activate(api) {
    api.ui.toolbarActions.register({
      id: 'hello',
      title: () => 'Say hello (example plugin)',
      run() {
        api.notify({
          title: 'Hello from NeoTavern!',
          description: 'Toolbar action registered by neotavern.example-hello.',
          variant: 'info',
        });
      },
    });

    api.ui.commands.register({
      id: 'hello',
      title: () => 'Example: say hello',
      run() {
        api.notify({ title: 'Hello from the command palette', variant: 'success' });
      },
    });

    api.slash.register({
      name: 'hello',
      description: 'Say hello from the example plugin',
      run(args) {
        api.notify({
          title: args.trim().length > 0 ? `Hello, ${args.trim()}!` : 'Hello!',
          variant: 'success',
        });
      },
    });
  },
};
