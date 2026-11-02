import type { BatchRow, Provider, Settings } from "./types";
export interface Model {
  id: string;
  label: string;
  provider: Provider;
  api: string;
  editApi?: string;
  maxReferences: number;
  options: Record<string, readonly (string | number | boolean)[] | "integer">;
  docs: string;
}
const openaiDocs =
  "https://developers.openai.com/api/docs/guides/image-generation";
const googleDocs = "https://ai.google.dev/gemini-api/docs/image-generation";
const maiDocs =
  "https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-mai-image";
const ratios = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"];
export const MODELS: Model[] = [
  ...[
    ["gpt-image-2.5-sunburst", "GPT Image 2.5 Sunburst"],
    ["gpt-image-2.5-flare", "GPT Image 2.5 Flare"],
    ["gpt-image-2", "GPT Image 2"],
  ].map(([id, label]) => ({
    id: id!,
    label: label!,
    provider: "openai" as const,
    api: id!,
    maxReferences: 16,
    options: {
      size: ["auto", "1024x1024", "1536x1024", "1024x1536"],
      quality: ["auto", "low", "medium", "high"],
      output_format: ["png", "jpeg", "webp"],
    },
    docs: openaiDocs,
  })),
  ...[
    ["gemini-nano-banana-2.1", "Nano Banana 2.1"],
    ["gemini-3.1-flash-lite-image", "Nano Banana 2 Lite"],
    ["gemini-3.1-flash-image", "Nano Banana 2"],
  ].map(([id, label]) => ({
    id: id!,
    label: label!,
    provider: "google" as const,
    api: id!,
    maxReferences: 14,
    options: { aspect_ratio: ratios },
    docs: googleDocs,
  })),
  ...[
    ["MAI-Image-2.6", "MAI-Image 2.6"],
    ["MAI-Image-2.6-Flash", "MAI-Image 2.6 Flash"],
  ].map(([id, label]) => ({
    id: id!,
    label: label!,
    provider: "microsoft" as const,
    api: id!,
    maxReferences: 5,
    options: {
      width: "integer" as const,
      height: "integer" as const,
      web_grounding: [true, false],
      auto_aspect_ratio: [true, false],
    },
    docs: maiDocs,
  })),
  {
    id: "grok-imagine-image-2.0",
    label: "Grok Imagine Image 2.0",
    provider: "xai",
    api: "grok-imagine-image-2.0",
    maxReferences: 5,
    options: { aspect_ratio: ["auto", ...ratios], resolution: ["1k", "2k"] },
    docs: "https://docs.x.ai/developers/model-capabilities/images/generation",
  },
  {
    id: "muse-image-1.0",
    label: "Muse Image 1.0",
    provider: "meta",
    api: "muse-image-1.0",
    maxReferences: 1,
    options: {},
    docs: "https://dev.meta.ai/docs/image-generation",
  },
  {
    id: "flux-3-image",
    label: "FLUX 3 Image",
    provider: "fal",
    api: "blackforestlabs/flux-3/text-to-image",
    editApi: "blackforestlabs/flux-3/edit-image",
    maxReferences: 10,
    options: {
      aspect_ratio: ["auto", ...ratios],
      resolution: ["768sq", "1k", "1.5k", "2k", "4k"],
      seed: "integer",
    },
    docs: "https://fal.ai/models/blackforestlabs/flux-3/text-to-image/api",
  },
  {
    id: "flux-3-image-klein",
    label: "FLUX 3 Image Klein",
    provider: "fal",
    api: "blackforestlabs/flux-3/klein/text-to-image",
    editApi: "blackforestlabs/flux-3/klein/edit-image",
    maxReferences: 10,
    options: {
      image_size: [
        "square_hd",
        "square",
        "portrait_4_3",
        "portrait_16_9",
        "landscape_4_3",
        "landscape_16_9",
      ],
      seed: "integer",
      output_format: ["png", "jpeg", "webp"],
    },
    docs: "https://fal.ai/models/blackforestlabs/flux-3/klein/text-to-image/api",
  },
  {
    id: "flux-2-max",
    label: "FLUX.2 Max",
    provider: "bfl",
    api: "flux-2-max",
    maxReferences: 8,
    options: { width: "integer", height: "integer", seed: "integer" },
    docs: "https://docs.bfl.ai/quick_start/generating_images",
  },
];
export function modelFor(id: string, provider?: Provider): Model {
  const m = MODELS.find(
    (m) =>
      (m.id === id || m.label.toLowerCase() === id.toLowerCase()) &&
      (!provider || m.provider === provider),
  );
  if (!m)
    throw new Error(
      `Unknown model/provider: ${id}${provider ? "/" + provider : ""}. Use imagegen models.`,
    );
  return m;
}
export function validateRow(row: BatchRow): Model {
  if (!row || typeof row.prompt !== "string" || !row.prompt.trim())
    throw new Error("Each row needs a prompt");
  for (const key of Object.keys(row))
    if (
      ![
        "prompt",
        "model",
        "provider",
        "references",
        "parentIds",
        "settings",
        "count",
      ].includes(key)
    )
      throw new Error(`Unknown row property: ${key}`);
  if (typeof row.model !== "string") throw new Error("Model must be a string");
  if (
    row.settings !== undefined &&
    (!row.settings ||
      typeof row.settings !== "object" ||
      Array.isArray(row.settings))
  )
    throw new Error("Settings must be an object");
  const m = modelFor(row.model, row.provider);
  if (
    !Number.isInteger(row.count ?? 1) ||
    (row.count ?? 1) < 1 ||
    (row.count ?? 1) > 1000
  )
    throw new Error("Copy count must be 1–1000");
  if (
    row.references &&
    (!Array.isArray(row.references) ||
      row.references.some((r) => typeof r !== "string"))
  )
    throw new Error("References must be file paths");
  if ((row.references?.length || 0) > m.maxReferences)
    throw new Error(`${m.label} accepts at most ${m.maxReferences} references`);
  if (
    row.parentIds &&
    (!Array.isArray(row.parentIds) ||
      row.parentIds.some((r) => typeof r !== "string"))
  )
    throw new Error("parentIds must be strings");
  const settings: Settings = row.settings || {};
  for (const [k, v] of Object.entries(settings)) {
    const allowed = m.options[k];
    if (
      !allowed ||
      (allowed === "integer"
        ? !Number.isSafeInteger(v) || Number(v) < 0
        : !allowed.includes(v))
    )
      throw new Error(`Unsupported ${k}=${v} for ${m.label}`);
  }
  if (m.provider === "microsoft") {
    const w = Number(settings.width ?? 1024),
      h = Number(settings.height ?? 1024);
    if (w < 768 || h < 768 || w * h > 2359296)
      throw new Error(
        "MAI requires dimensions ≥768 and at most 2,359,296 total pixels",
      );
  }
  if (m.provider === "bfl")
    for (const k of ["width", "height"])
      if (
        settings[k] !== undefined &&
        (Number(settings[k]) < 256 ||
          Number(settings[k]) > 2048 ||
          Number(settings[k]) % 16)
      )
        throw new Error(
          "BFL dimensions must be multiples of 16, from 256–2048",
        );
  return m;
}
