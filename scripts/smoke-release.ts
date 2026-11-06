import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { CLI_VERSION } from "../src/protocol";
import { Library } from "../src/storage";
import { mediaMime } from "../src/media";
import { svg, gifFixture } from "../tests/media-fixtures";
const root = mkdtempSync(join(tmpdir(), "imagegen-release-"));
const binary = resolve(process.argv[2] || "dist/imagegen");
const env = {
  ...process.env,
  IMAGEGEN_ROOT: join(root, "images"),
  IMAGEGEN_STATE_DIR: join(root, "state"),
  IMAGEGEN_CONFIG_DIR: join(root, "config"),
};
const library = new Library(env.IMAGEGEN_ROOT, env.IMAGEGEN_STATE_DIR);
function run(args: string[]) {
  const p = Bun.spawnSync([binary, ...args, "--json"], {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (p.exitCode) throw new Error(`Standalone failed: ${p.stderr.toString()}`);
  const value = JSON.parse(p.stdout.toString());
  if (!value.ok) throw new Error("Standalone returned error");
  return value.data;
}
try {
  if (run(["version"]).version !== CLI_VERSION)
    throw new Error("Incorrect release version");
  if (!run(["models", "gpt-image-2.6-flare"]).settingsSchema.properties.svg)
    throw new Error("Missing SVG discovery");
  const { dir, batch } = library.create({
    schemaVersion: 1,
    name: "Release smoke",
    rows: [{ model: "gpt-image-2.6-flare", prompt: "fixture" }],
  });
  library.saveOutput(dir, batch, batch.jobs[0]!, svg, 0);
  library.saveOutput(dir, batch, batch.jobs[0]!, gifFixture(), 1);
  for (const image of library.images()) {
    const result = run([
      "rasterize",
      image.id,
      ...(image.mime === "image/gif" ? ["--frame", "1"] : []),
    ]);
    if (mediaMime(readFileSync(result.path), true) !== "image/png")
      throw new Error("Missing standalone decoder assets");
  }
  run([
    "generate",
    "--prompt",
    "fixture",
    "--settings",
    '{"output_format":"gif","frame_count":16}',
    "--dry-run",
  ]);
  if (run(["library", "--format", "svg"]).items.length !== 1)
    throw new Error("Format filter failed");
  console.log(
    "Standalone smoke passed: version, schema, SVG/GIF conversion, dry-run, format filter (isolated cwd).",
  );
} finally {
  library.close();
  rmSync(root, { recursive: true, force: true });
}
