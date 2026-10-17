// Diagnostic: which llama-server configurations give coherent Bonsai replies on this machine?
import { spawn } from "node:child_process";
import path from "node:path";

const [server, ...models] = process.argv.slice(2);
const notice = (title, message) => console.log(`::notice title=${title}::${message.replaceAll("\n", "%0A").slice(0, 3800)}`);
const BASE = ["--ctx-size", "8192", "--parallel", "1", "--jinja", "--reasoning", "off", "--temp", "0", "--no-webui"];
const CONFIGS = [
  ["metal", []],
  ["fa-off", ["-fa", "off"]],
  ["ub1", ["-ub", "1", "-b", "1"]],
  ["cpu", ["-ngl", "0", "--device", "none"]],
];
let port = 19100;
let printedDevice = false;
for (const model of models) {
  for (const [name, extra] of CONFIGS) {
    port += 1;
    let log = "";
    const child = spawn(server, ["-m", model, "--host", "127.0.0.1", "--port", String(port), ...BASE, ...extra], {
      cwd: path.dirname(server), stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (d) => (log += d));
    child.stderr.on("data", (d) => (log += d));
    let result;
    try {
      let healthy = false;
      for (let i = 0; i < 600 && child.exitCode === null; i++) {
        try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { healthy = true; break; } } catch {}
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!healthy) throw new Error(`not healthy (exit ${child.exitCode})`);
      const t0 = Date.now();
      const reply = await (await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [
            { role: "system", content: "You are Nova, a warm, perceptive companion. Stay in character and reply in two or three sentences." },
            { role: "user", content: "I had a rough day at work. Can you cheer me up?" },
          ],
          max_tokens: 80,
        }),
      })).json();
      result = `${Date.now() - t0}ms ${JSON.stringify(reply.choices?.[0]?.message?.content ?? reply).slice(0, 300)} timings=${JSON.stringify(reply.timings)}`;
    } catch (error) {
      result = `ERROR ${error.message}`;
    } finally {
      child.kill();
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (!printedDevice) {
      printedDevice = true;
      notice("device", log.split("\n").filter((l) => /metal|gpu|simdgroup|bfloat|unified|flash|fa |offload|backend|residency|tensor api|family/i.test(l)).slice(0, 40).join("\n"));
    }
    notice(`${path.basename(model)} ${name}`, `${result}\n${log.split("\n").filter((l) => /error|warn|fail|unsupported|fallback/i.test(l)).slice(0, 8).join("\n")}`);
  }
}
