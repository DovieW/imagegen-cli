import {
  render,
  useKeyboard,
  usePaste,
  useRenderer,
  useTerminalDimensions,
} from "@opentui/solid";
import {
  createMemo,
  createSignal,
  For,
  Show,
  onCleanup,
  createEffect,
  on,
} from "solid-js";
import { NativeImage } from "@opentui/core";
import { PNG } from "pngjs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { authentication, AUTH_PROVIDERS } from "./auth";
import {
  atomicJson,
  configRoot,
  expand,
  loadConfig,
  saveConfig,
} from "./config";
import {
  MODELS,
  modelFor,
  validateRow,
  DEFAULT_MODEL,
  settingsSchema,
} from "./models";
import { Engine } from "./jobs";
import { serveEngine } from "./control";
import { expandBatch, Library, validateInputs } from "./storage";
import { preview, openExternal, animation, rasterize } from "./viewer";
import { pathSuggestions } from "./paths";
import type { BatchRow, BatchSpec, ImageEntry, Provider } from "./types";
const C = {
  bg: "#0b1018",
  panel: "#121c2b",
  text: "#e2eaf6",
  muted: "#8798b4",
  accent: "#75d8c1",
  blue: "#85b9ff",
  red: "#ff8c91",
};
const screens = [
  "Library",
  "Generate",
  "Jobs",
  "Authentication",
  "Settings",
  "Help",
] as const;
type Screen = (typeof screens)[number];
type Action = { name: string; description?: string; run: () => void };
type Dialog = {
  title: string;
  value?: string;
  hint?: string;
  secret?: boolean;
  path?: boolean;
  submit: (value: string) => void | Promise<void>;
};
export function createApp(library: Library, engine: Engine) {
  return function App() {
    const renderer = useRenderer(),
      size = useTerminalDimensions(),
      config = engine.config;
    const [screen, setScreen] = createSignal<Screen>(
      screens.includes(config.lastScreen as Screen)
        ? (config.lastScreen as Screen)
        : "Library",
    );
    const [version, setVersion] = createSignal(0),
      [notice, setNotice] = createSignal("Ready"),
      [query, setQuery] = createSignal(config.query);
    const [selected, setSelected] = createSignal(config.selected),
      [favoriteOnly, setFavoriteOnly] = createSignal(config.favoriteOnly);
    const [sort, setSort] = createSignal(config.sort),
      [group, setGroup] = createSignal(config.groupByBatch);
    const [full, setFull] = createSignal(false),
      [zoom, setZoom] = createSignal(1),
      [pan, setPan] = createSignal({ x: 0.5, y: 0.5 });
    const [format, setFormat] = createSignal("");
    const [frame, setFrame] = createSignal(0),
      [playing, setPlaying] = createSignal(true);
    const [overlayPreview, setOverlayPreview] = createSignal<Uint8Array | null>(
      null,
    );
    let loops = 0;
    const [compare, setCompare] = createSignal<ImageEntry | null>(null),
      [marked, setMarked] = createSignal(new Set<string>());
    const [dialog, setDialog] = createSignal<Dialog | null>(null),
      [actions, setActions] = createSignal<Action[] | null>(null),
      [actionQuery, setActionQuery] = createSignal("");
    const [actionIndex, setActionIndex] = createSignal(0);
    const [secret, setSecret] = createSignal(""),
      [input, setInput] = createSignal(""),
      [closing, setClosing] = createSignal(false);
    const [rows, setRows] = createSignal<BatchRow[]>([]),
      [batchName, setBatchName] = createSignal("Untitled"),
      [rowIndex, setRowIndex] = createSignal(0);
    const [jobIndex, setJobIndex] = createSignal(0),
      [authStatus, setAuthStatus] = createSignal(
        "Environment keys take precedence over saved keys.",
      );
    const refresh = () => setVersion((v) => v + 1);
    engine.on("change", refresh);
    engine.on("error", () =>
      setNotice("Job engine storage error — inspect Jobs"),
    );
    onCleanup(() => {
      engine.off("change", refresh);
      Object.assign(config, {
        lastScreen: screen(),
        query: query(),
        selected: selected(),
        favoriteOnly: favoriteOnly(),
        sort: sort(),
        groupByBatch: group(),
      });
      saveConfig(config);
    });
    const activeCount = () => {
      version();
      return engine.active.size;
    };
    const queuePaused = () => {
      version();
      return engine.paused;
    };
    const images = createMemo(() => {
      version();
      const items = library
        .images(query(), favoriteOnly(), sort())
        .filter(
          (i) =>
            !format() ||
            i.mime === `image/${format() === "svg" ? "svg+xml" : format()}`,
        );
      if (group()) {
        const order = new Map<string, number>();
        for (const i of items)
          if (!order.has(i.batchId)) order.set(i.batchId, order.size);
        items.sort((a, b) => order.get(a.batchId)! - order.get(b.batchId)!);
      }
      return items;
    });
    const current = () =>
      images()[Math.min(selected(), Math.max(0, images().length - 1))];
    const clip = createMemo(() =>
      full() && screen() === "Library" && current()?.mime === "image/gif"
        ? animation(current()!)
        : null,
    );
    createEffect(
      on(
        () => current()?.id,
        () => {
          setFrame(0);
          setPlaying(true);
          loops = 0;
        },
      ),
    );
    createEffect(() => {
      const a = clip(),
        n = frame();
      if (!a || !playing() || dialog() || actions()) return;
      const timer = setTimeout(() => {
        if (n + 1 >= a.frames.length) {
          loops++;
          if (a.loops && loops >= a.loops) {
            setPlaying(false);
            return;
          }
        }
        setFrame((n + 1) % a.frames.length);
      }, a.frames[n]?.delay || 100);
      onCleanup(() => clearTimeout(timer));
    });
    const jobs = createMemo(() => {
      version();
      return [...engine.entries.values()].reverse();
    });
    const cols = () =>
      Math.max(
        1,
        Math.min(
          4,
          Math.floor(
            (size().width - (full() ? 0 : size().width >= 110 ? 42 : 0)) / 27,
          ),
        ),
      );
    const pageSize = () =>
      cols() * Math.max(1, Math.floor((size().height - 12) / 11));
    const visible = () =>
      images().slice(
        Math.floor(selected() / pageSize()) * pageSize(),
        (Math.floor(selected() / pageSize()) + 1) * pageSize(),
      );
    const safe = (fn: () => void | Promise<void>) => {
      try {
        Promise.resolve(fn()).catch((e) => setNotice(e.message));
      } catch (e) {
        setNotice((e as Error).message);
      }
    };
    const go = (s: Screen) => {
      setFull(false);
      setScreen(s);
      setActions(null);
      setDialog(null);
    };
    const ask = (d: Dialog) => {
      setActions(null);
      setSecret("");
      setInput(d.value || "");
      setDialog(d);
    };
    const menu = (list: Action[]) => {
      setDialog(null);
      setActionQuery("");
      setActionIndex(0);
      setActions(list);
    };
    const confirm = (title: string, run: () => void | Promise<void>) =>
      menu([
        {
          name: title,
          description: "Enter to confirm · Esc to cancel",
          run: () => {
            setActions(null);
            safe(run);
          },
        },
      ]);
    const exit = async (interrupt: boolean) => {
      setClosing(true);
      await engine.close(interrupt);
      renderer.destroy();
    };
    const quit = () => {
      if (engine.active.size)
        menu([
          {
            name: "Wait for current requests, then quit",
            description: "Stop queued submissions and save active results.",
            run: () => safe(() => exit(false)),
          },
          {
            name: "Interrupt locally and quit",
            description:
              "Remote work may continue and be billed; recover known requests later.",
            run: () => safe(() => exit(true)),
          },
        ]);
      else safe(() => exit(false));
    };
    const selectedImages = () =>
      marked().size
        ? images().filter((i) => marked().has(i.id))
        : current()
          ? [current()!]
          : [];
    const exportTo = (dest: string) => {
      const list = selectedImages();
      safe(() => {
        try {
          library.export(list, dest);
          config.lastExport = dest;
          setDialog(null);
          setNotice(`Exported ${list.length} images to ${dest}`);
        } catch (e) {
          if ((e as Error).message.startsWith("File exists:"))
            confirm("Overwrite existing export files?", () => {
              library.export(list, dest, true, true);
              setNotice(`Exported to ${dest}`);
            });
          else throw e;
        }
      });
    };
    const exportDialog = () =>
      ask({
        title: `Export ${selectedImages().length} image(s) and metadata`,
        value: config.lastExport,
        path: true,
        submit: exportTo,
      });
    const makeRow = (reference?: ImageEntry) => {
      const row: BatchRow = {
        prompt: reference ? "Describe your edit" : "Describe the image",
        model: reference?.model || DEFAULT_MODEL,
        references: reference ? [reference.path] : [],
        parentIds: reference ? [reference.id] : [],
        settings: {},
        count: 1,
      };
      setRows([...rows(), row]);
      setRowIndex(rows().length - 1);
      go("Generate");
      editRow(rows().length - 1);
    };
    const updateRow = (i: number, patch: Partial<BatchRow>) =>
      setRows(rows().map((r, n) => (n === i ? { ...r, ...patch } : r)));
    const editRow = (i: number) => {
      setRowIndex(i);
      const r = rows()[i];
      if (!r) return;
      menu([
        {
          name: "Prompt",
          description: r.prompt,
          run: () =>
            ask({
              title: "Prompt",
              value: r.prompt,
              submit: (v) => {
                updateRow(i, { prompt: v });
                setDialog(null);
              },
            }),
        },
        {
          name: "Model",
          description: modelFor(r.model).label,
          run: () =>
            menu(
              MODELS.map((m) => ({
                name: m.label,
                description: `${m.provider} · ${m.maxReferences} reference inputs`,
                run: () => {
                  updateRow(i, {
                    model: m.id,
                    provider: m.provider,
                    settings: {},
                  });
                  setActions(null);
                },
              })),
            ),
        },
        {
          name: "Copies",
          description: String(r.count || 1),
          run: () =>
            ask({
              title: "Number of independent generations",
              value: String(r.count || 1),
              submit: (v) => {
                const n = Number(v);
                if (!Number.isInteger(n) || n < 1 || n > 1000)
                  throw new Error("Choose 1–1000");
                updateRow(i, { count: n });
                setDialog(null);
              },
            }),
        },
        {
          name: "Reference images",
          description: `${r.references?.length || 0} selected`,
          run: () =>
            menu([
              {
                name: "Add reference image",
                run: () =>
                  ask({
                    title: "Reference image file",
                    path: true,
                    submit: (v) => {
                      updateRow(i, {
                        references: [...(r.references || []), expand(v)],
                      });
                      setDialog(null);
                    },
                  }),
              },
              {
                name: "Clear references",
                run: () => {
                  updateRow(i, { references: [], parentIds: [] });
                  setActions(null);
                },
              },
            ]),
        },
        ...(["mask", "markup"] as const).map((kind) => ({
          name: kind === "mask" ? "Edit mask" : "Edit markup",
          description: r[kind] || "None",
          run: () =>
            ask({
              title: `${kind} PNG path · blank removes`,
              path: true,
              value: r[kind],
              submit: (v) => {
                updateRow(i, { [kind]: v ? expand(v) : undefined });
                setDialog(null);
              },
            }),
        })),
        {
          name: "Preview edit overlay",
          run: () => {
            const overlay = r.markup || r.mask;
            if (!overlay || !r.references?.[0])
              throw new Error("Choose a reference and mask/markup first");
            validateRow(r);
            validateInputs([r]);
            const base = NativeImage.decode(readFileSync(r.references[0])),
              layer = NativeImage.decode(readFileSync(overlay));
            let composed: NativeImage | undefined;
            try {
              composed = base.composite(layer, { opacity: 0.6 });
              const raw = composed.raw(),
                png = new PNG({ width: raw.width, height: raw.height });
              png.data = Buffer.from(raw.data);
              setOverlayPreview(PNG.sync.write(png));
              setActions(null);
            } finally {
              composed?.dispose();
              base.dispose();
              layer.dispose();
            }
          },
        },
        {
          name: "Model settings",
          description: JSON.stringify(r.settings || {}),
          run: () =>
            menu([
              {
                name: "Reset to provider defaults",
                run: () => {
                  updateRow(i, { settings: {} });
                  setActions(null);
                },
              },
              ...Object.entries(
                settingsSchema(modelFor(r.model)).properties || {},
              ).map(([key, rule]) => ({
                name: key,
                description: `Current: ${JSON.stringify(r.settings?.[key] ?? "provider default")}`,
                run: () =>
                  rule.enum
                    ? menu(
                        rule.enum.map((v) => ({
                          name: String(v),
                          run: () => {
                            updateRow(i, {
                              settings: { ...r.settings, [key]: v },
                            });
                            setActions(null);
                          },
                        })),
                      )
                    : ask({
                        title: `${key}${rule.type === "object" ? " (JSON)" : ""} · blank removes setting`,
                        value:
                          r.settings?.[key] === undefined
                            ? ""
                            : typeof r.settings[key] === "object"
                              ? JSON.stringify(r.settings[key])
                              : String(r.settings[key]),
                        submit: (v) => {
                          const settings = { ...r.settings };
                          if (!v) delete settings[key];
                          else
                            settings[key] =
                              rule.type === "integer"
                                ? Number(v)
                                : rule.type === "object" ||
                                    rule.type === "boolean"
                                  ? JSON.parse(v)
                                  : v;
                          updateRow(i, { settings });
                          setDialog(null);
                        },
                      }),
              })),
            ]),
        },
        {
          name: "Duplicate row",
          run: () => {
            setRows([...rows(), structuredClone(r)]);
            setActions(null);
          },
        },
        {
          name: "Remove row",
          run: () => {
            setRows(rows().filter((_, n) => n !== i));
            setActions(null);
          },
        },
      ]);
    };
    const review = () => {
      const spec: BatchSpec = {
        schemaVersion: 1,
        name: batchName(),
        rows: rows(),
      };
      const expanded = expandBatch(spec);
      validateInputs(expanded);
      const n = expanded.reduce((s, r) => s + (r.count || 1), 0);
      menu([
        {
          name: `Start ${n} generations`,
          description: `${rows().length} rows · ${new Set(rows().map((r) => r.model)).size} models · concurrency ${config.concurrency}. Provider billing applies.`,
          run: () =>
            safe(() => {
              const { dir, batch } = library.create(spec);
              engine.paused = false;
              engine.add(dir, batch);
              setActions(null);
              go("Jobs");
              setNotice(`Started ${n} jobs`);
            }),
        },
      ]);
    };
    const batchActions = () =>
      menu([
        { name: "Add generation row", run: () => makeRow() },
        {
          name: "Rename batch",
          run: () =>
            ask({
              title: "Batch name",
              value: batchName(),
              submit: (v) => {
                setBatchName(v);
                setDialog(null);
              },
            }),
        },
        {
          name: "Expand prompt/model matrix",
          description: "Combine prompts separated by || with selected models.",
          run: () =>
            ask({
              title: "Prompts separated by ||",
              submit: (v) => {
                const prompts = v
                  .split("||")
                  .map((s) => s.trim())
                  .filter(Boolean);
                const chosen = new Set<string>();
                const choose = () =>
                  menu([
                    ...MODELS.map((m) => ({
                      name: `${chosen.has(m.id) ? "✓ " : ""}${m.label}`,
                      run: () => {
                        chosen.has(m.id)
                          ? chosen.delete(m.id)
                          : chosen.add(m.id);
                        choose();
                      },
                    })),
                    {
                      name: "Add combinations to batch",
                      run: () => {
                        if (!chosen.size || !prompts.length)
                          throw new Error("Choose models and prompts");
                        setRows([
                          ...rows(),
                          ...prompts.flatMap((prompt) =>
                            [...chosen].map((model) => ({
                              prompt,
                              model,
                              count: 1,
                              settings: {},
                            })),
                          ),
                        ]);
                        setActions(null);
                      },
                    },
                  ]);
                choose();
              },
            }),
        },
        {
          name: "Save preset",
          run: () =>
            ask({
              title: "Preset name",
              value: batchName(),
              submit: (v) => {
                config.presets[v] = { name: batchName(), rows: rows() };
                saveConfig(config);
                setDialog(null);
                setNotice("Preset saved");
              },
            }),
        },
        {
          name: "Load preset",
          run: () =>
            menu(
              Object.entries(config.presets).map(([name, p]) => ({
                name,
                run: () => {
                  const preset = p as { name: string; rows: BatchRow[] };
                  setBatchName(preset.name);
                  setRows(structuredClone(preset.rows));
                  setActions(null);
                },
              })),
            ),
        },
        {
          name: "Import batch JSON",
          run: () =>
            ask({
              title: "Batch JSON path",
              path: true,
              submit: (v) => {
                const path = expand(v),
                  spec = JSON.parse(readFileSync(path, "utf8")) as BatchSpec;
                const expanded = expandBatch(spec).map((r) => ({
                  ...r,
                  references: r.references?.map((p) =>
                    p.startsWith("/") || p.startsWith("~")
                      ? expand(p)
                      : join(dirname(path), p),
                  ),
                }));
                setRows(expanded);
                setBatchName(spec.name);
                setDialog(null);
              },
            }),
        },
        {
          name: "Save batch JSON",
          run: () =>
            ask({
              title: "New batch JSON path",
              path: true,
              submit: (v) => {
                const path = expand(v);
                if (Bun.file(path).size > 0)
                  throw new Error("File exists; choose a new name");
                atomicJson(path, {
                  schemaVersion: 1,
                  name: batchName(),
                  rows: rows(),
                });
                setDialog(null);
              },
            }),
        },
        { name: "Review and start", run: () => safe(review) },
      ]);
    const imageActions = () => {
      const image = current();
      if (!image) return;
      menu([
        {
          name: "View full screen",
          run: () => {
            setFull(true);
            setActions(null);
          },
        },
        {
          name:
            image.mime === "image/svg+xml"
              ? "Rasterize as reference"
              : image.mime === "image/gif"
                ? "Use current frame as reference"
                : "Use as reference / edit",
          run: () =>
            makeRow(
              ["image/svg+xml", "image/gif"].includes(image.mime)
                ? {
                    ...image,
                    path: rasterize(
                      image,
                      image.mime === "image/gif" ? frame() : 0,
                      library.state,
                    ),
                  }
                : image,
            ),
        },
        {
          name: image.favorite ? "Remove favorite" : "Favorite",
          run: () => {
            library.annotate(image, { favorite: !image.favorite });
            refresh();
            setActions(null);
          },
        },
        {
          name: "Edit tags",
          description: image.tags.join(", "),
          run: () =>
            ask({
              title: "Tags, comma separated",
              value: image.tags.join(", "),
              submit: (v) => {
                library.annotate(image, {
                  tags: [
                    ...new Set(
                      v
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    ),
                  ],
                });
                refresh();
                setDialog(null);
              },
            }),
        },
        {
          name: "Pin for side-by-side comparison",
          run: () => {
            setCompare(image);
            setFull(true);
            setActions(null);
            setNotice("Select another image with left/right to compare");
          },
        },
        { name: "Export selection", run: exportDialog },
        {
          name: "Open in external viewer",
          run: () => safe(() => openExternal(image.path)),
        },
        {
          name: "Reveal in folder",
          run: () => safe(() => openExternal(dirname(image.path))),
        },
        {
          name: "Copy path",
          run: () => {
            renderer.copyToClipboardOSC52(image.path);
            setActions(null);
            setNotice("Path copied");
          },
        },
      ]);
    };
    const jobActions = (id: string) => {
      const e = engine.entries.get(id)!;
      menu([
        {
          name: "Resume / recover",
          description: e.job.error || e.job.status,
          run: () =>
            safe(() => {
              engine.resume(id);
              setActions(null);
            }),
        },
        {
          name: "Retry as a new request",
          description:
            "May incur another charge. Inspect provider history for uncertain submissions.",
          run: () =>
            confirm("Confirm new paid request", () => {
              engine.resume(id, true);
              setActions(null);
            }),
        },
        {
          name: "Pause queued submissions",
          run: () => {
            engine.pause();
            setActions(null);
          },
        },
        {
          name: "Cancel job",
          description:
            "Remote cancellation is best-effort; submitted work may still be billed.",
          run: () => confirm("Confirm cancellation", () => engine.cancel(id)),
        },
      ]);
    };
    const showSettings = () =>
      menu([
        {
          name: "Global concurrency",
          description: String(config.concurrency),
          run: () =>
            ask({
              title: "Maximum concurrent requests",
              value: String(config.concurrency),
              submit: (v) => {
                const n = Number(v);
                if (!Number.isInteger(n) || n < 1 || n > 1000)
                  throw new Error("Choose 1–1000");
                config.concurrency = n;
                saveConfig(config);
                engine.pump();
                setDialog(null);
                refresh();
              },
            }),
        },
        ...AUTH_PROVIDERS.filter((p) =>
          MODELS.some((m) => m.provider === p.id),
        ).map((p) => ({
          name: `${p.label} concurrency`,
          description: String(
            config.providerLimits[p.id] || config.concurrency,
          ),
          run: () =>
            ask({
              title: `${p.label} concurrent requests`,
              value: String(config.providerLimits[p.id] || config.concurrency),
              submit: (v) => {
                const n = Number(v);
                if (!Number.isInteger(n) || n < 1 || n > 1000)
                  throw new Error("Choose 1–1000");
                config.providerLimits[p.id] = n;
                saveConfig(config);
                engine.pump();
                setDialog(null);
              },
            }),
        })),
        {
          name: "Rebuild library index",
          description: "Read image metadata from batch folders",
          run: () => {
            setNotice(`Indexed ${library.rebuild()} images`);
            refresh();
            setActions(null);
          },
        },
        {
          name: "Toggle batch grouping",
          run: () => {
            setGroup(!group());
            setActions(null);
          },
        },
        {
          name: "Sort images",
          run: () =>
            menu(
              ["newest", "oldest", "model"].map((s) => ({
                name: s,
                run: () => {
                  setSort(s as typeof config.sort);
                  setActions(null);
                },
              })),
            ),
        },
      ]);
    const authActions = (provider: Provider) =>
      menu([
        {
          name: "Set API key",
          description: "Masked input; saved only in the system wallet",
          run: () =>
            ask({
              title: `${provider} API key`,
              secret: true,
              submit: async (v) => {
                await authentication.save(provider, "key", v);
                setSecret("");
                setDialog(null);
                setNotice("Key saved in system wallet");
              },
            }),
        },
        {
          name: "Load key from file",
          run: () =>
            ask({
              title: "Key file path",
              path: true,
              submit: async (v) => {
                await authentication.save(
                  provider,
                  "key",
                  readFileSync(expand(v), "utf8"),
                );
                setDialog(null);
                setNotice("Key saved in system wallet");
              },
            }),
        },
        ...(provider === "microsoft"
          ? [
              {
                name: "Set Azure endpoint",
                run: () =>
                  ask({
                    title: "Azure resource HTTPS endpoint",
                    submit: async (v) => {
                      await authentication.save(provider, "endpoint", v);
                      setDialog(null);
                    },
                  }),
              },
            ]
          : []),
        {
          name: "Check authentication status",
          run: () =>
            safe(async () => {
              const status = await authentication.status(provider);
              setAuthStatus(
                `${provider}: ${status.key}${status.endpoint ? " · endpoint configured" : ""}`,
              );
              setActions(null);
            }),
        },
        {
          name: "Remove saved credential",
          description: "Environment variables remain in effect",
          run: () =>
            confirm("Remove saved credential?", () =>
              authentication.remove(provider),
            ),
        },
      ]);
    const palette = () =>
      menu([
        ...screens.map((s) => ({ name: s, run: () => go(s) })),
        { name: "New generation", run: () => makeRow() },
        { name: "Export selection", run: exportDialog },
        { name: "Resume paused jobs", run: () => engine.resume() },
        { name: "Pause queue", run: () => engine.pause() },
        { name: "Quit", run: quit },
      ]);
    const submitDialog = (value: string) => {
      const d = dialog();
      if (d) safe(() => d.submit(value));
    };
    usePaste((event) => {
      if (dialog()?.secret) {
        setSecret((v) => v + new TextDecoder().decode(event.bytes));
        event.preventDefault();
      }
    });
    useKeyboard((key) => {
      if (closing()) return;
      if (key.ctrl && key.name === "q") {
        quit();
        return;
      }
      if (dialog()?.secret) {
        if (overlayPreview()) {
          if (key.name === "escape" || key.name === "return")
            setOverlayPreview(null);
          return;
        }
        if (key.name === "escape") {
          setDialog(null);
          setSecret("");
        } else if (key.name === "return") submitDialog(secret());
        else if (key.name === "backspace") setSecret((s) => s.slice(0, -1));
        else if (key.ctrl && key.name === "u") setSecret("");
        else if (
          !key.ctrl &&
          !key.meta &&
          key.sequence &&
          key.sequence.length === 1
        )
          setSecret((s) => s + key.sequence);
        return;
      }
      if (key.name === "escape") {
        if (dialog()) {
          setDialog(null);
          return;
        }
        if (actions()) {
          setActions(null);
          return;
        }
        if (full()) {
          setFull(false);
          setCompare(null);
          setZoom(1);
          return;
        }
        if (query()) {
          setQuery("");
          return;
        }
        go("Library");
        return;
      }
      if (dialog()) {
        if (key.name === "return") {
          key.preventDefault();
          submitDialog(input());
          return;
        }
        if (key.name === "tab" && dialog()?.path) {
          const option = pathSuggestions(input())[0];
          if (option) setInput(option.path);
        }
        return;
      }
      if (actions()) {
        if (key.name === "return") {
          key.preventDefault();
          const a = filteredActions()[actionIndex()];
          if (a) safe(a.run);
          return;
        }
        if (key.name === "up" || key.name === "down") {
          key.preventDefault();
          setActionIndex((i) =>
            Math.max(
              0,
              Math.min(
                filteredActions().length - 1,
                i + (key.name === "up" ? -1 : 1),
              ),
            ),
          );
        }
        return;
      }
      if (key.ctrl && key.name === "p") {
        palette();
        return;
      }
      if (key.ctrl && key.name === "c") {
        engine.active.size ? engine.pause() : quit();
        return;
      }
      if (key.name === "tab") {
        go(screens[(screens.indexOf(screen()) + 1) % screens.length]!);
        return;
      }
      if (key.name === "f1") {
        go("Help");
        return;
      }
      if (screen() === "Library") {
        key.preventDefault();
        if (key.name === "t") {
          menu(
            ["", "png", "jpeg", "webp", "svg", "gif"].map((f) => ({
              name: f || "All formats",
              run: () => {
                setFormat(f);
                setSelected(0);
                setActions(null);
              },
            })),
          );
          return;
        }
        if (
          full() &&
          clip() &&
          (key.name === "space" || ["[", "]"].includes(key.sequence))
        ) {
          if (key.name === "space") setPlaying(!playing());
          else {
            setPlaying(false);
            setFrame(
              (frame() +
                (key.sequence === "[" ? -1 : 1) +
                clip()!.frames.length) %
                clip()!.frames.length,
            );
          }
          return;
        }
        const step =
          key.name === "left"
            ? -1
            : key.name === "right"
              ? 1
              : key.name === "up"
                ? -cols()
                : key.name === "down"
                  ? cols()
                  : 0;
        if (step) {
          setSelected((n) =>
            Math.max(0, Math.min(images().length - 1, n + step)),
          );
          setZoom(1);
          return;
        }
        if (full() && ["+", "=", "-", "0"].includes(key.sequence)) {
          setZoom((z) =>
            key.sequence === "0"
              ? 1
              : Math.max(
                  1,
                  Math.min(8, z * (key.sequence === "-" ? 0.8 : 1.25)),
                ),
          );
          return;
        }
        if (full() && ["h", "j", "k", "l"].includes(key.name)) {
          setPan((p) => ({
            x: Math.max(
              0,
              Math.min(
                1,
                p.x + (key.name === "h" ? -0.1 : key.name === "l" ? 0.1 : 0),
              ),
            ),
            y: Math.max(
              0,
              Math.min(
                1,
                p.y + (key.name === "k" ? -0.1 : key.name === "j" ? 0.1 : 0),
              ),
            ),
          }));
          return;
        }
        if (key.name === "return") imageActions();
        if (key.name === "v") setFull(!full());
        if (key.name === "n") makeRow();
        if (key.name === "e") exportDialog();
        if (key.name === "o" && current())
          safe(() => openExternal(current()!.path));
        if (key.name === "f" && current()) {
          library.annotate(current()!, { favorite: !current()!.favorite });
          refresh();
        }
        if (key.name === "s") {
          setFavoriteOnly(!favoriteOnly());
          setSelected(0);
        }
        if (key.name === "space" && current())
          setMarked((s) => {
            const n = new Set(s);
            n.has(current()!.id)
              ? n.delete(current()!.id)
              : n.add(current()!.id);
            return n;
          });
        if (key.sequence === "/")
          ask({
            title: "Search prompts, tags, models, dates, batches",
            value: query(),
            submit: (v) => {
              setQuery(v);
              setSelected(0);
              setDialog(null);
            },
          });
        return;
      }
      if (screen() === "Generate") {
        if (["a", "n"].includes(key.name) || (key.ctrl && key.name === "r"))
          key.preventDefault();
        if (key.name === "a") batchActions();
        if (key.name === "n") makeRow();
        if (key.ctrl && key.name === "r") safe(review);
      }
      if (screen() === "Settings" && key.name === "return") showSettings();
    });
    const safePreview = (image: ImageEntry, width: number, z = 1) => {
      try {
        return preview(
          image,
          width,
          z,
          pan().x,
          pan().y,
          library.state,
          full() && image.id === current()?.id ? frame() : 0,
        );
      } catch {
        return undefined;
      }
    };
    function Picture(props: {
      image: ImageEntry;
      width?: number;
      large?: boolean;
    }) {
      const source = createMemo(() =>
        safePreview(
          props.image,
          props.large ? 1200 : 360,
          props.large ? zoom() : 1,
        ),
      );
      return (
        <Show
          when={source()}
          fallback={
            <text fg={C.muted}>Image unavailable · O opens externally</text>
          }
        >
          <image
            source={source()!}
            protocol="auto"
            fit="fit"
            width="100%"
            height="100%"
          />
        </Show>
      );
    }
    const previewJob = () => {
      version();
      return jobs()[jobIndex()]?.job;
    };
    const filteredActions = () =>
      actions()?.filter((a) =>
        a.name.toLowerCase().includes(actionQuery().toLowerCase()),
      ) || [];
    return (
      <box
        width="100%"
        height="100%"
        flexDirection="column"
        backgroundColor={C.bg}
      >
        <box
          height={3}
          paddingLeft={2}
          paddingRight={2}
          alignItems="center"
          flexDirection="row"
          backgroundColor={C.panel}
        >
          <text fg={C.accent}>
            <b>◈ imagegen</b>
          </text>
          <text fg={C.muted}> concurrent image workbench</text>
          <box flexGrow={1} />
          <text
            fg={C.blue}
          >{`${activeCount()} active · ${library.images().length} images`}</text>
        </box>
        <box height={2} flexDirection="row" gap={2} paddingLeft={2}>
          <For each={screens}>
            {(s) => (
              <text
                fg={screen() === s ? C.accent : C.muted}
                onMouseDown={() => go(s)}
              >
                {screen() === s ? "● " : "  "}
                {s}
              </text>
            )}
          </For>
        </box>
        <box
          flexGrow={1}
          flexDirection="column"
          paddingLeft={2}
          paddingRight={2}
        >
          <Show when={screen() === "Library"}>
            <box height={2}>
              <text fg={C.muted}>
                {query() ? `Search: ${query()} · ` : ""}
                {favoriteOnly() ? "Favorites · " : ""}
                {images().length} images · {marked().size} selected · {sort()} ·{" "}
                {group() ? "batch labels" : "model labels"}
              </text>
            </box>
            <Show
              when={full() && current()}
              fallback={
                <box flexGrow={1} flexDirection="row" gap={2}>
                  <box flexGrow={1} flexDirection="column">
                    <Show
                      when={images().length}
                      fallback={
                        <box padding={2} flexDirection="column">
                          <text fg={C.text}>
                            Your image library starts here.
                          </text>
                          <text fg={C.muted}>
                            Press N to configure a generation. Originals and
                            metadata live in {library.root}.
                          </text>
                        </box>
                      }
                    >
                      <For
                        each={Array.from(
                          { length: Math.ceil(visible().length / cols()) },
                          (_, i) => i,
                        )}
                      >
                        {(row) => (
                          <box flexDirection="row" height={11} gap={1}>
                            <For
                              each={visible().slice(
                                row * cols(),
                                (row + 1) * cols(),
                              )}
                            >
                              {(image) => (
                                <box
                                  width={`${100 / cols()}%`}
                                  height={10}
                                  border
                                  borderColor={
                                    current()?.id === image.id
                                      ? C.accent
                                      : C.panel
                                  }
                                  flexDirection="column"
                                  onMouseDown={() => {
                                    setSelected(
                                      images().findIndex(
                                        (i) => i.id === image.id,
                                      ),
                                    );
                                  }}
                                  onMouseScroll={(e) => {
                                    setSelected((n) =>
                                      Math.max(
                                        0,
                                        Math.min(
                                          images().length - 1,
                                          n +
                                            (e.scroll?.direction === "up"
                                              ? -cols()
                                              : cols()),
                                        ),
                                      ),
                                    );
                                  }}
                                >
                                  <box height={6}>
                                    <Picture image={image} />
                                  </box>
                                  <text
                                    fg={image.favorite ? C.accent : C.text}
                                    truncate
                                  >
                                    {marked().has(image.id)
                                      ? "✓ "
                                      : image.favorite
                                        ? "★ "
                                        : ""}
                                    {group() ? image.batchName : image.model}
                                  </text>
                                  <text fg={C.muted} truncate>
                                    {image.prompt}
                                  </text>
                                </box>
                              )}
                            </For>
                          </box>
                        )}
                      </For>
                    </Show>
                  </box>
                  <Show when={size().width >= 110 && current()}>
                    <box
                      width={38}
                      flexDirection="column"
                      gap={1}
                      border
                      borderColor={C.panel}
                      padding={1}
                    >
                      <box height={13}>
                        <Picture image={current()!} large />
                      </box>
                      <text fg={C.accent}>{current()!.model}</text>
                      <text fg={C.text}>{current()!.prompt}</text>
                      <text fg={C.muted}>
                        {[
                          current()!.batchName,
                          current()!.createdAt,
                          current()!.tags.join(", "),
                          JSON.stringify(current()!.settings),
                        ].join("\n")}
                      </text>
                      <text fg={C.muted}>
                        {
                          "Enter actions · V full screen\nSpace select · E export\nF favorite · S favorites filter"
                        }
                      </text>
                    </box>
                  </Show>
                </box>
              }
            >
              <box flexGrow={1} flexDirection="row" gap={2}>
                <Show when={compare()}>
                  <box width="50%" flexDirection="column">
                    <text fg={C.muted}>Pinned · {compare()!.model}</text>
                    <box flexGrow={1}>
                      <Picture image={compare()!} large />
                    </box>
                  </box>
                </Show>
                <box flexGrow={1} flexDirection="column">
                  <text fg={C.accent}>
                    {current()!.model} · {zoom().toFixed(1)}×
                  </text>
                  <box flexGrow={1}>
                    <Picture image={current()!} large />
                  </box>
                  <text fg={C.text} truncate>
                    {current()!.prompt}
                  </text>
                  <text fg={C.muted}>
                    ←→ next · +/- zoom · HJKL pan · 0 fit · Esc gallery
                  </text>
                </box>
              </box>
            </Show>
          </Show>
          <Show when={screen() === "Generate"}>
            <text fg={C.accent}>Batch: {batchName()}</text>
            <text fg={C.muted}>
              N add row · A batch actions / presets / matrix · Ctrl-R review and
              start
            </text>
            <select
              flexGrow={1}
              focused={!dialog() && !actions()}
              options={rows().map((r, i) => ({
                name: `${i + 1}. ${r.prompt}`,
                description: `${modelFor(r.model).label} · ${r.count || 1} copies · ${r.references?.length || 0} references · ${JSON.stringify(r.settings || {})}`,
                value: i,
              }))}
              selectedIndex={rowIndex()}
              onChange={(i) => setRowIndex(i)}
              onSelect={(_, o) => editRow(o!.value)}
            />
            <Show when={!rows().length}>
              <text fg={C.muted}>
                Press N to add your first generation row.
              </text>
            </Show>
          </Show>
          <Show when={screen() === "Jobs"}>
            <text fg={C.accent}>
              Jobs · {activeCount()} active ·{" "}
              {queuePaused() ? "queue paused" : "queue running"}
            </text>
            <select
              flexGrow={1}
              focused={!dialog() && !actions()}
              selectedIndex={jobIndex()}
              onChange={(i) => setJobIndex(i)}
              options={jobs().map((e) => ({
                name: `${e.job.status.padEnd(12)} ${e.job.model} · ${e.batch.name}`,
                description: `${e.job.prompt.slice(0, 90)}${e.job.error ? " · " + e.job.error : ""}`,
                value: e.job.id,
              }))}
              onSelect={(_, o) => jobActions(o!.value)}
            />
            <text fg={C.muted}>
              Enter control selected job · Ctrl-C pause queue · Ctrl-P resume
              paused jobs
            </text>
            <Show when={previewJob()?.preview}>
              <box height={12}>
                <image
                  source={previewJob()!.preview!.path}
                  protocol="auto"
                  fit="fit"
                  width="100%"
                  height="100%"
                />
              </box>
            </Show>
          </Show>
          <Show when={screen() === "Authentication"}>
            <text fg={C.muted}>{authStatus()}</text>
            <select
              focused={!dialog() && !actions()}
              flexGrow={1}
              options={AUTH_PROVIDERS.filter((p) =>
                MODELS.some((m) => m.provider === p.id),
              ).map((p) => ({
                name: p.label,
                description: p.env,
                value: p.id,
              }))}
              onSelect={(_, o) => authActions(o!.value)}
            />
          </Show>
          <Show when={screen() === "Settings"}>
            <text
              fg={C.text}
            >{`Global concurrency: ${config.concurrency}\nImage folder: ${library.root}\nIndex and thumbnails: ${library.state}\n\nPress Enter to edit settings, provider limits, sorting, and rebuild the library index.`}</text>
          </Show>
          <Show when={screen() === "Help"}>
            <scrollbox flexGrow={1} focused={!dialog() && !actions()}>
              <text
                fg={C.text}
              >{`Generate\n  N adds a row. Enter edits prompt, model, copies, references, and settings.\n  A opens batch actions: matrix, presets, JSON import/export, review/start.\n  New batches can start while others run.\n\nLibrary\n  Arrows navigate · Enter actions · / search · V full screen\n  F favorite · S favorites only · Space multi-select · E export · O external viewer\n  T filters formats · Full screen GIF: Space play/pause · [ ] frames\n  Full screen: +/- zoom · HJKL pan · 0 fit · arrows next image\n  Pin an image from its action menu to compare with another.\n\nJobs\n  Enter resumes, explicitly retries, or cancels a job. Ctrl-C pauses queued work.\n  Exit waits for active requests or interrupts locally. Remote work may continue.\n  Interrupted submissions without a receipt need explicit retry confirmation.\n\nNavigation\n  Tab next screen · Ctrl-P action palette · F1 help · Esc back · Ctrl-Q quit\n  Path prompts: Tab complete; click a suggestion, Enter accepts the path.\n\nImages and metadata live together under ${library.root}.\nThe index can be rebuilt from Settings. Export copies originals and metadata.\nUse imagegen --help for CLI commands and batch file options.`}</text>
            </scrollbox>
          </Show>
        </box>
        <box height={3} paddingLeft={2} flexDirection="column">
          <text
            fg={notice().toLowerCase().includes("error") ? C.red : C.accent}
            truncate
          >
            {closing() ? "Waiting for active work to settle…" : notice()}
          </text>
          <text fg={C.muted}>
            Tab screens · Ctrl-P actions · F1 help · Esc back · Ctrl-Q quit
          </text>
        </box>
        <Show when={actions()}>
          <box
            position="absolute"
            left="12%"
            top="18%"
            width="76%"
            height="65%"
            border
            borderColor={C.accent}
            backgroundColor={C.panel}
            padding={1}
            flexDirection="column"
          >
            <text fg={C.accent}>Actions</text>
            <input
              focused
              placeholder="Filter actions…"
              value={actionQuery()}
              onInput={(v) => {
                setActionQuery(v);
                setActionIndex(0);
              }}
            />
            <select
              selectedIndex={actionIndex()}
              flexGrow={1}
              focused={false}
              options={filteredActions().map((a) => ({
                name: a.name,
                description: a.description || "",
                value: a,
              }))}
              onSelect={(_, o) => safe(o!.value.run)}
            />
            <text fg={C.muted}>
              Type to filter · ↑↓ choose · Enter select · click an action · Esc
              cancel
            </text>
          </box>
        </Show>
        <Show when={dialog()}>
          <box
            position="absolute"
            left="10%"
            top="22%"
            width="80%"
            height={dialog()?.path ? 18 : 9}
            border
            borderColor={C.accent}
            backgroundColor={C.panel}
            padding={1}
            flexDirection="column"
          >
            <text fg={C.accent}>{dialog()!.title}</text>
            <Show
              when={dialog()?.secret}
              fallback={<input focused value={input()} onInput={setInput} />}
            >
              <text fg={C.text}>
                {"•".repeat(Math.min(secret().length, 60))}
              </text>
            </Show>
            <Show when={dialog()?.path}>
              <For each={pathSuggestions(input()).slice(0, 8)}>
                {(p) => (
                  <text
                    fg={C.muted}
                    onMouseDown={() => setInput(p.path)}
                    truncate
                  >
                    {p.directory ? "▸ " : "  "}
                    {p.path}
                  </text>
                )}
              </For>
            </Show>
            <text fg={C.muted}>
              Enter save · Esc cancel{dialog()?.path ? " · Tab complete" : ""}
            </text>
          </box>
        </Show>
        <Show when={overlayPreview()}>
          <box
            position="absolute"
            top={3}
            left={2}
            width="90%"
            height="80%"
            border
            backgroundColor={C.panel}
            flexDirection="column"
          >
            <text>Overlay preview · Esc closes</text>
            <image
              source={overlayPreview()!}
              protocol="auto"
              fit="fit"
              width="100%"
              flexGrow={1}
            />
          </box>
        </Show>
        <Show when={full() && clip()}>
          <text
            position="absolute"
            bottom={3}
            left={2}
          >{`GIF ${frame() + 1}/${clip()!.frames.length} · ${playing() ? "Playing" : "Paused"} · Space play/pause · [ ] frame`}</text>
        </Show>
      </box>
    );
  };
}
export async function runTui(library: Library) {
  const engine = new Engine(library);
  const App = createApp(library, engine);
  try {
    await serveEngine(engine);
    await new Promise<void>((resolve, reject) => {
      void render(() => <App />, {
        exitOnCtrlC: false,
        onDestroy: resolve,
      }).catch(reject);
    });
  } finally {
    await engine.close(true);
  }
}
