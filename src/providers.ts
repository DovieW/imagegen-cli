import { readFileSync } from "node:fs";
import { authentication, type Authentication } from "./auth";
import { modelFor } from "./models";
import { imageMime, inside } from "./storage";
import type { Job, Remote } from "./types";
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfter = 0,
  ) {
    super(
      `Provider HTTP ${status}${status === 401 ? " — check credentials" : status === 403 ? " — check model access" : status === 429 ? " — rate limited" : ""}`,
    );
  }
}
export interface Submission {
  remote?: Remote;
  results?: string[];
  requestId?: string;
  usage?: unknown;
}
export interface Adapter {
  prepare(job: Job): Promise<void>;
  submit(job: Job, dir: string, signal: AbortSignal): Promise<Submission>;
  poll(job: Job, signal: AbortSignal): Promise<Submission | null>;
  cancel(job: Job): Promise<void>;
  download(result: string, signal: AbortSignal): Promise<Uint8Array>;
}
export class Providers implements Adapter {
  constructor(
    readonly auth: Pick<Authentication, "key" | "endpoint"> = authentication,
    readonly request: typeof fetch = fetch,
  ) {}
  async prepare(job: Job) {
    await this.auth.key(job.provider);
    if (job.provider === "microsoft") await this.auth.endpoint();
  }
  async json(
    url: string,
    init: RequestInit,
    signal: AbortSignal,
  ): Promise<any> {
    const r = await this.request(url, {
      ...init,
      signal: AbortSignal.any([signal, AbortSignal.timeout(15 * 60 * 1000)]),
      redirect: "error",
    });
    if (!r.ok) {
      await r.body?.cancel();
      const delay = r.headers.get("retry-after");
      const n = Number(delay);
      throw new HttpError(
        r.status,
        Number.isFinite(n)
          ? n * 1000
          : Math.max(0, Date.parse(delay || "") - Date.now()) || 0,
      );
    }
    return r.json();
  }
  async submit(
    job: Job,
    dir: string,
    signal: AbortSignal,
  ): Promise<Submission> {
    const m = modelFor(job.model, job.provider),
      key = await this.auth.key(job.provider);
    const refs = job.references.map((p) => {
      const bytes = readFileSync(inside(dir, p));
      return { bytes, mime: imageMime(bytes) };
    });
    const uris = refs.map(
      (r) => `data:${r.mime};base64,${r.bytes.toString("base64")}`,
    );
    let url = "",
      headers: Record<string, string> = { "Content-Type": "application/json" },
      body: any = { model: m.api, prompt: job.prompt, ...job.settings };
    if (job.provider === "google") {
      url = "https://generativelanguage.googleapis.com/v1beta/interactions";
      headers["x-goog-api-key"] = key;
      body = {
        model: m.api,
        input: [
          { type: "text", text: job.prompt },
          ...refs.map((r) => ({
            type: "image",
            mime_type: r.mime,
            data: r.bytes.toString("base64"),
          })),
        ],
        ...(job.settings.aspect_ratio
          ? {
              response_format: {
                type: "image",
                aspect_ratio: job.settings.aspect_ratio,
              },
            }
          : {}),
      };
    } else if (job.provider === "fal") {
      url = `https://queue.fal.run/${refs.length ? m.editApi : m.api}`;
      headers.Authorization = `Key ${key}`;
      body = {
        prompt: job.prompt,
        ...job.settings,
        ...(refs.length ? { image_urls: uris } : {}),
      };
    } else if (job.provider === "bfl") {
      url = `https://api.bfl.ai/v1/${m.api}`;
      headers["x-key"] = key;
      body = {
        prompt: job.prompt,
        ...job.settings,
        ...Object.fromEntries(
          uris.map((v, i) => [`input_image${i ? "_" + (i + 1) : ""}`, v]),
        ),
      };
    } else {
      const base =
        job.provider === "microsoft"
          ? `${await this.auth.endpoint()}/mai/v1`
          : job.provider === "meta"
            ? "https://api.meta.ai/v1"
            : job.provider === "xai"
              ? "https://api.x.ai/v1"
              : "https://api.openai.com/v1";
      url = `${base}/images/${refs.length ? "edits" : "generations"}`;
      if (job.provider === "microsoft") headers["api-key"] = key;
      else headers.Authorization = `Bearer ${key}`;
      if (job.provider === "xai") body.response_format = "b64_json";
      if (refs.length && job.provider === "xai") {
        if (refs.length === 1) body.image = { url: uris[0], type: "image_url" };
        else body.images = uris.map((url) => ({ url, type: "image_url" }));
      }
      if (refs.length && job.provider !== "xai") {
        const form = new FormData();
        for (const [k, v] of Object.entries(body)) form.append(k, String(v));
        refs.forEach((r, i) =>
          form.append(
            job.provider === "microsoft" ? "image" : "image[]",
            new Blob([r.bytes], { type: r.mime }),
            `reference-${i}.${r.mime.split("/")[1]}`,
          ),
        );
        delete headers["Content-Type"];
        body = form;
      }
    }
    const data = await this.json(
      url,
      {
        method: "POST",
        headers,
        body: body instanceof FormData ? body : JSON.stringify(body),
      },
      signal,
    );
    if (job.provider === "fal") {
      const remote: Remote = {
        id: data.request_id,
        statusUrl: data.status_url,
        resultUrl: data.response_url,
        cancelUrl: data.cancel_url,
      };
      this.validateRemote(job, remote);
      return { remote, requestId: remote.id };
    }
    if (job.provider === "bfl") {
      const remote: Remote = {
        id: data.id,
        statusUrl: data.polling_url,
        resultUrl: data.polling_url,
      };
      this.validateRemote(job, remote);
      return { remote, requestId: remote.id };
    }
    return this.results(data, job.provider);
  }
  results(data: any, provider: string): Submission {
    let results: string[] = [];
    if (provider === "google") {
      const blocks =
        data.steps?.flatMap((s: any) => s.content || []) || data.outputs || [];
      if (data.output_image) blocks.push(data.output_image);
      results = blocks
        .filter(
          (b: any) =>
            (b.type === "image" || b.mime_type?.startsWith("image/")) && b.data,
        )
        .map((b: any) => `data:${b.mime_type || "image/png"};base64,${b.data}`);
    } else
      results = (data.data || []).flatMap((d: any) =>
        d.b64_json
          ? [`data:image/png;base64,${d.b64_json}`]
          : d.url
            ? [d.url]
            : [],
      );
    if (!results.length)
      throw new Error(
        "Provider returned no image; the request may have been billed. Retry explicitly if desired.",
      );
    return {
      results,
      usage: data.usage || data.usage_metadata,
      requestId: data.id,
    };
  }
  validateRemote(job: Job, r: Remote) {
    if (!r.id || !r.statusUrl || !r.resultUrl)
      throw new Error("Provider returned an incomplete request receipt");
    for (const s of [r.statusUrl, r.resultUrl, r.cancelUrl].filter(
      Boolean,
    ) as string[]) {
      const u = new URL(s);
      const trusted =
        job.provider === "fal"
          ? u.hostname === "queue.fal.run"
          : u.hostname === "api.bfl.ai" || u.hostname.endsWith(".bfl.ai");
      if (u.protocol !== "https:" || u.username || u.password || !trusted)
        throw new Error("Untrusted remote request URL");
    }
  }
  async poll(job: Job, signal: AbortSignal): Promise<Submission | null> {
    const r = job.remote!;
    this.validateRemote(job, r);
    const key = await this.auth.key(job.provider);
    const headers: Record<string, string> =
      job.provider === "fal"
        ? { Authorization: `Key ${key}` }
        : { "x-key": key };
    const data = await this.json(r.statusUrl, { headers }, signal);
    if (
      [
        "ERROR",
        "FAILED",
        "Error",
        "Failed",
        "Request Moderated",
        "Content Moderated",
      ].includes(data.status)
    )
      throw new HttpError(422);
    if (job.provider === "bfl")
      return data.status === "Ready" ? { results: [data.result.sample] } : null;
    if (data.status !== "COMPLETED") return null;
    const result = await this.json(r.resultUrl, { headers }, signal);
    const results = (result.images || []).map((i: any) => i.url);
    if (!results.length)
      throw new Error("Provider returned no downloadable images");
    return { results, usage: result.usage };
  }
  async cancel(job: Job) {
    if (!job.remote?.cancelUrl) return;
    this.validateRemote(job, job.remote);
    const key = await this.auth.key(job.provider);
    await this.json(
      job.remote.cancelUrl,
      { method: "PUT", headers: { Authorization: `Key ${key}` } },
      AbortSignal.timeout(10000),
    ).catch(() => {});
  }
  async download(result: string, signal: AbortSignal): Promise<Uint8Array> {
    if (result.startsWith("data:image/")) {
      const [, data] = result.split(",");
      if (!data) throw new Error("Empty image result");
      return Buffer.from(data, "base64");
    }
    const url = new URL(result);
    if (url.protocol !== "https:")
      throw new Error("Image download requires HTTPS");
    const r = await this.request(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
    });
    if (!r.ok) {
      await r.body?.cancel();
      throw new HttpError(r.status);
    }
    if (Number(r.headers.get("content-length")) > 100 * 1024 * 1024) {
      await r.body?.cancel();
      throw new Error("Image exceeds 100 MB");
    }
    const reader = r.body!.getReader(),
      chunks: Uint8Array[] = [];
    let n = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > 100 * 1024 * 1024) {
        await reader.cancel();
        throw new Error("Image exceeds 100 MB");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  }
}
