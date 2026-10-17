import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function readCargoVersion() {
  const cargo = fs.readFileSync(path.join(root, "src-tauri", "Cargo.toml"), "utf8");
  const packageSection = cargo.match(/\[package\]([\s\S]*?)(?:\n\[|$)/)?.[1] ?? "";
  const version = packageSection.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if (!version) {
    throw new Error("Could not read [package].version from src-tauri/Cargo.toml");
  }
  return version;
}

const versions = {
  packageJson: readJson("package.json").version,
  cargoToml: readCargoVersion(),
  tauriConfig: readJson("src-tauri/tauri.conf.json").version,
};

const unique = new Set(Object.values(versions));
if (unique.size !== 1) {
  throw new Error(`Release versions do not match: ${JSON.stringify(versions)}`);
}

const [version] = unique;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Release version is not valid SemVer: ${version}`);
}

console.log(`Release version verified: ${version}`);
