/**
 * Adds one history row through a storage adapter that pauses between reading
 * and writing — the read-modify-write window, widened at the one place a test
 * is allowed to reach: the injectable storage.
 *
 * argv: <storeFile> <lockDir> <id> <sleepMs> <markerPath>
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { createDownloadHistory } from "../../dist/history.js";

const [storeFile, lockDir, id, sleepMsRaw, marker] = process.argv.slice(2);
const sleepMs = Number(sleepMsRaw);

const storage = {
  async getItem(key) {
    const all = existsSync(storeFile) ? JSON.parse(readFileSync(storeFile, "utf8")) : {};
    // Read done, write not yet. This is the window.
    writeFileSync(marker, "read");
    await new Promise((r) => setTimeout(r, sleepMs));
    return all[key];
  },
  async setItem(key, value) {
    const all = existsSync(storeFile) ? JSON.parse(readFileSync(storeFile, "utf8")) : {};
    all[key] = value;
    writeFileSync(storeFile, JSON.stringify(all));
  },
  async removeItem(key) {
    const all = existsSync(storeFile) ? JSON.parse(readFileSync(storeFile, "utf8")) : {};
    delete all[key];
    writeFileSync(storeFile, JSON.stringify(all));
  },
};

const history = createDownloadHistory({ storage, lockDir });
await history.add({ id, filename: `${id}.bin`, outputPath: `/tmp/${id}.bin`, status: "completed" });
