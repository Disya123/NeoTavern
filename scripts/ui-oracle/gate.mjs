/**
 * Deterministic four-dimension UI oracle comparator.
 *
 * Both sides provide a CaptureBundle-shaped artifact. The Chromium source and
 * a future native candidate therefore compare semantics, geometry, gestures,
 * and raster evidence without a human "looks close" approval step.
 */

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    const record = value;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, stableValue(record[key])]),
    );
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function nodeIndex(bundle) {
  return new Map((bundle.nodes ?? []).map((node) => [node.nodeId, node]));
}

function semanticProjection(node) {
  return {
    nodeId: node.nodeId,
    parentNodeId: node.parentNodeId ?? null,
    order: node.order,
    component: node.component,
    binding: node.binding ?? null,
    states: [...(node.states ?? [])].sort(),
    actions: [...(node.actions ?? [])].sort(),
    semantic: node.semantic ?? {},
  };
}

function layoutProjection(node) {
  return {
    nodeId: node.nodeId,
    bounds: node.bounds,
  };
}

function compareProjection(kind, oracle, candidate, failures) {
  const oracleNodes = nodeIndex(oracle);
  const candidateNodes = nodeIndex(candidate);
  for (const [nodeId, oracleNode] of oracleNodes) {
    const candidateNode = candidateNodes.get(nodeId);
    if (!candidateNode) {
      failures.push({ code: `${kind.toUpperCase()}_NODE_MISSING`, nodeId });
      continue;
    }
    const projection = kind === 'semantic' ? semanticProjection : layoutProjection;
    if (stableJson(projection(oracleNode)) !== stableJson(projection(candidateNode))) {
      failures.push({ code: `${kind.toUpperCase()}_MISMATCH`, nodeId });
    }
  }
  for (const nodeId of candidateNodes.keys()) {
    if (!oracleNodes.has(nodeId)) {
      failures.push({ code: `${kind.toUpperCase()}_NODE_EXTRA`, nodeId });
    }
  }
}

/**
 * Compare all four independent UI oracle dimensions. Raster comparison is
 * intentionally exact for v1: same renderer path and deterministic fixture
 * must produce an identical PNG hash. A future explicitly approved tolerance
 * policy belongs in a versioned evidence schema, never in an implicit visual
 * judgement.
 */
export function compareUiOracleEvidence(oracle, candidate) {
  const failures = [];
  compareProjection('semantic', oracle, candidate, failures);
  compareProjection('layout', oracle, candidate, failures);

  if (stableJson(oracle.actionTrace ?? []) !== stableJson(candidate.actionTrace ?? [])) {
    failures.push({ code: 'ACTION_TRACE_MISMATCH' });
  }

  const oracleRaster = oracle.raster;
  const candidateRaster = candidate.raster;
  if (!oracleRaster || !candidateRaster) {
    failures.push({ code: 'RASTER_EVIDENCE_MISSING' });
  } else if (
    oracleRaster.width !== candidateRaster.width ||
    oracleRaster.height !== candidateRaster.height ||
    oracleRaster.sha256 !== candidateRaster.sha256
  ) {
    failures.push({ code: 'RASTER_MISMATCH' });
  }

  return { ok: failures.length === 0, failures };
}
