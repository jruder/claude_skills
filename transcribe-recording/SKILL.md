---
name: transcribe-recording
description: Transcribe local audio or video recordings into self-contained HTML, JSON, and Markdown using Mistral/Voxtral diarization, then assign human speaker names after inspecting raw speaker IDs. Use when the user asks to transcribe call recordings, meeting recordings, MP4/M4A/MP3/WAV/WebM files, generate transcript HTML/Markdown, archive call logs, or map diarized speakers to names such as Josh, Dave, James, Sean, etc.
---

# Transcribe Recording

Use the bundled Bun scripts to transcribe local recordings with Mistral/Voxtral, produce HTML/JSON/Markdown artifacts, and rerender aliases after manually mapping diarized speaker IDs.

## Setup

Use the skill directory as `<skill-path>`. The scripts expect:

- `bun`
- `ffmpeg` and `ffprobe`
- `<skill-path>/scripts/.env` with `MISTRAL_API_KEY` or `ARGONEX_MISTRAL_API_KEY`

The local `.env` is intentionally gitignored. Do not print its contents. If missing, create it from `.env.example` and ask the user for a Mistral key only if no key is available elsewhere.

## Workflow

1. Locate the recording if the user gives only a filename.
2. Choose an output directory from the request. If unspecified for an ad hoc transcript, prefer `/tmp`; if the user is archiving a project call, use that project’s archive folder.
3. Run a first pass without aliases:

```bash
bun --env-file <skill-path>/scripts/.env <skill-path>/scripts/run.ts "<recording>" --out-dir "<output-dir>"
```

This writes:

- `<basename>.transcript.json`
- `<basename>.transcript.html`
- `<basename>.transcript.md`
- `<basename>.speakers.txt`

4. Inspect the speaker report and, if needed, the JSON/HTML opening turns.
5. Apply aliases without retranscribing:

```bash
bun --env-file <skill-path>/scripts/.env <skill-path>/scripts/apply-aliases.ts "<output-dir>/<basename>.transcript.json" \
  --rename speaker_1=Josh \
  --rename speaker_2=Dave
```

6. Re-check the first Markdown lines and final artifact paths before reporting completion.

## Speaker Assignment Heuristics

Map speaker IDs from evidence in the transcript, not from the raw ID order.

- Use direct address carefully: in `Howdy, Dave`, the speaking raw ID is probably not Dave.
- Use self-identification: `I'm Sean`, `this is James`, titles, location, role, or biography.
- Use known context from the user: if the user says the call is `Josh, Dave, and James`, map every raw ID to one of those names unless there is clear evidence of another participant.
- Use stable biographical clues: Josh is often the Madison/Wisconsin caller in these recordings; Aledade or policy roles may identify other speakers.
- Inspect at least the opening turns and 8-12 samples per raw speaker before finalizing.
- Mistral often creates extra raw speaker IDs for very short interjections, crosstalk, or audio glitches. Merge these into the nearest real speaker based on local turn context and wording.
- If a raw speaker has only a few words and the local context is ambiguous, prefer a conservative merge with a note in the final response rather than inventing a fourth participant.
- If confidence is genuinely low, keep the raw label or ask the user before overwriting a transcript intended for long-term archive.

Useful inspection commands:

```bash
bun <skill-path>/scripts/speaker-report.ts "<transcript.json>" --turns 100 --samples 20
```

For a tight context window around a suspicious raw speaker, use a quick JSON query:

```bash
bun -e 'const fs=require("fs"); const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); for (const w of d.words) if (w.speaker===process.argv[2]) console.log(`[${Math.floor(w.startMs/1000)}] ${w.speaker}: ${w.text}`)' "<transcript.json>" speaker_4
```

## Script Notes

- `scripts/run.ts`: end-to-end transcription plus speaker report and Markdown.
- `scripts/transcribe-mistral.ts`: lower-level Mistral/Voxtral transcriber and HTML renderer; supports `--rerender-from-json` and repeated `--rename raw=name`.
- `scripts/apply-aliases.ts`: rerender aliases into existing JSON/HTML/Markdown without another API call.
- `scripts/render-markdown.ts`: render Markdown from transcript JSON.
- `scripts/speaker-report.ts`: summarize speaker counts, opening turns, and samples per raw speaker.

For long recordings or upload failures, pass `--chunk-seconds <n>` to `run.ts`; note that chunked mode can make speaker labels less stable across chunks, so alias mapping may require more merging.

