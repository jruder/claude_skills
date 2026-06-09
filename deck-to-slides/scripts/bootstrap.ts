/**
 * Bootstrap: Generate 3 variants of a slide for initial style selection.
 *
 * Usage: bun run bootstrap.ts <slide-id> <prompts-dir> <out-dir>
 *
 * Reads:  <prompts-dir>/brief.md, <prompts-dir>/slide-NNN.md
 * Writes: <out-dir>/variant-{1,2,3}.{png,jpg}
 */

import { generateImage } from "./api";
import { loadPromptAssets } from "./assets";
import { mkdir } from "fs/promises";
import { join } from "path";

const VARIANTS = 3;

async function main() {
  const [slideArg, promptsDir, outDir] = process.argv.slice(2);

  if (!slideArg?.match(/^\d{3}$/) || !promptsDir || !outDir) {
    console.error("Usage: bun run bootstrap.ts <slide-id> <prompts-dir> <out-dir>");
    console.error("Slide ID must be zero-padded, e.g. 001.");
    process.exit(1);
  }

  const brief = await Bun.file(join(promptsDir, "brief.md")).text();
  const slidePrompt = await Bun.file(join(promptsDir, `slide-${slideArg}.md`)).text();
  const additionalImages = await loadPromptAssets(promptsDir, slideArg);

  const fullPrompt = [
    brief,
    "\n---\n",
    "Generate the following as a single 16:9 presentation slide image:",
    "",
    slidePrompt,
  ].join("\n");

  await mkdir(outDir, { recursive: true });

  console.log(`Bootstrapping slide ${slideArg} → ${outDir}/`);

  for (let i = 1; i <= VARIANTS; i++) {
    console.log(`Variant ${i}/${VARIANTS}:`);
    try {
      const result = await generateImage({ prompt: fullPrompt, additionalImages });
      const ext = result.mimeType === "image/jpeg" ? "jpg" : "png";
      const outPath = join(outDir, `variant-${i}.${ext}`);
      await Bun.write(outPath, result.image);
      console.log(`  Saved: ${outPath} (${(result.image.length / 1024).toFixed(0)} KB)`);
    } catch (err: any) {
      console.error(`  Error: ${err.message}`);
    }
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
