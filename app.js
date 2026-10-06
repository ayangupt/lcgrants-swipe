/* Matchbox — swipe through a nonprofit's grant tasks.
   Data: the task deck that tools/phone.py publishes inside the pinned "Grant inbox" issue
   (private repo, read with the owner's own token). Actions: /commands posted as issue comments, which
   the sync applies within ~10 minutes. Nothing here stores grant data anywhere but this phone. */
"use strict";

const API = "https://api.github.com";
const LS = {
  get: (k, d) => { try { const v = localStorage.getItem("mb." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => localStorage.setItem("mb." + k, JSON.stringify(v)),
  del: (k) => localStorage.removeItem("mb." + k),
};
const INKS = ["vermilion", "ultramarine", "turmeric", "leaf", "magenta", "peacock", "ochre"];
const state = {
  deck: LS.get("deck", null), inbox: LS.get("inbox", null), view: "deck", focus: null, flipped: false,
  loading: false, error: null, lastFetch: 0, demo: /[?&]demo\b/.test(location.search),
};
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const today = () => new Date().toLocaleDateString("en-CA");
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------- GitHub ---------- */
async function gh(path, opts = {}) {
  const token = LS.get("token", "");
  const r = await fetch(API + path, {
    ...opts,
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.body ? { "Content-Type": "application/json" } : {}) },
  });
  if (r.status === 401) throw new Error("Your GitHub token was refused. Paste a new one in Settings.");
  if (r.status === 404) throw new Error("Can't see the repo. Check the token has access to " + repo() + ".");
  if (!r.ok) throw new Error(`GitHub said ${r.status}. Try again in a minute.`);
  return r.status === 204 ? null : r.json();
}
const repo = () => LS.get("repo", "");
{ const r = new URLSearchParams(location.search).get("repo"); if (r && /^[\w.-]+\/[\w.-]+$/.test(r)) LS.set("repo", r); }

async function unzip64(b64) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  if (!("DecompressionStream" in window)) throw new Error("This browser can't open the deck. Update iOS or Chrome, then try again.");
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text());
}
function b64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
async function zip64(obj) {   // gzip+base64, like the sync's own payloads; plain base64 JSON where gzip isn't available
  const raw = new TextEncoder().encode(JSON.stringify(obj));
  if (!("CompressionStream" in window)) return b64(raw);
  const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream("gzip"));
  return b64(new Uint8Array(await new Response(stream).arrayBuffer()));
}
async function decodeDeck(body) {
  const z = /<!-- lcg:deckz ([A-Za-z0-9+/=]+) -->/.exec(body || "");
  const m = z || /<!-- lcg:deck ([A-Za-z0-9+/=]+) -->/.exec(body || "");
  if (!m) return null;
  if (!z) return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0))));
  return unzip64(m[1]);
}

async function fetchDeck() {
  state.loading = true; state.error = null; render();
  try {
    if (state.demo) {
      const r = await fetch(new URLSearchParams(location.search).get("deck") || "demo-deck.json", { cache: "no-store" });
      state.deck = await r.json(); state.lastFetch = Date.now();
      return;
    }
    const issues = await gh(`/repos/${repo()}/issues?labels=grant-inbox&state=open&per_page=1`);
    if (!issues.length) throw new Error("No Grant inbox issue yet. The PC sync creates it on its next run.");
    const deck = await decodeDeck(issues[0].body);
    if (!deck) throw new Error("The inbox has no task deck yet. It appears after the next sync (every 10 min).");
    state.deck = deck; state.inbox = issues[0].number; state.lastFetch = Date.now();
    LS.set("deck", deck); LS.set("inbox", state.inbox);
    pruneSent();
  } catch (e) {
    state.error = navigator.onLine ? e.message : "You're offline. Showing the last deck you loaded.";
  } finally {
    state.loading = false; render();
  }
  flushQueue();
  if (state.pendingRead && state.deck) { const id = state.pendingRead; state.pendingRead = null; openDraft(id); }
}

/* ---------- sent / queue / stats (all on this phone) ---------- */
function pruneSent() {
  const sent = LS.get("sent", {}), ids = new Set((state.deck?.tasks || []).map((t) => t.id)), keep = {};
  const dayAgo = Date.now() - 36 * 3600e3;
  for (const [id, ts] of Object.entries(sent)) if (ids.has(id) && ts > dayAgo) keep[id] = ts;
  LS.set("sent", keep);
  const asked = LS.get("explainAsked", {}), stillAsked = {};
  for (const [id, ts] of Object.entries(asked)) {
    const t = (state.deck?.tasks || []).find((x) => x.id === id);
    if (t && !(t.ai && t.ai.explain) && ts > Date.now() - 48 * 3600e3) stillAsked[id] = ts;
  }
  LS.set("explainAsked", stillAsked);
}
const isSent = (t) => !!LS.get("sent", {})[t.id];

async function post(issue, body, id) {
  if (state.demo) return true;                       // demo: nothing leaves the phone
  try {
    if (!navigator.onLine) throw new Error("offline");
    await gh(`/repos/${repo()}/issues/${issue}/comments`, { method: "POST", body: JSON.stringify({ body }) });
    return true;
  } catch {
    const q = LS.get("queue", []); q.push({ issue, body, id, at: Date.now() }); LS.set("queue", q);
    return false;
  }
}
async function send(task, command) {
  const sent = LS.get("sent", {}); sent[task.id] = Date.now(); LS.set("sent", sent);
  bumpStats(task);
  return post(task.issue, command, task.id);
}
async function flushQueue() {
  const q = LS.get("queue", []);
  if (!q.length || !navigator.onLine || !LS.get("token", "")) return;
  const left = [];
  for (const item of q) {
    try { await gh(`/repos/${repo()}/issues/${item.issue}/comments`, { method: "POST", body: JSON.stringify({ body: item.body }) }); }
    catch { left.push(item); }
  }
  LS.set("queue", left);
  if (q.length !== left.length) toast(`Sent ${q.length - left.length} saved repl${q.length - left.length === 1 ? "y" : "ies"}.`);
  render();
}
function bumpStats(task) {
  const s = LS.get("stats", { days: {}, total: 0, xp: 0 });
  s.days[today()] = (s.days[today()] || 0) + 1; s.total += 1; s.xp += task.xp || 10;
  LS.set("stats", s);
}
function streak() {
  const days = LS.get("stats", { days: {} }).days;
  let n = 0; const d = new Date();
  if (!days[today()]) d.setDate(d.getDate() - 1);           // today not started yet: the flame is still yesterday's
  while (days[d.toLocaleDateString("en-CA")]) { n++; d.setDate(d.getDate() - 1); }
  return { n, lit: !!days[today()] };
}

/* ---------- deck order ---------- */
function visibleTasks() {
  const tasks = (state.deck?.tasks || []).filter((t) => !isSent(t) && (!state.focus || t.grant === state.focus));
  const later = LS.get("later", []);
  const rank = (t) => { const i = later.indexOf(t.id); return i === -1 ? -1 : i; };
  return tasks.map((t, i) => ({ t, i, r: rank(t) })).sort((a, b) => (a.r - b.r) || (a.i - b.i)).map((x) => x.t);
}
const grantOf = (t) => (state.deck?.grants || []).find((g) => g.id === t.grant) || {};
const inkOf = (g) => INKS[((g.rank || 1) - 1) % INKS.length];

/* ---------- task vocabulary ---------- */
const KIND = {
  question: { tag: "Open question", right: "Answer", sheet: "text" },
  decide: { tag: "Decision", right: "Pursue", down: "Pass", sheet: "note" },
  approve: { tag: "Gate 1", right: "Approve", sheet: "confirm" },
  final: { tag: "Gate 2", right: "Approve", sheet: "confirm" },
  submitted: { tag: "Submit", right: "Submitted", sheet: "confirm" },
  review: { tag: "Copilot replied", right: "Accept", sheet: "confirm" },
  blocked: { tag: "Blocked", right: "Unblock", sheet: "text" },
  followup: { tag: "Follow-up due", right: "Followed up", up: "They replied", sheet: "note" },
};
function kindOf(task) {
  const k = KIND[task.kind] || KIND.question;
  return task.kind === "question" && task.ai && task.ai.found ? { ...k, tag: "Found in our files", right: "Use this", sheet: "confirm" } : k;
}
function command(task, dir, text) {
  const t = (text || "").replace(/\s*\n+\s*/g, " ").trim();   // the sync reads one command per line
  switch (task.kind) {
    case "question": {
      const f = task.ai && task.ai.found, id = task.id.split(":q:")[1] ? "q:" + task.id.split(":q:")[1] : task.n;
      return `/answer ${id} ${t || (f ? `${f.answer} (from our records: ${f.file})` : "")}`;
    }
    case "decide": return dir === "down" ? `/pass ${t}` : `/pursue ${t}`;
    case "approve": return task.angle ? `/approve angle ${task.angle}` : "/approve";
    case "final": return "/final";
    case "submitted": return `/submitted ${t}`;
    case "review": return "/accept";
    case "blocked": return `/resolved ${t}`;
    case "followup": return dir === "up" ? `/resolved ${t}` : `/followup 7d ${t}`;
  }
  return `/note ${t}`;
}

