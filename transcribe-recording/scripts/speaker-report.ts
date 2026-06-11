#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";

interface Word {
  text?: string;
  startMs: number;
  endMs?: number;
  speaker: string;
}

interface TranscriptDoc {
  source: string;
  durationMs: number;
  speakers?: string[];
  words: Word[];
  aliases?: Record<string, string>;
}

const args = parseArgs(process.argv.slice(2));
const doc = JSON.parse(readFileSync(args.input, "utf8")) as TranscriptDoc;
const aliases = doc.aliases ?? {};
const words = doc.words ?? [];
const speakers = Array.from(new Set(words.map((word) => word.speaker))).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
const wordCounts = new Map<string, number>();
for (const word of words) wordCounts.set(word.speaker, (wordCounts.get(word.speaker) ?? 0) + 1);

const lines: string[] = [];
lines.push(`Source: ${doc.source}`);
lines.push(`Duration: ${formatDuration(doc.durationMs)}`);
lines.push("");
lines.push("Speaker counts:");
for (const speaker of speakers) {
  const count = wordCounts.get(speaker) ?? 0;
  const alias = aliases[speaker] ? ` -> ${aliases[speaker]}` : "";
  lines.push(`- ${speaker}${alias}: ${count}`);
}
lines.push("");

if (Object.keys(aliases).length > 0) {
  lines.push("Counts by display name:");
  for (const group of displayGroups(speakers, aliases, wordCounts)) {
    const raw = group.speakers.join(", ");
    lines.push(`- ${group.name}: ${group.count} (${raw})`);
  }
  lines.push("");
}

lines.push("Opening turns:");
for (const turn of coalesceTurns(words).slice(0, args.turns)) {
  lines.push(`[${formatDuration(turn.startMs)}] ${turn.speaker}${aliasSuffix(turn.speaker)}: ${clip(turn.parts.join(" "), args.width)}`);
}
lines.push("");

lines.push("Samples by raw speaker:");
for (const speaker of speakers) {
  lines.push("");
  lines.push(`## ${speaker}${aliasSuffix(speaker)}`);
  let shown = 0;
  for (const turn of coalesceTurns(words)) {
    if (turn.speaker !== speaker) continue;
    lines.push(`[${formatDuration(turn.startMs)}] ${clip(turn.parts.join(" "), args.width)}`);
    shown += 1;
    if (shown >= args.samples) break;
  }
}

const output = lines.join("\n") + "\n";
if (args.outReport) {
  writeFileSync(args.outReport, output);
  console.log(args.outReport);
} else {
  process.stdout.write(output);
}

function parseArgs(argv: string[]) {
  let input = "";
  let outReport = "";
  let turns = 80;
  let samples = 12;
  let width = 220;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out-report") outReport = requireValue(argv, ++i, arg);
    else if (arg === "--turns") turns = Number(requireValue(argv, ++i, arg));
    else if (arg === "--samples") samples = Number(requireValue(argv, ++i, arg));
    else if (arg === "--width") width = Number(requireValue(argv, ++i, arg));
    else if (arg === "-h" || arg === "--help") {
      console.log("Usage: bun scripts/speaker-report.ts <transcript.json> [--out-report path] [--turns n] [--samples n]");
      process.exit(0);
    } else if (!input) input = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (!input) throw new Error("Missing transcript JSON path");
  return { input, outReport, turns, samples, width };
}

function coalesceTurns(words: Word[]) {
  const turns: Array<{ speaker: string; startMs: number; parts: string[] }> = [];
  let current: { speaker: string; startMs: number; parts: string[] } | null = null;
  for (const word of words) {
    const text = String(word.text ?? "").trim().replace(/\s+/g, " ");
    if (!text) continue;
    if (!current || current.speaker !== word.speaker) {
      if (current) turns.push(current);
      current = { speaker: word.speaker, startMs: word.startMs, parts: [text] };
    } else {
      current.parts.push(text);
    }
  }
  if (current) turns.push(current);
  return turns;
}

function aliasSuffix(speaker: string): string {
  return aliases[speaker] ? ` -> ${aliases[speaker]}` : "";
}

function displayGroups(speakers: string[], aliases: Record<string, string>, wordCounts: Map<string, number>) {
  const groups: Array<{ name: string; speakers: string[]; count: number }> = [];
  const byName = new Map<string, { name: string; speakers: string[]; count: number }>();
  for (const speaker of speakers) {
    const name = aliases[speaker] || speaker;
    let group = byName.get(name);
    if (!group) {
      group = { name, speakers: [], count: 0 };
      byName.set(name, group);
      groups.push(group);
    }
    group.speakers.push(speaker);
    group.count += wordCounts.get(speaker) ?? 0;
  }
  return groups;
}

function clip(text: string, width: number): string {
  if (text.length <= width) return text;
  return `${text.slice(0, Math.max(0, width - 1))}...`;
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
