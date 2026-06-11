#!/usr/bin/env bun
/**
 * Standalone Mistral batch transcriber with diarization.
 *
 * Uses POST https://api.mistral.ai/v1/audio/transcriptions (Voxtral).
 *
 * Usage:
 *   bun --env-file=<skill>/scripts/.env <skill>/scripts/transcribe-mistral.ts <audio-or-video-file> [options]
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

interface Args {
  input: string;
  outJson: string;
  outHtml: string;
  chunkSeconds: number | null;  // null = single-pass
  language: string;
  diarize: boolean;
  keepAudio: boolean;
  mistralUrl: string;
  model: string;
  bitrateKbps: number;
  renames: Map<string, string>;
  rerenderFromJson: string | null;
}

interface MistralWord {
  text?: string;
  word?: string;
  start?: number;
  end?: number;
  confidence?: number;
  speaker?: number | string;
  speaker_id?: number | string;
}

interface MistralSegment {
  id?: string | number;
  segment_id?: string | number;
  text?: string;
  start?: number;
  end?: number;
  words?: MistralWord[];
  speaker?: number | string;
  speaker_id?: number | string;
}

interface MistralResponse {
  model?: string;
  text?: string;
  duration?: number;
  language?: string;
  words?: MistralWord[];
  segments?: MistralSegment[];
  usage?: Record<string, unknown>;
  [key: string]: unknown;
}

interface NormalizedWord {
  text: string;
  startMs: number;
  endMs: number;
  confidence: number | null;
  speaker: string;
  channelIndex: number | null;
  chunkIndex: number;
}

interface TranscriptDoc {
  source: string;
  generatedAt: string;
  model: string;
  language: string;
  diarize: boolean;
  durationMs: number;
  chunkSeconds: number;
  chunks: Array<{
    index: number;
    startOffsetMs: number;
    durationMs: number;
    text: string;
    raw: MistralResponse;
  }>;
  words: NormalizedWord[];
  fullText: string;
  speakers: string[];
  aliases?: Record<string, string>;
  regenerateCommand?: string;
}

const SAMPLE_RATE = 16_000;
const CHANNELS = 1;
const REQUEST_TIMEOUT_MS = 20 * 60_000;

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.rerenderFromJson) {
    const existing = JSON.parse(await readFile(args.rerenderFromJson, "utf8")) as TranscriptDoc;
    const aliases: Record<string, string> = { ...(existing.aliases ?? {}) };
    for (const [raw, name] of args.renames) aliases[raw] = name;
    existing.aliases = aliases;
    existing.regenerateCommand = buildRegenerateCommand(args, existing.source);
    await writeFile(args.outJson, JSON.stringify(existing, null, 2));
    console.log(`Rewrote JSON → ${args.outJson}`);
    await writeFile(args.outHtml, renderHtmlViewer(existing));
    console.log(`Wrote HTML → ${args.outHtml}`);
    console.log(`Open in browser:  file://${path.resolve(args.outHtml)}`);
    return;
  }

  const apiKey = firstNonEmpty(process.env.ARGONEX_MISTRAL_API_KEY, process.env.MISTRAL_API_KEY);
  if (!apiKey) {
    throw new Error("Set ARGONEX_MISTRAL_API_KEY or MISTRAL_API_KEY before running.");
  }

  const inputStat = await stat(args.input);
  if (!inputStat.isFile()) throw new Error(`Not a file: ${args.input}`);

  const totalDurationSec = await probeDurationSeconds(args.input);
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "mistral-stt-"));
  const doc: TranscriptDoc = {
    source: path.resolve(args.input),
    generatedAt: new Date().toISOString(),
    model: `mistral:${args.model}`,
    language: args.language,
    diarize: args.diarize,
    durationMs: 0,
    chunkSeconds: args.chunkSeconds ?? Math.ceil(totalDurationSec),
    chunks: [],
    words: [],
    fullText: "",
    speakers: [],
    aliases: args.renames.size > 0 ? Object.fromEntries(args.renames) : undefined,
    regenerateCommand: buildRegenerateCommand(args, path.resolve(args.input)),
  };

  console.log(`Input: ${args.input}`);
  console.log(`Duration: ${formatDuration(totalDurationSec * 1000)}`);
  console.log(`Model: ${args.model} · Diarize: ${args.diarize} · Language: ${args.language}`);

  try {
    if (args.chunkSeconds === null) {
      console.log(`Mode: single-pass (Opus ${args.bitrateKbps}kbps mono)`);
      const oggPath = path.join(tmpRoot, "audio.ogg");
      console.log(`\nEncoding audio → ${oggPath}`);
      await encodeOpus(args.input, oggPath, args.bitrateKbps);
      const oggStat = await stat(oggPath);
      console.log(`  size: ${(oggStat.size / 1_048_576).toFixed(2)} MiB`);
      console.log(`  uploading to Mistral…`);
      const t0 = Date.now();
      const parsed = await callMistralStt({
        audioPath: oggPath,
        contentType: "audio/ogg",
        apiKey,
        language: args.language,
        diarize: args.diarize,
        mistralUrl: args.mistralUrl,
        model: args.model,
      });
      const wordCount = countWords(parsed);
      const speakerCount = countSpeakers(parsed);
      console.log(`  done in ${((Date.now() - t0) / 1000).toFixed(1)}s — words: ${wordCount}, speakers: ${speakerCount}, response duration: ${parsed.duration ?? "?"}s`);
      if (args.diarize && wordCount > 0 && speakerCount === 0) {
        console.log(`  ⚠ no per-word speaker labels — Mistral model may not have returned diarization`);
      }
      doc.chunks.push({
        index: 0,
        startOffsetMs: 0,
        durationMs: Math.round(totalDurationSec * 1000),
        text: (parsed.text ?? "").trim(),
        raw: parsed,
      });
      doc.words.push(...normalizeWords(parsed, 0, 0, /*singlePass*/ true));
      if (!args.keepAudio) await rm(oggPath, { force: true });
    } else {
      const chunkCount = Math.max(1, Math.ceil(totalDurationSec / args.chunkSeconds));
      console.log(`Mode: chunked (${chunkCount} chunks of up to ${args.chunkSeconds}s)`);
      for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
        const startOffsetSec = chunkIndex * args.chunkSeconds;
        const remainingSec = Math.max(0, totalDurationSec - startOffsetSec);
        const chunkSec = Math.min(args.chunkSeconds, remainingSec);
        if (chunkSec <= 0) break;
        const wavPath = path.join(tmpRoot, `chunk-${String(chunkIndex).padStart(4, "0")}.wav`);
        console.log(`\n[${chunkIndex + 1}/${chunkCount}] Extracting ${formatDuration(startOffsetSec * 1000)} → ${formatDuration((startOffsetSec + chunkSec) * 1000)}`);
        await extractWavChunk(args.input, wavPath, startOffsetSec, chunkSec);
        const wavStat = await stat(wavPath);
        console.log(`  wav size: ${(wavStat.size / 1_048_576).toFixed(1)} MiB`);
        const parsed = await callMistralStt({
          audioPath: wavPath,
          contentType: "audio/wav",
          apiKey,
          language: args.language,
          diarize: args.diarize,
          mistralUrl: args.mistralUrl,
          model: args.model,
        });
        const wordCount = countWords(parsed);
        const speakerCount = countSpeakers(parsed);
        console.log(`  text length: ${(parsed.text ?? "").length}, words: ${wordCount}, speakers: ${speakerCount}, response duration: ${parsed.duration ?? "?"}s`);
        if (args.diarize && wordCount > 0 && speakerCount === 0) {
          console.log(`  ⚠ no per-word speaker labels — Mistral model may not have returned diarization`);
        }
        const offsetMs = Math.round(startOffsetSec * 1000);
        const chunkDurationMs = Math.round(chunkSec * 1000);
        doc.chunks.push({
          index: chunkIndex,
          startOffsetMs: offsetMs,
          durationMs: chunkDurationMs,
          text: (parsed.text ?? "").trim(),
          raw: parsed,
        });
        doc.words.push(...normalizeWords(parsed, chunkIndex, offsetMs));
        if (!args.keepAudio) await rm(wavPath, { force: true });
      }
    }
  } finally {
    if (!args.keepAudio) await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
    else console.log(`\nKept temp audio in ${tmpRoot}`);
  }

  doc.durationMs = doc.words.reduce((max, word) => Math.max(max, word.endMs), 0);
  doc.fullText = doc.chunks.map((chunk) => chunk.text).filter(Boolean).join("\n\n");
  doc.speakers = Array.from(new Set(doc.words.map((word) => word.speaker))).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  await writeFile(args.outJson, JSON.stringify(doc, null, 2));
  console.log(`\nWrote JSON → ${args.outJson}`);
  await writeFile(args.outHtml, renderHtmlViewer(doc));
  console.log(`Wrote HTML → ${args.outHtml}`);
  console.log(`Open in browser:  file://${path.resolve(args.outHtml)}`);
}

