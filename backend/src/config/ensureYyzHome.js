import fs from "node:fs/promises";

import { YYZ_DIR } from "./paths.js";
import { initializeDefaultYyzAssets } from "./defaultAssets.js";

export async function ensureYyzHome() {
  await fs.mkdir(YYZ_DIR, { recursive: true });
  await initializeDefaultYyzAssets({ targetDir: YYZ_DIR });
}
