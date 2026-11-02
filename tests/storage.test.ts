import { expect, test } from "bun:test";
import {
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { expandBatch, inside } from "../src/storage";
import { validateRow } from "../src/models";
import { fixture, png } from "./helpers";
const spec = () => ({
  schemaVersion: 1 as const,
  name: "portable",
  rows: [{ prompt: "a fox", model: "gpt-image-2.5-flare", count: 2 }],
});
test("matrix expansion validates each model/settings combination and copy counts", () => {
  const rows = expandBatch({
    ...spec(),
    matrix: {
      prompts: ["one", "two"],
      models: ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"],
      settings: [{ quality: "low" }, { quality: "high" }],
    },
  });
  expect(rows.length).toBe(9);
  expect(rows.reduce((s, r) => s + (r.count || 1), 0)).toBe(10);
  expect(() =>
    expandBatch({
      ...spec(),
      rows: [{ prompt: "x", model: "gpt-image-2.5-flare", count: -1 }],
    }),
  ).toThrow();
  expect(() =>
    validateRow({
      prompt: "x",
      model: "flux-3-image",
      settings: { quality: "high" },
    }),
  ).toThrow("Unsupported");
  expect(() =>
    validateRow({
      prompt: "x",
      model: "MAI-Image-2.6",
      settings: { width: 2000, height: 2000 },
    }),
  ).toThrow("MAI");
  expect(() => validateRow({ prompt: "x", model: "Midjourney V8.2" })).toThrow(
    "Unknown",
  );
});
test("inputs snapshot; annotated originals rebuild after moving batch; export collisions preserve originals", () => {
  const f = fixture();
  try {
    const input = join(f.root, "reference.png");
    writeFileSync(input, png);
    const { batch, dir } = f.library.create({
      ...spec(),
      rows: [{ ...spec().rows[0]!, references: [input] }],
    });
    const job = batch.jobs[0]!;
    expect(readFileSync(join(dir, job.references[0]!))).toEqual(png);
    job.outputs = [f.library.saveOutput(dir, batch, job, png, 0)];
    job.status = "completed";
    f.library.save(dir, batch);
    let image = f.library.images()[0]!;
    f.library.annotate(image, { tags: ["fox", "cover"], favorite: true });
    expect(f.library.images("fox cover", true)).toHaveLength(1);
    const moved = join(f.library.root, "renamed");
    renameSync(dir, moved);
    expect(f.library.rebuild()).toBe(1);
    image = f.library.images()[0]!;
    expect(image.favorite).toBe(true);
    expect(image.path.startsWith(moved)).toBe(true);
    const out = join(f.root, "export");
    f.library.export([image], out);
    expect(() => f.library.export([image], out)).toThrow("File exists");
    expect(readFileSync(image.path)).toEqual(png);
    expect(readFileSync(join(out, image.file))).toEqual(png);
  } finally {
    f.close();
  }
});
test("rejects path traversal and non-images; failed validation creates no batch", () => {
  const f = fixture();
  try {
    expect(() => inside(f.root, "../outside")).toThrow();
    writeFileSync(join(f.root, "bad.png"), "not an image");
    expect(() =>
      f.library.create({
        ...spec(),
        rows: [{ ...spec().rows[0]!, references: [join(f.root, "bad.png")] }],
      }),
    ).toThrow("Expected a PNG");
    expect(f.library.batches()).toHaveLength(0);
  } finally {
    f.close();
  }
});
test("one scheduler owns a library at a time", () => {
  const f = fixture();
  try {
    const release = f.library.acquire();
    expect(() => f.library.acquire()).toThrow("Another imagegen");
    release();
    f.library.acquire()();
  } finally {
    f.close();
  }
});