/* ---------- render ---------- */
function render() {
  const app = $("#app");
  if (!LS.get("token", "") && !state.demo) { app.innerHTML = setupView(); bindSetup(); return; }
  if (!state.deck && state.loading) { app.innerHTML = `<div></div><div class="boot">Opening the box…</div><div></div>`; return; }
  if (!state.deck) { app.className = ""; app.innerHTML = `<div></div>${emptyView("Can't open the box yet", state.error || "No deck loaded.", true)}<div></div>`; bindCommon(); return; }
  if (state.view === "draft" && state.read) {
    app.className = "reading"; app.innerHTML = draftView() + footView(); bindCommon(); bindDraft(); return;
  }
  app.className = state.view === "deck" ? "fit" : "";
  app.innerHTML = stripView() + (state.view === "shelf" ? shelfView() : deckView()) + footView();
  bindCommon();
  if (state.view === "deck") bindSwipe();
}

function stripView() {
  const s = streak(), done = LS.get("stats", { days: {} }).days[today()] || 0, goal = LS.get("goal", 3);
  const flame = `<svg viewBox="0 0 18 24" aria-hidden="true"><path d="M9 1c1 4 6 6 6 12a6 6 0 0 1-12 0c0-3 2-5 3-6 0 2 1 3 2 3 0-4-1-6 1-9z" fill="${s.lit ? "#ffb02e" : "#6b6690"}"/><path d="M9 12c1 2 3 3 3 6a3 3 0 0 1-6 0c0-2 1-3 2-4 0 1 1 1 1 1z" fill="${s.lit ? "#ff6a1a" : "#4d4870"}"/></svg>`;
  const sticks = Array.from({ length: Math.max(goal, done) }, (_, i) => `<i class="${i < done ? "struck" : ""}"></i>`).join("");
  return `<header class="strip">
    <span class="flame ${s.lit ? "" : "out"}" title="Days in a row with at least one match struck">${flame}${s.n ? `${s.n} day${s.n === 1 ? "" : "s"}` : "Start a streak"}</span>
    <span class="today" aria-label="${done} of ${goal} matches struck today">${sticks}<span class="today-label">${done}/${goal} today</span></span>
    <button class="iconbtn" data-act="note" aria-label="Note for Copilot">${icon("note")}</button>
    <button class="iconbtn" data-act="shelf" aria-label="${state.view === "shelf" ? "Back to the deck" : "All boxes"}">${state.view === "shelf" ? icon("deck") : icon("shelf")}</button>
  </header>`;
}

function stampHTML(g) {
  const d = g.days, hot = d != null && d <= 3;
  const inner = g.deadline === "rolling" ? `<b>ROLL</b><small>rolling</small>`
    : d == null ? `<b>—</b><small>no date</small>`
    : `<b>${d < 0 ? "LATE" : d === 0 ? "TODAY" : d + "d"}</b><small>${esc(fmtDate(g.deadline))}</small>`;
  return `<div class="stamp ${hot ? "hot" : ""}" aria-label="Due ${esc(g.deadline || "no date")}">${inner}</div>`;
}
const readable = (g) => !!(g && (g.read || (state.demo && state.deck?.drafts?.[g.id])));

