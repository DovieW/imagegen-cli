import { createServer, Socket, type Server } from "node:net";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Engine } from "./jobs";
import type { BatchSpec, ImageRecord, Provider } from "./types";
import { CliError, errorInfo } from "./errors";
import { saveConfig } from "./config";
import { AUTH_PROVIDERS } from "./auth";
export type ControlRequest =
  | { type: "submit"; spec: BatchSpec; requestKey: string }
  | { type: "resume"; id?: string; retry: boolean }
  | { type: "cancel"; ids: string[] }
  | { type: "pause" }
  | {
      type: "config";
      concurrency?: number;
      providerLimits?: Partial<Record<Provider, number>>;
    }
  | {
      type: "annotate";
      ids: string[];
      tags?: string[];
      addTags?: string[];
      removeTags?: string[];
      favorite?: boolean;
    }
  | { type: "status" };
export const socketPath = (root: string) => join(root, ".imagegen.sock");
export function validateLimits(request: {
  concurrency?: number;
  providerLimits?: Partial<Record<Provider, number>>;
}) {
  for (const n of [
    request.concurrency,
    ...Object.values(request.providerLimits || {}),
  ].filter((n) => n !== undefined))
    if (!Number.isInteger(n) || n! < 1 || n! > 1000)
      throw new CliError(
        "INVALID_CONCURRENCY",
        "Concurrency must be an integer from 1–1000",
      );
  for (const id of Object.keys(request.providerLimits || {}))
    if (!AUTH_PROVIDERS.some((p) => p.id === id))
      throw new CliError("INVALID_PROVIDER", `Unknown provider: ${id}`);
}
export function resolveJob(engine: Engine, id: string) {
  const matches = [...engine.entries.values()].filter(
    (e) => e.job.id === id || e.job.id.startsWith(id),
  );
  if (matches.length !== 1)
    throw new CliError(
      matches.length ? "AMBIGUOUS_ID" : "NOT_FOUND",
      matches.length ? "Ambiguous job ID" : "Job not found",
      matches.length ? 2 : 6,
    );
  return matches[0]!;
}
export async function dispatch(
  engine: Engine,
  request: ControlRequest,
): Promise<any> {
  if (engine.closing)
    throw new CliError(
      "ENGINE_CLOSING",
      "Engine is shutting down; retry the same request key after it closes",
      5,
    );
  switch (request.type) {
    case "status":
      return {
        pid: process.pid,
        root: engine.library.root,
        active: engine.active.size,
        paused: engine.paused,
        config: engine.config,
      };
    case "submit": {
      const e = engine.library.createIdempotent(
        request.spec,
        request.requestKey,
      );
      if (!e.reused) {
        engine.paused = false;
        engine.add(e.dir, e.batch);
      }
      return {
        batchId: e.batch.id,
        requestKey: request.requestKey,
        jobIds: e.batch.jobs.map((j) => j.id),
        directory: e.dir,
        reused: e.reused,
      };
    }
    case "resume": {
      const before = new Set(engine.entries.keys());
      const id = request.id ? resolveJob(engine, request.id).job.id : undefined;
      const ids = id
        ? [id]
        : [...engine.entries.values()]
            .filter((e) => e.job.status === "paused")
            .map((e) => e.job.id);
      engine.resume(id, request.retry);
      return {
        jobIds: request.retry
          ? [...engine.entries.keys()].filter((id) => !before.has(id))
          : ids,
      };
    }
    case "pause":
      engine.pause();
      return { paused: true };
    case "cancel": {
      if (!Array.isArray(request.ids) || !request.ids.length)
        throw new CliError("INVALID_INPUT", "cancel needs job IDs");
      const ids = request.ids.map((id) => resolveJob(engine, id).job.id);
      await Promise.all(ids.map((id) => engine.cancel(id)));
      return { jobIds: ids, cancellation: "best-effort" };
    }
    case "config": {
      validateLimits(request);
      if (request.concurrency !== undefined)
        engine.config.concurrency = request.concurrency;
      Object.assign(engine.config.providerLimits, request.providerLimits);
      if (
        request.concurrency !== undefined ||
        Object.keys(request.providerLimits || {}).length
      ) {
        saveConfig(engine.config);
        engine.emit("change");
        engine.pump();
      }
      return engine.config;
    }
    case "annotate": {
      const images = engine.library.images();
      const selected = request.ids.map((id) => {
        const items = images.filter((i) => i.id.startsWith(id));
        if (items.length !== 1)
          throw new CliError(
            items.length ? "AMBIGUOUS_ID" : "NOT_FOUND",
            "Image ID must match exactly one image",
            items.length ? 2 : 6,
          );
        return items[0]!;
      });
      for (const i of selected) {
        const tags = [
          ...new Set([...(request.tags ?? i.tags), ...(request.addTags || [])]),
        ].filter((t) => !request.removeTags?.includes(t));
        engine.library.annotate(i, {
          tags,
          ...(request.favorite !== undefined
            ? { favorite: request.favorite }
            : {}),
        });
      }
      engine.emit("change");
      return { imageIds: selected.map((i) => i.id) };
    }
    default:
      throw new CliError("INVALID_CONTROL_REQUEST", "Unknown engine operation");
  }
}
export async function serveEngine(engine: Engine) {
  const path = socketPath(engine.library.root);
  if (existsSync(path)) unlinkSync(path);
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setTimeout(30000, () => socket.destroy());
    let buffer = Buffer.alloc(0),
      handled = false;
    socket.on("data", (chunk) => {
      if (handled) return;
      buffer = Buffer.concat([
        buffer,
        typeof chunk === "string" ? Buffer.from(chunk) : chunk,
      ]);
      if (buffer.length > 8 * 1024 * 1024) {
        socket.destroy();
        return;
      }
      const i = buffer.indexOf(10);
      if (i < 0) return;
      handled = true;
      void (async () => {
        try {
          const request = JSON.parse(buffer.subarray(0, i).toString());
          const data = await dispatch(engine, request);
          socket.end(JSON.stringify({ ok: true, data }) + "\n");
        } catch (e) {
          const error = errorInfo(e);
          socket.end(
            JSON.stringify({
              ok: false,
              error: {
                code: error.code,
                message: error.message,
                exitCode: error.exitCode,
              },
            }) + "\n",
          );
        }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      chmodSync(path, 0o600);
      resolve();
    });
  });
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    server.close();
    for (const socket of sockets) socket.destroy();
    engine.off("closing", stop);
  };
  engine.once("closing", stop);
  return stop;
}
// Only connection failures before a request is sent may fall back to a local engine.
export function callEngine(
  root: string,
  request: ControlRequest,
): Promise<any | null> {
  return new Promise((resolve, reject) => {
    let sent = false,
      buffer = Buffer.alloc(0),
      done = false;
    const socket = new Socket();
    const finish = (error?: Error, value?: unknown) => {
      if (done) return;
      done = true;
      socket.destroy();
      error ? reject(error) : resolve(value);
    };
    socket.setTimeout(30000, () =>
      finish(
        new CliError(
          "ENGINE_TIMEOUT",
          "Engine control request timed out; resubmit using the same request key",
          4,
        ),
      ),
    );
    socket.on("connect", () => {
      sent = true;
      socket.write(JSON.stringify(request) + "\n");
    });
    const onError = (e: Error) => {
      if (
        !sent &&
        ["ENOENT", "ECONNREFUSED"].includes(
          (e as NodeJS.ErrnoException).code || "",
        )
      )
        finish(undefined, null);
      else
        finish(
          new CliError(
            "CONTROL_OUTCOME_UNKNOWN",
            "Engine connection failed; inspect jobs or resubmit using the same request key",
            5,
          ),
        );
    };
    socket.on("error", onError);
    socket.on("end", () => {
      if (!done)
        finish(
          new CliError(
            "CONTROL_OUTCOME_UNKNOWN",
            "Engine closed before acknowledging the request; reuse the request key",
            5,
          ),
        );
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([
        buffer,
        typeof chunk === "string" ? Buffer.from(chunk) : chunk,
      ]);
      if (buffer.length > 16 * 1024 * 1024)
        return finish(
          new CliError(
            "ENGINE_PROTOCOL_ERROR",
            "Engine response exceeds limit",
            1,
          ),
        );
      const i = buffer.indexOf(10);
      if (i < 0) return;
      try {
        const value = JSON.parse(buffer.subarray(0, i).toString());
        if (value.ok) finish(undefined, value.data);
        else
          finish(
            new CliError(
              value.error.code,
              value.error.message,
              value.error.exitCode,
            ),
          );
      } catch {
        finish(
          new CliError("ENGINE_PROTOCOL_ERROR", "Invalid engine response", 1),
        );
      }
    });
    try {
      socket.connect(socketPath(root));
    } catch (e) {
      onError(e as Error);
    }
  });
}
