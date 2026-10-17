import { describe, expect, it, vi } from "vitest";
import { applyPack, loadPack, PACK_LIMITS, THEME_VARIABLES } from "./index";
import { checkCssValue } from "./css-value";
import type { PackTargets } from "./apply";

// The test environment has no Node typings, so load the stylesheet through a
// non-literal specifier and a narrow local type.
async function readAppCss(): Promise<string> {
  const specifier = "node:fs";
  const fs = (await import(/* @vite-ignore */ specifier)) as {
    readFileSync(path: string, encoding: string): string;
  };
  return fs.readFileSync("src/App.css", "utf8");
}

const meta = { schemaVersion: 1, name: "Test pack" };

function errorsOf(input: unknown): { path: string; message: string }[] {
  const result = loadPack(input);
  if (result.ok) {
    throw new Error("expected the pack to be rejected");
  }
  return result.errors;
}

function expectRejected(input: unknown, path: string, message?: RegExp): void {
  const errors = errorsOf(input);
  const hit = errors.find((e) => e.path === path);
  expect(hit, JSON.stringify(errors)).toBeDefined();
  if (message) {
    expect(hit?.message).toMatch(message);
  }
}

describe("envelope", () => {
  it("accepts JSON text and parsed values alike", () => {
    const pack = { ...meta, kind: "personas", personas: [{ name: "Riley" }] };
    expect(loadPack(JSON.stringify(pack)).ok).toBe(true);
    expect(loadPack(pack).ok).toBe(true);
  });

  it("reports invalid JSON, non-objects and oversize input without throwing", () => {
    expect(errorsOf("{nope")[0].message).toMatch(/Not valid JSON/);
    expect(errorsOf("[]")[0].message).toMatch(/JSON object/);
    expect(errorsOf(null)[0].message).toMatch(/JSON object/);
    expect(errorsOf("x".repeat(PACK_LIMITS.maxJsonChars + 1))[0].message).toMatch(/larger than/);
  });

  it("requires a known kind and a supported schemaVersion", () => {
    expectRejected({ ...meta, kind: "plugin" }, "kind");
    expectRejected({ name: "x", kind: "personas", personas: [{ name: "a" }] }, "schemaVersion", /Required/);
    expectRejected({ ...meta, schemaVersion: 2, kind: "personas", personas: [{ name: "a" }] }, "schemaVersion", /newer/);
    expectRejected({ ...meta, schemaVersion: 0, kind: "personas", personas: [{ name: "a" }] }, "schemaVersion", /Unsupported/);
    expectRejected({ ...meta, schemaVersion: "1", kind: "personas", personas: [{ name: "a" }] }, "schemaVersion");
  });

  it("rejects unknown top-level fields, including code-looking ones", () => {
    const base = { ...meta, kind: "personas", personas: [{ name: "a" }] };
    expectRejected({ ...base, script: "alert(1)" }, "script", /Unknown field/);
    expectRejected({ ...base, onLoad: "x" }, "onLoad");
    expectRejected({ ...base, entries: [] }, "entries");
  });

  it("validates metadata", () => {
    const base = { kind: "personas", personas: [{ name: "a" }] };
    expectRejected({ schemaVersion: 1, ...base }, "name");
    expectRejected({ ...meta, ...base, name: "n".repeat(101) }, "name", /limit/);
    expectRejected({ ...meta, ...base, version: "latest" }, "version");
    expectRejected({ ...meta, ...base, description: "d".repeat(1001) }, "description");
    const ok = loadPack({ ...meta, ...base, author: "Someone", version: "1.2.0", description: "Hi" });
    expect(ok).toMatchObject({ ok: true, pack: { author: "Someone", version: "1.2.0" } });
  });

  it("requires the payload", () => {
    expectRejected({ ...meta, kind: "characters" }, "characters", /Required/);
    expectRejected({ ...meta, kind: "characters", characters: [] }, "characters", /at least one/);
    expectRejected({ ...meta, kind: "characters", characters: "x" }, "characters", /list/);
  });

  it("rejects non-plain objects and prototype keys", () => {
    const polluted = JSON.parse('{"schemaVersion":1,"kind":"personas","name":"x","personas":[{"name":"a"}],"__proto__":{"x":1}}');
    expectRejected(polluted, "__proto__");
    expectRejected({ ...meta, kind: "personas", personas: [Object.create({ name: "a" })] }, "personas[0]");
  });
});

