import type { ReactElement } from 'react';

declare global {
  namespace JSX {
    interface Element extends ReactElement {}
  }
}

export {};
