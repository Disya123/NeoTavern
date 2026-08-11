/**
 * Registration surfaces for legacy extensions that the v2 plugin SDK exposes
 * to sandboxed plugins (ТЗ §8.1 guaranteed items: slash commands and prompt
 * interceptors). Legacy code cannot run inside the sandbox, so these registries
 * live on the trusted bridge and are consumed by the host app alongside the
 * native plugin registrations.
 */

export interface LegacySlashCommand {
  name: string;
  description?: string;
  handler: (args: string) => unknown;
}

export interface LegacyPromptMessage {
  role: string;
  content: string;
  name?: string;
}

export type LegacyPromptInterceptor = (
  messages: LegacyPromptMessage[],
) => LegacyPromptMessage[] | Promise<LegacyPromptMessage[]>;

const slashCommands = new Map<string, LegacySlashCommand>();
const promptInterceptors = new Set<LegacyPromptInterceptor>();

/** Register a slash command. Returns an unregister function. */
export function registerLegacySlashCommand(command: LegacySlashCommand): () => void {
  const key = command.name.toLowerCase();
  slashCommands.set(key, command);
  return () => {
    if (slashCommands.get(key) === command) slashCommands.delete(key);
  };
}

export function findLegacySlashCommand(name: string): LegacySlashCommand | undefined {
  return slashCommands.get(name.toLowerCase());
}

export function listLegacySlashCommands(): LegacySlashCommand[] {
  return [...slashCommands.values()];
}

/** Register a prompt interceptor. Returns an unregister function. */
export function registerLegacyPromptInterceptor(interceptor: LegacyPromptInterceptor): () => void {
  promptInterceptors.add(interceptor);
  return () => {
    promptInterceptors.delete(interceptor);
  };
}

/** Whether any legacy prompt interceptors are registered. */
export function hasLegacyPromptInterceptors(): boolean {
  return promptInterceptors.size > 0;
}

/** Run all legacy interceptors in registration order; failures are isolated. */
export async function runLegacyPromptInterceptors(
  messages: LegacyPromptMessage[],
): Promise<LegacyPromptMessage[]> {
  let current = messages;
  for (const interceptor of [...promptInterceptors]) {
    try {
      const result = await interceptor(current);
      if (Array.isArray(result) && result.length > 0) current = result;
    } catch (error) {
      // One broken legacy interceptor must not stop generation (ТЗ §8).
      console.error('[legacy:interceptor] threw', error);
    }
  }
  return current;
}

/** Remove all legacy registrations (full teardown). */
export function clearLegacyRegistrations(): void {
  slashCommands.clear();
  promptInterceptors.clear();
}