function labelHTML(task, cls, pos) {
  const g = grantOf(task), k = kindOf(task), ink = inkOf(g);
  if (pos === 0 && state.flipped) return backHTML(task, g, ink, cls);
  const mine = (state.deck?.tasks || []).filter((t) => t.grant === task.grant), sent = LS.get("sent", {});
  const ask = (task.ai && task.ai.ask) || task.prompt, found = task.ai && task.ai.found;
  const struck = mine.filter((t) => sent[t.id]).length, len = (ask || "").length;
  const snip = found ? null : snippet(task);
  return `<article class="label c-${ink} ${cls}" data-id="${esc(task.id)}" ${pos === 0 ? 'tabindex="0" aria-roledescription="swipe card"' : 'aria-hidden="true"'}>
    <div class="l-head"><h2 class="funder${longWord(g.funder || g.title) ? " long" : ""}">${esc(g.funder || g.title || "Grant")}</h2>${stampHTML(g)}</div>
    <div class="l-meta"><span>${esc(k.tag)}</span></div>
    <div class="cartouche">
      ${task.label ? `<div class="qlabel">${esc(task.label)}</div>` : ""}
      <p class="q${len > 220 ? " xl" : len > 130 ? " l" : ""}">${esc(ask)}</p>
      ${found ? foundHTML(found) : ""}
      ${snip ? `<blockquote class="where"><span class="wl">${esc(snip.label)}</span>${snip.html}</blockquote>` : ""}
      ${task.ctx && task.ctx.deferred && !found ? `<div class="qdetail warn">You said to pull this from past grants, but it isn't in our files yet.</div>` : ""}
      ${task.detail && task.detail !== task.prompt ? `<div class="qdetail">${esc(task.detail)}${task.ai && task.ai.ask ? " · reworded by Copilot" : ""}</div>` : ""}
      ${(task.options || []).length > 1 ? `<div class="qdetail">Prefer angle ${esc(task.options.map((o) => o.split(":")[0]).filter((id) => id !== task.angle).join(" or "))}? Reply on the grant's card on GitHub.</div>` : ""}
      ${task.ctx ? `<button class="more" data-act="context">What is this for? ›</button>` : ""}
    </div>
    <div class="l-body">
      ${g.funds && g.funds !== task.detail && !task.ctx ? `<p class="funds"><b>What it funds</b> ${esc(g.funds)}</p>` : ""}
      ${mine.length > 1 ? `<div class="boxprog" aria-label="${struck} of ${mine.length} matches struck for this grant">${mine.map((t) => `<i class="${sent[t.id] ? "done" : ""}"></i>`).join("")}<span>${struck} of ${mine.length} struck</span></div>` : ""}
      ${LOTUS}
    </div>
    <div class="l-foot"><button class="flip" data-act="flip">About this grant</button>${readable(g) ? `<button class="flip" data-act="read" data-grant="${esc(g.id)}">Read the draft</button>` : ""}<span>+${task.xp || 10}</span></div>
    <div class="striker" aria-hidden="true"><span>← Later</span><span>${esc(k.right)} →</span></div>
    ${pos === 0 ? `<div class="hint r">${esc(k.right)}</div><div class="hint l">Later</div>${k.up ? `<div class="hint u">${esc(k.up)}</div>` : ""}${k.down ? `<div class="hint d">${esc(k.down)}</div>` : ""}` : ""}
  </article>`;
}
const LOTUS = `<svg class="emblem" viewBox="0 0 120 76" aria-hidden="true"><path d="M60 6c11 13 15 28 0 54C45 34 49 19 60 6z"/><path d="M58 60C50 41 37 29 18 25c2 18 15 32 40 35z"/><path d="M62 60c8-19 21-31 40-35-2 18-15 32-40 35z"/><path d="M57 63C38 60 20 52 4 41c8 16 27 26 53 22z"/><path d="M63 63c19-3 37-11 53-22-8 16-27 26-53 22z"/><rect x="22" y="68" width="76" height="4" rx="2"/></svg>`;

/* ---------- question context (built by tools/questions.py) ---------- */
function rich(s, hi) {
  let h = esc(s).replace(/▢/g, '<mark class="blank">your answer</mark>');
  for (const n of hi || []) h = h.split(esc(n)).join(`<mark class="num">${esc(n)}</mark>`);
  return h;
}
function snippet(task) {
  const c = task.ctx;
  if (!c) return null;
  if (c.where) return { label: "Goes into", html: rich(c.where) };
  if ((c.used || []).length) return { label: "Used in the application", html: rich(c.used[0], c.hi) };
  if ((c.list || []).length) return { label: "About this list", html: esc(c.list.slice(0, 2).join(" · ")) };
  if ((c.above || []).length) return { label: "Just above it in the draft", html: esc(c.above.slice(-2).join(" · ")) };
  if (c.note) return { label: "Note in the draft", html: rich(c.note, c.hi) };
  return null;
}
const STATUS = { conflict: "Conflict", confirm: "Unconfirmed", ok: "On file" };
const longWord = (s) => Math.max(0, ...String(s || "").split(/\s+/).map((w) => w.length)) > 11;
function foundHTML(f) {
  return `<div class="found"><span class="wl">Found in our files</span><b>${esc(f.answer)}</b>
    <small>“${esc(f.quote)}” · ${esc(f.file)}${f.date ? ", " + esc(f.date) : ""}</small></div>`;
}
function backHTML(task, g, ink, cls) {
  const sent = LS.get("sent", {}), left = (state.deck?.tasks || []).filter((t) => t.grant === task.grant && !sent[t.id]).length;
  return `<article class="label back c-${ink} ${cls}" data-id="${esc(task.id)}" tabindex="0">
    <div class="l-head"><h2 class="funder${longWord(g.funder) ? " long" : ""}">${esc(g.funder || "Grant")}</h2></div>
    <div class="l-meta"><span>${esc(g.stage || "")}</span></div>
    <div class="cartouche">
      ${g.title && g.title !== g.funder ? `<h3>Grant</h3><p>${esc(g.title)}</p>` : ""}
      ${g.funds ? `<h3>What it funds</h3><p>${esc(g.funds)}</p>` : ""}
      ${g.award ? `<h3>Award</h3><p>${esc(g.award)}</p>` : ""}
      ${(g.why || []).length ? `<h3>Why it needs you</h3><p>${esc(g.why.join("; "))}</p>` : ""}
      ${(g.notes || []).length ? `<h3>Your notes for Copilot</h3>${g.notes.map((n) => `<p class="note-line">${esc(n.text)} <small>${esc(n.date)}${n.all ? " · all grants" : ""}</small></p>`).join("")}` : ""}
      ${(g.filled || []).length ? `<h3>Filled from our records</h3>${g.filled.map((f) => `<p class="note-line">${esc(f.q)}: <b>${esc(f.text.split(" (")[0])}</b></p>`).join("")}` : ""}
      ${readable(g) ? `<button class="more" data-act="read" data-grant="${esc(g.id)}">Read and edit the application ›</button>` : ""}
      <button class="more" data-act="note" data-grant="${esc(g.id)}">Add a note for Copilot ›</button>
      ${g.local === false ? `<p>This draft lives in another Copilot session. Your answers are saved next to it.</p>` : ""}
      <p>${g.url ? `<a href="${esc(g.url)}" target="_blank" rel="noopener noreferrer">Funder page ↗</a> · ` : ""}${g.issue ? `<a href="https://github.com/${esc(repo())}/issues/${g.issue}" target="_blank" rel="noopener">Card on GitHub ↗</a>` : ""}</p>
    </div>
    <div class="l-body">${LOTUS}</div>
    <div class="l-foot"><button class="flip" data-act="flip">Back to the match</button><span>${left} left</span></div>
    <div class="striker" aria-hidden="true"></div>
  </article>`;
}

function deckView() {
  const tasks = visibleTasks();
  if (!tasks.length) {
    const sentN = Object.keys(LS.get("sent", {})).length, fg = state.focus && (state.deck?.grants || []).find((g) => g.id === state.focus);
    return `<section class="stage">${emptyView(state.focus ? "This box is empty" : "Box is empty",
      sentN ? `${sentN} repl${sentN === 1 ? "y is" : "ies are"} on the way to the drafts. New matches arrive after the next sync.` :
        "Nothing needs you right now. New matches arrive after the next sync.", false,
      readable(fg) ? `<button class="btn strike" data-act="read" data-grant="${esc(fg.id)}">Read the application</button>` : "")}</section>`;
  }
  const top = tasks.slice(0, 3);
  const k = kindOf(tasks[0]);
  return `<section class="stage"><div class="stack">
      ${top.map((t, i) => labelHTML(t, i === 0 ? "" : i === 1 ? "behind" : "behind2", i)).reverse().join("")}
    </div></section>
    <nav class="controls" aria-label="Actions">
      <button class="btn later" data-act="later">${icon("later")} Later</button>
      <button class="btn mic" data-act="voice" aria-label="${esc(k.right)} by voice">${icon("mic")}</button>
      <button class="btn strike" data-act="right">${esc(k.right)} ${icon("strike")}</button>
    </nav>
    ${k.up || k.down ? `<div class="sub">${k.up ? `<button data-act="up">${esc(k.up)}</button>` : ""}${k.down ? `<button data-act="down">${esc(k.down)}</button>` : ""}</div>` : ""}`;
}

function shelfView() {
  const sent = LS.get("sent", {});
  const boxes = (state.deck.grants || []).map((g) => {
    const mine = state.deck.tasks.filter((t) => t.grant === g.id);
    const left = mine.filter((t) => !sent[t.id]).length;
    const sticks = mine.map((t) => `<i class="${sent[t.id] ? "done" : ""}"></i>`).join("");
    const d = g.days;
    return `<div class="box c-${inkOf(g)}">
      <button class="box-main" data-act="focus" data-grant="${esc(g.id)}">
        <span class="bn">${esc(g.funder)}</span>
        <span class="bd">${g.deadline === "rolling" ? "Rolling" : d == null ? "No date" : d < 0 ? "Late" : d === 0 ? "Due today" : `Due in ${d}d`} · ${left} left</span>
        <span class="sticks" aria-hidden="true">${sticks}</span></button>
      ${readable(g) ? `<button class="box-read" data-act="read" data-grant="${esc(g.id)}" aria-label="Read the ${esc(g.funder)} application">Read the draft ›</button>` : ""}
    </div>`;
  }).join("");
  return `<section class="shelf"><h2 class="shelf-title">Boxes <span>${(state.deck.grants || []).length}</span></h2>${boxes}</section>`;
}

function footView() {
  const q = LS.get("queue", []).length, sent = Object.keys(LS.get("sent", {})).length;
  const gen = state.deck?.generated ? new Date(state.deck.generated) : null;
  const age = gen ? Math.round((Date.now() - gen) / 60000) : null;
  return `<footer class="sub">
    ${state.focus ? `<button data-act="unfocus">All boxes</button>` : ""}
    <span class="${q || sent ? "pending" : ""}">${q ? `${q} waiting for signal` : sent ? `${sent} sent · lands in ~10 min` : age != null ? `Deck ${age < 2 ? "just now" : age < 90 ? age + " min old" : Math.round(age / 60) + " h old"}` : ""}</span>
    <button data-act="refresh">${state.loading ? "Loading…" : "Refresh"}</button>
    <button data-act="settings">Settings</button>
  </footer>${state.error ? `<p class="sub err" role="alert">${esc(state.error)}</p>` : ""}`;
}

function emptyView(title, text, retry, extra = "") {
  return `<div class="empty"><svg width="88" height="64" viewBox="0 0 88 64" aria-hidden="true"><rect x="4" y="14" width="80" height="46" rx="6" fill="#c62a1f"/><rect x="10" y="20" width="68" height="34" rx="3" fill="none" stroke="#fffaf0" stroke-width="2"/><rect x="4" y="6" width="80" height="12" rx="4" fill="#f4b41a"/></svg>
    <h2>${esc(title)}</h2><p>${esc(text)}</p>${retry ? `<button class="btn strike" data-act="refresh">Try again</button><button class="btn later" data-act="settings">Settings</button>` : ""}${extra}</div>`;
}

function setupView() {
  const owner = (repo().split("/")[0] || "");
  const tokenUrl = "https://github.com/settings/personal-access-tokens/new?name=Matchbox%20(grant%20phone%20app)&description=Read%20the%20grant%20deck%20and%20post%20replies&expires_in=365&issues=write" + (owner ? "&target_name=" + encodeURIComponent(owner) : "");
  return `<div></div><section class="setup">
    <h1>Matchbox</h1>
    <p>Swipe through what your grants need from you. It reads the private grant repo with a token that stays on this phone.</p>
    <ol>
      <li><a href="${tokenUrl}" target="_blank" rel="noopener">Create a GitHub token ↗</a>: choose <b>Only select repositories</b> and pick the grant repo, and give <b>Issues: Read and write</b>.</li>
      <li>Paste it below. Add this page to your home screen for an app icon.</li>
    </ol>
    <label>Token<input id="tok" type="password" autocomplete="off" inputmode="text" placeholder="github_pat_…"></label>
    <label>Repository<input id="rep" value="${esc(repo())}" placeholder="owner/repo" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
    <button class="btn strike" data-act="save">Open the box</button>
    <p class="err" id="setup-err" role="alert">${esc(state.error || "")}</p>
  </section><div></div>`;
}
function bindSetup() {
  $("[data-act=save]").onclick = async () => {
    const tok = $("#tok").value.trim(), rep = $("#rep").value.trim();
    if (!tok) { $("#setup-err").textContent = "Paste your token first."; return; }
    if (!/^[\w.-]+\/[\w.-]+$/.test(rep)) { $("#setup-err").textContent = "Repository looks like owner/repo."; return; }
    LS.set("token", tok); LS.set("repo", rep);
    await fetchDeck();
    if (state.error && !state.deck) { LS.del("token"); render(); }
  };
}

/* ---------- interactions ---------- */
function bindCommon() {
  document.querySelectorAll("[data-act]").forEach((b) => (b.onclick = (e) => onAct(e, b)));
}
function onAct(e, b) {
  const act = b.dataset.act, top = visibleTasks()[0];
  if (act === "read") { e.stopPropagation(); openDraft(b.dataset.grant || state.focus || (top && top.grant)); return; }
  if (state.view === "draft" && state.read) {
    if (act === "back") closeDraft();
    else if (act === "edit") openEditor(+b.dataset.i);
    else if (act === "fill") openEditor(+b.dataset.i, +b.dataset.n);
    else if (act === "gap") nextGap();
    else if (act === "dismiss") { const eds = LS.get("edits", {}); delete eds[b.dataset.e]; LS.set("edits", eds); render(); }
    else if (act === "refresh") { loadDraft(state.read); fetchDeck(); }
    else if (act === "settings") openSettings();
    else if (act === "unfocus") { state.focus = null; closeDraft(); }
    return;
  }
  if (act === "shelf") { state.view = state.view === "shelf" ? "deck" : "shelf"; state.flipped = false; render(); }
  else if (act === "focus") { state.focus = b.dataset.grant; state.view = "deck"; state.flipped = false; render(); }
  else if (act === "unfocus") { state.focus = null; render(); }
  else if (act === "refresh") fetchDeck();
  else if (act === "settings") openSettings();
  else if (act === "flip") { e.stopPropagation(); state.flipped = !state.flipped; render(); }
  else if (act === "note") { e.stopPropagation(); openNote(b.dataset.grant || state.focus || (top && top.grant) || null); }
  else if (top && act === "context") { e.stopPropagation(); openContext(top); }
  else if (top && act === "later") flyOut(top, "left");
  else if (top && act === "right") act3(top, "right");
  else if (top && act === "voice") act3(top, "right", true);
  else if (top && act === "up") act3(top, "up");
  else if (top && act === "down") act3(top, "down");
}

function act3(task, dir, voice = false) {
  const k = kindOf(task);
  const label = dir === "up" ? k.up : dir === "down" ? k.down : k.right;
  const mode = dir === "down" ? "note" : dir === "up" ? "note" : k.sheet;
  if (mode === "confirm" && !voice) { strike(task, dir, ""); return; }
  openSheet(task, dir, label, mode === "text", voice);
}

function bindSwipe() {
  const el = $(".stack .label:last-child");
  if (!el) return;
  const task = visibleTasks()[0], k = kindOf(task);
  let x0 = 0, y0 = 0, dx = 0, dy = 0, dragging = false;
  const hint = (cls, on) => { const h = el.querySelector(".hint." + cls); if (h) h.style.opacity = on; };
  el.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button, a")) return;
    dragging = true; x0 = e.clientX; y0 = e.clientY; el.setPointerCapture(e.pointerId); el.style.transition = "none";
  });
  el.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    dx = e.clientX - x0; dy = e.clientY - y0;
    const rot = reduced() ? 0 : dx / 18;
    el.style.transform = `translate(${dx}px, ${dy * (k.up || k.down ? 1 : 0.25)}px) rotate(${rot}deg)`;
    hint("r", Math.max(0, Math.min(1, dx / 90))); hint("l", Math.max(0, Math.min(1, -dx / 90)));
    if (k.up) hint("u", Math.max(0, Math.min(1, -dy / 110))); if (k.down) hint("d", Math.max(0, Math.min(1, dy / 110)));
  });
  const end = () => {
    if (!dragging) return; dragging = false;
    const ax = Math.abs(dx), ay = Math.abs(dy);
    ["r", "l", "u", "d"].forEach((c) => hint(c, 0));
    if (ax > 90 && ax >= ay) { dx > 0 ? (el.style.transform = "", act3(task, "right")) : flyOut(task, "left"); }
    else if (k.up && dy < -110 && ay > ax) { el.style.transform = ""; act3(task, "up"); }
    else if (k.down && dy > 110 && ay > ax) { el.style.transform = ""; act3(task, "down"); }
    else { el.style.transition = "transform .35s cubic-bezier(.16,1,.3,1)"; el.style.transform = ""; }
    dx = dy = 0;
  };
  el.addEventListener("pointerup", end); el.addEventListener("pointercancel", end);
  el.addEventListener("keydown", (e) => {
    if (e.target !== el) return;                 // Enter on a button inside the card is that button's, not a strike
    if (e.key === "ArrowRight" || e.key === "Enter") act3(task, "right");
    else if (e.key === "ArrowLeft") flyOut(task, "left");
    else if (e.key === "ArrowUp" && k.up) act3(task, "up");
    else if (e.key === "ArrowDown" && k.down) act3(task, "down");
  });
  el.focus({ preventScroll: true });
}

function flyOut(task, dir) {
  const el = $(".stack .label:last-child");
  const later = LS.get("later", []).filter((id) => id !== task.id); later.push(task.id); LS.set("later", later);
  state.flipped = false;
  if (!el || reduced()) { render(); return; }
  el.style.transition = "transform .38s cubic-bezier(.5,0,.75,0), opacity .38s";
  el.style.transform = dir === "left" ? "translate(-120%, 60px) rotate(-14deg)" : "translate(120%, 0) rotate(14deg)";
  el.style.opacity = "0";
  setTimeout(render, 330);
}

async function strike(task, dir, text) {
  const el = $(".stack .label:last-child");
  const ok = await send(task, command(task, dir, text));
  const later = LS.get("later", []).filter((id) => id !== task.id); LS.set("later", later);
  sparks(el);
  if (el && !reduced()) {
    el.style.transition = "transform .45s cubic-bezier(.16,1,.3,1), opacity .45s";
    el.style.transform = dir === "up" ? "translate(0,-120%) rotate(-4deg)" : dir === "down" ? "translate(0,120%) rotate(4deg)" : "translate(130%, -30px) rotate(18deg)";
    el.style.opacity = "0";
  }
  state.flipped = false;
  const done = LS.get("stats", { days: {} }).days[today()] || 0, goal = LS.get("goal", 3);
  toast(ok ? (done === goal ? `Struck ${done} today. That's the goal.` : "Struck. It lands in the draft within 10 min.") : "Saved. It sends when you have signal.");
  if (navigator.vibrate) navigator.vibrate(ok ? 18 : [10, 40, 10]);
  setTimeout(render, reduced() ? 0 : 380);
}

