import { describe, expect, it } from 'vitest';
import {
  adjudicate,
  checkPerf18LabelOrder,
  evaluatePerf18,
  evaluatePerf19,
  evaluatePerf20,
  parsePerf20Frames,
  PERF18_LABELS,
} from './perf-18-20-adjudicate.mjs';

const provenance = { apk_linkage: 'BOUND', evidence_dirty: false };

const perf18Xml = `<?xml version="1.0"?><rdc><header><driver id="8">Vulkan</driver></header>
<chunk name="vkCmdBeginDebugUtilsLabelEXT"><string name="pLabelName">perf18-effect-opacity</string></chunk>
<chunk name="vkCmdBeginDebugUtilsLabelEXT"><string name="pLabelName">perf18-transform</string></chunk>
<chunk name="vkCmdBeginDebugUtilsLabelEXT"><string name="pLabelName">perf18-rounded-clip</string></chunk>
<chunk name="vkCmdBeginDebugUtilsLabelEXT"><string name="pLabelName">perf18-group-target</string></chunk>
<chunk name="vkCmdBeginDebugUtilsLabelEXT"><string name="pLabelName">perf18-backdrop-barrier:1</string></chunk>
<chunk name="vkCmdCopyImage">
  <ResourceId name="srcImage">401</ResourceId>
  <ResourceId name="destImage">402</ResourceId>
  <struct name="srcOffset"><int name="x">80</int><int name="y">160</int></struct>
  <struct name="extent"><uint name="width">96</uint><uint name="height">62</uint></struct>
</chunk>
<chunk name="vkCmdBeginDebugUtilsLabelEXT"><string name="pLabelName">perf18-glass:1:g2</string></chunk>
</rdc>`;

const perf18Log =
  'perf18 gpu_ran=true adapter=Adreno_710 backend=Vulkan software=false devices=1 readbacks=0 xdev=0 pass_compiles=1 layout_rebuilds=0 paint_scene_rebuilds=0 glass_in_opacity=true';

const perf19Xml = `<?xml version="1.0"?><rdc><header><driver id="8">Vulkan</driver></header>
<chunk name="vkCmdBeginDebugUtilsLabelEXT"><string name="pLabelName">perf19-background</string></chunk>
<chunk name="vkCmdBeginDebugUtilsLabelEXT"><string name="pLabelName">perf19-selection-underlay</string></chunk>
<chunk name="vkCmdBeginDebugUtilsLabelEXT"><string name="pLabelName">perf19-glyphs</string></chunk>
</rdc>`;

const perf19Log =
  'perf19 gpu_ran=true backend=Vulkan devices=1 readbacks=0 xdev=0 tiles=3 raster=SelectionOnly glass_roi=1 autoscroll=true shape_calls_after_commit=0 layout_rebuilds_during_drag=0 glyph_rasters_during_drag=0';

function perf20Log(opts = {}) {
  const velocityAfter = opts.velocityAfter ?? 10000;
  const lines = [
    `perf20-commit token=1 velocity_before=10000 velocity_after=${velocityAfter} anchor_before=40 anchor_after=40 hard_clamp=false applied=true deferred=false exact_delta=350 fling_px_s=10000`,
  ];
  for (let i = 0; i < 12; i += 1) {
    const after = i === 4 ? velocityAfter : 10000;
    lines.push(
      `perf20-frame frame_id=${i} scene_epoch=2 geometry_epoch=2 scroll_sequence=1 delta_token=1 visual_offset=0 anchor_screen_position=40 velocity_before=10000 velocity_after=${after} geometry_debt=0 hard_clamp=false layout_rebuilds=0 paint_rebuilds=0 raster_invalidations=0 mixed_epoch=false blank_px=0`,
    );
  }
  lines.push(
    'perf20 gpu_ran=true adapter=Adreno_710 backend=Vulkan software=false devices=1 readbacks=0 xdev=0',
  );
  return lines.join('\n');
}

describe('PERF-18/19/20 host adjudicator', () => {
  it('stamps each criterion independently and never almost-PASS', () => {
    const record = adjudicate({
      provenance,
      perf18: { xml: perf18Xml, log: perf18Log, provenance },
      perf19: {},
      perf20: {},
    });
    expect(record.perf18).toBe('PASS');
    expect(record.perf19).toBe('BLOCKED');
    expect(record.perf20).toBe('BLOCKED');
    expect(record.milestone_b).toBe('STARTED');
    expect(record.almost_pass).toBe(false);
  });

  it('requires PERF-18 ancestor effect labels in order', () => {
    for (const label of PERF18_LABELS) {
      expect(perf18Xml).toContain(label.split(':')[0]);
    }
    expect(checkPerf18LabelOrder(['perf18-glass', 'perf18-effect-opacity']).ok).toBe(false);
    const blocked = evaluatePerf18({
      xml: '<?xml version="1.0"?><rdc><header><driver id="8">Vulkan</driver></header></rdc>',
      log: perf18Log,
      provenance,
    });
    expect(blocked.status).toBe('BLOCKED');
  });

  it('requires selection underlay separate from glyphs', () => {
    const pass = evaluatePerf19({ xml: perf19Xml, log: perf19Log, provenance });
    expect(pass.status).toBe('PASS');
    const blocked = evaluatePerf19({
      xml: perf19Xml,
      log: 'perf19 devices=1 tiles=1 shape_calls_after_commit=4',
      provenance,
    });
    expect(blocked.status).toBe('BLOCKED');
  });

  it('rejects a single-frame PERF-20 trace and a velocity impulse', () => {
    expect(parsePerf20Frames(perf20Log()).length).toBe(12);
    const blocked = evaluatePerf20({
      log: 'perf20-frame frame_id=0 scene_epoch=1 geometry_epoch=1 scroll_sequence=1 delta_token=1 visual_offset=0 anchor_screen_position=0 velocity_before=10000 velocity_after=10000 geometry_debt=0 hard_clamp=false layout_rebuilds=0 paint_rebuilds=0 raster_invalidations=0',
      xml: perf18Xml,
      provenance,
    });
    expect(blocked.status).toBe('BLOCKED');
    const impulse = evaluatePerf20({
      log: perf20Log({ velocityAfter: 12000 }),
      xml: perf18Xml,
      provenance,
    });
    expect(impulse.status).toBe('BLOCKED');
    const pass = evaluatePerf20({ log: perf20Log(), xml: perf18Xml, provenance });
    expect(pass.status).toBe('PASS');
    expect(pass.frames).toBe(12);
  });

  it('keeps Milestone B STARTED when all three pass', () => {
    const record = adjudicate({
      provenance,
      perf18: { xml: perf18Xml, log: perf18Log, provenance },
      perf19: { xml: perf19Xml, log: perf19Log, provenance },
      perf20: { log: perf20Log(), xml: perf18Xml, provenance },
    });
    expect(record.perf18).toBe('PASS');
    expect(record.perf19).toBe('PASS');
    expect(record.perf20).toBe('PASS');
    expect(record.milestone_b).toBe('STARTED');
    expect(record.almost_pass).toBe(false);
  });
});
