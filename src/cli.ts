import { readFileSync, existsSync } from "node:fs";
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
import {
  callEngine,
  dispatch,
  serveEngine,
  validateLimits,
  type ControlRequest,
} from "./control";
import { CliError, envelope, errorInfo } from "./errors";
import {
  CLI_VERSION,
  COMMANDS,
  GLOBAL_FLAGS,
  EXIT_CODES,
  BATCH_SCHEMA,
  RESPONSE_SCHEMA,
} from "./protocol";
import type { BatchSpec, ImageEntry, Job, Provider } from "./types";
export const HELP = `imagegen ${CLI_VERSION} — image generation for humans and agents

imagegen                             Open the Ghostty workbench
imagegen help COMMAND                Discover command flags
imagegen schema --json               Command contract + JSON Schemas + exit codes
imagegen models [ID] --json           Exact IDs, capabilities, and accepted settings
imagegen generate --prompt TEXT --model ID [--count N] [--ref PATH ...] --json
imagegen generate --prompt-file FILE --model ID --request-key UNIQUE --json
imagegen batch FILE.json|- [--dry-run] [--request-key UNIQUE] --json
imagegen jobs [JOB_ID] [--batch ID] [--status STATUS] --json
imagegen wait JOB_ID ... [--timeout SECONDS] --json
imagegen resume [JOB_ID] [--retry] --json
imagegen cancel JOB_ID ... --json
imagegen pause --json
imagegen library [--query TEXT] [--tag TAG] [--favorite] --json
imagegen image IMAGE_ID --json
imagegen annotate IMAGE_ID ... [--add-tag TAG] [--favorite|--unfavorite] --json
imagegen export IMAGE_ID ... --to DIR [--overwrite] --json
imagegen config [--concurrency N] [--provider-limit PROVIDER=N] --json
imagegen doctor --json
imagegen auth PROVIDER [--key-file PATH | --remove | --endpoint URL] --json
imagegen view IMAGE_ID [--external]

--json: one versioned result/error object on stdout; diagnostics on stderr.
--jsonl: job-change events followed by one result event. Do not combine formats.
Generation waits by default and returns batch/job/image IDs plus absolute output paths.
--no-wait requires an already running TUI/CLI engine. Jobs never run as a daemon.
Separate CLI processes automatically share a running engine for the same image root.
Reuse --request-key with the same request to avoid duplicate submissions.
--prompt - and batch - read stdin. References in stdin batches resolve from cwd.
Exit codes: 0 success, 1 internal, 2 input, 3 incomplete, 4 timeout, 5 engine busy,
            6 not found, 7 request-key conflict, 130 SIGINT, 143 SIGTERM.

Images: ~/imagegen. Overrides: IMAGEGEN_ROOT, IMAGEGEN_CONFIG_DIR, IMAGEGEN_STATE_DIR.
Environment credentials override wallet entries; never pass key values in arguments.
`;
export function parse(args: string[], command?: string) {
  const definition = command ? COMMANDS[command] : undefined;
  const accepted: Record<string, "value" | "repeat" | "boolean"> = {
    ...GLOBAL_FLAGS,
    ...(definition?.flags || {}),
  };
  const flags: Record<string, string[]> = {},
    pos: string[] = [];
  let ended = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") {
      ended = true;
      continue;
    }
    if (!ended && (a === "-h" || a === "--help")) {
      flags.help = ["true"];
      continue;
    }
    if (!ended && a.startsWith("--")) {
      const eq = a.indexOf("="),
        k = a.slice(2, eq < 0 ? undefined : eq),
        kind = accepted[k];
      if (!kind)
        throw new CliError(
          "UNKNOWN_FLAG",
          `Unknown flag --${k}${command ? " for " + command : ""}. Use imagegen help ${command || ""}.`,
        );
      if (flags[k] && kind !== "repeat")
        throw new CliError(
          "DUPLICATE_FLAG",
          `--${k} may only be specified once`,
        );
      let value: string;
      if (kind === "boolean") {
        if (eq >= 0)
          throw new CliError("INVALID_FLAG", `--${k} does not take a value`);
        value = "true";
      } else {
        value = eq >= 0 ? a.slice(eq + 1) : args[++i]!;
        if (value === undefined || value.startsWith("--"))
          throw new CliError("MISSING_VALUE", `Missing value for --${k}`);
      }
      (flags[k] ??= []).push(value);
    } else if (!ended && a.startsWith("-") && a !== "-")
      throw new CliError("UNKNOWN_FLAG", `Unknown option: ${a}`);
    else pos.push(a);
  }
  if (flags.json && flags.jsonl)
    throw new CliError("OUTPUT_CONFLICT", "Choose --json or --jsonl");
  return { flags, pos, get: (k: string) => flags[k]?.at(-1) };
}
export function findImage(library: Library, id: string): ImageEntry {
  const rows = library
    .images()
    .filter((i) => i.id === id || i.id.startsWith(id));
  if (rows.length !== 1)
    throw new CliError(
      rows.length ? "AMBIGUOUS_ID" : "NOT_FOUND",
      rows.length ? "Ambiguous image ID" : "Image not found",
      rows.length ? 2 : 6,
    );
  return rows[0]!;
}
function integer(
  value: string | undefined,
  name: string,
  fallback: number,
  min = 0,
) {
  if (value !== undefined && !/^\d+$/.test(value))
    throw new CliError(
      "INVALID_NUMBER",
      `${name} must be an integer >= ${min}`,
    );
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < min)
    throw new CliError(
      "INVALID_NUMBER",
      `${name} must be an integer >= ${min}`,
    );
  return n;
}
const statuses = [
  "queued",
  "submitting",
  "running",
  "downloading",
  "completed",
  "failed",
  "uncertain",
  "paused",
  "cancelled",
];
const activeStates = new Set([
  "queued",
  "submitting",
  "running",
  "downloading",
]);
function publicJob(job: Job, dir: string, batch: { id: string; name: string }) {
  const { results, remote, ...record } = job;
  return {
    ...record,
    batchId: batch.id,
    batchName: batch.name,
    directory: dir,
    remoteRequestId: remote?.id,
    references: job.references.map((p) => join(dir, p)),
    outputs: job.outputs.map((o, index) => ({
      ...o,
      imageId: `${job.id}-${index}`,
      path: join(dir, o.file),
      metadataPath: join(dir, o.file) + ".json",
    })),
  };
}
function jobList(library: Library) {
  return library
    .batches()
    .flatMap(({ dir, batch }) =>
      batch.jobs.map((job) => publicJob(job, dir, batch)),
    );
}
function matchingJobs(library: Library, ids: string[], batchId?: string) {
  const all = jobList(library);
  const selected = ids.length
    ? ids.map((id) => {
        const m = all.filter((j) => j.id === id || j.id.startsWith(id));
        if (m.length !== 1)
          throw new CliError(
            m.length ? "AMBIGUOUS_ID" : "NOT_FOUND",
            "Job ID must match exactly one job",
            m.length ? 2 : 6,
          );
        return m[0]!;
      })
    : all;
  return batchId
    ? selected.filter((j) => j.batchId.startsWith(batchId))
    : selected;
}
function summarize(library: Library, ids: string[]) {
  const jobs = ids.length ? matchingJobs(library, ids) : [];
  return {
    jobIds: jobs.map((j) => j.id),
    jobs,
    outputs: jobs.flatMap((j) => j.outputs),
    complete: jobs.every((j) => j.status === "completed"),
  };
}
export async function runCli(
  args: string[],
  library: Library,
  dependencies: {
    engineFactory?: (library: Library) => Engine;
    stdin?: () => Promise<string>;
  } = {},
) {
  const front: string[] = [];
  while (args[0] === "--json" || args[0] === "--jsonl") {
    front.push(args[0]);
    args = args.slice(1);
  }
  if (front.length) args = [args[0] || "help", ...front, ...args.slice(1)];
  const raw = args[0] || "help",
    command = ["--version", "version"].includes(raw)
      ? "version"
      : ["--help", "-h"].includes(raw)
        ? "help"
        : raw;
  if (!COMMANDS[command])
    throw new CliError(
      "UNKNOWN_COMMAND",
      `Unknown command: ${raw}. Use imagegen --help.`,
    );
  const { flags, pos, get } = parse(args.slice(1), command),
    json = !!get("json"),
    jsonl = !!get("jsonl");
  const emit = (data: unknown, error?: CliError) => {
    const value = envelope(command, data, error);
    if (json) console.log(JSON.stringify(value));
    else if (jsonl) console.log(JSON.stringify({ event: "result", ...value }));
    else if (error)
      console.error(
        `${error.code}: ${error.message}\n${data ? JSON.stringify(data, null, 2) : ""}`,
      );
    else
      console.log(
        typeof data === "string" ? data : JSON.stringify(data, null, 2),
      );
    if (error) process.exitCode = error.exitCode;
  };
  if (get("help") || command === "help") {
    const subject = command === "help" ? pos[0] : command;
    if (subject && !COMMANDS[subject])
      throw new CliError("UNKNOWN_COMMAND", `Unknown command ${subject}`);
    emit(
      subject
        ? { command: subject, ...COMMANDS[subject], globalFlags: GLOBAL_FLAGS }
        : HELP,
    );
    return;
  }
  const needs = (count: number) => {
    if (pos.length !== count)
      throw new CliError(
        "INVALID_ARGUMENTS",
        `${command} needs ${count} positional argument(s). Use imagegen help ${command}.`,
      );
  };
  const stdin = async () => {
    if (process.stdin.isTTY && !dependencies.stdin)
      throw new CliError("STDIN_REQUIRED", "Pipe input into this command");
    return dependencies.stdin ? dependencies.stdin() : await Bun.stdin.text();
  };
  const readInput = async (path: string) =>
    path === "-" ? stdin() : readFileSync(expand(path), "utf8");
  const pagination = <T>(items: T[]) => {
    const offset = integer(get("offset"), "offset", 0),
      limit = integer(get("limit"), "limit", 100, 1);
    return {
      items: items.slice(offset, offset + limit),
      total: items.length,
      offset,
      limit,
    };
  };
  if (command === "version") {
    needs(0);
    emit(json || jsonl ? { version: CLI_VERSION } : `imagegen ${CLI_VERSION}`);
    return;
  }
  if (command === "schema") {
    if (pos.length > 1 || (pos[0] && !["batch", "response"].includes(pos[0])))
      throw new CliError(
        "INVALID_ARGUMENTS",
        "schema accepts batch or response",
      );
    emit(
      pos[0] === "batch"
        ? BATCH_SCHEMA
        : pos[0] === "response"
          ? RESPONSE_SCHEMA
          : {
              version: CLI_VERSION,
              commands: COMMANDS,
              globalFlags: GLOBAL_FLAGS,
              exitCodes: EXIT_CODES,
              batchSchema: BATCH_SCHEMA,
              responseSchema: RESPONSE_SCHEMA,
            },
    );
    return;
  }
  if (command === "models") {
    if (pos.length > 1)
      throw new CliError("INVALID_ARGUMENTS", "models accepts at most one ID");
    emit(pos[0] ? modelFor(pos[0]) : MODELS);
    return;
  }
  if (command === "jobs") {
    if (pos.length > 1)
      throw new CliError("INVALID_ARGUMENTS", "jobs accepts at most one ID");
    for (const s of flags.status || [])
      if (!statuses.includes(s))
        throw new CliError("INVALID_STATUS", `Unknown status ${s}`);
    const jobs = matchingJobs(library, pos, get("batch")).filter(
      (j) => !flags.status || flags.status.includes(j.status),
    );
    if (pos.length && !jobs.length)
      throw new CliError(
        "NOT_FOUND",
        "Job does not match the requested batch/status filters",
        6,
      );
    emit(pos.length ? jobs[0] : pagination(jobs));
    return;
  }
  if (command === "image") {
    needs(1);
    emit(findImage(library, pos[0]!));
    return;
  }
  if (command === "library") {
    needs(0);
    if (get("sort") && !["newest", "oldest", "model"].includes(get("sort")!))
      throw new CliError("INVALID_SORT", "Choose newest, oldest, or model");
    const rebuilt = get("rebuild") ? library.rebuild() : undefined;
    const items = library
      .images(get("query"), !!get("favorite"), get("sort"))
      .filter(
        (i) =>
          (!get("model") || i.model === get("model")) &&
          (!get("provider") || i.provider === get("provider")) &&
          (!get("batch") || i.batchId.startsWith(get("batch")!)) &&
          (flags.tag || []).every((t) => i.tags.includes(t)),
      );
    emit({
      ...pagination(items),
      ...(rebuilt !== undefined ? { rebuilt } : {}),
    });
    return;
  }
  if (command === "export") {
    if (!pos.length || !get("to"))
      throw new CliError(
        "INVALID_ARGUMENTS",
        "export needs image IDs and --to DIR",
      );
    emit({
      paths: library.export(
        pos.map((id) => findImage(library, id)),
        get("to")!,
        !get("no-metadata"),
        !!get("overwrite"),
      ),
    });
    return;
  }
  if (command === "auth") {
    needs(1);
    const provider = pos[0] as Provider;
    if (!AUTH_PROVIDERS.some((p) => p.id === provider))
      throw new CliError("INVALID_PROVIDER", "Choose a provider from models");
    if (["key-file", "endpoint", "remove"].filter((k) => get(k)).length > 1)
      throw new CliError(
        "CONFLICTING_FLAGS",
        "Choose one authentication operation",
      );
    if (get("key-file"))
      await authentication.save(
        provider,
        "key",
        readFileSync(expand(get("key-file")!), "utf8"),
      );
    else if (get("endpoint"))
      await authentication.save(provider, "endpoint", get("endpoint")!);
    else if (get("remove")) await authentication.remove(provider);
    emit({ provider, ...(await authentication.status(provider)) });
    return;
  }
  if (command === "doctor") {
    needs(0);
    const engine = await callEngine(library.root, { type: "status" }),
      credentials = [];
    for (const p of AUTH_PROVIDERS)
      try {
        credentials.push({
          provider: p.id,
          ...(await authentication.status(p.id)),
        });
      } catch {
        credentials.push({
          provider: p.id,
          key: process.env[p.env] ? "environment" : "not configured",
          wallet: "unavailable",
        });
      }
    emit({
      version: CLI_VERSION,
      root: library.root,
      config: configRoot(),
      state: library.state,
      terminal: process.env.TERM_PROGRAM || process.env.TERM || "unknown",
      engine: engine
        ? { pid: engine.pid, active: engine.active, paused: engine.paused }
        : null,
      credentials,
      externalViewer: Bun.which("xdg-open"),
    });
    return;
  }
  if (command === "view") {
    needs(1);
    if (json || jsonl)
      throw new CliError(
        "INTERACTIVE_COMMAND",
        "Use image IMAGE_ID --json for agent inspection, or view --external without --json",
      );
    const image = findImage(library, pos[0]!);
    if (get("external")) {
      await openExternal(image.path);
      return;
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY)
      throw new CliError(
        "TTY_REQUIRED",
        "Inline viewing requires a terminal; use image IMAGE_ID --json to obtain its path",
      );
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
  let request: ControlRequest | undefined;
  if (command === "config") {
    needs(0);
    const providerLimits: Partial<Record<Provider, number>> = {};
    for (const v of flags["provider-limit"] || []) {
      const [p, n, ...rest] = v.split("=");
      if (!p || !n || rest.length)
        throw new CliError(
          "INVALID_CONCURRENCY",
          "Use --provider-limit PROVIDER=N",
        );
      providerLimits[p as Provider] = integer(n, "provider limit", 1, 1);
    }
    const update = {
      concurrency:
        get("concurrency") === undefined
          ? undefined
          : integer(get("concurrency"), "concurrency", 4, 1),
      providerLimits,
    };
    validateLimits(update);
    const remote = await callEngine(library.root, {
      type: "config",
      ...update,
    });
    if (remote) {
      emit(remote);
      return;
    }
    const config = loadConfig();
    if (update.concurrency !== undefined)
      config.concurrency = update.concurrency;
    Object.assign(config.providerLimits, providerLimits);
    if (get("concurrency") || flags["provider-limit"]) saveConfig(config);
    emit(config);
    return;
  }
  if (command === "annotate") {
    if (!pos.length)
      throw new CliError("INVALID_ARGUMENTS", "annotate needs image IDs");
    if (get("favorite") && get("unfavorite"))
      throw new CliError(
        "CONFLICTING_FLAGS",
        "Choose --favorite or --unfavorite",
      );
    if (
      !["tags", "add-tag", "remove-tag", "favorite", "unfavorite"].some((k) =>
        get(k),
      )
    )
      throw new CliError("INVALID_ARGUMENTS", "Choose an annotation to change");
    request = {
      type: "annotate",
      ids: pos,
      tags:
        get("tags") !== undefined
          ? get("tags")!
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean)
          : undefined,
      addTags: flags["add-tag"],
      removeTags: flags["remove-tag"],
      favorite: get("favorite") ? true : get("unfavorite") ? false : undefined,
    };
  }
  if (command === "cancel") {
    if (!pos.length)
      throw new CliError("INVALID_ARGUMENTS", "cancel needs job IDs");
    request = { type: "cancel", ids: pos };
  }
  if (command === "pause") {
    needs(0);
    request = { type: "pause" };
  }
  if (command === "resume") {
    if (pos.length > 1)
      throw new CliError(
        "INVALID_ARGUMENTS",
        "resume accepts at most one job ID",
      );
    request = { type: "resume", id: pos[0], retry: !!get("retry") };
  }
  if (["generate", "batch"].includes(command)) {
    let spec: BatchSpec;
    if (command === "generate") {
      needs(0);
      if (Number(!!get("prompt")) + Number(!!get("prompt-file")) !== 1)
        throw new CliError(
          "INVALID_PROMPT",
          "Choose exactly one --prompt or --prompt-file",
        );
      if (get("settings") && get("settings-file"))
        throw new CliError(
          "CONFLICTING_FLAGS",
          "Choose --settings or --settings-file",
        );
      const prompt = get("prompt-file")
        ? await readInput(get("prompt-file")!)
        : get("prompt") === "-"
          ? await stdin()
          : get("prompt")!;
      const sources = (flags.from || []).map((id) => findImage(library, id));
      spec = {
        schemaVersion: 1,
        name: get("name") || "generation",
        rows: [
          {
            prompt,
            model: get("model") || sources[0]?.model || "gpt-image-2.5-flare",
            provider: get("provider") as Provider | undefined,
            count: integer(get("count"), "count", 1, 1),
            references: [
              ...sources.map((i) => i.path),
              ...(flags.ref || []).map(expand),
            ],
            parentIds: [
              ...sources.map((i) => i.id),
              ...(flags["parent-id"] || []),
            ],
            settings: JSON.parse(
              get("settings-file")
                ? await readInput(get("settings-file")!)
                : get("settings") || "{}",
            ),
          },
        ],
      };
    } else {
      needs(1);
      const path = pos[0]!,
        base = path === "-" ? process.cwd() : dirname(expand(path));
      spec = JSON.parse(await readInput(path));
      if (!spec || !Array.isArray(spec.rows))
        throw new CliError("INVALID_BATCH", "Batch requires a rows array");
      const absolute = (p: string) =>
        p.startsWith("~") || p.startsWith("/") ? expand(p) : join(base, p);
      for (const r of spec.rows) r.references = r.references?.map(absolute);
      if (spec.matrix?.references)
        spec.matrix.references = spec.matrix.references.map(absolute);
    }
    const rows = expandBatch(spec);
    if (get("dry-run")) {
      emit({
        dryRun: true,
        name: spec.name,
        jobCount: rows.reduce((n, r) => n + (r.count || 1), 0),
        rows,
      });
      return;
    }
    request = {
      type: "submit",
      spec,
      requestKey: get("request-key") || crypto.randomUUID(),
    };
  }
  const timeout = integer(get("timeout"), "timeout", 0),
    noWait = !!get("no-wait");
  if (command === "wait" && !pos.length && !get("batch"))
    throw new CliError("INVALID_ARGUMENTS", "wait needs job IDs or --batch ID");
  let deadlineForCleanup = Infinity;
  let owned: Engine | undefined,
    stopServer: (() => void) | undefined,
    interrupted = 0,
    receipt: any;
  const interrupt = () => {
      interrupted = 130;
      void owned?.close(true);
    },
    terminate = () => {
      interrupted = 143;
      void owned?.close(true);
    };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  try {
    if (request) {
      receipt = await callEngine(library.root, request);
      if (
        receipt === null &&
        existsSync(join(library.root, ".imagegen.lock"))
      ) {
        for (let attempt = 0; attempt < 20 && receipt === null; attempt++) {
          await Bun.sleep(100);
          receipt = await callEngine(library.root, request);
        }
      }
      if (receipt === null) {
        if (noWait || command === "pause")
          throw new CliError(
            "ENGINE_UNAVAILABLE",
            "No engine is running. Open imagegen first, or submit without --no-wait.",
            5,
          );
        owned = dependencies.engineFactory
          ? dependencies.engineFactory(library)
          : new Engine(library);
        stopServer = await serveEngine(owned);
        if (interrupted)
          throw new CliError(
            "INTERRUPTED",
            "Interrupted before submission",
            interrupted,
          );
        receipt = await dispatch(owned, request);
      }
    }
    if (["cancel", "pause", "annotate"].includes(command) || noWait) {
      emit(receipt);
      return;
    }
    const ids: string[] =
      command === "wait"
        ? matchingJobs(library, pos, get("batch")).map((j) => j.id)
        : receipt.jobIds;
    if (!ids.length && command === "wait")
      throw new CliError("NOT_FOUND", "No matching jobs", 6);
    if (!ids.length) {
      emit({
        ...receipt,
        ...summarize(library, []),
        jobs: [],
        outputs: [],
        complete: true,
      });
      return;
    }
    const deadline = timeout ? Date.now() + timeout * 1000 : Infinity;
    deadlineForCleanup = deadline;
    const seen = new Map<string, string>();
    let lastOwnerCheck = 0;
    while (true) {
      const result = summarize(library, ids);
      if (jsonl)
        for (const job of result.jobs) {
          const value = JSON.stringify(job);
          if (seen.get(job.id) !== value) {
            seen.set(job.id, value);
            console.log(
              JSON.stringify({ schemaVersion: 1, event: "job", data: job }),
            );
          }
        }
      if (interrupted) {
        if (owned) await owned.close(true);
        emit(
          { ...receipt, ...summarize(library, ids) },
          new CliError(
            "INTERRUPTED",
            owned
              ? "Owned jobs interrupted locally; recover known requests with resume"
              : "Stopped waiting; owner continues running jobs",
            interrupted,
          ),
        );
        return;
      }
      if (!result.jobs.some((j) => activeStates.has(j.status))) {
        emit(
          { ...receipt, ...result },
          result.complete
            ? undefined
            : new CliError(
                "JOBS_INCOMPLETE",
                "Some requested jobs failed, paused, were cancelled, or have uncertain submission outcomes",
                3,
              ),
        );
        return;
      }
      if (Date.now() >= deadline) {
        if (owned) await owned.close(true);
        emit(
          { ...receipt, ...summarize(library, ids) },
          new CliError(
            "WAIT_TIMEOUT",
            owned
              ? "Wait deadline reached; owned jobs will pause on exit"
              : "Wait deadline reached; engine continues running jobs",
            4,
          ),
        );
        return;
      }
      if (!owned && Date.now() - lastOwnerCheck > 1000) {
        lastOwnerCheck = Date.now();
        if ((await callEngine(library.root, { type: "status" })) === null) {
          emit(
            { ...receipt, ...result },
            new CliError(
              "ENGINE_UNAVAILABLE",
              "The job engine is no longer running; inspect jobs and use resume for recovery",
              5,
            ),
          );
          return;
        }
      }
      await Bun.sleep(100);
    }
  } catch (e) {
    const error = errorInfo(e);
    if (request?.type === "submit")
      throw new CliError(error.code, error.message, error.exitCode, {
        requestKey: request.requestKey,
      });
    throw error;
  } finally {
    if (owned) {
      if (!interrupted && Date.now() < deadlineForCleanup) {
        const deadlineTimer = Number.isFinite(deadlineForCleanup)
          ? setTimeout(
              () => {
                void owned!.close(true);
              },
              Math.max(0, deadlineForCleanup - Date.now()),
            )
          : undefined;
        try {
          await owned.idle();
        } finally {
          if (deadlineTimer) clearTimeout(deadlineTimer);
        }
      }
      await owned.close(true);
      stopServer?.();
    }
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}
