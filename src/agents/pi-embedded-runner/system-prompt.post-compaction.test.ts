import { describe, expect, it } from "vitest";
import { buildAgentSystemPrompt } from "../system-prompt.js";

describe("Post-Compaction Recovery", () => {
  it("does NOT include a static recovery section (handled by framework injection)", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
    });

    // Recovery instructions are injected dynamically via post-compaction-recovery.ts,
    // not baked into the system prompt (avoids wasting tokens on every turn).
    expect(prompt).not.toContain("## Post-Compaction Recovery");
  });
});
