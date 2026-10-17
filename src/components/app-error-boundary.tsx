import { Component, type ErrorInfo, type ReactNode } from "react";
import "./app-error-boundary.css";

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  failed: boolean;
}

export class AppErrorBoundary extends Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // The recovery screen deliberately avoids logging potentially sensitive
    // application state. Users can export a redacted diagnostics bundle after restart.
  }

  private reload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    if (!this.state.failed) {
      return this.props.children;
    }

    return (
      <main className="app-error-boundary">
        <section className="app-error-card" role="alert" aria-live="assertive">
          <span className="app-error-kicker">Glee needs a restart</span>
          <h1>Something unexpected interrupted the workspace.</h1>
          <p>
            Your local conversations are still stored on this device. Reload Glee,
            then open Diagnostics &amp; Recovery if the problem happens again.
          </p>
          <button type="button" onClick={this.reload}>
            Reload Glee
          </button>
        </section>
      </main>
    );
  }
}
