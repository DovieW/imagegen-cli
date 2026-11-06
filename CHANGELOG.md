# Releases

## 0.3.0

- Add GPT Image 2.6 Sunburst and Flare, with Flare as the shared default for new generations.
- Add schema-driven raster, complexity, SVG author, animation, and streaming controls in CLI and TUI.
- Add validated mask/markup inputs with portable snapshots, overlay preview, and content-aware deduplication.
- Preserve SVG/GIF originals; add vector previews, animated playback/frame stepping, explicit PNG reference conversion, and format filtering.
- Add per-job streaming previews and JSONL preview events; retain uncertain submission and independent job semantics.
- Preserve effective settings and separate SVG author usage; distinguish quota errors from retryable rate limiting.
- Add standalone decoder/packaging smoke checks to CI and releases.

GIF preview access and SVG author selection depend on account permissions. No paid generations are included in automated validation. The direct Images API is used; persistent Responses conversations are not part of this release.

Validation: type checking, 45 fixture-based tests, standalone build, and isolated executable smoke checks pass. Live API generation remains untested. Final desktop visual verification was blocked by the locked screen; the installed Ghostty reports 1.3.0-dev, so Ghostty 1.4 visual verification is also pending.
