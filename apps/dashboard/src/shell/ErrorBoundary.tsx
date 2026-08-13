import { Button } from "@keel/ui";
import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { readonly children: ReactNode };
type State = { readonly error: Error | null };

/**
 * The last line of defence. A render error must not leave a blank page — an
 * operator needs to know something broke and be able to get back.
 *
 * Deliberately not reporting the stack to the user: it is logged for the
 * console and will go to OTel in slice 8, but a stack trace on screen is noise
 * to the person reading it and information to anyone else.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("dashboard render error", error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;

    return (
      <div className="d-error" role="alert">
        <h1 className="d-error__title">Something broke while rendering this screen.</h1>
        <p className="d-error__body">
          The error was logged. Reloading usually clears it; if it does not, the run detail is still
          readable through the API.
        </p>
        <Button variant="primary" onClick={() => window.location.reload()}>
          Reload
        </Button>
      </div>
    );
  }
}
