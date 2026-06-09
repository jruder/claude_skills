/**
 * Export slide images into a PPTX file.
 *
 * Usage: bun run export-pptx.ts <slides-dir> <out.pptx>
 */

import PptxGenJS from "pptxgenjs";
import JSZip from "jszip";
import { readdir } from "fs/promises";
import { join, extname } from "path";
import { discoverPrompts } from "./prompts";

async function main() {
  const [slidesDir, outPath] = process.argv.slice(2);

  if (!slidesDir || !outPath) {
    console.error("Usage: bun run export-pptx.ts <slides-dir> <out.pptx>");
    process.exit(1);
  }

  const files = await readdir(slidesDir);
  const slideFiles = files
    .filter((f) => f.match(/^slide-\d{3}\.(png|jpg|jpeg)$/))
    .sort();

  if (slideFiles.length === 0) {
    console.error(`No slide images found in ${slidesDir}/ (expected slide-NNN.png/jpg/jpeg)`);
    process.exit(1);
  }

  // Auto-discover prompts
  const prompts = await discoverPrompts(slidesDir);

  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";

  for (const file of slideFiles) {
    const imageBytes = await Bun.file(join(slidesDir, file)).arrayBuffer();
    const base64 = Buffer.from(imageBytes).toString("base64");
    const ext = extname(file).slice(1).toLowerCase();
    const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png";

    const slideNum = file.match(/\d{3}/)![0];
    const slide = pptx.addSlide();
    slide.addImage({ data: `data:${mime};base64,${base64}`, x: 0, y: 0, w: "100%", h: "100%" });

    // Add per-slide prompt as speaker notes
    if (prompts?.slides[slideNum]) {
      slide.addNotes(prompts.slides[slideNum]);
    }

    console.log(`  Added: ${file}`);
  }

  // Write PPTX to buffer, then inject full prompts metadata via JSZip
  const pptxBuf = await pptx.write({ outputType: "nodebuffer" }) as Buffer;

  if (prompts) {
    const zip = await JSZip.loadAsync(pptxBuf);
    zip.file("deckPrompts.json", JSON.stringify(prompts, null, 2));
    const finalBuf = await zip.generateAsync({ type: "nodebuffer" });
    await Bun.write(outPath, finalBuf);
    console.log(`  Injected deckPrompts.json into PPTX`);
  } else {
    await Bun.write(outPath, pptxBuf);
  }

  console.log(`PPTX saved: ${outPath} (${slideFiles.length} slides)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
