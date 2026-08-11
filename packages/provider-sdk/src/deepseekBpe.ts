/**
 * Compact, counting-only implementation of DeepSeek's byte-level BPE
 * tokenizer.
 *
 * DeepSeek (V3 / V4-Flash / V4-Flash-0731 — identical vocab and merges)
 * ships a GPT-2-style byte-level BPE: a 128 000-token vocab, 127 741
 * merges and a three-stage regex pre-tokenizer (digit runs, CJK runs, the
 * classic GPT split), all in the byte-value space of the GPT-2 byte table.
 * Counting needs only the merge ranks, the added tokens and the three
 * regexes — no vocab, no decode tables, no `@huggingface/tokenizers`
 * runtime. The compact ranks file (~1.4 MB) is produced once from the
 * official `tokenizer.json` by `convertDeepSeekTokenizer` and cached on
 * disk; the engine itself is a faithful port of the tokenizers-lib BPE
 * merge (heap over `rank + position/len`), so counts match the provider's
 * usage byte-for-byte in every script.
 */
import type { DeepSeekTokenizerData } from './tokenizerModels.js';

/**
 * Pre-tokenizer split regexes, copied verbatim from the official
 * `deepseek-ai/DeepSeek-V4-Flash` tokenizer.json (byte-identical for the
 * whole DeepSeek family). Order matters: digit runs, then CJK runs, then
 * the GPT-2-style split; each stage splits the output of the previous one
 * with Isolated semantics (matches are kept as pieces).
 */
export const DEEPSEEK_PRE_TOKENIZE_REGEXES: readonly [string, string, string] = [
  '\\p{N}{1,3}',
  '[一-龥぀-ゟ゠-ヿ]+',
  '[!"#$%&\'()*+,\\-./:;<=>?@\\[\\\\\\]^_`{|}~][A-Za-z]+|[^\\r\\n\\p{L}\\p{P}\\p{S}]?[\\p{L}\\p{M}]+| ?[\\p{P}\\p{S}]+[\\r\\n]*|\\s*[\\r\\n]+|\\s+(?!\\S)|\\s+',
];

