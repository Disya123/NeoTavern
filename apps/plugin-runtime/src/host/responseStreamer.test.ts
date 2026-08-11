/**
 * §17 credit streams (Stage F part 14): the host-side chunking/credit state
 * machine. Pure unit tests — no subprocess, no runtime.
 */
import { describe, expect, it } from 'vitest';
import { RPC_STREAM_CHUNK_BYTES } from '@neotavern/contracts';
import {
  RESPONSE_STREAM_ERROR_DUPLICATE,
  RESPONSE_STREAM_ERROR_LIMIT,
  RESPONSE_STREAM_ERROR_TOO_LARGE,
  ResponseStreamer,
} from './responseStreamer.js';

const CHUNK = RPC_STREAM_CHUNK_BYTES;

function chunkBody(n: number): Uint8Array {
  return new Uint8Array(new TextEncoder().encode('x'.repeat(n)));
}

function splitPayload(payload: Uint8Array): { header: unknown; chunk: Uint8Array } {
  const nul = payload.indexOf(0);
  const header = JSON.parse(new TextDecoder().decode(payload.subarray(0, nul)));
  return { header, chunk: payload.subarray(nul + 1) };
}

describe('ResponseStreamer', () => {
  it('streams a body larger than one chunk in bounded frames with the §17 payload layout', () => {
    const streamer = new ResponseStreamer();
    const body = chunkBody(2.5 * CHUNK);
    const result = streamer.begin(3, 5, 'req-test-0001', body);
    expect(result.kind).toBe('frame');
    if (result.kind !== 'frame') return;

    const first = result.frame;
    expect(first.header).toEqual({ requestId: 'req-test-0001', seq: 0, final: false });
    expect(first.chunk.byteLength).toBe(CHUNK);
    const firstSplit = splitPayload(first.payload);
    expect(firstSplit.header).toEqual(first.header);
    expect(firstSplit.chunk.byteLength).toBe(CHUNK);
    expect(firstSplit.chunk).toEqual(body.subarray(0, CHUNK));

    // Without a credit grant the producer must not create the next chunk.
    expect(streamer.isActive('req-test-0001')).toBe(true);

    // Second chunk after one grant (the consumer consumed the first chunk).
    const second = streamer.grant(3, 5, 'req-test-0001', first.chunk.byteLength);
    expect(second).not.toBeNull();
    expect(second?.header).toEqual({ requestId: 'req-test-0001', seq: 1, final: false });
    expect(second?.chunk).toEqual(body.subarray(CHUNK, 2 * CHUNK));

    // Final chunk completes and removes the stream.
    const third = streamer.grant(3, 5, 'req-test-0001', second?.chunk.byteLength ?? 0);
    expect(third).not.toBeNull();
    expect(third?.header).toEqual({ requestId: 'req-test-0001', seq: 2, final: true });
    expect(third?.chunk).toEqual(body.subarray(2 * CHUNK));
    expect(streamer.isActive('req-test-0001')).toBe(false);
    expect(streamer.activeCount).toBe(0);
  });

  it('ignores a grant that does not open a full window', () => {
    const streamer = new ResponseStreamer({ chunkBytes: 128 });
    const result = streamer.begin(1, 1, 'req-test-0002', chunkBody(1000));
    expect(result.kind).toBe('frame');
    if (result.kind !== 'frame') return;
    expect(result.frame.header.final).toBe(false);

    // Granting less than the window needs must not produce a frame.
    const frame = streamer.grant(1, 1, 'req-test-0002', 64);
    expect(frame).toBeNull();
    // A full-window grant does.
    const frame2 = streamer.grant(1, 1, 'req-test-0002', 128);
    expect(frame2).not.toBeNull();
  });

  it('rejects a body above the accumulated cap before streaming', () => {
    const streamer = new ResponseStreamer({ maxAccumulatedBytes: 1024 });
    const result = streamer.begin(1, 1, 'req-test-0003', chunkBody(2048));
    expect(result).toEqual({
      kind: 'error',
      code: RESPONSE_STREAM_ERROR_TOO_LARGE,
      message: expect.any(String),
    });
    expect(streamer.activeCount).toBe(0);
  });

  it('bounds the concurrent stream registry', () => {
    const streamer = new ResponseStreamer({ maxConcurrent: 2 });
    const begin = (id: string) => streamer.begin(1, 1, id, chunkBody(CHUNK + 1));
    expect(begin('req-test-0004').kind).toBe('frame');
    expect(begin('req-test-0005').kind).toBe('frame');
    const third = begin('req-test-0006');
    expect(third).toEqual({
      kind: 'error',
      code: RESPONSE_STREAM_ERROR_LIMIT,
      message: expect.any(String),
    });
    // Finishing one stream frees a slot.
    streamer.grant(1, 1, 'req-test-0004', CHUNK);
    expect(begin('req-test-0006').kind).toBe('frame');
  });

  it('rejects a duplicate requestId and ignores stale/foreign grants', () => {
    const streamer = new ResponseStreamer({ maxConcurrent: 4 });
    const result = streamer.begin(1, 1, 'req-test-0007', chunkBody(CHUNK + 1));
    expect(result.kind).toBe('frame');
    const dup = streamer.begin(1, 1, 'req-test-0007', chunkBody(CHUNK + 1));
    expect(dup).toEqual({
      kind: 'error',
      code: RESPONSE_STREAM_ERROR_DUPLICATE,
      message: expect.any(String),
    });

    // Foreign epoch / unknown requestId / malformed bytes: all ignored.
    expect(streamer.grant(2, 1, 'req-test-0007', CHUNK)).toBeNull();
    expect(streamer.grant(1, 1, 'req-test-unknown', CHUNK)).toBeNull();
    expect(streamer.grant(1, 1, 'req-test-0007', CHUNK + 1)).toBeNull();
    expect(streamer.grant(1, 1, 'req-test-0007', 1.5)).toBeNull();
    // The stream is still alive and untouched.
    expect(streamer.isActive('req-test-0007')).toBe(true);

    // A valid grant produces the next chunk.
    const next = streamer.grant(1, 1, 'req-test-0007', CHUNK);
    expect(next).not.toBeNull();
  });

  it('streams a body that fits one chunk as a single final frame', () => {
    const streamer = new ResponseStreamer();
    const body = chunkBody(1024);
    const result = streamer.begin(1, 1, 'req-test-0008', body);
    expect(result.kind).toBe('frame');
    if (result.kind !== 'frame') return;
    expect(result.frame.header).toEqual({ requestId: 'req-test-0008', seq: 0, final: true });
    expect(result.frame.chunk).toEqual(body);
    expect(streamer.activeCount).toBe(0);
  });
});
