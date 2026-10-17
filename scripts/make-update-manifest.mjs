#!/usr/bin/env node
// Builds latest.json, the update manifest the app reads, from a (draft) GitHub
// release. Used by the Release workflow after both installers are built.
//
//   node scripts/make-update-manifest.mjs --release release.json --repo owner/repo \
//     [--out latest.json] [--min-supported 0.1.0]
//
// release.json is one object from `GET /repos/{repo}/releases`. The installers
// are downloaded through the API (GITHUB_TOKEN) to compute their size and
// SHA-256, because draft releases have no public download URLs yet.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const MAX_NOTES_LENGTH = 4000;
const SAFE_FILE_NAME = /^[A-Za-z0-9._-]+$/;

/** The body of the `## [version]` section (or `## [Unreleased]` as a fallback), trimmed. */
export function extractChangelogSection(changelog, version) {
  const lines = changelog.replace(/\r\n?/g, "\n").split("\n");
  const find = (name) => lines.findIndex((line) => new RegExp(`^##\\s+\\[${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`, "i").test(line));
  let start = find(version);
  if (start === -1) start = find("Unreleased");
  if (start === -1) return "";
  let end = lines.findIndex((line, index) => index > start && /^##\s/.test(line));
  if (end === -1) end = lines.length;
  return lines.slice(start + 1, end).join("\n").trim();
}

/** Short plain-text notes: headings become "Added:" style lines, length is capped. */
export function formatNotes(section) {
  const text = section
    .split("\n")
    .map((line) => line.replace(/^###\s+(.*)$/, "$1:").replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > MAX_NOTES_LENGTH ? `${text.slice(0, MAX_NOTES_LENGTH - 1).trimEnd()}…` : text;
}

/** Picks this version's Windows installer and macOS disk image from a release's assets. */
export function pickInstallers(assets, version) {
  const named = (suffix) => assets.find((asset) => asset.name.includes(version) && asset.name.endsWith(suffix));
  return {
    "windows-x64": named("-setup.exe") ?? named("x64-setup.exe"),
    "macos-universal": named("universal.dmg") ?? named(".dmg"),
  };
}

export function buildManifest({ version, repository, tag, releaseDate, notes, minSupportedVersion, files }) {
  const base = `https://github.com/${repository}/releases`;
  const assets = {};
  for (const [platform, file] of Object.entries(files)) {
    if (!SAFE_FILE_NAME.test(file.fileName)) throw new Error(`Unsafe installer file name: ${file.fileName}`);
    if (!/^[0-9a-f]{64}$/.test(file.sha256)) throw new Error(`Bad checksum for ${file.fileName}`);
    if (!Number.isInteger(file.sizeBytes) || file.sizeBytes <= 0) throw new Error(`Bad size for ${file.fileName}`);
    assets[platform] = {
      fileName: file.fileName,
      url: `${base}/download/${tag}/${file.fileName}`,
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
    };
  }
  if (!assets["windows-x64"] || !assets["macos-universal"]) {
    throw new Error("Both a Windows installer and a macOS disk image are required.");
  }
  return {
    schemaVersion: 1,
    version,
    releaseDate,
    notes,
    ...(minSupportedVersion ? { minSupportedVersion } : {}),
    pageUrl: `${base}/tag/${tag}`,
    assets,
  };
}

async function digestAsset(asset, token) {
  const response = await fetch(asset.url, {
    headers: { Accept: "application/octet-stream", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`Could not download ${asset.name}: HTTP ${response.status}`);
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of response.body) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { fileName: asset.name, sizeBytes: size, sha256: hash.digest("hex") };
}

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function main(args) {
  const releasePath = option(args, "--release");
  const repository = option(args, "--repo") ?? process.env.GITHUB_REPOSITORY;
  const out = option(args, "--out") ?? "latest.json";
  const minSupportedVersion = option(args, "--min-supported") || undefined;
  const token = process.env.GITHUB_TOKEN;
  if (!releasePath || !repository || !token) {
    throw new Error("Usage: make-update-manifest.mjs --release <release.json> --repo <owner/repo> [--out latest.json] (GITHUB_TOKEN required)");
  }
  const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const release = JSON.parse(readFileSync(releasePath, "utf8"));
  const tag = `v${version}`;
  if (release.tag_name !== tag) throw new Error(`Release tag ${release.tag_name} does not match ${tag}`);

  const picked = pickInstallers(release.assets ?? [], version);
  if (!picked["windows-x64"] || !picked["macos-universal"]) {
    throw new Error(`Release is missing an installer: ${(release.assets ?? []).map((asset) => asset.name).join(", ")}`);
  }
  const files = {};
  for (const [platform, asset] of Object.entries(picked)) files[platform] = await digestAsset(asset, token);

  const changelog = readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
  const notes = formatNotes(extractChangelogSection(changelog, version)) || `Glee ${version}`;
  const manifest = buildManifest({
    version,
    repository,
    tag,
    releaseDate: new Date().toISOString(),
    notes,
    minSupportedVersion,
    files,
  });
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${out} for ${tag}: ${Object.values(files).map((file) => `${file.fileName} (${file.sizeBytes} bytes)`).join(", ")}`);
}

if (process.argv[1] === import.meta.filename) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
