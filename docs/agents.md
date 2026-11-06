# Agent CLI contract

Use `imagegen` directly without a pseudo-terminal. The TUI is optional. For image inspection, obtain the original file path from `imagegen image ID --json` or a generation response, then open that path with your agent's image-viewing tool. `view` is an interactive human viewer.

## Discover before calling

```sh
imagegen schema --json
imagegen schema batch --json
imagegen help generate --json
imagegen models --json
imagegen models gpt-image-2.6-flare --json
imagegen doctor --json
```

`schema` exposes available commands, flag cardinality, batch and response JSON Schemas, and exit codes. `models` is the source of truth for supported IDs, providers, reference limits, and settings. Do not invent model identifiers or settings. Unknown flags, duplicate non-repeatable flags, and unknown batch/row properties fail before submission. `--help` works on individual commands. `--json` and `--jsonl` may precede or follow the command; other flags follow it.

## Generate, inspect, and edit

```sh
# Use a logical, stable request key for this generation step.
imagegen generate --prompt-file prompt.txt \
  --model gpt-image-2.6-flare --count 3 \
  --settings '{"quality":"medium","size":"1024x1536"}' \
  --request-key story-cover-v1 --json > result.json

# The result contains absolute paths, image IDs, and job IDs.
jq -r '.data.outputs[].path' result.json
jq -r '.data.outputs[].imageId' result.json

imagegen image IMAGE_ID --json
imagegen generate --from IMAGE_ID --prompt 'Keep the composition; make the light warmer' \
  --request-key story-cover-warmer-v1 --json
imagegen annotate IMAGE_ID --add-tag story-cover --favorite --json
imagegen library --tag story-cover --favorite --limit 20 --json
imagegen export IMAGE_ID --to ./selected --json
```

`--from` accepts existing image IDs, supplies their original images as references, and records parent lineage automatically. Repeat it to combine images. Without `--model`, it uses the first source image's model; without sources, the default is `gpt-image-2.6-flare`. `--ref PATH` accepts arbitrary local images; `--parent-id ID` records explicit lineage. Reference snapshots travel with the batch.

Generation waits for the requested jobs and returns their results, including any partial successes. Each image output includes `imageId`, `path`, `metadataPath`, `mime`, `bytes`, and `hash`. Read `.data.jobs[].status` and `.error` to diagnose failures. Signed provider download URLs and base64 result payloads are excluded from CLI responses.

## Flexible batches and stdin

```sh
imagegen batch ./batch.json --dry-run --json
imagegen batch ./batch.json --request-key cover-comparison-v1 --json
cat batch.json | imagegen batch - --request-key cover-comparison-v1 --json
printf '%s' 'A watercolor forest library' | imagegen generate --prompt - --json
```

Batch v1 supports independent rows and optional Cartesian-product matrices of prompts, models, settings, and counts. Obtain the schema from `imagegen schema batch --json` and an example from `examples/batch.json`. Local reference paths resolve relative to the batch file, or the current directory for stdin. `--dry-run` validates and expands the configuration without submitting; references, masks, and markup are read and validated during dry-run, then snapshotted during execution. `--settings-file FILE` avoids shell quoting of JSON settings.

## Idempotency and recovery

Supply `--request-key` when a tool call may be retried. The same key and normalized configuration (including reference file content hashes) return the existing batch without submitting new requests. Changing the configuration under an existing key fails with `REQUEST_KEY_CONFLICT` and exit 7. Keys persist in portable `batch.json` manifests and work after restarting the app. Keep reference files available if you need to replay the original command.

If no key is supplied, the app creates one and returns it. A transport error after submitting to a running engine includes the key in `.error.details.requestKey`; resubmit the identical generation request with that key to discover whether it was accepted. Never respond to an uncertain submission by blindly using a different key.

```sh
imagegen jobs --batch BATCH_ID --json
imagegen jobs JOB_ID --json
imagegen resume JOB_ID --json
# Only after inspecting provider history and deciding a new charge is acceptable:
imagegen resume JOB_ID --retry --json
```

`resume` recovers saved remote requests/results and paused jobs. It does not automatically resubmit an uncertain request. `--retry` explicitly creates a new job and can incur a new charge; repeating that operation creates further jobs. Idempotency keys deduplicate original generation submissions, not explicit paid retries. Existing images and job records are retained.

## Concurrent agents and the TUI

Only one process owns the engine per image root. The TUI and foreground generation CLI expose a private Unix socket at `~/imagegen/.imagegen.sock` with mode 0600. Other CLI processes submit and control jobs through it. They do not launch a second engine or pass credentials through the socket. The owner's environment/wallet credentials and concurrency settings apply.

