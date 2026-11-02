import { expect, test } from "bun:test";
import { Engine } from "../src/jobs";
import { defaults } from "../src/config";
import { HttpError } from "../src/providers";
import { adapter, fixture } from "./helpers";
const create = (f: ReturnType<typeof fixture>, count = 1) =>
  f.library.create({
    schemaVersion: 1,
    name: "test",
    rows: [{ prompt: "fox", model: "gpt-image-2.5-flare", count }],
  });
test("mixed batches respect global and per-provider limits; independent failure does not block outputs", async () => {
  const f = fixture();
  let active = 0,
    max = 0;
  const providerActive: Record<string, number> = {},
    maxProvider: Record<string, number> = {};
  const a = adapter({
    submit: async (job) => {
      active++;
      max = Math.max(active, max);
      providerActive[job.provider] = (providerActive[job.provider] || 0) + 1;
      maxProvider[job.provider] = Math.max(
        maxProvider[job.provider] || 0,
        providerActive[job.provider]!,
      );
      await Bun.sleep(15);
      active--;
      providerActive[job.provider]!--;
      if (job.prompt === "bad") throw new HttpError(400);
      return { results: ["mock"] };
    },
  });
  const e = new Engine(f.library, a, {
    ...defaults(),
    concurrency: 3,
    providerLimits: { openai: 1 },
  });
  try {
    const first = create(f, 3);
    e.add(first.dir, first.batch);
    const other = f.library.create({
      schemaVersion: 1,
      name: "second",
      rows: [
        { prompt: "other", model: "gemini-nano-banana-2.1", count: 3 },
        { prompt: "bad", model: "gpt-image-2.5-flare" },
      ],
    });
    e.add(other.dir, other.batch);
    await e.idle();
    expect(max).toBe(3);
    expect(maxProvider.openai).toBe(1);
    expect(f.library.images()).toHaveLength(6);
    expect(other.batch.jobs.at(-1)!.status).toBe("failed");
  } finally {
    await e.close();
    f.close();
  }
});
test("crash recovery never resubmits uncertain submissions; known remote requests resume by polling", async () => {
  const f = fixture(),
    first = create(f, 2);
  first.batch.jobs[0]!.status = "submitting";
  first.batch.jobs[1]!.status = "running";
  first.batch.jobs[1]!.remote = {
    id: "remote",
    statusUrl: "mock",
    resultUrl: "mock",
  };
  f.library.save(first.dir, first.batch);
  let submissions = 0,
    polls = 0;
  const e = new Engine(
    f.library,
    adapter({
      submit: async () => {
        submissions++;
        return { results: ["mock"] };
      },
      poll: async () => {
        polls++;
        return { results: ["mock"] };
      },
    }),
  );
  try {
    expect(e.entries.get(first.batch.jobs[0]!.id)!.job.status).toBe(
      "uncertain",
    );
    expect(() => e.resume(first.batch.jobs[0]!.id)).toThrow("Explicit retry");
    e.resume();
    await e.idle();
    expect(submissions).toBe(0);
    expect(polls).toBe(1);
    expect(f.library.images()).toHaveLength(1);
    e.resume(first.batch.jobs[0]!.id, true);
    await e.idle();
    expect(submissions).toBe(1);
  } finally {
    await e.close();
    f.close();
  }
});
test("ambiguous network/5xx submission stays uncertain and is not automatically retried", async () => {
  for (const error of [new Error("network"), new HttpError(503)]) {
    const f = fixture();
    const entry = create(f);
    let n = 0;
    const e = new Engine(
      f.library,
      adapter({
        submit: async () => {
          n++;
          throw error;
        },
      }),
    );
    try {
      e.add(entry.dir, entry.batch);
      await e.idle();
      expect(n).toBe(1);
      expect(entry.batch.jobs[0]!.status).toBe("uncertain");
    } finally {
      await e.close();
      f.close();
    }
  }
});
test("pause preserves queued jobs and interruption during submission stays uncertain", async () => {
  const f = fixture(),
    entry = create(f, 3);
  let start!: () => void;
  const started = new Promise<void>((r) => (start = r));
  const e = new Engine(
    f.library,
    adapter({
      submit: async (_j, _d, signal) => {
        start();
        await new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("abort")), {
            once: true,
          }),
        );
        return { results: [] };
      },
    }),
    { ...defaults(), concurrency: 1 },
  );
  try {
    e.add(entry.dir, entry.batch);
    await started;
    e.pause();
    expect(entry.batch.jobs.slice(1).every((j) => j.status === "paused")).toBe(
      true,
    );
    await e.close(true);
    expect(entry.batch.jobs[0]!.status).toBe("uncertain");
  } finally {
    await e.close();
    f.close();
  }
});
test("expired signed result refreshes through receipt without submitting", async () => {
  const f = fixture(),
    entry = create(f);
  const j = entry.batch.jobs[0]!;
  j.status = "paused";
  j.remote = { id: "r", statusUrl: "x", resultUrl: "x" };
  j.results = ["expired"];
  f.library.save(entry.dir, entry.batch);
  let submits = 0;
  const e = new Engine(
    f.library,
    adapter({
      submit: async () => {
        submits++;
        return {};
      },
      download: async (url) => {
        if (url === "expired") throw new HttpError(403);
        return (await import("./helpers")).png;
      },
      poll: async () => ({ results: ["fresh"] }),
    }),
  );
  try {
    e.resume();
    await e.idle();
    expect(f.library.images()).toHaveLength(1);
    expect(submits).toBe(0);
  } finally {
    await e.close();
    f.close();
  }
});

