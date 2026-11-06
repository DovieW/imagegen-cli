import { test, expect, spyOn } from "bun:test";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";
import { imageInfo } from "@opentui/core";
import {
  DEFAULT_MODEL,
  modelFor,
  describeModel,
  validateRow,
} from "../src/models";
import { mediaMime, decodeGif, svgPng } from "../src/media";
import { preview, rasterize } from "../src/viewer";
import { Providers, HttpError } from "../src/providers";
import { Engine } from "../src/jobs";
import { defaults } from "../src/config";
import { runCli } from "../src/cli";
import { fixture, png } from "./helpers";
import { svg, gifFixture } from "./media-fixtures";
const row = (settings: any = {}) => ({
  prompt: "fox",
  model: DEFAULT_MODEL,
  settings,
});
const auth = { key: async () => "fixture-secret", endpoint: async () => "" };
const signal = () => new AbortController().signal;
function stream(events: any[], truncate = false) {
  const bytes = Buffer.from(
    events.map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join("") +
      (truncate ? 'data: {"type":' : ""),
  );
  let offset = 0;
  return new Response(
    new ReadableStream({
      pull(c) {
        if (offset >= bytes.length) c.close();
        else {
          c.enqueue(bytes.subarray(offset, offset + 7));
          offset += 7;
        }
      },
    }),
    {
      headers: {
        "content-type": "text/event-stream",
        "x-request-id": "req-fixture",
      },
    },
  );
}
const partial = {
  type: "image_generation.partial_image",
  partial_image_index: 0,
  b64_json: png.toString("base64"),
  output_format: "png",
};
const final = {
  type: "image_generation.completed",
  b64_json: png.toString("base64"),
  output_format: "png",
  quality: "medium",
  usage: { output_tokens: 10 },
};
test("2.6 schemas validate quality, nested author options, formats and cross-field constraints", () => {
  expect(
    describeModel(modelFor(DEFAULT_MODEL)).settingsSchema.properties!
      .complexity!.enum,
  ).toEqual(["low", "medium", "high"]);
  validateRow(row({ quality: "max", size: "1536x864", complexity: "low" }));
  validateRow(
    row({
      output_format: "svg",
      svg: { model: "author", reasoning: { effort: "high" } },
    }),
  );
  validateRow({
    ...row({ output_format: "gif", frame_count: 16 }),
    references: ["still.png"],
  });
  for (const settings of [
    { frame_count: 17, output_format: "gif" },
    { output_format: "svg", stream: true },
    { output_format: "gif", partial_images: 1 },
    { background: "transparent", output_format: "jpeg" },
    { output_compression: 5 },
    { partial_images: 1 },
    { size: "17x1024" },
    { svg: { model: "author", typo: 1 }, output_format: "svg" },
  ])
    expect(() => validateRow(row(settings))).toThrow();
  expect(() =>
    validateRow({ ...row({ output_format: "svg" }), references: ["x.png"] }),
  ).toThrow();
  expect(() =>
    validateRow({
      prompt: "fox",
      model: "gpt-image-2",
      settings: { quality: "max" },
    }),
  ).toThrow();
});
test("mask/markup validation, immutable snapshots, nested canonical hashing and changed overlays", () => {
  const f = fixture();
  try {
    const ref = join(f.root, "ref.png"),
      overlay = join(f.root, "overlay.png");
    writeFileSync(ref, png);
    const p = PNG.sync.read(png);
    p.data[3] = 0;
    writeFileSync(overlay, PNG.sync.write(p));
    const spec = {
      schemaVersion: 1 as const,
      name: "edits",
      rows: [{ ...row(), references: [ref], markup: overlay }],
    };
    const first = f.library.createIdempotent(spec, "one");
    expect(readFileSync(join(first.dir, first.batch.jobs[0]!.markup!))).toEqual(
      readFileSync(overlay),
    );
    expect(f.library.createIdempotent(spec, "one").reused).toBe(true);
    p.data[0] = 1;
    writeFileSync(overlay, PNG.sync.write(p));
    expect(() => f.library.createIdempotent(spec, "one")).toThrow(
      "different batch",
    );
    expect(() =>
      f.library.create({
        ...spec,
        rows: [{ ...spec.rows[0]!, mask: overlay }],
      }),
    ).toThrow("mutually exclusive");
    for (let i = 3; i < p.data.length; i += 4) p.data[i] = 255;
    writeFileSync(overlay, PNG.sync.write(p));
    expect(() => f.library.create(spec)).toThrow("transparent");
  } finally {
    f.close();
  }
});
test("SVG and GIF originals, metadata, previews, frames, index rebuilding and export survive", () => {
  const f = fixture();
  try {
    const { dir, batch } = f.library.create({
      schemaVersion: 1,
      name: "formats",
      rows: [row()],
    });
    const j = batch.jobs[0]!;
    j.svgUsage = { model: "author", output_tokens: 20 };
    j.effectiveSettings = { quality: "max" };
    for (const [n, bytes] of [svg, gifFixture()].entries())
      f.library.saveOutput(dir, batch, j, bytes, n);
    const entries = f.library.images();
    expect(entries.map((i) => i.mime).sort()).toEqual([
      "image/gif",
      "image/svg+xml",
    ]);
    for (const image of entries) {
      expect(readFileSync(image.path)).toEqual(
        image.mime === "image/gif" ? gifFixture() : svg,
      );
      expect(
        imageInfo(preview(image, 64, 1, 0.5, 0.5, f.library.state)).width,
      ).toBeGreaterThan(0);
      expect(
        mediaMime(readFileSync(rasterize(image, 0, f.library.state)), true),
      ).toBe("image/png");
      expect(image.svgUsage).toEqual(j.svgUsage);
    }
    expect(f.library.rebuild()).toBe(2);
    expect(f.library.export(entries, join(f.root, "export"))).toHaveLength(4);
    expect(() =>
      svgPng(Buffer.from('<svg><image href="file:///etc/passwd"/></svg>')),
    ).toThrow("self-contained");
  } finally {
    f.close();
  }
});
test("GIF compositing honors restore-previous, restore-background, transparent pixels and timing", () => {
  const clip = decodeGif(gifFixture());
  expect(clip.loops).toBe(0);
  expect(clip.frames.map((f) => f.delay)).toEqual([100, 200, 300, 400]);
  const pixels = clip.frames.map((f) => [
    ...PNG.sync.read(Buffer.from(f.png)).data,
  ]);
  expect(pixels[1]!.slice(0, 4)).toEqual([0, 255, 0, 255]);
  expect(pixels[2]!.slice(0, 4)).toEqual([255, 0, 0, 255]);
  expect(pixels[3]!.slice(4, 8)).toEqual([0, 0, 0, 0]);
  expect(
    [
      ...PNG.sync.read(Buffer.from(decodeGif(gifFixture(false)).frames[3]!.png))
        .data,
    ].slice(4, 8),
  ).toEqual([0, 0, 0, 255]);
});
test("provider serializes markup, nested SVG and normalized GIF controls and captures separate usage", async () => {
  const f = fixture();
  try {
    let sent: any;
    const p = new Providers(auth, (async (_: any, init: any) => {
      sent = init.body instanceof FormData ? init.body : JSON.parse(init.body);
      return Response.json({
        data: [{ b64_json: svg.toString("base64") }],
        output_format: "svg",
        svg_usage: { output_tokens: 5 },
      });
    }) as unknown as typeof fetch);
    const { dir, batch } = f.library.create({
      schemaVersion: 1,
      name: "p",
      rows: [row({ output_format: "svg", svg: { model: "author" } })],
    });
    const result = await p.submit(batch.jobs[0]!, dir, signal());
    expect(sent.svg.model).toBe("author");
    expect(result.results![0]).toStartWith("data:image/svg+xml");
    expect(result.svgUsage).toEqual({ output_tokens: 5 });
    const job = {
      ...batch.jobs[0]!,
      settings: { output_format: "gif", frame_duration_ms: 207 },
    };
    await p.submit(job, dir, signal());
    expect(sent.frame_duration_ms).toBe(210);
    const ref = join(f.root, "ref.png"),
      mask = join(f.root, "mask.png");
    writeFileSync(ref, png);
    const rgba = PNG.sync.read(png);
    rgba.data[3] = 0;
    writeFileSync(mask, PNG.sync.write(rgba));
    const edit = f.library.create({
      schemaVersion: 1,
      name: "edit",
      rows: [{ ...row(), references: [ref], markup: mask }],
    });
    await p.submit(edit.batch.jobs[0]!, edit.dir, signal());
    expect(sent.get("markup")).toBeInstanceOf(File);
  } finally {
    f.close();
  }
});
test("fragmented streams deliver previews, final bytes and request metadata without waiting for EOF", async () => {
  const f = fixture();
  try {
    const p = new Providers(auth, (async () =>
      stream([partial, final], true)) as unknown as typeof fetch);
    const { dir, batch } = f.library.create({
      schemaVersion: 1,
      name: "stream",
      rows: [row({ stream: true, partial_images: 1 })],
    });
    const previews: any[] = [];
    const result = await p.submit(batch.jobs[0]!, dir, signal(), (e) =>
      previews.push(e),
    );
    expect(previews).toHaveLength(1);
    expect(result.requestId).toBe("req-fixture");
    expect(result.effectiveSettings!.quality).toBe("medium");
    const engine = new Engine(f.library, p, defaults());
    engine.add(dir, batch);
    await engine.idle();
    expect(batch.jobs[0]!.status).toBe("completed");
    expect(f.library.images()).toHaveLength(1);
    expect(batch.jobs[0]!.preview).toBeUndefined();
    await engine.close();
  } finally {
    f.close();
  }
});
test("missing final stream is uncertain, no automatic resubmission; quota errors are not retried", async () => {
  for (const quota of [false, true]) {
    const f = fixture();
    let submissions = 0;
    try {
      const p = new Providers(auth, (async () => {
        submissions++;
        return quota
          ? Response.json(
              {
                error: {
                  code: "insufficient_quota",
                  message: "never-display-secret",
                },
              },
              { status: 429, headers: { "x-request-id": "req-quota" } },
            )
          : stream([partial]);
      }) as unknown as typeof fetch);
      const { dir, batch } = f.library.create({
        schemaVersion: 1,
        name: "failure",
        rows: [row({ stream: true })],
      });
      const engine = new Engine(f.library, p, defaults());
      engine.add(dir, batch);
      await engine.idle();
      expect(submissions).toBe(1);
      expect(batch.jobs[0]!.status).toBe(quota ? "failed" : "uncertain");
      expect(f.library.images()).toHaveLength(0);
      if (quota) {
        expect(batch.jobs[0]!.errorCode).toBe("insufficient_quota");
        expect(batch.jobs[0]!.error).not.toContain("secret");
      }
      await engine.close();
    } finally {
      f.close();
    }
  }
});
test("CLI validates dry-run files and exposes new defaults, discovery and format filters", async () => {
  const f = fixture(),
    lines: any[] = [];
  const log = spyOn(console, "log").mockImplementation((s) =>
    lines.push(JSON.parse(s)),
  );
  try {
    await runCli(
      ["generate", "--prompt", "fox", "--dry-run", "--json"],
      f.library,
    );
    expect(lines.at(-1).data.rows[0].model).toBe(DEFAULT_MODEL);
    await expect(
      runCli(
        [
          "generate",
          "--prompt",
          "fox",
          "--ref",
          "/missing-fixture.png",
          "--dry-run",
          "--json",
        ],
        f.library,
      ),
    ).rejects.toThrow();
    await runCli(["models", DEFAULT_MODEL, "--json"], f.library);
    expect(lines.at(-1).data.settingsSchema.properties.svg).toBeDefined();
    await runCli(["library", "--format", "svg", "--json"], f.library);
    expect(f.library.batches()).toHaveLength(0);
  } finally {
    log.mockRestore();
    f.close();
  }
});
test("stream cancellation preserves uncertainty; concurrent streams keep previews isolated", async () => {
  const f = fixture();
  try {
    let submitted = 0;
    const observed = new Map<string, string>();
    const p = new Providers(auth, (async () => {
      const number = submitted++;
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(Buffer.from(`data: ${JSON.stringify(partial)}\n\n`));
            setTimeout(
              () => {
                c.enqueue(Buffer.from(`data: ${JSON.stringify(final)}\n\n`));
                c.close();
              },
              40 + number * 20,
            );
          },
        }),
      );
    }) as unknown as unknown as typeof fetch);
    const { dir, batch } = f.library.create({
      schemaVersion: 1,
      name: "concurrent",
      rows: [{ ...row({ stream: true }), count: 2 }],
    });
    const engine = new Engine(f.library, p, defaults());
    engine.on("change", () => {
      for (const j of batch.jobs)
        if (j.preview) observed.set(j.id, j.preview.path);
    });
    engine.add(dir, batch);
    await engine.idle();
    expect(submitted).toBe(2);
    expect(observed.size).toBe(2);
    expect(new Set(observed.values()).size).toBe(2);
    expect(f.library.images()).toHaveLength(2);
    await engine.close();
    let cancelled = false;
    const blocked = new Providers(
      auth,
      (async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(Buffer.from(`data: ${JSON.stringify(partial)}\n\n`));
            },
            cancel() {
              cancelled = true;
            },
          }),
        )) as unknown as unknown as typeof fetch,
    );
    const controller = new AbortController();
    const task = blocked.submit(batch.jobs[0]!, dir, controller.signal, () =>
      controller.abort(),
    );
    await expect(task).rejects.toThrow();
    expect(cancelled).toBe(true);
  } finally {
    f.close();
  }
});
test("JSONL preview paths are distinct events and never include base64 payloads", async () => {
  const f = fixture(),
    lines: any[] = [];
  const log = spyOn(console, "log").mockImplementation((s) =>
    lines.push(JSON.parse(s)),
  );
  try {
    const p = new Providers(
      auth,
      (async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(Buffer.from(`data: ${JSON.stringify(partial)}\n\n`));
              setTimeout(() => {
                c.enqueue(Buffer.from(`data: ${JSON.stringify(final)}\n\n`));
                c.close();
              }, 180);
            },
          }),
        )) as unknown as unknown as typeof fetch,
    );
    await runCli(
      [
        "generate",
        "--prompt",
        "fox",
        "--settings",
        '{"stream":true}',
        "--jsonl",
      ],
      f.library,
      { engineFactory: (l) => new Engine(l, p, defaults()) },
    );
    const event = lines.find((l) => l.event === "preview");
    expect(event.data.path).toStartWith(f.library.state);
    expect(mediaMime(readFileSync(event.data.path), true)).toBe("image/png");
    expect(lines.at(-1).ok).toBe(true);
    expect(JSON.stringify(lines)).not.toContain(png.toString("base64"));
  } finally {
    log.mockRestore();
    f.close();
  }
});
test("nested SVG settings with different key order deduplicate and agent rasterization returns usable PNG", async () => {
  const f = fixture(),
    lines: any[] = [];
  const log = spyOn(console, "log").mockImplementation((s) =>
    lines.push(JSON.parse(s)),
  );
  try {
    const a = {
      schemaVersion: 1 as const,
      name: "vector",
      rows: [
        row({
          output_format: "svg",
          svg: { model: "author", reasoning: { effort: "high" } },
        }),
      ],
    };
    const first = f.library.createIdempotent(a, "nested");
    const b = {
      ...a,
      rows: [
        row({
          svg: { reasoning: { effort: "high" }, model: "author" },
          output_format: "svg",
        }),
      ],
    };
    expect(f.library.createIdempotent(b, "nested").reused).toBe(true);
    f.library.saveOutput(first.dir, first.batch, first.batch.jobs[0]!, svg, 0);
    const image = f.library.images()[0]!;
    await runCli(["rasterize", image.id, "--json"], f.library);
    expect(mediaMime(readFileSync(lines.at(-1).data.path), true)).toBe(
      "image/png",
    );
    expect(lines.at(-1).data.sourceImageId).toBe(image.id);
  } finally {
    log.mockRestore();
    f.close();
  }
});

test("unknown inherited-property settings and damaged raster files fail before batch creation", () => {
  expect(() => validateRow(row(JSON.parse('{"toString":"bad"}')))).toThrow(
    "Unsupported",
  );
  const f = fixture();
  try {
    const path = join(f.root, "broken.png");
    writeFileSync(path, png.subarray(0, 12));
    expect(() =>
      f.library.create({
        schemaVersion: 1,
        name: "broken",
        rows: [{ ...row(), references: [path] }],
      }),
    ).toThrow();
    expect(f.library.batches()).toHaveLength(0);
  } finally {
    f.close();
  }
});
