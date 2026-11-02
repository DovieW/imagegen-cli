import { test, expect, spyOn } from "bun:test";
import { runCli } from "../src/cli";
import { fixture, png } from "./helpers";
test("successful CLI generation ignores unrelated historical failures and never exposes credentials", async () => {
  const f = fixture(),
    previous = process.env.OPENAI_API_KEY,
    exitCode = process.exitCode;
  const old = f.library.create({
    schemaVersion: 1,
    name: "historical",
    rows: [{ prompt: "failed", model: "gpt-image-2.5-flare" }],
  });
  old.batch.jobs[0]!.status = "failed";
  f.library.save(old.dir, old.batch);
  process.env.OPENAI_API_KEY = "fake-test-key";
  process.exitCode = 0;
  const request = spyOn(globalThis, "fetch").mockImplementation((async () =>
    Response.json({
      data: [{ b64_json: png.toString("base64") }],
    })) as unknown as typeof fetch);
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await runCli(
      ["generate", "--prompt", "fox", "--model", "gpt-image-2.5-flare"],
      f.library,
    );
    expect(f.library.images()).toHaveLength(1);
    expect(process.exitCode).toBe(0);
    expect(log.mock.calls.flat().join(" ")).not.toContain("fake-test-key");
  } finally {
    request.mockRestore();
    log.mockRestore();
    process.env.OPENAI_API_KEY = previous;
    process.exitCode = exitCode;
    f.close();
  }
});
