/**
 * Memory-backed MessageChannel test double for kernel tests. Emulates the
 * structured-clone boundary of the real browser bridge. True buffer-detach
 * semantics are covered by the Playwright spike suite (spike 4) against real
 * engines; here we only need the logical RPC/stream contract.
 */

type PortListener = (event: { data: unknown }) => void;

export class TestMessagePort {
  onmessage: PortListener | null = null;
  private listeners = new Set<PortListener>();
  private peer: TestMessagePort | null = null;
  private started = false;
  private queue: Array<{ data: unknown }> = [];
  private closed = false;

  connect(peer: TestMessagePort): void {
    this.peer = peer;
    peer.peer = this;
  }

  postMessage(value: unknown, transfer: readonly ArrayBuffer[] = []): void {
    if (this.closed || !this.peer || this.peer.closed) {
      throw new Error('port closed');
    }
    void transfer; // Detach semantics validated by the real-browser spike.
    const event = { data: structuredClone(value) };
    if (this.peer.started || this.peer.onmessage) {
      this.peer.onmessage?.(event);
      for (const listener of [...this.peer.listeners]) listener(event);
    } else {
      this.peer.queue.push(event);
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const queued = this.queue.splice(0);
    for (const event of queued) {
      this.onmessage?.(event);
      for (const listener of [...this.listeners]) listener(event);
    }
  }

  addEventListener(_type: 'message', listener: PortListener): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'message', listener: PortListener): void {
    this.listeners.delete(listener);
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
    this.onmessage = null;
  }
}

export function createPortPair(): [TestMessagePort, TestMessagePort] {
  const left = new TestMessagePort();
  const right = new TestMessagePort();
  left.connect(right);
  return [left, right];
}
