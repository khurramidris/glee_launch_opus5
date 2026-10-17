import { isTauri } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { modelStore } from "../stores/model-store";

/**
 * Fetch for the local llama-server. Inside the desktop app the request goes
 * through Tauri's HTTP plugin, so WebView CORS and mixed-content rules never
 * apply, and it carries the per-launch API key. Tests and browser previews
 * fall back to the global fetch.
 */
export function runtimeFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const apiKey = modelStore.getState().runtime.apiKey;
  if (apiKey && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }
  const request = { ...init, headers };
  return isTauri() ? tauriFetch(input, request) : fetch(input, request);
}
