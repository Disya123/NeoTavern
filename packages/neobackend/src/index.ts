/**
 * @neotavern/neobackend — UI facade over the NeoTavern product wire API.
 *
 * Exports the `NeoBackend` surface plus its three implementations
 * (`LocalBackend`, `RemoteBackend`, `LegacyBackend`) and the typed errors they
 * throw (`ContractMismatchError`, `ValidationError`, `ContractViolationError`,
 * `UnsupportedError`).
 */
export * from './neobackend.js';
export * from './localBackend.js';
export * from './remoteBackend.js';
export * from './legacyBackend.js';
