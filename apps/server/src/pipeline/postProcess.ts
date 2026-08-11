/**
 * Post-processing hooks — the pipeline stage between the finished stream and
 * the saved message (ТЗ §4.4):
 *
 * Streaming response -> Post-processing hooks -> Save message.
 *
 * Hooks transform the final assistant text (cleanup, filters, formatting).
 * Each hook has priority/order, a timeout, an optional required permission,
 * exception isolation and a diagnostics journal entry — a broken hook never
 * breaks generation (ТЗ §4.4 «один сломанный плагин не должен убивать
 * генерацию»).
 */
import { withTimeout } from '@neotavern/shared';

export interface PostProcessContext {
  chatId: string;
  characterId: string | null;
  model: string;
}

export interface PostProcessor {
  id: string;
  /** Lower priority runs first (consistent with pipeline interceptors). */
  priority?: number;
  timeoutMs?: number;
  /** Permission the registrant must hold (verified by the host). */
  requiredPermission?: string;
  process(text: string, context: PostProcessContext): Promise<string> | string;
}

/** Hard bound so a misbehaving hook cannot balloon the saved message. */
const MAX_POST_PROCESS_LENGTH = 200_000;

export class PostProcessorRegistry {
  private readonly processors: PostProcessor[] = [];

  /** Register a hook. Returns the cleanup function (Plugin SDK contract). */
  register(processor: PostProcessor): () => void {
    if (processor.id.trim().length === 0) {
      throw new Error('Post-processor id must not be empty');
    }
    this.processors.push(processor);
    return () => {
      const index = this.processors.indexOf(processor);
      if (index >= 0) this.processors.splice(index, 1);
    };
  }

  /** Snapshot ordered by priority (lower first), ready to run. */
  ordered(): PostProcessor[] {
    return [...this.processors].sort(
      (left, right) => (left.priority ?? 100) - (right.priority ?? 100),
    );
  }

  get size(): number {
    return this.processors.length;
  }
}

export interface RunPostProcessorsInput {
  text: string;
  context: PostProcessContext;
  processors: PostProcessor[];
  /** Host permission checker; hooks with an unmet permission are skipped. */
  hasPermission?: (permission: string) => boolean;
  /** Receives one journal entry per hook outcome (ТЗ §4.4 diagnostics). */
  diagnostics?: string[];
}

/**
 * Apply hooks sequentially. A hook that throws, times out, returns a
 * non-string or exceeds the length bound is skipped and the previous text is
 * kept.
 */
export async function runPostProcessors(input: RunPostProcessorsInput): Promise<string> {
  let current = input.text;
  for (const processor of input.processors) {
    if (
      processor.requiredPermission &&
      !(input.hasPermission?.(processor.requiredPermission) ?? true)
    ) {
      input.diagnostics?.push(
        `post-process "${processor.id}" skipped (missing permission "${processor.requiredPermission}")`,
      );
      continue;
    }
    try {
      const result = await withTimeout(
        Promise.resolve(processor.process(current, input.context)),
        processor.timeoutMs ?? 2000,
      );
      if (typeof result !== 'string') {
        input.diagnostics?.push(`post-process "${processor.id}" skipped (non-string result)`);
        continue;
      }
      if (result.length > MAX_POST_PROCESS_LENGTH) {
        input.diagnostics?.push(`post-process "${processor.id}" skipped (result too large)`);
        continue;
      }
      current = result;
      input.diagnostics?.push(`post-process "${processor.id}" applied`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      input.diagnostics?.push(`post-process "${processor.id}" skipped (${message})`);
    }
  }
  return current;
}