test("explicit retry creates a new job and retains the failed job and its receipt", async () => {
  const f = fixture(),
    entry = create(f);
  const old = entry.batch.jobs[0]!;
  old.status = "failed";
  old.remote = { id: "original", statusUrl: "old", resultUrl: "old" };
  f.library.save(entry.dir, entry.batch);
  const e = new Engine(f.library, adapter());
  try {
    e.resume(old.id, true);
    await e.idle();
    expect(entry.batch.jobs).toHaveLength(1);
    const saved = f.library.findJob(old.id);
    expect(saved.batch.jobs).toHaveLength(2);
    expect(saved.job.remote?.id).toBe("original");
    expect(saved.job.status).toBe("failed");
    expect(saved.batch.jobs[1]!.id).not.toBe(old.id);
    expect(saved.batch.jobs[1]!.status).toBe("completed");
  } finally {
    await e.close();
    f.close();
  }
});
test("explicit rate-limit rejection is safely retried and cancellation never resumes automatically", async () => {
  const f = fixture(),
    entry = create(f);
  let calls = 0;
  const e = new Engine(
    f.library,
    adapter({
      submit: async () => {
        calls++;
        if (calls === 1) throw new HttpError(429);
        return { results: ["mock"] };
      },
    }),
  );
  try {
    e.add(entry.dir, entry.batch);
    await e.idle();
    expect(calls).toBe(2);
    expect(entry.batch.jobs[0]!.status).toBe("completed");
    const second = create(f);
    e.paused = true;
    e.add(second.dir, second.batch);
    await e.cancel(second.batch.jobs[0]!.id);
    expect(second.batch.jobs[0]!.status).toBe("cancelled");
    expect(() => e.resume(second.batch.jobs[0]!.id)).toThrow("Explicit retry");
  } finally {
    await e.close();
    f.close();
  }
});

test("cancelling an in-flight synchronous submission retains cancelled status", async () => {
  const f = fixture(),
    entry = create(f);
  let start!: () => void;
  const started = new Promise<void>((r) => (start = r));
  const e = new Engine(
    f.library,
    adapter({
      submit: async (_j, _d, signal) => {
        start();
        await new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("abort")), {
            once: true,
          }),
        );
        return { results: [] };
      },
    }),
  );
  try {
    e.add(entry.dir, entry.batch);
    await started;
    await e.cancel(entry.batch.jobs[0]!.id);
    await e.idle();
    expect(entry.batch.jobs[0]!.status).toBe("cancelled");
  } finally {
    await e.close();
    f.close();
  }
});
