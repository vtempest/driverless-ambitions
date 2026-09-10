/* global globalThis */
/**
 * @xviz/io sniffs a message's container with `data instanceof Buffer`, and
 * `Buffer` is a Node global that does not exist in a browser — the reference
 * throws a ReferenceError before the check can return false, which surfaces as
 * "Buffer is not defined" the moment the first XVIZ message arrives. Upstream
 * never hit this because webpack 4 injected Node polyfills automatically; Vite
 * deliberately ships none.
 *
 * A stub class is the whole fix. Nothing in a browser is ever a Node Buffer, so
 * `instanceof` against a class with no instances gives exactly the right answer
 * — and it costs nothing next to bundling the real `buffer` package for one
 * type test.
 */
if (typeof globalThis.Buffer === 'undefined') {
  globalThis.Buffer = class Buffer {};
}
