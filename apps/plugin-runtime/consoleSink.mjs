// BoundedConsoleSink core (ТЗ Plugin SDK vNext v3.2 §9.1.1/§9.1.2).
//
// Part of the NeoTavern trusted Worker bootstrap (ADR-0028): this module is loaded
// by `worker-bootstrap.mjs` BEFORE lockdown and therefore belongs to the
// Trusted Computing Base. It is plain ESM, depends only on Web platform
// primitives and contains no plugin-reachable authority.
//
// Two pure pieces, both unit-testable without a Worker:
//
// 1. `makeBoundedFormatter` — §9.1.2 bounded record formatting: max depth,
//    max object keys, max array elements, max string bytes, max record
//    bytes, max stack frames. It never intentionally invokes getters
//    (property reads go through own-property descriptors; accessors render
//    as `[Getter]`), never runs unbounded serialization, and contains proxy
//    failures with a diagnostic placeholder.
// 2. `makeLogRing` — §9.1.1 fixed-byte ring buffer for diagnostics: when
//    full, identical consecutive records coalesce (count), everything else
//    is dropped with `droppedCount` accounting. The ring is the ONLY log
//    buffer; there is never a secondary unbounded queue behind it.
//
// The worker bootstrap owns the policy numbers (constants pinned against
// `packages/contracts/src/pluginRuntime.ts`) and passes them in.

const textEncoder = new TextEncoder();

function utf8Length(value) {
  return textEncoder.encode(value).byteLength;
}

/** Byte-aware truncation; `…` marker when anything was cut. */
function truncateString(value, maxBytes) {
  if (utf8Length(value) <= maxBytes) return value;
  let bytes = 0;
  let end = 0;
  for (; end < value.length; end += 1) {
    bytes += utf8Length(value[end]);
    if (bytes > maxBytes - 3) break;
  }
  return `${value.slice(0, end)}…`;
}

/**
 * §9.1.2 bounded formatter. Returns a string of at most
 * `limits.maxRecordBytes` bytes; never throws (all exotic paths degrade to
 * diagnostic placeholders).
 */