describe("character packs", () => {
  const card = {
    name: "Mira",
    description: "A harbour pilot.",
    personality: "Dry humour.",
    systemPrompt: "Stay in character.",
    greeting: "Tide's turning.",
    alternateGreetings: ["Hello again."],
    tags: ["sea", "mentor"],
    likes: ["tea"],
    exampleDialogue: "{{user}}: hi",
  };

  it("loads camelCase characters", () => {
    const result = loadPack({ ...meta, kind: "characters", characters: [card] });
    expect(result).toMatchObject({ ok: true, pack: { kind: "characters", characters: [card] } });
  });

  it("maps card-style snake_case aliases and the { spec, data } wrapper", () => {
    const result = loadPack({
      ...meta,
      kind: "characters",
      characters: [
        {
          spec: "chara_card_v2",
          data: {
            name: "Mira",
            first_mes: "Hi",
            mes_example: "ex",
            system_prompt: "sys",
            post_history_instructions: "post",
            creator_notes: "notes",
            alternate_greetings: ["a"],
            char_persona: "calm",
          },
        },
      ],
    });
    expect(result).toMatchObject({
      ok: true,
      pack: {
        characters: [
          {
            name: "Mira",
            greeting: "Hi",
            exampleDialogue: "ex",
            systemPrompt: "sys",
            postHistoryInstructions: "post",
            creatorNotes: "notes",
            alternateGreetings: ["a"],
            personality: "calm",
          },
        ],
      },
    });
  });

  it("rejects unknown and dangerous fields, avatars and card extensions", () => {
    const wrap = (c: unknown) => ({ ...meta, kind: "characters", characters: [c] });
    expectRejected(wrap({ ...card, avatar: "data:image/png;base64,AAAA" }), "characters[0].avatar", /Unknown/);
    expectRejected(wrap({ ...card, cardExtensions: {} }), "characters[0].cardExtensions");
    expectRejected(wrap({ ...card, extensions: { x: 1 } }), "characters[0].extensions");
    expectRejected(wrap({ ...card, character_book: {} }), "characters[0].character_book");
    expectRejected(wrap({ ...card, id: "stolen" }), "characters[0].id");
  });

  it("requires a name and rejects the same field given twice", () => {
    const wrap = (c: unknown) => ({ ...meta, kind: "characters", characters: [c] });
    expectRejected(wrap({ description: "x" }), "characters[0].name", /needs a name/);
    expectRejected(wrap({ name: "   " }), "characters[0].name", /empty/);
    expectRejected(wrap({ name: "a", greeting: "x", first_mes: "y" }), "characters[0].first_mes", /Duplicates/);
  });

  it("enforces size limits on text, lists and counts", () => {
    const wrap = (c: unknown) => ({ ...meta, kind: "characters", characters: [c] });
    expectRejected(wrap({ name: "a", description: "x".repeat(4001) }), "characters[0].description", /limit/);
    expectRejected(wrap({ name: "a".repeat(101) }), "characters[0].name");
    expectRejected(wrap({ name: "a", tags: Array(26).fill("t") }), "characters[0].tags", /limit/);
    expectRejected(wrap({ name: "a", tags: ["t".repeat(41)] }), "characters[0].tags[0]");
    expectRejected(wrap({ name: "a", alternateGreetings: Array(11).fill("hi") }), "characters[0].alternateGreetings");
    const many = Array.from({ length: PACK_LIMITS.maxCharacters + 1 }, (_, i) => ({ name: `c${i}` }));
    expectRejected({ ...meta, kind: "characters", characters: many }, "characters", /limit/);
  });

  it("rejects wrong types and control characters", () => {
    const wrap = (c: unknown) => ({ ...meta, kind: "characters", characters: [c] });
    expectRejected(wrap({ name: 5 }), "characters[0].name", /text/);
    expectRejected(wrap({ name: "a", tags: "sea" }), "characters[0].tags", /list/);
    expectRejected(wrap({ name: "a", tags: [1] }), "characters[0].tags[0]");
    expectRejected(wrap({ name: "a", description: "bad\u0000text" }), "characters[0].description", /control/);
    expectRejected(wrap({ name: "a", description: "rtl‮trick" }), "characters[0].description", /control/);
    expectRejected(wrap({ name: "multi\nline" }), "characters[0].name", /single line/);
    expectRejected(wrap("just text"), "characters[0]");
    expectRejected(wrap(null), "characters[0]");
  });

  it("normalises CRLF and keeps newlines in long text", () => {
    const result = loadPack({ ...meta, kind: "characters", characters: [{ name: "a", description: "x\r\ny" }] });
    expect(result).toMatchObject({ ok: true, pack: { characters: [{ description: "x\ny" }] } });
  });

  it("reports every problem in one pass but caps the list", () => {
    const characters = Array.from({ length: 40 }, () => ({ name: 1 }));
    const errors = errorsOf({ ...meta, kind: "characters", characters });
    expect(errors.length).toBe(PACK_LIMITS.maxIssues + 1);
    expect(errors[errors.length - 1]?.message).toMatch(/not shown/);
  });
});

