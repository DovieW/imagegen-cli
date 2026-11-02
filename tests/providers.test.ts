import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Providers, HttpError } from "../src/providers";
import { fixture, png } from "./helpers";
import { MODELS } from "../src/models";
const auth = {
  key: async () => "test-secret-never-log",
  endpoint: async () => "https://resource.services.ai.azure.com",
};
test("all catalog models serialize generation and reference requests using provider-specific schemas", async () => {
  const f = fixture();
  try {
    const ref = join(f.root, "ref.png");
    writeFileSync(ref, png);
    for (const m of MODELS) {
      for (const references of [[], [ref]]) {
        const { batch, dir } = f.library.create({
          schemaVersion: 1,
          name: "provider",
          rows: [{ prompt: "fox", model: m.id, references }],
        });
        const j = batch.jobs[0]!;
        let request: { url: string; init: RequestInit } | undefined;
        const fetcher = (async (url: any, init: any) => {
          request = { url: String(url), init };
          if (m.provider === "fal")
            return Response.json({
              request_id: "r",
              status_url: "https://queue.fal.run/a/status",
              response_url: "https://queue.fal.run/a/result",
            });
          if (m.provider === "bfl")
            return Response.json({
              id: "r",
              polling_url: "https://api.bfl.ai/v1/get_result?id=r",
            });
          return Response.json(
            m.provider === "google"
              ? {
                  steps: [
                    {
                      content: [
                        {
                          type: "image",
                          mime_type: "image/png",
                          data: png.toString("base64"),
                        },
                      ],
                    },
                  ],
                }
              : {
                  data: [{ b64_json: png.toString("base64") }],
                  usage: { images: 1 },
                },
          );
        }) as unknown as typeof fetch;
        const p = new Providers(auth, fetcher),
          receipt = await p.submit(j, dir, new AbortController().signal);
        expect(request).toBeDefined();
        if (m.provider === "fal" || m.provider === "bfl")
          expect(receipt.remote?.id).toBe("r");
        else expect(receipt.results).toHaveLength(1);
        if (
          references.length &&
          ["openai", "microsoft", "meta"].includes(m.provider)
        ) {
          expect(request!.init.body).toBeInstanceOf(FormData);
          expect(
            (request!.init.body as FormData).get(
              m.provider === "microsoft" ? "image" : "image[]",
            ),
          ).toBeInstanceOf(File);
        } else {
          const b = JSON.parse(request!.init.body as string);
          if (m.provider === "google") expect(b.input[0].text).toBe("fox");
          else expect(b.prompt).toBe("fox");
          if (references.length && m.provider === "bfl")
            expect(b.input_image).toStartWith("data:image/png");
          if (references.length && m.provider === "xai")
            expect(b.image.type).toBe("image_url");
        }
      }
    }
  } finally {
    f.close();
  }
});
test("remote polling only sends credentials to trusted provider hosts", async () => {
  const p = new Providers(auth, (async () => {
    throw new Error("must not fetch");
  }) as unknown as typeof fetch);
  const f = fixture();
  try {
    const j = f.library.create({
      schemaVersion: 1,
      name: "x",
      rows: [{ prompt: "x", model: "flux-3-image" }],
    }).batch.jobs[0]!;
    j.remote = {
      id: "r",
      statusUrl: "https://evil.test/steal",
      resultUrl: "https://queue.fal.run/a",
    };
    await expect(p.poll(j, new AbortController().signal)).rejects.toThrow(
      "Untrusted",
    );
  } finally {
    f.close();
  }
});
test("HTTP errors never include provider bodies or credentials", async () => {
  const p = new Providers(
    auth,
    (async () =>
      new Response("secret response content", {
        status: 429,
        headers: { "retry-after": "3" },
      })) as unknown as typeof fetch,
  );
  try {
    await p.json("https://example.com", {}, new AbortController().signal);
    throw new Error("expected failure");
  } catch (e) {
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).retryAfter).toBe(3000);
    expect((e as Error).message).not.toContain("secret");
  }
});
