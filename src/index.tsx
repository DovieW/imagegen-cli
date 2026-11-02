#!/usr/bin/env bun
import { HELP, runCli } from "./cli";
import { Library } from "./storage";
import { runTui } from "./tui";
process.umask(0o077);
const args = process.argv.slice(2);
if (["--help", "-h", "help"].includes(args[0] || "")) {
  console.log(HELP);
  process.exit(0);
}
if (["--version", "version"].includes(args[0] || "")) {
  console.log("imagegen 0.1.0");
  process.exit(0);
}
let library: Library | undefined;
try {
  library = new Library();
  if (!args.length) {
    if (!process.stdin.isTTY || !process.stdout.isTTY)
      throw new Error(
        "Interactive workbench needs a terminal. Use imagegen --help",
      );
    library.rebuild();
    await runTui(library);
  } else await runCli(args, library);
} catch (e) {
  console.error(`imagegen: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  library?.close();
}
