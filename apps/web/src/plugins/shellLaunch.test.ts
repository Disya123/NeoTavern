import { afterEach, describe, expect, it } from 'vitest';
import { canReplaceShell, launchShell } from './shellLaunch.js';
import { shellMode } from './shellMode.js';

const manifest = { runtime: { host: 'sandbox', ui: 'shell' } };

afterEach(() => shellMode.restore());

describe('shell launch', () => {
  it('hands the window over only when the grant exists', () => {
    expect(canReplaceShell({ id: 'a', manifest, grantedPermissions: [] })).toBe(false);
    expect(canReplaceShell({ id: 'a', manifest, grantedPermissions: ['ui.shell.replace'] })).toBe(
      true,
    );
  });

  it('refuses a plugin that did not declare the shell surface', () => {
    expect(
      canReplaceShell({
        id: 'a',
        manifest: { runtime: { ui: 'panel' } },
        grantedPermissions: ['ui.shell.replace'],
      }),
    ).toBe(false);
    expect(
      launchShell({
        id: 'a',
        manifest: { runtime: { ui: 'panel' } },
        grantedPermissions: ['ui.shell.replace'],
      }),
    ).toBe(false);
    expect(shellMode.activePluginId()).toBeNull();
  });

  it('actually replaces the shell when both conditions hold', () => {
    expect(
      launchShell({ id: 'author.shell', manifest, grantedPermissions: ['ui.shell.replace'] }),
    ).toBe(true);
    expect(shellMode.activePluginId()).toBe('author.shell');
  });

  it('treats a missing manifest as no surface at all', () => {
    expect(
      canReplaceShell({ id: 'a', manifest: null, grantedPermissions: ['ui.shell.replace'] }),
    ).toBe(false);
  });
});
