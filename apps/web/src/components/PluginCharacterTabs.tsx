import { useEffect, useState } from 'react';
import { PuzzlePiece } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { Button, Dialog, DialogContent, Tabs } from '@neotavern/ui';
import { frontendPluginRuntime, usePluginRegistrations } from '../plugins/runtime.js';
import styles from './PluginCharacterTabs.module.css';

export function PluginCharacterTabsButton({
  characterId,
  characterName,
}: {
  characterId: string;
  characterName: string;
}) {
  const { t } = useTranslation();
  const registrations = usePluginRegistrations('characterTabs');
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const active =
    registrations.find((registration) => registration.registrationId === activeId) ??
    registrations[0];

  useEffect(() => {
    if (!open || !active || !host) return;
    return frontendPluginRuntime.mountPage(active, host, { characterId });
  }, [active, characterId, host, open]);

  if (registrations.length === 0) return null;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setActiveId((current) => current ?? registrations[0]?.registrationId ?? null);
          setOpen(true);
        }}
      >
        <PuzzlePiece aria-hidden="true" />
        {t('plugins:characterExtensions')}
      </Button>
      <DialogContent
        title={t('plugins:characterTabs')}
        description={t('plugins:characterTabsHint', { name: characterName })}
      >
        <Tabs
          variant="segment"
          className={styles.tabs}
          contentClassName={styles.host}
          ariaLabel={t('plugins:characterTabs')}
          value={active?.registrationId}
          onValueChange={setActiveId}
          tabs={registrations.map((registration) => ({
            value: registration.registrationId,
            label: registration.definition.title,
            title: registration.pluginName,
            content: (
              <div ref={setHost} data-component="plugin-character-tab" data-part="sandbox-host" />
            ),
          }))}
        />
      </DialogContent>
    </Dialog>
  );
}
