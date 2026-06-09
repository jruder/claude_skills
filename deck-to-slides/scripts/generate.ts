/**
 * Generate slide images using one-shot prompting with a selected exemplar.
 *
 * Usage: bun run generate.ts <prompts-dir> <slides-out-dir> [exemplar-path] [slide-ids...]
 *
 * Reads:  <prompts-dir>/brief.md, <prompts-dir>/slide-NNN.md
 *         <prompts-dir>/slide-NNN.json (optional — additional images for that slide)
 * Writes: <slides-out-dir>/slide-NNN.{png,jpg}
 *
 * If exemplar-path is provided, it's used as a one-shot style reference.
 * If no slide IDs given, auto-discovers all slide-NNN.md in prompts-dir.
 *
 * Per-slide JSON format (array):
 * [
 *   { "path": "../logo.png", "label": "Incorporate this logo into the ticket" },
 *   { "path": "../slides/slide-001.png", "label": "Ticket from slide 001 — maintain consistency" }
 * ]
 * Paths are resolved relative to the JSON file's directory (i.e. prompts-dir).
 */

import { generateImage, imageToDataUri } from "./api";
import { loadPromptAssets } from "./assets";
import { mkdir, readdir } from "fs/promises";
import { join } from "path";

async function main() {
  const args = process.argv.slice(2);
  const promptsDir = args[0];
  const slidesOutDir = args[1];
  const exemplarPath = args[2] && !args[2].match(/^\d{3}$/) ? args[2] : undefined;
  const explicitSlides = args.slice(exemplarPath ? 3 : 2);

  if (!promptsDir || !slidesOutDir) {
    console.error("Usage: bun run generate.ts <prompts-dir> <slides-out-dir> [exemplar-path] [slide-ids...]");
    console.error("Slide IDs must be zero-padded, e.g. 001 002 013.");
    process.exit(1);
  }

  for (const id of explicitSlides) {
    if (!id.match(/^\d{3}$/)) {
      console.error(`Invalid slide ID "${id}". Use exactly three digits, e.g. 001.`);
      process.exit(1);
    }
  }

  const brief = await Bun.file(join(promptsDir, "brief.md")).text();

  let slideIds: string[];
  if (explicitSlides.length > 0) {
    slideIds = explicitSlides;
  } else {
    const files = await readdir(promptsDir);
    slideIds = files
      .filter((f) => f.match(/^slide-\d{3}\.md$/))
      .map((f) => f.match(/^slide-(\d{3})\.md$/)![1])
      .sort();
  }

  if (slideIds.length === 0) {
    console.error(`No slide prompts found in ${promptsDir}/ (expected slide-NNN.md)`);
    process.exit(1);
  }

  let exemplarDataUri: string | undefined;
  if (exemplarPath) {
    exemplarDataUri = await imageToDataUri(exemplarPath);
    console.log(`Using exemplar: ${exemplarPath}`);
  } else {
    console.log("No exemplar — generating without one-shot reference.");
  }

  await mkdir(slidesOutDir, { recursive: true });

  for (const id of slideIds) {
    const slidePrompt = await Bun.file(join(promptsDir, `slide-${id}.md`)).text().catch(() => null);
    if (!slidePrompt) { console.error(`  Skipping slide ${id}: not found`); continue; }

    const additionalImages = await loadPromptAssets(promptsDir, id);

    console.log(`Slide ${id}:`);
    const fullPrompt = [brief, "\n---\n", "Generate the following as a single 16:9 presentation slide image:", "", slidePrompt].join("\n");

    try {
      const result = await generateImage({ prompt: fullPrompt, referenceImage: exemplarDataUri, additionalImages });
      const ext = result.mimeType === "image/jpeg" ? "jpg" : "png";
      const outPath = join(slidesOutDir, `slide-${id}.${ext}`);

      // Clean up any previous version with a different extension
      const otherExt = ext === "png" ? "jpg" : "png";
      const stalePath = join(slidesOutDir, `slide-${id}.${otherExt}`);
      await Bun.file(stalePath).exists().then(exists => {
        if (exists) {
          require("fs").unlinkSync(stalePath);
          console.log(`  Removed stale: ${stalePath}`);
        }
      });

      await Bun.write(outPath, result.image);
      console.log(`  Saved: ${outPath} (${(result.image.length / 1024).toFixed(0)} KB)`);
    } catch (err: any) {
      console.error(`  Error: ${err.message}`);
    }
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
