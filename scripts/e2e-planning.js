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
  out.nav = await A.ev(`[...document.querySelectorAll(".nav[data-page]")].filter((b) => !b.hidden).map((b) => b.textContent.trim())`);
  out.titles = [];
  for (const p of pages) {
    await A.nav(p);
    out.titles.push([await A.text("#eyebrow"), await A.text("#pageTitle"), await A.text("#pageSubtitle")]);
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
        for (const k of Object.keys(before)) if (k !== "first" || mode === "school") check(`[7] ${mode}: ${k} matches the old build`, same(before[k], after[k]), `old ${JSON.stringify(before[k])} new ${JSON.stringify(after[k])}`);
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
      check("[name] nav is Dashboard, Calendar, My Plans, Journal, Checklists, AI, Settings", same([...nav].sort(), ["AI", "Calendar", "Checklists", "Dashboard", "Journal", "My Plans", "Settings"]), JSON.stringify(nav));
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
      check("[8] seven nav items at 393px", (await A.ev(`[...document.querySelectorAll(".nav[data-page]")].filter((b) => b.offsetParent !== null).length`)) === 7);
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
