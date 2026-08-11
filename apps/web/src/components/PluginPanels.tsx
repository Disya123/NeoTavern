import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Tabs } from '@neotavern/ui';
import {
  frontendPluginRuntime,
  usePluginRegistrations,
  type PluginRegistrationKind,
} from '../plugins/runtime.js';
import styles from './PluginPanels.module.css';

export function PluginSettingsPanels() {
  return <PluginPanelList kind="settingsPanels" variant="settings" />;
}

export function PluginSidebarPanels() {
  return <PluginPanelList kind="sidebarPanels" variant="sidebar" />;
}

function PluginPanelList({
  kind,
  variant,
}: {
  kind: Extract<PluginRegistrationKind, 'settingsPanels' | 'sidebarPanels'>;
  variant: 'settings' | 'sidebar';
}) {
  const { t } = useTranslation();
  const registrations = usePluginRegistrations(kind);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [hostNode, setHostNode] = useState<HTMLDivElement | null>(null);
  const active = registrations.find((item) => item.registrationId === activeId);
  const kernelFrame = active?.kernel
    ? frontendPluginRuntime.kernelGetFrame(active.pluginId)
    : undefined;
  const kernelSurface = active?.kernel === true;

  useEffect(() => {
    if (!active || !hostNode) return;
    if (kernelSurface && kernelFrame) {
      return frontendPluginRuntime.kernelMountSurface(kernelFrame, active.registrationId, hostNode);
    }
    return frontendPluginRuntime.mountPage(active, hostNode);
  }, [active, hostNode, kernelSurface, kernelFrame]);

  if (registrations.length === 0) return null;
  return (
    <section className={styles[variant]} data-component={`plugin-${variant}-panels`}>
      <header>
        <h2>{t(variant === 'settings' ? 'plugins:settingsPanels' : 'plugins:sidebarPanels')}</h2>
      </header>
      <Tabs
        variant="segment"
        className={styles.tabs}
        contentClassName={styles.host}
        ariaLabel={t(variant === 'settings' ? 'plugins:settingsPanels' : 'plugins:sidebarPanels')}
        value={activeId ?? ''}
        onValueChange={(value) => setActiveId((current) => (current === value ? null : value))}
        tabs={registrations.map((registration) => ({
          value: registration.registrationId,
          label: registration.definition.title,
          title: registration.pluginName,
          content: <div ref={setHostNode} data-part="sandbox-host" />,
        }))}
      />
    </section>
  );
}