function sparks(el) {
  if (!el || reduced()) return;
  const r = el.getBoundingClientRect(), cx = r.right - 40, cy = r.top + r.height * 0.45;
  for (let i = 0; i < 18; i++) {
    const s = document.createElement("i"); s.className = "spark"; document.body.appendChild(s);
    const a = Math.random() * Math.PI * 2, d = 40 + Math.random() * 90;
    s.style.left = cx + "px"; s.style.top = cy + "px";
    s.animate([{ transform: "translate(0,0) scale(1)", opacity: 1 }, { transform: `translate(${Math.cos(a) * d}px, ${Math.sin(a) * d - 30}px) scale(.2)`, opacity: 0 }],
      { duration: 520 + Math.random() * 300, easing: "cubic-bezier(.16,1,.3,1)" }).onfinish = () => s.remove();
  }
}

/* ---------- the application: read it, edit it ----------
   Each grant's card issue carries its current draft (tools/phone.py draft_payload: blocks with key, title,
   level, text, fingerprint). Edits go back as `/edit <id>` comments with a fenced payload; the sync writes
   them only if that part still matches the fingerprint the phone started from. Otherwise the edit becomes
   a comment for Copilot to merge, and the draft's `ed` map tells this phone what happened. */
const NEEDS = /\[NEEDS INPUT[^\]]*\]/g;
const LIMIT_RX = /\s*\((\d[\d,]*)\s*(?:words?|char(?:acter)?s?)\)\s*$/i;
function words(text) {    // the same count as lcgrants.count_words, so the phone agrees with the lint
  const clean = text.split("\n").filter((l) => !/^\s*(Source:|<!--)/.test(l)).join("\n").replace(NEEDS, "");
  return (clean.match(/[A-Za-z0-9$][\p{L}\p{N}_'’$%,.\-]*/gu) || []).length;   // \p{L}\p{N}_ = Python's Unicode \w
}
function chars(text) {
  return [...text.replace(NEEDS, "").trim().split(/\r?\n/).map((l) => l.replace(/\s+$/, "")).join("\n")].length;
}
const normText = (s) => String(s || "").replace(/\r\n/g, "\n").replace(/^(\s*\n)+/, "").replace(/(\n\s*(---)?\s*)+$/, "").replace(/\s+$/, "");
const partTitle = (b) => (b.l ? b.t.replace(LIMIT_RX, "") : "") || "Top of the document";
const grantById = (id) => (state.deck?.grants || []).find((g) => g.id === id) || { id };

function mdInline(s) {
  const keep = [], hold = (html) => `\u0000${keep.push(html) - 1}\u0000`;
  const fmt = (h) => h.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/__([^_]+)__/g, "<b>$1</b>")
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, "$1<i>$2</i>").replace(/(^|[^_\w])_([^_\s][^_]*?)_(?!\w)/g, "$1<i>$2</i>");
  let h = esc(s);
  h = h.replace(/`([^`]+)`/g, (m, x) => hold(`<code>${x}</code>`));
  h = h.replace(/\[NEEDS INPUT([^\]]*)\]/g, (m, x) => hold(`<mark class="gap">NEEDS INPUT${fmt(x)}</mark>`));
  h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, t, u) => hold(`<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`));
  return fmt(h).replace(/\u0000(\d+)\u0000/g, (m, n) => keep[+n]);
}
function mdTable(rows) {
  const cells = (r) => r.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  const sep = rows[1] && /^\s*\|?\s*:?-{2,}/.test(rows[1]);
  const head = sep ? cells(rows[0]) : null, body = rows.slice(sep ? 2 : 0).map(cells);
  return `<div class="tbl" tabindex="0" role="region" aria-label="Table"><table>${head ? `<thead><tr>${head.map((c) => `<th>${mdInline(c)}</th>`).join("")}</tr></thead>` : ""}<tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${mdInline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
function md(text) {      // a small, safe Markdown reader: everything is escaped first; links are http(s) only
  const src = String(text || "").replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/);
  const LI = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/, STOP = /^\s*(```|~~~|\||>|#{1,6}\s|([-*+]|\d+[.)])\s)/;
  let out = "", i = 0;
  while (i < src.length) {
    const line = src[i];
    if (!line.trim()) { i++; continue; }
    if (/^\s*(```|~~~)/.test(line)) {
      const f = line.trim().slice(0, 3), buf = []; i++;
      while (i < src.length && !src[i].trim().startsWith(f)) buf.push(src[i++]);
      i++; out += `<pre>${esc(buf.join("\n"))}</pre>`; continue;
    }
    const h = /^\s*#{1,6}\s+(.*?)[\s#]*$/.exec(line);
    if (h) { out += `<h5>${mdInline(h[1])}</h5>`; i++; continue; }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out += "<hr>"; i++; continue; }
    if (/^\s*\|/.test(line)) { const rows = []; while (i < src.length && /^\s*\|/.test(src[i])) rows.push(src[i++]); out += mdTable(rows); continue; }
    if (/^\s*>/.test(line)) {
      const buf = []; while (i < src.length && /^\s*>/.test(src[i])) buf.push(src[i++].replace(/^\s*>\s?/, ""));
      out += `<blockquote>${md(buf.join("\n"))}</blockquote>`; continue;
    }
    if (LI.test(line)) {
      const ordered = /\d/.test(LI.exec(line)[2]), items = [];
      while (i < src.length && (LI.test(src[i]) || (items.length && src[i].trim() && /^\s{2,}/.test(src[i])))) {
        const m = LI.exec(src[i]);
        if (m) items.push({ nest: m[1].length >= 2, t: m[3] }); else items[items.length - 1].t += " " + src[i].trim();
        i++;
      }
      const box = (t) => t.replace(/^\[ \]\s+/, "☐ ").replace(/^\[[xX]\]\s+/, "☑ ");
      out += `<${ordered ? "ol" : "ul"}>${items.map((it) => `<li${it.nest ? ' class="nest"' : ""}>${mdInline(box(it.t))}</li>`).join("")}</${ordered ? "ol" : "ul"}>`;
      continue;
    }
    const buf = [line]; i++;
    while (i < src.length && src[i].trim() && !STOP.test(src[i])) buf.push(src[i++]);
    let para = "";      // wrapped prose joins up; short lines, **Label:** lines and two-space breaks stay separate
    buf.forEach((l, k) => {
      if (k) para += /(\s{2}|\\)$/.test(buf[k - 1]) || buf[k - 1].trim().length < 50 || /^\s*(\*\*|__)/.test(l) ? "\n" : " ";
      para += k ? l.trim() : l.trimEnd();
    });
    out += `<p>${mdInline(para.replace(/\\\n/g, "\n")).replace(/\n/g, "<br>")}</p>`;
  }
  return out;
}

