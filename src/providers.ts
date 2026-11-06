import { readFileSync } from "node:fs";
import { authentication, type Authentication } from "./auth";
import { modelFor } from "./models";
import { imageMime, inside } from "./storage";
import type { Job, Remote, Settings } from "./types";
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfter = 0,
    readonly code?: string,
    readonly requestId?: string,
  ) {
    super(
      `Provider HTTP ${status}${code ? ` (${code})` : ""}${status === 401 ? " — check credentials" : status === 403 ? " — check model and requested GIF/SVG preview access" : status === 429 ? " — rate limited" : ""}`,
    );
  }
}
export interface Submission {
  remote?: Remote;
  results?: string[];
  requestId?: string;
  usage?: unknown;
  svgUsage?: unknown;
  effectiveSettings?: Settings;
}
export type Progress = (event: { preview: string; index: number }) => void;
export interface Adapter {
  prepare(job: Job): Promise<void>;
  submit(
    job: Job,
    dir: string,
    signal: AbortSignal,
    progress?: Progress,
  ): Promise<Submission>;
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
  async response(
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
      let code: string | undefined;
      try {
        const body = await boundedText(r, 16384);
        const candidate = JSON.parse(body)?.error?.code;
        if (
          [
            "insufficient_quota",
            "billing_hard_limit_reached",
            "rate_limit_exceeded",
            "moderation_blocked",
            "model_not_found",
            "permission_denied",
            "invalid_api_key",
            "image_generation_user_error",
          ].includes(candidate)
        )
          code = candidate;
      } catch {
      } finally {
        await r.body?.cancel().catch(() => {});
      }
      const delay = r.headers.get("retry-after"),
        n = Number(delay);
      throw new HttpError(
        r.status,
        Number.isFinite(n)
          ? n * 1000
          : Math.max(0, Date.parse(delay || "") - Date.now()) || 0,
        code,
        r.headers.get("x-request-id") || undefined,
      );
    }
    return r;
  }
  async json(
    url: string,
    init: RequestInit,
    signal: AbortSignal,
  ): Promise<any> {
    const r = await this.response(url, init, signal);
    const data = await r.json();
    if (data && typeof data === "object")
      data._requestId =
        r.headers.get("x-request-id") || r.headers.get("request-id") || data.id;
    return data;
  }
  async submit(
    job: Job,
    dir: string,
    signal: AbortSignal,
    progress?: Progress,
  ): Promise<Submission> {
    const m = modelFor(job.model, job.provider),
      key = await this.auth.key(job.provider);
    const refs = job.references.map((p) => {
      const bytes = readFileSync(inside(dir, p));
      return { bytes, mime: imageMime(bytes) };
    });
    const finish = (data: any): Submission => {
      const result = this.results(data, job.provider);
      result.effectiveSettings = {
        ...job.settings,
        ...(job.settings.frame_duration_ms !== undefined
          ? {
              frame_duration_ms:
                Math.round(Number(job.settings.frame_duration_ms) / 10) * 10,
            }
          : {}),
        ...result.effectiveSettings,
      };
      return result;
    };
    const uris = refs.map(
      (r) => `data:${r.mime};base64,${r.bytes.toString("base64")}`,
    );
    let url = "",
      headers: Record<string, string> = { "Content-Type": "application/json" },
      body: any = {
        model: m.api,
        prompt: job.prompt,
        ...job.settings,
        ...(job.provider === "openai" ? { n: 1 } : {}),
      };
    if (body.frame_duration_ms !== undefined)
      body.frame_duration_ms =
        Math.round(Number(body.frame_duration_ms) / 10) * 10;
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
        for (const [k, v] of Object.entries(body))
          form.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
        refs.forEach((r, i) =>
          form.append(
            job.provider === "microsoft" ? "image" : "image[]",
            new Blob([r.bytes], { type: r.mime }),
            `reference-${i}.${r.mime.split("/")[1]}`,
          ),
        );
        for (const kind of ["mask", "markup"] as const)
          if (job[kind])
            form.append(
              kind,
              new Blob([readFileSync(inside(dir, job[kind]!))], {
                type: "image/png",
              }),
              `${kind}.png`,
            );
        delete headers["Content-Type"];
        body = form;
      }
    }
    const init = {
      method: "POST",
      headers,
      body: body instanceof FormData ? body : JSON.stringify(body),
    };
    if (job.provider === "openai" && job.settings.stream) {
      const response = await this.response(url, init, signal);
      for await (const event of imageEvents(response, signal)) {
        if (event.type === "error" || event.error)
          throw new Error(
            "Provider stream failed; inspect request history before retrying",
          );
        if (/\.partial_image$/.test(event.type))
          progress?.({
            preview: `data:image/${event.output_format || job.settings.output_format || "png"};base64,${event.b64_json}`,
            index: event.partial_image_index,
          });
        if (/\.completed$/.test(event.type))
          return finish({
            ...event,
            data: [{ b64_json: event.b64_json }],
            _requestId: response.headers.get("x-request-id"),
          });
      }
      throw new Error("Stream ended without a final image");
    }
    const data = await this.json(url, init, signal);
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
    return finish(data);
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
          ? [
              `data:${data.output_format === "svg" ? "image/svg+xml" : "image/" + (data.output_format || "png")};base64,${d.b64_json}`,
            ]
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
      svgUsage: data.svg_usage,
      effectiveSettings: Object.fromEntries(
        [
          "size",
          "quality",
          "background",
          "output_format",
          "complexity",
          "frame_count",
          "frame_duration_ms",
        ]
          .filter((k) => data[k] !== undefined)
          .map((k) => [k, data[k]]),
      ),
      requestId: data.id || data._requestId,
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
      if (data.length > 140 * 1024 * 1024)
        throw new Error("Image exceeds 100 MB");
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

async function boundedText(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  let n = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > limit) throw new Error("Response exceeds limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}
export async function* imageEvents(
  response: Response,
  signal: AbortSignal,
): AsyncGenerator<any> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty image stream");
  const decoder = new TextDecoder();
  let pending = "";
  const abort = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      pending += decoder.decode(value, { stream: !done });
      if (pending.length > 140 * 1024 * 1024)
        throw new Error("Image event exceeds limit");
      // Normalize split CRLF only after a complete line arrives.
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(pending))) {
        const block = pending.slice(0, boundary.index);
        pending = pending.slice(boundary.index + boundary[0].length);
        const payload = block
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (payload && payload !== "[DONE]") yield JSON.parse(payload);
      }
      if (done) break;
    }
    if (pending.trim()) throw new Error("Truncated image stream event");
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
