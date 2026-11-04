import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { PluginConsentDialog } from './PluginConsentDialog.js';
import type { PluginManifest } from '@neotavern/plugin-sdk';

const manifest: PluginManifest = {
  id: 'author.vtuber',
  name: 'AI VTuber',
  version: '2.0.0',
  apiVersion: 3,
  requiredCapabilities: [
    { name: 'network.domains' },
    { name: 'native.process' },
    { name: 'microphone.request' },
  ],
};

afterEach(() => cleanup());

describe('PluginConsentDialog', () => {
  it('lists grants most dangerous first, with the reason', () => {
    render(<PluginConsentDialog manifest={manifest} onDecide={() => {}} />);
    const items = screen.getAllByRole('listitem');
    expect(items.map((item) => item.getAttribute('data-capability'))).toEqual([
      'native.process',
      'microphone.request',
      'network.domains',
    ]);
    expect(items[0]).toHaveAttribute('data-risk', 'critical');
    expect(screen.getByText('plugins:consentNativeProcessWhy')).toBeInTheDocument();
  });

  it('names the package and its version', () => {
    render(<PluginConsentDialog manifest={manifest} onDecide={() => {}} />);
    expect(screen.getByText('AI VTuber 2.0.0')).toBeInTheDocument();
  });

  it('reports the decision without installing anything itself', async () => {
    const decide = vi.fn();
    render(<PluginConsentDialog manifest={manifest} onDecide={decide} />);
    await userEvent.click(screen.getByRole('button', { name: 'plugins:consentCancel' }));
    await userEvent.click(screen.getByRole('button', { name: 'plugins:consentAccept' }));
    expect(decide.mock.calls).toEqual([[false], [true]]);
  });

  it('shows nothing to consent to when the package asks for nothing risky', () => {
    render(
      <PluginConsentDialog
        manifest={{ ...manifest, requiredCapabilities: [{ name: 'storage.user' }] }}
        onDecide={() => {}}
      />,
    );
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    // The dialog still appears: the user sees a package with no dangerous grants.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
