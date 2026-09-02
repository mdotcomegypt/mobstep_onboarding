/**
 * Records what was built, so "is the server running the code I just pulled?"
 * is answerable from outside the box.
 *
 * dist/ is gitignored and systemd runs dist/index.js, so a `git pull` that is
 * not followed by a build leaves the service on old code while the source tree
 * looks current — a failure mode that reads as "the fix didn't work".
 */
import { execSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const git = (args) => {
  try {
    return execSync(`git ${args}`, { cwd: root, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
};

await writeFile(
  join(root, "dist", "build-info.json"),
  JSON.stringify({ commit: git("rev-parse --short HEAD"), builtAt: new Date().toISOString() }, null, 2),
);