/* pending phone edits, kept on this phone until the draft shows what happened to them */
const pendingFor = (gid, key) => Object.values(LS.get("edits", {})).filter((e) => e.gid === gid && e.key === key).sort((a, b) => b.at - a.at)[0] || null;
// a pending edit still applies to what's on screen only if the part is what it was built on: the text it
// started from, or what an earlier edit in its chain produced (the sync echoes each outcome's fingerprint)
function liveEdit(p, b, ed) {
  if (!p || p.status === "conflict") return null;
  if (!p.base || p.base === b.h) return p;
  return (p.chain || []).some((id) => { const o = (ed || {})[id]; return o && (o[0] === "ok" || o[0] === "same") && o[2] === b.h; }) ? p : null;
}
const cardOf = (r) => r.issue || grantById(r.gid).issue || null;
function reconcileEdits(gid, data) {
  const eds = LS.get("edits", {}), out = data.ed || {};
  let saved = 0, bounced = 0;
  for (const [id, e] of Object.entries(eds)) {
    if (e.gid !== gid) continue;
    const o = out[id];
    if (o && (o[0] === "ok" || o[0] === "same")) { delete eds[id]; saved++; }
    else if (o && e.status !== "conflict") { e.status = "conflict"; e.why = o[0]; bounced++; }
    else if (!o && Date.now() - e.at > 4 * 864e5) delete eds[id];          // never arrived: stop showing it
  }
  LS.set("edits", eds);
  if (bounced) toast(`${bounced} edit${bounced === 1 ? "" : "s"} couldn't go in: that part changed first. It's with Copilot as a comment.`);
  else if (saved) toast(`Your edit${saved === 1 ? " is" : "s are"} in the draft.`);
}

function cacheDraft(gid, z, issue) {
  try {
    LS.set("draft:" + gid, { z, at: Date.now(), issue });
    const ids = [gid, ...LS.get("draftIds", []).filter((x) => x !== gid)];
    ids.slice(8).forEach((x) => LS.del("draft:" + x));
    LS.set("draftIds", ids.slice(0, 8));
  } catch { /* storage full: the draft stays in memory for this visit */ }
}
async function openDraft(gid, line) {
  if (!gid) return;
  if (state.view !== "draft") state.prevView = state.view;
  state.view = "draft"; state.flipped = false;
  const c = LS.get("draft:" + gid, null);
  const r = state.read = { gid, line: line || null, data: null, at: null, loading: true, error: null, open: new Set(),
    issue: grantById(gid).issue || (c && c.issue) || null };
  if (c && c.z) { try { r.data = await unzip64(c.z); r.at = c.at; } catch { /* stale cache: refetch */ } }
  if (state.read !== r) return;
  render(); window.scrollTo(0, 0);
  loadDraft(r);
}
async function loadDraft(r) {
  r.loading = true; r.error = null;
  if (state.read === r && r.data) render();
  try {
    let data, z = null;
    if (state.demo) data = JSON.parse(JSON.stringify((state.deck.drafts || {})[r.gid] || null));
    else {
      const issue = cardOf(r);
      if (!issue) throw new Error("This grant isn't in your inbox right now, so its draft can't be refreshed or edited from the phone.");
      const iss = await gh(`/repos/${repo()}/issues/${issue}`);
      const m = /<!-- lcg:draftz ([A-Za-z0-9+/=]+) -->/.exec(iss.body || "");
      if (m) { z = m[1]; data = await unzip64(z); r.issue = issue; }
    }
    if (!data) throw new Error("There's no draft for this grant on the phone yet. It's added on the next sync once a draft exists.");
    r.data = data; r.at = Date.now();
    if (z) cacheDraft(r.gid, z, r.issue);
    reconcileEdits(r.gid, data);
  } catch (e) {
    r.error = navigator.onLine ? e.message : "You're offline. Showing the copy saved on this phone.";
  } finally {
    r.loading = false;
    if (state.read === r && state.view === "draft") render();
  }
}
function closeDraft() {
  state.view = state.prevView && state.prevView !== "draft" ? state.prevView : "deck";
  state.read = null;
  if (/read=/.test(location.hash)) history.replaceState(null, "", location.pathname + location.search);
  render(); window.scrollTo(0, 0);
}

