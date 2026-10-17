#!/usr/bin/env node
// Tools for the AI resources pinned in src-tauri/resources/manifest.json.
//
//   node scripts/resources.mjs check
//       Validate the manifest (pinned hashes, https URLs, supported platforms).
//   node scripts/resources.mjs set-mirror <https://downloads.example.com/glee/>
//       Write a download mirror into the manifest (used by release builds).
//   node scripts/resources.mjs mirror <out-dir>
//       Download every file, verify it, and lay it out as <sha256>/<file name>,
//       ready to upload to the mirror (for example a Cloudflare R2 bucket).
//   node scripts/resources.mjs smoke [--eval]
//       Download this platform's model and engine, start llama-server with the
//       app's launch flags, and check chat, streaming, auth, and embeddings.

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const root = path.resolve(import.meta.dirname, "..");
const manifestPath = path.join(root, "src-tauri", "resources", "manifest.json");
const REQUIRED_PLATFORMS = ["windows-x64", "macos-arm64", "macos-x64"];

// Keep in sync with chat_server_args() in src-tauri/src/runtime_selection.rs.
const CHAT_ARGS = [
  "--ctx-size", "8192", "--parallel", "1", "--jinja", "--reasoning", "off",
  "--temp", "0.7", "--top-p", "0.8", "--top-k", "20", "--min-p", "0",
  "--presence-penalty", "1.5", "--repeat-penalty", "1.0", "--cache-ram", "512",
];

const readManifest = () => JSON.parse(readFileSync(manifestPath, "utf8"));
const allAssets = (manifest) => [...manifest.models, ...manifest.runtimes];
const notice = (title, message) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice title=${title}::${message.replaceAll("\n", "%0A")}` : `${title}: ${message}`);

function currentPlatform() {
  const os = { win32: "windows", darwin: "macos", linux: "linux" }[process.platform] ?? process.platform;
  const arch = { x64: "x64", arm64: "arm64" }[process.arch] ?? process.arch;
  return `${os}-${arch}`;
}

// Mirrors ResourceManifest::model_for in src-tauri/src/resources.rs.
function modelFor(manifest, role, platform) {
  return (
    manifest.models.find((model) => model.role === role && (model.platforms ?? []).includes(platform)) ??
    manifest.models.find((model) => model.role === role && !(model.platforms ?? []).length)
  );
}

function check() {
  const manifest = readManifest();
  const failures = [];
  if (manifest.schemaVersion !== 1) failures.push("schemaVersion must be 1");
  for (const mirror of manifest.mirrors ?? []) {
    if (!/^https:\/\/[^/]+\.[^/]+\//.test(mirror)) failures.push(`mirror must be an https URL ending in '/': ${mirror}`);
  }
  for (const role of ["chat", "embedding"]) {
    const defaults = manifest.models.filter((model) => model.role === role && !(model.platforms ?? []).length);
    if (defaults.length !== 1) failures.push(`exactly one default ${role} model is required`);
  }
  for (const asset of allAssets(manifest)) {
    const label = asset.id ?? asset.fileName;
    if (!/^[0-9a-f]{64}$/.test(asset.sha256) || /^0+$/.test(asset.sha256)) failures.push(`${label}: sha256 is not pinned`);
    if (!Number.isInteger(asset.sizeBytes) || asset.sizeBytes <= 0) failures.push(`${label}: sizeBytes must be positive`);
    if (!asset.url?.startsWith("https://")) failures.push(`${label}: url must use https`);
    if (!/^[A-Za-z0-9._-]+$/.test(asset.fileName)) failures.push(`${label}: unsafe fileName`);
  }
  for (const platform of REQUIRED_PLATFORMS) {
    if (!manifest.runtimes.some((runtime) => runtime.platform === platform && !runtime.optional)) {
      failures.push(`no required runtime for ${platform}`);
    }
  }
  if (failures.length) {
    console.error(failures.map((failure) => `- ${failure}`).join("\n"));
    process.exit(1);
  }
  console.log(`Resource manifest OK: ${manifest.models.length} models, ${manifest.runtimes.length} runtimes, ${(manifest.mirrors ?? []).length} mirrors.`);
}

function setMirror(url) {
  if (!url) {
    console.log("No mirror URL given; keeping upstream downloads only.");
    return;
  }
  const normalized = url.endsWith("/") ? url : `${url}/`;
  const manifest = readManifest();
  manifest.mirrors = [normalized];
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  check();
  console.log(`Mirror set to ${normalized}`);
}

async function sha256File(file) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

async function download(asset, destination) {
  if (existsSync(destination) && statSync(destination).size === asset.sizeBytes && (await sha256File(destination)) === asset.sha256) {
    return destination;
  }
  mkdirSync(path.dirname(destination), { recursive: true });
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(asset.url, { redirect: "follow" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const partial = `${destination}.part`;
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
      const size = statSync(partial).size;
      const digest = await sha256File(partial);
      if (size !== asset.sizeBytes || digest !== asset.sha256) {
        throw new Error(`integrity mismatch for ${asset.fileName}: size ${size} sha256 ${digest}`);
      }
      renameSync(partial, destination);
      return destination;
    } catch (error) {
      if (attempt === 3) throw error;
      console.warn(`retrying ${asset.fileName}: ${error.message}`);
    }
  }
}

async function mirror(outDir) {
  if (!outDir) throw new Error("usage: mirror <out-dir>");
  const manifest = readManifest();
  for (const asset of allAssets(manifest)) {
    const destination = path.join(outDir, asset.sha256, asset.fileName);
    await download(asset, destination);
    console.log(`ok ${asset.sha256}/${asset.fileName}`);
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`))));
  });
}

