import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import type { Provider } from "./types";
export const expand = (p: string) =>
  resolve(
    p === "~"
      ? homedir()
      : p.startsWith("~/")
        ? join(homedir(), p.slice(2))
        : p,
  );
export const configRoot = () =>
  process.env.IMAGEGEN_CONFIG_DIR ||
  join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "imagegen");
export const stateRoot = () =>
  process.env.IMAGEGEN_STATE_DIR ||
  join(
    process.env.XDG_STATE_HOME || join(homedir(), ".local/state"),
    "imagegen",
  );
export const imageRoot = () =>
  expand(process.env.IMAGEGEN_ROOT || "~/imagegen");
export function atomicJson(path: string, value: unknown) {
  mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
  const tmp = path + ".tmp-" + crypto.randomUUID();
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}
export interface Config {
  concurrency: number;
  providerLimits: Partial<Record<Provider, number>>;
  lastExport: string;
  lastScreen: string;
  query: string;
  selected: number;
  groupByBatch: boolean;
  sort: "newest" | "oldest" | "model";
  favoriteOnly: boolean;
  presets: Record<string, unknown>;
}
export const defaults = (): Config => ({
  concurrency: 4,
  providerLimits: {},
  lastExport: homedir(),
  lastScreen: "Library",
  query: "",
  selected: 0,
  groupByBatch: true,
  sort: "newest",
  favoriteOnly: false,
  presets: {},
});
export function loadConfig(): Config {
  const p = join(configRoot(), "config.json");
  const c = {
    ...defaults(),
    ...(existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {}),
  };
  if (!Number.isInteger(c.concurrency) || c.concurrency < 1)
    throw new Error("Invalid concurrency");
  for (const n of Object.values(c.providerLimits))
    if (!Number.isInteger(n) || Number(n) < 1)
      throw new Error("Provider limits must be positive integers");
  return c;
}
export const saveConfig = (c: Config) =>
  atomicJson(join(configRoot(), "config.json"), c);
