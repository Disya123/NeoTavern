import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkNoFlatten,
  checkPassOrder,
  checkRoiCopies,
  EXPECTED_ROI,
  extractCopyImages,
  extractDebugLabels,
  extractNamedResources,
  forbiddenCommands,
} from './m0-d1a-adjudicate.mjs';
import { classifyRenderdocApi } from './m0-d1a-capture-host.mjs';

const ROOT = join(import.meta.dirname, '..');

const fixture = `<?xml version="1.0"?><rdc><header><driver id="8">Vulkan</driver></header>
<chunk name="vkSetDebugUtilsObjectNameEXT">
  <ResourceId name="Object" typename="ResourceId" width="8" important="true">299</ResourceId>
  <string name="ObjectName" typename="string" important="true">m0-d1a-accumulator</string>
</chunk>
<chunk name="vkSetDebugUtilsObjectNameEXT">
  <ResourceId name="Object" typename="ResourceId" width="8" important="true">303</ResourceId>
  <string name="ObjectName" typename="string" important="true">m0-d1a-glass-roi</string>
</chunk>
<chunk name="vkCmdBeginDebugUtilsLabelEXT"><string name="pLabelName">m0-d1a-clear-acc</string></chunk>
<chunk name="vkCmdBeginDebugUtilsLabelEXT"><string name="pLabelName">m0-d1a-blit-pass</string></chunk>
<chunk name="vkCmdBeginDebugUtilsLabelEXT"><string name="pLabelName">m0-d1a-roi-read:1</string></chunk>
<chunk name="vkCmdCopyImage">
  <ResourceId name="srcImage">299</ResourceId>
  <ResourceId name="destImage">303</ResourceId>
  <struct name="srcOffset"><int name="x">24</int><int name="y">40</int></struct>
  <struct name="extent"><uint name="width">140</uint><uint name="height">80</uint></struct>
</chunk>
<chunk name="vkCmdBeginDebugUtilsLabelEXT"><string name="pLabelName">m0-d1a-glass:1</string></chunk>
<chunk name="vkCmdBeginDebugUtilsLabelEXT"><string name="pLabelName">m0-d1a-blit-pass</string></chunk>
<chunk name="vkCmdBeginDebugUtilsLabelEXT"><string name="pLabelName">m0-d1a-blit-pass</string></chunk>
<chunk name="vkCmdBeginDebugUtilsLabelEXT"><string name="pLabelName">m0-d1a-blit-pass</string></chunk>
<chunk name="vkCmdBeginDebugUtilsLabelEXT"><string name="pLabelName">m0-d1a-roi-read:2</string></chunk>
<chunk name="vkCmdCopyImage">
  <ResourceId name="srcImage">299</ResourceId>
  <ResourceId name="destImage">303</ResourceId>
  <struct name="srcOffset"><int name="x">80</int><int name="y">70</int></struct>
  <struct name="extent"><uint name="width">140</uint><uint name="height">80</uint></struct>
</chunk>
<chunk name="vkCmdBeginDebugUtilsLabelEXT"><string name="pLabelName">m0-d1a-glass:2</string></chunk>
</rdc>`;

describe('m0-d1a host adjudicator', () => {
  it('accepts ROI-1 → glass-1 → blit → ROI-2 → glass-2', () => {
    const labels = extractDebugLabels(fixture);
    const order = checkPassOrder(labels);
    expect(order.ok).toBe(true);
    expect(order.blit_mutations_between_glasses).toBe(3);
  });

  it('identifies bounded accumulator → glass-roi copies', () => {
    const names = extractNamedResources(fixture);
    const copies = extractCopyImages(fixture);
    const roi = checkRoiCopies(copies, names);
    expect(roi.ok).toBe(true);
    expect(roi.copies[0]).toMatchObject(EXPECTED_ROI[1]);
    expect(roi.copies[1]).toMatchObject(EXPECTED_ROI[2]);
    expect(checkNoFlatten(extractDebugLabels(fixture), copies, names).ok).toBe(true);
  });

  it('rejects GLES dumps and map-memory', () => {
    const gles =
      '<?xml version="1.0"?><rdc><header><driver id="9">OpenGLES</driver></header></rdc>';
    expect(classifyRenderdocApi(gles).status).toBe('WRONG_API_CAPTURE');
    expect(forbiddenCommands('<chunk name="vkMapMemory"></chunk>')).toContain('vkMapMemory');
  });

  it('keeps the committed host-side PASS record', () => {
    const rec = JSON.parse(
      readFileSync(join(ROOT, 'docs', 'rfc', 'm0-d1a-adjudication.json'), 'utf8'),
    );
    expect(rec.schema).toBe('m0-d1a-adjudication/v1');
    expect(rec.d1a_verdict).toBe('PASS');
    expect(rec.android_gpu_capture).toBe(true);
    expect(rec.capture_driver).toBe('Vulkan');
    expect(rec.capture_admissible).toBe(true);
    expect(rec.environment_blocked).toBe(false);
    expect(rec.d1b).toBe('NOT_STARTED');
    expect(rec.apk_source_commit).toBe('2d72a3cd5ab6684824f411be62173250e9d23398');
    expect(rec.checks.every((row) => row.ok)).toBe(true);
    expect(rec.checks.map((row) => row.id)).toEqual([
      'hashes',
      'driver',
      'pass_order',
      'roi_identity',
      'no_flatten',
      'no_readback',
      'lifetime_and_counters',
    ]);
    const hashes = rec.checks.find((row) => row.id === 'hashes').hashes;
    expect(hashes.rdc.path.startsWith('apps/android/')).toBe(true);
    expect(hashes.rdc.sha256).toBe(
      'd45c45db86c574829527f8d094a7217e112a97184bc8f99ab6c7835474b11259',
    );
    expect(rec.checks.find((row) => row.id === 'lifetime_and_counters').high_water_stable).toBe(
      true,
    );
  });
});
