import { describe, expect, it } from 'vitest';
import type {
  PluginRuntimeHotHeader,
  PluginRuntimeProtocolErrorCodeValue,
} from '@neotavern/contracts';
import {
  PLUGIN_RUNTIME_HEADER_BYTES,
  PLUGIN_RUNTIME_MAX_CONTROL_PAYLOAD_BYTES,
  PLUGIN_RUNTIME_MAX_DATA_PAYLOAD_BYTES,
  PLUGIN_RUNTIME_MAX_STRING_BYTES,
  PLUGIN_RUNTIME_PROTOCOL_VERSION,
  PluginRuntimeFrameFlag,
  PluginRuntimeFrameParser,
  PluginRuntimeFrameType,
  PluginRuntimeProtocolError,
  PluginRuntimeProtocolErrorCode,
  decodeControlBody,
  decodeControlFrame,
  decodeDataFrame,
  encodeControlBody,
  encodeControlFrame,
  encodeDataBody,
  encodeDataFrame,
  encodeHeader,
  parseHeader,
} from '@neotavern/contracts';

function header(overrides: Partial<PluginRuntimeHotHeader> = {}): PluginRuntimeHotHeader {
  return {
    protocolVersion: PLUGIN_RUNTIME_PROTOCOL_VERSION,
    frameType: PluginRuntimeFrameType.HELLO,
    flags: 0,
    runtimeEpoch: 1,
    workerId: 0,
    workerEpoch: 0,
    requestId: 0,
    payloadLength: 0,
    ...overrides,
  };
}

