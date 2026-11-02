# imagegen-cli

A concurrent image generation workbench for Ghostty, with a scriptable CLI and a portable image library. Built with Bun, TypeScript, OpenTUI, and Solid, following [transcribe-cli](https://github.com/DovieW/transcribe-cli).

Run `imagegen` for the TUI. Use **N** in Library to add a generation. Edit each row's prompt, model, references, copy count, and model-specific settings. **A** in Generate opens batch actions, including presets and prompt/model combinations. **Ctrl-R** reviews the expanded job count before starting. Keep adding batches while jobs run.

## Install and build

Linux x86-64 is the initial standalone build target. Ghostty 1.4 is recommended for its complete Kitty graphics implementation; the gallery has also been visually checked on the installed 1.3 development build. Other terminals use OpenTUI's detected image protocol or block rendering. `xdg-open` enables external viewing.

```sh
npm ci
node node_modules/bun/install.js  # only if your npm blocks Bun's install script
npm run check
npm test
npm run build
install -Dm755 dist/imagegen ~/.local/bin/imagegen
imagegen doctor
```

The compiled executable needs no Node.js or Bun installation. `install.sh --local dist/imagegen` also installs a local build. For a published GitHub release, `install.sh` downloads the binary and verifies its SHA-256 checksum before installation. Release publication is separate from a local build.

## Image library

Originals live under `~/imagegen/<date>-<batch-name>-<short-id>/`, alongside `batch.json`, per-image `.json` metadata, and an `inputs/` directory containing immutable reference snapshots. Prompts, exact model/provider IDs, effective settings, request IDs, available usage, hashes, tags, favorites, and edit lineage travel with these files. Images retain the provider's original bytes and format.

SQLite is an index, not the source of truth. Move or rename an entire batch folder within `~/imagegen`, then choose **Settings → Rebuild library index** or run `imagegen library --rebuild`. Copy the image root to a new machine and rebuild there. Keep manifests and metadata with images to retain generation history. The scanner searches up to four folder levels within the configured root and does not follow directory symlinks.

- **Arrows** navigate the thumbnail grid; **Enter** opens image actions.
- **/** searches prompts, tags, model/provider, date, and batch name.
- **F** toggles favorite; **S** filters favorites; **Space** selects multiple images.
- **V** opens full screen; **+/-** zoom; **HJKL** pan; **0** fits the image.
- Pin an image from its action menu, then select another for side-by-side comparison.
- **O** opens the original externally; image actions also reveal its folder or copy its path.
- **E** exports selected images, or the current image, to a folder you choose. Originals remain in the library. Metadata is included by default, and overwriting requires confirmation.

The grid mounts only the visible page. Native image decoding, scaling, and cropping produce cached PNG thumbnails; zoom crops are transient. OpenTUI's native image widget probes terminal capabilities, chooses the protocol, and manages graphics with its rendering lifecycle. Kitty placement is handled by OpenTUI rather than raw writes around the renderer. See [Ghostty features](https://ghostty.org/docs/features) and [OpenTUI](https://github.com/anomalyco/opentui).

## Supported model routes

These routes are based on provider documentation checked November 2, 2026. Actual availability depends on your account, region, deployment, and provider policies. Only OpenAI authentication/model-list access has been checked against a live account during development; generation adapters are tested with mocked responses.

| Models | Route | Credential |
| --- | --- | --- |
| GPT Image 2.5 Sunburst, GPT Image 2.5 Flare, GPT Image 2 | [OpenAI Images API](https://developers.openai.com/api/docs/guides/image-generation) | `OPENAI_API_KEY` |
| Nano Banana 2.1, Nano Banana 2 Lite, Nano Banana 2 | [Google Interactions API](https://ai.google.dev/gemini-api/docs/image-generation) | `GEMINI_API_KEY` |
| MAI-Image 2.6, MAI-Image 2.6 Flash | [Azure MAI Images API](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-mai-image) | `AZURE_API_KEY`, `AZURE_ENDPOINT` |
| Grok Imagine Image 2.0 | [xAI Images API](https://docs.x.ai/developers/model-capabilities/images/generation) | `XAI_API_KEY` |
| Muse Image 1.0 | [Meta Images API](https://dev.meta.ai/docs/image-generation) | `MODEL_API_KEY` |
| FLUX 3 Image | [fal queue API](https://fal.ai/models/blackforestlabs/flux-3/text-to-image/api) | `FAL_KEY` |
| FLUX 3 Image Klein | [fal queue API](https://fal.ai/models/blackforestlabs/flux-3/klein/text-to-image/api) | `FAL_KEY` |
| FLUX.2 Max | [BFL asynchronous API](https://docs.bfl.ai/quick_start/generating_images) | `BFL_API_KEY` |

Midjourney V8.2 is omitted because a usable documented API route was not verified. No model substitutions or automatic provider switching occur. Run `imagegen models` to see exact IDs, reference limits, and the supported subset of settings. New settings are accepted only after adapter support and provider validation are added. Azure deployments must use the catalog model ID as their deployment name. Muse currently exposes one reference per edit in this app.

## Credentials

**Authentication** provides masked key entry, loading from a local key file, status, and removal. Keys persist in a separate `imagegen-cli` system-wallet entry. KDE uses KWallet with `python3-dbus`; other Linux desktops use Secret Service and `libsecret-tools`. There is no plaintext fallback. Environment variables override wallet keys. Endpoint configuration for Azure is also available here.

For CLI setup, use `imagegen auth openai --key-file /path/to/private-key-file`. The key value never appears in command arguments, manifests, or application logs. Keep credential files out of Git. Source-mode Bun may load ignored `.env` files; standalone binaries use the process environment and wallet.

## Concurrent jobs and recovery

Global concurrency defaults to four; Settings provides global and per-provider limits. Each copy is an independent job. Different batches, prompts, models, reference sets, and settings can run together. A failed request does not stop other jobs.

Jobs run inside the app. **Ctrl-C** pauses new submissions while current requests settle. On **Ctrl-Q**, choose to wait for current work or interrupt locally. Remote providers may continue interrupted work and charge for it. Reopen Jobs and resume manually.

The engine saves state before submission, immediately after a receipt/result arrives, and after each output. Known asynchronous requests resume by polling their saved receipt. Persisted image results resume by downloading. Expired signed URLs are refreshed by polling the existing receipt. A network failure or server error during submission is **uncertain**, not automatically retried. Check the provider's history before explicitly retrying; a new submission can mean a second charge. Explicit retries create a new job and retain the original job and images. Explicit HTTP 429 rejections are retried up to three times with backoff. Polling tolerates transient failures. Cancellation is best-effort (remote cancellation is available for fal); cancelling synchronously submitted work only interrupts local handling.

Only one process owns the job engine per image root. Other CLI processes can submit, monitor, cancel, and annotate work through its private local socket while the TUI or a foreground generation runs. `--no-wait` requires an existing owner; there is no background daemon. The owner’s credentials and concurrency settings apply.

## Agent CLI

The CLI has a versioned JSON contract, structured errors and exit codes, JSONL progress, stdin inputs, request-key deduplication, discoverable schemas, paginated search, and complete job/output IDs and paths. Agents can work alongside the TUI without starting another engine. See [the agent guide](docs/agents.md) for the full contract, lifecycle limits, and examples.

```sh
imagegen schema --json
imagegen models --json
imagegen generate --prompt-file prompt.txt --request-key cover-v1 --json
imagegen generate --from IMAGE_ID --prompt 'Make the light warmer' --request-key cover-v2 --json
imagegen jobs --json
```

Version 0.2 changes `--json` output to a common `{schemaVersion,ok,command,data,error?}` envelope; agent scripts should read `.data` rather than expecting raw arrays. Generation returns results on completion instead of only printing the input configuration.

## CLI and batch files

```sh
imagegen generate --prompt 'A watercolor forest library' --model gpt-image-2.5-flare --count 3 --settings '{"quality":"medium"}'
imagegen generate --prompt 'Make the lighting warmer' --model gpt-image-2.5-sunburst --ref ./original.png
imagegen batch examples/batch.json --dry-run
imagegen batch examples/batch.json
imagegen jobs
imagegen resume JOB_ID
imagegen resume JOB_ID --retry
imagegen library --query fox --favorite --json
imagegen library --rebuild
imagegen view IMAGE_ID
imagegen export IMAGE_ID --to ~/Pictures/selected
```

Batch JSON has `schemaVersion: 1`, a `name`, and `rows`. Each row contains `prompt`, `model`, optional `provider`, `references`, `parentIds`, `settings`, and `count`. Optional `matrix` contains `prompts`, `models`, an array of `settings`, optional `references`, and `count`; it expands their Cartesian product and appends it to explicit rows. References in imported batch files resolve relative to the JSON file. The TUI's matrix builder combines prompts and models; row duplication and settings editing cover additional variants. The CLI also supports complete settings matrices. Review a real example in [examples/batch.json](examples/batch.json).

`--dry-run` validates model settings and displays expanded configurations without submitting or creating a batch. It does not read reference files; execution validates and snapshots them before submitting.

Configuration uses `${XDG_CONFIG_HOME:-~/.config}/imagegen`; the index/cache uses `${XDG_STATE_HOME:-~/.local/state}/imagegen`. Override with `IMAGEGEN_CONFIG_DIR`, `IMAGEGEN_STATE_DIR`, and `IMAGEGEN_ROOT`.

## Development validation

`npm test` covers matrix validation, provider-specific payloads, scheduler concurrency, independent failures, ambiguous outcomes, interruption, recovery, expired URLs, portable metadata/index rebuilding, export collisions, thumbnail decoding/cropping, and keyboard-driven TUI generation. Dependency overrides pin patched Seroval, glob, and minimatch versions while retaining the Solid peer version required by OpenTUI. `npm run check` type-checks the code and `npm run build` creates the standalone executable. Live generations require a separate agreed spending allowance.
