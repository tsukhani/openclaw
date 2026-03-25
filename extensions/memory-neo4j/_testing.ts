/**
 * L5: Test-only re-exports — separated from index.ts to keep the public API clean.
 * Test files should import from "./_testing.js" instead of "./index.js".
 */
export { _captureMessage, _runAutoCapture } from "./auto-capture.js";
