// Drives DayDream mode (stored as "planning") in headless Chrome over CDP, next to the build from before it existed.
// Usage: node scripts/e2e-planning.js   (OLD_REF=<commit> picks the old build, SHOTS=<dir> also saves screenshots, ONLY=<text> runs only scenarios whose name contains it)
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// Pinned to the last commit before this feature: "main" stops being the old build once this branch merges.
const OLD_REF = process.env.OLD_REF || "dd49bba";
const SHOTS = process.env.SHOTS || "";
const ONLY = process.env.ONLY || "";
const DD_ACCENT = "#6f83df";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "studyflow-e2e-"));
let failures = 0;
let total = 0;
const check = (name, ok, detail = "") => {
  total++;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : " :: " + detail}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const errors = [];

async function scenario(name, run) {
  if (!name.includes(ONLY)) return;
  try {
    await run();
  } catch (err) {
    check(`${name} (scenario threw)`, false, String(err.message).split("\n")[0]);
  }
}

function serve() {
  const old = execFileSync("git", ["show", `${OLD_REF}:index.html`], { cwd: ROOT, maxBuffer: 64 << 20 });
  const types = { ".html": "text/html; charset=utf-8", ".txt": "text/plain", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png" };
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p === "/old-build.html") return res.writeHead(200, { "content-type": types[".html"] }).end(old);
    // No service worker in the test: it would answer reloads from its cache.
    const file = path.join(ROOT, p === "/" ? "index.html" : p);
    if (p === "/sw.js" || !file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" }).end(fs.readFileSync(file));
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

async function attach(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) pending.get(msg.id)(msg);
    if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") errors.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
  };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "eval failed: " + expr.slice(0, 120));
    return r.result.result.value;
  };
  const q = (sel, n = 0) => `document.querySelectorAll(${JSON.stringify(sel)})[${n}]`;
  const center = async (sel, n = 0) => {
    const p = await ev(`(() => { const el = ${q(sel, n)}; if (!el) return null; el.scrollIntoView({ block: "center" }); const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
    if (!p) throw new Error(`no element ${sel}[${n}]`);
    return p;
  };
  const mouse = (type, p, buttons) => send("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button: type === "mouseMoved" && !buttons ? "none" : "left", buttons, clickCount: 1 });
  const page = {
    send, ev, close: () => ws.close(),
    click: async (sel, n = 0) => {
      if (!(await ev(`!!${q(sel, n)}`))) throw new Error(`nothing to click: ${sel}[${n}]`);
      await ev(`${q(sel, n)}.click()`);
      await sleep(120);
    },
    text: (sel, n = 0) => ev(`${q(sel, n)}?.textContent.trim() ?? null`),
    texts: (sel) => ev(`[...document.querySelectorAll(${JSON.stringify(sel)})].map((e) => e.textContent.trim())`),
    count: (sel) => ev(`document.querySelectorAll(${JSON.stringify(sel)}).length`),
    value: (sel) => ev(`${q(sel)}?.value ?? null`),
    setValue: (sel, v) => ev(`(() => { const el = ${q(sel)}; el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); })()`),
    ls: (key) => ev(`JSON.parse(localStorage.getItem(${JSON.stringify(key)}))`),
    nav: (p) => page.click(`.nav[data-page="${p}"]`),
    async tap(sel, n = 0) {
      const p = await center(sel, n);
      await mouse("mouseMoved", p);
      await mouse("mousePressed", p, 1);
      await mouse("mouseReleased", p, 0);
      await sleep(150);
    },
    type: async (text) => { await send("Input.insertText", { text }); await sleep(60); },
    async press(key) {
      const base = { key, code: key, windowsVirtualKeyCode: { Enter: 13, Escape: 27 }[key] };
      await send("Input.dispatchKeyEvent", key === "Enter" ? { type: "keyDown", text: "\r", ...base } : { type: "rawKeyDown", ...base });
      await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
      await sleep(150);
    },
    async load(url) {
      await send("Page.navigate", { url });
      await page.ready();
    },
    async reload() {
      await send("Page.reload");
      await sleep(150);
      await page.ready();
    },
    async ready() {
      for (let i = 0; i < 80; i++) {
        if (await ev(`document.readyState === "complete" && !!window.__mode`).catch(() => false)) return sleep(250);
        await sleep(100);
      }
      throw new Error("app did not boot");
    },
    snapshot: () => ev(`Object.fromEntries(Object.keys(localStorage).filter((k) => k.startsWith("studyflow")).map((k) => [k, localStorage.getItem(k)]))`),
    async putSnapshot(snap) {
      await ev(`(() => { const s = ${JSON.stringify(snap)}; Object.keys(localStorage).filter((k) => k.startsWith("studyflow")).forEach((k) => localStorage.removeItem(k)); Object.entries(s).forEach(([k, v]) => localStorage.setItem(k, v)); })()`);
      await page.reload();
    },
    // Empties this origin, writes the given keys (objects are stored as JSON) and boots the build at url.
    async fresh(url, keys = {}) {
      await page.load(url);
      await ev(`(async () => {
        localStorage.clear();
        await new Promise((r) => { const d = indexedDB.deleteDatabase("studyflow"); d.onsuccess = d.onerror = d.onblocked = r; });
        const keys = ${JSON.stringify(keys)};
        for (const [k, v] of Object.entries(keys)) localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v));
      })()`);
      await page.reload();
    },
    // Never opens the database itself: opening it before the app does would create it without the photo store.
    photos: () => ev(`(async () => {
      if (!(await indexedDB.databases()).some((d) => d.name === "studyflow")) return [];
      const db = await new Promise((r, j) => { const o = indexedDB.open("studyflow"); o.onsuccess = () => r(o.result); o.onerror = () => j(o.error); });
      try {
        if (!db.objectStoreNames.contains("photos")) return [];
        const st = db.transaction("photos").objectStore("photos");
        const all = (req) => new Promise((r) => { req.onsuccess = () => r(req.result); });
        const [keys, vals] = [await all(st.getAllKeys()), await all(st.getAll())];
        return keys.map((k, i) => ({ id: k, type: vals[i].blob?.type, size: vals[i].blob?.size, orphanedAt: vals[i].orphanedAt ?? null }));
      } finally { db.close(); }
    })()`),
    agePhoto: (id, days) => ev(`(async () => {
      const db = await new Promise((r) => { const o = indexedDB.open("studyflow"); o.onsuccess = () => r(o.result); });
      await new Promise((r) => { const tx = db.transaction("photos", "readwrite"), st = tx.objectStore("photos"), g = st.get(${JSON.stringify(id)}); g.onsuccess = () => st.put({ ...g.result, orphanedAt: Date.now() - ${days} * 864e5 }, ${JSON.stringify(id)}); tx.oncomplete = r; });
      db.close();
    })()`),
    async pickPhoto() {
      await ev(`(async () => {
        const c = document.createElement("canvas"); c.width = 2400; c.height = 1200; c.getContext("2d").fillRect(0, 0, 2400, 1200);
        const blob = await new Promise((r) => c.toBlob(r, "image/png"));
        const dt = new DataTransfer(); dt.items.add(new File([blob], "big.png", { type: "image/png" }));
        const input = document.querySelector("#memoryPhoto"); input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true }));
      })()`);
      await sleep(600);
    },
    async submit(sel) { await ev(`document.querySelector(${JSON.stringify(sel)}).requestSubmit()`); await sleep(250); },
    async newPlan(fields) {
      await page.click("#addPlan");
      for (const [name, v] of Object.entries(fields)) await page.setValue(`#modalForm [name="${name}"]`, v);
      await page.submit("#modalForm");
    },
    async addTodo(scope, planId, title) {
      await page.setValue(`${scope} form[data-todo-add="${planId}"] input[name=title]`, title);
      await page.submit(`${scope} form[data-todo-add="${planId}"]`);
    },
    async saveMemory(fields, photo = false) {
      if (photo) await page.pickPhoto();
      for (const [sel, v] of Object.entries(fields)) await page.setValue(sel, v);
      await page.submit("#memoryForm");
      await sleep(500);
    },
    themeVars: () => ev(`(() => { const h = getComputedStyle(document.documentElement), b = getComputedStyle(document.body); const o = { theme: document.documentElement.dataset.theme ?? null, bodyBg: b.backgroundImage, bodyColor: b.color, font: b.fontFamily }; for (const v of ["--blue", "--page-bg", "--page-bg-2", "--card-bg", "--card-solid", "--text-color", "--ink", "--muted", "--line", "--accent-ink", "--k-hw", "--k-event", "--k-plan"]) o[v] = h.getPropertyValue(v).trim(); return o; })()`),
    async setMode(m) { await page.nav("settings"); await page.click(`#modeSeg [data-mode="${m}"]`); await sleep(250); },
    async shot(file, width, height) {
      await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 700 });
      await sleep(350);
      const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
      fs.writeFileSync(file, Buffer.from(r.result.data, "base64"));
    },
  };
  await send("Runtime.enable");
  await send("Page.enable");
  return page;
}

async function devtoolsPort() {
  const file = path.join(profile, "DevToolsActivePort");
  for (let i = 0; i < 100; i++) {
    if (fs.existsSync(file)) {
      const port = fs.readFileSync(file, "utf8").split("\n")[0].trim();
      if (port) return port;
    }
    await sleep(100);
  }
  throw new Error("Chrome did not write DevToolsActivePort");
}

// What a student sees and can do with calendar events in one mode. Run on both builds and compared.
async function eventProbe(A, url, mode, seed) {
  await A.fresh(url, { ...seed, studyflowMode: mode });
  const out = {};
  out.first = { chips: await A.texts(".day.today .chip"), trash: await A.texts("#trashList h4") };
  const pages = await A.ev(`[...document.querySelectorAll(".nav[data-page]")].filter((b) => !b.hidden).map((b) => b.dataset.page)`);
  pages.sort();
  out.nav = pages;
  out.titles = [];
  for (const p of pages) {
    await A.nav(p);
    out.titles.push([p, await A.text("#eyebrow"), await A.text("#pageTitle"), await A.text("#pageSubtitle")]);
  }
  await A.nav("dashboard");
  out.tiles = await A.ev(`["#dashStats", "#dashWorkStats", "#dashPlanStats", "#dashColumns", "#dashWork", "#dashPlan"].map((s) => { const e = document.querySelector(s); return e.offsetParent === null ? null : e.innerText; })`);
  out.look = await A.themeVars();
  await A.nav("calendar");
  const form = () => A.ev(`[document.querySelector("#modalTitle").textContent, ...[...document.querySelectorAll("#modalFields label")].map((l) => { const i = l.querySelector("input,select,textarea"); return [l.textContent.trim(), i.name, i.type, i.required, i.name === "date" ? "<date>" : i.value]; })]`);
  out.calHead = [await A.text("#calSub"), await A.text("#addCalEvent"), await A.ev(`document.querySelector("#calLegend").innerText`)];
  await A.click("#addCalEvent");
  out.form1 = await form();
  out.modalBox = await A.ev(`(() => { const s = getComputedStyle(document.querySelector("#modalBg .modal")); return [s.maxHeight, s.overflowY, s.borderRadius]; })()`);
  await A.setValue('#modalForm [name="title"]', "Probe A");
  await A.setValue('#modalForm [name="start"]', "15:00");
  await A.setValue('#modalForm [name="note"]', "Room 4");
  await A.submit("#modalForm");
  out.day1 = await A.ev(`document.querySelector("#calDay").innerText`);
  await A.click("#calDayAdd");
  out.form2 = await form();
  await A.setValue('#modalForm [name="title"]', "Probe B");
  await A.submit("#modalForm");
  out.day2 = await A.ev(`document.querySelector("#calDay").innerText`);
  out.chips = await A.ev(`[...document.querySelectorAll(".day.today .chip")].map((c) => [c.textContent, c.title, c.className])`);
  await A.click("#calDay [data-cal-event-del]");
  out.day3 = await A.ev(`document.querySelector("#calDay").innerText`);
  out.toast = await A.text("#toast");
  out.events = (await A.ls("studyflowEvents")).map(({ id, date, ...e }) => e);
  out.trash = (await A.ls("studyflowTrash")).map((t) => [t.kind, t.label, t.mode, Object.keys(t.data).sort().join()]);
  await A.nav("settings");
  out.trashShown = await A.texts("#trashList h4");
  return out;
}

