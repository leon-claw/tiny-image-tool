import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const content = readFileSync(join(process.cwd(), "site", "src", "content.mdx"), "utf8");

describe("homepage marketing content", () => {
  test("explains the Tinify quota-saving workflow", () => {
    expect(content).toContain("Tinify");
    expect(content).toContain("500 次/月");
    expect(content).toContain("70%");
    expect(content).toContain("智能跳过");
    expect(content).toContain("ComfyUI workflow");
    expect(content).toContain("多个账号");
    expect(content).toContain("自动切换");
  });
});
