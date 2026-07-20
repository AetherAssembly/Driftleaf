import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button, Card } from "@aetherAssembly/ui";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

// Catches crashes anywhere in the render tree so a bug in one component shows a recoverable
// dialog instead of a blank window — there's no server to report to, so "reload" is the fix.
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Unhandled error in renderer:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="error-boundary">
          <Card header={<h1>Something went wrong</h1>}>
            <p>Driftleaf hit an unexpected error. Your notes are safe on disk.</p>
            <pre className="error-boundary__message">{this.state.error.message}</pre>
            <div className="modal-actions">
              <Button variant="primary" onClick={() => window.location.reload()}>
                Reload
              </Button>
            </div>
          </Card>
        </div>
      );
    }
    return this.props.children;
  }
}