describe("context packs", () => {
  const entry = { title: "The lighthouse", keywords: ["lighthouse", "beacon"], content: "It guards the bay." };

  it("loads entries with defaults", () => {
    const result = loadPack({ ...meta, kind: "context", entries: [entry] });
    expect(result).toMatchObject({
      ok: true,
      pack: { entries: [{ scope: "global", enabled: true, ...entry }] },
    });
  });

  it("requires a character name for character scope and forbids it otherwise", () => {
    const wrap = (e: unknown) => ({ ...meta, kind: "context", entries: [e] });
    expect(loadPack(wrap({ ...entry, scope: "character", characterName: "Mira" })).ok).toBe(true);
    expectRejected(wrap({ ...entry, scope: "character" }), "entries[0].characterName");
    expectRejected(wrap({ ...entry, characterName: "Mira" }), "entries[0].characterName", /Only allowed/);
    expectRejected(wrap({ ...entry, scope: "everything" }), "entries[0].scope");
  });

  it("enforces limits and types", () => {
    const wrap = (e: unknown) => ({ ...meta, kind: "context", entries: [e] });
    expectRejected(wrap({ ...entry, content: "x".repeat(4001) }), "entries[0].content");
    expectRejected(wrap({ ...entry, content: "" }), "entries[0].content", /empty/);
    expectRejected(wrap({ ...entry, keywords: Array(21).fill("k") }), "entries[0].keywords");
    expectRejected(wrap({ ...entry, enabled: "yes" }), "entries[0].enabled");
    expectRejected(wrap({ ...entry, id: "x" }), "entries[0].id");
    expectRejected(wrap({ ...entry, characterId: "x" }), "entries[0].characterId");
  });
});

describe("persona packs", () => {
  it("loads personas with empty defaults", () => {
    expect(loadPack({ ...meta, kind: "personas", personas: [{ name: "Captain", about: "Retired." }] })).toMatchObject({
      ok: true,
      pack: { personas: [{ name: "Captain", about: "Retired.", preferences: "" }] },
    });
  });

  it("rejects bad personas", () => {
    const wrap = (p: unknown) => ({ ...meta, kind: "personas", personas: [p] });
    expectRejected(wrap({ about: "x" }), "personas[0].name");
    expectRejected(wrap({ name: "a", about: "x".repeat(4001) }), "personas[0].about");
    expectRejected(wrap({ name: "a", avatar: "x" }), "personas[0].avatar");
    expectRejected(wrap([]), "personas[0]");
  });
});

describe("snippet packs", () => {
  const snippet = { id: "calm-tone", name: "Calm tone", text: "Keep a calm tone." };

  it("loads snippets, defaulting enabledByDefault to false", () => {
    expect(loadPack({ ...meta, kind: "snippets", snippets: [snippet] })).toMatchObject({
      ok: true,
      pack: { snippets: [{ ...snippet, enabledByDefault: false }] },
    });
  });

  it("rejects bad ids, long text, many lines, duplicates and unknown fields", () => {
    const wrap = (...s: unknown[]) => ({ ...meta, kind: "snippets", snippets: s });
    expectRejected(wrap({ ...snippet, id: "Bad Id" }), "snippets[0].id");
    expectRejected(wrap({ ...snippet, id: "../x" }), "snippets[0].id");
    expectRejected(wrap({ ...snippet, text: "x".repeat(401) }), "snippets[0].text");
    expectRejected(wrap({ ...snippet, text: "a\nb\nc\nd\ne" }), "snippets[0].text", /at most 4 lines/);
    expectRejected(wrap(snippet, snippet), "snippets[1].id", /Duplicate/);
    expectRejected(wrap({ ...snippet, run: "x" }), "snippets[0].run");
    expectRejected(wrap({ ...snippet, enabledByDefault: "true" }), "snippets[0].enabledByDefault");
  });
});