/** Exposed for tests; not part of the public contract. */
export function splitRegex(text: string, re: RegExp): string[] {
  const parts: string[] = [];
  let last = 0;
  for (const match of text.matchAll(re)) {
    const index = match.index;
    if (index > last) parts.push(text.slice(last, index));
    parts.push(match[0]);
    last = index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** Exposed for tests; not part of the public contract. */
export function byteToMappedChar(byte: number): string {
  if ((byte >= 33 && byte <= 126) || (byte >= 161 && byte <= 172) || (byte >= 174 && byte <= 255)) {
    return String.fromCharCode(byte);
  }
  if (byte <= 32) return String.fromCharCode(0x0100 + byte);
  if (byte <= 160) return String.fromCharCode(0x0121 + (byte - 127));
  // byte 173 only.
  return String.fromCharCode(0x0143);
}

const MAPPED_TO_BYTE: Map<string, number> = (() => {
  const table = new Map<string, number>();
  for (let byte = 0; byte < 256; byte += 1) {
    table.set(byteToMappedChar(byte), byte);
  }
  return table;
})();

/** Mapped-char string → raw byte string (latin1). */
function mappedToBytes(mapped: string): string {
  let out = '';
  for (const ch of mapped) {
    const byte = MAPPED_TO_BYTE.get(ch);
    if (byte === undefined) {
      throw new TypeError(`Not a byte-level tokenizer char: ${JSON.stringify(ch)}`);
    }
    out += String.fromCharCode(byte);
  }
  return out;
}

/**
 * Convert an official DeepSeek `tokenizer.json` into the compact cache
 * format: tiktoken-style lines (`<rank> <b64> <b64> …` with consecutive
 * ranks) plus the added-token contents. The vocab and the ByteLevel
 * decoder are not needed for counting and are dropped.
 */
export function convertDeepSeekTokenizer(tokenizerJson: unknown): DeepSeekTokenizerData {
  const tj = tokenizerJson as {
    model?: { merges?: unknown };
    added_tokens?: Array<{ content?: unknown }>;
  };
  const merges = tj.model?.merges;
  if (!Array.isArray(merges)) {
    throw new TypeError('tokenizer.json: model.merges must be an array');
  }
  const addedTokens: string[] = [];
  for (const added of tj.added_tokens ?? []) {
    if (typeof added.content === 'string') addedTokens.push(added.content);
  }
  const lines: string[] = [];
  let pending: string[] = [];
  let rank = 0;
  const flush = (): void => {
    if (pending.length === 0) return;
    lines.push(`${rank - pending.length} ${pending.join(' ')}`);
    pending = [];
  };
  for (const merge of merges) {
    if (typeof merge !== 'string') {
      throw new TypeError('tokenizer.json: model.merges entries must be strings');
    }
    const space = merge.indexOf(' ');
    const left = space === -1 ? merge : merge.slice(0, space);
    const right = space === -1 ? '' : merge.slice(space + 1);
    const pair = mappedToBytes(left) + mappedToBytes(right);
    pending.push(Buffer.from(pair, 'latin1').toString('base64'));
    rank += 1;
    if (pending.length >= 64) flush();
  }
  flush();
  return { ranksText: lines.join('\n'), addedTokens };
}

/**
 * Min-heap over merge scores, a port of the tokenizers-lib heap used by
 * its BPE model. Pops the lowest `score` first; stale entries are skipped
 * via the `deleted` flag.
 */
class ScoreHeap {
  private readonly items: HeapEntry[] = [];
  private readonly less: (left: HeapEntry, right: HeapEntry) => boolean;

  constructor(less: (left: HeapEntry, right: HeapEntry) => boolean) {
    this.less = less;
  }

  private greater(a: number, b: number): boolean {
    const left = this.items[a];
    const right = this.items[b];
    return left !== undefined && right !== undefined && this.less(left, right);
  }

  private swap(a: number, b: number): void {
    const t = this.items[a];
    if (t === undefined) return;
    this.items[a] = this.items[b] as HeapEntry;
    this.items[b] = t;
  }

  private siftUpFrom(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.greater(i, parent)) break;
      this.swap(parent, i);
      i = parent;
    }
  }

  private siftDown(): void {
    let e = 0;
    for (;;) {
      const left = 2 * e + 1;
      const right = 2 * e + 2;
      const leftSmaller = left < this.items.length && this.greater(left, e);
      const rightSmaller = right < this.items.length && this.greater(right, e);
      if (!leftSmaller && !rightSmaller) break;
      const t = right < this.items.length && this.greater(right, left) ? right : left;
      this.swap(e, t);
      e = t;
    }
  }

  isEmpty(): boolean {
    return this.items.length === 0;
  }

  push(item: HeapEntry): void {
    this.items.push(item);
    this.siftUpFrom(this.items.length - 1);
  }

  pop(): HeapEntry | undefined {
    if (this.items.length === 0) return undefined;
    const root = this.items[0];
    this.swap(0, this.items.length - 1);
    this.items.pop();
    this.siftDown();
    return root;
  }
}

interface HeapEntry {
  node: MergeNode;
  score: number;
}

interface MergeNode {
  token: string;
  bias: number;
  deleted?: boolean;
  prev: MergeNode | null;
  next: MergeNode | null;
}

/**
 * Counting-only byte-level BPE for the DeepSeek family.
 *
 * `ranksText` is the compact tiktoken-style text produced by
 * `convertDeepSeekTokenizer`; `addedTokens` are ALL `added_tokens` contents
 * (special or not) — they are split from the text before pre-tokenization,
 * exactly like the tokenizers-lib does. Initial tokens are the individual
 * bytes of each pre-tokenized piece, and merges are keyed by byte-pair
 * strings, so no vocab or byte table is required at count time.
 */
export class DeepSeekCountingBpe {
  private readonly ranks: Map<string, number> = new Map();
  private readonly specials: string[];
  private readonly specialsByFirst: Map<string, string[]> = new Map();
  private readonly regexes: readonly [RegExp, RegExp, RegExp];
  /** Word-level count cache: pieces repeat heavily in real prompts. */
  private readonly wordCache = new Map<string, number>();
  private static readonly WORD_CACHE_MAX = 10_000;
  private static readonly WORD_CACHE_MAX_LEN = 256;

  constructor(ranksText: string, addedTokens: readonly string[]) {
    for (const line of ranksText.split('\n')) {
      if (line.length === 0) continue;
      const space = line.indexOf(' ');
      const base = Number.parseInt(line.slice(0, space), 10);
      let rank = Number.isFinite(base) ? base : 0;
      for (const b64 of line
        .slice(space + 1)
        .trim()
        .split(' ')) {
        if (b64.length === 0) continue;
        this.ranks.set(Buffer.from(b64, 'base64').toString('latin1'), rank);
        rank += 1;
      }
    }
    this.specials = [...addedTokens].sort((a, b) => b.length - a.length);
    for (const special of this.specials) {
      const first = special[0];
      if (first === undefined) continue;
      const group = this.specialsByFirst.get(first) ?? [];
      group.push(special);
      this.specialsByFirst.set(first, group);
    }
    this.regexes = DEEPSEEK_PRE_TOKENIZE_REGEXES.map((source) => new RegExp(source, 'gu')) as [
      RegExp,
      RegExp,
      RegExp,
    ];
  }

