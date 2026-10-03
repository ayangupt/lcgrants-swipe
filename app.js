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

function decodeDeck(body) {
  const m = /<!-- lcg:deck ([A-Za-z0-9+/=]+) -->/.exec(body || "");
  if (!m) return null;
  const bytes = Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
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
    const deck = decodeDeck(issues[0].body);
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
}

/* ---------- sent / queue / stats (all on this phone) ---------- */
function pruneSent() {
  const sent = LS.get("sent", {}), ids = new Set((state.deck?.tasks || []).map((t) => t.id)), keep = {};
  const dayAgo = Date.now() - 36 * 3600e3;
  for (const [id, ts] of Object.entries(sent)) if (ids.has(id) && ts > dayAgo) keep[id] = ts;
  LS.set("sent", keep);
}
const isSent = (t) => !!LS.get("sent", {})[t.id];

async function send(task, command) {
  const sent = LS.get("sent", {}); sent[task.id] = Date.now(); LS.set("sent", sent);
  bumpStats(task);
  if (state.demo) return true;                       // demo: nothing leaves the phone
  try {
    if (!navigator.onLine) throw new Error("offline");
    await gh(`/repos/${repo()}/issues/${task.issue}/comments`, { method: "POST", body: JSON.stringify({ body: command }) });
    return true;
  } catch {
    const q = LS.get("queue", []); q.push({ issue: task.issue, body: command, id: task.id, at: Date.now() }); LS.set("queue", q);
    return false;
  }
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
function command(task, dir, text) {
  const t = (text || "").replace(/\s*\n+\s*/g, " ").trim();   // the sync reads one command per line
  switch (task.kind) {
    case "question": return `/answer ${task.id.split(":q:")[1] ? "q:" + task.id.split(":q:")[1] : task.n} ${t}`;
    case "decide": return dir === "down" ? `/pass ${t}` : `/pursue ${t}`;
    case "approve": return "/approve";
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
    <button class="iconbtn" data-act="shelf" aria-label="${state.view === "shelf" ? "Back to the deck" : "All boxes"}">${state.view === "shelf" ? icon("deck") : icon("shelf")}</button>
  </header>`;
}

function labelHTML(task, cls, pos) {
  const g = grantOf(task), k = KIND[task.kind] || KIND.question, ink = inkOf(g);
  const d = g.days, hot = d != null && d <= 3;
  const stamp = g.deadline === "rolling" ? `<b>ROLL</b><small>rolling</small>`
    : d == null ? `<b>—</b><small>no date</small>`
    : `<b>${d < 0 ? "LATE" : d === 0 ? "TODAY" : d + "d"}</b><small>${esc(fmtDate(g.deadline))}</small>`;
  if (pos === 0 && state.flipped) return backHTML(task, g, ink, cls);
  const mine = (state.deck?.tasks || []).filter((t) => t.grant === task.grant), sent = LS.get("sent", {});
  const struck = mine.filter((t) => sent[t.id]).length, len = (task.prompt || "").length;
  return `<article class="label c-${ink} ${cls}" data-id="${esc(task.id)}" ${pos === 0 ? 'tabindex="0" aria-roledescription="swipe card"' : 'aria-hidden="true"'}>
    <div class="l-head"><h2 class="funder">${esc(g.funder || g.title || "Grant")}</h2><div class="stamp ${hot ? "hot" : ""}" aria-label="Due ${esc(g.deadline || "no date")}">${stamp}</div></div>
    <div class="l-meta"><span>${esc(k.tag)}</span></div>
    <div class="cartouche">
      ${task.label ? `<div class="qlabel">${esc(task.label)}</div>` : ""}
      <p class="q${len > 220 ? " xl" : len > 130 ? " l" : ""}">${esc(task.prompt)}</p>
      ${task.detail ? `<div class="qdetail">${esc(task.detail)}</div>` : ""}
    </div>
    <div class="l-body">
      ${g.funds && g.funds !== task.detail ? `<p class="funds"><b>What it funds</b> ${esc(g.funds)}</p>` : ""}
      ${mine.length > 1 ? `<div class="boxprog" aria-label="${struck} of ${mine.length} matches struck for this grant">${mine.map((t) => `<i class="${sent[t.id] ? "done" : ""}"></i>`).join("")}<span>${struck} of ${mine.length} struck</span></div>` : ""}
      ${LOTUS}
    </div>
    <div class="l-foot"><button class="flip" data-act="flip">About this grant</button><span>+${task.xp || 10}</span></div>
    <div class="striker" aria-hidden="true"><span>← Later</span><span>${esc(k.right)} →</span></div>
    ${pos === 0 ? `<div class="hint r">${esc(k.right)}</div><div class="hint l">Later</div>${k.up ? `<div class="hint u">${esc(k.up)}</div>` : ""}${k.down ? `<div class="hint d">${esc(k.down)}</div>` : ""}` : ""}
  </article>`;
}
const LOTUS = `<svg class="emblem" viewBox="0 0 120 76" aria-hidden="true"><path d="M60 6c11 13 15 28 0 54C45 34 49 19 60 6z"/><path d="M58 60C50 41 37 29 18 25c2 18 15 32 40 35z"/><path d="M62 60c8-19 21-31 40-35-2 18-15 32-40 35z"/><path d="M57 63C38 60 20 52 4 41c8 16 27 26 53 22z"/><path d="M63 63c19-3 37-11 53-22-8 16-27 26-53 22z"/><rect x="22" y="68" width="76" height="4" rx="2"/></svg>`;
function backHTML(task, g, ink, cls) {
  const sent = LS.get("sent", {}), left = (state.deck?.tasks || []).filter((t) => t.grant === task.grant && !sent[t.id]).length;
  return `<article class="label back c-${ink} ${cls}" data-id="${esc(task.id)}" tabindex="0">
    <div class="l-head"><h2 class="funder">${esc(g.funder || "Grant")}</h2></div>
    <div class="l-meta"><span>${esc(g.stage || "")}</span></div>
    <div class="cartouche">
      ${g.title && g.title !== g.funder ? `<h3>Grant</h3><p>${esc(g.title)}</p>` : ""}
      ${g.funds ? `<h3>What it funds</h3><p>${esc(g.funds)}</p>` : ""}
      ${g.award ? `<h3>Award</h3><p>${esc(g.award)}</p>` : ""}
      ${(g.why || []).length ? `<h3>Why it needs you</h3><p>${esc(g.why.join("; "))}</p>` : ""}
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
    const sentN = Object.keys(LS.get("sent", {})).length;
    return `<section class="stage">${emptyView(state.focus ? "This box is empty" : "Box is empty",
      sentN ? `${sentN} repl${sentN === 1 ? "y is" : "ies are"} on the way to the drafts. New matches arrive after the next sync.` :
        "Nothing needs you right now. New matches arrive after the next sync.", false)}</section>`;
  }
  const top = tasks.slice(0, 3);
  const k = KIND[tasks[0].kind] || KIND.question;
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
    return `<button class="box c-${inkOf(g)}" data-act="focus" data-grant="${esc(g.id)}">
      <span class="bn">${esc(g.funder)}</span>
      <span class="bd">${g.deadline === "rolling" ? "Rolling" : d == null ? "No date" : d < 0 ? "Late" : d === 0 ? "Due today" : `Due in ${d}d`} · ${left} left</span>
      <span class="sticks" aria-hidden="true">${sticks}</span></button>`;
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

function emptyView(title, text, retry) {
  return `<div class="empty"><svg width="88" height="64" viewBox="0 0 88 64" aria-hidden="true"><rect x="4" y="14" width="80" height="46" rx="6" fill="#c62a1f"/><rect x="10" y="20" width="68" height="34" rx="3" fill="none" stroke="#fffaf0" stroke-width="2"/><rect x="4" y="6" width="80" height="12" rx="4" fill="#f4b41a"/></svg>
    <h2>${esc(title)}</h2><p>${esc(text)}</p>${retry ? `<button class="btn strike" data-act="refresh">Try again</button><button class="btn later" data-act="settings">Settings</button>` : ""}</div>`;
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
  if (act === "shelf") { state.view = state.view === "shelf" ? "deck" : "shelf"; state.flipped = false; render(); }
  else if (act === "focus") { state.focus = b.dataset.grant; state.view = "deck"; state.flipped = false; render(); }
  else if (act === "unfocus") { state.focus = null; render(); }
  else if (act === "refresh") fetchDeck();
  else if (act === "settings") openSettings();
  else if (act === "flip") { e.stopPropagation(); state.flipped = !state.flipped; render(); }
  else if (top && act === "later") flyOut(top, "left");
  else if (top && act === "right") act3(top, "right");
  else if (top && act === "voice") act3(top, "right", true);
  else if (top && act === "up") act3(top, "up");
  else if (top && act === "down") act3(top, "down");
}

function act3(task, dir, voice = false) {
  const k = KIND[task.kind] || KIND.question;
  const label = dir === "up" ? k.up : dir === "down" ? k.down : k.right;
  const mode = dir === "down" ? "note" : dir === "up" ? "note" : k.sheet;
  if (mode === "confirm" && !voice) { strike(task, dir, ""); return; }
  openSheet(task, dir, label, mode === "text", voice);
}

function bindSwipe() {
  const el = $(".stack .label:last-child");
  if (!el) return;
  const task = visibleTasks()[0], k = KIND[task.kind] || KIND.question;
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

/* ---------- sheet + voice ---------- */
let rec = null;
function openSheet(task, dir, label, needText, voice) {
  const g = grantOf(task), sheet = $("#sheet");
  const scrim = document.createElement("div"); scrim.className = "scrim"; document.body.appendChild(scrim);
  sheet.innerHTML = `<h2>${esc(label)}</h2>
    <p class="ctx">${esc(g.funder || "")}${task.label ? " · " + esc(task.label) : ""}<br>${esc(task.prompt)}</p>
    <textarea id="ans" placeholder="${needText ? "Say it or type it…" : "Add a note (optional)"}" aria-label="Your answer"></textarea>
    <div class="row"><button class="btn mic" data-s="mic" aria-label="Dictate">${icon("mic")}</button><span class="listening" id="lis" aria-live="polite">${window.SpeechRecognition || window.webkitSpeechRecognition ? "Tap to talk" : "Use the mic on your keyboard"}</span></div>
    <div class="row"><button class="btn cancel" data-s="cancel">Cancel</button><button class="btn strike" data-s="go">${esc(label)} ${icon("strike")}</button></div>`;
  sheet.hidden = false;
  const ta = $("#ans"), close = () => { stopRec(); sheet.hidden = true; scrim.remove(); };
  scrim.onclick = close;
  sheet.querySelector("[data-s=cancel]").onclick = close;
  sheet.querySelector("[data-s=mic]").onclick = (e) => toggleRec(ta, e.currentTarget);
  sheet.querySelector("[data-s=go]").onclick = () => {
    const v = ta.value.trim();
    if (needText && !v) { ta.focus(); $("#lis").textContent = "Say or type your answer first"; return; }
    close(); strike(task, dir, v);
  };
  if (voice) toggleRec(ta, sheet.querySelector("[data-s=mic]")); else setTimeout(() => ta.focus(), 50);
}
function toggleRec(ta, btn) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (rec) { stopRec(); return; }
  if (!SR) { $("#lis").textContent = "Use the mic on your keyboard"; ta.focus(); return; }
  rec = new SR(); rec.lang = "en-US"; rec.interimResults = true; rec.continuous = false;
  const base = ta.value ? ta.value.replace(/\s*$/, " ") : "";
  rec.onresult = (e) => { let s = ""; for (let i = 0; i < e.results.length; i++) s += e.results[i][0].transcript; ta.value = base + s; };
  rec.onerror = (e) => { $("#lis").textContent = e.error === "not-allowed" ? "Mic blocked: allow it in settings, or use the keyboard mic" : "Didn't catch that. Try again"; };
  rec.onend = () => { rec = null; btn.style.boxShadow = ""; if ($("#lis").textContent === "Listening…") $("#lis").textContent = ""; };
  $("#lis").textContent = "Listening…"; btn.style.boxShadow = "0 0 0 6px rgba(198,42,31,.35)";
  try { rec.start(); } catch { rec = null; $("#lis").textContent = "Use the mic on your keyboard"; }
}
function stopRec() { if (rec) { try { rec.stop(); } catch { /* already stopped */ } rec = null; } }

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
  sheet.querySelector("[data-s=signout]").onclick = () => { ["token", "deck", "inbox", "queue", "sent"].forEach(LS.del); state.deck = null; sheet.hidden = true; scrim.remove(); render(); };
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
  }[n] || "";
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${p}</svg>`;
}

/* ---------- boot ---------- */
function applyHash() {
  const m = /grant=([^&]+)/.exec(location.hash);
  if (m) { state.focus = decodeURIComponent(m[1]); state.view = "deck"; }
}
window.addEventListener("hashchange", () => { applyHash(); render(); });
window.addEventListener("online", flushQueue);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && LS.get("token", "") && Date.now() - state.lastFetch > 120e3) fetchDeck();
});
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
applyHash();
if (state.demo) ["sent", "later"].forEach(LS.del);   // demo starts fresh each load
render();
if (LS.get("token", "") || state.demo) fetchDeck();
