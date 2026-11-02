import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createCliRenderer, ImageRenderable } from "@opentui/core";
import { authentication, AUTH_PROVIDERS } from "./auth";
import {
  expand,
  loadConfig,
  saveConfig,
  configRoot,
  stateRoot,
} from "./config";
import { MODELS, modelFor } from "./models";
import { Engine } from "./jobs";
import { expandBatch, Library } from "./storage";
import { openExternal } from "./viewer";
import type { BatchSpec, ImageEntry, Provider, Settings } from "./types";
export const HELP = `imagegen — concurrent image generation and portable image library

imagegen                              Open the workbench
imagegen generate --prompt TEXT --model ID [--count N] [--ref PATH ...]
                  [--settings JSON] [--name NAME] [--dry-run]
imagegen batch FILE.json [--dry-run]   Preview or run rows + matrix
imagegen jobs                         List persisted jobs
imagegen resume [JOB_ID] [--retry]     Recover known requests; retry confirms possible new charge
imagegen cancel JOB_ID                Best-effort remote cancellation
imagegen library [--query TEXT] [--favorite] [--rebuild] [--json]
imagegen view IMAGE_ID [--external]    Inline image or external viewer
imagegen export IMAGE_ID ... --to DIR [--no-metadata] [--overwrite]
imagegen models [--json]               Supported exact model IDs and options
imagegen auth PROVIDER [--key-file PATH | --remove | --endpoint URL]
imagegen doctor                       Inspect terminal, paths, and credential status
imagegen --version

Files: ~/imagegen/<date>-<batch-name>-<id>/
Config: XDG_CONFIG_HOME/imagegen; index/cache: XDG_STATE_HOME/imagegen
Overrides: IMAGEGEN_ROOT, IMAGEGEN_CONFIG_DIR, IMAGEGEN_STATE_DIR
Keys: environment variables override KWallet / Secret Service. Never pass keys as arguments.
`;
export function parse(args: string[]) {
  const flags: Record<string, string[]> = {},
    pos: string[] = [];
  const boolean = new Set([
    "dry-run",
    "retry",
    "favorite",
    "rebuild",
    "json",
    "external",
    "no-metadata",
    "overwrite",
    "remove",
  ]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = boolean.has(k) ? "true" : args[++i];
      if (!v || v.startsWith("--")) throw new Error(`Missing value for --${k}`);
      (flags[k] ??= []).push(v);
    } else pos.push(a);
  }
  return { flags, pos, get: (k: string) => flags[k]?.at(-1) };
}
export function findImage(library: Library, id: string): ImageEntry {
  const rows = library.images().filter((i) => i.id.startsWith(id));
  if (rows.length !== 1)
    throw new Error(rows.length ? "Ambiguous image ID" : "Image not found");
  return rows[0]!;
}
export async function runCli(args: string[], library: Library) {
  const command = args[0],
    { flags, pos, get } = parse(args.slice(1));
  if (command === "models") {
    console.log(
      get("json")
        ? JSON.stringify(MODELS, null, 2)
        : MODELS.map(
            (m) =>
              `${m.id.padEnd(30)} ${m.label} · ${m.provider} · ${m.maxReferences} references\n  ${JSON.stringify(m.options)}`,
          ).join("\n"),
    );
    return;
  }
  if (command === "doctor") {
    console.log(
      `Images: ${library.root}\nConfig: ${configRoot()}\nIndex/cache: ${stateRoot()}\nTerminal: ${process.env.TERM_PROGRAM || process.env.TERM || "unknown"}\nInline rendering: runtime Kitty/Sixel capability detection (blocks fallback)\nDesktop opener: ${Bun.which("xdg-open") || "missing"}`,
    );
    for (const p of AUTH_PROVIDERS.filter((p) =>
      MODELS.some((m) => m.provider === p.id),
    ))
      try {
        const s = await authentication.status(p.id);
        console.log(
          `${p.label}: ${s.key}${s.endpoint ? " · endpoint configured" : ""}`,
        );
      } catch {
        console.log(
          `${p.label}: wallet unavailable; ${process.env[p.env] ? "environment configured" : "no environment key"}`,
        );
      }
    return;
  }
  if (command === "auth") {
    const p = pos[0] as Provider;
    if (!AUTH_PROVIDERS.some((a) => a.id === p))
      throw new Error("Choose a provider from imagegen models");
    if (get("key-file"))
      await authentication.save(
        p,
        "key",
        readFileSync(expand(get("key-file")!), "utf8"),
      );
    else if (get("endpoint"))
      await authentication.save(p, "endpoint", get("endpoint")!);
    else if (get("remove")) await authentication.remove(p);
    else {
      console.log(JSON.stringify(await authentication.status(p)));
      return;
    }
    console.log("Authentication updated in system wallet");
    return;
  }
  if (command === "library") {
    if (get("rebuild")) console.error(`Indexed ${library.rebuild()} images`);
    const rows = library.images(get("query"), !!get("favorite"));
    console.log(
      get("json")
        ? JSON.stringify(rows, null, 2)
        : rows
            .map(
              (i) =>
                `${i.favorite ? "★" : " "} ${i.id} ${i.model} · ${i.batchName}\n  ${i.path}`,
            )
            .join("\n"),
    );
    return;
  }
  if (command === "jobs") {
    for (const { batch } of library.batches())
      for (const j of batch.jobs)
        console.log(
          `${j.id} ${j.status.padEnd(12)} ${j.model} · ${batch.name}${j.error ? " · " + j.error : ""}`,
        );
    return;
  }
  if (command === "export") {
    if (!get("to") || !pos.length)
      throw new Error("export needs image IDs and --to DIR");
    const images = pos.map((id) => findImage(library, id));
    console.log(
      library
        .export(images, get("to")!, !get("no-metadata"), !!get("overwrite"))
        .join("\n"),
    );
    return;
  }
  if (command === "view") {
    const image = findImage(library, pos[0] || "");
    if (get("external")) {
      await openExternal(image.path);
      return;
    }
    if (!process.stdin.isTTY)
      throw new Error("Inline viewing requires a terminal");
    const r = await createCliRenderer({ exitOnCtrlC: false });
    r.root.add(
      new ImageRenderable(r, {
        id: "image",
        source: image.path,
        width: "100%",
        height: "100%",
        fit: "fit",
        protocol: "auto",
      }),
    );
    r.keyInput.on("keypress", (key) => {
      if (["escape", "q", "return"].includes(key.name)) r.destroy();
    });
    await new Promise<void>((resolve) => r.on("destroy", resolve));
    return;
  }
  if (["generate", "batch", "resume", "cancel"].includes(command || "")) {
    let spec: BatchSpec | undefined;
    if (command === "generate")
      spec = {
        schemaVersion: 1,
        name: get("name") || "generation",
        rows: [
          {
            prompt: get("prompt") || "",
            model: get("model") || MODELS[1]!.id,
            count: Number(get("count") || 1),
            references: flags.ref,
            provider: get("provider") as Provider | undefined,
            settings: JSON.parse(get("settings") || "{}") as Settings,
          },
        ],
      };
    if (command === "batch") {
      const path = expand(pos[0] || "");
      spec = JSON.parse(readFileSync(path, "utf8"));
      for (const row of spec!.rows)
        row.references = row.references?.map((p) =>
          p.startsWith("~") || p.startsWith("/")
            ? expand(p)
            : join(dirname(path), p),
        );
      if (spec!.matrix?.references)
        spec!.matrix.references = spec!.matrix.references.map((p) =>
          p.startsWith("~") || p.startsWith("/")
            ? expand(p)
            : join(dirname(path), p),
        );
    }
    if (spec) {
      const rows = expandBatch(spec);
      console.log(
        JSON.stringify(
          {
            name: spec.name,
            jobs: rows.reduce((n, r) => n + (r.count || 1), 0),
            rows,
          },
          null,
          2,
        ),
      );
      if (get("dry-run")) return;
    }
    const engine = new Engine(library);
    engine.on("error", () => {});
    const interrupt = () => {
      void engine.close(true);
    };
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    try {
      if (command === "cancel")
        await engine.cancel(library.findJob(pos[0] || "").job.id);
      else {
        if (spec) {
          const { dir, batch } = library.create(spec);
          engine.add(dir, batch);
        } else
          engine.resume(
            pos[0] ? library.findJob(pos[0]).job.id : undefined,
            !!get("retry"),
          );
        await engine.idle();
        for (const e of engine.entries.values())
          if (["failed", "uncertain"].includes(e.job.status))
            process.exitCode = 1;
      }
    } finally {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
      await engine.close(false);
    }
    return;
  }
  throw new Error("Unknown command. Use imagegen --help");
}
