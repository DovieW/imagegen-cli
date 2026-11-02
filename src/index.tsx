#!/usr/bin/env bun
import { runCli } from "./cli";
import { Library } from "./storage";
import { runTui } from "./tui";
import { envelope, errorInfo } from "./errors";
process.umask(0o077);
const args = process.argv.slice(2);
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
  const error = errorInfo(e);
  if (args.includes("--json") || args.includes("--jsonl"))
    console.log(
      JSON.stringify({
        ...(args.includes("--jsonl") ? { event: "result" } : {}),
        ...envelope(args[0] || "tui", undefined, error),
      }),
    );
  else console.error(`imagegen: ${error.code}: ${error.message}`);
  process.exitCode = error.exitCode;
} finally {
  library?.close();
}
