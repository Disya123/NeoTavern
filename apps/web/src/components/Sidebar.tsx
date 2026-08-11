import {
  BookOpenText,
  ChatsCircle,
  Cube,
  Globe,
  ImageSquare,
  SidebarSimple,
  SlidersHorizontal,
  Smiley,
  UsersThree,
} from '@phosphor-icons/react';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type AnimationEvent as ReactAnimationEvent,
  type ComponentType,
} from 'react';
import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { NavigationRailItemId, NavigationRailPanelItemId } from '@neotavern/theme-sdk';
import { usePlugins, useThemes } from '../api/hooks.js';
import { useUiStore, type SidebarPanelId } from '../state/ui.js';
import { ScrollArea } from '@neotavern/ui';
import styles from './Sidebar.module.css';
import { SystemSurfaceLink } from './SystemSurfaceLink.js';
import { SidebarPanelHeader } from './SidebarPanelHeader.js';
import { matchSystemSurface } from './systemSurfaces.js';
import { PluginSidebarPanels } from './PluginPanels.js';
import { SettingsPanel } from './SettingsPanel.js';
import { AiSettingsPanel as ApiBackedAiSettingsPanel } from './ai-settings/AiSettingsPanel.js';
import { CharacterManagementPanel } from './CharacterManagementPanel.js';
import { ChatManagementPanel } from './ChatManagementPanel.js';
import { PersonasPanel } from './PersonasPanel.js';
import { LorebookPanel } from './LorebookPanel.js';
import { BackgroundsPanel } from './BackgroundsPanel.js';
import { isSafeMode } from '../theme/apply.js';
import { resolveInstalledThemeShellLayout } from '../theme/navigation.js';

interface RailItem {
  themeId: NavigationRailPanelItemId;
  id: SidebarPanelId;
  labelKey: string;
  icon: ComponentType<{ size?: number; weight?: 'regular' | 'fill' | 'duotone' }>;
}

const RAIL_ITEMS: readonly RailItem[] = [
  { themeId: 'chats', id: 'home', labelKey: 'navigation:chats', icon: ChatsCircle },
  {
    themeId: 'characters',
    id: 'characters',
    labelKey: 'navigation:characters',
    icon: UsersThree,
  },
  { themeId: 'personas', id: 'personas', labelKey: 'navigation:personas', icon: Smiley },
  {
    themeId: 'lorebooks',
    id: 'lorebooks',
    labelKey: 'navigation:lorebooks',
    icon: BookOpenText,
  },
  {
    themeId: 'backgrounds',
    id: 'backgrounds',
    labelKey: 'navigation:backgrounds',
    icon: ImageSquare,
  },
  { themeId: 'ai-settings', id: 'providers', labelKey: 'settings:aiSettings', icon: Globe },
  { themeId: 'plugins', id: 'plugins', labelKey: 'navigation:plugins', icon: Cube },
  {
    themeId: 'settings',
    id: 'settings',
    labelKey: 'navigation:settings',
    icon: SlidersHorizontal,
  },
] as const;

const RAIL_ITEMS_BY_THEME_ID: ReadonlyMap<NavigationRailPanelItemId, RailItem> = new Map(
  RAIL_ITEMS.map((item) => [item.themeId, item]),
);

