export const CLI_VERSION = "0.2.0";
export const COMMANDS: Record<
  string,
  {
    description: string;
    positionals?: string;
    flags: Record<string, "value" | "repeat" | "boolean">;
  }
> = {
  generate: {
    description: "Generate images, waiting for completion by default",
    flags: {
      prompt: "value",
      "prompt-file": "value",
      model: "value",
      provider: "value",
      count: "value",
      ref: "repeat",
      from: "repeat",
      "parent-id": "repeat",
      settings: "value",
      "settings-file": "value",
      name: "value",
      "dry-run": "boolean",
      "request-key": "value",
      "no-wait": "boolean",
      timeout: "value",
    },
  },
  batch: {
    description:
      "Submit explicit rows and Cartesian-product matrices; - reads stdin",
    positionals: "FILE|-",
    flags: {
      "dry-run": "boolean",
      "request-key": "value",
      "no-wait": "boolean",
      timeout: "value",
    },
  },
  models: {
    description:
      "Discover exact model IDs, providers, reference limits, and settings",
    positionals: "[MODEL_ID]",
    flags: {},
  },
  jobs: {
    description: "List or inspect jobs with output paths and IDs",
    positionals: "[JOB_ID]",
    flags: {
      batch: "value",
      status: "repeat",
      limit: "value",
      offset: "value",
    },
  },
  wait: {
    description: "Wait for specific jobs without submitting or retrying them",
    positionals: "JOB_ID ...",
    flags: { batch: "value", timeout: "value" },
  },
  resume: {
    description:
      "Recover paused/known requests; --retry explicitly creates new paid jobs",
    positionals: "[JOB_ID]",
    flags: { retry: "boolean", "no-wait": "boolean", timeout: "value" },
  },
  cancel: {
    description: "Best-effort cancellation of specific jobs",
    positionals: "JOB_ID ...",
    flags: {},
  },
  pause: {
    description: "Pause queued submissions on the running engine",
    flags: {},
  },
  library: {
    description: "Search/filter images with stable IDs and absolute paths",
    flags: {
      query: "value",
      favorite: "boolean",
      rebuild: "boolean",
      model: "value",
      provider: "value",
      batch: "value",
      tag: "repeat",
      sort: "value",
      limit: "value",
      offset: "value",
    },
  },
  image: {
    description: "Inspect image metadata and parent lineage",
    positionals: "IMAGE_ID",
    flags: {},
  },
  annotate: {
    description: "Update portable tags/favorites for selected images",
    positionals: "IMAGE_ID ...",
    flags: {
      tags: "value",
      "add-tag": "repeat",
      "remove-tag": "repeat",
      favorite: "boolean",
      unfavorite: "boolean",
    },
  },
  export: {
    description: "Copy original images and optional sidecars to a destination",
    positionals: "IMAGE_ID ...",
    flags: { to: "value", "no-metadata": "boolean", overwrite: "boolean" },
  },
  config: {
    description:
      "Inspect/set global and provider concurrency (also updates a running engine)",
    flags: { concurrency: "value", "provider-limit": "repeat" },
  },
  doctor: {
    description:
      "Inspect engine, terminal, paths, and credential sources without revealing keys",
    flags: {},
  },
  auth: {
    description: "Inspect or update wallet credentials",
    positionals: "PROVIDER",
    flags: { "key-file": "value", remove: "boolean", endpoint: "value" },
  },
  view: {
    description: "Open an interactive terminal image viewer or desktop viewer",
    positionals: "IMAGE_ID",
    flags: { external: "boolean" },
  },
  schema: {
    description: "Discover command contracts and JSON Schemas",
    positionals: "[batch|response]",
    flags: {},
  },
  help: { description: "Show usage", positionals: "[COMMAND]", flags: {} },
  version: { description: "Show executable version", flags: {} },
};
export const GLOBAL_FLAGS = {
  json: "boolean",
  jsonl: "boolean",
  help: "boolean",
} as const;
export const EXIT_CODES = {
  success: 0,
  internal_error: 1,
  invalid_input: 2,
  incomplete_jobs: 3,
  timeout: 4,
  engine_unavailable: 5,
  not_found: 6,
  request_key_conflict: 7,
  interrupted: 130,
  terminated: 143,
};
export const RESPONSE_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["schemaVersion", "ok", "command"],
  properties: {
    schemaVersion: { const: 1 },
    ok: { type: "boolean" },
    command: { type: "string" },
    data: {},
    error: {
      type: "object",
      required: ["code", "message"],
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        details: {},
      },
    },
  },
  additionalProperties: false,
};
const row = {
  type: "object",
  required: ["prompt", "model"],
  properties: {
    prompt: { type: "string", minLength: 1 },
    model: { type: "string" },
    provider: {
      enum: ["openai", "google", "microsoft", "meta", "bfl", "fal", "xai"],
    },
    references: { type: "array", items: { type: "string" } },
    parentIds: { type: "array", items: { type: "string" } },
    count: { type: "integer", minimum: 1, maximum: 1000 },
    settings: {
      type: "object",
      additionalProperties: { type: ["string", "number", "boolean"] },
    },
  },
  additionalProperties: false,
};
export const BATCH_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Imagegen batch v1",
  type: "object",
  required: ["schemaVersion", "name", "rows"],
  properties: {
    schemaVersion: { const: 1 },
    name: { type: "string", minLength: 1 },
    rows: { type: "array", items: row },
    matrix: {
      type: "object",
      required: ["prompts", "models"],
      properties: {
        prompts: {
          type: "array",
          minItems: 1,
          items: { type: "string", minLength: 1 },
        },
        models: { type: "array", minItems: 1, items: { type: "string" } },
        settings: {
          type: "array",
          minItems: 1,
          items: row.properties.settings,
        },
        references: row.properties.references,
        count: row.properties.count,
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};