async function waitForHealth(port, child, label) {
  for (let i = 0; i < 240; i++) {
    if (child.exitCode !== null) throw new Error(`${label} server exited with code ${child.exitCode}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} server did not become healthy`);
}

async function smoke({ runEval }) {
  const manifest = readManifest();
  const platform = currentPlatform();
  const runtime = manifest.runtimes.find((entry) => entry.platform === platform && !entry.optional);
  if (!runtime) throw new Error(`no required runtime for ${platform}`);
  const work = path.join(root, ".artifacts", "smoke");
  const chat = modelFor(manifest, "chat", platform);
  const embedding = modelFor(manifest, "embedding", platform);
  const started = Date.now();
  const archive = await download(runtime, path.join(work, runtime.fileName));
  const chatModel = await download(chat, path.join(work, chat.fileName));
  const embeddingModel = await download(embedding, path.join(work, embedding.fileName));
  notice("downloads verified", `${platform}: ${runtime.fileName}, ${chat.fileName}, ${embedding.fileName} in ${Math.round((Date.now() - started) / 1000)}s`);

  const engineDir = path.join(work, runtime.id);
  mkdirSync(engineDir, { recursive: true });
  if (runtime.archive === "zip") {
    if (process.platform === "win32") {
      await run("powershell", ["-NoProfile", "-Command", `Expand-Archive -Force -Path '${archive}' -DestinationPath '${engineDir}'`]);
    } else {
      await run("unzip", ["-o", "-q", archive, "-d", engineDir]);
    }
  } else {
    await run("tar", ["-xzf", archive, "-C", engineDir]);
  }
  const server = path.join(engineDir, runtime.entrypoint);

  const key = randomBytes(24).toString("hex");
  const keyFile = path.join(work, "server.key");
  writeFileSync(keyFile, key);
  const port = 18080;
  const offload = runtime.backend === "cpu" ? ["-ngl", "0"] : [];
  const chatServer = spawn(server, ["-m", chatModel, "--host", "127.0.0.1", "--port", String(port), "--api-key-file", keyFile, "--no-webui", "--no-slots", ...CHAT_ARGS, ...offload], {
    cwd: path.dirname(server),
    stdio: ["ignore", "inherit", "inherit"],
  });
  const embedServer = spawn(server, ["-m", embeddingModel, "--host", "127.0.0.1", "--port", String(port + 1), "--embeddings", "--pooling", "cls", "-ngl", "0", "--no-webui"], {
    cwd: path.dirname(server),
    stdio: ["ignore", "ignore", "inherit"],
  });
  try {
    await waitForHealth(port, chatServer, "chat");
    await waitForHealth(port + 1, embedServer, "embedding");
    const endpoint = `http://127.0.0.1:${port}/v1/chat/completions`;
    const unauthorized = await fetch(endpoint, { method: "POST" });
    if (unauthorized.status !== 401) throw new Error(`expected 401 without the API key, got ${unauthorized.status}`);
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${key}` };
    const body = {
      messages: [
        { role: "system", content: "You are Nova, a warm, perceptive companion. Stay in character and reply in two or three sentences." },
        { role: "user", content: "I had a rough day at work. Can you cheer me up?" },
      ],
      max_tokens: 160,
    };
    const reply = await (await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) })).json();
    const text = reply.choices?.[0]?.message?.content ?? "";
    if (text.trim().length < 20 || /<think>/i.test(text)) throw new Error(`unexpected reply: ${JSON.stringify(reply).slice(0, 400)}`);
    notice("chat reply", `${text.trim().slice(0, 600)}\ntimings ${JSON.stringify(reply.timings)}`);

    const streamed = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ ...body, stream: true }) });
    const streamText = await streamed.text();
    const deltas = streamText.split("\n").filter((line) => line.startsWith("data: {")).length;
    if (deltas < 5 || !streamText.includes("[DONE]")) throw new Error(`streaming looked wrong: ${streamText.slice(0, 300)}`);

    const embeddingResponse = await (await fetch(`http://127.0.0.1:${port + 1}/v1/embeddings`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input: "hello world" }),
    })).json();
    const dimensions = embeddingResponse.data?.[0]?.embedding?.length ?? 0;
    if (dimensions !== 384) throw new Error(`expected 384 embedding dimensions, got ${dimensions}`);
    notice("smoke passed", `${platform}: chat, streaming (${deltas} chunks), auth, and ${dimensions}-d embeddings OK`);

    if (runEval) {
      await run(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["exec", "vitest", "run", "--config", "vitest.eval.config.ts"], {
        cwd: root,
        shell: process.platform === "win32",
        env: { ...process.env, GLEE_MODEL_EVAL_ENDPOINT: `http://127.0.0.1:${port}`, GLEE_MODEL_EVAL_API_KEY: key },
      });
      notice("eval passed", "Glee's prompt pipeline produced accepted replies from the shipped model");
    }
  } finally {
    chatServer.kill();
    embedServer.kill();
  }
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === "check") check();
  else if (command === "set-mirror") setMirror(rest[0]);
  else if (command === "mirror") await mirror(rest[0]);
  else if (command === "smoke") await smoke({ runEval: rest.includes("--eval") });
  else {
    console.error("usage: resources.mjs check | set-mirror <url> | mirror <out-dir> | smoke [--eval]");
    process.exit(2);
  }
} catch (error) {
  console.error(process.env.GITHUB_ACTIONS ? `::error title=resources ${command}::${String(error.message ?? error).replaceAll("\n", "%0A")}` : error);
  process.exit(1);
}