export function Sidebar() {
  const { t } = useTranslation();
  const sidebarOpen = useUiStore((state) => state.sidebarOpen);
  const setSidebarOpen = useUiStore((state) => state.setSidebarOpen);
  const navigationRailExpanded = useUiStore((state) => state.navigationRailExpanded);
  const setNavigationRailExpanded = useUiStore((state) => state.setNavigationRailExpanded);
  const activePanel = useUiStore((state) => state.activeSidebarPanel);
  const openSidebarPanel = useUiStore((state) => state.openSidebarPanel);
  const panelRef = useRef<HTMLElement>(null);
  const [sidebarPresent, setSidebarPresent] = useState(sidebarOpen);
  const safeMode = isSafeMode();
  const themes = useThemes(!safeMode);
  const shellLayout = useMemo(
    () => resolveInstalledThemeShellLayout(themes.data, safeMode),
    [safeMode, themes.data],
  );
  const railLayout = shellLayout.navigationRail;
  const hasMenuToggle =
    railLayout.main.includes('menu-toggle') || railLayout.bottom.includes('menu-toggle');
  const renderedMainItems = navigationRailExpanded
    ? railLayout.main
    : railLayout.main.filter((item) => item === 'menu-toggle');
  const renderedBottomItems = navigationRailExpanded
    ? railLayout.bottom
    : railLayout.bottom.filter((item) => item === 'menu-toggle');

  useLayoutEffect(() => {
    if (sidebarOpen) setSidebarPresent(true);
  }, [sidebarOpen]);

  useEffect(() => {
    document.documentElement.dataset['navigationRailState'] = navigationRailExpanded
      ? 'expanded'
      : 'collapsed';
    return () => {
      delete document.documentElement.dataset['navigationRailState'];
    };
  }, [navigationRailExpanded]);

  useEffect(() => {
    if (!hasMenuToggle && !navigationRailExpanded) setNavigationRailExpanded(true);
  }, [hasMenuToggle, navigationRailExpanded, setNavigationRailExpanded]);

  useEffect(() => {
    if (!sidebarOpen) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusFrame = requestAnimationFrame(() => {
      panelRef.current
        ?.querySelector<HTMLElement>('button:not([disabled]), a[href], input, select, textarea')
        ?.focus();
    });
    const closeOnEscape = (event: KeyboardEvent): void => {
      // A dialog or a (possibly portalled) menu owns the Escape key; closing
      // the sidebar here would hide the panel a menu was opened from.
      if (
        event.key === 'Escape' &&
        document.querySelector('[role="dialog"], [role="menu"], [role="alertdialog"]') === null
      ) {
        setSidebarOpen(false);
      }
    };
    // Capture phase: React handles Escape before this document-level listener
    // runs and synchronously unmounts the dialog/menu, so a bubbling listener
    // would always see an empty DOM and close the sidebar underneath an open
    // dialog or menu.
    document.addEventListener('keydown', closeOnEscape, true);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', closeOnEscape, true);
      if (panelRef.current?.contains(document.activeElement)) previouslyFocused?.focus();
    };
  }, [activePanel, sidebarOpen, setSidebarOpen]);

  const [isResizing, setIsResizing] = useState(false);

  const readPanelWidth = (): number => {
    const inline = document.documentElement.style.getPropertyValue('--st-shell-panel-width');
    return inline ? Number.parseFloat(inline) : 380;
  };

  const clampPanelWidth = (width: number): number => {
    const root = getComputedStyle(document.documentElement);
    const min = Number.parseFloat(root.getPropertyValue('--st-shell-panel-min-width')) || 260;
    const max = Number.parseFloat(root.getPropertyValue('--st-shell-panel-max-width')) || 720;
    return Math.min(Math.max(min, width), max);
  };

  const applyPanelWidth = (width: number): void => {
    const clamped = clampPanelWidth(width);
    document.documentElement.style.setProperty('--st-shell-panel-width', `${clamped}px`);
    localStorage.setItem('neotavern-panel-width', `${clamped}px`);
  };

  useEffect(() => {
    if (!isResizing) return;
    document.documentElement.dataset['resizingPanel'] = 'true';

    const handleMouseMove = (event: MouseEvent): void => {
      const railWidth = Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue('--shell-rail-current-width'),
      );
      applyPanelWidth(event.clientX - (Number.isFinite(railWidth) ? railWidth : 0));
    };
    const handleMouseUp = (): void => {
      setIsResizing(false);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      delete document.documentElement.dataset['resizingPanel'];
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing]);

  useEffect(() => {
    const saved = localStorage.getItem('neotavern-panel-width');
    if (saved) {
      document.documentElement.style.setProperty('--st-shell-panel-width', saved);
    }
  }, []);

  const openPanel = (panel: SidebarPanelId): void => {
    if (sidebarOpen && activePanel === panel) {
      setSidebarOpen(false);
      return;
    }
    openSidebarPanel(panel);
  };

  const finishSidebarExit = (event: ReactAnimationEvent<HTMLElement>): void => {
    if (event.target === event.currentTarget && !sidebarOpen) setSidebarPresent(false);
  };

  const activeItem = RAIL_ITEMS.find((item) => item.id === activePanel);

  const renderRailItem = (itemId: NavigationRailItemId, group: 'main' | 'bottom') => {
    if (itemId === 'menu-toggle') {
      const label = t(
        navigationRailExpanded ? 'accessibility:closeMenu' : 'accessibility:openMenu',
      );
      return (
        <span
          key={itemId}
          className={styles.railItem}
          data-part="item"
          data-item={itemId}
          data-group={group}
        >
          <button
            type="button"
            className={styles.railButton}
            data-part="item-control"
            data-action="menu-toggle"
            data-state={navigationRailExpanded ? 'expanded' : 'collapsed'}
            onClick={() => {
              if (navigationRailExpanded) setSidebarOpen(false);
              setNavigationRailExpanded(!navigationRailExpanded);
            }}
            aria-label={label}
            title={label}
            aria-expanded={navigationRailExpanded}
            aria-controls="primary-navigation"
          >
            <SidebarSimple size={21} aria-hidden="true" />
            <span className={styles.railLabel}>{label}</span>
          </button>
        </span>
      );
    }

    const item = RAIL_ITEMS_BY_THEME_ID.get(itemId);
    if (!item) return null;
    const { id, labelKey, icon: Icon } = item;
    const selected = sidebarOpen && activePanel === id;
    return (
      <span
        key={itemId}
        className={styles.railItem}
        data-part="item"
        data-item={itemId}
        data-group={group}
      >
        <button
          type="button"
          className={selected ? styles.railButtonActive : styles.railButton}
          data-part="item-control"
          data-state={selected ? 'active' : 'inactive'}
          onClick={() => openPanel(id)}
          aria-label={t(labelKey)}
          title={t(labelKey)}
          aria-expanded={selected}
          aria-controls="navigation-context-panel"
        >
          <Icon size={21} aria-hidden="true" />
          <span className={styles.railLabel}>{t(labelKey)}</span>
        </button>
      </span>
    );
  };

  return (
    <aside
      className={styles.sidebar}
      data-component="navigation-rail"
      data-state={navigationRailExpanded ? 'expanded' : 'collapsed'}
    >
      <nav
        id="primary-navigation"
        className={styles.rail}
        data-slot="navigation.primary"
        data-state={navigationRailExpanded ? 'expanded' : 'collapsed'}
        data-has-menu-toggle={hasMenuToggle ? 'true' : 'false'}
        data-leading-menu-toggle={railLayout.main[0] === 'menu-toggle' ? 'true' : 'false'}
        aria-label={t('accessibility:mainNavigation')}
      >
        {renderedMainItems.length > 0 ? (
          <div className={styles.railMain} data-part="main-items">
            {renderedMainItems.map((item) => renderRailItem(item, 'main'))}
          </div>
        ) : null}
        {renderedBottomItems.length > 0 ? (
          <div className={styles.railBottom} data-part="bottom-items">
            {renderedBottomItems.map((item) => renderRailItem(item, 'bottom'))}
          </div>
        ) : null}
      </nav>
      {sidebarPresent ? (
        <>
          <button
            type="button"
            className={styles.backdrop}
            data-part="panel-backdrop"
            data-state={sidebarOpen ? 'open' : 'closing'}
            onClick={() => setSidebarOpen(false)}
            aria-label={t('accessibility:closeMenu')}
            aria-hidden={!sidebarOpen}
            inert={!sidebarOpen}
          />

          <section
            ref={panelRef}
            id="navigation-context-panel"
            className={styles.panelOpen}
            data-component="navigation-panel"
            data-state={sidebarOpen ? 'open' : 'closing'}
            data-panel={activePanel}
            data-slot="panel.left"
            data-management-tabs-pinned={shellLayout.managementTabs.pinned ? 'true' : 'false'}
            aria-label={t(activeItem?.labelKey ?? 'navigation:home')}
            aria-hidden={!sidebarOpen}
            inert={!sidebarOpen}
            onAnimationEnd={finishSidebarExit}
          >
            {activePanel === 'characters' ? (
              <CharacterManagementPanel onClose={() => setSidebarOpen(false)} />
            ) : activePanel === 'home' ? (
              <ChatManagementPanel onClose={() => setSidebarOpen(false)} />
            ) : activePanel === 'personas' ? (
              <PersonasPanel onClose={() => setSidebarOpen(false)} />
            ) : activePanel === 'lorebooks' ? (
              <LorebookPanel onClose={() => setSidebarOpen(false)} />
            ) : activePanel === 'backgrounds' ? (
              <BackgroundsPanel onClose={() => setSidebarOpen(false)} />
            ) : activePanel === 'providers' ? (
              <ApiBackedAiSettingsPanel onClose={() => setSidebarOpen(false)} />
            ) : activePanel === 'settings' ? (
              <SettingsPanel onClose={() => setSidebarOpen(false)} />
            ) : (
              <>
                <SidebarPanelHeader
                  title={t(activeItem?.labelKey ?? 'navigation:home')}
                  onClose={() => setSidebarOpen(false)}
                />

                <ScrollArea className={styles.panelBody}>
                  <div className={styles.panelBodyContent}>
                    <PanelContent panel={activePanel} />
                  </div>
                </ScrollArea>
              </>
            )}

            <button
              type="button"
              className={styles.resizeHandle}
              aria-label={t('navigation:resizeHint')}
              title={t('navigation:resizeHint')}
              onMouseDown={(event) => {
                event.preventDefault();
                setIsResizing(true);
              }}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                event.preventDefault();
                const delta = event.key === 'ArrowRight' ? 20 : -20;
                applyPanelWidth(readPanelWidth() + delta);
              }}
            />
          </section>
        </>
      ) : null}
    </aside>
  );
}