function pendHTML(p, stale) {
  if (p.status === "conflict") {
    return `<div class="pend bad" role="status"><b>Your phone edit didn't go in</b>
      <p>${p.why === "missing" ? "This part's heading changed before your edit arrived." : p.why === "error" ? "It couldn't be saved." : "This part changed before your edit arrived."} Your version is with Copilot as a comment to merge, so nothing is lost.</p>
      <details><summary>Your version</summary><div class="md">${md(p.text)}</div></details>
      <button class="linkish" data-act="dismiss" data-e="${esc(p.id)}">OK, got it</button></div>`;
  }
  if (stale) {
    return `<div class="pend bad" role="status"><b>This part changed after your edit</b>
      <p>Below is the newer text. Your edit is still on its way; when it arrives it's kept as a comment for Copilot to merge, not written over this.</p>
      <details><summary>Your edit</summary><div class="md">${md(p.text)}</div></details></div>`;
  }
  const queued = LS.get("queue", []).some((q) => q.id === "edit:" + p.id);
  return `<div class="pend" role="status"><b>${queued ? "Waiting for signal" : "Sent"}</b> ${queued ? "It sends when you're back online." : "Your edit lands in the draft within ~10 min."}</div>`;
}
function blockHTML(gid, b, i, canEdit) {
  const pend = pendingFor(gid, b.k), live = liveEdit(pend, b, state.read.data.ed), stale = !!(pend && !live && pend.status !== "conflict");
  const text = live ? live.text : b.x, title = partTitle(b);
  const w = words(text), c = chars(text), over = (b.wl && w > b.wl) || (b.cl && c > b.cl);
  const count = b.wl ? `${w} / ${b.wl} words` : b.cl ? `${c} / ${b.cl} characters` : b.l >= 2 ? `${w} words` : "";
  let n = 0;
  const body = b.cut ? `<p class="cut">Too long to carry on the phone. Read this part on the desktop Grant board.</p>`
    : text.trim() ? md(text).replace(/<mark class="gap">/g, () => canEdit ? `<mark class="gap" data-act="fill" data-i="${i}" data-n="${n++}" role="button" tabindex="0" title="Fill this in">` : `<mark class="gap">`)
    : `<p class="none">Nothing here yet.</p>`;
  const tag = b.l <= 1 ? "h2" : b.l === 2 ? "h3" : "h4";
  const head = `<header class="blk-h">${b.l ? `<${tag} class="blk-t">${mdInline(title)}</${tag}>` : ""}
      <div class="blk-tools">${count ? `<span class="wc${over ? " over" : ""}">${count}${over ? " · over" : ""}</span>` : ""}${b.cut || !canEdit ? "" : `<button class="blk-edit" data-act="edit" data-i="${i}" aria-label="Edit ${esc(title)}">${icon("note")}Edit</button>`}</div></header>`;
  const inner = `${head}${pend ? pendHTML(pend, stale) : ""}<div class="md${live ? " is-pending" : ""}">${body}</div>`;
  if (b.i) return `<details class="blk internal" id="b${i}" data-i="${i}"${state.read.open.has(i) ? " open" : ""}><summary>Copilot's working notes · ${esc(title)}</summary>${inner}</details>`;
  return `<section class="blk lv${b.l}" id="b${i}">${inner}</section>`;
}
function draftView() {
  const r = state.read, g = grantById(r.gid), d = r.data;
  const head = `<header class="rd-top c-${inkOf(g)}">
    <button class="rd-back" data-act="back" aria-label="Back to the ${state.prevView === "shelf" ? "boxes" : "deck"}">${icon("back")}</button>
    <div class="rd-t"><small>The application</small><h1 class="${longWord(g.funder) ? "long" : ""}">${esc(g.funder || g.title || r.gid)}</h1></div>
    ${stampHTML(g)}</header>`;
  if (!d) {
    return head + `<section class="rd">${r.loading ? `<div class="boot">Unfolding the draft…</div>`
      : emptyView("No draft on the phone", r.error || "Nothing to show yet.", false, `<button class="btn later" data-act="back">Back</button>`)}</section>`;
  }
  const blocks = d.blocks || [], parts = blocks.map((b, i) => ({ b, i })).filter((x) => !x.b.i && x.b.l >= 2);
  const canEdit = state.demo || !!cardOf(r);
  const gaps = blocks.filter((b) => !b.i).reduce((n, b) => {
    const p = liveEdit(pendingFor(r.gid, b.k), b, d.ed), t = p ? p.text : b.x;
    return n + (t.replace(/<!--[\s\S]*?-->/g, "").match(NEEDS) || []).length;
  }, 0);
  const pend = Object.values(LS.get("edits", {})).filter((e) => e.gid === r.gid && e.status !== "conflict").length;
  const changed = d.mt ? new Date(d.mt) : null;
  return head + `<section class="rd">
    <div class="rd-bar">
      <span>${changed && !isNaN(changed) ? `Changed ${esc(fmtWhen(changed))}` : ""}${r.loading ? " · checking…" : ""}${pend ? ` · <b class="pending">${pend} edit${pend === 1 ? "" : "s"} on the way</b>` : ""}</span>
      ${gaps ? `<button class="rd-gaps" data-act="gap">${gaps} to fill in ›</button>` : `<span class="rd-ok">Nothing left to fill in</span>`}
    </div>
    ${parts.length > 2 ? `<label class="rd-jump"><span>Jump to</span><select id="jump" aria-label="Jump to a part of the application"><option value="">${parts.length} parts…</option>${parts.map((x) => `<option value="${x.i}">${esc(partTitle(x.b).slice(0, 70))}</option>`).join("")}</select></label>` : ""}
    ${r.error ? `<p class="rd-err" role="alert">${esc(r.error)}</p>` : ""}
    <article class="paper">${blocks.map((b, i) => blockHTML(r.gid, b, i, canEdit)).join("")}</article>
    <p class="rd-end">${esc(d.file || "")}${canEdit ? " · tap <b>Edit</b> on any part, or a yellow gap to fill it in" : " · read only on the phone right now"}</p>
  </section>`;
}
function fmtWhen(d) {
  const mins = Math.round((Date.now() - d) / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 20 * 60) return `${Math.round(mins / 60)} h ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function bindDraft() {
  const r = state.read;
  if (!r || !r.data) return;
  const j = $("#jump");
  if (j) j.onchange = () => { const el = document.getElementById("b" + j.value); if (el) { el.scrollIntoView({ block: "start", behavior: reduced() ? "auto" : "smooth" }); el.focus?.({ preventScroll: true }); } j.value = ""; };
  document.querySelectorAll("details.blk").forEach((el) => (el.ontoggle = () => { const i = +el.dataset.i; el.open ? r.open.add(i) : r.open.delete(i); }));
  document.querySelectorAll("mark.gap").forEach((m) => (m.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); m.click(); } }));
  if (r.line) {
    const at = r.line; r.line = null;
    let idx = 0; (r.data.blocks || []).forEach((b, i) => { if ((b.ln || 0) <= at) idx = i; });
    const el = document.getElementById("b" + idx);
    if (el) {
      if (el.tagName === "DETAILS") { el.open = true; r.open.add(idx); }
      requestAnimationFrame(() => { el.scrollIntoView({ block: "start" }); el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 1600); });
    }
  }
}
function nextGap() {
  const marks = [...document.querySelectorAll(".paper mark.gap")].filter((m) => !m.closest("details:not([open])"));
  if (!marks.length) return;
  const line = ($(".rd-top")?.getBoundingClientRect().bottom || 0) + 12;
  const next = marks.find((m) => m.getBoundingClientRect().top > line + 4) || marks[0];
  next.scrollIntoView({ block: "center", behavior: reduced() ? "auto" : "smooth" });
  next.classList.add("flash"); setTimeout(() => next.classList.remove("flash"), 1400);
}

function gapRanges(text) {   // [NEEDS INPUT …] spans the reader shows (not ones inside <!-- comments -->)
  const skip = [...text.matchAll(/<!--[\s\S]*?-->/g)].map((m) => [m.index, m.index + m[0].length]);
  return [...text.matchAll(NEEDS)].map((m) => [m.index, m.index + m[0].length]).filter(([a]) => !skip.some(([s, e]) => a >= s && a < e));
}
function openEditor(i, gapN) {
  const r = state.read, b = r && r.data && r.data.blocks[i];
  if (!b) return;
  const gid = r.gid, g = grantById(gid), title = partTitle(b);
  const pend = pendingFor(gid, b.k), live = liveEdit(pend, b, r.data.ed);
  const start = live ? live.text : b.x;
  const typing = LS.get("typing", null);
  const resumed = typing && typing.gid === gid && typing.key === b.k && typing.base === b.h && typing.from === start && normText(typing.text) !== normText(start);
  const sheet = $("#sheet"), scrim = document.createElement("div"); scrim.className = "scrim"; document.body.appendChild(scrim);
  sheet.classList.add("tall");
  sheet.innerHTML = `<div class="sheet-scroll"><h2>Edit</h2>
    <p class="ctx">${esc(g.funder || "")} · ${esc(title)}</p>
    ${live ? `<p class="ed-note">This includes your edit that's still on its way.</p>` : ""}
    ${resumed ? `<p class="ed-note">Picked up where you left off. <button class="linkish" data-s="over">Start over</button></p>` : ""}
    <textarea id="ans" class="ed-ta" aria-label="Text of ${esc(title)}" spellcheck="true" autocapitalize="sentences"></textarea>
    <div class="row"><button class="btn mic" data-s="mic" aria-label="Dictate at the cursor">${icon("mic")}</button><span class="listening" id="lis" aria-live="polite">${window.SpeechRecognition || window.webkitSpeechRecognition ? "Tap to talk" : "Use the mic on your keyboard"}</span><span class="wc" id="wc" aria-live="polite"></span></div></div>
    <div class="row"><button class="btn cancel" data-s="cancel">Cancel</button><button class="btn strike" data-s="go">Save ${icon("strike")}</button></div>`;
  sheet.hidden = false; fitSheet();
  const ta = $("#ans"), wc = $("#wc"), go = sheet.querySelector("[data-s=go]"), cancel = sheet.querySelector("[data-s=cancel]");
  ta.value = resumed ? typing.text : start;
  const count = () => {
    const w = words(ta.value), c = chars(ta.value), over = (b.wl && w > b.wl) || (b.cl && c > b.cl);
    wc.textContent = b.wl ? `${w} / ${b.wl} words` : b.cl ? `${c} / ${b.cl} chars` : `${w} words`;
    wc.classList.toggle("over", !!over);
  };
  let armed = false;
  const dirty = () => normText(ta.value) !== normText(start);
  const close = (keep) => {
    stopRec(); sheet.hidden = true; sheet.classList.remove("tall"); scrim.remove();
    if (!keep) LS.del("typing");
  };
  const tryClose = () => {
    if (!dirty() || armed) { close(false); return; }
    armed = true; cancel.textContent = "Discard changes?"; cancel.classList.add("warn");
    setTimeout(() => { armed = false; cancel.textContent = "Cancel"; cancel.classList.remove("warn"); }, 3000);
  };
  ta.oninput = () => { count(); LS.set("typing", { gid, key: b.k, base: b.h, from: start, text: ta.value, at: Date.now() }); };
  scrim.onclick = tryClose; cancel.onclick = tryClose;
  sheet.querySelector("[data-s=mic]").onclick = (e) => toggleRec(ta, e.currentTarget);
  const over = sheet.querySelector("[data-s=over]");
  if (over) over.onclick = () => { ta.value = start; LS.del("typing"); over.parentElement.remove(); count(); ta.focus(); };
  go.onclick = async () => {
    if (!dirty()) { close(false); toast("No changes to send."); return; }
    go.disabled = true; go.textContent = "Sending…";
    try {
      const ok = await sendEdit(r, b, ta.value, live);
      close(false); render();
      toast(state.demo ? "Saved in the demo. Nothing leaves this phone." : ok ? "Sent. It lands in the draft within 10 min." : "Saved. It sends when you have signal.");
      if (navigator.vibrate) navigator.vibrate(18);
    } catch (e) {
      go.disabled = false; go.innerHTML = `Save ${icon("strike")}`; $("#lis").textContent = e.message;
    }
  };
  count();
  setTimeout(() => {
    ta.focus({ preventScroll: true });
    const gap = gapN != null ? gapRanges(ta.value)[gapN] : null;
    if (gap) { ta.setSelectionRange(gap[0], gap[1]); const lh = parseFloat(getComputedStyle(ta).lineHeight) || 24; ta.scrollTop = Math.max(0, (ta.value.slice(0, gap[0]).split("\n").length - 2) * lh); }
    else ta.setSelectionRange(ta.value.length, ta.value.length);
  }, 60);
}
async function sendEdit(r, b, text, prev) {
  const gid = r.gid, issue = cardOf(r), title = partTitle(b).replace(/[`\n]/g, "'");
  if (!state.demo && !issue) throw new Error("This grant isn't in your inbox right now, so the phone can't send edits to it.");
  const id = "e" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  let base = b.h, after = null, chain = [];
  if (prev) {   // built on an edit that hasn't landed yet
    const q = LS.get("queue", []), unsent = q.some((x) => x.id === "edit:" + prev.id);
    base = prev.base || b.h; chain = prev.chain || [];
    if (unsent) { LS.set("queue", q.filter((x) => x.id !== "edit:" + prev.id)); after = prev.prev || null; }   // never left the phone: this replaces it
    else { after = prev.id; chain = [...chain, prev.id]; }
  }
  const z = await zip64({ v: 1, id, file: r.data.file, key: b.k, base, text, ...(after ? { prev: after } : {}) });
  if (z.length > 60000) throw new Error("This part is too long to send from the phone. Edit it on the desktop.");
  const eds = LS.get("edits", {});
  if (prev) delete eds[prev.id];
  if (state.demo) { b.x = normText(text); LS.set("edits", eds); bumpStats({ xp: 15 }); return true; }   // demo: only this phone changes
  eds[id] = { id, gid, key: b.k, title, text, base, chain: chain.slice(-10), ...(after ? { prev: after } : {}), at: Date.now(), status: "sent" };
  LS.set("edits", eds);
  bumpStats({ xp: 15 });
  return post(issue, `/edit ${gid}\n✏️ Edited “${title}” in Matchbox on my phone.\n\n\`\`\`lcg-edit\n${z}\n\`\`\``, "edit:" + id);
}
function fitSheet() {     // keep the open sheet above the on-screen keyboard (iOS doesn't resize the page for it)
  const vv = window.visualViewport, sheet = $("#sheet");
  if (!vv || !sheet) return;
  if (sheet.hidden) { sheet.style.bottom = ""; sheet.style.maxHeight = ""; return; }
  const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
  sheet.style.bottom = kb ? kb + "px" : "";
  sheet.style.maxHeight = kb ? (vv.height - 8) + "px" : "";
}
if (window.visualViewport) { visualViewport.addEventListener("resize", fitSheet); visualViewport.addEventListener("scroll", fitSheet); }

