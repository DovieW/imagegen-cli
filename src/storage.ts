import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
  constants,
  unlinkSync,
} from "node:fs";
import {
  basename,
  dirname,
  extname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { atomicJson, expand, imageRoot, stateRoot } from "./config";
import { validateRow } from "./models";
import {
  mediaMime,
  mediaExtension,
  validateOverlay,
  validateRaster,
} from "./media";
import { CliError } from "./errors";
import type {
  Batch,
  BatchRow,
  BatchSpec,
  ImageEntry,
  ImageRecord,
  Job,
  Output,
} from "./types";
export const hash = (b: Uint8Array) =>
  createHash("sha256").update(b).digest("hex");
export function inside(root: string, path: string): string {
  const p = resolve(root, path);
  const r = relative(resolve(root), p);
  if (r === ".." || r.startsWith(".." + sep) || resolve(p) === resolve(root))
    throw new Error("Invalid artifact path");
  return p;
}
export const imageMime = (data: Uint8Array) => mediaMime(data, true);
export function validateInputs(rows: BatchRow[]) {
  const inputs = new Map<string, Buffer>();
  for (const row of rows) {
    for (const ref of [
      ...(row.references ?? []),
      ...([row.mask, row.markup].filter(Boolean) as string[]),
    ]) {
      const path = expand(ref);
      if (statSync(path).size > 50 * 1024 * 1024)
        throw new Error("Input exceeds 50 MB");
      const bytes = readFileSync(path);
      validateRaster(bytes);
      if (bytes.length > 50 * 1024 * 1024)
        throw new Error("Input exceeds 50 MB");
      inputs.set(path, bytes);
    }
    for (const kind of ["mask", "markup"] as const)
      if (row[kind])
        validateOverlay(
          inputs.get(expand(row[kind]!))!,
          inputs.get(expand(row.references![0]!))!,
          kind === "markup",
        );
  }
  return inputs;
}
function canonical(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value))
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export function expandBatch(spec: BatchSpec): BatchRow[] {
  if (
    !spec ||
    spec.schemaVersion !== 1 ||
    !Array.isArray(spec.rows) ||
    typeof spec.name !== "string" ||
    !spec.name.trim()
  )
    throw new Error("Expected schemaVersion 1, name, and rows array");
  for (const key of Object.keys(spec))
    if (!["schemaVersion", "name", "rows", "matrix"].includes(key))
      throw new Error(`Unknown batch property: ${key}`);
  if (spec.matrix) {
    for (const key of Object.keys(spec.matrix))
      if (
        !["prompts", "models", "settings", "references", "count"].includes(key)
      )
        throw new Error(`Unknown matrix property: ${key}`);
    if (
      spec.matrix.settings !== undefined &&
      (!Array.isArray(spec.matrix.settings) || !spec.matrix.settings.length)
    )
      throw new Error("Matrix settings must be a nonempty array");
  }
  const rows = [...spec.rows];
  if (spec.matrix) {
    const m = spec.matrix;
    if (
      !Array.isArray(m.prompts) ||
      !Array.isArray(m.models) ||
      !m.prompts.length ||
      !m.models.length
    )
      throw new Error("Matrix needs prompts and models");
    if (m.prompts.length * m.models.length * (m.settings?.length || 1) > 10000)
      throw new Error("Batch exceeds 10,000 jobs");
    for (const prompt of m.prompts)
      for (const model of m.models)
        for (const settings of m.settings || [{}])
          rows.push({
            prompt,
            model,
            settings,
            references: m.references,
            count: m.count,
          });
  }
  let n = 0;
  for (const row of rows) {
    validateRow(row);
    n += row.count ?? 1;
  }
  if (!n || n > 10000) throw new Error("Batch must contain 1–10,000 jobs");
  return rows;
}
export class Library {
  db: Database;
  constructor(
    readonly root = imageRoot(),
    readonly state = stateRoot(),
  ) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    mkdirSync(state, { recursive: true, mode: 0o700 });
    this.db = new Database(join(state, "library.sqlite3"), { create: true });
    this.db.run("PRAGMA journal_mode=WAL");
    this.db.run("PRAGMA busy_timeout=5000");
    this.db.run(
      "CREATE TABLE IF NOT EXISTS images(id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, metadata_path TEXT NOT NULL, record TEXT NOT NULL)",
    );
  }
  close() {
    this.db.close();
  }
  acquire(): () => void {
    const path = join(this.root, ".imagegen.lock");
    try {
      writeFileSync(path, String(process.pid), { flag: "wx", mode: 0o600 });
    } catch {
      let alive = true;
      try {
        const pid = Number(readFileSync(path, "utf8"));
        if (!Number.isInteger(pid) || pid <= 0) throw new Error("Invalid lock");
        process.kill(pid, 0);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ESRCH") alive = false;
      }
      if (alive)
        throw new Error(
          "Another imagegen process owns the job engine. Use that workbench, or wait for it to exit.",
        );
      unlinkSync(path);
      return this.acquire();
    }
    return () => {
      if (
        existsSync(path) &&
        readFileSync(path, "utf8") === String(process.pid)
      )
        unlinkSync(path);
    };
  }
  batches(): { dir: string; batch: Batch }[] {
    const result: { dir: string; batch: Batch }[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 4) return;
      if (existsSync(join(dir, "batch.json"))) {
        const batch = JSON.parse(
          readFileSync(join(dir, "batch.json"), "utf8"),
        ) as Batch;
        if (batch.schemaVersion !== 1 || !Array.isArray(batch.jobs))
          throw new Error(`Unsupported manifest: ${dir}`);
        result.push({ dir, batch });
        return;
      }
      for (const e of readdirSync(dir, { withFileTypes: true }))
        if (e.isDirectory() && !e.name.startsWith("."))
          walk(join(dir, e.name), depth + 1);
    };
    walk(this.root, 0);
    return result.sort((a, b) =>
      b.batch.createdAt.localeCompare(a.batch.createdAt),
    );
  }
  createIdempotent(spec: BatchSpec, requestKey: string) {
    if (!requestKey || requestKey.length > 200)
      throw new CliError(
        "INVALID_REQUEST_KEY",
        "Request key must contain 1–200 characters",
      );
    const rows = expandBatch(spec).map((row) => {
      const m = validateRow(row);
      return {
        prompt: row.prompt.trim(),
        model: m.id,
        provider: m.provider,
        count: row.count ?? 1,
        settings: canonical(row.settings || {}),
        ...(row.mask ? { mask: hash(readFileSync(expand(row.mask))) } : {}),
        ...(row.markup
          ? { markup: hash(readFileSync(expand(row.markup))) }
          : {}),
        parentIds: row.parentIds || [],
        references: (row.references || []).map((p) =>
          hash(readFileSync(expand(p))),
        ),
      };
    });
    const specHash = hash(
      Buffer.from(JSON.stringify({ name: spec.name, rows })),
    );
    const existing = this.batches().find(
      (e) => e.batch.requestKey === requestKey,
    );
    if (existing) {
      if (existing.batch.specHash !== specHash)
        throw new CliError(
          "REQUEST_KEY_CONFLICT",
          "Request key already belongs to a different batch configuration",
          7,
        );
      return { ...existing, reused: true };
    }
    const entry = this.create(spec);
    entry.batch.requestKey = requestKey;
    entry.batch.specHash = specHash;
    this.save(entry.dir, entry.batch);
    return { ...entry, reused: false };
  }
  create(spec: BatchSpec): { dir: string; batch: Batch } {
    const rows = expandBatch(spec),
      now = new Date().toISOString(),
      id = randomUUID();
    // Validate every input before creating a batch.
    const inputs = validateInputs(rows);
    const slug =
      spec.name
        .normalize("NFKD")
        .replace(/[^a-zA-Z0-9_-]+/g, "-")
        .slice(0, 60) || "batch";
    const dir = join(
      this.root,
      `${now.slice(0, 10)}-${slug}-${id.slice(0, 8)}`,
    );
    mkdirSync(join(dir, "inputs"), { recursive: true, mode: 0o700 });
    const batch: Batch = {
      schemaVersion: 1,
      id,
      name: spec.name,
      createdAt: now,
      jobs: [],
    };
    for (const row of rows) {
      const model = validateRow(row),
        references: string[] = [];
      const snapshot = (ref: string) => {
        const b = inputs.get(expand(ref))!,
          name = `inputs/${hash(b)}.${mediaExtension(imageMime(b))}`;
        if (!existsSync(join(dir, name)))
          writeFileSync(join(dir, name), b, { mode: 0o600 });
        return name;
      };
      for (const ref of row.references || []) references.push(snapshot(ref));
      const mask = row.mask ? snapshot(row.mask) : undefined,
        markup = row.markup ? snapshot(row.markup) : undefined;
      for (let i = 0; i < (row.count ?? 1); i++)
        batch.jobs.push({
          id: randomUUID(),
          prompt: row.prompt.trim(),
          model: model.id,
          provider: model.provider,
          settings: row.settings || {},
          references,
          ...(mask ? { mask } : {}),
          ...(markup ? { markup } : {}),
          parentIds: row.parentIds || [],
          status: "queued",
          attempts: 0,
          createdAt: now,
          updatedAt: now,
          outputs: [],
        });
    }
    this.save(dir, batch);
    return { dir, batch };
  }
  save(dir: string, batch: Batch) {
    atomicJson(join(dir, "batch.json"), batch);
  }
  findJob(id: string): { dir: string; batch: Batch; job: Job } {
    const found = this.batches().flatMap(({ dir, batch }) =>
      batch.jobs
        .filter((j) => j.id.startsWith(id))
        .map((job) => ({ dir, batch, job })),
    );
    if (found.length !== 1)
      throw new Error(found.length ? "Ambiguous job ID" : "Job not found");
    return found[0]!;
  }
  index(record: ImageRecord, path: string, metadataPath: string) {
    this.db.run(
      "INSERT INTO images(id,path,metadata_path,record) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET path=excluded.path,metadata_path=excluded.metadata_path,record=excluded.record",
      [record.id, path, metadataPath, JSON.stringify(record)],
    );
  }
  saveOutput(
    dir: string,
    batch: Batch,
    job: Job,
    bytes: Uint8Array,
    index: number,
  ): Output {
    const mime = mediaMime(bytes),
      ext = mediaExtension(mime),
      name = `${String(batch.jobs.indexOf(job) + 1).padStart(4, "0")}-${job.model}-${job.id.slice(0, 8)}-${index + 1}.${ext}`;
    const output: Output = {
      file: name,
      hash: hash(bytes),
      bytes: bytes.length,
      mime,
    };
    const record: ImageRecord = {
      schemaVersion: 1,
      id: `${job.id}-${index}`,
      jobId: job.id,
      batchId: batch.id,
      batchName: batch.name,
      prompt: job.prompt,
      model: job.model,
      provider: job.provider,
      settings: job.settings,
      parentIds: job.parentIds,
      references: job.references,
      mask: job.mask,
      markup: job.markup,
      svgUsage: job.svgUsage,
      effectiveSettings: job.effectiveSettings,
      createdAt: new Date().toISOString(),
      ...output,
      tags: [],
      favorite: false,
      usage: job.usage,
      requestId: job.requestId,
    };
    const path = join(dir, name),
      meta = path + ".json";
    // On recovery, preserve existing annotation sidecars for this exact output.
    if (existsSync(meta)) {
      const old = JSON.parse(readFileSync(meta, "utf8"));
      if (old.id === record.id) {
        record.tags = old.tags;
        record.favorite = old.favorite;
      }
    }
    const tmp = path + ".part";
    writeFileSync(tmp, bytes, { mode: 0o600 });
    renameSync(tmp, path);
    atomicJson(meta, record);
    this.index(record, path, meta);
    return output;
  }
  rebuild(): number {
    const entries: ImageEntry[] = [];
    for (const { dir } of this.batches())
      for (const f of readdirSync(dir))
        if (f.endsWith(".json") && f !== "batch.json") {
          const record = JSON.parse(
            readFileSync(join(dir, f), "utf8"),
          ) as ImageRecord;
          if (record.schemaVersion !== 1 || !record.id || !record.file)
            continue;
          const path = inside(dir, record.file);
          if (existsSync(path))
            entries.push({ ...record, path, metadataPath: join(dir, f) });
        }
    this.db.transaction(() => {
      this.db.run("DELETE FROM images");
      for (const { path, metadataPath, ...record } of entries)
        this.index(record, path, metadataPath);
    })();
    return entries.length;
  }
  images(query = "", favorite = false, sort = "newest"): ImageEntry[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const images = (
      this.db.query("SELECT * FROM images").all() as {
        path: string;
        metadata_path: string;
        record: string;
      }[]
    )
      .map(
        (r) =>
          ({
            ...JSON.parse(r.record),
            path: r.path,
            metadataPath: r.metadata_path,
          }) as ImageEntry,
      )
      .filter(
        (r) =>
          resolve(r.path).startsWith(resolve(this.root) + sep) &&
          (!favorite || r.favorite) &&
          words.every((w) =>
            `${r.prompt} ${r.model} ${r.provider} ${r.batchName} ${r.createdAt} ${r.tags.join(" ")}`
              .toLowerCase()
              .includes(w),
          ),
      );
    return images.sort((a, b) =>
      sort === "model"
        ? a.model.localeCompare(b.model)
        : sort === "oldest"
          ? a.createdAt.localeCompare(b.createdAt)
          : b.createdAt.localeCompare(a.createdAt),
    );
  }
  annotate(
    image: ImageEntry,
    patch: Partial<Pick<ImageRecord, "tags" | "favorite">>,
  ) {
    const { path, metadataPath, ...record } = image;
    Object.assign(record, patch);
    atomicJson(metadataPath, record);
    this.index(record, path, metadataPath);
  }
  export(
    images: ImageEntry[],
    destination: string,
    metadata = true,
    overwrite = false,
  ): string[] {
    const dir = expand(destination);
    mkdirSync(dir, { recursive: true });
    const outputs: string[] = [];
    const targets = images.flatMap((i) => [
      join(dir, basename(i.path)),
      ...(metadata ? [join(dir, basename(i.metadataPath))] : []),
    ]);
    if (new Set(targets).size !== targets.length)
      throw new Error("Selected images have conflicting export filenames");
    for (const target of targets)
      if (existsSync(target) && !overwrite)
        throw new Error(`File exists: ${target}. Confirm overwrite first.`);
    for (const i of images) {
      for (const source of [i.path, ...(metadata ? [i.metadataPath] : [])]) {
        const target = join(dir, basename(source));
        if (resolve(source) === target)
          throw new Error("Export destination is the source folder");
        copyFileSync(source, target, overwrite ? 0 : constants.COPYFILE_EXCL);
        outputs.push(target);
      }
    }
    return outputs;
  }
}
