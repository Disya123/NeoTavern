import { describe, expect, it } from 'vitest';
import { parseGfxinfo, parseM1Logcat, summarizeCapture } from './m1-android-capture.mjs';

const LOG = `
08-17 17:00:01.000 I/NeoTavern(123): m1-env sdk=34 release=14 model=Pixel webview=com.google.android.webview:125.0
08-17 17:00:01.010 I/NeoTavern(123): m1-origin profile=File url=file:///android_asset/web/index.html
08-17 17:00:01.020 I/NeoTavern(123): m1-refresh phase=apply requested_hz=120 observed_hz=60
08-17 17:00:31.000 I/NeoTavern(123): m1-frames {"expected_hz":120,"callback_hz":59.8,"misses":12,"longest_streak":3}
08-17 17:00:31.010 I/NeoTavern(123): m1-choreographer {"expected_hz":120,"callback_hz":60.1,"misses":4,"longest_streak":1}
unrelated noise
`;

const GFX = `
Total frames rendered: 1800
Janky frames: 90 (5.00%)
Number Missed Vsync: 11
50th percentile: 8ms
90th percentile: 12ms
95th percentile: 18ms
99th percentile: 32ms
`;

describe('m1 android capture parser', () => {
  it('keeps the last m1 line of each kind', () => {
    const parsed = parseM1Logcat(LOG);
    expect(parsed.lines).toHaveLength(5);
    expect(parsed.last.origin).toContain('profile=File');
    expect(parsed.last.frames).toContain('"callback_hz":59.8');
    expect(parsed.last.choreographer).toContain('"misses":4');
  });

  it('reads gfxinfo jank counters', () => {
    const gfx = parseGfxinfo(GFX);
    expect(gfx.totalFrames).toBe('1800');
    expect(gfx.jankyFrames).toBe('90 (5.00%)');
    expect(gfx.missedVsync).toBe('11');
    expect(gfx.percentile90).toBe('12ms');
  });

  it('prefers the JSON m1-frames summary over the start line', () => {
    const mixed = `m1-frames expected_hz=60 sample_ms=30000
m1-frames {"expected_hz":60,"callback_hz":52.96,"misses":215,"longest_streak":38}
`;
    const parsed = parseM1Logcat(mixed);
    expect(parsed.last.frames).toContain('"callback_hz":52.96');
  });

  it('summarizes logcat plus gfxinfo without requiring adb', () => {
    const summary = summarizeCapture(LOG, GFX);
    expect(summary.lineCount).toBe(5);
    expect(summary.gfxinfo.missedVsync).toBe('11');
    expect(summary.logcat.env).toContain('sdk=34');
  });
});