export function makeBoundedFormatter(limits) {
  const maxDepth = limits.maxDepth;
  const maxKeys = limits.maxKeys;
  const maxItems = limits.maxItems;
  const maxStringBytes = limits.maxStringBytes;
  const maxRecordBytes = limits.maxRecordBytes;
  const maxStackFrames = limits.maxStackFrames;
  const maxVisits = limits.maxVisits;

  function formatValue(value, depth, ctx) {
    if (ctx.omitted) return;
    ctx.visits += 1;
    if (ctx.visits > maxVisits) {
      ctx.push('…');
      return;
    }
    if (value === null) {
      ctx.push('null');
      return;
    }
    const type = typeof value;
    switch (type) {
      case 'string':
        ctx.push(truncateString(value, maxStringBytes));
        return;
      case 'number':
      case 'boolean':
      case 'bigint':
        ctx.push(String(value));
        return;
      case 'undefined':
        ctx.push('undefined');
        return;
      case 'symbol':
        ctx.push('Symbol(…)');
        return;
      case 'function':
        ctx.push('[Function]');
        return;
      default:
        break;
    }
    if (depth >= maxDepth) {
      ctx.push('[…]');
      return;
    }
    let tag = '[object Object]';
    try {
      // Intrinsic toStringTag probe; a hostile proxy may trap and throw.
      tag = Object.prototype.toString.call(value);
    } catch {
      ctx.push('[Uninspected]');
      return;
    }
    if (tag === '[object Error]' || tag === '[object DOMException]') {
      formatErrorLike(value, ctx);
      return;
    }
    if (tag === '[object Date]') {
      try {
        ctx.push(`Date(${truncateString(value.toISOString(), maxStringBytes)})`);
      } catch {
        ctx.push('[Date]');
      }
      return;
    }
    if (tag === '[object ArrayBuffer]') {
      try {
        ctx.push(`ArrayBuffer(${String(value.byteLength)})`);
      } catch {
        ctx.push('[ArrayBuffer]');
      }
      return;
    }
    if (ArrayBuffer.isView(value)) {
      try {
        ctx.push(`${tag.slice(8, -1)}(${String(value.byteLength)})`);
      } catch {
        ctx.push('[TypedArray]');
      }
      return;
    }
    if (Array.isArray(value)) {
      formatArray(value, depth, ctx);
      return;
    }
    formatPlainObject(value, tag, depth, ctx);
  }

  function formatErrorLike(value, ctx) {
    const identity = errorIdentity(value);
    ctx.push(
      `${truncateString(identity.name, maxStringBytes)}: ${truncateString(identity.message, maxStringBytes)}`,
    );
    if (identity.stack === null) return;
    ctx.push(
      `\n${identity.stack
        .split('\n')
        .slice(0, 1 + maxStackFrames)
        .join('\n')}`,
    );
  }

  function formatArray(value, depth, ctx) {
    let length = 0;
    try {
      length = value.length;
    } catch {
      ctx.push('[Array]');
      return;
    }
    if (!Number.isInteger(length) || length < 0) length = 0;
    const shown = Math.min(length, maxItems);
    ctx.push(`Array(${String(length)})[`);
    for (let i = 0; i < shown; i += 1) {
      if (i > 0) ctx.push(', ');
      let item;
      try {
        item = value[i];
      } catch {
        ctx.push('[Unreadable]');
        continue;
      }
      formatValue(item, depth + 1, ctx);
    }
    if (length > shown) ctx.push(`…+${String(length - shown)}`);
    ctx.push(']');
  }

  function formatPlainObject(value, tag, depth, ctx) {
    let keys = null;
    try {
      keys = Object.keys(value);
    } catch {
      ctx.push('[Uninspected]');
      return;
    }
    ctx.push(`${tag.slice(8, -1)} {`);
    const shown = Math.min(keys.length, maxKeys);
    for (let i = 0; i < shown; i += 1) {
      if (i > 0) ctx.push(', ');
      const key = keys[i];
      ctx.push(`${truncateString(key, maxStringBytes)}: `);
      let desc = null;
      try {
        desc = Object.getOwnPropertyDescriptor(value, key);
      } catch {
        ctx.push('[Unreadable]');
        continue;
      }
      if (desc === undefined) {
        ctx.push('[Unreadable]');
        continue;
      }
      if (typeof desc.get === 'function') {
        // §9.1.2: never intentionally invoke getters.
        ctx.push('[Getter]');
        continue;
      }
      formatValue(desc.value, depth + 1, ctx);
    }
    if (keys.length > shown) ctx.push(`…+${String(keys.length - shown)}`);
    ctx.push('}');
  }

  return function formatArgs(args) {
    const ctx = {
      parts: [],
      bytes: 0,
      visits: 0,
      omitted: false,
      push(part) {
        if (this.omitted || part.length === 0) return;
        const cost = utf8Length(part);
        if (this.bytes + cost > maxRecordBytes) {
          this.omitted = true;
          return;
        }
        this.parts.push(part);
        this.bytes += cost;
      },
    };
    for (let i = 0; i < args.length; i += 1) {
      if (i > 0) ctx.push(' ');
      formatValue(args[i], 0, ctx);
      if (ctx.omitted) break;
    }
    if (ctx.omitted) ctx.parts.push('…');
    return ctx.parts.join('');
  };
}

/**
 * Error identity for diagnostics (§9.1.3): name/message/stack read without
 * ever intentionally invoking guest getters (own-property descriptors,
 * walking the prototype chain; first found wins). SES `errorTaming: 'safe'`
 * moves name/stack into side-table accessors — those getters are hardened
 * intrinsic code, safe to invoke; a censored stack reads as empty and is
 * reported as absent.
 */
