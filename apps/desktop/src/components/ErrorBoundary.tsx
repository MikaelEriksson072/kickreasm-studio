import { Component, type ReactNode } from 'react';

/** Keeps one broken panel from taking down the whole window. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  override state: { err: Error | null } = { err: null };
  static getDerivedStateFromError(err: Error) { return { err }; }
  override render() {
    return this.state.err
      ? <div className="notice err">This panel hit an error: {String(this.state.err.message || this.state.err)}. <button className="linkish" onClick={() => this.setState({ err: null })}>Retry</button></div>
      : this.props.children;
  }
}