describe("theme packs", () => {
  const theme = (variables: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    ...meta,
    kind: "theme",
    theme: { variables, ...extra },
  });

  it("accepts colours, gradients, shadows, fonts and motion tokens", () => {
    const result = loadPack(
      theme(
        {
          "--bg": "#101418",
          "--text": "rgb(240, 240, 240)",
          "--surface": "rgba(255, 255, 255, 0.84)",
          "--surface-shell": "linear-gradient(180deg, #fffaf3 0, rgba(251, 243, 231, 0.78) 100%)",
          "--body-glow-left": "radial-gradient(circle, rgba(255, 240, 201, 0.84) 0, transparent 72%)",
          "--glass-panel": "var(--surface-shell)",
          "--shadow-sm": "0 12px 24px rgba(86, 59, 27, 0.08), 0 3px 10px rgba(73, 49, 20, 0.04)",
          "--shadow-inner": "inset 0 1px 0 rgba(255, 255, 255, 0.72)",
          "--font-body": '"Avenir Next", "Segoe UI", sans-serif',
          "--trans-fast": "140ms",
          "--ease-standard": "cubic-bezier(0.2, 0.8, 0.2, 1)",
          "--wordmark-color": "hsl(48 98% 52%)",
        },
        { base: "black", colorScheme: "dark" },
      ),
    );
    expect(result.ok).toBe(true);
  });

  it("accepts every value used by the built-in themes in the stylesheet", async () => {
    const css = await readAppCss();
    const blocks = [...css.matchAll(/^(?::root|html\[data-theme="[a-z]+"\])\s*\{([^}]*)\}/gm)];
    let checked = 0;
    for (const block of blocks) {
      for (const match of block[1].matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)) {
        const kind = THEME_VARIABLES[match[1]];
        if (!kind) {
          continue;
        }
        const normalised = match[2].replace(/\s+/g, " ").trim();
        expect(checkCssValue(kind, normalised), `${match[1]}: ${normalised}`).toEqual({ ok: true });
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(200);
  });

  it("keeps the whitelist in sync with the stylesheet", async () => {
    const css = await readAppCss();
    const declared = new Set(
      [...css.matchAll(/^\s*(--[\w-]+):/gm)].map((match) => match[1]),
    );
    for (const name of Object.keys(THEME_VARIABLES)) {
      expect(declared.has(name), `${name} is not declared in App.css`).toBe(true);
    }
  });

  it.each([
    ["url()", "url(https://evil.test/x.png)"],
    ["url with data", "url(data:image/svg+xml;base64,AAAA)"],
    ["uppercase URL", "URL( 'x' )"],
    ["spaced url", "u\\72l(x)"],
    ["expression()", "expression(alert(1))"],
    ["@import", "@import 'x.css'"],
    ["javascript scheme", "javascript:alert(1)"],
    ["semicolon injection", "red; background: url(x)"],
    ["brace injection", "red} body{display:none"],
    ["comment", "red /* hi */"],
    ["important", "red !important"],
    ["image-set", "image-set('a.png' 1x)"],
    ["element()", "element(#x)"],
    ["unknown function", "calc(1px + 2px)"],
    ["attr()", "attr(data-x)"],
    ["env()", "env(safe-area-inset-top)"],
    ["var of non-theme var", "var(--shell-rail-width)"],
    ["var with fallback", "var(--bg, url(x))"],
    ["unbalanced paren", "rgb(1, 2, 3"],
    ["extra close paren", "red)"],
    ["html", "<script>"],
    ["unknown keyword", "expressionish"],
    ["bad unit", "10vmax"],
    ["too deep", "rgb(rgb(rgb(rgb(rgb(1)))))"],
    ["bad hex", "#12"],
    ["empty", "   "],
  ])("rejects %s in a colour variable", (_name, value) => {
    expectRejected(theme({ "--bg": value }), "theme.variables.--bg");
  });

  it("rejects a url() hidden inside a gradient", () => {
    expectRejected(
      theme({ "--surface-shell": "linear-gradient(180deg, url(x), #fff)" }),
      "theme.variables.--surface-shell",
      /url\(\)/,
    );
  });

  it("rejects gradients in shadows and non-font strings in fonts", () => {
    expectRejected(theme({ "--shadow": "linear-gradient(#fff, #000)" }), "theme.variables.--shadow");
    expectRejected(theme({ "--font-body": "Arial; background:url(x)" }), "theme.variables.--font-body");
    expectRejected(theme({ "--font-body": '"A" "B"' }), "theme.variables.--font-body");
    expectRejected(theme({ "--trans-fast": "fast" }), "theme.variables.--trans-fast");
    expectRejected(theme({ "--ease-standard": "steps(4)" }), "theme.variables.--ease-standard");
  });

  it("rejects variables outside the whitelist, layout variables and non-variable keys", () => {
    expectRejected(theme({ "--shell-rail-width": "10px" }), "theme.variables.--shell-rail-width", /Not a themeable/);
    expectRejected(theme({ "--custom": "red" }), "theme.variables.--custom");
    expectRejected(theme({ "background": "red" }), "theme.variables.background");
    expectRejected(theme({ "--bg;x": "red" }), "theme.variables.--bg;x");
    expectRejected(theme({ constructor: "red" }), "theme.variables.constructor");
    expectRejected(theme({ toString: "red" }), "theme.variables.toString");
  });

  it("rejects bad containers, bases and sizes", () => {
    expectRejected(theme({}), "theme.variables", /at least one/);
    expectRejected({ ...meta, kind: "theme", theme: { variables: [] } }, "theme.variables");
    expectRejected(theme({ "--bg": "red" }, { base: "neon" }), "theme.base");
    expectRejected(theme({ "--bg": "red" }, { colorScheme: "auto" }), "theme.colorScheme");
    expectRejected(theme({ "--bg": "red" }, { css: ".x{}" }), "theme.css");
    expectRejected(theme({ "--bg": 5 }), "theme.variables.--bg", /text/);
    expectRejected(theme({ "--bg": "#" + "a".repeat(301) }), "theme.variables.--bg", /limit/);
    expectRejected({ ...meta, kind: "theme", theme: "dark" }, "theme");
  });

  it("trims accepted values", () => {
    expect(loadPack(theme({ "--bg": "  #fff  " }))).toMatchObject({
      ok: true,
      pack: { theme: { variables: { "--bg": "#fff" } } },
    });
  });
});

