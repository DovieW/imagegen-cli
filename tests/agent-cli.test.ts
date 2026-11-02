import { test, expect, spyOn } from "bun:test";
import { join, isAbsolute } from "node:path";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { runCli } from "../src/cli";
import { fixture, adapter, png } from "./helpers";
import { Engine } from "../src/jobs";
import { defaults } from "../src/config";
import { callEngine, dispatch, serveEngine, socketPath } from "../src/control";
import { CliError } from "../src/errors";
function capture() {
  const lines: any[] = [];
  const log = spyOn(console, "log").mockImplementation((text: any) =>
    lines.push(JSON.parse(text)),
  );
  return { lines, restore: () => log.mockRestore() };
}
const spec = {
  schemaVersion: 1 as const,
  name: "Agent batch",
  rows: [{ prompt: "fox", model: "gpt-image-2.5-flare" }],
};
test("agent discovers batch schema and exact model capabilities without a terminal", async () => {
  const f = fixture(),
    c = capture();
  try {
    await runCli(["schema", "--json"], f.library);
    expect(c.lines[0].data.commands.generate.flags["request-key"]).toBe(
      "value",
    );
    expect(c.lines[0].data.batchSchema.properties.rows.type).toBe("array");
    await runCli(["models", "gpt-image-2.5-flare", "--json"], f.library);
    expect(c.lines[1].data.options.quality).toContain("high");
    expect(c.lines.every((v) => v.schemaVersion === 1 && v.ok)).toBe(true);
  } finally {
    c.restore();
    f.close();
  }
});
test("unknown flags and conflicting inputs fail before submitting; stdin batch validates unknown properties", async () => {
  const f = fixture();
  try {
    await expect(
      runCli(
        ["generate", "--modle", "gpt-image-2.5-flare", "--json"],
        f.library,
      ),
    ).rejects.toMatchObject({ code: "UNKNOWN_FLAG" });
    await expect(
      runCli(
        ["generate", "--prompt", "fox", "--prompt-file", "a.txt", "--json"],
        f.library,
      ),
    ).rejects.toMatchObject({ code: "INVALID_PROMPT" });
    await expect(
      runCli(["batch", "-", "--dry-run", "--json"], f.library, {
        stdin: async () => JSON.stringify({ ...spec, typo: true }),
      }),
    ).rejects.toThrow("Unknown batch property");
    expect(f.library.batches()).toHaveLength(0);
  } finally {
    f.close();
  }
});
test("stdin dry-run expands mixed model matrices without writing a batch", async () => {
  const f = fixture(),
    c = capture();
  try {
    await runCli(["batch", "-", "--dry-run", "--json"], f.library, {
      stdin: async () =>
        JSON.stringify({
          ...spec,
          matrix: {
            prompts: ["one", "two"],
            models: ["gpt-image-2.5-flare", "gemini-nano-banana-2.1"],
            count: 2,
          },
        }),
    });
    expect(c.lines[0].data.jobCount).toBe(9);
    expect(c.lines[0].data.rows).toHaveLength(5);
    expect(f.library.batches()).toHaveLength(0);
  } finally {
    c.restore();
    f.close();
  }
});
test("foreground CLI returns stable IDs and absolute output paths; request keys prevent double billing", async () => {
  const f = fixture(),
    c = capture();
  let submissions = 0;
  const deps = {
    engineFactory: (l: any) =>
      new Engine(
        l,
        adapter({
          submit: async () => {
            submissions++;
            return { results: ["mock"] };
          },
        }),
        defaults(),
      ),
  };
  try {
    const args = [
      "generate",
      "--prompt",
      "fox",
      "--model",
      "gpt-image-2.5-flare",
      "--request-key",
      "agent-step-1",
      "--json",
    ];
    await runCli(args, f.library, deps);
    const first = c.lines[0];
    expect(first.ok).toBe(true);
    expect(first.data.batchId).toBeString();
    expect(first.data.jobIds).toHaveLength(1);
    expect(first.data.outputs[0].imageId).toBeString();
    expect(isAbsolute(first.data.outputs[0].path)).toBe(true);
    expect(readFileSync(first.data.outputs[0].path)).toEqual(png);
    await runCli(args, f.library, deps);
    expect(c.lines[1].data.reused).toBe(true);
    expect(c.lines[1].data.batchId).toBe(first.data.batchId);
    expect(submissions).toBe(1);
    await expect(
      runCli(
        [...args.slice(0, 2), "different", ...args.slice(3)],
        f.library,
        deps,
      ),
    ).rejects.toMatchObject({ code: "REQUEST_KEY_CONFLICT", exitCode: 7 });
    expect(submissions).toBe(1);
  } finally {
    c.restore();
    f.close();
  }
});
test("a running engine accepts concurrent agent submissions and metadata updates, with private socket permissions", async () => {
  const f = fixture(),
    c = capture(),
    e = new Engine(f.library, adapter(), defaults());
  await serveEngine(e);
  try {
    expect(statSync(socketPath(f.library.root)).mode & 0o777).toBe(0o600);
    await Promise.all(
      ["first", "second"].map((key) =>
        runCli(
          [
            "generate",
            "--prompt",
            "fox",
            "--request-key",
            key,
            "--no-wait",
            "--json",
          ],
          f.library,
        ),
      ),
    );
    expect(c.lines).toHaveLength(2);
    expect(new Set(c.lines.map((r) => r.data.batchId)).size).toBe(2);
    await e.idle();
    const ids = c.lines.flatMap((r) => r.data.jobIds);
    await runCli(["wait", ...ids, "--json"], f.library);
    expect(c.lines[2].data.outputs).toHaveLength(2);
    const image = c.lines[2].data.outputs[0].imageId;
    await runCli(
      ["annotate", image, "--add-tag", "cover", "--favorite", "--json"],
      f.library,
    );
    await runCli(
      ["library", "--tag", "cover", "--favorite", "--json"],
      f.library,
    );
    expect(c.lines.at(-1).data.items).toHaveLength(1);
    expect(
      f.library.images()[0]!.favorite || f.library.images()[1]!.favorite,
    ).toBe(true);
    expect(e.closing).toBe(false);
  } finally {
    c.restore();
    await e.close();
    f.close();
  }
});
test("duplicate concurrent submissions share one request key; a changed reference conflicts", async () => {
  const f = fixture(),
    e = new Engine(f.library, adapter(), defaults());
  await serveEngine(e);
  try {
    const input = join(f.root, "ref.png");
    writeFileSync(input, png);
    const withRef = {
      ...spec,
      rows: [{ ...spec.rows[0]!, references: [input] }],
    };
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        callEngine(f.library.root, {
          type: "submit",
          spec: withRef,
          requestKey: "same",
        }),
      ),
    );
    expect(new Set(results.map((r) => r.batchId)).size).toBe(1);
    await e.idle();
    expect(f.library.images()).toHaveLength(1);
    writeFileSync(input, Buffer.concat([png, Buffer.from("different")]));
    await expect(
      callEngine(f.library.root, {
        type: "submit",
        spec: withRef,
        requestKey: "same",
      }),
    ).rejects.toMatchObject({ code: "REQUEST_KEY_CONFLICT" });
  } finally {
    await e.close();
    f.close();
  }
});
test("no-wait without a running engine creates no batch; pagination and structured events are predictable", async () => {
  const f = fixture(),
    c = capture();
  try {
    await expect(
      runCli(["generate", "--prompt", "fox", "--no-wait", "--json"], f.library),
    ).rejects.toMatchObject({ code: "ENGINE_UNAVAILABLE" });
    expect(f.library.batches()).toHaveLength(0);
    await runCli(["generate", "--prompt", "fox", "--jsonl"], f.library, {
      engineFactory: (l) => new Engine(l, adapter(), defaults()),
    });
    expect(c.lines.at(-1).event).toBe("result");
    expect(c.lines.at(-1).ok).toBe(true);
    expect(c.lines.some((l) => l.event === "job")).toBe(true);
    await runCli(["jobs", "--limit", "1", "--json"], f.library);
    expect(c.lines.at(-1).data.items).toHaveLength(1);
    expect(c.lines.at(-1).data.total).toBe(1);
  } finally {
    c.restore();
    f.close();
  }
});
test("timeouts detach from a running engine without cancelling its job", async () => {
  const f = fixture(),
    c = capture();
  const previousExit = process.exitCode;
  const e = new Engine(
    f.library,
    adapter({
      submit: async () => {
        await Bun.sleep(1400);
        return { results: ["mock"] };
      },
    }),
    defaults(),
  );
  await serveEngine(e);
  try {
    await runCli(
      ["generate", "--prompt", "fox", "--timeout", "1", "--json"],
      f.library,
    );
    expect(c.lines[0].error.code).toBe("WAIT_TIMEOUT");
    expect(process.exitCode).toBe(4);
    expect(e.closing).toBe(false);
    await e.idle();
    expect(f.library.images()).toHaveLength(1);
  } finally {
    process.exitCode = previousExit ?? 0;
    c.restore();
    await e.close();
    f.close();
  }
});

