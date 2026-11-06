import { NativeImage } from "@opentui/core";
import { PNG } from "pngjs";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeGif, svgPng, type Animation } from "./media";
import { stateRoot } from "./config";
import type { ImageEntry } from "./types";
export function preview(
  image: ImageEntry,
  width = 640,
  zoom = 1,
  x = 0,
  y = 0,
  state = stateRoot(),
  frame = 0,
): Uint8Array {
  const dir = join(state, "thumbnails");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(
    dir,
    `${image.hash}-${frame}-${width}-${zoom.toFixed(2)}-${x.toFixed(2)}-${y.toFixed(2)}.png`,
  );
  if (zoom === 1 && existsSync(path)) return readFileSync(path);
  const bytes = readFileSync(image.path);
  const original = NativeImage.decode(
    image.mime === "image/svg+xml"
      ? svgPng(bytes, Math.min(2048, width * zoom))
      : image.mime === "image/gif"
        ? animation(image).frames[frame % animation(image).frames.length]!.png
        : bytes,
  );
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

const animations = new Map<string, Animation>();
export function animation(image: Pick<ImageEntry, "hash" | "path">) {
  let result = animations.get(image.hash);
  if (!result) {
    result = decodeGif(readFileSync(image.path));
    if (animations.size >= 2)
      animations.delete(animations.keys().next().value!);
    animations.set(image.hash, result);
  }
  return result;
}
export function rasterize(image: ImageEntry, frame = 0, state = stateRoot()) {
  if (
    !Number.isInteger(frame) ||
    frame < 0 ||
    (image.mime === "image/gif"
      ? frame >= animation(image).frames.length
      : frame !== 0)
  )
    throw new Error("Frame index out of range");
  const dir = join(state, "references");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${image.hash}-${frame}.png`);
  const bytes = readFileSync(image.path);
  const source =
    image.mime === "image/svg+xml"
      ? svgPng(bytes, 2048)
      : image.mime === "image/gif"
        ? animation(image).frames[frame]!.png
        : bytes;
  const native = NativeImage.decode(source);
  try {
    const raw = native.raw(),
      png = new PNG({ width: raw.width, height: raw.height });
    png.data = Buffer.from(raw.data);
    writeFileSync(path, PNG.sync.write(png), { mode: 0o600 });
  } finally {
    native.dispose();
  }
  return path;
}