  /** Count the tokens of one pre-tokenized piece (a latin1 byte string). */
  private countPiece(bytes: string): number {
    const cached = this.wordCache.get(bytes);
    if (cached !== undefined) {
      // Refresh LRU position.
      this.wordCache.delete(bytes);
      this.wordCache.set(bytes, cached);
      return cached;
    }
    const count = this.mergeWord(bytes);
    if (bytes.length <= DeepSeekCountingBpe.WORD_CACHE_MAX_LEN) {
      this.wordCache.set(bytes, count);
      if (this.wordCache.size > DeepSeekCountingBpe.WORD_CACHE_MAX) {
        const oldest = this.wordCache.keys().next();
        if (!oldest.done) this.wordCache.delete(oldest.value);
      }
    }
    return count;
  }

  private addNode(heap: ScoreHeap, node: MergeNode): void {
    if (node.next === null) return;
    const rank = this.ranks.get(node.token + node.next.token);
    if (rank !== undefined) {
      heap.push({ node, score: rank + node.bias });
    }
  }

  /**
   * Byte-level BPE merge over one word (latin1 byte string), an exact port
   * of the tokenizers-lib BPE: a min-heap over `rank + position/len` pops
   * the best adjacent pair; merged tokens replace the pair and the new
   * neighbours are re-inserted. Returns the final token count.
   */
  private mergeWord(bytes: string): number {
    const len = bytes.length;
    if (len <= 1) return len;
    const heap = new ScoreHeap((left, right) => left.score < right.score);
    const head: MergeNode = { token: bytes[0] ?? '', bias: 0, prev: null, next: null };
    let a: MergeNode = head;
    for (let index = 1; index < len; index += 1) {
      const node: MergeNode = {
        token: bytes[index] ?? '',
        bias: index / len,
        prev: a,
        next: null,
      };
      a.next = node;
      this.addNode(heap, a);
      a = node;
    }
    let count = len;
    for (;;) {
      const popped = heap.pop();
      if (popped === undefined) break;
      const node = popped.node;
      if (node.deleted || node.next === null || node.next.deleted) continue;
      node.deleted = true;
      node.next.deleted = true;
      count -= 1;
      let prev: MergeNode | null = node.prev;
      if (prev !== null) {
        // Clone the predecessor so its stale heap entry is invalidated.
        const clone: MergeNode = { ...prev, deleted: false };
        prev.deleted = true;
        prev = clone;
        node.prev = clone;
        if (clone.prev !== null) clone.prev.next = clone;
      }
      const merged: MergeNode = {
        token: node.token + node.next.token,
        bias: node.bias,
        prev,
        next: node.next.next,
      };
      if (merged.prev !== null) {
        merged.prev.next = merged;
        this.addNode(heap, merged.prev);
      }
      if (merged.next !== null) {
        merged.next.prev = merged;
        this.addNode(heap, merged);
      }
    }
    return count;
  }

  /** Exact DeepSeek token count of `text`. */
  count(text: string): number {
    if (text.length === 0) return 0;
    let total = 0;
    let index = 0;
    while (index < text.length) {
      const first = text[index];
      const candidates = first === undefined ? undefined : this.specialsByFirst.get(first);
      let matched: string | null = null;
      if (candidates !== undefined) {
        for (const special of candidates) {
          if (text.startsWith(special, index)) {
            matched = special;
            break;
          }
        }
      }
      if (matched !== null) {
        total += 1;
        index += matched.length;
        continue;
      }
      let end = index + 1;
      while (end < text.length) {
        const candidate = text[end];
        const group = candidate === undefined ? undefined : this.specialsByFirst.get(candidate);
        if (group !== undefined && group.some((s) => text.startsWith(s, end))) break;
        end += 1;
      }
      let pieces = [text.slice(index, end)];
      for (const source of this.regexes) pieces = pieces.flatMap((p) => splitRegex(p, source));
      for (const piece of pieces) {
        total += this.countPiece(Buffer.from(piece, 'utf8').toString('latin1'));
      }
      index = end;
    }
    return total;
  }
}
