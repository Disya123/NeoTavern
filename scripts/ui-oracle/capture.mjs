/**
 * Chromium-side capture adapter. It observes only explicit `data-ui-*` nodes;
 * it never serializes a React fiber, DOM subtree, or browser object into the
 * portable Rust blueprint.
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
    ({ selector, properties }) => {
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
      const nodes = annotatedNodes.map(
        (element, order) => {
          const rect = element.getBoundingClientRect();
          const computed = getComputedStyle(element);
          const computedStyle = Object.fromEntries(
            properties.map((property) => [property, computed.getPropertyValue(property).trim()]),
          );
          const parent = element.parentElement?.closest('[data-ui-node]');
          const input =
            element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
          const selected = element.getAttribute('aria-selected') === 'true';
          const expanded = element.getAttribute('aria-expanded') === 'true';
          const checked =
            element.getAttribute('aria-checked') === 'true' ||
            (element instanceof HTMLInputElement && element.checked);
          return {
            nodeId: element.getAttribute('data-ui-node'),
            ...(parent ? { parentNodeId: parent.getAttribute('data-ui-node') } : {}),
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
              ...(element.hasAttribute('disabled') ||
              element.getAttribute('aria-disabled') === 'true'
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
        },
      );
      return { rootNodeId: root.getAttribute('data-ui-node'), nodes };
    },
    { selector: rootSelector, properties: computedStyleProperties },
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
    actionTrace,
    ...(raster ? { raster } : {}),
  };
}
