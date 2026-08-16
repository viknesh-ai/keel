import { TextDecoder, TextEncoder } from "node:util";
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// jsdom installs its own TextEncoder, whose output is a Uint8Array from the
// jsdom realm — so `instanceof Uint8Array` is false in Node's realm and any
// library that checks it (jose, here) rejects perfectly good bytes. Only the
// tests are affected: the widget never signs anything, and the code that does
// runs in Node. Swapping in Node's implementation is the narrowest fix.
globalThis.TextEncoder = TextEncoder as unknown as typeof globalThis.TextEncoder;
globalThis.TextDecoder = TextDecoder as unknown as typeof globalThis.TextDecoder;
// And the constructor itself, for the same reason: the global binding jsdom
// leaves in place matches nothing either realm actually produces.
globalThis.Uint8Array = new TextEncoder().encode("").constructor as Uint8ArrayConstructor;

// jsdom implements no layout, so it ships no Element.scrollTo. Stubbed here
// rather than guarded in the component: every browser the widget targets has
// it, and adding an optional call to production code to satisfy a test
// environment is how components end up defending against conditions that
// cannot occur.
if (typeof Element.prototype.scrollTo !== "function") {
  Element.prototype.scrollTo = () => undefined;
}

afterEach(cleanup);
