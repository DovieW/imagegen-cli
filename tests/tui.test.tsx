import { join } from "node:path";
import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { createApp } from "../src/tui";
import { Engine } from "../src/jobs";
import { defaults } from "../src/config";
import { fixture, adapter } from "./helpers";
test("keyboard batch builder adds independent rows, selects model/settings, and submits reviewed jobs", async () => {
  const f = fixture(),
    e = new Engine(f.library, adapter(), defaults());
  const oldConfig = process.env.IMAGEGEN_CONFIG_DIR;
  process.env.IMAGEGEN_CONFIG_DIR = join(f.root, "config");
  const App = createApp(f.library, e);
  const setup = await testRender(() => <App />, {
    width: 120,
    height: 40,
    exitOnCtrlC: false,
  });
  try {
    await setup.flush();
    expect(setup.captureCharFrame()).toContain(
      "Your image library starts here",
    );
    setup.mockInput.pressKey("n");
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("Prompt");
    setup.mockInput.pressEscape();
    await Bun.sleep(40);
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("Describe the image");
    setup.mockInput.pressKey("a");
    await setup.flush();
    await setup.mockInput.typeText("Rename batch");
    setup.mockInput.pressEnter();
    await setup.flush();
    setup.mockInput.pressKey("u", { ctrl: true });
    await setup.mockInput.typeText("Fox studies");
    setup.mockInput.pressEnter();
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("Fox studies");
    setup.mockInput.pressKey("r", { ctrl: true });
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("Start 1 generations");
    setup.mockInput.pressEnter();
    await setup.flush();
    await e.idle();
    await setup.flush();
    expect(f.library.images()).toHaveLength(1);
    expect(setup.captureCharFrame()).toContain("completed");
    setup.mockInput.pressKey("p", { ctrl: true });
    await setup.flush();
    await setup.mockInput.typeText("Library");
    setup.mockInput.pressEnter();
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("Fox studies");
    setup.mockInput.pressKey("f");
    await setup.flush();
    expect(f.library.images()[0]!.favorite).toBe(true);
    setup.resize(65, 22);
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("imagegen");
  } finally {
    setup.renderer.destroy();
    await e.close();
    process.env.IMAGEGEN_CONFIG_DIR = oldConfig;
    f.close();
  }
});

test("gallery supports full-screen comparison, zoom, and masked credential entry", async () => {
  const f = fixture(),
    e = new Engine(f.library, adapter(), defaults());
  const oldConfig = process.env.IMAGEGEN_CONFIG_DIR;
  process.env.IMAGEGEN_CONFIG_DIR = join(f.root, "config");
  const entry = f.library.create({
    schemaVersion: 1,
    name: "Comparisons",
    rows: [{ prompt: "first", model: "gpt-image-2.5-flare", count: 2 }],
  });
  const { png } = await import("./helpers");
  for (const j of entry.batch.jobs)
    f.library.saveOutput(entry.dir, entry.batch, j, png, 0);
  const App = createApp(f.library, e);
  const s = await testRender(() => <App />, {
    width: 120,
    height: 40,
    exitOnCtrlC: false,
  });
  const esc = async () => {
    s.mockInput.pressEscape();
    await Bun.sleep(40);
    await s.flush();
  };
  try {
    await s.flush();
    s.mockInput.pressEnter();
    await s.flush();
    await s.mockInput.typeText("Pin");
    s.mockInput.pressEnter();
    await s.flush();
    expect(s.captureCharFrame()).toContain("Pinned");
    s.mockInput.pressKey("right");
    await s.flush();
    s.mockInput.pressKey("=");
    await s.flush();
    expect(s.captureCharFrame()).toContain("1.3×");
    await esc();
    s.mockInput.pressKey("p", { ctrl: true });
    await s.flush();
    await s.mockInput.typeText("Authentication");
    s.mockInput.pressEnter();
    await s.flush();
    s.mockInput.pressEnter();
    await s.flush();
    s.mockInput.pressEnter();
    await s.flush();
    await s.mockInput.typeText("fake-key-for-masking");
    await s.flush();
    expect(s.captureCharFrame()).toContain("•");
    expect(s.captureCharFrame()).not.toContain("fake-key-for-masking");
    await esc();
  } finally {
    s.renderer.destroy();
    await e.close();
    process.env.IMAGEGEN_CONFIG_DIR = oldConfig;
    f.close();
  }
});