test("agent can edit from an image ID while preserving parent lineage", async () => {
  const f = fixture(),
    c = capture();
  try {
    const e = f.library.create(spec);
    f.library.saveOutput(e.dir, e.batch, e.batch.jobs[0]!, png, 0);
    const image = f.library.images()[0]!;
    await runCli(
      ["generate", "--prompt", "warmer light", "--from", image.id, "--json"],
      f.library,
      { engineFactory: (l) => new Engine(l, adapter(), defaults()) },
    );
    expect(c.lines[0].data.jobs[0].parentIds).toEqual([image.id]);
    expect(c.lines[0].data.jobs[0].references).toHaveLength(1);
  } finally {
    c.restore();
    f.close();
  }
});
test("executable emits one structured error object, stable nonzero status, and no stdout chatter", async () => {
  const f = fixture();
  try {
    const p = Bun.spawn(
      [
        process.execPath,
        "--preload",
        "@opentui/solid/preload",
        "src/index.tsx",
        "generate",
        "--prompt",
        "fox",
        "--modle",
        "bad",
        "--json",
      ],
      {
        env: {
          ...process.env,
          IMAGEGEN_ROOT: f.library.root,
          IMAGEGEN_STATE_DIR: f.library.state,
          IMAGEGEN_CONFIG_DIR: join(f.root, "config"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    const value = JSON.parse(stdout);
    expect(value.ok).toBe(false);
    expect(value.error.code).toBe("UNKNOWN_FLAG");
    expect(code).toBe(2);
    expect(stderr).toBe("");
    expect(stdout.trim().split("\n")).toHaveLength(1);
  } finally {
    f.close();
  }
});

test("independent CLI processes share an existing foreground engine and return usable image files", async () => {
  const f = fixture();
  const env = {
    ...process.env,
    IMAGEGEN_ROOT: f.library.root,
    IMAGEGEN_STATE_DIR: f.library.state,
    IMAGEGEN_CONFIG_DIR: join(f.root, "config"),
  };
  const script = `import {Library} from './src/storage';import {Engine} from './src/jobs';import {serveEngine} from './src/control';import {adapter} from './tests/helpers';import {defaults} from './src/config';const l=new Library();const e=new Engine(l,adapter({submit:async()=>{await Bun.sleep(50);return {results:['mock']}}}),defaults());await serveEngine(e);process.on('SIGTERM',async()=>{await e.close();l.close();process.exit(0)});console.log('ready');await new Promise(()=>{});`;
  const owner = Bun.spawn([process.execPath, "-e", script], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const reader = owner.stdout.getReader();
    const ready = await reader.read();
    reader.releaseLock();
    expect(new TextDecoder().decode(ready.value)).toContain("ready");
    const run = async (key: string) => {
      const p = Bun.spawn(
        [
          process.execPath,
          "--preload",
          "@opentui/solid/preload",
          "src/index.tsx",
          "generate",
          "--prompt",
          "fox",
          "--request-key",
          key,
          "--json",
        ],
        { env, stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      expect(stderr).toBe("");
      expect(code).toBe(0);
      return JSON.parse(stdout);
    };
    const results = await Promise.all([run("process-a"), run("process-b")]);
    expect(new Set(results.map((r) => r.data.batchId)).size).toBe(2);
    for (const r of results) {
      expect(r.ok).toBe(true);
      expect(readFileSync(r.data.outputs[0].path)).toEqual(png);
    }
    expect(f.library.images()).toHaveLength(2);
  } finally {
    owner.kill("SIGTERM");
    await owner.exited;
    f.close();
  }
}, 15000);

test("waiting on stale active jobs fails clearly when the owner is gone", async () => {
  const f = fixture(),
    c = capture(),
    previous = process.exitCode;
  try {
    const { dir, batch } = f.library.create(spec);
    batch.jobs[0]!.status = "running";
    f.library.save(dir, batch);
    await runCli(["wait", batch.jobs[0]!.id, "--json"], f.library);
    expect(c.lines[0].error.code).toBe("ENGINE_UNAVAILABLE");
    expect(process.exitCode).toBe(5);
  } finally {
    process.exitCode = previous ?? 0;
    c.restore();
    f.close();
  }
});
test("an owner deadline also bounds time spent keeping other clients jobs alive", async () => {
  const f = fixture(),
    c = capture();
  let owned: Engine | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const start = Date.now();
  try {
    await runCli(
      ["generate", "--prompt", "own", "--timeout", "1", "--json"],
      f.library,
      {
        engineFactory: (l) => {
          owned = new Engine(
            l,
            adapter({
              submit: async (job) => {
                if (job.prompt === "other")
                  return {
                    remote: { id: "r", statusUrl: "mock", resultUrl: "mock" },
                  };
                await Bun.sleep(150);
                return { results: ["mock"] };
              },
              poll: async (_j, signal) => {
                await new Promise((_, reject) =>
                  signal.addEventListener(
                    "abort",
                    () => reject(new Error("abort")),
                    { once: true },
                  ),
                );
                return null;
              },
            }),
            defaults(),
          );
          timer = setTimeout(() => {
            void dispatch(owned!, {
              type: "submit",
              requestKey: "other-client",
              spec: {
                ...spec,
                rows: [{ prompt: "other", model: "gpt-image-2.5-flare" }],
              },
            });
          }, 20);
          return owned;
        },
      },
    );
    expect(Date.now() - start).toBeLessThan(2500);
    expect(c.lines[0].ok).toBe(true);
    expect(owned!.closing).toBe(true);
    expect(
      [...owned!.entries.values()].find((e) => e.job.prompt === "other")!.job
        .status,
    ).toBe("paused");
  } finally {
    if (timer) clearTimeout(timer);
    await owned?.close();
    c.restore();
    f.close();
  }
});
