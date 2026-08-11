import { useTranslation } from 'react-i18next';
import { CharactersPage } from '../pages/CharactersPage.js';
import { ChatsPage } from '../pages/ChatsPage.js';
import { PluginSurfacePage } from '../pages/PluginSurfacePage.js';
import { PluginsPage } from '../pages/PluginsPage.js';
import { ProvidersPage } from '../pages/ProvidersPage.js';
import { ThemesPage } from '../pages/ThemesPage.js';
import { SurfaceDialog } from './SurfaceDialog.js';
import type { SystemSurfaceMatch } from './systemSurfaces.js';

export interface SystemSurfaceProps {
  match: SystemSurfaceMatch;
  onClose: () => void;
}

/** Route-aware modal layer. Chat remains mounted behind every system tool. */
export function SystemSurface({ match, onClose }: SystemSurfaceProps) {
  const { t } = useTranslation();
  return (
    <SurfaceDialog
      open
      surface={match.id}
      title={t(match.definition.labelKey)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SurfaceContent match={match} />
    </SurfaceDialog>
  );
}

function SurfaceContent({ match }: { match: SystemSurfaceMatch }) {
  switch (match.id) {
    case 'characters':
      return <CharactersPage />;
    case 'chats':
      return <ChatsPage />;
    case 'providers':
      return <ProvidersPage />;
    case 'themes':
      return <ThemesPage />;
    case 'plugins':
      return <PluginsPage />;
    case 'plugin':
      return <PluginSurfacePage pluginId={match.pluginId} path={match.pluginPath} />;
  }
}