function parseArgs(argv: string[]): Args {
  let input: string | null = null;
  let outJson: string | null = null;
  let outHtml: string | null = null;
  let chunkSeconds: number | null = null;  // null = single-pass
  let language = "en";
  let diarize = true;
  let keepAudio = false;
  let mistralUrl = process.env.ARGONEX_MISTRAL_REST_URL ?? "https://api.mistral.ai/v1/audio/transcriptions";
  let model = process.env.ARGONEX_MISTRAL_BATCH_MODEL ?? "voxtral-mini-latest";
  let bitrateKbps = 32;
  const renames = new Map<string, string>();
  let rerenderFromJson: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out-json") outJson = requireValue(argv, ++i, arg);
    else if (arg === "--out-html") outHtml = requireValue(argv, ++i, arg);
    else if (arg === "--chunk-seconds") chunkSeconds = Number(requireValue(argv, ++i, arg));
    else if (arg === "--language") language = requireValue(argv, ++i, arg);
    else if (arg === "--no-diarize") diarize = false;
    else if (arg === "--keep-audio" || arg === "--keep-wav") keepAudio = true;
    else if (arg === "--mistral-url") mistralUrl = requireValue(argv, ++i, arg);
    else if (arg === "--model") model = requireValue(argv, ++i, arg);
    else if (arg === "--bitrate-kbps") bitrateKbps = Number(requireValue(argv, ++i, arg));
    else if (arg === "--rename") {
      const value = requireValue(argv, ++i, arg);
      const eq = value.indexOf("=");
      if (eq <= 0) throw new Error(`--rename expects raw=display, got: ${value}`);
      renames.set(value.slice(0, eq).trim(), value.slice(eq + 1).trim());
    }
    else if (arg === "--rerender-from-json") rerenderFromJson = requireValue(argv, ++i, arg);
    else if (arg === "-h" || arg === "--help") { printHelp(); process.exit(0); }
    else if (arg.startsWith("--")) throw new Error(`Unknown flag: ${arg}`);
    else if (!input) input = arg;
    else throw new Error(`Unexpected positional argument: ${arg}`);
  }
  if (!input && !rerenderFromJson) { printHelp(); throw new Error("Missing input file (or --rerender-from-json)."); }
  if (!input && rerenderFromJson) input = rerenderFromJson;
  if (chunkSeconds !== null && (!Number.isFinite(chunkSeconds) || chunkSeconds < 5)) throw new Error("--chunk-seconds must be >= 5");
  if (!Number.isFinite(bitrateKbps) || bitrateKbps < 8) throw new Error("--bitrate-kbps must be >= 8");
  const baseDir = path.dirname(path.resolve(input));
  const baseName = path.basename(input, path.extname(input));
  return {
    input,
    outJson: outJson ?? path.join(baseDir, `${baseName}.transcript.json`),
    outHtml: outHtml ?? path.join(baseDir, `${baseName}.transcript.html`),
    chunkSeconds,
    language,
    diarize,
    keepAudio,
    mistralUrl,
    model,
    bitrateKbps,
    renames,
    rerenderFromJson,
  };
}

