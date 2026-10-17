#!/usr/bin/env node
// Tools for the update source in src-tauri/resources/update-source.json.
//
//   node scripts/update-source.mjs check
//       Validate the file (empty = update checks disabled, otherwise https).
//   node scripts/update-source.mjs set <https://github.com/owner/repo/releases/latest/download/latest.json>
//       Point the app at a published update manifest (used by release builds).

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const sourcePath = path.join(root, "src-tauri", "resources", "update-source.json");

/** Returns a list of problems with `url`; an empty string means "checks disabled". */
export function validateManifestUrl(url) {
  if (typeof url !== "string") return ["manifestUrl must be a string"];
  if (url === "") return [];
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return [`manifestUrl is not a URL: ${url}`];
  }
  const problems = [];
  if (parsed.protocol !== "https:") problems.push("manifestUrl must use https");
  if (!parsed.pathname.endsWith(".json")) problems.push("manifestUrl must point at a .json file");
  return problems;
}

function check() {
  const source = JSON.parse(readFileSync(sourcePath, "utf8"));
  const problems = validateManifestUrl(source.manifestUrl);
  if (problems.length) {
    console.error(problems.map((problem) => `- ${problem}`).join("\n"));
    process.exit(1);
  }
  console.log(source.manifestUrl ? `Update source OK: ${source.manifestUrl}` : "Update source OK: update checks are disabled.");
}

function set(url) {
  const problems = !url ? ["a manifest URL is required"] : validateManifestUrl(url);
  if (problems.length) {
    console.error(problems.map((problem) => `- ${problem}`).join("\n"));
    process.exit(1);
  }
  writeFileSync(sourcePath, `${JSON.stringify({ manifestUrl: url }, null, 2)}\n`);
  check();
}

if (process.argv[1] === import.meta.filename) {
  const [command, argument] = process.argv.slice(2);
  if (command === "check") check();
  else if (command === "set") set(argument);
  else {
    console.error("Usage: update-source.mjs check | set <manifest-url>");
    process.exit(2);
  }
}
