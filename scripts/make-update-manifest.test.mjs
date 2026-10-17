import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildManifest, extractChangelogSection, formatNotes, pickInstallers } from "./make-update-manifest.mjs";
import { validateManifestUrl } from "./update-source.mjs";

const CHANGELOG = `# Changelog

## [Unreleased]

### Added
- Something upcoming

## [0.2.0] - 2000-01-01

### Added
- Update notifications

### Fixed
- A crash

## [0.1.0] - 1999-12-31

- First release
`;

const SHA = "a".repeat(64);
const file = (fileName) => ({ fileName, sizeBytes: 1234, sha256: SHA });

describe("extractChangelogSection", () => {
  it("returns the matching version section only", () => {
    const section = extractChangelogSection(CHANGELOG, "0.2.0");
    assert.match(section, /Update notifications/);
    assert.doesNotMatch(section, /First release|Something upcoming/);
  });

  it("falls back to Unreleased, then to nothing", () => {
    assert.match(extractChangelogSection(CHANGELOG, "9.9.9"), /Something upcoming/);
    assert.equal(extractChangelogSection("# Changelog\n", "1.0.0"), "");
  });
});

describe("formatNotes", () => {
  it("turns headings into labels and caps the length", () => {
    assert.equal(formatNotes("### Added\n- One\n\n\n\n### Fixed\n- Two"), "Added:\n- One\n\nFixed:\n- Two");
    assert.ok(formatNotes("x".repeat(10000)).length <= 4000);
  });
});

describe("pickInstallers", () => {
  it("finds the installer and disk image for the version", () => {
    const assets = [{ name: "Glee_0.2.0_x64-setup.exe" }, { name: "Glee_0.2.0_universal.dmg" }, { name: "Glee_0.1.0_x64-setup.exe" }];
    const picked = pickInstallers(assets, "0.2.0");
    assert.equal(picked["windows-x64"].name, "Glee_0.2.0_x64-setup.exe");
    assert.equal(picked["macos-universal"].name, "Glee_0.2.0_universal.dmg");
    assert.equal(pickInstallers([], "0.2.0")["windows-x64"], undefined);
  });
});

describe("buildManifest", () => {
  const input = {
    version: "0.2.0",
    repository: "example/glee",
    tag: "v0.2.0",
    releaseDate: "2000-01-01T00:00:00.000Z",
    notes: "Added:\n- Updates",
    files: { "windows-x64": file("Glee_0.2.0_x64-setup.exe"), "macos-universal": file("Glee_0.2.0_universal.dmg") },
  };

  it("builds the version 1 schema with release download URLs", () => {
    const manifest = buildManifest({ ...input, minSupportedVersion: "0.1.0" });
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.minSupportedVersion, "0.1.0");
    assert.equal(manifest.pageUrl, "https://github.com/example/glee/releases/tag/v0.2.0");
    assert.equal(manifest.assets["windows-x64"].url, "https://github.com/example/glee/releases/download/v0.2.0/Glee_0.2.0_x64-setup.exe");
    assert.equal(manifest.assets["macos-universal"].sha256, SHA);
    assert.equal("minSupportedVersion" in buildManifest(input), false);
  });

  it("rejects unsafe names, bad checksums, and missing platforms", () => {
    assert.throws(() => buildManifest({ ...input, files: { ...input.files, "windows-x64": file("../evil.exe") } }), /Unsafe/);
    assert.throws(() => buildManifest({ ...input, files: { ...input.files, "windows-x64": { ...file("a.exe"), sha256: "zz" } } }), /checksum/);
    assert.throws(() => buildManifest({ ...input, files: { "windows-x64": file("a.exe") } }), /required/);
  });
});

describe("validateManifestUrl", () => {
  it("accepts empty and https json URLs only", () => {
    assert.deepEqual(validateManifestUrl(""), []);
    assert.deepEqual(validateManifestUrl("https://github.com/example/glee/releases/latest/download/latest.json"), []);
    assert.notDeepEqual(validateManifestUrl("http://github.com/x/latest.json"), []);
    assert.notDeepEqual(validateManifestUrl("https://github.com/x/latest.txt"), []);
    assert.notDeepEqual(validateManifestUrl("nonsense"), []);
  });
});
