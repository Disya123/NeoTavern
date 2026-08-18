import { describe, expect, it } from 'vitest';
import {
  adjudicate,
  checkBlitSamplesRaster,
  checkNamedRasterAndAccumulator,
  evaluateInterop,
  VELLO_LABEL,
} from './shared-device-interop-adjudicate.mjs';
import { extractNamedResources } from './m0-d1a-adjudicate.mjs';

const provenance = { apk_linkage: 'BOUND', evidence_dirty: false };

const interopXml = `<?xml version="1.0"?><rdc><header><driver id="8">Vulkan</driver></header>
<chunk name="vkCreateDevice"><ResourceId name="Device">7</ResourceId></chunk>
<chunk name="vkSetDebugUtilsObjectNameEXT">
  <ResourceId name="Object" typename="ResourceId" width="8" important="true">299</ResourceId>
  <string name="ObjectName" typename="string" important="true">m0-d1a-accumulator</string>
</chunk>
<chunk name="vkSetDebugUtilsObjectNameEXT">
  <ResourceId name="Object" typename="ResourceId" width="8" important="true">301</ResourceId>
  <string name="ObjectName" typename="string" important="true">m0-d1a-vello</string>
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

const interopLog =
  'interop gpu_ran=true adapter=Adreno_(TM)_710 backend=Vulkan software=false devices=1 readbacks=0 xdev=0 image_readbacks=0 timestamp=Unavailable raster_texture_sampled=true shared_identity_match=true capture_ended=true';

describe('shared-device interop host adjudicator', () => {
  it('requires a Vulkan resource chain and never almost-PASS', () => {
    const names = extractNamedResources(interopXml);
    expect(checkNamedRasterAndAccumulator(names).ok).toBe(true);
    expect(names.get('301')).toBe(VELLO_LABEL);
    const record = adjudicate({
      provenance,
      interop: { xml: interopXml, log: interopLog, controlLog: interopLog, provenance },
    });
    expect(record.interop).toBe('PASS');
    expect(record.milestone_b).toBe('STARTED');
    expect(record.almost_pass).toBe(false);
  });

  it('blocks GLES, map-memory, and a second device', () => {
    const gles = evaluateInterop({
      xml: '<?xml version="1.0"?><rdc><header><driver id="9">OpenGLES</driver></header></rdc>',
      log: interopLog,
      provenance,
    });
    expect(gles.status).toBe('BLOCKED');
    const mapped = evaluateInterop({
      xml: interopXml.replace('</rdc>', '<chunk name="vkMapMemory"></chunk></rdc>'),
      log: interopLog,
      provenance,
    });
    expect(mapped.status).toBe('BLOCKED');
    const twoDevices = evaluateInterop({
      xml: interopXml.replace(
        '<chunk name="vkCreateDevice"><ResourceId name="Device">7</ResourceId></chunk>',
        '<chunk name="vkCreateDevice"><ResourceId name="Device">7</ResourceId></chunk><chunk name="vkCreateDevice"><ResourceId name="Device">8</ResourceId></chunk>',
      ),
      log: interopLog,
      provenance,
    });
    expect(twoDevices.status).toBe('BLOCKED');
    expect(checkBlitSamplesRaster(['m0-d1a-glass:1', 'm0-d1a-blit-pass'], new Map()).ok).toBe(
      false,
    );
  });
});