function buildRegenerateCommand(args: Args, sourcePath: string): string {
  const tool = path.resolve(process.argv[1] ?? "scripts/transcribe-mistral.ts");
  const envFile = path.join(path.dirname(tool), ".env");
  const parts: string[] = ["bun", `--env-file=${shellQuote(envFile)}`, shellQuote(tool), shellQuote(sourcePath)];
  if (args.outJson) parts.push("--out-json", shellQuote(args.outJson));
  if (args.outHtml) parts.push("--out-html", shellQuote(args.outHtml));
  if (args.chunkSeconds !== null) parts.push("--chunk-seconds", String(args.chunkSeconds));
  if (args.bitrateKbps !== 32) parts.push("--bitrate-kbps", String(args.bitrateKbps));
  if (args.language !== "en") parts.push("--language", args.language);
  if (!args.diarize) parts.push("--no-diarize");
  if (args.model !== "voxtral-mini-latest") parts.push("--model", args.model);
  for (const [raw, name] of args.renames) parts.push("--rename", shellQuote(`${raw}=${name}`));
  return parts.join(" ");
}

function shellQuote(value: string): string {
  if (/^[\w./@:=+-]+$/.test(value)) return value;
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

function printHelp(): void {
  console.log(`Usage: bun --env-file=<skill>/scripts/.env <skill>/scripts/transcribe-mistral.ts <input> [options]
  --out-json <path>       Output JSON path
  --out-html <path>       Output HTML viewer path
  --chunk-seconds <n>     Enable chunked mode (default: single-pass with Opus)
  --bitrate-kbps <n>      Opus bitrate for single-pass (default 32)
  --language <code>       Language hint (default en)
  --no-diarize            Disable diarization
  --keep-audio            Keep extracted audio for debugging
  --model <name>          Mistral model (default voxtral-mini-latest)
  --mistral-url <url>     Override Mistral transcriptions URL
  --rename raw=display    Preset a speaker display name (repeatable)
  --rerender-from-json <path>  Skip API; rebuild HTML from existing JSON`);
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined) throw new Error(`${flag} requires a value`);
  return value;
}

