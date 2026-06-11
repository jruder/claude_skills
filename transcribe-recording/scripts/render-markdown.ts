#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

interface Word {
  text?: string;
  startMs: number;
  speaker: string;
}

interface TranscriptDoc {
  source: string;
  generatedAt: string;
  model: string;
  durationMs: number;
  words: Word[];
  aliases?: Record<string, string>;
  regenerateCommand?: string;
}

const args = parseArgs(process.argv.slice(2));
const doc = JSON.parse(readFileSync(args.input, "utf8")) as TranscriptDoc;
const aliases = doc.aliases ?? {};
const turns = coalesceTurns(doc.words, aliases);
const speakers = Array.from(new Set(turns.map((turn) => turn.speaker))).join(", ");

const lines: string[] = [];
lines.push(`# Transcript - ${path.basename(doc.source)}`);
lines.push("");
lines.push(`- Source: ${doc.source}`);
lines.push(`- Generated: ${doc.generatedAt}`);
lines.push(`- Model: ${doc.model}`);
lines.push(`- Duration: ${formatDuration(doc.durationMs)}`);
if (speakers) lines.push(`- Speakers: ${speakers}`);
if (doc.regenerateCommand) lines.push(`- Regenerate: \`${doc.regenerateCommand.replace(/`/g, "\\`")}\``);
lines.push("");
lines.push("## Transcript");
lines.push("");

for (const turn of turns) {
  lines.push(`**[${formatDuration(turn.startMs)}] ${turn.speaker}:** ${turn.parts.join(" ")}`);
  lines.push("");
}

writeFileSync(args.outMd, lines.join("\n"));
console.log(args.outMd);

function parseArgs(argv: string[]): { input: string; outMd: string } {
  let input = "";
  let outMd = "";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out-md") outMd = requireValue(argv, ++i, arg);
    else if (arg === "-h" || arg === "--help") {
      console.log("Usage: bun scripts/render-markdown.ts <transcript.json> [--out-md path]");
      process.exit(0);
    } else if (!input) input = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (!input) throw new Error("Missing transcript JSON path");
  if (!outMd) outMd = input.replace(/\.json$/i, ".md");
  return { input, outMd };
}

function coalesceTurns(words: Word[], aliases: Record<string, string>) {
  const turns: Array<{ speaker: string; startMs: number; parts: string[] }> = [];
  let current: { speaker: string; startMs: number; parts: string[] } | null = null;
  for (const word of words ?? []) {
    const text = String(word.text ?? "").trim().replace(/\s+/g, " ");
    if (!text) continue;
    const speaker = aliases[word.speaker] || word.speaker;
    if (!current || current.speaker !== speaker) {
      if (current) turns.push(current);
      current = { speaker, startMs: word.startMs, parts: [text] };
    } else {
      current.parts.push(text);
    }
  }
  if (current) turns.push(current);
  return turns;
}

function formatDuration(ms: number): string {
  let totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  totalSec -= h * 3600;
  const m = Math.floor(totalSec / 60);
  const s = totalSec - m * 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined) throw new Error(`${flag} requires a value`);
  return value;
}