/* ---------- sheet + voice ---------- */
let rec = null;
function openContext(task) {
  const g = grantOf(task), c = task.ctx || {}, ai = task.ai || {}, sheet = $("#sheet");
  const asked = LS.get("explainAsked", {})[task.id];
  const scrim = document.createElement("div"); scrim.className = "scrim"; document.body.appendChild(scrim);
  const facts = (c.facts || []).map((f) => `<li><span class="st st-${esc(f.s)}">${esc(STATUS[f.s] || f.s)}</span>${esc(f.t)}<small>${esc(f.src)}</small></li>`).join("");
  const list = (title, xs) => (xs || []).length ? `<h3>${title}</h3><ul class="lst">${xs.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "";
  sheet.innerHTML = `<div class="sheet-scroll">
    <h2>What this is for</h2>
    <p class="ctx">${esc(g.funder || "")}${c.section ? " · " + esc(c.section) : ""}</p>
    <p class="q-in">${esc(ai.ask || task.prompt)}</p>
    ${ai.ask && ai.ask !== task.prompt ? `<p class="orig">In the draft: “${esc(task.label ? task.label + ": " : "")}${esc(task.prompt)}”</p>` : ""}
    ${ai.found ? foundHTML(ai.found) : ""}
    ${c.deferred ? `<p class="note">You said: “${esc(c.deferred)}”${ai.found ? "" : ". Nothing in our files answers it yet."}</p>` : ""}
    ${ai.why ? `<div class="ai"><b>Copilot's read</b><p>${esc(ai.why)}</p></div>` : ""}
    ${ai.explain ? `<div class="ai"><b>Copilot explains</b><p>${esc(ai.explain)}</p></div>` : ""}
    ${c.where ? `<h3>Your answer goes into</h3><blockquote class="where">${rich(c.where)}</blockquote>` : ""}
    ${(c.used || []).length ? `<h3>Where the application uses it</h3>${c.used.map((u) => `<blockquote class="where">${rich(u, c.hi)}</blockquote>`).join("")}` : ""}
    ${list("The list it introduces", c.list)}${list("Just above it in the draft", c.above)}
    ${c.note ? `<h3>${c.zone === "field" ? "Notes on this field" : "Copilot's note in the draft"}</h3><p class="note">${rich(c.note, c.hi)}</p>` : ""}
    ${facts ? `<h3>What our files say</h3><ul class="facts">${facts}</ul>` : ""}
    ${(() => {
      const rel = (task.rec || []).filter((r) => !(ai.found && r.file === ai.found.file));   // the found box already shows that one
      return rel.length ? `<h3>${rel[0].checked ? "Related in our files" : "Closest matches in our files"}</h3><ul class="facts">${rel.map((r) => `<li>${esc(r.text)}<small>${esc(r.file)}${r.date ? " · " + esc(r.date) : ""}</small></li>`).join("")}</ul>` : "";
    })()}
    ${c.funder ? `<h3>The funder's question</h3><blockquote class="fq">${esc(c.funder)}</blockquote>` : ""}
    ${(c.also || []).length ? `<h3>Also used in</h3><p class="note">${esc(c.also.join(" · "))}</p>` : ""}
    ${readable(g) ? `<p class="note"><button class="linkish inapp" data-s="read">See it in the application ›</button></p>` : ""}
    ${g.draft ? `<p class="note"><a href="${esc(g.draft)}${c.line ? "#L" + c.line : ""}" target="_blank" rel="noopener">Open this spot on GitHub ↗</a></p>` : ""}
    ${asked && !ai.explain ? `<p class="ctx small">You asked Copilot to explain this. It shows up here in about 10 minutes.</p>` : ""}
  </div>
  <div class="row"><button class="btn cancel" data-s="explain" ${asked || !task.id.includes(":q:") ? "disabled" : ""}>${asked ? "Asked ✓" : "Explain more"}</button><button class="btn strike" data-s="answer">${ai.found ? "Answer differently" : "Answer " + icon("strike")}</button></div>`;
  sheet.hidden = false;
  const close = () => { sheet.hidden = true; scrim.remove(); refocus(); };
  scrim.onclick = close;
  const rd = sheet.querySelector("[data-s=read]");
  if (rd) rd.onclick = () => { sheet.hidden = true; scrim.remove(); openDraft(g.id, c.line); };
  sheet.querySelector("[data-s=answer]").onclick = () => { sheet.hidden = true; scrim.remove(); openSheet(task, "right", "Answer", true, false); };
  const ex = sheet.querySelector("[data-s=explain]");
  ex.onclick = async () => {
    const m = LS.get("explainAsked", {}); m[task.id] = Date.now(); LS.set("explainAsked", m);
    ex.disabled = true; ex.textContent = "Asked ✓";
    const ok = await post(task.issue, `/explain q:${task.id.split(":q:")[1]}`, task.id + ":explain");
    toast(ok ? "Asked Copilot. The explanation shows up on this card in about 10 minutes." : "Saved. It asks Copilot when you have signal.");
  };
}
function openSheet(task, dir, label, needText, voice) {
  const g = grantOf(task), sheet = $("#sheet"), ai = task.ai || {}, snip = task.kind === "question" ? snippet(task) : null;
  const scrim = document.createElement("div"); scrim.className = "scrim"; document.body.appendChild(scrim);
  const opts = [...new Set([...(ai.found ? [ai.found.answer] : []), ...(ai.options || [])])];
  const chips = dir === "right" ? opts.map((o) => `<button class="chip" data-opt="${esc(o)}">${esc(o)}</button>`).join("") : "";
  sheet.innerHTML = `<div class="sheet-scroll"><h2>${esc(label)}</h2>
    <p class="ctx">${esc(g.funder || "")}${task.label ? " · " + esc(task.label) : ""}</p>
    <p class="q-in">${esc(ai.ask || task.prompt)}</p>
    ${snip ? `<blockquote class="where small"><span class="wl">${esc(snip.label)}</span>${snip.html}</blockquote>` : ""}
    ${chips ? `<div class="chips" role="group" aria-label="Suggested answers">${chips}</div>` : ""}
    <textarea id="ans" placeholder="${needText ? "Say it or type it…" : "Add a note (optional)"}" aria-label="Your answer"></textarea>
    <div class="row"><button class="btn mic" data-s="mic" aria-label="Dictate">${icon("mic")}</button><span class="listening" id="lis" aria-live="polite">${window.SpeechRecognition || window.webkitSpeechRecognition ? "Tap to talk" : "Use the mic on your keyboard"}</span>${task.ctx ? `<button class="linkish" data-s="ctx">What is this for?</button>` : ""}</div></div>
    <div class="row"><button class="btn cancel" data-s="cancel">Cancel</button><button class="btn strike" data-s="go">${esc(label)} ${icon("strike")}</button></div>`;
  sheet.hidden = false;
  const ta = $("#ans"), close = () => { stopRec(); sheet.hidden = true; scrim.remove(); refocus(); };
  scrim.onclick = close;
  sheet.querySelector("[data-s=cancel]").onclick = close;
  sheet.querySelector("[data-s=mic]").onclick = (e) => toggleRec(ta, e.currentTarget);
  const cx = sheet.querySelector("[data-s=ctx]");
  if (cx) cx.onclick = () => { stopRec(); sheet.hidden = true; scrim.remove(); openContext(task); };
  sheet.querySelectorAll("[data-opt]").forEach((b) => (b.onclick = () => {
    const o = b.dataset.opt, at = o.indexOf("___");
    ta.value = o.replace("___", "");
    ta.focus();
    if (at >= 0) ta.setSelectionRange(at, at);
  }));
  sheet.querySelector("[data-s=go]").onclick = () => {
    const v = ta.value.trim();
    if (needText && !v) { ta.focus(); $("#lis").textContent = "Say or type your answer first"; return; }
    close(); strike(task, dir, v);
  };
  if (voice) toggleRec(ta, sheet.querySelector("[data-s=mic]")); else if (!chips) setTimeout(() => ta.focus(), 50);
}
function openNote(gid) {
  const grants = state.deck?.grants || [], g = grants.find((x) => x.id === gid) || null, sheet = $("#sheet");
  const scrim = document.createElement("div"); scrim.className = "scrim"; document.body.appendChild(scrim);
  let scope = g ? g.id : "all";
  sheet.innerHTML = `<div class="sheet-scroll"><h2>Note for Copilot</h2>
    <p class="ctx">Something new Copilot should know. It doesn't have to answer a card: a changed number, a new partner, a decision, a correction.</p>
    <div class="chips" role="radiogroup" aria-label="Who it's for">
      ${g ? `<button class="chip on" data-scope="${esc(g.id)}" role="radio" aria-checked="true">${esc(g.funder)}</button>` : ""}
      <button class="chip${g ? "" : " on"}" data-scope="all" role="radio" aria-checked="${g ? "false" : "true"}">All grants</button>
    </div>
    <textarea id="ans" placeholder="Say it or type it…" aria-label="Your note"></textarea>
    <div class="row"><button class="btn mic" data-s="mic" aria-label="Dictate">${icon("mic")}</button><span class="listening" id="lis" aria-live="polite">${window.SpeechRecognition || window.webkitSpeechRecognition ? "Tap to talk" : "Use the mic on your keyboard"}</span></div></div>
    <div class="row"><button class="btn cancel" data-s="cancel">Cancel</button><button class="btn strike" data-s="go">Send note ${icon("note")}</button></div>`;
  sheet.hidden = false;
  const ta = $("#ans"), close = () => { stopRec(); sheet.hidden = true; scrim.remove(); refocus(); };
  scrim.onclick = close;
  sheet.querySelector("[data-s=cancel]").onclick = close;
  sheet.querySelector("[data-s=mic]").onclick = (e) => toggleRec(ta, e.currentTarget);
  sheet.querySelectorAll("[data-scope]").forEach((b) => (b.onclick = () => {
    scope = b.dataset.scope;
    sheet.querySelectorAll("[data-scope]").forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-checked", String(x === b)); });
  }));
  sheet.querySelector("[data-s=go]").onclick = async () => {
    const v = ta.value.replace(/\s*\n+\s*/g, " ").trim();
    if (!v) { ta.focus(); $("#lis").textContent = "Say or type the note first"; return; }
    const target = scope === "all" ? (g || grants[0] || {}) : grants.find((x) => x.id === scope) || {};
    const issue = scope === "all" ? (state.inbox || target.issue) : target.issue;   // on the inbox, /fyi means every grant
    if (!issue) { $("#lis").textContent = "No grant card to post on yet. Try after the next sync."; return; }
    close();
    const ok = await post(issue, scope === "all" ? `/fyi all: ${v}` : `/fyi ${v}`, `note:${Date.now()}`);
    toast(ok ? `Noted for ${scope === "all" ? "every grant" : target.funder}. Copilot sees it after the next sync.` : "Saved. It sends when you have signal.");
  };
  setTimeout(() => ta.focus(), 50);
}
function toggleRec(ta, btn) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (rec) { stopRec(); return; }
  if (!SR) { $("#lis").textContent = "Use the mic on your keyboard"; ta.focus(); return; }
  rec = new SR(); rec.lang = "en-US"; rec.interimResults = true; rec.continuous = false;
  const a = ta.selectionStart ?? ta.value.length, z = ta.selectionEnd ?? a;   // speech goes in at the cursor (or replaces the selection)
  const pre = ta.value.slice(0, a), post = ta.value.slice(z), sep = pre && !/\s$/.test(pre) ? " " : "";
  rec.onresult = (e) => {
    let s = ""; for (let i = 0; i < e.results.length; i++) s += e.results[i][0].transcript;
    const tail = post && !/^[\s.,;:!?)]/.test(post) ? " " : "";
    ta.value = pre + sep + s + tail + post;
    const p = (pre + sep + s).length; ta.setSelectionRange(p, p);
    ta.dispatchEvent(new Event("input"));
  };
  rec.onerror = (e) => { $("#lis").textContent = e.error === "not-allowed" ? "Mic blocked: allow it in settings, or use the keyboard mic" : "Didn't catch that. Try again"; };
  rec.onend = () => { rec = null; btn.style.boxShadow = ""; if ($("#lis").textContent === "Listening…") $("#lis").textContent = ""; };
  $("#lis").textContent = "Listening…"; btn.style.boxShadow = "0 0 0 6px rgba(198,42,31,.35)";
  try { rec.start(); } catch { rec = null; $("#lis").textContent = "Use the mic on your keyboard"; }
}
function stopRec() { if (rec) { try { rec.stop(); } catch { /* already stopped */ } rec = null; } }
function refocus() { const el = $(".stack .label:last-child"); if (el) el.focus({ preventScroll: true }); }   // keys keep working after a sheet

function openSettings() {
  const sheet = $("#sheet"), scrim = document.createElement("div"); scrim.className = "scrim"; document.body.appendChild(scrim);
  const goal = LS.get("goal", 3), s = LS.get("stats", { total: 0, xp: 0 }), n = s.total || 0;
  sheet.innerHTML = `<h2>Settings</h2>
    <p class="ctx">${n} match${n === 1 ? "" : "es"} struck · ${s.xp || 0} points · repo ${esc(repo())}</p>
    <label class="ctx">Daily goal <input id="goal" type="number" min="1" max="20" value="${goal}" style="width:70px;margin-left:8px;padding:6px;border:2px solid var(--ink);border-radius:8px"></label>
    <div class="row"><button class="btn cancel" data-s="close">Done</button><button class="btn later" data-s="later" style="background:#e8e2d4;color:var(--ink)">Clear the “later” pile</button></div>
    <div class="row"><button class="btn cancel" data-s="signout" style="color:var(--vermilion);border-color:var(--vermilion)">Forget token on this phone</button></div>`;
  sheet.hidden = false;
  const close = () => { const v = parseInt($("#goal").value, 10); if (v > 0) LS.set("goal", v); sheet.hidden = true; scrim.remove(); render(); };
  scrim.onclick = close;
  sheet.querySelector("[data-s=close]").onclick = close;
  sheet.querySelector("[data-s=later]").onclick = () => { LS.set("later", []); toast("Put-back matches are back in order."); close(); };
  sheet.querySelector("[data-s=signout]").onclick = () => {
    ["token", "deck", "inbox", "queue", "sent", "edits", "typing", "draftIds", ...LS.get("draftIds", []).map((x) => "draft:" + x)].forEach(LS.del);
    state.deck = null; state.read = null; state.view = "deck"; sheet.hidden = true; scrim.remove(); render();
  };
}

/* ---------- bits ---------- */
let toastT;
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 2600); }
function fmtDate(iso) { if (!iso || iso === "rolling") return iso || ""; const d = new Date(iso + "T12:00:00"); return isNaN(d) ? iso : d.toLocaleDateString(undefined, { month: "short", day: "numeric" }); }
function icon(n) {
  const p = {
    mic: '<path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-2.1A7 7 0 0 0 19 12z" fill="currentColor"/>',
    strike: '<path d="M4 20 18 6M15 4l5 5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" fill="none"/><circle cx="18.5" cy="5.5" r="2.6" fill="#c62a1f"/>',
    later: '<path d="M10 6 4 12l6 6M5 12h15" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
    shelf: '<rect x="3" y="4" width="8" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><rect x="13" y="4" width="8" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><rect x="3" y="13" width="8" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><rect x="13" y="13" width="8" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/>',
    deck: '<rect x="5" y="3" width="14" height="18" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 8h8M8 12h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    note: '<path d="M4 20h4L19 9l-4-4L4 16v4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M13.5 6.5l4 4" stroke="currentColor" stroke-width="2"/>',
    back: '<path d="M15 5l-7 7 7 7" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  }[n] || "";
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${p}</svg>`;
}

/* ---------- boot ---------- */
function applyHash() {
  const m = /grant=([^&]+)/.exec(location.hash), rd = /read=([^&]+)/.exec(location.hash);
  if (m) { state.focus = decodeURIComponent(m[1]); state.view = "deck"; }
  if (rd) state.pendingRead = decodeURIComponent(rd[1]);
}
window.addEventListener("hashchange", () => {
  applyHash();
  if (state.pendingRead && state.deck) { const id = state.pendingRead; state.pendingRead = null; openDraft(id); }
  else render();
});
window.addEventListener("online", flushQueue);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !LS.get("token", "")) return;
  if (Date.now() - state.lastFetch > 120e3) fetchDeck();
  if (state.view === "draft" && state.read && !state.read.loading && Date.now() - (state.read.at || 0) > 120e3) loadDraft(state.read);
});
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
applyHash();
if (state.demo) ["sent", "later", "edits", "typing"].forEach(LS.del);   // demo starts fresh each load
render();
if (LS.get("token", "") || state.demo) fetchDeck();