async function probeDurationSeconds(input: string): Promise<number> {
  const stdout = await runCapture("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    input,
  ]);
  const value = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Could not determine duration for ${input}`);
  return value;
}

async function extractWavChunk(input: string, output: string, startSec: number, durationSec: number): Promise<void> {
  await runCapture("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-ss", startSec.toFixed(3),
    "-t", durationSec.toFixed(3),
    "-i", input,
    "-vn",
    "-ac", String(CHANNELS),
    "-ar", String(SAMPLE_RATE),
    "-acodec", "pcm_s16le",
    output,
  ]);
}

async function encodeOpus(input: string, output: string, bitrateKbps: number): Promise<void> {
  await runCapture("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", input,
    "-vn",
    "-ac", "1",
    "-ar", "16000",
    "-c:a", "libopus",
    "-b:a", `${bitrateKbps}k`,
    "-application", "voip",
    output,
  ]);
}

async function callMistralStt(opts: {
  audioPath: string;
  contentType: string;
  apiKey: string;
  language: string;
  diarize: boolean;
  mistralUrl: string;
  model: string;
}): Promise<MistralResponse> {
  const audioBytes = await readFile(opts.audioPath);
  const maxAttempts = 4;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const formData = new FormData();
    formData.append("model", opts.model);
    // Mistral rejects multiple granularities, and with diarize=true requires "segment".
    formData.append("timestamp_granularities", opts.diarize ? "segment" : "word");
    if (opts.language) formData.append("language", opts.language);
    if (opts.diarize) formData.append("diarize", "true");
    formData.append("file", new Blob([new Uint8Array(audioBytes)], { type: opts.contentType }), path.basename(opts.audioPath));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(opts.mistralUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${opts.apiKey}` },
        body: formData,
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`Mistral transcription HTTP ${response.status}: ${text.slice(0, 800)}`);
      }
      try {
        return JSON.parse(text) as MistralResponse;
      } catch {
        return { text } as MistralResponse;
      }
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const retriable = /timed out|ETIMEDOUT|ECONNRESET|fetch failed|aborted|HTTP 5/i.test(message);
      if (!retriable || attempt === maxAttempts) throw error;
      const backoffSec = 2 ** attempt;
      console.log(`  ⚠ attempt ${attempt} failed (${message.slice(0, 120)}); retrying in ${backoffSec}s`);
      await new Promise((resolve) => setTimeout(resolve, backoffSec * 1000));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new Error("Mistral transcription failed without an error message");
}

function countWords(parsed: MistralResponse): number {
  let words = 0;
  let segmentsWithoutWords = 0;
  if (Array.isArray(parsed.segments)) {
    for (const seg of parsed.segments) {
      if (Array.isArray(seg.words) && seg.words.length) words += seg.words.length;
      else if ((seg.text ?? "").trim()) segmentsWithoutWords += 1;
    }
  }
  if (words > 0) return words;
  if (segmentsWithoutWords > 0) return segmentsWithoutWords;
  if (Array.isArray(parsed.words)) return parsed.words.length;
  return 0;
}

