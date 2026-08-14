/**
 * Environment-backed SecretStore (ТЗ §SEC-01: Headless «явно настроенный
 * environment/file secret provider»). Read-only: values come from process
 * environment variables; the store only resolves references and lists which
 * configured names are present. Never writes anything.
 */
import { SecretStoreError, SecretStoreErrorCodes } from './errors.js';
import type { SecretBackendInfo, SecretStore } from './store.js';

export class EnvSecretStore implements SecretStore {
  constructor(
    private readonly prefix = 'NEOTA_SECRET_',
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  isAvailable(): boolean {
    return true;
  }

  describe(): SecretBackendInfo {
    return {
      kind: 'env',
      persistent: true,
      writable: false,
      available: true,
      recordCount: this.configuredNames().length,
    };
  }

  async put(): Promise<string> {
    throw new SecretStoreError(SecretStoreErrorCodes.SECRET_READ_ONLY, 'env store is read-only');
  }

  async get(namespace: string, id: string): Promise<string | null> {
    const name = `${this.prefix}${namespace}_${id}`;
    const value = this.env[name];
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  async delete(): Promise<boolean> {
    return false;
  }

  async list(
    namespace: string,
  ): Promise<Array<{ id: string; createdAt: number; updatedAt: number }>> {
    return this.configuredNames()
      .filter((name) => name.startsWith(`${this.prefix}${namespace}_`))
      .map((name) => ({
        id: name.slice(`${this.prefix}${namespace}_`.length),
        createdAt: 0,
        updatedAt: 0,
      }));
  }

  async has(namespace: string, id: string): Promise<boolean> {
    const value = this.env[`${this.prefix}${namespace}_${id}`];
    return typeof value === 'string' && value.length > 0;
  }

  ref(namespace: string, id: string): string {
    return `env:${namespace}:${id}`;
  }

  private configuredNames(): string[] {
    return Object.keys(this.env).filter((name) => name.startsWith(this.prefix));
  }
}