describe("applyPack", () => {
  function targets(): PackTargets & { calls: Record<string, unknown[]> } {
    const calls: Record<string, unknown[]> = {};
    const record = (name: string) => (item: unknown) => {
      (calls[name] ??= []).push(item);
      return Promise.resolve();
    };
    return {
      calls,
      createCharacter: record("character"),
      createContextEntry: record("context"),
      createPersona: record("persona"),
      setTheme: (theme, packName) => void record("theme")({ theme, packName }),
      registerSnippet: record("snippet"),
    };
  }

  function load(pack: unknown) {
    const result = loadPack(pack);
    if (!result.ok) {
      throw new Error(JSON.stringify(result.errors));
    }
    return result.pack;
  }

  it("routes each kind to its target", async () => {
    const t = targets();
    await applyPack(load({ ...meta, kind: "characters", characters: [{ name: "A" }, { name: "B" }] }), t);
    await applyPack(load({ ...meta, kind: "context", entries: [{ title: "T", content: "C" }] }), t);
    await applyPack(load({ ...meta, kind: "personas", personas: [{ name: "P" }] }), t);
    await applyPack(load({ ...meta, kind: "snippets", snippets: [{ id: "s", name: "S", text: "x" }] }), t);
    const report = await applyPack(load({ ...meta, kind: "theme", theme: { variables: { "--bg": "#fff" } } }), t);
    expect(t.calls.character).toHaveLength(2);
    expect(t.calls.context).toHaveLength(1);
    expect(t.calls.persona).toHaveLength(1);
    expect(t.calls.snippet).toEqual([expect.objectContaining({ id: "s", packName: "Test pack" })]);
    expect(t.calls.theme).toEqual([{ theme: { variables: { "--bg": "#fff" } }, packName: "Test pack" }]);
    expect(report).toEqual({ applied: 1, failed: [] });
  });

  it("keeps going after a failure and reports it", async () => {
    const t = targets();
    const createCharacter = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("duplicate name"))
      .mockResolvedValueOnce(undefined);
    const report = await applyPack(
      load({ ...meta, kind: "characters", characters: [{ name: "A" }, { name: "B" }, { name: "C" }] }),
      { ...t, createCharacter },
    );
    expect(createCharacter).toHaveBeenCalledTimes(3);
    expect(report).toEqual({ applied: 2, failed: [{ label: "B", error: "duplicate name" }] });
  });

  it("stringifies non-Error rejections", async () => {
    const t = targets();
    const report = await applyPack(load({ ...meta, kind: "personas", personas: [{ name: "P" }] }), {
      ...t,
      createPersona: () => Promise.reject("disk full"),
    });
    expect(report.failed).toEqual([{ label: "P", error: "disk full" }]);
  });
});
