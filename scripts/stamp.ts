import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
const commit = git("rev-parse", "HEAD");
const dirty = git("status", "--porcelain").length > 0;
const revision = dirty ? `${commit}-dirty` : commit;

mkdirSync("src/generated", { recursive: true });
writeFileSync(
  "src/generated/build-info.ts",
  `export const BUILD_REVISION = ${JSON.stringify(revision)};\n`,
);
