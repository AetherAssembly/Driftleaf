// Regenerates the product screenshots used by the README and the website, and doubles as an
// end-to-end smoke test of the renderer: it drives the real UI (through the web harness, in
// headless Firefox) from "create a branch" to a populated workspace and fails loudly if any
// step does not behave.
//
//   node scripts/dev/screenshots.mjs [output-directory]     (default: docs/screenshots)
//
// Needs Firefox on PATH (or FIREFOX=/path/to/firefox). Nothing is installed or downloaded:
// Firefox is driven over its built-in WebDriver BiDi endpoint with Node's own WebSocket.
// Everything it creates lives in temporary directories that are removed on exit.
//
// The harness renders with Firefox's engine, not the WebKit/WebView2 engine a release build
// uses, so treat a pass here as "the UI logic works", not as a substitute for clicking
// through a packaged build on each platform.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const outDir = path.resolve(process.argv[2] ?? path.join(root, "docs/screenshots"));
const APP_URL = "http://localhost:5183";
const BIDI_PORT = 9333;
const VIEWPORT = { width: 1440, height: 900 };
const PASSPHRASE = "screenshot-harness-passphrase";

const profileDir = await mkdtemp(path.join(os.tmpdir(), "driftleaf-screenshots-profile-"));
const children = [];
let failed = false;

function start(command, args, options = {}) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
  children.push(child);
  return child;
}

