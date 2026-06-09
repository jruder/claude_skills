---
name: deck-to-slides
description: Create slide-image decks from markdown, outlines, or detailed presentation briefs, then assemble them into HTML and PowerPoint. Use this skill when the user wants generated presentation slides, a prompt set for slide images, a deck-level visual system, image-model slide generation through Codex-native tools or OpenRouter/Gemini scripts, or assembly/export of existing slide images.
---

# Deck-to-Slides

Create a presentation as a sequence of 16:9 slide images, then export the image sequence to HTML and PowerPoint. The skill supports three execution modes:

1. **Codex-native image generation**: Codex writes prompts and calls its available image-generation tool. Copy selected outputs into `slides/`.
2. **External script generation**: use the bundled Bun scripts, which call Gemini through OpenRouter.
3. **Assemble-only**: skip generation and export an existing `slides/` directory to `.html` and `.pptx`.

Prefer the mode that matches the user's request and available tools. Keep image generation, prompt authoring, and export as separable steps so any step can be repeated without redoing the others.

## Output Layout

Unless the user specifies otherwise, outputs go beside the input deck file. For `project/deck.md`:

```text
project/
  deck.md
  deck.pptx
  deck.html
  prompts/
    brief.md
    brief.json        # optional deck-level grounding images
    slide-001.md
    slide-001.json      # optional slide-specific grounding images
    ...
  slides/
    slide-001.png
    slide-002.png
    ...
```

Keep `prompts/` by default. The HTML and PPTX exporters embed prompt metadata when `prompts/` is a sibling of `slides/`, which makes the deck auditable and easier to regenerate.

Use zero-padded three-digit slide IDs everywhere. The canonical convention is `slide-001.md`, `slide-001.json`, and `slide-001.png`. Do not create or consume `slide-1.*` or `01-title.*` files.

## Setup For External Scripts

Install dependencies once:

```bash
cd <skill-path>/scripts && bun install
```

The OpenRouter generation scripts need `OPENROUTER_API_KEY`. If `<skill-path>/scripts/.env` exists, include it in generation commands:

```bash
bun --env-file <skill-path>/scripts/.env run <skill-path>/scripts/generate.ts ...
```

If no key is available and the user still wants external script generation, ask for the key before calling `bootstrap.ts` or `generate.ts`. Export scripts do not need an API key.

## Workflow

### 1. Parse And Design The Deck

Read the user's source material and write:

- `prompts/brief.md`: the deck-level visual system and shared generation rules.
- `prompts/slide-NNN.md`: one self-contained prompt per slide.
- `prompts/brief.json`: optional shared visual references, such as style-guide images, font specimens, logos, color boards, screenshots, or diagrams.
- `prompts/slide-NNN.json`: optional per-slide references.

Use the source deck or agenda order as the slide order unless the user asks for a new ordering.

### 2. Ground The Deck-Level Style

The brief is the most important file. It should tell the model what the deck is, how it should feel, and what references actually mean. Include concrete guidance for:

- **Audience and use**: live talk, panel prompt deck, workshop, sales deck, keynote, handout companion.
- **Visual thesis**: the repeated visual grammar that carries the argument.
- **Aspect and density**: 16:9, strong readability from the back of a room, target text density, whitespace expectations.
- **Color system**: exact hex values and role assignments such as background, title, body text, accent, warning, muted linework, demo callout.
- **Typography**: font family or font style, title/body/accent sizes in relative terms, weight, casing, and any forbidden typography.
- **Composition rules**: margins, grid, recurring footer or progress marker, diagram style, image treatment, chart treatment.
- **Grounding content**: how to use supplied images or references. Say whether a reference is for palette only, layout rhythm only, a literal object, a font sample, or a factual diagram.
- **Brand rules**: where logos may appear, where they must not appear, and whether brand-like marks are forbidden.
- **Negative guidance**: explicitly reject clip art, fake UI chrome, clutter, unreadable labels, generic gradients, accidental logos, or any other likely failure mode.

Good grounding labels are specific:

```json
[
  {
    "path": "../background/style-guide.png",
    "label": "Use only as a palette, whitespace, and timeline-linework reference. Do not copy the logo or repeat the star mark."
  },
  {
    "path": "../background/font-sample.png",
    "label": "Typography reference: match the clean geometric sans style and generous letter spacing, not the exact text."
  }
]
```

### 3. Write Per-Slide Prompts

Each `slide-NNN.md` should include:

- Slide title and role in the talk.
- Full visible layout, including zones and relative proportions.
- All on-screen text verbatim. Current image models can render exact text well enough, so include the actual words the slide should show.
- Visual content and metaphor.
- Any data, spec, repo, demo, or external source that the slide should link to.
- Speaker/demo notes if useful. These will be embedded in exports as prompt metadata, not rendered on the image unless requested.
- Negative guidance specific to the slide.

