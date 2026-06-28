import { describe, expect, it } from "vitest";
import { createTranslator, normalizeLanguage } from "./i18n";

describe("i18n", () => {
  it("normalizes unknown languages to Chinese", () => {
    expect(normalizeLanguage("en")).toBe("en");
    expect(normalizeLanguage("fr")).toBe("zh");
    expect(normalizeLanguage(undefined)).toBe("zh");
  });

  it("translates with interpolation and falls back to Chinese text", () => {
    const zh = createTranslator("zh");
    const en = createTranslator("en");

    expect(zh("nav.settings")).toBe("设置");
    expect(en("nav.settings")).toBe("Settings");
    expect(en("toast.filesLoaded", { count: 3 })).toBe("Loaded 3 supported image files.");
  });
});
