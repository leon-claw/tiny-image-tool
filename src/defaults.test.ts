import { describe, expect, it } from "vitest";
import { DEFAULT_PROVIDER, defaultConfig, defaultOptions, optionsFromConfig } from "./defaults";

describe("defaults", () => {
  it("uses Tinify and Chinese by default", () => {
    expect(DEFAULT_PROVIDER).toBe("Tinify");
    expect(defaultConfig.language).toBe("zh");
  });

  it("keeps ComfyUI workflow preservation enabled from persisted config by default", () => {
    expect(defaultConfig.preserveComfyWorkflow).toBe(true);
    expect(defaultOptions.preserveComfyWorkflow).toBe(true);
    expect(optionsFromConfig(defaultConfig).preserveComfyWorkflow).toBe(true);
  });
});
