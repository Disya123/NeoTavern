/** Unmanaged DOM insertion points for documented SillyTavern legacy extensions. */
import { LEGACY_ISLANDS, islandElementId } from '@neotavern/legacy-compat';
import styles from './LegacyIslands.module.css';

export function LegacyIslands() {
  return (
    <div className={styles.layer} data-component="legacy-island-layer">
      {LEGACY_ISLANDS.map((name) => (
        <div
          key={name}
          id={islandElementId(name)}
          className={styles.island}
          data-component="legacy-island"
          data-slot={name}
        />
      ))}
    </div>
  );
}