function expectProtocolError(
  action: () => unknown,
  code: PluginRuntimeProtocolErrorCodeValue,
): void {
  try {
    action();
    expect.unreachable(`expected protocol error ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(PluginRuntimeProtocolError);
    expect((error as PluginRuntimeProtocolError).code).toBe(code);
  }
}

describe('plugin-runtime header codec (§15.2)', () => {
  it('round-trips a full routing header', () => {
    const h = header({
      frameType: PluginRuntimeFrameType.RPC_REQUEST,
      flags: 1,
      runtimeEpoch: 7,
      workerId: 42,
      workerEpoch: 3,
      requestId: 9001,
      payloadLength: 123456,
    });
    expect(parseHeader(encodeHeader(h))).toEqual(h);
  });

  it('rejects a truncated header', () => {
    expectProtocolError(
      () => parseHeader(new Uint8Array(PLUGIN_RUNTIME_HEADER_BYTES - 1)),
      PluginRuntimeProtocolErrorCode.BAD_HEADER,
    );
  });

  it('rejects an unknown frame type on the wire', () => {
    const raw = new Uint8Array(PLUGIN_RUNTIME_HEADER_BYTES);
    const view = new DataView(raw.buffer);
    view.setUint16(0, PLUGIN_RUNTIME_PROTOCOL_VERSION);
    view.setUint8(2, 0xff);
    expectProtocolError(() => parseHeader(raw), PluginRuntimeProtocolErrorCode.BAD_HEADER);
  });
});

describe('plugin-runtime control payloads (§15.11 bounds)', () => {
  it('round-trips nested bodies and unicode', () => {
    const body = { a: 1, nested: { list: ['два', true, null] }, emoji: '🎈' };
    const bytes = encodeControlBody(body);
    expect(decodeControlBody(bytes)).toEqual(body);
  });

  it('rejects payloads over the control cap', () => {
    expectProtocolError(
      () => encodeControlBody({ big: 'x'.repeat(PLUGIN_RUNTIME_MAX_CONTROL_PAYLOAD_BYTES) }),
      PluginRuntimeProtocolErrorCode.FRAME_TOO_LARGE,
    );
  });

  it('rejects over-deep JSON trees', () => {
    let value: unknown = 1;
    for (let i = 0; i < 70; i += 1) value = [value];
    expectProtocolError(
      () => decodeControlBody(new TextEncoder().encode(JSON.stringify(value))),
      PluginRuntimeProtocolErrorCode.DECODE_DEPTH,
    );
  });

  it('rejects oversized strings inside an otherwise small payload', () => {
    const body = { message: 'x'.repeat(PLUGIN_RUNTIME_MAX_STRING_BYTES + 1) };
    const bytes = encodeControlBody(body);
    expect(bytes.byteLength).toBeLessThanOrEqual(PLUGIN_RUNTIME_MAX_CONTROL_PAYLOAD_BYTES);
    expectProtocolError(
      () => decodeControlBody(bytes),
      PluginRuntimeProtocolErrorCode.DECODE_STRING,
    );
  });

  it('rejects malformed JSON', () => {
    expectProtocolError(
      () => decodeControlBody(new TextEncoder().encode('{"broken":')),
      PluginRuntimeProtocolErrorCode.BAD_PAYLOAD,
    );
  });
});

describe('plugin-runtime control frames', () => {
  it('encode/decode round-trip with header + body', () => {
    const base = header({ frameType: PluginRuntimeFrameType.HELLO, requestId: 11 });
    const frame = encodeControlFrame(base, { hello: 'мир', n: 5 });
    const decoded = decodeControlFrame(frame);
    expect(decoded.header).toEqual({
      ...base,
      payloadLength: frame.byteLength - PLUGIN_RUNTIME_HEADER_BYTES,
    });
    expect(decoded.body).toEqual({ hello: 'мир', n: 5 });
  });
});

describe('plugin-runtime data frames (§15.9)', () => {
  it('keeps bulk payloads opaque', () => {
    const payload = new Uint8Array([1, 2, 3, 255, 0, 128, 7]);
    const frame = encodeDataFrame(
      header({ frameType: PluginRuntimeFrameType.TELEMETRY, flags: 1 }),
      payload,
    );
    const decoded = decodeDataFrame(frame);
    expect(decoded.payload).toEqual(payload);
  });

  it('encodeDataBody round-trips and ignores control string bounds', () => {
    const big = 'x'.repeat(PLUGIN_RUNTIME_MAX_STRING_BYTES * 2);
    const body = { workerId: 1, workerEpoch: 2, graph: { big } };
    const bytes = encodeDataBody(body);
    expect(bytes.byteLength).toBeGreaterThan(PLUGIN_RUNTIME_MAX_CONTROL_PAYLOAD_BYTES);
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual(body);
  });

  it('encodeDataBody rejects payloads over the data cap', () => {
    expectProtocolError(
      () => encodeDataBody({ big: 'x'.repeat(PLUGIN_RUNTIME_MAX_DATA_PAYLOAD_BYTES + 1) }),
      PluginRuntimeProtocolErrorCode.FRAME_TOO_LARGE,
    );
  });

  it('data-cap parser accepts payloads far above the control cap', { timeout: 10000 }, () => {
    const payload = new Uint8Array(3 * 1024 * 1024).fill(7);
    const frame = encodeDataFrame(
      header({
        frameType: PluginRuntimeFrameType.MODULE_GRAPH_DATA,
        flags: PluginRuntimeFrameFlag.DATA,
      }),
      payload,
    );
    const parser = new PluginRuntimeFrameParser({
      maxPayloadBytes: PLUGIN_RUNTIME_MAX_DATA_PAYLOAD_BYTES,
    });
    const frames = parser.push(frame);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.header.frameType).toBe(PluginRuntimeFrameType.MODULE_GRAPH_DATA);
    // Spot-check instead of a megabyte-scale toEqual: the matcher's deep
    // walker is too slow for 3 MiB arrays.
    expect(frames[0]?.payload.byteLength).toBe(payload.byteLength);
    expect(frames[0]?.payload[0]).toBe(7);
    expect(frames[0]?.payload[payload.byteLength - 1]).toBe(7);
  });

  it('control-cap parser rejects the same frame (channel separation)', () => {
    const frame = encodeDataFrame(
      header({ frameType: PluginRuntimeFrameType.MODULE_GRAPH_DATA }),
      new Uint8Array(1024 * 1024),
    );
    const parser = new PluginRuntimeFrameParser();
    expectProtocolError(() => parser.push(frame), PluginRuntimeProtocolErrorCode.FRAME_TOO_LARGE);
  });
});

describe('plugin-runtime incremental parser', () => {
  it('assembles a frame fed byte by byte', () => {
    const frame = encodeControlFrame(header({ frameType: PluginRuntimeFrameType.PING }), { p: 1 });
    const parser = new PluginRuntimeFrameParser();
    let frames = 0;
    for (const byte of frame) {
      frames += parser.push(new Uint8Array([byte])).length;
    }
    expect(frames).toBe(1);
    expect(parser.push(new Uint8Array())).toEqual([]);
  });

  it('splits two concatenated frames', () => {
    const a = encodeControlFrame(header({ frameType: PluginRuntimeFrameType.PING }), { a: 1 });
    const b = encodeControlFrame(header({ frameType: PluginRuntimeFrameType.PONG }), { b: 2 });
    const joined = new Uint8Array(a.byteLength + b.byteLength);
    joined.set(a, 0);
    joined.set(b, a.byteLength);
    const parser = new PluginRuntimeFrameParser();
    const frames = parser.push(joined);
    expect(frames).toHaveLength(2);
    expect(frames[0]?.header.frameType).toBe(PluginRuntimeFrameType.PING);
    expect(frames[1]?.header.frameType).toBe(PluginRuntimeFrameType.PONG);
  });

  it('rejects a frame whose payload exceeds the configured cap', () => {
    const payload = new Uint8Array(PLUGIN_RUNTIME_MAX_CONTROL_PAYLOAD_BYTES + 1);
    const frame = encodeDataFrame(header({ frameType: PluginRuntimeFrameType.TELEMETRY }), payload);
    const parser = new PluginRuntimeFrameParser();
    expectProtocolError(() => parser.push(frame), PluginRuntimeProtocolErrorCode.FRAME_TOO_LARGE);
  });
});
