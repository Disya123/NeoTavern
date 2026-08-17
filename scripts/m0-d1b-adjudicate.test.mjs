import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  D1B_MOTION_TIMELINE_G120,
  GLASS_B_G120,
  GOLDEN_D1B_COUNTERS,
  MOVING_BLIT_G120,
  ROI_READ_2,
  checkD1bPassOrder,
  checkD1bRoiCopies,
  classifyD1bDump,
  parseD1bLogLine,
} from './m0-d1b-adjudicate.mjs';

const ROOT = join(import.meta.dirname, '..');

const goldenLine =
  'm0-d1b gpu_ran=true adapter=Adreno_710 backend=Vulkan software=false devices=1 readbacks=0 xdev=0 roi_copies=1001 raster=4 glass=1001 moving_blits=1000 pass_compiles=1 vello_rebuilds=4 layout_rebuilds=0 ui_rebuilds=0 sampled_gen=999 damage=95x88+96x62 frames=1000 ran_on_android=true capture=false timeline=clear,raster,blit,roi:1,glass:1,raster,blit,raster,blit,moving:g0,roi:2,glass:2:g0,raster,blit capture_timeline=restore,moving:g120,roi:2,glass:2:g120,overlay render_polls=0 capture_polls=1 acc_bytes=1046528 verdict=BLOCKED reason=Android_GPU_ran;_GPU_capture_with_pass/resource_order_is_still_required_for_D1a_PASS';

const fixture = `<?xml version="1.0"?><rdc><header><driver id="8">Vulkan</driver></header>
<chunk name="vkSetDebugUtilsObjectNameEXT">
  <ResourceId name="Object">401</ResourceId>
  <string name="ObjectName">m0-d1a-accumulator</string>
</chunk>
<chunk name="vkSetDebugUtilsObjectNameEXT">
  <ResourceId name="Object">402</ResourceId>
  <string name="ObjectName">m0-d1a-glass-roi</string>
</chunk>
<chunk name="vkSetDebugUtilsObjectNameEXT">
  <ResourceId name="Object">403</ResourceId>
  <string name="ObjectName">m0-d1b-moving</string>
</chunk>
<chunk name="vkCmdBeginDebugUtilsLabelEXT"><string name="pLabelName">m0-d1b-restore-static</string></chunk>
<chunk name="vkCmdBeginDebugUtilsLabelEXT"><string name="pLabelName">m0-d1b-moving-blit:g120</string></chunk>
<chunk name="vkCmdCopyImage">
  <ResourceId name="srcImage">403</ResourceId>
  <ResourceId name="destImage">401</ResourceId>
  <struct name="srcOffset"><int name="x">0</int><int name="y">0</int></struct>
  <struct name="extent"><uint name="width">64</uint><uint name="height">64</uint></struct>
</chunk>
<chunk name="vkCmdBeginDebugUtilsLabelEXT"><string name="pLabelName">m0-d1b-roi-read:2</string></chunk>
<chunk name="vkCmdCopyImage">
  <ResourceId name="srcImage">401</ResourceId>
  <ResourceId name="destImage">402</ResourceId>
  <struct name="srcOffset"><int name="x">95</int><int name="y">88</int></struct>
  <struct name="extent"><uint name="width">96</uint><uint name="height">62</uint></struct>
</chunk>
<chunk name="vkCmdBeginDebugUtilsLabelEXT"><string name="pLabelName">m0-d1b-glass:2:g120</string></chunk>
</rdc>`;

describe('m0-d1b host adjudicator schema', () => {
  it('parses the golden 1000-frame D1b log line', () => {
    const parsed = parseD1bLogLine(goldenLine);
    expect(parsed.ok).toBe(true);
    expect(parsed.values.moving_blits).toBe(GOLDEN_D1B_COUNTERS.moving_blits);
    expect(parsed.values.pass_compiles).toBe(1);
    expect(parsed.values.vello_rebuilds).toBe(4);
    expect(parsed.values.render_polls).toBe(0);
    expect(parsed.values.capture_polls).toBe(1);
    expect(parsed.values.capture_timeline).toBe(D1B_MOTION_TIMELINE_G120);
    expect(parsed.values.capture).toBe(false);
  });

  it('rejects a D1a log line', () => {
    expect(parseD1bLogLine('m0-d1a gpu_ran=true devices=1').ok).toBe(false);
  });

  it('proves moving-blit:g120 → roi:2 → glass:2:g120 and rejects a stale generation', () => {
    const labels = ['m0-d1b-restore-static', MOVING_BLIT_G120, ROI_READ_2, GLASS_B_G120];
    expect(checkD1bPassOrder(labels).ok).toBe(true);
    expect(checkD1bPassOrder([...labels, 'm0-d1b-glass:2:g0']).ok).toBe(false);
    expect(checkD1bPassOrder([ROI_READ_2, MOVING_BLIT_G120, GLASS_B_G120]).ok).toBe(false);
  });

  it('accepts a bounded Glass B ROI after the 64×64 moving blit', () => {
    const names = new Map([
      ['401', 'm0-d1a-accumulator'],
      ['402', 'm0-d1a-glass-roi'],
      ['403', 'm0-d1b-moving'],
    ]);
    const copies = [
      { src: '403', dst: '401', x: 0, y: 0, w: 64, h: 64 },
      { src: '401', dst: '402', x: 95, y: 88, w: 96, h: 62 },
    ];
    expect(checkD1bRoiCopies(copies, names).ok).toBe(true);
    expect(
      checkD1bRoiCopies(
        [
          { src: '403', dst: '401', x: 0, y: 0, w: 64, h: 64 },
          { src: '401', dst: '402', x: 0, y: 0, w: 320, h: 200 },
        ],
        names,
      ).ok,
    ).toBe(false);
  });

  it('classifies a Vulkan dump with the generation-120 chain', () => {
    const dump = classifyD1bDump(fixture);
    expect(dump.ok).toBe(true);
    expect(dump.api.api).toBe('Vulkan');
  });

  it('keeps M0D1bActivity debug-only without a launcher', () => {
    const xml = readFileSync(
      join(ROOT, 'apps', 'android', 'app', 'src', 'debug', 'AndroidManifest.xml'),
      'utf8',
    );
    expect(xml).toContain('M0D1bActivity');
    expect(xml).toContain('android.intent.action.MAIN');
    expect(xml).not.toContain('android.intent.category.LAUNCHER');
    const release = readFileSync(
      join(ROOT, 'apps', 'android', 'app', 'src', 'main', 'AndroidManifest.xml'),
      'utf8',
    );
    expect(release).not.toContain('M0D1bActivity');
  });
});
