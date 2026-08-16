import { chmod } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  await chmod(resolve(projectRoot, "dist", "cli.js"), 0o755);
}
