import type { BatchRow, Provider, Settings } from "./types";
export const DEFAULT_MODEL = "gpt-image-2.6-flare";
export interface SettingSchema {
  type?: string;
  enum?: readonly (string | number | boolean)[];
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  properties?: Record<string, SettingSchema>;
  required?: string[];
  additionalProperties?: boolean;
}
export interface Model {
  id: string;
  label: string;
  provider: Provider;
  api: string;
  editApi?: string;
  maxReferences: number;
  options: Record<string, readonly (string | number | boolean)[] | "integer">;
  docs: string;
  settingsSchema?: SettingSchema;
  constraints?: string[];
}
const openaiDocs =
  "https://developers.openai.com/api/docs/guides/image-generation";
const googleDocs = "https://ai.google.dev/gemini-api/docs/image-generation";
const maiDocs =
  "https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-mai-image";
const ratios = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"];
export const MODELS: Model[] = [
  ...[
    ["gpt-image-2.6-sunburst", "GPT Image 2.6 Sunburst"],
    ["gpt-image-2.6-flare", "GPT Image 2.6 Flare"],
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
      quality: [
        "auto",
        "low",
        "medium",
        "high",
        ...(id !== "gpt-image-2" ? ["xhigh", "max"] : []),
      ],
      output_format: [
        "png",
        "jpeg",
        "webp",
        ...(id!.includes("2.6") ? ["svg", "gif"] : []),
      ],
    },
    docs: openaiDocs,
    settingsSchema: openaiSchema(id!),
    constraints: [
      "mask and markup require references and are mutually exclusive; markup requires 2.5 or 2.6",
      "SVG requires generation, n=1, no streaming/partials/compression",
      "GIF supports generation or still references; no masks/markup/streaming/partials/compression",
      "transparent requires PNG or WebP; compression requires JPEG or WebP",
      "custom raster size: edges divisible by 16, <=3840, aspect <=3:1, 655360..8294400 pixels; >2560x1440 experimental",
      "GIF frame_count 2..16; duration 20..2000ms rounded to 10ms; preview access required",
      "SVG author selection requires account access; GIF pixel budget validated by provider",
    ],
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
        "mask",
        "markup",
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
  for (const kind of ["mask", "markup"] as const)
    if (
      row[kind] !== undefined &&
      (typeof row[kind] !== "string" || !row[kind])
    )
      throw new Error(`${kind} must be a file path`);
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
  validateSetting(settings, settingsSchema(m), "settings");
  if (m.provider === "openai") {
    const format = settings.output_format ?? "png";
    const edit = !!row.references?.length;
    if (row.prompt.length > 32000)
      throw new Error("Prompt exceeds 32000 characters");
    if (row.mask && row.markup)
      throw new Error("mask and markup are mutually exclusive");
    if ((row.mask || row.markup) && !edit)
      throw new Error("mask/markup require a first reference image");
    if (row.markup && m.id === "gpt-image-2")
      throw new Error("Markup requires GPT Image 2.5 or 2.6");
    if (format === "svg" && edit)
      throw new Error("SVG output supports generation only");
    if (
      ["svg", "gif"].includes(String(format)) &&
      (settings.stream ||
        Number(settings.partial_images ?? 0) > 0 ||
        settings.output_compression !== undefined ||
        row.mask ||
        row.markup)
    )
      throw new Error(
        "SVG/GIF do not support streaming, partial images, compression, masks or markup",
      );
    if (
      format !== "gif" &&
      (settings.frame_count !== undefined ||
        settings.frame_duration_ms !== undefined)
    )
      throw new Error("Frame controls require GIF output");
    if (format !== "svg" && settings.svg !== undefined)
      throw new Error("SVG author options require SVG output");
    if (
      settings.background === "transparent" &&
      !["png", "webp"].includes(String(format))
    )
      throw new Error("Transparency requires PNG or WebP");
    if (
      settings.output_compression !== undefined &&
      !["jpeg", "webp"].includes(String(format))
    )
      throw new Error("Compression requires JPEG or WebP");
    if (Number(settings.partial_images ?? 0) > 0 && settings.stream !== true)
      throw new Error("partial_images requires stream=true");
    if (settings.size !== undefined && settings.size !== "auto") {
      const match = /^(\d+)x(\d+)$/.exec(String(settings.size));
      const w = Number(match?.[1]),
        h = Number(match?.[2]);
      if (
        !match ||
        !w ||
        !h ||
        w % 16 ||
        h % 16 ||
        Math.max(w, h) > 3840 ||
        Math.max(w, h) / Math.min(w, h) > 3 ||
        (format !== "gif" && (w * h < 655360 || w * h > 8294400))
      )
        throw new Error("Invalid image dimensions; see model constraints");
    }
  } else if (row.mask || row.markup)
    throw new Error("mask/markup are supported only for OpenAI");
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

function openaiSchema(id: string): SettingSchema {
  const modern = id !== "gpt-image-2",
    newest = id.includes("2.6");
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      size: { type: "string" },
      quality: {
        enum: [
          "auto",
          "low",
          "medium",
          "high",
          ...(modern ? ["xhigh", "max"] : []),
        ],
      },
      output_format: {
        enum: ["png", "jpeg", "webp", ...(newest ? ["svg", "gif"] : [])],
      },
      background: { enum: ["auto", "opaque", "transparent"] },
      output_compression: { type: "integer", minimum: 0, maximum: 100 },
      moderation: { enum: ["auto", "low"] },
      safety_identifier: { type: "string", maxLength: 128 },
      stream: { type: "boolean" },
      partial_images: { type: "integer", minimum: 0, maximum: 3 },
      ...(newest
        ? {
            complexity: { enum: ["low", "medium", "high"] },
            frame_count: { type: "integer", minimum: 2, maximum: 16 },
            frame_duration_ms: { type: "integer", minimum: 20, maximum: 2000 },
            svg: {
              type: "object",
              required: ["model"],
              additionalProperties: false,
              properties: {
                model: { type: "string", maxLength: 200 },
                reasoning: {
                  type: "object",
                  required: ["effort"],
                  additionalProperties: false,
                  properties: {
                    effort: {
                      enum: [
                        "none",
                        "minimal",
                        "low",
                        "medium",
                        "high",
                        "xhigh",
                        "max",
                      ],
                    },
                  },
                },
              },
            },
          }
        : {}),
    },
  };
}
export function settingsSchema(model: Model): SettingSchema {
  return (
    model.settingsSchema ?? {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(
        Object.entries(model.options).map(([k, v]) => [
          k,
          v === "integer" ? { type: "integer", minimum: 0 } : { enum: v },
        ]),
      ),
    }
  );
}
export function describeModel(model: Model) {
  return { ...model, settingsSchema: settingsSchema(model) };
}
export function validateSetting(
  value: unknown,
  rule: SettingSchema,
  path: string,
) {
  if (rule.enum && !rule.enum.includes(value as never))
    throw new Error(`Unsupported ${path}=${JSON.stringify(value)}`);
  if (rule.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(`${path} must be an object`);
    for (const k of rule.required ?? [])
      if (!(k in value)) throw new Error(`${path}.${k} is required`);
    for (const [k, v] of Object.entries(value)) {
      const child =
        rule.properties && Object.hasOwn(rule.properties, k)
          ? rule.properties[k]
          : undefined;
      if (!child) throw new Error(`Unsupported ${path}.${k}`);
      validateSetting(v, child, `${path}.${k}`);
    }
  } else if (rule.type === "integer") {
    if (
      !Number.isSafeInteger(value) ||
      Number(value) < (rule.minimum ?? 0) ||
      Number(value) > (rule.maximum ?? Number.MAX_SAFE_INTEGER)
    )
      throw new Error(
        `${path} must be an integer in ${rule.minimum ?? 0}..${rule.maximum ?? "safe range"}`,
      );
  } else if (rule.type && typeof value !== rule.type)
    throw new Error(`${path} must be ${rule.type}`);
  if (
    typeof value === "string" &&
    (!value || value.length > (rule.maxLength ?? Infinity))
  )
    throw new Error(`Invalid ${path} length`);
}
