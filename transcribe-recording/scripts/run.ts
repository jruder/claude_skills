#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

const scriptDir = path.dirname(path.resolve(process.argv[1] ?? import.meta.path));
const args = parseArgs(process.argv.slice(2));
mkdirSync(args.outDir, { recursive: true });

const sourceBase = args.baseName || path.basename(args.input, path.extname(args.input));
const jsonPath = path.join(args.outDir, `${sourceBase}.transcript.json`);
const htmlPath = path.join(args.outDir, `${sourceBase}.transcript.html`);
const mdPath = path.join(args.outDir, `${sourceBase}.transcript.md`);
const reportPath = path.join(args.outDir, `${sourceBase}.speakers.txt`);

const transcribeArgs = [
  path.join(scriptDir, "transcribe-mistral.ts"),
  args.input,
  "--out-json",
  jsonPath,
  "--out-html",
  htmlPath,
  ...args.passThrough,
];
for (const rename of args.renames) transcribeArgs.push("--rename", rename);

runBun(transcribeArgs, args.envFile);
runBun([path.join(scriptDir, "speaker-report.ts"), jsonPath, "--out-report", reportPath], null);
runBun([path.join(scriptDir, "render-markdown.ts"), jsonPath, "--out-md", mdPath], null);

console.log("");
console.log(`JSON:   ${jsonPath}`);
console.log(`HTML:   ${htmlPath}`);
console.log(`MD:     ${mdPath}`);
console.log(`Report: ${reportPath}`);

function parseArgs(argv: string[]) {
  let input = "";
  let outDir = process.cwd();
  let baseName = "";
  let envFile = path.join(scriptDir, ".env");
  const renames: string[] = [];
  const passThrough: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out-dir") outDir = path.resolve(requireValue(argv, ++i, arg));
    else if (arg === "--basename") baseName = requireValue(argv, ++i, arg);
    else if (arg === "--env-file") envFile = path.resolve(requireValue(argv, ++i, arg));
    else if (arg === "--rename") renames.push(requireValue(argv, ++i, arg));
    else if (arg === "--chunk-seconds" || arg === "--language" || arg === "--model" || arg === "--mistral-url" || arg === "--bitrate-kbps") {
      passThrough.push(arg, requireValue(argv, ++i, arg));
    } else if (arg === "--no-diarize" || arg === "--keep-audio" || arg === "--keep-wav") {
      passThrough.push(arg);
    } else if (arg === "-h" || arg === "--help") {
      console.log(`Usage: bun scripts/run.ts <audio-or-video> [--out-dir dir] [--basename name] [--rename raw=name ...]

Runs transcription, writes HTML/JSON/Markdown, and emits a speaker report for aliasing.`);
      process.exit(0);
    } else if (!input) input = path.resolve(arg);
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (!input) throw new Error("Missing audio/video input path");
  return { input, outDir, baseName, envFile, renames, passThrough };
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