```sh
imagegen config --concurrency 8 --provider-limit openai=3 --provider-limit google=4 --json
# While the TUI or another foreground generation is running:
imagegen batch batch.json --request-key agent-batch-v1 --no-wait --json
imagegen wait JOB_ID --timeout 120 --json
imagegen cancel JOB_ID --json
imagegen pause --json
```

`--no-wait` returns the submission receipt immediately and requires an already running engine. Without an owner it fails without creating a batch. There is no daemon. Keep the TUI open for detached submissions. A foreground CLI owner remains alive until admitted jobs settle, including work from other clients. If that owner exits or is interrupted, its jobs stop locally; remote work may still continue and be billed.

`--timeout SECONDS` bounds waiting after submission (0 means unlimited). Timing out or interrupting a client detaches the waiter and leaves the owner's jobs running. Timing out or interrupting the owning foreground CLI interrupts its local jobs and saves recovery state; provider cancellation is not implied. If the engine disappears unexpectedly, waiters return `ENGINE_UNAVAILABLE` instead of waiting forever. Control requests have a separate 30-second transport timeout.

`config` changes persist and update a running engine. Jobs and library listings support `--limit`/`--offset` pagination and return `{items,total,limit,offset}`; default limit is 100. Jobs filter by `--batch` and repeatable `--status`. Library supports query, exact tags, model/provider, batch, favorites, and sort filters. `annotate` accepts tag replacement, repeatable additions/removals, and favorite changes. Metadata mutations go through the running engine when available.

## Output and exit statuses

With `--json`, stdout contains exactly one JSON object:

```json
{"schemaVersion":1,"ok":true,"command":"generate","data":{"batchId":"...","jobIds":["..."],"outputs":[{"imageId":"...","path":"/absolute/image.png"}]}}
```

Errors have `ok:false` and `error:{code,message,details?}`. Incomplete jobs and timeouts also retain `.data` with job status and partial output paths. Do not assume a nonzero status means no images were created. Human-readable output is not a parsing contract. `--jsonl` streams job snapshots (`event:"job"`) followed by one final result/error (`event:"result"`); it cannot be combined with `--json`.

| Exit | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Internal/protocol error |
| 2 | Invalid input, unsupported settings, ambiguous ID, or explicit retry confirmation needed |
| 3 | Requested jobs failed, paused, were cancelled, or have uncertain submission outcomes |
| 4 | Wait/control timeout |
| 5 | Engine unavailable, closing, or control outcome unknown |
| 6 | File, image, or job not found |
| 7 | Request-key conflict |
| 130 / 143 | SIGINT / SIGTERM |

Credentials never belong in prompts, batch files, request keys, logs, or command arguments. Use configured environment variables or the system wallet. `doctor --json` reports credential sources without revealing values. If you select another image root with `IMAGEGEN_ROOT`, use the same root when polling or controlling its jobs.

## Version 0.3 capabilities

`models ID --json` retains `options` and adds `settingsSchema` plus human-readable compatibility `constraints`. Prefer the schema for complete settings, including nested `svg.model` and `svg.reasoning.effort`. Unknown nested settings fail before submission. Batch/response envelopes remain schema version 1 with additive fields.

Generation accepts `--mask FILE` or `--markup FILE`, corresponding to optional row properties in batch JSON. They apply to the first reference; input paths resolve relative to a batch file, or cwd for stdin. Model/format combinations and input files validate before submission. SVG/GIF are outputs, not implicit raster inputs.

Use `imagegen rasterize IMAGE_ID [--frame ZERO_BASED_INDEX] --json` for an explicit PNG conversion. The result returns `path`, `mime`, and `sourceImageId`. Pass that path with `--ref` and the source ID with `--parent-id` to retain lineage. `library --format png|jpeg|webp|svg|gif --json` filters by original format.

Streaming is opt-in: `--settings '{"stream":true,"partial_images":2}'`. JSONL may emit `{schemaVersion:1,event:"preview",data:{jobId,path,index,updatedAt}}` events before the final result. Preview files are rebuildable cache data, not completed outputs. Clients may miss short-lived previews while polling; always use final job status/output paths as the completion contract. Ordinary `--json` still emits exactly one final envelope. Base64 payloads never appear in CLI output.

SVG/GIF access failures never trigger automatic substitutions. Quota errors are not retried. Structured provider `errorCode` and request IDs are available on jobs where known; generic errors remain redacted. Interrupted streams do not authorize automatic resubmission. SVG author usage is separate from image usage. The app keeps one provider output per independent job, so `--count` preserves existing concurrency and retry semantics.