export function errorIdentity(value) {
  let name = 'Error';
  let message = '';
  let foundName = false;
  let foundMessage = false;
  let current = value;
  for (let level = 0; level < 4 && current !== null; level += 1) {
    try {
      const nameDesc = Object.getOwnPropertyDescriptor(current, 'name');
      if (nameDesc !== undefined && !foundName) {
        if (
          nameDesc.get === undefined &&
          typeof nameDesc.value === 'string' &&
          nameDesc.value.length > 0
        ) {
          name = nameDesc.value;
          foundName = true;
        } else if (typeof nameDesc.get === 'function') {
          try {
            const captured = nameDesc.get.call(current);
            if (typeof captured === 'string' && captured.length > 0) {
              name = captured;
              foundName = true;
            }
          } catch {
            // Exotic receiver; keep the default.
          }
        }
      }
      const messageDesc = Object.getOwnPropertyDescriptor(current, 'message');
      if (messageDesc !== undefined && messageDesc.get === undefined) {
        if (typeof messageDesc.value === 'string' && !foundMessage) {
          message = messageDesc.value;
          foundMessage = true;
        }
      } else if (messageDesc !== undefined && typeof messageDesc.get === 'function') {
        try {
          const captured = messageDesc.get.call(current);
          if (typeof captured === 'string' && !foundMessage) {
            message = captured;
            foundMessage = true;
          }
        } catch {
          // Accessor failed on an exotic receiver; keep the default.
        }
      }
    } catch {
      // Proxy trap failure; keep what we have.
    }
    try {
      current = Object.getPrototypeOf(current);
    } catch {
      break;
    }
  }
  let stack = null;
  try {
    const stackDesc = Object.getOwnPropertyDescriptor(value, 'stack');
    if (stackDesc !== undefined) {
      if (stackDesc.get === undefined && typeof stackDesc.value === 'string') {
        stack = stackDesc.value;
      } else if (typeof stackDesc.get === 'function') {
        try {
          const captured = stackDesc.get.call(value);
          // Compartment errors may have an empty side-table stack under
          // errorTaming: 'safe' (§9.1.3) — treat as absent.
          if (typeof captured === 'string' && captured.length > 0) stack = captured;
        } catch {
          stack = null;
        }
      }
    }
  } catch {
    stack = null;
  }
  return { name, message, stack };
}

/**
 * §9.1.1 rules 7/8: flush credits. The worker may send a batch only while
 * it holds credit; the host replenishes one credit per consumed batch (ack).
 * This is a rate backstop: without acks the worker stops flushing once its
 * grants are spent — the ring stays the only log buffer (no secondary
 * unbounded queue, rule 5).
 */
export function makeLogCredits(initial, max) {
  let credits = initial;
  return {
    /** May a new batch be flushed right now? */
    canFlush() {
      return credits > 0;
    },
    /** Consume one credit for a sent batch (no-op when none available). */
    consume() {
      if (credits > 0) credits -= 1;
    },
    /** Replenish one credit after a host ack (bounded by `max`). */
    replenish() {
      credits = Math.min(max, credits + 1);
    },
    get available() {
      return credits;
    },
  };
}

/**
 * §9.1.1 fixed-byte ring: `maxBytes` total budget (message wire cost +
 * per-record overhead). Full ring: identical consecutive records coalesce
 * (bounded count), everything else is dropped with `droppedCount`.
 */
export function makeLogRing(maxBytes, recordOverheadBytes) {
  const records = [];
  let bytes = 0;
  let droppedCount = 0;

  /** Wire cost of a formatted message (§9.1.1 rule 3 accounting). */
  function recordCost(message) {
    // JSON escaping is the true wire size of the message inside the batch.
    let escaped = 0;
    try {
      escaped = utf8Length(JSON.stringify(message));
    } catch {
      escaped = utf8Length(message);
    }
    return escaped + recordOverheadBytes;
  }

  return {
    push(level, message, at) {
      const last = records[records.length - 1];
      if (
        last !== undefined &&
        last.level === level &&
        last.message === message &&
        last.count < 1_000_000
      ) {
        last.count += 1;
        return;
      }
      const cost = recordCost(message);
      if (bytes + cost > maxBytes) {
        droppedCount += 1;
        return;
      }
      records.push({ level, message, at, count: 1 });
      bytes += cost;
    },
    /**
     * Take records off the front up to `maxRecords` records and `maxBytes`
     * of wire cost. Returns plain records (count omitted when 1).
     */
    drain(maxRecords, maxBytes) {
      const out = [];
      let outBytes = 0;
      while (records.length > 0 && out.length < maxRecords) {
        const next = records[0];
        const cost = recordCost(next.message);
        if (outBytes + cost > maxBytes && out.length > 0) break;
        records.shift();
        bytes -= cost;
        outBytes += cost;
        out.push(
          next.count === 1
            ? { level: next.level, message: next.message, at: next.at }
            : { level: next.level, message: next.message, at: next.at, count: next.count },
        );
      }
      return out;
    },
    get dropped() {
      return droppedCount;
    },
    /** Count records that left the ring without reaching a batch. */
    countDropped(additional) {
      droppedCount += additional;
    },
    get size() {
      return records.length;
    },
    get bytesUsed() {
      return bytes;
    },
  };
}
