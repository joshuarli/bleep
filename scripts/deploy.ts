import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { PROVIDERS, type Provider } from "../src/config/targets.ts";

const VERCEL_PROJECT = "blip-monitor";

function usage(): never {
  console.error(`usage: node scripts/deploy.ts <${[...PROVIDERS, "all"].join("|")}>`);
  process.exit(2);
}

const requested = process.argv[2];
if (process.argv.length !== 3 || requested === undefined) usage();
const providers: readonly Provider[] =
  requested === "all"
    ? PROVIDERS
    : (PROVIDERS as readonly string[]).includes(requested)
      ? [requested as Provider]
      : usage();

const env = { ...process.env, BLIP_TARGET: "production" };
const run = (command: string, args: string[]) =>
  execFileSync(command, args, { stdio: "inherit", env });

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
if (git("status", "--porcelain") !== "") {
  throw new Error("refusing to deploy a dirty tree; commit or stash first");
}
const revision = git("rev-parse", "HEAD");

run("npm", ["run", "stamp"]);
const { BUILD_REVISION, BUILD_TARGET } = await import("../src/generated/build-info.ts");
if (BUILD_REVISION !== revision || BUILD_TARGET !== "production") {
  throw new Error(`stamp produced ${BUILD_REVISION} for ${BUILD_TARGET}; expected ${revision} for production`);
}

for (const provider of providers) {
  if (provider === "cloudflare") {
    run("npx", ["cf", "deploy", "--message", revision]);
  } else {
    if (!existsSync(".vercel/project.json")) {
      run("vercel", ["link", "--yes", "--project", VERCEL_PROJECT]);
    }
    run("vercel", ["build", "--prod", "--yes"]);
    run("vercel", ["deploy", "--prebuilt", "--prod", "--yes"]);
  }
}

console.log(`deployed ${revision} to ${providers.join(", ")}; run node scripts/verify-live.ts --all`);
