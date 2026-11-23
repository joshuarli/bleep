import { BUILD_TARGET } from "../generated/build-info.ts";
import type { BuildTarget, Provider } from "./targets.ts";

export type Endpoint = {
  provider: Provider;
  label: string;
  origin: string;
  configuredLocation: string;
};

export type EndpointMap = Record<Provider, Endpoint>;

const CONFIGURED_LOCATION: Record<Provider, string> = {
  cloudflare: "default placement",
  vercel: "sfo1",
};

const LABEL: Record<Provider, string> = { cloudflare: "Cloudflare", vercel: "Vercel" };

function endpointMap(origins: Record<Provider, string>): EndpointMap {
  const endpoint = (provider: Provider): Endpoint => ({
    provider,
    label: LABEL[provider],
    origin: origins[provider],
    configuredLocation: CONFIGURED_LOCATION[provider],
  });
  return { cloudflare: endpoint("cloudflare"), vercel: endpoint("vercel") };
}

export const ENDPOINTS_BY_TARGET: Record<BuildTarget, EndpointMap> = {
  production: endpointMap({
    cloudflare: "https://blip-monitor.joshua-r-li-98.workers.dev",
    vercel: "https://blip-monitor.vercel.app",
  }),
  local: endpointMap({
    cloudflare: "http://127.0.0.1:8787",
    vercel: "http://127.0.0.1:8788",
  }),
  fixture: endpointMap({
    cloudflare: "http://127.0.0.1:8791",
    vercel: "http://127.0.0.1:8792",
  }),
};

export const ENDPOINTS: EndpointMap = ENDPOINTS_BY_TARGET[BUILD_TARGET];

export const probeUrl = (endpoint: Endpoint, id: string): string => `${endpoint.origin}/probe?id=${id}`;
