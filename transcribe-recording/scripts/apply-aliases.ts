#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import path from "node:path";

const scriptDir = path.dirname(path.resolve(process.argv[1] ?? import.meta.path));
const args = parseArgs(process.argv.slice(2));

const htmlPath = args.outHtml || args.input.replace(/\.json$/i, ".html");
const mdPath = args.outMd || args.input.replace(/\.json$/i, ".md");

const transcribeArgs = [
  path.join(scriptDir, "transcribe-mistral.ts"),
  "--rerender-from-json",
  args.input,
  "--out-json",
  args.input,
  "--out-html",
  htmlPath,
];
for (const rename of args.renames) transcribeArgs.push("--rename", rename);

runBun(transcribeArgs, args.envFile);
runBun([path.join(scriptDir, "render-markdown.ts"), args.input, "--out-md", mdPath], null);
runBun([path.join(scriptDir, "speaker-report.ts"), args.input, "--out-report", args.input.replace(/\.json$/i, ".speakers.txt")], null);

console.log("");
console.log(`HTML: ${htmlPath}`);
console.log(`MD:   ${mdPath}`);

function parseArgs(argv: string[]) {
  let input = "";
  let outHtml = "";
  let outMd = "";
  let envFile = path.join(scriptDir, ".env");
  const renames: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out-html") outHtml = path.resolve(requireValue(argv, ++i, arg));
    else if (arg === "--out-md") outMd = path.resolve(requireValue(argv, ++i, arg));
    else if (arg === "--env-file") envFile = path.resolve(requireValue(argv, ++i, arg));
    else if (arg === "--rename") renames.push(requireValue(argv, ++i, arg));
    else if (arg === "-h" || arg === "--help") {
      console.log("Usage: bun scripts/apply-aliases.ts <transcript.json> --rename raw=name [--rename raw=name ...]");
      process.exit(0);
    } else if (!input) input = path.resolve(arg);
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (!input) throw new Error("Missing transcript JSON path");
  if (renames.length === 0) throw new Error("Provide at least one --rename raw=name");
  return { input, outHtml, outMd, envFile, renames };
}

function runBun(args: string[], envFile: string | null): void {
  const bunArgs = envFile ? [`--env-file=${envFile}`, ...args] : args;
  const result = spawnSync("bun", bunArgs, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined) throw new Error(`${flag} requires a value`);
  return value;
}