function countSpeakers(parsed: MistralResponse): number {
  const speakers = new Set<string>();
  const noteSpeaker = (value: number | string | undefined) => {
    if (value !== undefined && value !== null && value !== "") speakers.add(String(value));
  };
  if (Array.isArray(parsed.segments)) {
    for (const seg of parsed.segments) {
      noteSpeaker(seg.speaker ?? seg.speaker_id);
      if (Array.isArray(seg.words)) {
        for (const w of seg.words) noteSpeaker(w.speaker ?? w.speaker_id);
      }
    }
  }
  if (Array.isArray(parsed.words)) {
    for (const w of parsed.words) noteSpeaker(w.speaker ?? w.speaker_id);
  }
  return speakers.size;
}

function normalizeWords(parsed: MistralResponse, chunkIndex: number, offsetMs: number, singlePass = false): NormalizedWord[] {
  const out: NormalizedWord[] = [];
  const pushWord = (word: MistralWord, fallbackSpeaker: number | string | undefined) => {
    const text = (word.text ?? word.word ?? "").trim();
    if (!text) return;
    const startMs = offsetMs + Math.round((word.start ?? 0) * 1000);
    const endMs = offsetMs + Math.round((word.end ?? word.start ?? 0) * 1000);
    const speakerValue = word.speaker ?? word.speaker_id ?? fallbackSpeaker;
    const speakerLabel = labelSpeaker(speakerValue, chunkIndex, null, singlePass);
    out.push({
      text,
      startMs,
      endMs,
      confidence: typeof word.confidence === "number" ? word.confidence : null,
      speaker: speakerLabel,
      channelIndex: null,
      chunkIndex,
    });
  };

  if (Array.isArray(parsed.segments) && parsed.segments.length > 0) {
    for (const seg of parsed.segments) {
      const segSpeaker = seg.speaker ?? seg.speaker_id;
      if (Array.isArray(seg.words) && seg.words.length > 0) {
        for (const word of seg.words) pushWord(word, segSpeaker);
      } else {
        // Segment without word-level timestamps: emit one "word" per segment using its text+start/end
        const text = (seg.text ?? "").trim();
        if (!text) continue;
        pushWord({ text, start: seg.start, end: seg.end }, segSpeaker);
      }
    }
  } else if (Array.isArray(parsed.words)) {
    for (const word of parsed.words) pushWord(word, undefined);
  }

  out.sort((a, b) => a.startMs - b.startMs);
  return out;
}

function labelSpeaker(speaker: number | string | undefined, chunkIndex: number, channelIndex: number | null, singlePass: boolean): string {
  if (speaker === undefined || speaker === null || speaker === "") {
    if (channelIndex !== null) return `ch${channelIndex}`;
    return singlePass ? "unknown" : `chunk${chunkIndex}`;
  }
  const base = typeof speaker === "number" ? `S${speaker}` : String(speaker);
  return singlePass ? base : `c${chunkIndex}-${base}`;
}

