import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { BUILD_TARGETS, type BuildTarget } from "../src/config/targets.ts";

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
const commit = git("rev-parse", "HEAD");
const dirty = git("status", "--porcelain").length > 0;
const revision = dirty ? `${commit}-dirty` : commit;

const requested = process.env.BLIP_TARGET ?? "local";
if (!(BUILD_TARGETS as readonly string[]).includes(requested)) {
  throw new Error(`BLIP_TARGET must be one of ${BUILD_TARGETS.join(", ")}; got ${requested}`);
}
const target = requested as BuildTarget;

mkdirSync("src/generated", { recursive: true });
writeFileSync(
  "src/generated/build-info.ts",
  [
    `import type { BuildTarget } from "../config/targets.ts";`,
    "",
    `export const BUILD_REVISION: string = ${JSON.stringify(revision)};`,
    `export const BUILD_TARGET: BuildTarget = ${JSON.stringify(target)};`,
    "",
  ].join("\n"),
);
