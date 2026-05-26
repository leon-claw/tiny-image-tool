import { describe, expect, it } from "vitest";
import { formatBytes, toQueueItems, totalBytes } from "./utils";

describe("utils", () => {
  it("formats bytes for compact display", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(10_500_000)).toBe("10.5 MB");
  });

  it("deduplicates files already in the queue", () => {
    const items = toQueueItems(
      [
        { path: "/a.png", name: "a.png", extension: "png", size: 100, isCompressed: false },
        { path: "/b.png", name: "b.png", extension: "png", size: 200, isCompressed: false },
      ],
      [{ id: "/a.png", path: "/a.png", name: "a.png", extension: "png", size: 100, isCompressed: false, selected: false, status: "queued" }],
    );

    expect(items).toHaveLength(1);
    expect(items[0].path).toBe("/b.png");
  });

  it("totals optional compressed sizes", () => {
    expect(
      totalBytes(
        [
          { id: "a", path: "a", name: "a", extension: "png", size: 100, isCompressed: false, selected: false, compressedSize: 20, status: "done" },
          { id: "b", path: "b", name: "b", extension: "png", size: 100, isCompressed: false, selected: false, status: "queued" },
        ],
        "compressedSize",
      ),
    ).toBe(20);
  });
});