function waitForLine(child, pattern, label, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not become ready`)), timeoutMs);
    const onData = (chunk) => {
      if (!pattern.test(String(chunk))) return;
      clearTimeout(timer);
      resolve();
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => reject(new Error(`${label} exited early (${code})`)));
  });
}

async function cleanup() {
  for (const child of children) child.kill("SIGINT");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  for (const child of children) child.kill("SIGKILL");
  await rm(profileDir, { recursive: true, force: true }).catch(() => {});
}

// ---- minimal WebDriver BiDi client ----
class Bidi {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.type === "error") waiter.reject(new Error(`${message.error}: ${message.message}`));
      else waiter.resolve(message.result);
    });
  }

  static async connect(url, attempts = 40) {
    for (let attempt = 0; ; attempt++) {
      try {
        const socket = new WebSocket(url);
        await new Promise((resolve, reject) => {
          socket.addEventListener("open", resolve, { once: true });
          socket.addEventListener("error", reject, { once: true });
        });
        return new Bidi(socket);
      } catch (error) {
        if (attempt >= attempts) throw new Error("Could not connect to Firefox", { cause: error });
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

try {
  await mkdir(outDir, { recursive: true });

  const harness = start(process.execPath, [path.join(root, "scripts/dev/web-harness.mjs")], {
    cwd: root,
  });
  await waitForLine(harness, /ready in \d+/, "The web harness");

  const firefox = start(process.env.FIREFOX ?? "firefox", [
    "--headless",
    "--no-remote",
    "--profile",
    profileDir,
    `--remote-debugging-port=${BIDI_PORT}`,
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    "about:blank",
  ]);
  firefox.on("error", () => {});
  const bidi = await Bidi.connect(`ws://127.0.0.1:${BIDI_PORT}/session`);
  await bidi.send("session.new", { capabilities: {} });
  const { contexts } = await bidi.send("browsingContext.getTree", {});
  const context = contexts[0].context;
  await bidi.send("browsingContext.setViewport", { context, viewport: VIEWPORT, devicePixelRatio: 2 });

  // Runs an async function body in the page and returns its JSON-serialisable result. The
  // helpers every step needs are prepended so each step reads as plain UI instructions.
  async function page(body) {
    const expression = `(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const label = (b) => (b.getAttribute("aria-label") || b.textContent).trim();
      const button = (text, root = document) => {
        const found = [...root.querySelectorAll("button")].find((b) => label(b) === text);
        if (!found) throw new Error("No button labelled " + JSON.stringify(text));
        return found;
      };
      const until = async (check, what, timeoutMs = 15000) => {
        for (const started = Date.now(); Date.now() - started < timeoutMs; await sleep(100)) {
          const value = await check();
          if (value) return value;
        }
        throw new Error("Timed out waiting for " + what);
      };
      const setValue = (element, value) => {
        const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value").set.call(element, value);
        element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
      };
      const api = window.driftleaf;
      return JSON.stringify(await (async () => { ${body} })() ?? null);
    })()`;
    const response = await bidi.send("script.evaluate", {
      expression,
      target: { context },
      awaitPromise: true,
      resultOwnership: "none",
    });
    if (response.type === "exception") {
      throw new Error(`Page step failed: ${response.exceptionDetails.text}`);
    }
    return JSON.parse(response.result.value);
  }

  async function capture(name) {
    const { data } = await bidi.send("browsingContext.captureScreenshot", { context, origin: "viewport" });
    const file = path.join(outDir, name);
    await writeFile(file, Buffer.from(data, "base64"));
    console.log(`wrote ${path.relative(root, file)}`);
  }

  const navigate = () => bidi.send("browsingContext.navigate", { context, url: APP_URL, wait: "complete" });

  // ---- 1. create a branch through the real first-run flow ----
  await navigate();
  await page(`
    await until(() => document.querySelector("button"), "the unlock screen");
    button("Create a new branch").click();
    const field = await until(() => document.querySelector("input[type=password]"), "the passphrase field");
    setValue(field, ${JSON.stringify(PASSPHRASE)});
    button("Create branch").click();
    await sleep(300);
    button("I understand, create branch").click();
    await until(() => document.querySelector(".sidebar"), "the unlocked workspace", 30000);
    button("Got it").click();
    // Headless Firefox has no desktop theme to take scrollbar colours from and paints
    // them white; they are noise in a screenshot either way.
  `);
  const hideScrollbars = `
    const style = document.createElement("style");
    style.textContent = "* { scrollbar-width: none !important; }";
    document.head.append(style);
  `;

  // ---- 2. fill it with believable content through the same API the UI uses ----
  await page(`
    await api.settings.patch({ theme: "dark" });
    const drawing = document.createElement("canvas");
    drawing.width = 960; drawing.height = 420;
    const g = drawing.getContext("2d");
    g.fillStyle = "#16201a"; g.fillRect(0, 0, 960, 420);
    const bars = [120, 180, 150, 240, 210, 300, 270, 340];
    bars.forEach((height, index) => {
      g.fillStyle = index === bars.length - 1 ? "#78a886" : "#3a493d";
      g.fillRect(70 + index * 105, 360 - height, 70, height);
    });
    g.fillStyle = "#e5ece7"; g.font = "600 26px sans-serif";
    g.fillText("Words written per week", 70, 48);
    const png = await new Promise((resolve) => drawing.toBlob(resolve, "image/png"));
    const base64 = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1]);
      reader.readAsDataURL(png);
    });
    const chart = await api.attachments.add("words-per-week.png", "image/png", base64);

    for (const folder of ["Projects", "Projects/Field guide", "Journal", "Reading"]) {
      await api.folders.create(folder);
    }
    const write = async (folder, title, content) => {
      const meta = await api.notes.create(folder, title);
      await api.notes.write(meta.id, content);
      return meta;
    };
    await write("Reading", "The Overstory", "Notes on [[Chapter outline]].\\n\\n> What you make from a tree should be at least as miraculous as what you cut down.\\n");
    await write("Journal", "2026-11-12", "Walked the ridge trail. Ideas for [[Chapter outline]] below.\\n");
    await write("Projects/Field guide", "Research log", "See [[Chapter outline]] for where each source is used.\\n");
    const outline = await write("Projects/Field guide", "Chapter outline", [
      "# Chapter outline",
      "",
      "A working plan for the **field guide**. Sources live in [[Research log]]; day notes in [[2026-11-12]].",
      "",
      "## This week",
      "",
      "- [x] Draft the introduction",
      "- [x] Sort photographs by habitat",
      "- [ ] Rewrite the section on *lichens*",
      "- [ ] Send chapter two to Milo",
      "",
      "## Word count script",
      "",
      "\`\`\`python",
      "from pathlib import Path",
      "",
      "def count_words(folder: str) -> int:",
      '    """Total words across every Markdown chapter."""',
      '    return sum(len(p.read_text().split()) for p in Path(folder).glob("*.md"))',
      "\`\`\`",
      "",
      "## Progress",
      "",
      "![Words written per week](attachment:" + chart.id + ")",
      "",
    ].join("\\n"));
    const tasks = await api.databases.create("Chapters", "Projects/Field guide");
    await api.canvas.update([
      { id: crypto.randomUUID(), kind: "note", targetId: outline.id, x: 60, y: 50 },
      { id: crypto.randomUUID(), kind: "database", targetId: tasks.id, x: 420, y: 90 },
      ...(await api.notes.list())
        .filter((note) => ["Research log", "The Overstory", "2026-11-12"].includes(note.title))
        .map((note, index) => ({ id: crypto.randomUUID(), kind: "note", targetId: note.id, x: 120 + index * 330, y: 300 + (index % 2) * 60 })),
    ]);
    // The page is about to be reloaded; the backend session would otherwise stay unlocked.
    await api.vault.lock();
  `);

  // ---- 3. editor: reload so the sidebar and theme reflect what was just written ----
  await navigate();
  await page(`
    ${hideScrollbars}
    (await until(() => [...document.querySelectorAll("button")].find((b) => label(b) === "Reopen branch"), "the reopen button")).click();
    const field = await until(() => document.querySelector("input[type=password]"), "the passphrase field");
    setValue(field, ${JSON.stringify(PASSPHRASE)});
    button("Unlock").click();
    await until(() => document.querySelector(".sidebar"), "the unlocked workspace", 30000);
    button("Field guide folder").click();
    await sleep(300);
    (await until(() => [...document.querySelectorAll(".sidebar button")].find((b) => b.textContent.trim() === "Chapter outline"), "the note in the sidebar")).click();
    await until(() => document.querySelector(".cm-attachment img")?.naturalWidth > 0, "the attached image to render");
    await until(() => document.querySelectorAll(".cm-content span[class^='ͼ']").length > 3, "code highlighting");
    if (!document.querySelector(".cm-task-checkbox")) throw new Error("Task checkboxes did not render");
    if (!document.querySelector(".cm-wikilink[data-note-id]")) throw new Error("Wikilinks did not resolve");
    document.activeElement?.blur();
    await sleep(400);
    if (document.querySelector(".cm-line")?.textContent.startsWith("#")) {
      throw new Error("An unfocused note should not show raw Markdown on its first line");
    }
  `);
  await capture("editor.png");

  // ---- 4. canvas ----
  await page(`
    button("Open workspace canvas").click();
    await until(() => document.querySelectorAll(".canvas-card").length >= 4, "the canvas cards");
    await sleep(300);
  `);
  await capture("canvas.png");

  // ---- 5. Trash: delete through the UI, confirm it is recoverable ----
  await page(`
    button("Open workspace canvas").click();
    await sleep(200);
    (await until(() => [...document.querySelectorAll(".sidebar button")].find((b) => b.textContent.trim() === "Research log"), "a note to delete")).click();
    await until(() => document.querySelector(".editor__title")?.value === "Research log", "the note to open");
    button("Delete").click();
    await sleep(200);
    button("Move to Trash", [...document.querySelectorAll("dialog[open]")].pop()).click();
    await until(async () => (await api.trash.list()).length === 1, "the note to reach Trash");
    (await until(() => [...document.querySelectorAll("button")].find((b) => label(b) === "Open Trash, 1 item(s)"), "the Trash count in the sidebar")).click();
    await until(() => document.querySelector(".trash__item"), "the Trash list");
    await sleep(300);
  `);
  await capture("trash.png");
  await page(`
    button("Restore Research log").click();
    await until(async () => (await api.trash.list()).length === 0, "the note to be restored");
    if (!(await api.notes.list()).some((note) => note.title === "Research log")) throw new Error("Restore did not bring the note back");
  `);

  console.log("All UI steps passed.");
} catch (error) {
  failed = true;
  console.error(error instanceof Error ? error.message : error);
} finally {
  await cleanup();
  process.exit(failed ? 1 : 0);
}
