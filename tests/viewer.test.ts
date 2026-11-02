import { expect, test } from "bun:test";
import { imageInfo } from "@opentui/core";
import { preview } from "../src/viewer";
import { fixture, png } from "./helpers";
test("thumbnail cache and zoom crop preserve original bytes", () => {
  const f = fixture();
  try {
    const { dir, batch } = f.library.create({
      schemaVersion: 1,
      name: "view",
      rows: [{ prompt: "x", model: "gpt-image-2.5-flare" }],
    });
    f.library.saveOutput(dir, batch, batch.jobs[0]!, png, 0);
    const i = f.library.images()[0]!;
    const thumb = preview(i, 8, 1, 0.5, 0.5, f.library.state),
      zoom = preview(i, 8, 2, 0.5, 0.5, f.library.state);
    expect(imageInfo(thumb).width).toBe(8);
    expect(imageInfo(zoom).width).toBe(8);
    expect(i.bytes).toBe(png.length);
    expect(preview(i, 8, 1, 0.5, 0.5, f.library.state)).toEqual(thumb);
  } finally {
    f.close();
  }
});
