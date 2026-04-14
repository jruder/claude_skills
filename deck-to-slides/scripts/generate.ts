/**
 * Generate slide images using one-shot prompting with a selected exemplar.
 *
 * Usage: bun run generate.ts <prompts-dir> <slides-out-dir> [exemplar-path] [slide-numbers...]
 *
 * Reads:  <prompts-dir>/brief.md, <prompts-dir>/slide-N.md
 *         <prompts-dir>/slide-N.json (optional — additional images for that slide)
 * Writes: <slides-out-dir>/slide-N.{png,jpg}
 *
 * If exemplar-path is provided, it's used as a one-shot style reference.
 * If no slide numbers given, auto-discovers all slide-N.md in prompts-dir.
 *
 * Per-slide JSON format (array):
 * [
 *   { "path": "../logo.png", "label": "Incorporate this logo into the ticket" },
 *   { "path": "../slides/slide-1.png", "label": "Ticket from slide 1 — maintain consistency" }
 * ]
 * Paths are resolved relative to the JSON file's directory (i.e. prompts-dir).
 */

import { generateImage, imageToDataUri } from "./api";
import { mkdir, readdir } from "fs/promises";
import { join, resolve, extname } from "path";
import { Glob } from "bun";

/**
 * Resolve an asset path, trying common image extensions if the exact path doesn't exist.
 * If multiple extensions exist (e.g. both slide-1.png and slide-1.jpg from different runs),
 * picks the most recently modified file to avoid using stale versions.
 */
async function resolveAssetPath(path: string): Promise<string> {
  const base = path.replace(/\.(png|jpg|jpeg|webp)$/i, "");
  const candidates: { path: string; mtime: number }[] = [];

  for (const ext of [".png", ".jpg", ".jpeg", ".webp"]) {
    const candidate = base + ext;
    const file = Bun.file(candidate);
    if (await file.exists()) {
      const stat = await file.stat();
      candidates.push({ path: candidate, mtime: stat?.mtime?.getTime() ?? 0 });
    }
  }

  if (candidates.length === 0) {
    throw new Error(`Asset not found: ${path} (tried .png/.jpg/.jpeg/.webp)`);
  }

  // Pick the most recently modified file
  candidates.sort((a, b) => b.mtime - a.mtime);
  if (candidates.length > 1) {
    console.log(`  Resolved: ${candidates[0].path} (newest of ${candidates.length} matches)`);
  }
  return candidates[0].path;
}

async function main() {
  const args = process.argv.slice(2);
  const promptsDir = args[0];
  const slidesOutDir = args[1];
  const exemplarPath = args[2] && !args[2].match(/^\d+$/) ? args[2] : undefined;
  const explicitSlides = args.slice(exemplarPath ? 3 : 2).map(Number).filter((n) => !isNaN(n));

  if (!promptsDir || !slidesOutDir) {
    console.error("Usage: bun run generate.ts <prompts-dir> <slides-out-dir> [exemplar-path] [slide-numbers...]");
    process.exit(1);
  }

  const brief = await Bun.file(join(promptsDir, "brief.md")).text();

  let slideNums: number[];
  if (explicitSlides.length > 0) {
    slideNums = explicitSlides;
  } else {
    const files = await readdir(promptsDir);
    slideNums = files
      .filter((f) => f.match(/^slide-\d+\.md$/))
      .map((f) => parseInt(f.match(/\d+/)![0]))
      .sort((a, b) => a - b);
  }

  if (slideNums.length === 0) {
    console.error(`No slide prompts found in ${promptsDir}/`);
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

  for (const num of slideNums) {
    const slidePrompt = await Bun.file(join(promptsDir, `slide-${num}.md`)).text().catch(() => null);
    if (!slidePrompt) { console.error(`  Skipping slide ${num}: not found`); continue; }

    // Load per-slide image assets if slide-N.json exists
    let additionalImages: { label: string; dataUri: string }[] | undefined;
    const jsonPath = join(promptsDir, `slide-${num}.json`);
    const jsonFile = Bun.file(jsonPath);
    if (await jsonFile.exists()) {
      const entries: { path: string; label: string }[] = JSON.parse(await jsonFile.text());
      additionalImages = [];
      for (const entry of entries) {
        const absPath = await resolveAssetPath(resolve(promptsDir, entry.path));
        additionalImages.push({ label: entry.label, dataUri: await imageToDataUri(absPath) });
        console.log(`  Asset: ${entry.path}`);
      }
    }

    console.log(`Slide ${num}:`);
    const fullPrompt = [brief, "\n---\n", "Generate the following as a single 16:9 presentation slide image:", "", slidePrompt].join("\n");

    try {
      const result = await generateImage({ prompt: fullPrompt, referenceImage: exemplarDataUri, additionalImages });
      const ext = result.mimeType === "image/jpeg" ? "jpg" : "png";
      const outPath = join(slidesOutDir, `slide-${num}.${ext}`);

      // Clean up any previous version with a different extension
      const otherExt = ext === "png" ? "jpg" : "png";
      const stalePath = join(slidesOutDir, `slide-${num}.${otherExt}`);
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
