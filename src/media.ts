import { NativeImage } from "@opentui/core";
import { Resvg } from "@resvg/resvg-js";
import { parseGIF, decompressFrames } from "gifuct-js";
import { PNG } from "pngjs";
export function mediaMime(data: Uint8Array, input = false): string {
  const b = Buffer.from(data);
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png";
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return "image/jpeg";
  if (
    b.toString("ascii", 0, 4) === "RIFF" &&
    b.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  if (!input) {
    if (/^GIF8[79]a/.test(b.toString("ascii", 0, 6))) return "image/gif";
    if (
      /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(
        b.toString("utf8"),
      )
    )
      return "image/svg+xml";
  }
  throw new Error(
    input
      ? "Expected a PNG, JPEG, or WebP edit input; rasterize SVG/GIF explicitly first"
      : "Expected PNG, JPEG, WebP, SVG, or GIF",
  );
}
export const mediaExtension = (mime: string) =>
  mime === "image/svg+xml" ? "svg" : mime.split("/")[1]!;
export function svgPng(bytes: Uint8Array, width = 1200): Uint8Array {
  const xml = Buffer.from(bytes).toString("utf8");
  if (
    /<(?:script|foreignObject|image)\b|<!DOCTYPE|<!ENTITY|\bon\w+\s*=|(?:href\s*=\s*["']\s*[^#])|url\(\s*["']?\s*[^#]/i.test(
      xml,
    )
  )
    throw new Error("SVG must contain static, self-contained vector content");
  const svg = new Resvg(xml, {
    fitTo: { mode: "width", value: Math.min(2048, width) },
    font: { loadSystemFonts: false },
  });
  if (
    svg.width <= 0 ||
    svg.height <= 0 ||
    svg.width * svg.height > 16777216 ||
    svg.height > 8192
  )
    throw new Error("SVG preview dimensions exceed limit");
  return svg.render().asPng();
}
export interface Animation {
  frames: { png: Uint8Array; delay: number }[];
  loops: number;
}
export function decodeGif(bytes: Uint8Array): Animation {
  const parsed = parseGIF(Uint8Array.from(bytes).buffer);
  const { width, height } = parsed.lsd;
  const count = parsed.frames.filter((f) => "image" in f).length;
  if (
    !width ||
    !height ||
    count < 1 ||
    count > 256 ||
    width * height * count > 67108864
  )
    throw new Error("GIF exceeds decoding budget");
  for (const frame of parsed.frames)
    if ("image" in frame) {
      const d = frame.image.descriptor;
      if (
        !d.width ||
        !d.height ||
        d.left + d.width > width ||
        d.top + d.height > height
      )
        throw new Error("GIF frame outside canvas");
    }
  const decoded = decompressFrames(parsed, true);
  const background = (transparentIndex?: number) => {
    const color = parsed.gct?.[parsed.lsd.backgroundColorIndex];
    return color && transparentIndex !== parsed.lsd.backgroundColorIndex
      ? [...color, 255]
      : [0, 0, 0, 0];
  };
  let canvas: Uint8Array = new Uint8Array(width * height * 4);
  const initial = background(decoded[0]?.transparentIndex);
  for (let n = 0; n < canvas.length; n += 4) canvas.set(initial, n);
  let previous: ReturnType<typeof decompressFrames>[number] | undefined,
    saved: Uint8Array | undefined;
  const frames: Animation["frames"] = [];
  for (const frame of decoded) {
    if (previous?.disposalType === 2) {
      const d = previous.dims;
      const color = background(previous.transparentIndex);
      for (let y = d.top; y < d.top + d.height; y++)
        for (let x = d.left; x < d.left + d.width; x++)
          canvas.set(color, (y * width + x) * 4);
    } else if (previous?.disposalType === 3 && saved) canvas = saved;
    saved = frame.disposalType === 3 ? canvas.slice() : undefined;
    const d = frame.dims;
    if (d.left + d.width > width || d.top + d.height > height)
      throw new Error("GIF frame outside canvas");
    for (let y = 0; y < d.height; y++)
      for (let x = 0; x < d.width; x++) {
        const src = (y * d.width + x) * 4,
          dst = ((y + d.top) * width + x + d.left) * 4;
        if (frame.patch[src + 3])
          canvas.set(frame.patch.subarray(src, src + 4), dst);
      }
    const png = new PNG({ width, height });
    png.data = Buffer.from(canvas);
    frames.push({
      png: PNG.sync.write(png),
      delay: Math.max(20, frame.delay || 100),
    });
    previous = frame;
  }
  let loops = 1;
  for (const f of parsed.frames)
    if ("application" in f && /NETSCAPE|ANIMEXTS/.test(f.application.id)) {
      const b = f.application.blocks;
      loops = (b[1] ?? 0) + ((b[2] ?? 0) << 8);
      if (loops) loops++;
    }
  return { frames, loops };
}
export function validateRaster(bytes: Uint8Array) {
  mediaMime(bytes, true);
  const image = NativeImage.decode(bytes);
  image.dispose();
}
export function validateOverlay(
  bytes: Uint8Array,
  first: Uint8Array,
  markup: boolean,
) {
  if (mediaMime(bytes, true) !== "image/png")
    throw new Error("Mask/markup must be PNG");
  const original = NativeImage.decode(first);
  let overlay: NativeImage | undefined;
  try {
    overlay = NativeImage.decode(bytes);
    if (original.width !== overlay.width || original.height !== overlay.height)
      throw new Error(
        "Mask/markup dimensions must match the oriented first reference",
      );
    if (markup && original.width * original.height > 16777216)
      throw new Error("Markup exceeds 16777216 pixels");
    const raw = overlay.raw().data;
    let transparent = false;
    for (let i = 3; i < raw.length; i += 4)
      if (raw[i]! < 255) {
        transparent = true;
        break;
      }
    if (!transparent)
      throw new Error("Mask/markup must contain transparent pixels");
  } finally {
    original.dispose();
    overlay?.dispose();
  }
}