async function main() {
  const server = await serve();
  const BASE = `http://127.0.0.1:${server.address().port}`;
  const NEW = `${BASE}/index.html`;
  const OLD = `${BASE}/old-build.html`;
  const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--window-size=1280,900", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "about:blank"], { stdio: "ignore" });
  try {
    const port = await devtoolsPort();
    const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page");
    const A = await attach(target.webSocketDebuggerUrl);
    await A.load(NEW);
    const today = await A.ev(`iso(new Date())`);
    const inDays = (n) => A.ev(`plus(${n})`);
    const planning = { studyflowMode: "planning" };
    const seedV1 = {
      ...planning,
      studyflowPlanning: { v: 1, todos: [{ id: 11, title: "Buy stamps", due: await inDays(2), priority: "High", note: "post office", done: false }, { id: 12, title: "Call grandma", due: "", priority: "Medium", note: "", done: true }] },
      studyflowEvents: [
        { id: 21, title: "Dentist", date: await inDays(3), start: "15:00", end: "16:00", note: "Dr. Lee", mode: "planning" },
        { id: 22, title: "Legacy picnic", date: await inDays(9), start: "", end: "", note: "" },
        { id: 23, title: "Parent night", date: await inDays(4), start: "", end: "", note: "", mode: "school" },
        { id: 24, title: "Staff meeting", date: await inDays(5), start: "", end: "", note: "", mode: "work" },
      ],
    };
    const planTitles = () => A.texts("#planGrid .dd-plan-title");
    const planByTitle = async (t) => (await A.ls("studyflowEvents")).find((e) => e.title === t);

    await scenario("[7] School and Work are unchanged", async () => {
      const ev = (id, title, mode, more = {}) => ({ id, title, date: today, start: "", end: "", note: "", ...(mode ? { mode } : {}), ...more });
      const gone = (id, title, mode) => ({ id: "t" + id, kind: "pevent", label: title, data: ev(id, title, mode), at: Date.now() - 864e5, mode });
      const seed = {
        studyflowEvents: [ev(41, "School fair", "school", { start: "10:00", note: "Gym" }), ev(42, "Inventory", "work"), ev(43, "Beach day", "planning", { type: "trip", place: "Pier", emoji: "🏖️" }), ev(44, "Old picnic")],
        studyflowPlanning: { v: 1, todos: [{ id: 51, title: "Buy film", due: today, priority: "Medium", note: "", done: false }] },
        studyflowTrash: [gone(61, "School trash", "school"), gone(62, "Work trash", "work"), gone(63, "Plan trash", "planning")],
      };
      const own = { school: ["School fair", "School trash"], work: ["Inventory", "Work trash"] };
      for (const mode of ["school", "work"]) {
        const before = await eventProbe(A, OLD, mode, seed);
        const after = await eventProbe(A, NEW, mode, seed);
        const [event, trash] = own[mode];
        check(`[7] ${mode}: the first draw after loading shows only this section's event and Recently deleted`, after.first.chips.length === 1 && after.first.chips[0].includes(event) && same(after.first.trash, [trash]), JSON.stringify(after.first));
        if (!same(before.first, after.first)) console.log(`INFO ${mode}: the old build's first draw showed ${JSON.stringify(before.first)}, the new build's ${JSON.stringify(after.first)}`);
        for (const k of Object.keys(before)) if (k !== "first" || mode === "school") {
          // Pages may be added, so for the page list and titles every old page must still be there, unchanged.
          const kept = k === "nav" || k === "titles" ? before[k].every((x) => after[k].some((y) => same(x, y))) : same(before[k], after[k]);
          check(`[7] ${mode}: ${k} ${k === "nav" || k === "titles" ? "still has everything the old build had" : "matches the old build"}`, kept, `old ${JSON.stringify(before[k])} new ${JSON.stringify(after[k])}`);
        }
      }
    });

    await scenario("undated plan on the old build", async () => {
      const before = errors.length;
      await A.fresh(OLD, { ...planning, studyflowEvents: [{ id: 31, title: "Someday trip", date: "", start: "", end: "", note: "", mode: "planning", type: "trip", place: "Kyoto", emoji: "🏖️" }] });
      for (const p of ["plan", "calendar", "dashboard", "focus", "plan"]) await A.nav(p);
      for (const r of ["all", "past", "upcoming"]) await A.setValue("#planEventRange", r);
      await A.setValue("#planEventRange", "all");
      const row = await A.text("#planEventList");
      check("old build renders an undated plan without throwing", errors.length === before && row.includes("Someday trip"), `${errors.slice(before).join(" | ")} row=${row}`);
      console.log(`INFO old build shows an undated plan as: ${JSON.stringify(row)}`);
      errors.length = before;
    });

    await scenario("[name] the mode is called DayDream", async () => {
      await A.fresh(NEW, planning);
      check("[name] mode button reads DayDream", (await A.text('#modeSeg [data-mode="planning"]')) === "DayDream");
      check("[name] the name at the top reads DayDream", (await A.text(".brand b")) === "DayDream");
      const logo = () => A.ev(`({ hat: document.querySelector("#hat").innerHTML.length, label: document.querySelector("#hat").getAttribute("aria-label"), tab: [...document.querySelectorAll("link[rel=icon]")].map((l) => l.getAttribute("href")), title: document.title })`);
      const ddLogo = await logo();
      check("[name] the tab shows the DayDream logo and title", ddLogo.tab.every((h) => h.startsWith("data:image/svg+xml,")) && decodeURIComponent(ddLogo.tab[0]).includes("#6f83df") && ddLogo.title === "DayDream — Planner" && ddLogo.label === "DayDream logo", JSON.stringify(ddLogo).slice(0, 300));
      await A.setMode("school");
      const schoolLogo = await logo();
      check("[name] School gets the StudyFlow logo and tab back", same(schoolLogo.tab, ["icons/icon.svg", "icons/icon-192.png"]) && schoolLogo.title === "StudyFlow — Planner" && schoolLogo.label === "StudyFlow logo" && schoolLogo.hat !== ddLogo.hat, JSON.stringify(schoolLogo).slice(0, 300));
      await A.setMode("planning");
      await A.click('[data-set-tab="appearance"]');
      await A.click('[data-dd-color="mint"]');
      check("[name] the tab logo follows the DayDream color", decodeURIComponent((await logo()).tab[0]).includes("#45b394"));
      await A.click('[data-dd-color="lavender"]');
      await A.setMode("school");
      check("[name] the name at the top reads StudyFlow in School", (await A.text(".brand b")) === "StudyFlow");
      await A.setMode("work");
      check("[name] the name at the top reads StudyFlow in Work", (await A.text(".brand b")) === "StudyFlow");
      await A.setMode("planning");
      check("[name] eyebrow says DayDream", /DAYDREAM/.test(await A.text("#eyebrow")), await A.text("#eyebrow"));
      const nav = await A.ev(`[...document.querySelectorAll(".nav[data-page]")].filter((b) => !b.hidden).map((b) => b.textContent.trim())`);
      check("[name] nav is Home, My Plans, Calendar, Checklists, Budget Planner, Digital Journal, AI, Settings", same([...nav].sort(), ["AI", "Budget Planner", "Calendar", "Checklists", "Digital Journal", "Home", "My Plans", "Settings"]), JSON.stringify(nav));
      const visible = await A.ev(`document.body.innerText`);
      for (const p of ["dashboard", "plan", "calendar", "journal", "checklists", "settings", "assistant"]) {
        await A.nav(p);
        const t = await A.ev(`document.querySelector("main").innerText`);
        check(`[name] no visible "Planning" on ${p}`, !/\bPlanning\b/.test(t), (t.match(/.{0,40}\bPlanning\b.{0,40}/) || [""])[0]);
      }
      check("[name] stored mode is still planning", (await A.ev(`localStorage.getItem("studyflowMode")`)) === "planning" && visible.length > 0);
    });

    await scenario("[look] DayDream palette comes and goes with the mode", async () => {
      const designs = {
        mint: { accent: "#2fa57c", background: "#e6f7ef", background2: "#dff3ea", cards: "#ffffff", text: "#1f4a3c" },
        night: { accent: "#8ea8ff", background: "#0f1535", background2: "#1a2150", cards: "#1b2347", text: "#e8ecff" },
      };
      for (const [name, colors] of Object.entries(designs)) {
        await A.fresh(NEW, { studyflowMode: "school", studyflowColors: colors });
        const savedColors = await A.ev(`localStorage.getItem("studyflowColors")`);
        const before = await A.themeVars();
        check(`[look] ${name}: School starts on the student's design`, before.theme === name && before["--blue"] === colors.accent, JSON.stringify(before));
        await A.setMode("planning");
        const dd = await A.themeVars();
        check(`[look] ${name}: DayDream mode shows DayDream's accent`, dd["--blue"] === DD_ACCENT && dd.theme === "daydream", JSON.stringify(dd));
        const lum = await A.ev(`(() => { const p = (s) => s.match(/[\\d.]+/g).slice(0, 3).map(Number); const [r, g, b] = p(getComputedStyle(document.querySelector(".card")).backgroundColor); const [x, y, z] = p(getComputedStyle(document.querySelector(".card")).color); return [(r + g + b) / 3, (x + y + z) / 3]; })()`);
        check(`[look] ${name}: DayDream mode is light cards with dark text`, lum[0] > 230 && lum[1] < 110, JSON.stringify(lum));
        await A.reload();
        check(`[look] ${name}: DayDream palette survives a reload`, (await A.themeVars())["--blue"] === DD_ACCENT);
        await A.setMode("school");
        const after = await A.themeVars();
        check(`[look] ${name}: back in School every theme value is what it was`, same(before, after), `before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
        check(`[look] ${name}: studyflowColors is unchanged by the round trip`, (await A.ev(`localStorage.getItem("studyflowColors")`)) === savedColors);
      }
    });

    await scenario("[color] DayDream colors and the calendar", async () => {
      const today = await A.ev(`(() => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); })()`);
      await A.fresh(NEW, { ...planning, studyflowEvents: [{ id: 71, title: "Picnic", date: today, start: "", end: "", note: "", mode: "planning", type: "outing", place: "", emoji: "🧺" }], studyflowPlanning: { v: 1, todos: [{ id: 72, title: "Pack basket", due: today, priority: "Medium", note: "", done: false }] } });
      const look = () => A.ev(`(() => { const h = getComputedStyle(document.documentElement); const k = (s) => { const e = document.querySelector(s); return e ? getComputedStyle(e).getPropertyValue("--k").trim() : null; }; return { dd: document.documentElement.dataset.dd, blue: h.getPropertyValue("--blue").trim(), planChip: k(".day.today .chip.k-event"), todoChip: k(".day.today .chip.k-plan"), pressed: [...document.querySelectorAll('[data-dd-color][aria-pressed="true"]')].map((b) => b.dataset.ddColor), patterns: getComputedStyle(document.body).backgroundImage, font: getComputedStyle(document.body).fontFamily, bg: getComputedStyle(document.body).backgroundColor }; })()`);
      await A.nav("calendar");
      const first = await look();
      check("[color] DayDream starts lavender and the calendar wears it", first.dd === "lavender" && first.blue === "#6f83df" && first.planChip === "#6f83df" && first.todoChip === "#536dcf", JSON.stringify(first));
      const want = { pink: ["#e07aa5", "#c2527f"], sky: ["#4f9fe0", "#2c7cc0"], mint: ["#45b394", "#2a8c70"], peach: ["#ee9460", "#c96d38"], lavender: ["#6f83df", "#536dcf"] };
      const tint = (accent) => "rgb(" + [1, 3, 5].map((i) => Math.round(parseInt(accent.slice(i, i + 2), 16) * 0.09 + 255 * 0.91)).join(", ") + ")";
      const seen = new Set();
      for (const [name, [accent, deep]] of Object.entries(want)) {
        await A.nav("settings");
        await A.click('[data-set-tab="appearance"]');
        await A.click(`[data-dd-color="${name}"]`);
        await A.nav("calendar");
        const now = await look();
        check(`[color] ${name}: the page and the calendar chips take the color`, now.dd === name && now.blue === accent && now.planChip === accent && now.todoChip === deep && same(now.pressed, [name]), JSON.stringify(now));
        seen.add(now.bg);
        check(`[color] ${name}: the page background is a light tint of the color`, now.bg === tint(accent), `${now.bg} want ${tint(accent)}`);
        check(`[color] ${name}: only the color changes, with no pattern and the same font`, now.patterns === first.patterns && now.font === first.font, JSON.stringify(now));
      }
      check("[color] each color has its own background", seen.size === 5, [...seen].join(" | "));
      await A.nav("settings");
      await A.click('[data-set-tab="appearance"]');
      await A.click('[data-dd-color="pink"]');
      const hero = async () => { await A.nav("dashboard"); return A.ev(`getComputedStyle(document.querySelector(".dd-hero")).backgroundImage`); };
      if (SHOTS) { await A.nav("dashboard"); await A.shot(path.join(SHOTS, "daydream-pink-dashboard.png"), 1280, 900); await A.nav("calendar"); await A.shot(path.join(SHOTS, "daydream-pink-calendar.png"), 1280, 900); await A.nav("settings"); await A.click('[data-set-tab="appearance"]'); await A.shot(path.join(SHOTS, "daydream-color-picker.png"), 1280, 900); }
      check("[color] the dashboard hero takes the color", /rgb\(22[0-9], 1[0-9][0-9], 1[0-9][0-9]\)/.test(await hero()), await hero());
      await A.send("Page.reload");
      await sleep(900);
      await A.nav("calendar");
      const again = await look();
      check("[color] the color is remembered after a reload", again.dd === "pink" && again.blue === "#e07aa5" && again.planChip === "#e07aa5", JSON.stringify(again));
      check("[color] the calendar key swatches cannot be edited in DayDream", await A.ev(`[...document.querySelectorAll("[data-kcolor]")].filter((i) => i.offsetParent !== null).every((i) => i.disabled)`));
      await A.setMode("school");
      const school = await A.ev(`({ blue: getComputedStyle(document.documentElement).getPropertyValue("--blue").trim(), theme: document.documentElement.dataset.theme ?? null, editable: [...document.querySelectorAll("[data-kcolor]")].every((i) => !i.disabled) })`);
      check("[color] School keeps its own color and editable calendar colors", school.blue !== "#e07aa5" && school.theme !== "daydream" && school.editable, JSON.stringify(school));
    });

    await scenario("[tab] the open section's tab has a shadow in every mode", async () => {
      await A.fresh(NEW, planning);
      const tab = () => A.ev(`(() => { const n = document.querySelector(".nav.active"), o = [...document.querySelectorAll(".nav:not(.active)")].find((e) => e.getClientRects().length); return { tab: getComputedStyle(n).boxShadow, icon: getComputedStyle(n.querySelector(".nav-icon")).boxShadow, other: getComputedStyle(o).boxShadow + "|" + getComputedStyle(o.querySelector(".nav-icon")).boxShadow }; })()`);
      const plain = (t) => t.other.startsWith("none|") && !/3px 8px/.test(t.other);
      await A.nav("journal");
      await sleep(500);
      const dd = await tab();
      check("[tab] DayDream: the open tab has an edge and a soft shadow in the DayDream color, other tabs have none", dd.tab.includes("rgb(111, 131, 223)") && dd.tab.includes("inset") && /3px 8px/.test(dd.icon) && plain(dd), JSON.stringify(dd));
      await A.nav("settings");
      await A.click('[data-set-tab="appearance"]');
      await A.click('[data-dd-color="mint"]');
      await sleep(500);
      check("[tab] DayDream: the shadow follows the chosen color", (await tab()).tab.includes("rgb(69, 179, 148)"), JSON.stringify(await tab()));
      if (SHOTS) { await A.nav("journal"); await A.shot(path.join(SHOTS, "tab-shadow-daydream.png"), 1280, 900); }
      for (const m of ["work", "school"]) {
        await A.setMode(m);
        await sleep(500);
        const t = await tab();
        check(`[tab] ${m}: the open tab has an edge and a soft shadow`, t.tab.includes("inset") && /3px 8px/.test(t.icon) && plain(t), JSON.stringify(t));
        if (SHOTS && m === "work") await A.shot(path.join(SHOTS, "tab-shadow-work.png"), 1280, 900);
      }
    });

    await scenario("[games] the game room follows the appearance colors", async () => {
      const presets = { rose: ["#d9578b", "#fff1f6", "#ffe3ee", "#ffffff", "#5a2a3e"], mint: ["#2fa57c", "#e6f7f0", "#e2f3fb", "#ffffff", "#24504a"], custom: ["#b0409a", "#fbf0fa", "#f3e3f6", "#ffffff", "#40203a"], night: ["#8ea8ff", "#0f1531", "#1d1742", "#1a2145", "#e4e9ff"] };
      const paint = () => A.ev(`(() => { const c = (s, p) => { const e = document.querySelector(s); return e ? getComputedStyle(e)[p] : "missing " + s; }; return [c(".game-tabs", "backgroundColor"), c(".game-tabs button:not(.on)", "color"), c(".secret", "backgroundImage"), c(".secret", "borderTopColor"), c(".game-tabs button:not(.on) .game-ico", "backgroundColor"), c(".game-ico", "color"), c(".game-tabs button.on .game-ico", "backgroundImage"), c(".big-book", "boxShadow"), c(".up-icon", "backgroundColor"), c(".wd-tile", "borderTopColor"), c(".wd-key", "backgroundColor"), c(".wd-key", "color"), c(".ty-text", "backgroundColor"), c(".ty-text", "borderTopColor")]; })()`);
      const seen = [];
      for (const [name, [accent, background, background2, cards, text]] of Object.entries(presets)) {
        await A.fresh(NEW, { studyflowColors: { accent, background, background2, cards, text } });
        for (let i = 0; i < 5; i++) await A.click("#hat");
        await sleep(400);
        const p = await paint();
        seen.push(p);
        check(`[games] ${name}: every part of the game room is drawn`, (await A.ev(`document.querySelector("#page-secret").classList.contains("active")`)) && p.every((v) => !v.startsWith("missing")), JSON.stringify(p));
        if (SHOTS) for (const g of ["clicker", "wordle", "typing"]) { await A.click(`[data-game="${g}"]`); await sleep(300); await A.shot(path.join(SHOTS, `games-${name}-${g}.png`), 1280, 900); }
      }
      const differs = seen[0].map((_, i) => new Set(seen.map((p) => p[i])).size);
      check("[games] every colored part is different in each of four appearances", differs.every((n) => n === 4), JSON.stringify(differs) + " " + JSON.stringify(seen[0]));
      await A.fresh(NEW, {});
      for (let i = 0; i < 5; i++) await A.click("#hat");
      await A.click('[data-game="wordle"]');
      for (const k of [..."crane", "enter"]) await A.click(`#wdKb [data-key="${k}"]`);
      await sleep(2500);
      const scored = await A.ev(`[...document.querySelectorAll(".wd-row")][0] ? [...[...document.querySelectorAll(".wd-row")][0].children].map((t) => [t.className, getComputedStyle(t).borderTopColor, getComputedStyle(t).backgroundColor]) : []`);
      check("[games] scored Wordle tiles keep their green, yellow and gray", scored.length === 5 && scored.every(([cls, border, bg]) => /\b[gyx]\b/.test(cls) && border === bg && ["rgb(95, 184, 138)", "rgb(232, 184, 74)", "rgb(169, 184, 204)"].includes(bg)), JSON.stringify(scored));
    });

    await scenario("[camera] the journal can take a photo with the camera", async () => {
      await A.fresh(NEW, planning);
      await A.nav("journal");
      const cam = () => A.ev(`(() => { const d = document.querySelector("#camDialog"), v = document.querySelector("#camVideo"), p = document.querySelector("#memoryPreview"); return { open: d.open, live: !!v.srcObject && v.srcObject.getTracks().some((t) => t.readyState === "live"), width: v.videoWidth, preview: !p.hidden && p.naturalWidth > 0, msg: document.querySelector("#journalMsg").textContent }; })()`);
      check("[camera] the form has Take a photo next to Add a photo", (await A.texts("#memoryForm .dd-photo-pick")).map((t) => t.trim()).join("|") === "Take a photo|Add a photo");
      await A.click("#memoryCamera");
      await sleep(1500);
      const opened = await cam();
      check("[camera] the button opens a live camera view", opened.open && opened.live && opened.width > 0, JSON.stringify(opened));
      if (process.env.SHOTS) await A.shot(require("path").join(process.env.SHOTS, "camera.png"), 1280, 900);
      await A.ev(`window.__track = document.querySelector("#camVideo").srcObject.getTracks()[0]`);
      await A.click("#camCancel");
      const cancelled = await cam();
      check("[camera] Cancel closes the view, turns the camera off and adds no photo", !cancelled.open && !cancelled.live && !cancelled.preview && (await A.ev(`window.__track.readyState`)) === "ended", JSON.stringify(cancelled));
      await A.click("#memoryCamera");
      await sleep(1500);
      await A.click("#camSnap");
      await sleep(900);
      const snapped = await cam();
      check("[camera] Take photo closes the view, turns the camera off and shows the photo", !snapped.open && !snapped.live && snapped.preview, JSON.stringify(snapped));
      await A.saveMemory({ "#memoryTitle": "Camera day" });
      const saved = (await A.ls("studyflowMemories"))[0];
      check("[camera] the photo is saved with the memory and shown on its card", saved.title === "Camera day" && saved.hasPhoto === true && (await A.ev(`(() => { const i = document.querySelector("#memoryGrid .dd-memory img"); return !!i && i.naturalWidth > 0; })()`)), JSON.stringify(saved));
      await A.ev(`navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("no", "NotAllowedError"))`);
      await A.click("#memoryCamera");
      await sleep(300);
      const blocked = await cam();
      check("[camera] a blocked camera gives a message and no empty view", !blocked.open && /blocked/.test(blocked.msg), JSON.stringify(blocked));
      await A.ev(`navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("no", "NotFoundError"))`);
      await A.click("#memoryCamera");
      await sleep(300);
      const none = await cam();
      check("[camera] a device with no camera gives a message", !none.open && /No camera/.test(none.msg), JSON.stringify(none));
    });

    await scenario("[icons] DayDream shows no emojis", async () => {
      const today = await A.ev(`(() => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); })()`);
      await A.fresh(NEW, { ...planning, studyflowEvents: [{ id: 81, title: "Old beach trip", date: today, start: "", end: "", note: "", mode: "planning", type: "trip", place: "Pier", emoji: "🏖️" }], studyflowPlanning: { v: 1, todos: [{ id: 82, title: "Sunscreen", due: today, priority: "Medium", note: "", done: false, planId: 81 }] }, studyflowMemories: [{ id: "m1", title: "Old memory", date: today, mood: "Happy ☀️", text: "Nice day", tags: ["sun"], hasPhoto: false }] });
      const found = () => A.ev(`(() => { const css = [":before", ":after"].flatMap((p) => [...document.querySelectorAll("main *, aside *")].filter((e) => e.getClientRects().length).map((e) => getComputedStyle(e, p).content)).filter((c) => c && c !== "none" && c !== "normal").join(" "); const text = document.querySelector(".app").innerText + " " + document.querySelector("#modalBg").innerText + " " + (document.querySelector(".toast")?.innerText || "") + " " + css; return [...new Set(text.match(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2300}-\u{23FF}\u{25A0}-\u{25FF}\u{FE0F}]/gu) || [])].join(" "); })()`);
      for (const p of ["dashboard", "plan", "calendar", "journal", "checklists", "settings", "assistant"]) {
        await A.nav(p);
        check(`[icons] no emoji on ${p}`, (await found()) === "", await found());
      }
      await A.nav("plan");
      check("[icons] a plan saved with an emoji now shows its type's icon", (await A.count('#planGrid [data-plan-open="81"] .dd-cover svg.dd-ico')) === 1 && !/🏖/.test(await A.text('[data-plan-open="81"]')));
      await A.click('[data-plan-open="81"] .dd-plan-title');
      check("[icons] no emoji in the plan detail", (await found()) === "", await found());
      await A.click("[data-plan-edit]");
      const hues = await A.ev(`[...new Set([...document.querySelectorAll("#modalFields [data-icon] svg")].map((s) => getComputedStyle(s).color))]`);
      check("[icons] each of the twelve icons has its own color", hues.length === 12, JSON.stringify(hues));
      check("[icons] the plan form offers twelve icons and no emoji", (await A.count("#modalFields [data-icon] svg")) === 12 && (await found()) === "", await found());
      await A.submit("#modalForm");
      check("[icons] no emoji after saving a plan", (await found()) === "", await found());
      await A.nav("journal");
      check("[icons] an old mood shows as a plain word", /Happy/.test(await A.text("#memoryGrid")) && (await A.texts("#memoryMood option")).includes("Happy"), await A.text("#memoryGrid"));
      await A.saveMemory({ "#memoryTitle": "New one", "#memoryText": "Hello" }, false);
      check("[icons] no emoji after saving a memory", (await found()) === "", await found());
      await A.nav("dashboard");
      const tileHues = await A.ev(`[...new Set([...document.querySelectorAll(".dd-stat-icon")].map((s) => getComputedStyle(s).color + getComputedStyle(s).backgroundColor))]`);
      check("[icons] the four dashboard tiles each have their own icon color and tint", tileHues.length === 4, JSON.stringify(tileHues));
      check("[icons] the dashboard tiles, hero and covers use drawn icons", (await A.count(".dd-stat-icon svg")) === 4 && (await A.count(".dd-hero-art svg")) === 1 && (await A.count("#dashPlanGrid .dd-cover svg")) === 1);
    });

    await scenario("[safety] new collections and device settings cannot lose or overwrite data", async () => {
      await A.fresh(NEW, {});
      const r = await A.ev(`(() => {
        const before = Object.keys(localStorage).filter((k) => k.startsWith("studyflow")).sort().join();
        devPref.set("probe", { on: true });
        const c = coll("studyflowProbe", []);
        const untouched = localStorage.getItem("studyflowProbe") === null && Object.keys(localStorage).filter((k) => k.startsWith("studyflow")).sort().join() === before;
        c.update((v) => v.push("a"));
        localStorage.setItem("studyflowProbe", JSON.stringify(["a", "from another tab"]));
        c.update((v) => v.push("c"));
        const merged = c.get();
        localStorage.setItem("studyflowProbe", "not json");
        const broken = c.get();
        const keys = new Set(["studyflowProbe"]);
        const local = ["studyflowData", "studyflowProbe", "studyflowGone"];
        const oldCopy = sfSync.plan(local, { data: { studyflowData: "{}" } }, keys);
        const newCopy = sfSync.plan(local, { data: { studyflowData: "{}" }, schema: 2 }, keys);
        const size = sfSync.size({ studyflowData: "x".repeat(10), studyflowNotes: "é".repeat(500) });
        localStorage.removeItem("studyflowProbe");
        return { pref: devPref.get("probe", null), prefKey: Object.keys(localStorage).filter((k) => /probe/i.test(k)), untouched, merged, broken, oldCopy, newCopy, size, registered: sfKeys.has("studyflowProbe") };
      })()`);
      check("[safety] a device setting is saved outside the synced and backed-up keys", r.pref && r.pref.on === true && same(r.prefKey, ["sfLocal.probe"]), JSON.stringify(r.prefKey));
      check("[safety] a new collection writes nothing until something is added", r.untouched && r.registered);
      check("[safety] saving keeps what another tab added in between", same(r.merged, ["a", "from another tab", "c"]), JSON.stringify(r.merged));
      check("[safety] a damaged collection reads as empty", same(r.broken, []));
      check("[safety] an account copy saved by an older build does not erase new collections", same(r.oldCopy, { remove: ["studyflowGone"], kept: ["studyflowProbe"] }), JSON.stringify(r.oldCopy));
      check("[safety] an account copy saved by this build can remove them", same(r.newCopy, { remove: ["studyflowProbe", "studyflowGone"], kept: [] }), JSON.stringify(r.newCopy));
      check("[safety] the account size is measured in bytes and names the biggest part", r.size.total === 13 + 10 + 14 + 1000 && r.size.big === "studyflowNotes", JSON.stringify(r.size));
      await A.nav("settings");
      check("[safety] the page still works after the probe", (await A.count(".page.active")) === 1);
    });

    await scenario("[home] the StudyFlow dashboard", async () => {
      const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
      const g = (id, score) => ({ id, title: "Score " + id, type: "Homework", score, total: 10, date: day(-3) });
      const task = (id, title, due, type, priority) => ({ id, title, classId: 2001, type, due, points: 10, priority, done: false });
      const seed = { studyflowData: { v: 1, displayName: "Sam", sessions: [{ id: 3001, title: "Review", subject: "Math", date: day(2), time: "", duration: 30, note: "" }],
        classes: [{ id: 2001, name: "Math", teacher: "", icon: "M", grades: [g(1, 6), g(2, 6)], weights: {}, credits: 1 }, { id: 2002, name: "Art", teacher: "", icon: "A", grades: [g(3, 9), g(4, 10)], weights: {}, credits: 1 }],
        tasks: [task(4001, "Far away", day(20), "Homework", "Medium"), task(4002, "Tomorrow sheet", day(1), "Homework", "Medium"), task(4003, "Unit test", day(3), "Test", "Medium"), task(4004, "Today sheet", day(0), "Homework", "High"), task(4005, "Late essay", day(-2), "Project", "Low")] },
        studyflowFocus: { [day(0)]: 25, [day(-1)]: 30 } };
      await A.fresh(NEW, seed);
      const hello = await A.text("#dashHello");
      check("[home] the welcome names the student and sums up today", /Good (morning|afternoon|evening), Sam/.test(hello) && /1 overdue/.test(hello) && /1 due today/.test(hello) && /next test in 3 days/.test(hello), hello);
      const ranked = await A.ev(`sfNextSteps().map((s) => s.title)`);
      check("[home] next steps rank overdue, today, the test, tomorrow, then the weakest class, and leave out far work", same(ranked, ["Late essay", "Today sheet", "Unit test", "Tomorrow sheet", "Review Math"]), JSON.stringify(ranked));
      check("[home] the card shows the top four with a reason each", same(await A.texts("#dashNext .step-body b"), ["Late essay", "Today sheet", "Unit test", "Tomorrow sheet"]) && /Overdue, it was due 2 days ago/.test(await A.text("#dashNext .step.over")) && (await A.count("#dashNext .step.over")) === 1);
      const week = await A.ev(`[...document.querySelectorAll("#dashNext .week button")].map((b) => [b.className.trim(), b.querySelector("i").textContent])`);
      check("[home] the week strip has seven days, marks today and shows the test", week.length === 7 && week[0][0] === "now" && week[0][1] === "1 due" && week[3][0] === "has-test" && week[3][1] === "Test" && week[1][1] === "1 due" && week[2][1] === "", JSON.stringify(week));
      check("[home] today's work is listed under the week", /Today sheet · Math\s*High/.test(await A.text("#dashToday")) && !/Tomorrow/.test(await A.text("#dashToday")), await A.text("#dashToday"));
      const more = await A.text("#dashMore");
      check("[home] tests show a countdown", /Unit test · Math\s*in 3 days/.test(more), more);
      check("[home] study time comes from the focus log", /55m/.test(more) && /2 days/.test(more) && /Study sessions planned this week\s*1/.test(more), more);
      await A.nav("grades");
      const gpa = await A.text("#gpaValue");
      await A.nav("dashboard");
      check("[home] the grade summary shows the same GPA as the Grade Tracker", gpa !== "—" && (await A.text("#dashMore .big-num")).startsWith(gpa) && /Needs attention · Math\s*60%/.test(more) && /Strongest · Art\s*95%/.test(more), gpa + " | " + more);
      if (SHOTS) await A.shot(path.join(SHOTS, "home-school-1280.png"), 1280, 900);
      await A.click('#dashNext [data-complete-step="4005"]');
      check("[home] Done on a step finishes the task and brings up the next one", (await A.ls("studyflowData")).tasks.find((t) => t.id === 4005).done === true && same(await A.texts("#dashNext .step-body b"), ["Today sheet", "Unit test", "Tomorrow sheet", "Review Math"]));
      await A.click('#dashHello [data-quick="task"]');
      check("[home] a quick action opens the assignment form", (await A.text("#modalTitle")) === "Add assignment or task");
      await A.press("Escape");
      await A.ev(`document.querySelector("#modalBg").style.display = "none"`);
      await A.send("Emulation.setDeviceMetricsOverride", { width: 393, height: 852, deviceScaleFactor: 1, mobile: true });
      await sleep(250);
      check("[home] phone: nothing scrolls sideways", (await A.ev(`document.documentElement.scrollWidth - innerWidth`)) <= 0);
      if (SHOTS) await A.shot(path.join(SHOTS, "home-school-393.png"), 393, 852);
      await A.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
      for (const m of ["work", "planning"]) {
        await A.click(`#wsSwitch [data-mode="${m}"]`);
        check(`[home] ${m}: the school dashboard parts are hidden`, await A.ev(`["#dashHello", "#dashNext", "#dashMore"].every((s) => document.querySelector(s).getClientRects().length === 0)`));
      }
      await A.fresh(NEW, { studyflowData: { v: 1, displayName: "", classes: [{ id: 2001, name: "Math", teacher: "", icon: "M", grades: [], weights: {}, credits: 1 }], tasks: [], sessions: [] } });
      check("[home] an empty planner shows friendly empty states", /all caught up/.test(await A.text("#dashNext")) && /No tests coming up/.test(await A.text("#dashMore")) && /Add a grade/.test(await A.text("#dashMore")) && /^Good (morning|afternoon|evening)\s*0 due today/.test((await A.text("#dashHello")).replace(/\n/g, " ")), await A.text("#dashHello"));
    });

    await scenario("[search] one search across every workspace", async () => {
      await A.fresh(NEW, { studyflowData: { v: 1, displayName: "", sessions: [{ id: 3001, title: "Beach vocabulary drill", subject: "Spanish", date: "2026-12-01", time: "", duration: 30, note: "" }], classes: [{ id: 2001, name: "Spanish", teacher: "Ms Vega", icon: "S", grades: [], weights: {}, credits: 1 }], tasks: [{ id: 4001, title: "Essay about the beach", classId: 2001, type: "Homework", due: "2026-12-02", points: 10, priority: "High", done: false }] },
        studyflowEvents: [{ id: 81, title: "Beach trip", date: "2026-12-20", start: "", end: "", note: "bring towels", mode: "planning", type: "trip", place: "Pier", icon: "sun" }, { id: 82, title: "Dentist", date: "2026-12-03", start: "", end: "", note: "", mode: "work" }],
        studyflowPlanning: { v: 1, todos: [{ id: 91, title: "Sunscreen for the beach", due: "", priority: "Medium", note: "", done: false, planId: 81 }] },
        studyflowMemories: [{ id: "m1", title: "Sunset", date: "2026-11-01", mood: "Happy", text: "We walked on the beach", tags: ["sea"], hasPhoto: false }],
        studyflowWork: { v: 1, jobs: [{ id: 1, name: "Beach cafe", rate: 15, color: "#4f8fe8" }], shifts: [], todos: [] } });
      const hits = await A.ev(`sfSearch("beach").map((h) => h.ws + ":" + h.kind + ":" + h.title)`);
      check("[search] finds matches in all three workspaces: this workspace first, titles that start with the word, then other titles, then text", same(hits, ["school:Study session:Beach vocabulary drill", "school:Assignment:Essay about the beach", "work:Job:Beach cafe", "planning:Plan:Beach trip", "planning:Checklist item:Sunscreen for the beach", "planning:Memory:Sunset"]), JSON.stringify(hits));
      check("[search] every word must match", same(await A.ev(`sfSearch("beach essay").map((h) => h.title)`), ["Essay about the beach"]) && (await A.ev(`sfSearch("zebra").length`)) === 0 && (await A.ev(`sfSearch("   ").length`)) === 0);
      await A.ev(`dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }))`);
      check("[search] Ctrl+K opens the search box with the cursor in it", await A.ev(`document.querySelector("#searchDlg").open && document.activeElement.id === "searchBox"`));
      await A.setValue("#searchBox", "towels");
      check("[search] typing lists hits under their workspace", same(await A.texts("#searchResults .search-group"), ["DAYDREAM"]) && same(await A.texts("#searchResults .search-hit b"), ["Beach trip"]), await A.text("#searchResults"));
      if (SHOTS) { await A.setValue("#searchBox", "beach"); await A.shot(path.join(SHOTS, "search-1280.png"), 1280, 900); await A.setValue("#searchBox", "towels"); }
      await A.ev(`document.querySelector("#searchBox").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))`);
      await sleep(400);
      check("[search] Enter opens the plan in DayDream", (await A.ev(`localStorage.getItem("studyflowMode")`)) === "planning" && (await A.ev(`document.querySelector("#page-plan").classList.contains("active") && !document.querySelector("#searchDlg").open`)) && /Beach trip/.test(await A.text("#planModal")), await A.text("#pageTitle"));
      await A.press("Escape");
      await A.click("#searchOpen");
      await A.setValue("#searchBox", "vega");
      await A.click("#searchResults .search-hit");
      await sleep(300);
      check("[search] a class hit switches back to StudyFlow and opens My Classes", (await A.ev(`localStorage.getItem("studyflowMode")`)) === "school" && (await A.ev(`document.querySelector("#page-classes").classList.contains("active")`)));
      await A.click("#searchOpen");
      await A.setValue("#searchBox", "zebra");
      check("[search] no match says so", /Nothing matches/.test(await A.text("#searchResults")));
      await A.press("Escape");
      await A.send("Emulation.setDeviceMetricsOverride", { width: 393, height: 852, deviceScaleFactor: 1, mobile: true });
      await sleep(250);
      check("[search] phone: the search button is on screen and nothing scrolls sideways", await A.ev(`(() => { const r = document.querySelector("#searchOpen").getBoundingClientRect(); return r.width > 20 && r.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth; })()`));
      await A.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    });

    await scenario("[calendar] other workspaces can be shown on one calendar", async () => {
      const today = await A.ev(`(() => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); })()`);
      const seed = { studyflowData: { v: 1, displayName: "", sessions: [], classes: [{ id: 2001, name: "Math", teacher: "", icon: "M", grades: [], weights: {}, credits: 1 }], tasks: [{ id: 4001, title: "Math sheet", classId: 2001, type: "Homework", due: today, points: 10, priority: "High", done: false }] },
        studyflowEvents: [{ id: 81, title: "Picnic", date: today, start: "13:00", end: "", note: "", mode: "planning", type: "outing", place: "Park", icon: "sun" }],
        studyflowPlanning: { v: 1, todos: [{ id: 91, title: "Buy bread", due: today, priority: "Medium", note: "", done: false }] },
        studyflowWork: { v: 1, jobs: [{ id: 1, name: "Cafe", rate: 15, color: "#4f8fe8" }], shifts: [{ id: 2, jobId: 1, date: today, start: "09:00", end: "12:00", note: "" }], todos: [] } };
      await A.fresh(NEW, seed);
      await A.nav("calendar");
      const chips = () => A.ev(`[...document.querySelectorAll(".day.today .chip")].map((c) => [c.textContent, c.classList.contains("k-other")])`);
      const before = await A.snapshot();
      check("[calendar] by default only this workspace's items show", same(await chips(), [["Math sheet", false]]) && same(await A.texts("#calAlso button"), ["Work", "DayDream"]), JSON.stringify(await chips()));
      await A.click('#calAlso [data-also="planning"]');
      check("[calendar] turning on DayDream adds its plan and dated to-do, outlined", same(await chips(), [["Math sheet", false], ["Picnic 1:00 PM", true], ["Buy bread", true]]), JSON.stringify(await chips()));
      await A.click(".day.today");
      const list = await A.text("#calDay");
      check("[calendar] the day list names the workspace and offers no delete for visitors", /Picnic 1:00 PM\s*DayDream · Plan/.test(list) && /Buy bread\s*DayDream · To-do/.test(list) && (await A.count("#calDay [data-cal-event-del]")) === 0, list);
      await A.click('#calAlso [data-also="work"]');
      check("[calendar] turning on Work adds the shift", (await chips()).some((c) => c[0] === "Cafe 9:00 AM–12:00 PM" && c[1]) || /Cafe 9:00 AM–12:00 PM\s*Work · Shift/.test(await A.text("#calDay")), JSON.stringify(await chips()) + (await A.text("#calDay")));
      check("[calendar] the choice is a device setting and changes no synced data", same(await A.snapshot(), before) && (await A.ev(`localStorage.getItem("sfLocal.calAlso")`)) === '{"planning":true,"work":true}');
      if (SHOTS) await A.shot(path.join(SHOTS, "calendar-also-1280.png"), 1280, 900);
      await A.reload();
      await A.nav("calendar");
      check("[calendar] the choice survives a reload", (await chips()).length === 3 && (await A.ev(`document.querySelector('#calAlso [data-also="work"]').getAttribute("aria-pressed")`)) === "true", JSON.stringify(await chips()));
      await A.click('#wsSwitch [data-mode="planning"]');
      await A.nav("calendar");
      const dd = await chips();
      check("[calendar] in DayDream its own plan is not doubled, and StudyFlow can be shown", dd.filter((c) => c[0].startsWith("Picnic")).length === 1 && dd.find((c) => c[0].startsWith("Picnic"))[1] === false && same(await A.texts("#calAlso button"), ["StudyFlow", "Work"]), JSON.stringify(dd));
      await A.click('#calAlso [data-also="school"]');
      await A.click(".day.today");
      check("[calendar] StudyFlow work shows in DayDream's calendar", /Math sheet\s*StudyFlow · Homework/.test(await A.text("#calDay")), await A.text("#calDay"));
    });

    await scenario("[task] assignments have a time, points earned, details, a link and steps", async () => {
      const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
      await A.fresh(NEW, { studyflowData: { v: 1, displayName: "", sessions: [], classes: [{ id: 2001, name: "Math", teacher: "", icon: "M", grades: [], weights: {}, credits: 1 }, { id: 2002, name: "Art", teacher: "", icon: "A", grades: [], weights: {}, credits: 1 }],
        tasks: [{ id: 4001, title: "Imported lab", classId: 2001, type: "Quiz", due: day(2), points: 20, priority: "Medium", done: false, source: "classroom", gcId: "g1", desc: "From class", url: "https://classroom.google.com/x", detailFrom: "api" }, { id: 4002, title: "Afternoon thing", classId: 2001, type: "Homework", due: day(1), points: "", priority: "High", done: false, time: "15:00" }] } });
      await A.nav("assignments");
      await A.ev(`(() => { const s = document.querySelector("#dueFilter"); s.value = "all"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
      await A.click("#addTask");
      check("[task] the form has the new fields", same(await A.ev(`[...document.querySelectorAll("#modalFields [name]")].map((e) => e.name)`), ["title", "classId", "type", "priority", "points", "due", "time", "earned", "notes", "link"]));
      for (const [n, v] of Object.entries({ title: "Morning sheet", points: "10", due: day(1), time: "09:30", earned: "8", notes: "Pages 4 to 6, see https://example.com/help", link: "https://example.com/sheet" })) await A.setValue(`#modalForm [name="${n}"]`, v);
      await A.ev(`document.querySelector('#modalForm [name="priority"]').value = "High"`);
      await A.submit("#modalForm");
      const saved = (await A.ls("studyflowData")).tasks.find((t) => t.title === "Morning sheet");
      check("[task] a new assignment saves its time, points earned, details and link", !!saved && saved.time === "09:30" && saved.earned === 8 && saved.notes.startsWith("Pages 4") && same(saved.myLinks, [{ title: "", url: "https://example.com/sheet" }]) && saved.points === 10, JSON.stringify(saved));
      const rows = await A.texts("#assignmentList .item h4");
      check("[task] on the same day the earlier time comes first", rows.indexOf("Morning sheet") >= 0 && rows.indexOf("Morning sheet") < rows.indexOf("Afternoon thing"), JSON.stringify(rows));
      const row = await A.ev(`[...document.querySelectorAll("#assignmentList .item")].find((r) => r.textContent.includes("Morning sheet")).querySelector("p").textContent`);
      check("[task] the row shows the time and the points earned", /at 9:30 AM/.test(row) && /8 of 10 points earned/.test(row), row);
      await A.click(`[data-details="${saved.id}"]`);
      check("[task] the details panel shows the details with a working link, and the link", (await A.count('#tdMine .td-desc a[href="https://example.com/help"]')) === 1 && (await A.count('#tdMine .td-links a[href="https://example.com/sheet"]')) === 1 && !(await A.ev(`[...document.querySelectorAll("#tdBody > p.muted")].some((p) => !p.hidden)`)));
      for (const step of ["Outline", "First draft"]) { await A.setValue("#subAdd input", step); await A.submit("#subAdd"); }
      await A.click(`#tdMine .sub input`);
      check("[task] steps can be added and ticked", same(await A.ev(`[...document.querySelectorAll("#tdMine .sub")].map((s) => [s.textContent.replace("×", "").trim(), s.classList.contains("done")])`), [["Outline", true], ["First draft", false]]) && /1 of 2 done/.test(await A.text("#tdMine .td-sec")));
      if (SHOTS) await A.shot(path.join(SHOTS, "task-details-1280.png"), 1280, 900);
      await A.click("#tdClose");
      check("[task] the row shows the step count", /1 of 2 steps/.test(await A.text("#assignmentList")));
      await A.reload();
      const kept = (await A.ls("studyflowData")).tasks.find((t) => t.id === saved.id);
      check("[task] steps and fields survive a reload", kept.subs.length === 2 && kept.subs[0].done === true && kept.time === "09:30" && kept.notes === saved.notes, JSON.stringify(kept));
      await A.nav("assignments");
      await A.ev(`(() => { const s = document.querySelector("#dueFilter"); s.value = "all"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
      await A.click('[data-edit-task="4001"]');
      check("[task] Edit opens the form filled in, keeping an imported type", (await A.text("#modalTitle")) === "Edit assignment" && (await A.value('#modalForm [name="title"]')) === "Imported lab" && (await A.value('#modalForm [name="type"]')) === "Quiz" && (await A.value('#modalForm [name="due"]')) === day(2));
      await A.setValue('#modalForm [name="title"]', "Imported lab, renamed");
      await A.setValue('#modalForm [name="classId"]', "2002");
      await A.setValue('#modalForm [name="notes"]', "My own note");
      await A.submit("#modalForm");
      const all = (await A.ls("studyflowData")).tasks, edited = all.find((t) => t.id === 4001);
      check("[task] editing changes the assignment in place and keeps what was imported", all.length === 3 && edited.title === "Imported lab, renamed" && edited.classId === 2002 && edited.notes === "My own note" && edited.desc === "From class" && edited.gcId === "g1" && edited.url === "https://classroom.google.com/x" && edited.type === "Quiz" && edited.points === 20, JSON.stringify(edited));
      await A.click('[data-details="4001"]');
      check("[task] an imported assignment shows both its description and my note", /From class/.test(await A.text("#tdBody")) && /My own note/.test(await A.text("#tdMine")) && (await A.count("#tdActions #tdEdit")) === 1);
      await A.click("#tdEdit");
      check("[task] Edit inside the panel closes it and opens the form", (await A.text("#modalTitle")) === "Edit assignment" && !(await A.ev(`document.querySelector("#detailsBg").classList.contains("show")`)));
      await A.setValue('#modalForm [name="notes"]', "");
      await A.submit("#modalForm");
      check("[task] clearing a field removes it", !("notes" in (await A.ls("studyflowData")).tasks.find((t) => t.id === 4001)));
      await A.ev(`sfSearch("outline").map((h) => h.title)`).then((r) => check("[task] search finds an assignment by a step", same(r, ["Morning sheet"]), JSON.stringify(r)));
      await A.send("Emulation.setDeviceMetricsOverride", { width: 393, height: 852, deviceScaleFactor: 1, mobile: true });
      await A.click(`[data-details="${saved.id}"]`);
      await sleep(250);
      check("[task] phone: the details panel fits the screen", await A.ev(`(() => { const r = document.querySelector("#detailsBg .modal").getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1 && document.documentElement.scrollWidth <= innerWidth; })()`));
      if (SHOTS) await A.shot(path.join(SHOTS, "task-details-393.png"), 393, 852);
      await A.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    });

    await scenario("[class] classes have a color, a goal and a detail view", async () => {
      const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
      const g = (id, score, n) => ({ id, title: "Quiz " + id, type: "Quiz", score, total: 10, date: day(n) });
      await A.fresh(NEW, { studyflowData: { v: 1, displayName: "", sessions: [], classes: [{ id: 2001, name: "Math", teacher: "Mr Lee", icon: "M", grades: [g(1, 6, -9), g(2, 8, -5), g(3, 10, -1)], weights: {}, credits: 1, gcId: "keep-me" }, { id: 2002, name: "Art", teacher: "", icon: "A", grades: [], weights: {}, credits: 1 }],
        tasks: [{ id: 4001, title: "Unit test", classId: 2001, type: "Test", due: day(3), points: 50, priority: "High", done: false }, { id: 4002, title: "Old sheet", classId: 2001, type: "Homework", due: day(-4), points: 10, priority: "Low", done: true }, { id: 4003, title: "Art poster", classId: 2002, type: "Project", due: day(5), points: 10, priority: "Low", done: false }] } });
      await A.nav("classes");
      await A.click('[data-class-open="2001"]');
      const view = await A.text("#classDlg");
      check("[class] the detail view shows the grade, what is coming up and recent scores", /Math/.test(view) && /80%\s*B/.test(view) && /Unit test · Test/.test(view) && !/Old sheet/.test(view) && !/Art poster/.test(view) && /Quiz 3 · .*10 of 10 · 100%/.test(view) && /No goal yet/.test(view), view);
      check("[class] the trend is the running average, oldest score first", same(await A.ev(`sfClassTrend(classes.find((c) => c.id === 2001)).map(Math.round)`), [60, 70, 80]) && /Up 20 points since your first score/.test(view) && (await A.count("#classDlg .spark polyline")) === 1);
      await A.click("#classEdit");
      await A.setValue('#classForm [name="name"]', "Algebra");
      await A.setValue('#classForm [name="goal"]', "90");
      await A.ev(`(() => { const r = document.querySelector('#classForm [name="color"][value="#2fa57c"]'); r.checked = true; })()`);
      await A.submit("#classForm");
      const c = (await A.ls("studyflowData")).classes.find((x) => x.id === 2001);
      check("[class] editing saves the name, goal and color and keeps everything else", c.name === "Algebra" && c.goal === 90 && c.color === "#2fa57c" && c.gcId === "keep-me" && c.grades.length === 3 && c.teacher === "Mr Lee", JSON.stringify(c).slice(0, 300));
      check("[class] the view shows how far the goal is", /10 points below your goal of 90%/.test(await A.text("#goalText")) && (await A.count("#classDlg .goal-bar i")) === 1, await A.text("#goalText"));
      if (SHOTS) await A.shot(path.join(SHOTS, "class-detail-1280.png"), 1280, 900);
      await A.click("#classClose");
      const card = await A.ev(`(() => { const b = document.querySelector('[data-class-open="2001"]'); return { text: b.textContent, color: getComputedStyle(b.querySelector(".class-icon")).color, bar: getComputedStyle(b.querySelector(".progress span")).backgroundColor, other: document.querySelector('[data-class-open="2002"]').getAttribute("style") }; })()`);
      check("[class] the card shows the new name, goal and color, and a class without a color is unchanged", /Algebra/.test(card.text) && /goal 90%/.test(card.text) && card.color === "rgb(47, 165, 124)" && card.bar === "rgb(47, 165, 124)" && card.other === "", JSON.stringify(card));
      await A.click('[data-class-open="2001"]');
      await A.click("#classEdit");
      await A.setValue('#classForm [name="goal"]', "");
      await A.ev(`document.querySelector('#classForm [name="color"][value=""]').checked = true`);
      await A.submit("#classForm");
      const cleared = (await A.ls("studyflowData")).classes.find((x) => x.id === 2001);
      check("[class] clearing the goal and color removes them", !("goal" in cleared) && !("color" in cleared));
      await A.click("#classClose");
    });

    await scenario("[notes] a Notes page by class and topic", async () => {
      await A.fresh(NEW, { studyflowData: { v: 1, displayName: "", sessions: [], classes: [{ id: 2001, name: "Math", teacher: "", icon: "M", grades: [], weights: {}, credits: 1, color: "#8b6fe0" }, { id: 2002, name: "Art", teacher: "", icon: "A", grades: [], weights: {}, credits: 1 }], tasks: [] } });
      check("[notes] nothing is saved before the first note", (await A.ev(`localStorage.getItem("studyflowNotes")`)) === null);
      await A.nav("notes");
      check("[notes] the page opens from the Academics group with an empty state", (await A.text("#pageTitle")) === "Notes" && /No notes yet/.test(await A.text("#noteGrid")));
      const add = async (f) => { await A.click("#addNote"); for (const [n, v] of Object.entries(f)) await A.setValue(`#noteForm [name="${n}"]`, v); await A.submit("#noteForm"); await sleep(150); };
      await A.click("#addNote");
      await A.submit("#noteForm");
      check("[notes] an empty note is not saved", /Add a title or some writing/.test(await A.text("#noteMsg")) && (await A.ev(`localStorage.getItem("studyflowNotes")`)) === null);
      await A.click("#noteCancel");
      await add({ title: "Fractions <b>rules</b>", classId: "2001", topic: "Chapter 4", text: "Flip the second fraction, then multiply." });
      await add({ title: "Color wheel", classId: "2002", topic: "", text: "Primary and secondary colors." });
      await add({ title: "Locker code idea", classId: "", topic: "", text: "Ask the office." });
      const notes = await A.ls("studyflowNotes");
      check("[notes] notes are saved in their own collection with class and topic", notes.length === 3 && same(Object.keys(notes[2]).sort(), ["at", "classId", "id", "text", "title", "topic"]) && notes[2].classId === 2001 && notes[2].topic === "Chapter 4" && notes[0].classId === null, JSON.stringify(notes).slice(0, 400));
      check("[notes] cards show the newest first, with escaped text and the class color", same(await A.texts("#noteGrid .note-card b"), ["Locker code idea", "Color wheel", "Fractions <b>rules</b>"]) && (await A.ev(`document.querySelectorAll("#noteGrid .note-card")[2].getAttribute("style")`)) === "--cc:#8b6fe0");
      await A.setValue("#noteClass", "2001");
      await A.ev(`document.querySelector("#noteClass").dispatchEvent(new Event("change", { bubbles: true }))`);
      check("[notes] the class filter narrows the list", same(await A.texts("#noteGrid .note-card b"), ["Fractions <b>rules</b>"]) && same(await A.texts("#noteClass option"), ["All classes", "Math", "Art", "No class"]));
      await A.setValue("#noteClass", "all");
      await A.ev(`document.querySelector("#noteClass").dispatchEvent(new Event("change", { bubbles: true }))`);
      await A.setValue("#noteSearch", "multiply");
      check("[notes] search looks inside the note text", same(await A.texts("#noteGrid .note-card b"), ["Fractions <b>rules</b>"]));
      await A.setValue("#noteSearch", "zebra");
      check("[notes] no match says so", /No notes match/.test(await A.text("#noteGrid")));
      await A.setValue("#noteSearch", "");
      if (SHOTS) await A.shot(path.join(SHOTS, "notes-1280.png"), 1280, 900);
      await A.click(`[data-note-open="${notes[2].id}"]`);
      check("[notes] a card opens the note for editing", (await A.text("#noteDlgTitle")) === "Edit note" && (await A.value('#noteForm [name="topic"]')) === "Chapter 4" && (await A.value('#noteForm [name="classId"]')) === "2001");
      await A.setValue('#noteForm [name="text"]', "Keep, change, flip.");
      await A.submit("#noteForm");
      const edited = await A.ls("studyflowNotes");
      check("[notes] editing changes the note in place and moves it to the top", edited.length === 3 && edited.find((n) => n.id === notes[2].id).text === "Keep, change, flip." && (await A.texts("#noteGrid .note-card b"))[0] === "Fractions <b>rules</b>");
      await A.ev(`localStorage.setItem("studyflowNotes", JSON.stringify([{ id: "tab2", title: "From another tab", topic: "", text: "x", classId: null, at: Date.now() + 5000 }, ...JSON.parse(localStorage.getItem("studyflowNotes"))]))`);
      await add({ title: "After the other tab", classId: "", topic: "", text: "y" });
      check("[notes] saving keeps a note another tab added in between", (await A.ls("studyflowNotes")).some((n) => n.id === "tab2") && (await A.ls("studyflowNotes")).length === 5);
      await A.reload();
      await A.nav("classes");
      await A.click('[data-class-open="2001"]');
      check("[notes] the class view lists that class's notes after a reload", /Fractions <b>rules<\/b> · Chapter 4/.test(await A.text("#classDlg")) && !/Color wheel/.test(await A.text("#classDlg")));
      await A.click("#classDlg [data-note-new]");
      check("[notes] a note started from a class is filed under it", (await A.value('#noteForm [name="classId"]')) === "2001" && !(await A.ev(`document.querySelector("#classDlg").open`)));
      await A.click("#noteCancel");
      check("[notes] search finds a note by its text", same(await A.ev(`sfSearch("flip").map((h) => h.kind + ":" + h.title)`), ["Note:Fractions <b>rules</b>"]));
      await A.click("#searchOpen");
      await A.setValue("#searchBox", "flip");
      await A.click("#searchResults .search-hit");
      await sleep(300);
      check("[notes] opening the hit shows the note", (await A.ev(`document.querySelector("#page-notes").classList.contains("active") && document.querySelector("#noteDlg").open`)) && (await A.value('#noteForm [name="text"]')) === "Keep, change, flip.");
      await A.click("#noteDelete");
      await A.click("#confirmYes");
      check("[notes] deleting moves the note to Recently deleted", (await A.ls("studyflowNotes")).length === 4 && (await A.ls("studyflowTrash"))[0].kind === "note");
      await A.nav("settings");
      await A.click('[data-set-tab="data"]');
      check("[notes] the trash lists it as a Note", /Fractions <b>rules<\/b>\s*Note · deleted today/.test(await A.text("#trashList")), await A.text("#trashList"));
      await A.click("#trashList [data-restore]");
      check("[notes] Restore brings the note back", (await A.ls("studyflowNotes")).some((n) => n.id === notes[2].id) && (await A.ls("studyflowNotes")).length === 5);
      for (const m of ["work", "planning"]) { await A.click(`#wsSwitch [data-mode="${m}"]`); check(`[notes] ${m}: Notes is not in the sidebar`, await A.ev(`document.querySelector('.nav[data-page="notes"]').hidden`)); }
      await A.click('#wsSwitch [data-mode="school"]');
      await A.send("Emulation.setDeviceMetricsOverride", { width: 393, height: 852, deviceScaleFactor: 1, mobile: true });
      await A.nav("notes");
      await sleep(250);
      check("[notes] phone: the page fits the screen", (await A.ev(`document.documentElement.scrollWidth - innerWidth`)) <= 0);
      await A.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    });

    await scenario("[trip] a plan holds an itinerary, a budget, guests and trip details", async () => {
      const today = await A.ev(`(() => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); })()`);
      const seedEvents = [{ id: 81, title: "Lake trip", date: "2027-06-10", start: "", end: "", note: "", mode: "planning", type: "trip", place: "Lake", icon: "tent" }, { id: 82, title: "Birthday", date: "2027-03-01", start: "", end: "", note: "", mode: "planning", type: "event", place: "Home", icon: "cake" }];
      await A.fresh(NEW, { ...planning, studyflowEvents: seedEvents, studyflowPlanning: { v: 1, todos: [{ id: 91, title: "pack tent", due: "", priority: "Medium", note: "", done: false, planId: 81 }] } });
      const before = await A.snapshot();
      await A.nav("plan");
      await A.click('[data-plan-open="81"] .dd-plan-title');
      check("[trip] the plan panel has four planning sections and still its checklist", same(await A.ev(`[...document.querySelectorAll("#planModal .trip-sec")].map((d) => d.dataset.tripSec)`), ["itin", "budget", "guests", "info"]) && /pack tent/.test(await A.text("#planModal")) && same(await A.snapshot(), before));
      const openSec = (k) => A.ev(`(() => { const d = document.querySelector('#planModal [data-trip-sec="${k}"]'); if (!d.open) d.querySelector("summary").click(); })()`);
      const add = async (k, f) => { for (const [n, v] of Object.entries(f)) await A.setValue(`#planModal [data-trip-form="${k}"] [name="${n}"]`, v); await A.submit(`#planModal [data-trip-form="${k}"]`); };
      await openSec("itin");
      await add("itin", { day: "2027-06-11", time: "14:00", title: "Kayak rental" });
      await add("itin", { day: "2027-06-10", time: "09:30", title: "Drive up" });
      await add("itin", { day: "2027-06-11", time: "08:00", title: "Pancakes <b>" });
      const itin = await A.ev(`[...document.querySelectorAll('#planModal [data-trip-sec="itin"] .trip-day, #planModal [data-trip-sec="itin"] .trip-row > span:first-child')].map((e) => e.textContent.trim())`);
      check("[trip] itinerary stops are grouped by day and sorted by time, and the section stays open", same(itin, ["Thu, Jun 10", "9:30 AMDrive up", "Fri, Jun 11", "8:00 AMPancakes <b>", "2:00 PMKayak rental"]) && (await A.ev(`document.querySelector('#planModal [data-trip-sec="itin"]').open`)), JSON.stringify(itin));
      check("[trip] the cursor is back in the add box", await A.ev(`document.activeElement.name === "title" && !!document.activeElement.closest('[data-trip-form="itin"]')`));
      await openSec("budget");
      await add("budget", { name: "Cabin", cat: "Stay", est: "200", act: "" });
      await add("budget", { name: "Gas", cat: "Travel", est: "60", act: "75.5" });
      check("[trip] without a set budget the estimate is the plan", same(await A.ev(`sfTripTotals(81)`), { est: 260, spent: 75.5, plan: 260, left: 184.5 }));
      await add("limit", { limit: "250" });
      const cabin = (await A.ls("studyflowTrips"))["81"].budget.items[0].id;
      await A.setValue(`#planModal [data-trip-act="${cabin}"]`, "210");
      await A.ev(`document.querySelector('#planModal [data-trip-act="${cabin}"]').dispatchEvent(new Event("change", { bubbles: true }))`);
      const money = await A.text('#planModal [data-trip-sec="budget"] .money');
      check("[trip] the budget shows the limit, what is spent and how far over", same(await A.ev(`sfTripTotals(81)`), { est: 260, spent: 285.5, plan: 250, left: -35.5 }) && /Budget\s*\$250/.test(money) && /Spent\s*\$285\.50/.test(money) && /Over by\s*\$35\.50/.test(money) && (await A.count("#planModal .money-bar.over")) === 1, money);
      check("[trip] spending is summed by category", same(await A.ev(`[...document.querySelectorAll("#planModal .cat-row")].map((r) => [r.querySelector("span").textContent, r.querySelector("b").textContent])`), [["Travel", "$75.50"], ["Stay", "$210"]]));
      await openSec("guests");
      await add("guests", { name: "Mia" });
      await add("guests", { name: "Leo" });
      const mia = (await A.ls("studyflowTrips"))["81"].guests[0].id;
      await A.setValue(`#planModal [data-trip-rsvp="${mia}"]`, "yes");
      await A.ev(`document.querySelector('#planModal [data-trip-rsvp="${mia}"]').dispatchEvent(new Event("change", { bubbles: true }))`);
      check("[trip] guests keep their replies and the heading counts who is coming", /1 of 2 coming/.test(await A.text('#planModal [data-trip-sec="guests"] summary')) && (await A.ls("studyflowTrips"))["81"].guests[0].rsvp === "yes");
      await openSec("info");
      await A.setValue('#planModal [data-trip-info="stay"]', "Pine cabin 4");
      await A.ev(`document.querySelector('#planModal [data-trip-info="stay"]').dispatchEvent(new Event("change", { bubbles: true }))`);
      await A.setValue('#planModal [data-trip-info="endDate"]', "2027-06-13");
      await A.ev(`document.querySelector('#planModal [data-trip-info="endDate"]').dispatchEvent(new Event("change", { bubbles: true }))`);
      check("[trip] trip details are saved", same((await A.ls("studyflowTrips"))["81"].info, { stay: "Pine cabin 4", endDate: "2027-06-13" }) && /2 of 4 filled in/.test(await A.text('#planModal [data-trip-sec="info"] summary')));
      if (SHOTS) await A.shot(path.join(SHOTS, "trip-1280.png"), 1280, 900);
      const after = await A.snapshot();
      check("[trip] the plan, its checklist and every older key are untouched", same(Object.keys(after).sort(), [...Object.keys(before), "studyflowTrips"].sort()) && Object.keys(before).every((k) => before[k] === after[k]));
      await A.click("#planModal [data-plan-del]");
      await A.click("#confirmYes");
      check("[trip] deleting the plan keeps its planning for a restore", !!(await A.ls("studyflowTrips"))["81"] && !(await A.ls("studyflowEvents")).some((e) => e.id === 81));
      await A.click(".toast-undo");
      await A.click('[data-plan-open="81"] .dd-plan-title');
      check("[trip] the restored plan has its itinerary, budget and guests again", /3 stops/.test(await A.text("#planModal")) && /1 of 2 coming/.test(await A.text("#planModal")) && /pack tent/.test(await A.text("#planModal")));
      await A.click(`#planModal [data-trip-del="guests:${mia}"]`);
      check("[trip] a guest can be removed", (await A.ls("studyflowTrips"))["81"].guests.length === 1);
      await A.press("Escape");
      await A.reload();
      await A.nav("budget");
      const page = await A.text("#budgetPage");
      check("[trip] the Budget Planner page adds up plans that have a budget, after a reload", (await A.text("#pageTitle")) === "Budget Planner" && /Lake trip\s*\$250\s*\$285\.50\s*-\$35\.50/.test(page) && !/Birthday/.test(page) && /All plans\s*\$250\s*\$285\.50\s*-\$35\.50/.test(page), page);
      if (SHOTS) await A.shot(path.join(SHOTS, "budget-1280.png"), 1280, 900);
      await A.click('#budgetPage [data-plan-open="81"]');
      check("[trip] a row opens that plan with its budget showing", /Lake trip/.test(await A.text("#planModalTitle")) && (await A.ev(`document.querySelector('#planModal [data-trip-sec="budget"]').open`)));
      await A.press("Escape");
      check("[trip] search finds a stop, an expense and a guest", same(await A.ev(`["kayak", "cabin", "leo"].map((q) => sfSearch(q).map((h) => h.kind + ":" + h.title + ":" + h.sub).join("|"))`), ["Itinerary:Kayak rental:Lake trip", "Expense:Cabin:Lake trip", "Guest:Leo:Lake trip"]), JSON.stringify(await A.ev(`["kayak", "cabin", "leo"].map((q) => sfSearch(q).map((h) => h.kind + ":" + h.title + ":" + h.sub).join("|"))`)));
      await A.send("Emulation.setDeviceMetricsOverride", { width: 393, height: 852, deviceScaleFactor: 1, mobile: true });
      await A.nav("plan");
      await A.click('[data-plan-open="81"] .dd-plan-title');
      await openSec("budget");
      await sleep(250);
      check("[trip] phone: the plan panel and its budget fit the screen", await A.ev(`(() => { const r = document.querySelector("#planModal").getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1 && document.querySelector("#planModal").scrollWidth <= document.querySelector("#planModal").clientWidth + 1; })()`));
      if (SHOTS) await A.shot(path.join(SHOTS, "trip-393.png"), 393, 852);
      await A.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
      await A.fresh(NEW, { ...planning, studyflowEvents: seedEvents });
      await A.nav("budget");
      check("[trip] with no budgets the page explains how to start, and nothing is saved", /No budgets yet/.test(await A.text("#budgetPage")) && (await A.ev(`localStorage.getItem("studyflowTrips")`)) === null);
    });

    await scenario("[journal] the journal is a scrapbook: edit, favorites, places, albums, search and months", async () => {
      const mem = (id, title, date, text) => ({ id, title, date, mood: "Happy", text, tags: ["sea"], hasPhoto: false });
      await A.fresh(NEW, { ...planning, studyflowMemories: [mem("m3", "Fireworks", "2027-07-04", "Loud and bright"), mem("m2", "Beach day", "2027-06-20", "Sand everywhere"), mem("m1", "First swim", "2027-06-02", "Cold water")] });
      const before = await A.snapshot();
      await A.nav("journal");
      const shown = () => A.ev(`[...document.querySelectorAll("#memoryGrid > *")].filter((e) => !e.hidden).map((e) => e.classList.contains("jr-month") ? "# " + e.textContent : e.classList.contains("dd-memory") ? e.querySelector("h3").textContent : e.textContent)`);
      check("[journal] memories are grouped under their month, newest first", same(await shown(), ["# July 2027", "Fireworks", "# June 2027", "Beach day", "First swim"]), JSON.stringify(await shown()));
      check("[journal] looking at the journal saves nothing new", same(await A.snapshot(), before));
      await A.click('[data-memory-edit="m2"]');
      check("[journal] Edit opens the memory filled in", (await A.value('#memForm [name="title"]')) === "Beach day" && (await A.value('#memForm [name="date"]')) === "2027-06-20" && (await A.value('#memForm [name="tags"]')) === "sea" && (await A.value('#memForm [name="mood"]')) === "Happy");
      for (const [n, v] of Object.entries({ title: "Beach day <i>", text: "Sand everywhere, and ice cream", tags: "sea, sun", loc: "Pier 39", album: "Summer 2027", caption: "Best fries" })) await A.setValue(`#memForm [name="${n}"]`, v);
      await A.ev(`document.querySelector('#memForm [name="fav"]').checked = true`);
      await A.submit("#memForm");
      await sleep(300);
      const rec = (await A.ls("studyflowMemories")).find((m) => m.id === "m2");
      check("[journal] the memory record changes in place and keeps its seven fields", same(Object.keys(rec).sort(), ["date", "hasPhoto", "id", "mood", "tags", "text", "title"]) && rec.title === "Beach day <i>" && rec.text === "Sand everywhere, and ice cream" && same(rec.tags, ["sea", "sun"]) && (await A.ls("studyflowMemories")).length === 3, JSON.stringify(rec));
      check("[journal] the place, album, caption and favorite mark are saved beside it", same(await A.ls("studyflowMemoryMeta"), { m2: { loc: "Pier 39", album: "Summer 2027", caption: "Best fries", fav: true } }), JSON.stringify(await A.ls("studyflowMemoryMeta")));
      const card = await A.text('#memoryGrid [data-mem="m2"]');
      check("[journal] the card shows them, with the title escaped", /Beach day <i>/.test(card) && /Best fries/.test(card) && /Pier 39/.test(card) && /Summer 2027/.test(card) && (await A.ev(`document.querySelector('[data-mem-fav="m2"]').getAttribute("aria-pressed")`)) === "true", card);
      await A.click('[data-mem-fav="m3"]');
      check("[journal] the heart on a card marks a favorite", (await A.ls("studyflowMemoryMeta")).m3.fav === true && same(await A.texts("#jrChips button"), ["All", "Favorites", "Summer 2027"]));
      await A.click('[data-mem-fav="m3"]');
      check("[journal] tapping it again removes the mark and leaves no empty record", !("m3" in (await A.ls("studyflowMemoryMeta"))));
      await A.click('[data-jr-pick="fav"]');
      check("[journal] Favorites shows only favorites", same(await shown(), ["# June 2027", "Beach day <i>"]), JSON.stringify(await shown()));
      await A.click('[data-jr-pick="album:Summer 2027"]');
      check("[journal] an album chip shows that album", same(await shown(), ["# June 2027", "Beach day <i>"]));
      await A.click('[data-jr-pick="all"]');
      await A.setValue("#jrSearch", "pier");
      check("[journal] search looks at the place", same(await shown(), ["# June 2027", "Beach day <i>"]));
      await A.setValue("#jrSearch", "cold");
      check("[journal] search looks at the writing", same(await shown(), ["# June 2027", "First swim"]));
      await A.setValue("#jrSearch", "zebra");
      check("[journal] no match says so", same(await shown(), ["No memories match that."]));
      await A.setValue("#jrSearch", "");
      if (SHOTS) await A.shot(path.join(SHOTS, "journal-1280.png"), 1280, 900);
      await A.saveMemory({ "#memoryTitle": "Brand new" });
      check("[journal] a new memory joins the grid under its month with the filters still working", (await shown()).includes("Brand new") && (await A.count("#memoryGrid .jr-month")) >= 2);
      await A.reload();
      await A.nav("journal");
      check("[journal] everything survives a reload", /Pier 39/.test(await A.text('#memoryGrid [data-mem="m2"]')) && (await A.ev(`document.querySelector('[data-mem-fav="m2"]').getAttribute("aria-pressed")`)) === "true");
      await A.load(OLD);
      await sleep(600);
      await A.load(NEW);
      await A.nav("journal");
      check("[journal] opening the older build does not lose the place, album or favorite", same((await A.ls("studyflowMemoryMeta")).m2, { loc: "Pier 39", album: "Summer 2027", caption: "Best fries", fav: true }) && /Pier 39/.test(await A.text('#memoryGrid [data-mem="m2"]')));
      await A.click('[data-memory-del="m2"]');
      await A.click("#confirmYes");
      await A.ev(`sfMemPrune()`);
      check("[journal] a deleted memory keeps its extras while it is in Recently deleted", !!(await A.ls("studyflowMemoryMeta")).m2);
      await A.click(".toast-undo");
      check("[journal] and has them again when restored", /Pier 39/.test(await A.text('#memoryGrid [data-mem="m2"]')));
      check("[journal] search finds a memory by its place", (await A.ev(`sfSearch("pier").map((h) => h.kind + ":" + h.title)`)).includes("Memory:Beach day <i>"));
      await A.send("Emulation.setDeviceMetricsOverride", { width: 393, height: 852, deviceScaleFactor: 1, mobile: true });
      await sleep(250);
      check("[journal] phone: the journal fits the screen", (await A.ev(`document.documentElement.scrollWidth - innerWidth`)) <= 0);
      await A.click('[data-memory-edit="m1"]');
      await sleep(200);
      check("[journal] phone: the edit form fits the screen", await A.ev(`(() => { const r = document.querySelector("#memDlg").getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1; })()`));
      await A.click("#memCancel");
      await A.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    });

    await scenario("[photos] a memory holds several photos, and a backup can carry them", async () => {
      await A.fresh(NEW, { ...planning, studyflowMemories: [{ id: "m1", title: "Zoo day", date: "2027-05-01", mood: "", text: "Giraffes", tags: [], hasPhoto: false }] });
      await A.nav("journal");
      await A.saveMemory({ "#memoryTitle": "Cover shot" }, true);
      const cover = (await A.ls("studyflowMemories"))[0].id;
      const pick = (n) => A.ev(`(async () => { const dt = new DataTransfer(); for (let i = 0; i < ${n}; i++) { const c = document.createElement("canvas"); c.width = 1600; c.height = 900; const x = c.getContext("2d"); x.fillStyle = ["#e07aa5", "#4f9fe0", "#45b394", "#ee9460"][i % 4]; x.fillRect(0, 0, 1600, 900); const b = await new Promise((r) => c.toBlob(r, "image/png")); dt.items.add(new File([b], "p" + i + ".png", { type: "image/png" })); } const el = document.querySelector("#memMore"); el.files = dt.files; el.dispatchEvent(new Event("change", { bubbles: true })); })()`);
      const stores = () => A.ev(`(async () => ({ album: await sfMemPhotos.count(), main: await __plan.photoTx("readonly", (s) => s.count()) }))()`);
      await A.click('#memoryGrid [data-memory-edit="m1"]');
      await pick(3);
      await sleep(900);
      check("[photos] picked photos show in the edit form before saving, and nothing is stored yet", (await A.count("#memPhotos .jr-thumb")) === 3 && /3 of 8/.test(await A.text("#memPhotos")) && (await stores()).album === 0);
      await A.submit("#memForm");
      await sleep(900);
      const keys = (await A.ls("studyflowMemoryMeta")).m1.extra;
      check("[photos] saving stores them in their own photo database, listed on the memory", keys.length === 3 && keys.every((k) => k.startsWith("m1#")) && same(await stores(), { album: 3, main: 1 }), JSON.stringify(keys) + JSON.stringify(await stores()));
      const thumbs = () => A.ev(`[...document.querySelectorAll('#memoryGrid [data-mem="m1"] .jr-thumb')].map((b) => b.style.backgroundImage.startsWith('url("blob:'))`);
      check("[photos] the card shows a collage of the photos", same(await thumbs(), [true, true, true]), JSON.stringify(await thumbs()));
      check("[photos] a memory without a first photo uses its first extra photo as the cover", await A.ev(`getComputedStyle(document.querySelector('#memoryGrid [data-mem="m1"] > .dd-memory-image')).backgroundImage.startsWith('url("blob:')`));
      check("[photos] the memory record itself is unchanged", same(Object.keys((await A.ls("studyflowMemories")).find((m) => m.id === "m1")).sort(), ["date", "hasPhoto", "id", "mood", "tags", "text", "title"]));
      if (SHOTS) await A.shot(path.join(SHOTS, "journal-photos-1280.png"), 1280, 900);
      await A.click('#memoryGrid [data-mem="m1"] .jr-thumb');
      await sleep(400);
      const big = await A.ev(`(() => { const d = document.querySelector("#photoDlg"), i = document.querySelector("#photoBig"); return { open: d.open, w: i.naturalWidth, count: document.querySelector("#photoCount").textContent }; })()`);
      check("[photos] a thumbnail opens the photo large, scaled down to 1000 pixels", big.open && big.w === 1000 && big.count === "1 of 3", JSON.stringify(big));
      await A.click("#photoNext");
      await sleep(200);
      check("[photos] Next moves to the next photo", (await A.text("#photoCount")) === "2 of 3");
      await A.click("#photoClose");
      await A.reload();
      await A.nav("journal");
      await sleep(600);
      check("[photos] the photos are still there after a reload", same(await thumbs(), [true, true, true]));
      await A.click('#memoryGrid [data-memory-edit="m1"]');
      await A.click(`#memPhotos [data-xdel="${keys[0]}"]`);
      await A.submit("#memForm");
      await sleep(700);
      check("[photos] removing one in the edit form deletes it from storage", (await A.ls("studyflowMemoryMeta")).m1.extra.length === 2 && (await stores()).album === 2);
      await A.load(OLD);
      await sleep(900);
      await A.load(NEW);
      await A.nav("journal");
      await sleep(600);
      check("[photos] opening the older build, which cleans up photos it does not know, leaves these alone", same(await stores(), { album: 2, main: 1 }) && same(await thumbs(), [true, true]), JSON.stringify(await stores()));
      await A.ev(`(async () => { const d = await new Promise((r) => { const q = indexedDB.open("studyflow-album", 1); q.onsuccess = () => r(q.result); }); const c = document.createElement("canvas"); c.width = 10; c.height = 10; const b = await new Promise((r) => c.toBlob(r, "image/png")); await new Promise((r) => { const t = d.transaction("photos", "readwrite"); t.objectStore("photos").put({ blob: b, orphanedAt: Date.now() - 31 * 864e5 }, "gone#old"); t.objectStore("photos").put({ blob: b }, "gone#new"); t.oncomplete = r; }); await sfMemPhotos.sweep(); })()`);
      check("[photos] a photo with no memory is kept for 30 days, then removed", (await stores()).album === 3 && (await A.ev(`(async () => { const d = await new Promise((r) => { const q = indexedDB.open("studyflow-album", 1); q.onsuccess = () => r(q.result); }); return new Promise((r) => { const q = d.transaction("photos").objectStore("photos").getAllKeys(); q.onsuccess = () => r(q.result.filter((k) => k.startsWith("gone")).join()); }); })()`)) === "gone#new");
      await A.nav("settings");
      await A.click('[data-set-tab="data"]');
      await A.ev(`window.__blobs = []; const o = URL.createObjectURL; URL.createObjectURL = (b) => { window.__blobs.push(b); return o.call(URL, b); }`);
      await A.click("#backupPhotos");
      await sleep(1500);
      const file = await A.ev(`(async () => { const t = await window.__blobs[window.__blobs.length - 1].text(); window.__backup = t; const b = JSON.parse(t); return { app: b.app, main: Object.keys(b.photos.main), album: Object.keys(b.photos.album).length, jpegs: Object.values(b.photos.album).filter((v) => v.startsWith("data:image/jpeg;base64,")).length, dataHasPhotos: JSON.stringify(b.data).includes("data:image"), keys: Object.keys(b).sort() }; })()`);
      check("[photos] the photo backup holds every photo at the top of the file, outside the data", file.app === "StudyFlow" && same(file.main, [cover]) && file.album === 3 && file.jpegs === 2 && !file.dataHasPhotos && same(file.keys, ["app", "data", "photos", "saved", "version"]), JSON.stringify(file));
      await A.click("#backupDownload");
      await sleep(300);
      check("[photos] the ordinary backup still has no photos", !(await A.ev(`(async () => (await window.__blobs[window.__blobs.length - 1].text()).includes("data:image"))()`)));
      const text = await A.ev(`window.__backup`);
      await A.click("#resetAll");
      await A.click("#resetAll");
      await sleep(2500);
      check("[photos] Delete all data clears both photo stores", same(await stores(), { album: 0, main: 0 }), JSON.stringify(await stores()));
      await A.nav("settings");
      await A.click('[data-set-tab="data"]');
      await A.ev(`(() => { const t = document.querySelector("#backupText"); t.closest("details").open = true; t.value = ${JSON.stringify("__TEXT__")}; })()`.replace('"__TEXT__"', JSON.stringify(text)));
      await A.click("#backupPaste");
      await A.click('#restoreConfirm [data-restore="yes"]');
      await sleep(3000);
      check("[photos] restoring the photo backup brings back the memories and all their photos", (await A.ls("studyflowMemories")).length === 2 && (await stores()).main === 1 && (await stores()).album === 3, JSON.stringify(await stores()));
      await A.click('#wsSwitch [data-mode="planning"]');
      await A.nav("journal");
      await sleep(700);
      check("[photos] and the journal shows them", same(await thumbs(), [true, true]) && (await A.ev(`!!document.querySelector('#memoryGrid [data-mem="${cover}"] img.dd-memory-image')`)));
    });

    await scenario("[shell] grouped sidebar and a workspace switcher", async () => {
      const groups = () => A.ev(`(() => { const out = []; for (const el of document.querySelector("#nav").children) { if (el.classList.contains("label")) out.push([el.textContent, []]); else if (!el.hidden) out[out.length - 1][1].push(el.lastElementChild.textContent); } return out; })()`);
      await A.fresh(NEW, {});
      check("[shell] StudyFlow groups its pages under four labels", same(await groups(), [["OVERVIEW", ["Dashboard", "Calendar", "All Assignments"]], ["ACADEMICS", ["My Classes", "Grade Tracker", "Notes", "Flashcards"]], ["PRODUCTIVITY", ["Study Planner", "Focus Timer"]], ["OTHER", ["AI Study Assistant", "Settings"]]]), JSON.stringify(await groups()));
      check("[shell] the switcher shows the current workspace", same(await A.ev(`[...document.querySelectorAll("#wsSwitch button")].map((b) => [b.textContent, b.getAttribute("aria-pressed")])`), [["School", "true"], ["Work", "false"], ["DayDream", "false"]]));
      await A.click('#wsSwitch [data-mode="planning"]');
      check("[shell] the switcher opens DayDream and saves it", (await A.ev(`localStorage.getItem("studyflowMode")`)) === "planning" && (await A.text(".brand b")) === "DayDream");
      check("[shell] DayDream groups its pages", same(await groups(), [["YOUR SPACE", ["Home", "My Plans", "Calendar"]], ["ORGANIZATION", ["Checklists", "Budget Planner"]], ["MEMORIES", ["Digital Journal"]], ["MORE", ["AI", "Settings"]]]), JSON.stringify(await groups()));
      await A.nav("settings");
      check("[shell] the Settings switch agrees with the sidebar one", (await A.ev(`document.querySelector('#modeSeg [data-mode="planning"]').classList.contains("on")`)) === true);
      await A.click('#wsSwitch [data-mode="work"]');
      check("[shell] Work groups its pages", same(await groups(), [["OVERVIEW", ["Dashboard", "Calendar"]], ["WORK", ["Work"]], ["OTHER", ["AI", "Settings"]]]), JSON.stringify(await groups()));
      await A.click('#wsSwitch [data-mode="school"]');
      for (const [w, h] of [[393, 852], [820, 1180], [1280, 900]]) {
        await A.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
        await sleep(250);
        const fit = await A.ev(`(() => { const r = (s) => document.querySelector(s).getBoundingClientRect(); const sw = r("#wsSwitch"), nav = r("#nav"); return { scroll: document.documentElement.scrollWidth - innerWidth, sw: sw.width > 0 && sw.left >= 0 && sw.right <= innerWidth + 1, navBottom: Math.round(innerHeight - nav.bottom), navTop: Math.round(nav.top), first: document.querySelector(".nav:not([hidden])").getBoundingClientRect().width > 20 }; })()`);
        check(`[shell] ${w}px wide: no sideways page scroll, switcher and pages on screen`, fit.scroll <= 0 && fit.sw && fit.first && (w > 700 || (fit.navBottom === 0 && fit.navTop > h - 90)), JSON.stringify(fit));
        if (SHOTS) await A.shot(path.join(SHOTS, `shell-school-${w}.png`), w, h);
      }
      await A.send("Emulation.setDeviceMetricsOverride", { width: 393, height: 852, deviceScaleFactor: 1, mobile: true });
      await A.nav("settings");
      await sleep(400);
      check("[shell] phone: the open page's button is scrolled into view in the bottom bar", await A.ev(`(() => { const b = document.querySelector(".nav.active").getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth + 1; })()`));
      await A.nav("assistant");
      await sleep(400);
      check("[shell] phone: the AI message box sits above the bottom bar", await A.ev(`document.querySelector("#chatShell").getBoundingClientRect().bottom <= document.querySelector("#nav").getBoundingClientRect().top + 1`));
      if (SHOTS) { await A.shot(path.join(SHOTS, "shell-school-ai-393.png"), 393, 852); await A.click('#wsSwitch [data-mode="planning"]'); await A.shot(path.join(SHOTS, "shell-daydream-393.png"), 393, 852); }
      await A.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    });

    await scenario("[look] Settings cannot change the saved design in DayDream mode", async () => {
      await A.fresh(NEW, { studyflowMode: "school", studyflowColors: { accent: "#2fa57c", background: "#e6f7ef", background2: "#dff3ea", cards: "#ffffff", text: "#1f4a3c" } });
      const saved = await A.ev(`localStorage.getItem("studyflowColors")`);
      const controls = () => A.ev(`[...document.querySelectorAll("#setPanel-appearance input, #setPanel-appearance button")].filter((e) => e.offsetParent !== null).length`);
      const panel = () => A.ev(`document.querySelector("#setPanel-appearance").innerText`);
      await A.setMode("planning");
      await A.click('[data-set-tab="appearance"]');
      check("[look] DayDream mode shows only its five color buttons in Settings", (await controls()) === 5 && (await A.count("#setPanel-appearance [data-dd-color]")) === 5, `${await controls()} visible`);
      check("[look] Appearance says the DayDream color leaves the School and Work design alone", /Pick a color for DayDream/.test(await panel()) && /School and Work design is not changed/.test(await panel()), await panel());
      await A.click('[data-dd-color="mint"]');
      check("[look] studyflowColors is unchanged", (await A.ev(`localStorage.getItem("studyflowColors")`)) === saved);
      for (const m of ["school", "work"]) {
        await A.setMode(m);
        await A.click('[data-set-tab="appearance"]');
        check(`[look] ${m}: the color controls are back and the DayDream note is gone`, (await controls()) > 5 && !/DayDream/.test(await panel()), `${await controls()} ${await panel()}`);
      }
    });

    await scenario("[1] existing data", async () => {
      await A.fresh(NEW, seedV1);
      await A.nav("plan");
      check("[1] planning events are plans, soonest first, school and work events are not", same(await planTitles(), ["Dentist", "Legacy picnic"]), JSON.stringify(await planTitles()));
      await A.nav("checklists");
      check("[1] v1 to-dos are in General with their done state", (await A.text('#checklistCards [data-list=""] .dd-progress')) === "1 of 2 done" && same(await A.texts('#checklistCards [data-list=""] .dd-check-title'), ["Buy stamps", "Call grandma"]), JSON.stringify(await A.texts('#checklistCards [data-list=""] .dd-check-title')));
      check("[1] a to-do's due date and note still show", /post office/.test(await A.text('#checklistCards [data-list=""]')) && /Due /.test(await A.text('#checklistCards [data-list=""]')));
      check("[1] each plan has its own card", (await A.count("#checklistCards [data-list]")) === 3);
      check("[1] loading wrote nothing new", same(await A.ls("studyflowPlanning"), seedV1.studyflowPlanning) && same(await A.ls("studyflowEvents"), seedV1.studyflowEvents) && (await A.ev(`localStorage.getItem("studyflowMemories")`)) === null);
      await A.nav("dashboard");
      const tiles = await A.texts("#dashPlanStats .dd-stat-number");
      check("[1] dashboard tiles: 2 plans, 2 upcoming, 1 open item, next plan", tiles.length === 4 && same(tiles.slice(0, 3), ["2", "2", "1"]) && tiles[3].includes("Dentist"), JSON.stringify(tiles));
      check("[1] dashboard lists what is coming up and the General checklist", same(await A.texts("#dashPlanList .dd-timeline-title"), ["Dentist", "Legacy picnic"]) && (await A.count("#dashChecklist [data-plan-todo]")) === 2);
    });

    await scenario("[2] plans", async () => {
      await A.fresh(NEW, seedV1);
      await A.nav("plan");
      await A.click("#addPlan");
      check("[2] plan form has the DayDream fields", same(await A.ev(`[...document.querySelectorAll("#modalFields [name]")].map((i) => i.name)`), ["title", "type", "date", "start", "end", "place", "note", "icon"]), JSON.stringify(await A.ev(`[...document.querySelectorAll("#modalFields [name]")].map((i) => i.name)`)));
      await A.setValue('#modalForm [name="title"]', "<b>Ski trip</b>");
      await A.setValue('#modalForm [name="type"]', "event");
      check("[2] icon follows the type default", (await A.value('#modalForm [name="icon"]')) === "balloon");
      await A.click('#modalFields [data-icon="film"]');
      await A.setValue('#modalForm [name="date"]', await inDays(5));
      await A.setValue('#modalForm [name="place"]', "Tahoe");
      await A.submit("#modalForm");
      const ski = await planByTitle("<b>Ski trip</b>");
      check("[2] plan is saved as a planning event with type, place and icon", ski && ski.mode === "planning" && ski.type === "event" && ski.place === "Tahoe" && ski.icon === "film" && ski.date === (await inDays(5)), JSON.stringify(ski));
      check("[2] card shows the escaped title, icon and type tag", (await planTitles()).includes("<b>Ski trip</b>") && (await A.count("#planGrid b")) === 0 && (await A.count(`#planGrid [data-plan-open="${ski.id}"] .dd-cover svg.dd-ico`)) === 1 && (await A.text(`[data-plan-open="${ski.id}"] .dd-cover-tag`)) === "Event");

      await A.click('#planFilter [data-plan-type="event"]');
      check("[2] Events filter shows untyped old events and the new event", same(await planTitles(), ["Dentist", "<b>Ski trip</b>", "Legacy picnic"]), JSON.stringify(await planTitles()));
      await A.click('#planFilter [data-plan-type="trip"]');
      check("[2] Vacations filter is empty", (await planTitles()).length === 0 && (await A.count("#planGrid .dd-empty")) === 1);
      await A.click('#planFilter [data-plan-type="all"]');

      await A.click(`[data-plan-open="${ski.id}"]`);
      check("[2] detail shows the plan with its countdown and place", (await A.text("#planModalTitle")) === "<b>Ski trip</b>" && (await A.text("#planModal .dd-countdown")) === "in 5 days" && (await A.text("#planModal")).includes("Tahoe"), await A.text("#planModal"));
      await A.addTodo("#planModal", ski.id, "bring skis");
      await A.addTodo("#planModal", ski.id, "wax board");
      check("[2] items added to this plan carry its planId", (await A.ls("studyflowPlanning")).todos.filter((t) => t.planId === ski.id).length === 2 && (await A.text("#planModal .dd-progress")) === "0 of 2 done");
      await A.click("#planModal [data-plan-todo]");
      check("[2] ticking an item in the detail counts it", (await A.text("#planModal .dd-progress")) === "1 of 2 done");
      await A.click("#planModal [data-plan-todo-del]", 1);
      check("[2] deleting an item removes it", (await A.count("#planModal [data-plan-todo]")) === 1);
      await A.ev(`localStorage.removeItem("studyflowTrash")`);

      await A.click("#planModal [data-plan-edit]");
      check("[2] edit form is prefilled", (await A.value('#modalForm [name="title"]')) === "<b>Ski trip</b>" && (await A.value('#modalForm [name="place"]')) === "Tahoe" && (await A.value('#modalForm [name="icon"]')) === "film");
      await A.setValue('#modalForm [name="title"]', "Ski weekend");
      await A.setValue('#modalForm [name="note"]', "Bring cocoa");
      await A.submit("#modalForm");
      const edited = await planByTitle("Ski weekend");
      check("[2] edit changes the same record and keeps its other fields", edited && edited.id === ski.id && edited.note === "Bring cocoa" && edited.type === "event" && edited.icon === "film" && (await A.ls("studyflowEvents")).length === 5, JSON.stringify(edited));

      await A.click(`#planGrid [data-plan-open="${ski.id}"]`);
      await A.click("#planModal [data-plan-del]");
      check("[2] delete asks first, inside the app", (await A.count("#confirmBg.show")) === 1 && (await A.text("#confirmMsg")).includes("1 checklist item"), await A.text("#confirmMsg"));
      await A.click("#confirmNo");
      check("[2] Cancel keeps the plan", !!(await planByTitle("Ski weekend")));
      await A.click("#planModal [data-plan-del]");
      await A.click("#confirmYes");
      check("[2] confirmed delete removes the plan and its items", !(await planByTitle("Ski weekend")) && (await A.ls("studyflowPlanning")).todos.every((t) => t.planId !== ski.id) && (await A.count("#planBg.show")) === 0);
      await A.nav("settings");
      check("[2] the deleted plan is in Recently deleted", (await A.text("#trashList h4")) === "Ski weekend");
      await A.click("#trashList [data-restore]");
      const back = await planByTitle("Ski weekend");
      const backTodos = (await A.ls("studyflowPlanning")).todos.filter((t) => t.planId === ski.id);
      check("[2] restore puts the plan and its checklist back", back && back.place === "Tahoe" && !("todos" in back) && backTodos.length === 1 && backTodos[0].title === "bring skis" && backTodos[0].done === true, JSON.stringify([back, backTodos]));
    });

    await scenario("[phone] the plan form can be saved on a phone", async () => {
      for (const [w, h] of [[393, 659], [375, 553]]) {
        await A.fresh(NEW, seedV1);
        await A.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: true });
        await sleep(300);
        const save = '#modalForm [type="submit"]';
        const where = () => A.ev(`(() => { const b = document.querySelector(${JSON.stringify(save)}).getBoundingClientRect(); return [Math.round(b.top), Math.round(b.bottom), innerHeight]; })()`);
        await A.nav("plan");
        await A.click("#addPlan");
        await A.setValue('#modalForm [name="title"]', `Phone plan ${w}`);
        await A.tap(save);
        check(`[phone] ${w}x${h}: a real tap on Save in the new-plan form creates the plan`, !!(await planByTitle(`Phone plan ${w}`)) && (await A.count("#modalBg.show")) === 0, `Save button top, bottom, viewport ${JSON.stringify(await where())}`);
        await A.click('[data-plan-open="21"]');
        await A.click("#planModal [data-plan-edit]");
        await A.setValue('#modalForm [name="title"]', `Edited ${w}`);
        await A.tap(save);
        check(`[phone] ${w}x${h}: a real tap on Save in the edit form saves the plan`, (await planByTitle(`Edited ${w}`))?.id === 21 && (await A.count("#modalBg.show")) === 0, `Save button top, bottom, viewport ${JSON.stringify(await where())}`);
      }
      await A.send("Emulation.clearDeviceMetricsOverride");
    });

    await scenario("[3] calendar in DayDream mode", async () => {
      await A.fresh(NEW, planning);
      await A.nav("plan");
      await A.newPlan({ title: "Today thing", type: "outing", date: today, start: "18:00" });
      const plan = await planByTitle("Today thing");
      await A.nav("calendar");
      const chip = await A.ev(`[...document.querySelectorAll(".day.today .chip")].map((c) => [c.textContent, c.className])`);
      check("[3] today's cell has the plan's chip, in the event color", chip.length === 1 && chip[0][0].startsWith("Today thing") && chip[0][1].includes("k-event"), JSON.stringify(chip));
      await A.tap(".day.today .chip");
      check("[3] tapping the chip opens that plan", (await A.count("#planBg.show")) === 1 && (await A.text("#planModalTitle")) === "Today thing");
      await A.press("Escape");
      check("[3] Escape closes the plan", (await A.count("#planBg.show")) === 0);
      const legend = await A.ev(`document.querySelector("#calLegend").innerText`);
      check("[3] the color key calls plans Plans", /\bPlans\b/.test(legend) && !/\bEvents\b/.test(legend), JSON.stringify(legend));
      check("[3] a plan's line in the day list says Plan", (await A.text("#calDay .meta")).startsWith("Plan · Outing"), await A.text("#calDay .meta"));
      check("[3] a plan's row in the day list has no one-tap Delete", (await A.count("#calDay [data-cal-event-del]")) === 0 && (await A.count("#calDay .task")) === 1, JSON.stringify(await A.ev(`document.querySelector("#calDay").innerText`)));
      await A.click("#calDay [data-plan-open]");
      check("[3] the plan in the day list opens it too", (await A.text("#planModalTitle")) === "Today thing");
      await A.click("#planModal [data-plan-close]");
      const other = await A.ev(`[...document.querySelectorAll("#calendarGrid .day")].find((d) => d.dataset.day !== ${JSON.stringify(today)}).dataset.day`);
      await A.tap(`#calendarGrid .day[data-day="${other}"]`);
      await A.click("#calDayAdd");
      check("[3] the day button opens the plan form with that day preset", (await A.text("#modalTitle")) === "Create a new plan" && (await A.value('#modalForm [name="date"]')) === other, `${await A.text("#modalTitle")} ${await A.value('#modalForm [name="date"]')}`);
      await A.click("#cancel");
      await A.click("#addCalEvent");
      check("[3] the calendar's add button opens the plan form too", (await A.count('#modalForm [name="icon"]')) === 1 && (await A.value('#modalForm [name="date"]')) === other);
      await A.setValue('#modalForm [name="title"]', "From calendar");
      await A.submit("#modalForm");
      check("[3] a plan made from the calendar is a plan on that day", (await planByTitle("From calendar"))?.date === other && (await A.text(`.day[data-day="${other}"] .chip`)).includes("From calendar") && plan.type === "outing");
    });

    await scenario("[print] journal print", async () => {
      await A.fresh(NEW, planning);
      await A.nav("journal");
      await A.ev(`window.__prints = 0; window.print = () => { window.__prints++; }`);
      await A.click("#printJournal");
      check("[print] an empty journal does not print", (await A.ev(`window.__prints`)) === 0 && !(await A.ev(`document.documentElement.classList.contains("print-journal")`)));
      await A.saveMemory({ "#memoryTitle": "Beach day", "#memoryText": "Sand everywhere" }, true);
      await A.saveMemory({ "#memoryTitle": "Movie night", "#memoryText": "Popcorn" }, false);
      await A.click("#printJournal");
      check("[print] the button opens the print dialog once", (await A.ev(`window.__prints`)) === 1);
      await A.send("Emulation.setEmulatedMedia", { media: "print" });
      const shown = await A.ev(`(() => { const v = (s) => [...document.querySelectorAll(s)].some((e) => e.getClientRects().length > 0); return { memories: [...document.querySelectorAll("#memoryGrid .dd-memory h3")].filter((e) => e.getClientRects().length).map((e) => e.textContent), photo: v("#memoryGrid img"), text: v(".dd-memory-text"), aside: v("aside"), form: v("#memoryForm"), del: v(".dd-memory-del"), button: v("#printJournal"), other: v("main > *:not(#page-journal)") }; })()`);
      check("[print] the printed page shows every memory with its photo and text", same([...shown.memories].sort(), ["Beach day", "Movie night"]) && shown.photo && shown.text, JSON.stringify(shown));
      check("[print] the printed page leaves out the sidebar, the form and the buttons", !shown.aside && !shown.form && !shown.del && !shown.button && !shown.other, JSON.stringify(shown));
      if (process.env.SHOTS) { const pdf = await A.send("Page.printToPDF", { printBackground: true }); require("fs").writeFileSync(require("path").join(process.env.SHOTS, "journal-print.pdf"), Buffer.from(pdf.result.data, "base64")); }
      await A.send("Emulation.setEmulatedMedia", { media: "" });
      await A.ev(`dispatchEvent(new Event("afterprint"))`);
      check("[print] the screen goes back to normal after printing", (await A.ev(`!document.documentElement.classList.contains("print-journal") && document.querySelector("aside").getClientRects().length > 0`)));
    });

    await scenario("[4] journal with a photo", async () => {
      await A.fresh(NEW, planning);
      await A.nav("journal");
      check("[4] the form says photos stay on this device", /stay on this device/i.test(await A.text("#memoryForm")) && /backup/i.test(await A.text("#memoryForm")));
      await A.submit("#memoryForm");
      check("[4] an empty memory shows a message and saves nothing", (await A.text("#journalMsg")).length > 0 && (await A.ev(`localStorage.getItem("studyflowMemories")`)) === null);
      await A.pickPhoto();
      check("[4] photo preview is shown", await A.ev(`!document.querySelector("#memoryPreview").hidden && document.querySelector("#memoryPreview").src.startsWith("blob:")`));
      await A.saveMemory({ "#memoryTitle": "Beach <i>day</i>", "#memoryTags": "sun, #sea", "#memoryText": "Waves", "#memoryMood": "Happy ☀️" });
      const mem = (await A.ls("studyflowMemories"))?.[0];
      check("[4] memory is saved in its own key", mem && same(Object.keys(mem).sort(), ["date", "hasPhoto", "id", "mood", "tags", "text", "title"]) && mem.hasPhoto === true && same(mem.tags, ["sun", "sea"]) && mem.date === today, JSON.stringify(mem));
      check("[4] card is escaped and shows tags and the stored photo", (await A.count("#memoryGrid .dd-memory")) === 1 && (await A.count("#memoryGrid i")) === 0 && (await A.count("#memoryGrid .dd-memory-tag")) === 2 && (await A.ev(`!!document.querySelector("#memoryGrid img[src^='blob:']")`)));
      check("[4] form is cleared after saving", (await A.value("#memoryTitle")) === "" && (await A.ev(`document.querySelector("#memoryPreview").hidden`)));
      const photos = await A.photos();
      const dims = await A.ev(`(async () => { const i = document.querySelector("#memoryGrid img"); await i.decode(); return [i.naturalWidth, i.naturalHeight]; })()`);
      check("[4] photo is one 1000px JPEG in IndexedDB under the memory's id", photos.length === 1 && photos[0].id === mem.id && photos[0].type === "image/jpeg" && same(dims, [1000, 500]) && photos[0].orphanedAt === null, JSON.stringify([photos, dims]));
      const stored = JSON.stringify(await A.snapshot());
      check("[4] no image data in localStorage", !stored.includes("data:image") && !stored.includes("blob:") && stored.length < 20000, String(stored.length));
      await A.ev(`Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (t) => { window.__copied = t; return Promise.resolve(); } } })`);
      await A.click("#backupCopy");
      const backup = await A.ev(`window.__copied`);
      check("[4] the backup has the memory and no photo", !!backup && JSON.parse(backup).data.studyflowMemories.includes("Beach") && !backup.includes("data:image") && backup.length < 40000, String(backup?.length));

      await A.click("#memoryGrid [data-memory-del]");
      await A.click("#confirmYes");
      check("[4] deleted memory leaves the journal and keeps its photo for restore", (await A.count("#memoryGrid .dd-memory")) === 0 && (await A.ls("studyflowMemories")).length === 0 && (await A.photos()).length === 1);
      await A.reload();
      check("[4] a photo held only by the trash is not marked for cleanup", (await A.photos())[0]?.orphanedAt === null, JSON.stringify(await A.photos()));
      await A.nav("settings");
      await A.click("#trashList [data-restore]");
      await A.nav("journal");
      await sleep(300);
      check("[4] restore from Recently deleted brings the memory back with its photo", (await A.ls("studyflowMemories"))[0]?.id === mem.id && (await A.ev(`!!document.querySelector("#memoryGrid img[src^='blob:']")`)));
      await A.nav("dashboard");
      await sleep(200);
      check("[4] dashboard shows the latest memory with its photo", (await A.count("#dashMemories .dd-memory")) === 1 && (await A.ev(`!!document.querySelector("#dashMemories img[src^='blob:']")`)));
    });

    await scenario("[4] a photo store that never answers", async () => {
      const stub = await A.send("Page.addScriptToEvaluateOnNewDocument", { source: "IDBFactory.prototype.open = function () { return {}; };" });
      try {
        await A.fresh(NEW, planning);
        await A.nav("journal");
        await A.pickPhoto();
        await A.setValue("#memoryTitle", "No database");
        await A.ev(`document.querySelector("#memoryForm").requestSubmit()`);
        await sleep(5000);
        const mem = (await A.ls("studyflowMemories"))?.[0];
        check("[4] within 5 seconds the memory is saved without its photo", mem?.title === "No database" && mem.hasPhoto === false, JSON.stringify(mem));
        check("[4] the student is told the photo was left out", /left out/.test(await A.text("#toast")), await A.text("#toast"));
        check("[4] the save button works again", (await A.ev(`document.querySelector("#memoryForm button[type=submit]").disabled`)) === false);
      } finally {
        await A.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: stub.result.identifier });
      }
    });

    await scenario("checklists page", async () => {
      await A.fresh(NEW, seedV1);
      await A.nav("checklists");
      await A.addTodo("#checklistCards", "", "new item");
      check("general item added", (await A.text('#checklistCards [data-list=""] .dd-progress')) === "1 of 3 done" && (await A.ls("studyflowPlanning")).todos.at(-1).title === "new item" && !(await A.ls("studyflowPlanning")).todos.at(-1).planId);
      await A.addTodo("#checklistCards", "21", "only item");
      check("item added to a plan's card", (await A.text('#checklistCards [data-list="21"] .dd-progress')) === "0 of 1 done" && (await A.ls("studyflowPlanning")).todos.at(-1).planId === 21);
      await A.click('#checklistCards [data-list="21"] [data-plan-todo-del]');
      check("removing a plan's last item keeps its card and add box", (await A.count('#checklistCards [data-list="21"] form[data-todo-add]')) === 1);
      await A.click('#checklistCards [data-list="21"] [data-plan-open]');
      check("a plan's card title opens the plan", (await A.text("#planModalTitle")) === "Dentist");
      await A.press("Escape");
      await A.click("#addDatedTodo");
      await A.setValue('#modalForm [name="title"]', "Renew pass");
      await A.setValue('#modalForm [name="due"]', today);
      await A.submit("#modalForm");
      await A.nav("calendar");
      check("a to-do with a due date still shows on the calendar", (await A.texts(".day.today .chip.k-plan")).includes("Renew pass"), JSON.stringify(await A.texts(".day.today .chip")));
      check("DayDream has no Focus Timer in the sidebar or in Settings", await A.ev(`document.querySelector('.nav[data-page="focus"]').hidden && document.querySelector("#featuresCard").offsetParent === null`));
      check("AI summary still lists open to-dos and upcoming plans", (await A.ev(`sfPlanSummary()`)).includes("Buy stamps") && (await A.ev(`sfEventList().join("|")`)).includes("Dentist"));
    });

    await scenario("[tabs] two open tabs keep each other's changes", async () => {
      await A.fresh(NEW, seedV1);
      const tab = await (await fetch(`http://127.0.0.1:${port}/json/new?${NEW}`, { method: "PUT" })).json();
      const B = await attach(tab.webSocketDebuggerUrl);
      try {
        await B.ready();
        await B.nav("checklists");
        const box = `#checklistCards [data-list=""] form[data-todo-add] input`;
        await B.ev(`(() => { const i = document.querySelector(${JSON.stringify(box)}); i.focus(); i.value = "half"; i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
        await B.ev(`(() => { window.__writes = 0; const raw = Storage.prototype.setItem; Storage.prototype.setItem = function (...a) { window.__writes++; return raw.apply(this, a); }; })()`);
        await A.nav("plan");
        await A.newPlan({ title: "Shared trip", type: "trip" });
        const trip = await planByTitle("Shared trip");
        await A.click(`[data-plan-open="${trip.id}"]`);
        await A.addTodo("#planModal", trip.id, "pack bag");
        await A.press("Escape");
        await sleep(300);
        check("[tabs] the other tab shows the new plan and its item without a reload", same(await B.texts(`#checklistCards [data-list="${trip.id}"] .dd-check-title`), ["pack bag"]), JSON.stringify(await B.texts("#checklistCards .dd-check-title")));
        check("[tabs] taking the other tab's changes writes nothing", (await B.ev("window.__writes")) === 0, String(await B.ev("window.__writes")));
        check("[tabs] a half-typed item in the other tab keeps its text and focus", (await B.value(box)) === "half" && (await B.ev(`document.activeElement === document.querySelector(${JSON.stringify(box)})`)));
        await B.click('#checklistCards [data-plan-todo="11"]');
        const todos = (await A.ls("studyflowPlanning")).todos;
        check("[tabs] ticking a to-do in the tab opened earlier keeps the plan and item the other tab added", !!(await planByTitle("Shared trip")) && todos.some((t) => t.title === "pack bag" && t.planId === trip.id) && todos.find((t) => t.id === 11).done === true, JSON.stringify(todos));
        await A.reload();
        await A.nav("checklists");
        check("[tabs] the first tab sees the tick after a reload", (await A.ev(`document.querySelector('#checklistCards [data-plan-todo="11"]').checked`)) === true);
        await B.click('#checklistCards [data-list="21"] [data-plan-open]');
        await A.nav("plan");
        await A.click('[data-plan-open="21"]');
        await A.click("#planModal [data-plan-del]");
        await A.click("#confirmYes");
        await sleep(300);
        check("[tabs] a plan deleted in one tab closes its open detail in the other", (await B.count("#planBg.show")) === 0 && (await B.count('#checklistCards [data-list="21"]')) === 0);
        await B.nav("plan");
        await B.click('[data-plan-open="22"]');
        await B.click("#planModal [data-plan-edit]");
        await A.click('[data-plan-open="22"]');
        await A.click("#planModal [data-plan-del]");
        await A.click("#confirmYes");
        await sleep(300);
        check("[tabs] a plan deleted in one tab closes its edit form in the other", (await B.count("#modalBg.show")) === 0);
      } finally {
        B.close();
        await fetch(`http://127.0.0.1:${port}/json/close/${tab.id}`);
      }
    });

    let oldTrashEntry = null;
    await scenario("[5] an old client cannot destroy new data", async () => {
      await A.fresh(NEW, seedV1);
      await A.nav("plan");
      await A.newPlan({ title: "Camping", type: "trip", date: await inDays(12), place: "Big Sur" });
      const camp = await planByTitle("Camping");
      await A.click(`[data-plan-open="${camp.id}"]`);
      await A.addTodo("#planModal", camp.id, "pack tent");
      await A.press("Escape");
      await A.nav("journal");
      await A.saveMemory({ "#memoryTitle": "Kept" }, true);
      const before = { events: await A.ls("studyflowEvents"), todos: (await A.ls("studyflowPlanning")).todos, memories: await A.ev(`localStorage.getItem("studyflowMemories")`), photos: await A.photos() };
      const seen = async () => { await A.nav("plan"); const card = await A.ev(`document.querySelector('#planGrid [data-plan-open="${camp.id}"]').innerText`); await A.nav("checklists"); return [card, await A.texts(`#checklistCards [data-list="${camp.id}"] .dd-check-title`)]; };
      const seenBefore = await seen();

      await A.load(OLD);
      await A.nav("plan");
      await A.click('#planTodoList [data-plan-todo="11"]');
      await A.click("#addPlanEvent");
      await A.setValue('#modalForm [name="title"]', "Added by old build");
      await A.submit("#modalForm");
      await A.click(`#planEventList [data-cal-event-del="22"]`);
      oldTrashEntry = (await A.ls("studyflowTrash"))[0];
      check("[5] the old build really wrote all three keys", (await A.ls("studyflowPlanning")).todos.find((t) => t.id === 11).done === true && (await A.ls("studyflowEvents")).some((e) => e.title === "Added by old build") && oldTrashEntry?.kind === "pevent");

      await A.load(NEW);
      const after = { events: await A.ls("studyflowEvents"), todos: (await A.ls("studyflowPlanning")).todos };
      const campAfter = after.events.find((e) => e.id === camp.id);
      check("[5] every plan field survived the old build", same(campAfter, before.events.find((e) => e.id === camp.id)) && campAfter.type === "trip" && campAfter.place === "Big Sur" && campAfter.icon === "plane", JSON.stringify(campAfter));
      const seenAfter = await seen();
      check("[5] the plan card and its checklist read the same after the old build wrote", seenBefore[0].includes("Big Sur") && seenBefore[0].includes("Vacation") && same(seenBefore[1], ["pack tent"]) && same(seenAfter, seenBefore), `before ${JSON.stringify(seenBefore)} after ${JSON.stringify(seenAfter)}`);
      check("[5] every planId survived", same(after.todos.map((t) => [t.id, t.planId ?? null]), before.todos.map((t) => [t.id, t.planId ?? null])) && after.todos.some((t) => t.planId === camp.id));
      check("[5] memories and the photo survived", (await A.ev(`localStorage.getItem("studyflowMemories")`)) === before.memories && same(await A.photos(), before.photos) && before.photos.length === 1);
      await A.nav("plan");
      check("[5] the new build shows the old build's event as a plan", (await planTitles()).includes("Added by old build") && (await planTitles()).includes("Camping"));
      await A.nav("settings");
      await A.click("#trashList [data-restore]");
      check("[6] a pevent trash entry made by the old build restores as a plan", !!(await planByTitle("Legacy picnic")) && (await A.ls("studyflowTrash")).length === 0);
    });

    await scenario("[6] a plan deleted in the new build and restored by the old one keeps its checklist", async () => {
      await A.fresh(NEW, seedV1);
      await A.nav("plan");
      await A.newPlan({ title: "Picnic", type: "outing", date: await inDays(6), place: "Park" });
      const pic = await planByTitle("Picnic");
      await A.click(`[data-plan-open="${pic.id}"]`);
      await A.addTodo("#planModal", pic.id, "blanket");
      await A.addTodo("#planModal", pic.id, "lemonade");
      await A.click("#planModal [data-plan-todo]");
      await A.click("#planModal [data-plan-del]");
      await A.click("#confirmYes");
      check("[6] the new build deleted the plan and its items", !(await planByTitle("Picnic")) && (await A.ls("studyflowPlanning")).todos.every((t) => t.planId !== pic.id));
      await A.load(OLD);
      // The old build leaves Recently deleted empty after a load in Planning mode until something redraws it.
      await A.setMode("school");
      await A.setMode("planning");
      check("[6] the old build lists the deleted plan", same(await A.texts("#trashList h4"), ["Picnic"]), JSON.stringify(await A.texts("#trashList h4")));
      await A.click("#trashList [data-restore]");
      check("[6] the old build restored it", !!(await planByTitle("Picnic")));
      await A.load(NEW);
      await A.nav("plan");
      await A.click(`[data-plan-open="${pic.id}"]`);
      check("[6] the new build shows the restored plan with its place and checklist", (await A.text("#planModalTitle")) === "Picnic" && (await A.text("#planModal")).includes("Park") && same(await A.texts("#planModal .dd-check-title"), ["blanket", "lemonade"]) && (await A.text("#planModal .dd-progress")) === "1 of 2 done", await A.text("#planModal"));
      const stored = await planByTitle("Picnic");
      check("[6] the items are back in studyflowPlanning, not inside the event", !("todos" in stored) && (await A.ls("studyflowPlanning")).todos.filter((t) => t.planId === pic.id).length === 2, JSON.stringify(stored));
    });

    await scenario("[6] sync and restore paths", async () => {
      await A.fresh(NEW, seedV1);
      const older = await A.snapshot();
      await A.nav("journal");
      await A.saveMemory({ "#memoryTitle": "Lake" }, true);
      const newer = await A.snapshot();
      const id = (await A.photos())[0].id;

      await A.putSnapshot(older);
      await sleep(300);
      let p = await A.photos();
      check("[6] an older cloud copy leaves the photo in place, only marked", p.length === 1 && p[0].id === id && typeof p[0].orphanedAt === "number", JSON.stringify(p));
      await A.reload();
      await sleep(300);
      check("[6] the mark is not moved by another load", (await A.photos())[0].orphanedAt === p[0].orphanedAt);
      await A.putSnapshot(newer);
      await A.nav("journal");
      await sleep(300);
      p = await A.photos();
      check("[6] when the newer copy returns the photo is shown and unmarked", p.length === 1 && p[0].orphanedAt === null && (await A.ev(`!!document.querySelector("#memoryGrid img[src^='blob:']")`)), JSON.stringify(p));

      await A.putSnapshot(older);
      await sleep(300);
      await A.agePhoto(id, 29);
      await A.reload();
      await sleep(300);
      check("[6] an unreferenced photo is kept for 29 days", (await A.photos()).length === 1);
      await A.agePhoto(id, 31);
      await A.reload();
      await sleep(300);
      check("[6] it is removed once unreferenced for more than 30 days", (await A.photos()).length === 0, JSON.stringify(await A.photos()));
      await A.putSnapshot(newer);
      await A.nav("journal");
      await sleep(300);
      check("[6] a memory whose photo is not on this device says so", /another device/i.test(await A.text("#memoryGrid .dd-memory")) && (await A.count("#memoryGrid img")) === 0, await A.text("#memoryGrid .dd-memory"));

      await A.fresh(OLD, seedV1);
      const oldBackup = JSON.stringify({ app: "StudyFlow", version: 1, saved: new Date().toISOString(), data: await A.snapshot() });
      await A.fresh(NEW, planning);
      await A.nav("journal");
      await A.saveMemory({ "#memoryTitle": "Before restore" }, true);
      await A.nav("settings");
      await A.setValue("#backupText", oldBackup);
      await A.click("#backupPaste");
      await A.click('#restoreConfirm [data-restore="yes"]');
      await sleep(300);
      await A.ready();
      await A.nav("plan");
      check("[6] a backup from before the change restores as plans and General items", same(await planTitles(), ["Dentist", "Legacy picnic"]) && (await A.ls("studyflowPlanning")).todos.length === 2 && (await A.ev(`localStorage.getItem("studyflowMemories")`)) === null, JSON.stringify(await planTitles()));
      check("[6] restoring a backup does not delete photos", (await A.photos()).length === 1);

      await A.nav("settings");
      await A.click("#resetAll");
      await A.click("#resetAll");
      await sleep(400);
      await A.ready();
      check("[6] Reset empties the photo store and the data", (await A.photos()).length === 0 && (await A.ev(`localStorage.getItem("studyflowEvents")`)) === null, JSON.stringify(await A.photos()));
    });

    await scenario("[8] typed text survives re-renders", async () => {
      await A.fresh(NEW, seedV1);
      await A.nav("checklists");
      await A.tap('#checklistCards [data-list=""] form[data-todo-add] input');
      await A.type("half");
      await A.tap('#checklistCards [data-list=""] [data-plan-todo]');
      check("[8] half-typed item survives ticking a box on Checklists", (await A.value('#checklistCards [data-list=""] form[data-todo-add] input')) === "half" && (await A.text('#checklistCards [data-list=""] .dd-progress')) === "2 of 2 done");
      await A.press("Enter");
      check("[8] nothing was added by a stray Enter after the tick", (await A.ls("studyflowPlanning")).todos.length === 2);
      await A.tap('#checklistCards [data-list=""] form[data-todo-add] input');
      await A.press("Enter");
      check("[8] Enter in the box adds the item and clears the box", (await A.ls("studyflowPlanning")).todos.at(-1).title === "half" && (await A.value('#checklistCards [data-list=""] form[data-todo-add] input')) === "");
      await A.type("next");
      check("[8] focus stays in the box after adding", (await A.value('#checklistCards [data-list=""] form[data-todo-add] input')) === "next");
      await A.nav("plan");
      await A.click('[data-plan-open="21"]');
      await A.addTodo("#planModal", 21, "a");
      await A.tap("#planModal form[data-todo-add] input");
      await A.type("draft");
      await A.tap("#planModal [data-plan-todo]");
      check("[8] half-typed item survives ticking a box in the plan", (await A.value("#planModal form[data-todo-add] input")) === "draft" && (await A.text("#planModal .dd-progress")) === "1 of 1 done");
      await A.press("Escape");
      await A.nav("journal");
      await A.pickPhoto();
      await A.tap("#memoryTitle");
      await A.type("Half written");
      await A.tap("#memoryText");
      await A.type("still thinking");
      await A.nav("checklists");
      await A.click('#checklistCards [data-list=""] [data-plan-todo]');
      await A.nav("journal");
      check("[8] journal draft and picked photo survive leaving and a change elsewhere", (await A.value("#memoryTitle")) === "Half written" && (await A.value("#memoryText")) === "still thinking" && (await A.ev(`!document.querySelector("#memoryPreview").hidden`)));
      check("[8] memory text is capped at 4000 characters", (await A.ev(`document.querySelector("#memoryText").maxLength`)) === 4000);
    });

    await scenario("[8] size with a full journal", async () => {
      const memories = Array.from({ length: 200 }, (_, i) => ({ id: "m" + i, title: "Memory " + i, date: today, mood: "", text: "x".repeat(4000), tags: ["a"], hasPhoto: false }));
      await A.fresh(NEW, { ...seedV1, studyflowMemories: memories });
      await A.nav("journal");
      const bytes = await A.ev(`new TextEncoder().encode(JSON.stringify(Object.fromEntries(Object.keys(localStorage).filter((k) => k.startsWith("studyflow") && k !== "studyflowCloud").map((k) => [k, localStorage.getItem(k)])))).length`);
      console.log(`INFO synced data with 200 memories of 4000 ASCII characters: ${bytes} bytes (limit 1048576)`);
      check("[8] 200 full memories render and the synced data stays under 1 MiB", (await A.count("#memoryGrid .dd-memory")) === 200 && bytes < 1048576, String(bytes));
    });

    await scenario("[8] phone width", async () => {
      await A.fresh(NEW, seedV1);
      await A.nav("journal");
      await A.saveMemory({ "#memoryTitle": "Phone" }, true);
      await A.send("Emulation.setDeviceMetricsOverride", { width: 393, height: 852, deviceScaleFactor: 1, mobile: true });
      await sleep(300);
      check("[8] eight nav items at 393px", (await A.ev(`[...document.querySelectorAll(".nav[data-page]")].filter((b) => b.offsetParent !== null).length`)) === 8);
      for (const p of ["dashboard", "plan", "calendar", "journal", "checklists", "settings"]) {
        await A.nav(p);
        const w = await A.ev(`document.documentElement.scrollWidth`);
        const wide = w <= 393 ? "" : await A.ev(`[...document.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().right > 394).slice(0, 5).map((e) => e.tagName + "#" + e.id + "." + e.className + ":" + Math.round(e.getBoundingClientRect().right)).join(" ")`);
        check(`[8] no horizontal scroll at 393px on ${p}`, w <= 393, `scrollWidth ${w} ${wide}`);
      }
      await A.nav("checklists");
      // Every point of a 32x32 square around the control must land on it or on its label.
      const hitArea = (sel, centered) => A.ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.scrollIntoView({ block: "center" }); const b = el.getBoundingClientRect(), own = el.closest("label") || el, cy = b.top + b.height / 2, x0 = ${centered} ? b.left + b.width / 2 - 15.5 : b.left; let miss = 0; for (let x = x0; x <= x0 + 31; x += 3.1) for (let y = cy - 15.5; y <= cy + 15.5; y += 3.1) { const h = document.elementFromPoint(x, y); if (!h || !own.contains(h)) miss++; } return { w: Math.round(b.width), h: Math.round(b.height), miss }; })()`);
      const box = await hitArea('#checklistCards [data-list=""] [data-plan-todo]', false);
      check("[8] a checklist checkbox has a 32x32 hit area at 393px and still looks small", box.miss === 0 && box.w < 24, JSON.stringify(box));
      const del = await hitArea('#checklistCards [data-list=""] [data-plan-todo-del]', true);
      check("[8] a checklist delete button has a 32x32 hit area at 393px", del.miss === 0, JSON.stringify(del));
      await A.nav("plan");
      await A.click('[data-plan-open="21"]');
      check("[8] the plan detail fits the phone", await A.ev(`(() => { const b = document.querySelector("#planModal").getBoundingClientRect(); return b.left >= 0 && b.right <= 393 && b.height <= 852; })()`));
      await A.press("Escape");
      await A.send("Emulation.clearDeviceMetricsOverride");
    });

    check("no console errors or exceptions", errors.length === 0, errors.slice(0, 5).join(" | "));

    if (SHOTS) {
      fs.mkdirSync(SHOTS, { recursive: true });
      await A.fresh(NEW, seedV1);
      await A.nav("plan");
      await A.newPlan({ title: "Coastal getaway", type: "trip", date: await inDays(24), place: "Santa Cruz", note: "Beach walks, sunset, and a cozy weekend." });
      await A.newPlan({ title: "Holiday lights outing", type: "outing", date: today, start: "18:30", place: "Downtown", note: "Hot cocoa and a walk to see the lights." });
      await A.newPlan({ title: "Someday road trip", type: "other" });
      const trip = await planByTitle("Coastal getaway");
      await A.click(`[data-plan-open="${trip.id}"]`);
      await A.addTodo("#planModal", trip.id, "Book the cabin");
      await A.addTodo("#planModal", trip.id, "Pack sunscreen");
      await A.click("#planModal [data-plan-todo]");
      await A.press("Escape");
      await A.nav("journal");
      await A.saveMemory({ "#memoryTitle": "Sunset at the pier", "#memoryText": "Golden light, cold toes, best fries.", "#memoryTags": "beach, friends", "#memoryMood": "Happy ☀️" }, true);
      await A.saveMemory({ "#memoryTitle": "Rainy day baking", "#memoryText": "Cinnamon rolls with grandma.", "#memoryTags": "cozy" });
      const shoot = async (tag) => {
        for (const [w, h] of [[1280, 900], [393, 852]]) for (const p of ["dashboard", "plan", "journal", "checklists", "calendar"]) {
          await A.nav(p);
          await A.ev(`window.scrollTo(0, 0)`);
          await A.shot(path.join(SHOTS, `daydream-${tag}${p}-${w}.png`), w, h);
        }
      };
      await shoot("");
      await A.send("Emulation.setDeviceMetricsOverride", { width: 393, height: 659, deviceScaleFactor: 1, mobile: true });
      await A.nav("plan");
      await A.click("#addPlan");
      await A.ev(`document.querySelector("#modalBg .modal").scrollTop = 1e4`);
      await sleep(350);
      fs.writeFileSync(path.join(SHOTS, "daydream-plan-form-393x659.png"), Buffer.from((await A.send("Page.captureScreenshot", { format: "png" })).result.data, "base64"));
      await A.click("#cancel");
      await A.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
      await A.nav("plan");
      await A.click(`[data-plan-open="${trip.id}"]`);
      await A.shot(path.join(SHOTS, "daydream-plan-detail-1280.png"), 1280, 900);
      await A.press("Escape");
      await A.ev(`localStorage.setItem("studyflowColors", JSON.stringify({ accent: "#8ea8ff", background: "#0f1535", background2: "#1a2150", cards: "#1b2347", text: "#e8ecff" }))`);
      await A.reload();
      for (const p of ["dashboard", "calendar"]) { await A.nav(p); await A.shot(path.join(SHOTS, `daydream-night-design-${p}-1280.png`), 1280, 900); }
      await A.setMode("school");
      await A.nav("dashboard");
      await A.shot(path.join(SHOTS, "school-night-design-after-daydream-1280.png"), 1280, 900);
      console.log(`INFO screenshots saved to ${SHOTS}`);
    }
  } finally {
    const exited = new Promise((r) => chrome.once("exit", r));
    chrome.kill();
    await exited;
    server.close();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  }
  console.log(failures ? `${failures} of ${total} FAILED` : `ALL ${total} PASSED`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
