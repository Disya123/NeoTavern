import { Component, type ErrorInfo, type ReactNode } from 'react';

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** Optional custom fallback. Receives the error and a reset callback. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  /** Name for diagnostics (which region crashed). */
  name?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Region-level error boundary. Every major app region and every plugin gets
 * its own boundary so a crash in one does not take down the whole app
 * (AGENTS.md §13).
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Log with region context; no secrets are involved here.
    console.error(`[ErrorBoundary:${this.props.name ?? 'unknown'}]`, error, info.componentStack);
  }

  private reset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (error) {
      if (this.props.fallback) return this.props.fallback(error, this.reset);
      return (
        <div data-component="error-boundary" role="alert" className="st-error-boundary">
          <p>Something went wrong in this section.</p>
          <button data-component="button" type="button" onClick={this.reset}>
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
