/// <reference types="vite/client" />
import type { KrApi } from '../shared/ipc';

declare global {
  interface Window {
    /** The preload bridge. Undefined when the renderer runs outside Electron (e.g. `vite` in a browser). */
    kr?: KrApi;
  }
}

declare module '*.md?raw' {
  const text: string;
  export default text;
}

export {};