async function runCapture(command: string, args: string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data.toString(); });
    child.stderr.on("data", (data) => { stderr += data.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited ${code}: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function renderHtmlViewer(doc: TranscriptDoc): string {
  const json = JSON.stringify(doc).replace(/</g, "\\u003c").replace(/-->/g, "--\\u003e");
  const sourceName = path.basename(doc.source);
  const cmd = (doc.regenerateCommand ?? "").replaceAll("-->", "--\\>");
  const header = doc.regenerateCommand
    ? `<!--\n  Source:    ${doc.source}\n  Generated: ${doc.generatedAt}\n\n  To regenerate this transcript:\n    ${cmd}\n-->\n`
    : "";
  return `${header}<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Transcript — ${escapeHtml(sourceName)}</title>
<style>
  :root {
    --bg: #0f1117;
    --panel: #171a23;
    --panel-2: #1f2330;
    --text: #e6e8ee;
    --muted: #8a93a6;
    --accent: #6aa9ff;
    --border: #262b3a;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif; }
  header { position: sticky; top: 0; background: rgba(15,17,23,0.92); backdrop-filter: blur(8px); border-bottom: 1px solid var(--border); padding: 14px 20px; z-index: 5; }
  header h1 { margin: 0 0 4px; font-size: 16px; font-weight: 600; }
  header .meta { color: var(--muted); font-size: 12px; }
  main { max-width: 980px; margin: 0 auto; padding: 24px 20px 80px; }
  .toolbar { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin: 0 0 18px; }
  .toolbar input[type="search"] { flex: 1 1 240px; min-width: 180px; padding: 8px 12px; border: 1px solid var(--border); background: var(--panel); color: var(--text); border-radius: 8px; font-size: 14px; }
  .toolbar select, .toolbar button { padding: 8px 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--panel); color: var(--text); font-size: 13px; cursor: pointer; }
  .toolbar button:hover, .toolbar select:hover { background: var(--panel-2); }
  .speakers-panel { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; margin: 0 0 18px; }
  .speakers-panel h2 { margin: 0 0 10px; font-size: 13px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; display: flex; align-items: center; gap: 10px; }
  .speakers-panel h2 .panel-hint { font-weight: 400; color: var(--muted); font-size: 11px; text-transform: none; letter-spacing: 0; }
  .speaker-row { display: flex; align-items: center; gap: 10px; padding: 6px 0; border-bottom: 1px solid var(--border); }
  .speaker-row:last-child { border-bottom: none; }
  .speaker-row .swatch { width: 14px; height: 14px; border-radius: 50%; flex-shrink: 0; }
  .speaker-row .raw-label { color: var(--muted); font-size: 11px; min-width: 56px; font-variant-numeric: tabular-nums; }
  .speaker-row .name-input { flex: 1 1 200px; max-width: 320px; padding: 6px 10px; background: var(--panel-2); border: 1px solid var(--border); color: var(--text); border-radius: 6px; font: inherit; font-size: 14px; font-weight: 600; }
  .speaker-row .name-input:focus { outline: none; border-color: var(--accent); }
  .speaker-row .stat { color: var(--muted); font-size: 12px; min-width: 90px; }
  .speaker-row .visibility { display: flex; align-items: center; gap: 4px; font-size: 12px; color: var(--muted); cursor: pointer; user-select: none; }
  .speaker-row .visibility input { margin: 0; }
  .speaker-row.muted .name-input, .speaker-row.muted .stat { opacity: 0.5; }
  .turn { display: grid; grid-template-columns: 90px 110px 1fr; gap: 12px; padding: 10px 12px; border-radius: 10px; margin: 0 0 6px; align-items: start; }
  .turn:hover { background: var(--panel); }
  .turn .timestamp { color: var(--muted); font-variant-numeric: tabular-nums; font-size: 12px; padding-top: 2px; }
  .turn .speaker { font-size: 12px; font-weight: 600; padding-top: 2px; word-break: break-word; }
  .turn .text { font-size: 15px; }
  .turn mark { background: rgba(255, 217, 0, 0.35); color: inherit; border-radius: 3px; padding: 0 2px; }
  .turn.hidden { display: none; }
  footer { color: var(--muted); font-size: 12px; max-width: 980px; margin: 16px auto 0; padding: 0 20px 30px; }
  .empty { color: var(--muted); padding: 30px 0; text-align: center; }
  .stats { display: flex; gap: 14px; flex-wrap: wrap; color: var(--muted); font-size: 12px; }
  details.raw { margin-top: 30px; }
  details.raw summary { cursor: pointer; color: var(--muted); }
  details.raw pre { background: var(--panel); padding: 12px; border-radius: 8px; overflow: auto; max-height: 400px; font-size: 11px; }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(sourceName)}</h1>
  <div class="meta">
    Duration: <span id="meta-duration"></span> •
    Generated: <span id="meta-generated"></span> •
    Model: <span id="meta-model"></span> •
    Language: <span id="meta-language"></span>
  </div>
</header>
<main>
  <div class="toolbar">
    <input id="search" type="search" placeholder="Search transcript…" />
    <select id="gap-select" title="Coalesce gap (seconds)">
      <option value="1.5">Gap ≤ 1.5s</option>
      <option value="3" selected>Gap ≤ 3s</option>
      <option value="6">Gap ≤ 6s</option>
      <option value="999">No gap split</option>
    </select>
    <button id="copy-text" type="button">Copy plain text</button>
    <button id="download-json" type="button">Download JSON</button>
  </div>
  <section class="speakers-panel">
    <h2>Speakers <span class="panel-hint">edit names below · same name merges speakers · names persist in this browser</span></h2>
    <div id="speaker-rows"></div>
  </section>
  <div class="stats" id="stats"></div>
  <div id="turns"></div>
  <div class="empty" id="empty" hidden>No matches.</div>
  <details class="raw">
    <summary>Raw chunk responses (debug)</summary>
    <pre id="raw"></pre>
  </details>
</main>
<footer>
  <div>Generated by <code>devtools/transcribe-mistral.ts</code> · self-contained, opens with <code>file://</code></div>
</footer>
<script id="transcript-data" type="application/json">${json}</script>
<script>
(function() {
  const data = JSON.parse(document.getElementById("transcript-data").textContent);
  const palette = ["#6aa9ff","#ffb86c","#7ee787","#ff7b9c","#c39bff","#ffd866","#5ad1ff","#f08bf2","#9ece6a","#ff9e64","#7dcfff","#bb9af7","#e0af68","#73daca","#f7768e"];
  const storageKey = "stt-aliases::" + (data.source || "transcript");

  // alias: rawSpeaker -> displayName (defaults to rawSpeaker)
  const aliases = loadAliases();
  // displayVisible: displayName -> boolean
  const displayVisible = new Map();

  document.getElementById("meta-duration").textContent = formatDur(data.durationMs);
  document.getElementById("meta-generated").textContent = new Date(data.generatedAt).toLocaleString();
  document.getElementById("meta-model").textContent = data.model;
  document.getElementById("meta-language").textContent = data.language;

  document.getElementById("copy-text").addEventListener("click", () => {
    const text = currentTurns().map((t) => "[" + formatDur(t.startMs) + "] " + displayName(t.speaker) + ": " + t.text).join("\\n\\n");
    navigator.clipboard.writeText(text).then(() => {
      const btn = document.getElementById("copy-text");
      const prev = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(() => { btn.textContent = prev; }, 1200);
    });
  });

  document.getElementById("download-json").addEventListener("click", () => {
    const out = JSON.parse(JSON.stringify(data));
    out.aliases = Object.fromEntries(aliases);
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = (data.source.split("/").pop() || "transcript") + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  document.getElementById("raw").textContent = JSON.stringify(data.chunks.map((c) => ({ index: c.index, startOffsetMs: c.startOffsetMs, durationMs: c.durationMs, raw: c.raw })), null, 2);

  const search = document.getElementById("search");
  search.addEventListener("input", render);
  document.getElementById("gap-select").addEventListener("change", () => { cachedGap = null; render(); });

  let cachedTurns = null;
  let cachedGap = null;

  function loadAliases() {
    const map = new Map();
    // 1. Defaults shipped in the JSON (via --rename)
    if (data.aliases && typeof data.aliases === "object") {
      for (const [k, v] of Object.entries(data.aliases)) map.set(k, String(v));
    }
    // 2. localStorage overrides
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        for (const [k, v] of Object.entries(parsed)) map.set(k, String(v));
      }
    } catch {}
    // 3. Fall back to raw label for any speaker not yet named
    for (const sp of data.speakers) {
      if (!map.has(sp)) map.set(sp, sp);
    }
    return map;
  }

  function saveAliases() {
    try { localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(aliases))); } catch {}
  }

  function displayName(rawSpeaker) {
    return aliases.get(rawSpeaker) || rawSpeaker;
  }

  function colorFor(displayName) {
    const names = uniqueDisplayNames();
    const idx = names.indexOf(displayName);
    return palette[(idx >= 0 ? idx : 0) % palette.length];
  }

  function uniqueDisplayNames() {
    const seen = [];
    for (const sp of data.speakers) {
      const name = displayName(sp);
      if (!seen.includes(name)) seen.push(name);
    }
    return seen;
  }

  function buildLegend() {
    const container = document.getElementById("speaker-rows");
    container.innerHTML = "";

    const wordCounts = new Map();
    const durationMs = new Map();
    for (const w of data.words) {
      wordCounts.set(w.speaker, (wordCounts.get(w.speaker) || 0) + 1);
      durationMs.set(w.speaker, (durationMs.get(w.speaker) || 0) + Math.max(0, (w.endMs || w.startMs) - w.startMs));
    }

    for (const sp of data.speakers) {
      const name = displayName(sp);
      if (!displayVisible.has(name)) displayVisible.set(name, true);
      const row = document.createElement("div");
      row.className = "speaker-row";
      if (!displayVisible.get(name)) row.classList.add("muted");

      const swatch = document.createElement("span");
      swatch.className = "swatch";
      swatch.style.background = colorFor(name);

      const rawLabel = document.createElement("span");
      rawLabel.className = "raw-label";
      rawLabel.textContent = sp;

      const input = document.createElement("input");
      input.type = "text";
      input.className = "name-input";
      input.value = name;
      input.placeholder = sp;
      input.spellcheck = false;
      input.setAttribute("aria-label", "Display name for " + sp);

      const commit = () => {
        const next = input.value.trim();
        const newName = next || sp;
        if (newName === aliases.get(sp)) return;
        const oldName = displayName(sp);
        aliases.set(sp, newName);
        saveAliases();
        // carry visibility from old name to new name if needed
        if (!displayVisible.has(newName) && displayVisible.has(oldName)) {
          displayVisible.set(newName, displayVisible.get(oldName));
        }
        render();
      };
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") { ev.preventDefault(); input.blur(); }
        if (ev.key === "Escape") { input.value = displayName(sp); input.blur(); }
      });
      input.addEventListener("blur", commit);

      const stat = document.createElement("span");
      stat.className = "stat";
      const wc = wordCounts.get(sp) || 0;
      const dur = formatDur(durationMs.get(sp) || 0);
      stat.textContent = wc.toLocaleString() + " words · " + dur;

      const visLabel = document.createElement("label");
      visLabel.className = "visibility";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = displayVisible.get(name) !== false;
      cb.addEventListener("change", () => {
        displayVisible.set(displayName(sp), cb.checked);
        render();
      });
      const visText = document.createElement("span");
      visText.textContent = "show";
      visLabel.appendChild(cb);
      visLabel.appendChild(visText);

      row.appendChild(swatch);
      row.appendChild(rawLabel);
      row.appendChild(input);
      row.appendChild(stat);
      row.appendChild(visLabel);
      container.appendChild(row);
    }
  }

  function buildTurns(maxGapSec) {
    const turns = [];
    let current = null;
    const gapMs = maxGapSec * 1000;
    for (const w of data.words) {
      const dn = displayName(w.speaker);
      if (!current || dn !== displayName(current.rawSpeaker) || (w.startMs - current.endMs) > gapMs) {
        if (current) turns.push(current);
        current = { rawSpeaker: w.speaker, startMs: w.startMs, endMs: w.endMs, words: [w] };
      } else {
        current.words.push(w);
        current.endMs = Math.max(current.endMs, w.endMs);
      }
    }
    if (current) turns.push(current);
    return turns.map((t) => ({
      speaker: t.rawSpeaker,
      startMs: t.startMs,
      endMs: t.endMs,
      text: joinWords(t.words),
      words: t.words,
    }));
  }

  function joinWords(words) {
    return words.map((w) => w.text).join(" ").replace(/\\s+([,.;:!?])/g, "$1").trim();
  }

  function currentTurns() {
    const gap = parseFloat(document.getElementById("gap-select").value);
    if (cachedGap !== gap || cachedTurns === null) {
      cachedTurns = buildTurns(gap);
      cachedGap = gap;
    }
    return cachedTurns;
  }

  function render() {
    cachedTurns = null;
    buildLegend();
    const query = search.value.trim().toLowerCase();
    const container = document.getElementById("turns");
    const empty = document.getElementById("empty");
    container.innerHTML = "";
    let visible = 0;
    let totalWords = 0;
    const turns = currentTurns();
    for (const turn of turns) {
      const dn = displayName(turn.speaker);
      if (!displayVisible.get(dn)) continue;
      const text = turn.text;
      const matches = !query || text.toLowerCase().includes(query);
      if (!matches) continue;
      visible += 1;
      totalWords += turn.words.length;
      const row = document.createElement("div");
      row.className = "turn";
      const ts = document.createElement("div");
      ts.className = "timestamp";
      ts.textContent = formatDur(turn.startMs);
      const spk = document.createElement("div");
      spk.className = "speaker";
      spk.style.color = colorFor(dn);
      spk.textContent = dn;
      const txt = document.createElement("div");
      txt.className = "text";
      txt.innerHTML = highlight(text, query);
      row.appendChild(ts);
      row.appendChild(spk);
      row.appendChild(txt);
      container.appendChild(row);
    }
    empty.hidden = visible !== 0;
    document.getElementById("stats").textContent = visible + " turn" + (visible === 1 ? "" : "s") + " · " + totalWords + " words" + (query ? " · filter: " + JSON.stringify(query) : "");
  }

  function highlight(text, query) {
    const safe = escapeHtml(text);
    if (!query) return safe;
    const re = new RegExp("(" + query.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&") + ")", "gi");
    return safe.replace(re, "<mark>$1</mark>");
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c]));
  }

  function formatDur(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
    return m + ":" + String(s).padStart(2, "0");
  }

  render();
})();
</script>
</body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
