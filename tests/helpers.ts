import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { Library } from "../src/storage";
import type { Adapter } from "../src/providers";
export function fixture() {
  const root = mkdtempSync(join(tmpdir(), "imagegen-test-"));
  const library = new Library(join(root, "images"), join(root, "state"));
  return {
    root,
    library,
    close() {
      library.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const p = new PNG({ width: 16, height: 12 });
p.data.fill(200);
export const png = Buffer.from(PNG.sync.write(p));
export const adapter = (overrides: Partial<Adapter> = {}): Adapter => ({
  prepare: async () => {},
  submit: async () => ({ results: ["mock"] }),
  poll: async () => ({ results: ["mock"] }),
  cancel: async () => {},
  download: async () => png,
  ...overrides,
});
