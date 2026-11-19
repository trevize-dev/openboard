#!/usr/bin/env node
// node:sqlite still prints an ExperimentalWarning on Node 22; it's noise for CLI users.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  if (String(warning instanceof Error ? warning.message : warning).includes("SQLite is an experimental")) return;
  (emitWarning as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

const { main } = await import("./cli.js");

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(err);
    process.exitCode = 1;
  },
);
