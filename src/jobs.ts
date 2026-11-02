import { EventEmitter } from "node:events";
import { loadConfig, type Config } from "./config";
import { Library } from "./storage";
import { HttpError, Providers, type Adapter } from "./providers";
import type { Batch, Job } from "./types";
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const done = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
export class Engine extends EventEmitter {
  entries = new Map<string, { dir: string; batch: Batch; job: Job }>();
  active = new Map<string, AbortController>();
  paused = false;
  closing = false;
  private tasks = new Set<Promise<void>>();
  private release: () => void;
  constructor(
    readonly library: Library,
    readonly adapter: Adapter = new Providers(),
    readonly config: Config = loadConfig(),
    readonly pollMs = 2000,
  ) {
    super();
    this.release = library.acquire();
    try {
      for (const { dir, batch } of library.batches()) {
        for (const job of batch.jobs) {
          if (job.status === "queued") job.status = "paused";
          if (["submitting", "running", "downloading"].includes(job.status)) {
            job.status =
              job.results?.length || job.remote ? "paused" : "uncertain";
            job.error =
              job.status === "uncertain"
                ? "Submission outcome unknown; explicit retry may incur another charge"
                : undefined;
          }
          this.entries.set(job.id, { dir, batch, job });
        }
        library.save(dir, batch);
      }
    } catch (e) {
      this.release();
      throw e;
    }
  }
  add(dir: string, batch: Batch) {
    for (const job of batch.jobs) this.entries.set(job.id, { dir, batch, job });
    this.emit("change");
    this.pump();
  }
  private save(id: string) {
    const e = this.entries.get(id)!;
    e.job.updatedAt = new Date().toISOString();
    this.library.save(e.dir, e.batch);
    this.emit("change");
  }
  pump() {
    if (this.paused) return;
    for (const [id, e] of this.entries) {
      if (this.active.size >= this.config.concurrency) break;
      if (e.job.status !== "queued" || this.active.has(id)) continue;
      const count = [...this.active.keys()].filter(
        (k) => this.entries.get(k)!.job.provider === e.job.provider,
      ).length;
      if (
        count >=
        (this.config.providerLimits[e.job.provider] || this.config.concurrency)
      )
        continue;
      const controller = new AbortController();
      this.active.set(id, controller);
      const task = this.run(id, controller.signal)
        .catch((error) => {
          e.job.status = e.job.status === "submitting" ? "uncertain" : "failed";
          e.job.error = `Job storage/engine failure: ${error instanceof Error ? error.message : "unknown"}`;
          if (this.listenerCount("error")) this.emit("error", error);
        })
        .finally(() => {
          this.active.delete(id);
          this.tasks.delete(task);
          this.emit("change");
          queueMicrotask(() => this.pump());
        });
      this.tasks.add(task);
    }
  }
  private async run(id: string, signal: AbortSignal) {
    const { job, dir, batch } = this.entries.get(id)!;
    try {
      await this.adapter.prepare(job);
      if (signal.aborted) throw signal.reason;
      if (!job.remote && !job.results?.length) {
        for (let retry = 0; ; retry++) {
          if (this.paused || job.status === "paused") {
            job.status = "paused";
            return;
          }
          job.status = "submitting";
          job.attempts++;
          job.error = undefined;
          this.save(id);
          try {
            const receipt = await this.adapter.submit(job, dir, signal);
            Object.assign(job, receipt);
            if (signal.aborted) {
              if (String(job.status) !== "cancelled") job.status = "paused";
              this.save(id);
              return;
            }
            job.status = job.results?.length ? "downloading" : "running";
            this.save(id);
            break;
          } catch (error) {
            if (String(job.status) === "cancelled") throw error;
            // Only an explicit rejection is safe to resubmit automatically.
            if (
              error instanceof HttpError &&
              error.status === 429 &&
              retry < 3
            ) {
              job.status = "queued";
              this.save(id);
              await sleep(
                Math.max(error.retryAfter, 1000 * 2 ** retry),
                signal,
              );
              continue;
            }
            if (error instanceof HttpError && error.status < 500)
              job.status = "failed";
            else job.status = "uncertain";
            throw error;
          }
        }
      }
      if (!job.results?.length) {
        job.status = "running";
        this.save(id);
        let failures = 0;
        while (!job.results?.length) {
          try {
            const result = await this.adapter.poll(job, signal);
            if (result) {
              Object.assign(job, result);
              this.save(id);
            }
            failures = 0;
          } catch (error) {
            if (
              error instanceof HttpError &&
              [400, 401, 403, 404, 422].includes(error.status)
            )
              throw error;
            if (++failures > 5) throw error;
          }
          if (!job.results?.length) await sleep(this.pollMs, signal);
        }
      }
      job.status = "downloading";
      this.save(id);
      for (let i = 0; i < job.results.length; i++) {
        if (signal.aborted) throw signal.reason;
        let bytes: Uint8Array;
        try {
          bytes = await this.adapter.download(job.results[i]!, signal);
        } catch (error) {
          if (
            job.remote &&
            error instanceof HttpError &&
            [401, 403, 404, 410].includes(error.status)
          ) {
            const refreshed = await this.adapter.poll(job, signal);
            if (!refreshed?.results) throw error;
            Object.assign(job, refreshed);
            this.save(id);
            bytes = await this.adapter.download(job.results![i]!, signal);
          } else throw error;
        }
        job.outputs[i] = this.library.saveOutput(dir, batch, job, bytes, i);
        this.save(id);
      }
      job.status = "completed";
      job.error = undefined;
      delete job.results;
    } catch (error) {
      if (signal.aborted) {
        if (job.status !== "cancelled")
          job.status = ["submitting", "uncertain"].includes(job.status)
            ? "uncertain"
            : "paused";
      } else {
        if (!["uncertain", "failed"].includes(job.status))
          job.status = "failed";
        job.error =
          error instanceof HttpError
            ? error.message
            : job.status === "uncertain"
              ? "Submission outcome unknown. Inspect provider history before retrying."
              : error instanceof Error
                ? error.message
                : "Request failed";
      }
    } finally {
      this.save(id);
    }
  }
  pause() {
    this.paused = true;
    for (const [id, e] of this.entries)
      if (e.job.status === "queued") {
        e.job.status = "paused";
        this.save(id);
      }
    this.emit("change");
  }
  resume(id?: string, retry = false) {
    this.paused = false;
    const entries = id
      ? [this.entries.get(id)]
      : [...this.entries.values()].filter((e) => e.job.status === "paused");
    for (const e of entries) {
      if (!e) throw new Error("Job not found");
      if (this.active.has(e.job.id)) continue;
      if (e.job.status === "completed") continue;
      if (["uncertain", "cancelled"].includes(e.job.status) && !retry)
        throw new Error(
          "Explicit retry confirmation required; another charge is possible",
        );
      if (
        e.job.status === "failed" &&
        !e.job.remote &&
        !e.job.results &&
        !retry
      )
        throw new Error("Failed submission requires explicit retry");
      if (retry) {
        const now = new Date().toISOString();
        const job: Job = {
          ...structuredClone(e.job),
          id: crypto.randomUUID(),
          status: "queued",
          attempts: 0,
          createdAt: now,
          updatedAt: now,
          outputs: [],
          remote: undefined,
          results: undefined,
          requestId: undefined,
          usage: undefined,
          error: undefined,
        };
        e.batch.jobs.push(job);
        this.entries.set(job.id, { dir: e.dir, batch: e.batch, job });
        this.save(job.id);
        continue;
      }
      e.job.status = "queued";
      e.job.error = undefined;
      this.save(e.job.id);
    }
    this.pump();
  }
  async cancel(id: string) {
    const e = this.entries.get(id);
    if (!e) throw new Error("Job not found");
    if (e.job.status === "completed") return;
    e.job.status = "cancelled";
    this.save(id);
    this.active.get(id)?.abort();
    await this.adapter.cancel(e.job).catch(() => {});
  }
  async idle() {
    while (
      this.active.size ||
      [...this.entries.values()].some(
        (e) => !this.paused && e.job.status === "queued",
      )
    ) {
      this.pump();
      await Promise.all([...this.tasks]);
    }
  }
  async close(interrupt = true) {
    if (!this.closing) {
      this.closing = true;
      this.emit("closing");
    }
    this.pause();
    if (interrupt) for (const c of this.active.values()) c.abort();
    await Promise.all([...this.tasks]);
    this.release();
  }
}