function PanelContent({ panel }: { panel: SidebarPanelId }) {
  switch (panel) {
    case 'plugins':
      return <PluginsPanel />;
    default:
      return null;
  }
}

function PluginsPanel() {
  const { t } = useTranslation();
  const plugins = usePlugins();

  return (
    <div className={styles.compactPanel}>
      <NavItem to="/plugins" labelKey="navigation:plugins" icon={Cube} />
      {(plugins.data?.items ?? []).length === 0 ? (
        <p className={styles.emptyText}>{t('plugins:emptyHint')}</p>
      ) : (
        <ul className={styles.statusList}>
          {(plugins.data?.items ?? []).map((plugin) => (
            <li key={plugin.id}>
              <span>{plugin.name}</span>
              <strong data-state={plugin.status}>{t(`plugins:status_${plugin.status}`)}</strong>
            </li>
          ))}
        </ul>
      )}
      <PluginSidebarPanels />
    </div>
  );
}

function NavItem({
  to,
  labelKey,
  icon: Icon,
}: {
  to: string;
  labelKey: string;
  icon: ComponentType<{ size?: number; weight?: 'regular' | 'fill' | 'duotone' }>;
}) {
  const { t } = useTranslation();
  const className = ({ isActive }: { isActive: boolean }) =>
    isActive ? styles.linkActive : styles.link;
  const content = (
    <>
      <Icon size={20} aria-hidden="true" />
      <span>{t(labelKey)}</span>
    </>
  );

  return matchSystemSurface(to) ? (
    <SystemSurfaceLink to={to} className={className}>
      {content}
    </SystemSurfaceLink>
  ) : (
    <NavLink to={to} className={className}>
      {content}
    </NavLink>
  );
}
