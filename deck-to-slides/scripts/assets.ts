/**
 * Shared utilities for loading deck-level and per-slide image references.
 */

import { imageToDataUri } from "./api";
import { resolve, join } from "path";

export interface ImageAssetEntry {
  path: string;
  label: string;
}

export interface ResolvedImageAsset {
  label: string;
  dataUri: string;
}

/**
 * Resolve an asset path, trying common image extensions if the exact path doesn't exist.
 * If multiple extensions exist, picks the most recently modified file to avoid stale outputs.
 */
export async function resolveAssetPath(path: string): Promise<string> {
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

  candidates.sort((a, b) => b.mtime - a.mtime);
  if (candidates.length > 1) {
    console.log(`  Resolved: ${candidates[0].path} (newest of ${candidates.length} matches)`);
  }
  return candidates[0].path;
}

async function loadAssetJson(jsonPath: string): Promise<ImageAssetEntry[]> {
  const file = Bun.file(jsonPath);
  if (!(await file.exists())) return [];
  return JSON.parse(await file.text());
}

/**
 * Loads optional prompts/brief.json and prompts/slide-NNN.json image references.
 * Paths are resolved relative to the prompts directory.
 */
export async function loadPromptAssets(promptsDir: string, slideId: string): Promise<ResolvedImageAsset[] | undefined> {
  if (!slideId.match(/^\d{3}$/)) {
    throw new Error(`Invalid slide ID "${slideId}". Use exactly three digits, e.g. 001.`);
  }

  const entries = [
    ...(await loadAssetJson(join(promptsDir, "brief.json"))),
    ...(await loadAssetJson(join(promptsDir, `slide-${slideId}.json`))),
  ];

  if (entries.length === 0) return undefined;

  const assets: ResolvedImageAsset[] = [];
  for (const entry of entries) {
    const absPath = await resolveAssetPath(resolve(promptsDir, entry.path));
    assets.push({ label: entry.label, dataUri: await imageToDataUri(absPath) });
    console.log(`  Asset: ${entry.path}`);
  }

  return assets;
}
