import { NavLink, useLocation, type NavLinkProps } from 'react-router-dom';
import { createSurfaceNavigationState } from './systemSurfaces.js';

/** Link that opens a system surface without unmounting the current chat. */
export function SystemSurfaceLink(props: Omit<NavLinkProps, 'state'>) {
  const location = useLocation();
  return <NavLink {...props} state={createSurfaceNavigationState(location)} />;
}