For live-demo decks, include interstitial slides that link out to demos. A slide can be mostly visual with a URL, QR-style placeholder, terminal command, or short demo objective.

### 4. Generate Images

#### Codex-native mode

Use the available image-generation tool with `brief.md`, the relevant `slide-NNN.md`, and any matching `brief.json` or `slide-NNN.json` assets. Generated images may be saved outside the project by the tool; copy selected outputs into `slides/slide-NNN.png` or `slides/slide-NNN.jpg`.

Generate a small number of style candidates first when the visual system is unsettled. Once the user or agent selects the direction, generate slides in order, especially when later slides reference earlier rendered outputs.

When consistency matters, use multiple explicit visual references with separate roles instead of one overloaded exemplar. A good deck often needs:

- **Global style reference**: palette, linework, whitespace, icon treatment, and overall mood. Example: a timeline snapshot used only for colors and connector style.
- **Typography/header reference**: title font feel, title weight, title position, margins, subtitle treatment, footer treatment, and density. Example: an approved title slide.
- **Per-slide layout/content reference**: the current slide draft, sketch, screenshot, or source diagram for composition and factual content only.
- **Literal asset reference**: a screenshot, product UI, chart, or artifact that should be reproduced or closely adapted.

Label each reference by role in `brief.json` or `slide-NNN.json`, and repeat those roles in the generation prompt. Say exactly what to copy and what not to copy. For example, "Use Image A only for palette and thin timeline linework; do not copy its logo or star mark. Use Image B for header typography and margin rhythm; do not copy its content. Use Image C for this slide's layout and exact content." If the image-generation tool supports image references directly, pass the relevant files through `brief.json`/`slide-NNN.json` or display/load them before generation. If it does not, describe the references in `brief.md` and repeat the key style rules in every `slide-NNN.md`.

For full-quality slide decks, request a standard 16:9 output size explicitly, usually `1920x1080`. Verify every generated image with `identify` or an equivalent image-inspection tool. If the active image-generation surface does not expose hard pixel-size control and returns a nearby nonstandard size, either regenerate with stronger size language or normalize a copy to the target canvas before export, preserving aspect ratio and documenting the normalization in the deck notes. Do not assume that “16:9” means the generated file is exactly `1920x1080`.

#### External script mode

Bootstrap three variants for a representative slide:

```bash
bun --env-file <skill-path>/scripts/.env run <skill-path>/scripts/bootstrap.ts <slide-id> <prompts-dir> <bootstrap-out-dir>
```

Select one exemplar:

```bash
bun run <skill-path>/scripts/select.ts ./bootstrap/variant-2.png ./exemplar.png
```

Generate all slides:

```bash
bun --env-file <skill-path>/scripts/.env run <skill-path>/scripts/generate.ts <prompts-dir> <slides-out-dir> [exemplar-path] [slide-ids...]
```

Examples:

```bash
bun --env-file <skill-path>/scripts/.env run <skill-path>/scripts/generate.ts ./prompts ./slides ./exemplar.png
bun --env-file <skill-path>/scripts/.env run <skill-path>/scripts/generate.ts ./prompts ./slides ./exemplar.png 003 005
bun --env-file <skill-path>/scripts/.env run <skill-path>/scripts/generate.ts ./prompts ./slides
```

`brief.json` and `slide-NNN.json` are both passed as image references. Paths are resolved relative to the prompts directory.

### 5. Export HTML And PowerPoint

Use this for generated slides or assemble-only workflows:

```bash
bun run <skill-path>/scripts/export-pptx.ts <slides-dir> <out.pptx>
bun run <skill-path>/scripts/export-html.ts <slides-dir> <out.html>
```

Example:

```bash
bun run <skill-path>/scripts/export-pptx.ts ./slides ./deck.pptx
bun run <skill-path>/scripts/export-html.ts ./slides ./deck.html
```

## Prompt Craft

- Describe the visible result, not the construction process.
- Say what the viewer sees from across the room and what appears up close.
- Use concrete spatial relationships and ratios, not tiny pixel differences.
- Include exact slide text when the deck needs text.
- Keep generated slides legible as projected images; move detailed evidence, specs, and citations into notes or companion material.
- Use reference images deliberately. A style reference should not become accidental repeated branding.
- Regenerate individual slides when style or factual alignment is off; do not redo the whole deck unless the visual system changes.

## Troubleshooting

- **No image found in response**: shorten the prompt or remove competing references.
- **Inconsistent style**: create a stronger `brief.md`, use `brief.json`, or generate with an exemplar.
- **References copied too literally**: tighten the asset label and add explicit negative guidance.
- **Too much text**: split into two slides or move details into notes.
- **Wrong aspect ratio**: scripts default to 16:9; edit `scripts/api.ts` only if the deck requires another ratio.
