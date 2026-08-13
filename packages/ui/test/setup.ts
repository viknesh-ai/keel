import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Vitest does not enable testing-library's auto-cleanup unless globals are on.
// Without this, each test inherits the previous test's DOM and `tab()` lands on
// a stale control — failures that look like component bugs but are not.
afterEach(cleanup);

// jsdom implements neither of these, and Radix's floating-element positioning
// needs both. Environment gaps, not component behaviour, so they are stubbed
// rather than asserted on — layout correctness is a Playwright concern.
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}

if (!("DOMRect" in globalThis)) {
  globalThis.DOMRect = class {
    constructor(
      public x = 0,
      public y = 0,
      public width = 0,
      public height = 0,
    ) {}
    top = 0;
    left = 0;
    right = 0;
    bottom = 0;
    toJSON(): unknown {
      return this;
    }
    static fromRect(): DOMRect {
      return new globalThis.DOMRect();
    }
  } as unknown as typeof DOMRect;
}
