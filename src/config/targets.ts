export const BUILD_TARGETS = ["production", "local", "fixture"] as const;
export type BuildTarget = (typeof BUILD_TARGETS)[number];

export const PROVIDERS = ["cloudflare", "vercel"] as const;
export type Provider = (typeof PROVIDERS)[number];
