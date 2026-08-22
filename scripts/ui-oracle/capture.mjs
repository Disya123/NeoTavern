/**
 * Chromium-side capture adapter. It observes only explicit `data-ui-*` nodes;
 * it never serializes a React fiber, DOM subtree, or browser object into the
 * portable Rust blueprint.
 *
 * Pending strict-import boundary: this adapter captures authored
 * `::before`/`::after` declarations via stylesheet inspection, but does not
 * capture resolved computed styles for those pseudo-elements
 * (`getComputedStyle(element, '::before')`). A strict import cannot silently
 * lose pseudo data, so any future pseudo-element style support must either
 * capture both authored and resolved layers or explicitly reject them.
 */

function implicitRole(element) {
  if (element.tagName === 'BUTTON') return 'button';
  if (element.tagName === 'INPUT') {
    return element.getAttribute('type') === 'search' ? 'searchbox' : 'textbox';
  }
  if (element.tagName === 'SELECT') return 'combobox';
  return undefined;
}

/**
 * Extract an annotated UI capture. `computedStyleProperties` must be the
 * whitelist exported by the presentation contract; passing an ad-hoc property
 * list is intentionally left to the strict normalizer to reject.
 */
export async function captureAnnotatedUi(page, options) {
  const {
    rootSelector,
    fixtureId,
    viewportClass,
    state,
    viewport,
    computedStyleProperties,
    actionTrace = [],
    raster,
  } = options;
  const captured = await page.evaluate(
    ({ selector, properties, trace }) => {
      const root = document.querySelector(selector);
      if (!root) throw new Error(`UI oracle root not found: ${selector}`);
      if (!root.matches('[data-ui-node][data-ui-component]')) {
        throw new Error('UI oracle root must declare data-ui-node and data-ui-component');
      }

      const declarationsFor = (element) => {
        const declarations = [];
        const visitRules = (rules, conditions) => {
          for (const rule of Array.from(rules)) {
            if (rule.cssRules) {
              const constructorName = rule.constructor?.name;
              let nestedConditions = conditions;
              if (constructorName === 'CSSMediaRule') {
                nestedConditions = [...conditions, `@media ${rule.conditionText}`];
              } else if (constructorName === 'CSSContainerRule') {
                nestedConditions = [...conditions, `@container ${rule.conditionText}`];
              } else if (constructorName === 'CSSSupportsRule') {
                nestedConditions = [...conditions, `@supports ${rule.conditionText}`];
              }
              visitRules(rule.cssRules, nestedConditions);
              continue;
            }
            if (typeof rule.selectorText !== 'string' || !rule.style) continue;
            const pseudoMatch = /::(before|after)\b/i.exec(rule.selectorText);
            const pseudo = pseudoMatch?.[1]?.toLowerCase();
            const matchSelector = pseudo
              ? rule.selectorText.replace(/::(before|after)\b/gi, '')
              : rule.selectorText;
            let matches = false;
            try {
              matches = element.matches(matchSelector);
            } catch {
              throw new Error(`UI oracle cannot evaluate selector: ${rule.selectorText}`);
            }
            if (!matches) continue;
            for (const property of Array.from(rule.style)) {
              declarations.push({
                property,
                value: rule.style.getPropertyValue(property).trim(),
                selector: rule.selectorText,
                conditions,
                ...(pseudo === 'before' || pseudo === 'after' ? { pseudo } : {}),
              });
            }
          }
        };
        for (const styleSheet of Array.from(document.styleSheets)) {
          try {
            visitRules(styleSheet.cssRules, []);
          } catch (error) {
            throw new Error(
              `UI oracle cannot inspect stylesheet ${styleSheet.href ?? '<inline>'}: ${String(error)}`,
            );
          }
        }
        return declarations;
      };

      const annotatedNodes = Array.from(
        new Set([root, ...root.querySelectorAll('[data-ui-node][data-ui-component]')]),
      );

      // Resolve stable unique nodeIds. Elements with `data-ui-key` get a
      // disambiguated ID like `character-card.<character-id>` to prevent
      // PRESENTATION_CAPTURE_DUPLICATE_NODE. The same resolved IDs must be
      // used for parentNodeId and actionTrace references.
      /** @type {Map<Element, string>} */
      const resolvedId = new Map();
      for (const element of annotatedNodes) {
        const base = element.getAttribute('data-ui-node');
        const key = element.getAttribute('data-ui-key');
        const resolved = key ? `${base}.${key}` : base;
        resolvedId.set(element, resolved);
      }
      /** @type {Map<Element, string | null>} */
      const resolvedParent = new Map();
      for (const element of annotatedNodes) {
        const parent = element.parentElement?.closest('[data-ui-node]');
        if (!parent) {
          resolvedParent.set(element, null);
          continue;
        }
        const parentResolved = resolvedId.get(parent);
        if (parentResolved) {
          resolvedParent.set(element, parentResolved);
        } else {
          const parentBase = parent.getAttribute('data-ui-node');
          const parentKey = parent.getAttribute('data-ui-key');
          resolvedParent.set(element, parentKey ? `${parentBase}.${parentKey}` : parentBase);
        }
      }

      const nodes = annotatedNodes.map((element, order) => {
        const rect = element.getBoundingClientRect();
        const computed = getComputedStyle(element);
        const computedStyle = Object.fromEntries(
          properties.map((property) => [property, computed.getPropertyValue(property).trim()]),
        );
        const input = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
        const selected = element.getAttribute('aria-selected') === 'true';
        const expanded = element.getAttribute('aria-expanded') === 'true';
        const checked =
          element.getAttribute('aria-checked') === 'true' ||
          (element instanceof HTMLInputElement && element.checked);
        const parentId = resolvedParent.get(element);
        return {
          nodeId: resolvedId.get(element),
          ...(parentId ? { parentNodeId: parentId } : {}),
          order,
          component: element.getAttribute('data-ui-component'),
          ...(element.getAttribute('data-ui-bind')
            ? { binding: element.getAttribute('data-ui-bind') }
            : {}),
          states: (element.getAttribute('data-ui-state') ?? '').split(/\s+/).filter(Boolean),
          actions: (element.getAttribute('data-ui-action') ?? '').split(/\s+/).filter(Boolean),
          semantic: {
            ...(element.getAttribute('role') || implicitRole(element)
              ? { role: element.getAttribute('role') ?? implicitRole(element) }
              : {}),
            ...(element.getAttribute('aria-label')
              ? { name: element.getAttribute('aria-label') }
              : {}),
            ...(input ? { value: element.value } : {}),
            ...(element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true'
              ? { disabled: true }
              : {}),
            ...(selected ? { selected: true } : {}),
            ...(expanded ? { expanded: true } : {}),
            ...(checked ? { checked: true } : {}),
          },
          bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          computedStyle,
          authoredDeclarations: declarationsFor(element),
        };
      });
      // Build a string map for actionTrace remapping: raw base -> resolved,
      // and resolved -> resolved (identity) so traces already using stable IDs
      // remain valid. When a raw base is shared by multiple elements with
      // different keys, the first encountered resolved ID wins; callers that
      // trace a repeated element must provide the disambiguated ID.
      const stringIdMap = new Map();
      for (const [element, resolved] of resolvedId) {
        const base = element.getAttribute('data-ui-node');
        if (base && !stringIdMap.has(base)) stringIdMap.set(base, resolved);
        stringIdMap.set(resolved, resolved);
        // Also map base.key form explicitly if caller used that form.
        const key = element.getAttribute('data-ui-key');
        if (key) stringIdMap.set(`${base}.${key}`, resolved);
      }
      const resolvedTrace = Array.isArray(trace)
        ? trace.map((step) => ({
            ...step,
            nodeId: stringIdMap.get(step.nodeId) ?? step.nodeId,
          }))
        : trace;
      return {
        rootNodeId: resolvedId.get(root) ?? root.getAttribute('data-ui-node'),
        nodes,
        actionTrace: resolvedTrace,
      };
    },
    { selector: rootSelector, properties: computedStyleProperties, trace: actionTrace },
  );

  return {
    format: 'neotavern.capture.v1',
    fixtureId,
    surfaceId: 'character-manager',
    state,
    viewportClass,
    viewport,
    rootNodeId: captured.rootNodeId,
    nodes: captured.nodes,
    actionTrace: captured.actionTrace ?? actionTrace,
    ...(raster ? { raster } : {}),
  };
}
