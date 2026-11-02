import { NativeImage } from "@opentui/core";
import { PNG } from "pngjs";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateRoot } from "./config";
import type { ImageEntry } from "./types";
export function preview(
  image: ImageEntry,
  width = 640,
  zoom = 1,
  x = 0,
  y = 0,
  state = stateRoot(),
): Uint8Array {
  const dir = join(state, "thumbnails");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(
    dir,
    `${image.hash}-${width}-${zoom.toFixed(2)}-${x.toFixed(2)}-${y.toFixed(2)}.png`,
  );
  if (zoom === 1 && existsSync(path)) return readFileSync(path);
  const original = NativeImage.decode(readFileSync(image.path));
  let crop: NativeImage | undefined, resized: NativeImage | undefined;
  try {
    const w = Math.max(1, Math.floor(original.width / zoom)),
      h = Math.max(1, Math.floor(original.height / zoom));
    crop = original.extract({
      left: Math.round((original.width - w) * x),
      top: Math.round((original.height - h) * y),
      width: w,
      height: h,
    });
    const ratio = Math.min(1, width / crop.width, 2048 / crop.height);
    resized = crop.resize({
      width: Math.max(1, Math.round(crop.width * ratio)),
      height: Math.max(1, Math.round(crop.height * ratio)),
    });
    const raw = resized.raw();
    const png = new PNG({ width: raw.width, height: raw.height });
    png.data = Buffer.from(raw.data);
    const bytes = PNG.sync.write(png);
    if (zoom === 1) writeFileSync(path, bytes, { mode: 0o600 });
    return bytes;
  } finally {
    resized?.dispose();
    crop?.dispose();
    original.dispose();
  }
}
export async function openExternal(path: string) {
  const p = Bun.spawn(["xdg-open", path], {
    stdout: "ignore",
    stderr: "ignore",
  });
  const code = await p.exited;
  if (code) throw new Error("Could not open external viewer");
}
