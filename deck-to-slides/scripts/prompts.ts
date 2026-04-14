/**
 * Shared utility for auto-discovering and reading prompts metadata
 * from a sibling `prompts/` directory next to the slides directory.
 */

import { readdir } from "fs/promises";
import { join, dirname } from "path";

export interface PromptsMetadata {
  brief: string;
  slides: Record<string, string>;
  assets: Record<string, any[]>;
}

/** Auto-discover prompts directory as a sibling to slides dir */
export async function discoverPrompts(slidesDir: string): Promise<PromptsMetadata | null> {
  const promptsDir = join(dirname(slidesDir), "prompts");
  const briefFile = Bun.file(join(promptsDir, "brief.md"));
  if (!(await briefFile.exists())) return null;

  const brief = await briefFile.text();
  const slides: Record<string, string> = {};
  const assets: Record<string, any[]> = {};

  const files = await readdir(promptsDir).catch(() => [] as string[]);
  for (const f of files) {
    const mdMatch = f.match(/^slide-(\d+)\.md$/);
    if (mdMatch) {
      slides[mdMatch[1]] = await Bun.file(join(promptsDir, f)).text();
    }
    const jsonMatch = f.match(/^slide-(\d+)\.json$/);
    if (jsonMatch) {
      assets[jsonMatch[1]] = JSON.parse(await Bun.file(join(promptsDir, f)).text());
    }
  }

  const assetCount = Object.keys(assets).length;
  console.log(`  Found prompts metadata (brief + ${Object.keys(slides).length} slide prompts + ${assetCount} asset configs)`);
  return { brief, slides, assets };
}
