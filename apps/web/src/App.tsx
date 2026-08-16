/** Root router. System tools are modal routes above the persistent chat workspace. */
import { useEffect, useState, type ReactNode } from 'react';
import { IconContext } from '@phosphor-icons/react';
import {
  BrowserRouter,
  HashRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom';
import type { Location } from 'react-router-dom';
import { AppShell } from './components/AppShell.js';
import { AuthGate } from './components/AuthGate.js';
import { AutoConnectSync } from './components/AutoConnectSync.js';
import { LegacyBridgeSync } from './components/LegacyBridgeSync.js';
import { PluginSync } from './components/PluginSync.js';
import { PluginProviderSync } from './components/PluginProviderSync.js';
import { SystemSurface } from './components/SystemSurface.js';
import { getBackgroundLocation, matchSystemSurface } from './components/systemSurfaces.js';
import { PluginAuthResult } from './components/PluginAuthResult.js';
import { ThemeSync } from './components/ThemeSync.js';
import { HostConnect } from './components/HostConnect.js';
import { ChatPage } from './pages/ChatPage.js';
import { HomePage } from './pages/HomePage.js';
import { useUiStore } from './state/ui.js';
import { usesHashRouting } from './lib/routing.js';

function AppRouter({ children }: { children: ReactNode }) {
  if (usesHashRouting()) {
    return <HashRouter>{children}</HashRouter>;
  }
  return <BrowserRouter>{children}</BrowserRouter>;
}

export function App() {
  return (
    <IconContext.Provider value={{ size: 16 }}>
      <AppRouter>
        <ThemeSync />
        <HostConnect>
          <AuthGate>
            <PluginSync />
            <PluginProviderSync />
            <LegacyBridgeSync />
            <AutoConnectSync />
            <AppRoutes />
          </AuthGate>
        </HostConnect>
      </AppRouter>
    </IconContext.Provider>
  );
}

function AppRoutes() {
  const location = useLocation();
  const navigate = useNavigate();
  const openHomeOnLoad = useUiStore((state) => state.openHomeOnLoad);
  const [startupRedirectPending, setStartupRedirectPending] = useState(true);

  useEffect(() => {
    setStartupRedirectPending(false);
  }, []);

  // The OAuth callback redirects the popup to `#/plugin-auth-result?...`;
  // it is a standalone screen (no chat workspace, no shell chrome).
  if (location.hash.startsWith('#/plugin-auth-result')) {
    return <PluginAuthResult hash={location.hash} />;
  }
  const surface = matchSystemSurface(location.pathname);

  const startupHomeTarget = startupRedirectPending
    ? getStartupHomeTarget(location, openHomeOnLoad)
    : null;
  if (startupHomeTarget) {
    return <Navigate to={startupHomeTarget} replace />;
  }

  const backgroundLocation = getBackgroundLocation(location);
  const workspaceLocation = surface
    ? (backgroundLocation ?? createHomeLocation(location))
    : location;

  return (
    <>
      <Routes location={workspaceLocation}>
        <Route element={<AppShell />}>
          <Route index element={<Navigate to="/home" replace />} />
          <Route path="home" element={<HomePage />} />
          <Route path="chats/:chatId" element={<ChatPage />} />
          <Route path="*" element={<Navigate to="/home" replace />} />
        </Route>
      </Routes>
      {surface ? (
        <SystemSurface
          match={surface}
          onClose={() => {
            if (!backgroundLocation) {
              navigate('/home', { replace: true });
              return;
            }
            navigate(
              `${backgroundLocation.pathname}${backgroundLocation.search}${backgroundLocation.hash}`,
              { replace: true, state: backgroundLocation.state },
            );
          }}
        />
      ) : null}
    </>
  );
}

function createHomeLocation(location: Location): Location {
  return {
    ...location,
    pathname: '/home',
    search: '',
    hash: '',
    state: null,
    key: 'system-surface-home',
  };
}

export function getStartupHomeTarget(
  location: Pick<Location, 'pathname' | 'search' | 'hash'>,
  enabled: boolean,
): { pathname: '/home'; search: string; hash: string } | null {
  // The redirect applies to the bare app entry only. A deep link
  // (`/chats/:id`, a system surface, an OAuth result) is explicit intent and
  // must not be hijacked — the index route already lands on /home.
  if (!enabled || (location.pathname !== '/' && location.pathname !== '')) return null;
  return {
    pathname: '/home',
    search: location.search,
    hash: location.hash,
  };
}
