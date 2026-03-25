import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";

type LoggerModule = typeof import("./logger.js");

const originalGetBuiltinModule = (
  process as NodeJS.Process & { getBuiltinModule?: (id: string) => unknown }
).getBuiltinModule;

async function importBrowserSafeLogger(params?: {
  resolvePreferredOpenClawTmpDir?: ReturnType<typeof vi.fn>;
}): Promise<{
  module: LoggerModule;
  resolvePreferredOpenClawTmpDir: ReturnType<typeof vi.fn>;
}> {
  const resolvePreferredOpenClawTmpDir =
    params?.resolvePreferredOpenClawTmpDir ??
    vi.fn(() => {
      throw new Error("resolvePreferredOpenClawTmpDir should not run during browser-safe import");
    });

  vi.doMock("../infra/tmp-openclaw-dir.js", async () => {
    const actual = await vi.importActual<typeof import("../infra/tmp-openclaw-dir.js")>(
      "../infra/tmp-openclaw-dir.js",
    );
    return {
      ...actual,
      resolvePreferredOpenClawTmpDir,
    };
  });

  Object.defineProperty(process, "getBuiltinModule", {
    configurable: true,
    value: undefined,
  });

  const module = await importFreshModule<LoggerModule>(
    import.meta.url,
    "./logger.js?scope=browser-safe",
  );
  return { module, resolvePreferredOpenClawTmpDir };
}

describe("logging/logger browser-safe import", () => {
  let originalVitest: string | undefined;

  afterEach(() => {
    vi.doUnmock("../infra/tmp-openclaw-dir.js");
    Object.defineProperty(process, "getBuiltinModule", {
      configurable: true,
      value: originalGetBuiltinModule,
    });
    // Restore VITEST env var after browser-safe tests.
    if (originalVitest !== undefined) {
      process.env.VITEST = originalVitest;
    }
  });

  it("does not resolve the preferred temp dir at import time when node fs is unavailable", async () => {
    // Unset VITEST so the browser-safe fallback path is exercised instead of the test-isolation shortcut.
    originalVitest = process.env.VITEST;
    delete process.env.VITEST;
    const { module, resolvePreferredOpenClawTmpDir } = await importBrowserSafeLogger();

    expect(resolvePreferredOpenClawTmpDir).not.toHaveBeenCalled();
    expect(module.DEFAULT_LOG_DIR).toBe("/tmp/openclaw");
    expect(module.DEFAULT_LOG_FILE).toBe("/tmp/openclaw/openclaw.log");
  });

  it("disables file logging when imported in a browser-like environment", async () => {
    originalVitest = process.env.VITEST;
    delete process.env.VITEST;
    const { module, resolvePreferredOpenClawTmpDir } = await importBrowserSafeLogger();

    expect(module.getResolvedLoggerSettings()).toMatchObject({
      level: "silent",
      file: "/tmp/openclaw/openclaw.log",
    });
    expect(module.isFileLogLevelEnabled("info")).toBe(false);
    expect(() => module.getLogger().info("browser-safe")).not.toThrow();
    expect(resolvePreferredOpenClawTmpDir).not.toHaveBeenCalled();
  });
});
