// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { ErrorBoundary } from '../src/index.js';
import { render, cleanup, click } from './helpers.js';

beforeEach(() => {
  // ErrorBoundary (and React itself) log crashes; keep test output clean.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

function Bomb({ boom }: { boom: boolean }) {
  if (boom) throw new Error('kaboom');
  return <div data-safe>all good</div>;
}

describe('ErrorBoundary', () => {
  it('renders children untouched when nothing throws', () => {
    const { container } = render(
      <ErrorBoundary name="region">
        <Bomb boom={false} />
      </ErrorBoundary>,
    );
    expect(container.querySelector('[data-safe]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('shows the default fallback when a child crashes and logs the region', () => {
    const { container } = render(
      <ErrorBoundary name="sidebar">
        <Bomb boom />
      </ErrorBoundary>,
    );
    const alert = container.querySelector('[role="alert"]')!;
    expect(alert.getAttribute('data-component')).toBe('error-boundary');
    expect(alert.textContent).toContain('Something went wrong in this section.');
    expect(alert.textContent).toContain('Try again');
    // React logs the crash itself; the boundary must add its region context.
    const logged = vi
      .mocked(console.error)
      .mock.calls.some((args) => String(args[0]).includes('[ErrorBoundary:sidebar]'));
    expect(logged).toBe(true);
  });

  it('recovers when the user retries and the crash is gone', () => {
    let boom = true;
    function Flaky() {
      return <Bomb boom={boom} />;
    }
    const { container } = render(
      <ErrorBoundary name="flaky">
        <Flaky />
      </ErrorBoundary>,
    );
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    boom = false;
    click(container.querySelector('[role="alert"] button')!);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[data-safe]')).not.toBeNull();
  });

  it('uses a custom fallback that receives the error and a reset callback', () => {
    const seen: string[] = [];
    const { container } = render(
      <ErrorBoundary
        name="custom"
        fallback={(error, reset) => {
          seen.push(error.message);
          return (
            <div data-custom>
              broke: {error.message}
              <button type="button" onClick={reset}>
                retry
              </button>
            </div>
          );
        }}
      >
        <Bomb boom />
      </ErrorBoundary>,
    );
    expect(container.querySelector('[data-custom]')!.textContent).toContain('broke: kaboom');
    // React may re-run the render pass internally; every fallback render
    // must receive the original error.
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen.every((message) => message === 'kaboom')).toBe(true);
  });
});
