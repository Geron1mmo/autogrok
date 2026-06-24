"use strict";

const AUTH_API_URL = "https://script.google.com/macros/s/AKfycbxR1dSf-PUE8InE7nFcF9I0GX79Ssi8TvttvI-UA-G8COe4qIXr1p9kcLJwGz90-w/exec";
const ADMIN_PASSWORD = "2";
const AG_VERSION = "v6.0 HUMAN-GROK";
const PROMPT_ECHO_INITIAL_GRACE_MS = 11000;
const PROMPT_ECHO_LOST_GRACE_MS = 16000;
const DOWNLOAD_COMPLETE_WAIT_MS = 90000;
const POST_SEND_IGNORE_ECHO_MS = 9000;
const DOWNLOAD_PROMPT_CONTEXT_GRACE_MS = 9000;
const DOWNLOAD_NO_ECHO_SAFE_DELAY_MS = 11000;
let downloadClickedForThisPrompt = false;

const S = {
  prompts: "ag4_prompts",
  index: "ag4_index",
  running: "ag4_running",
  resume: "ag4_resume",
  mode: "ag4_mode",
  menuOpen: "ag4_menu_open",
  user: "ag4_user",
  role: "ag4_role",
  logged: "ag4_logged",
  stats: "ag4_stats",
  refData: "ag4_ref_data",
  refName: "ag4_ref_name",
  refMime: "ag4_ref_mime",
  useRef: "ag4_use_ref",
  sendSig: "ag4_send_sig",
  downloadSig: "ag4_download_sig",
  uploadSig: "ag4_upload_sig"
};

const WAIT = {
  reference: 45000,
  input: 35000,
  promptConfirm: 30000,
  wsAccept: 45000,
  generation: 14 * 60 * 1000,
  download: 4 * 60 * 1000
};

let promptsText = "";
let queue = [];
let index = 0;
let runningWanted = false;
let running = false;
let paused = false;
let stopped = false;
let mode = "video";
let menuOpen = true;

let currentUser = null;
let currentRole = "user";
let logged = false;
let stats = {};

let refFile = null;
let refData = null;
let refName = null;
let refMime = null;
let useRef = false;

let sendSig = null;
let downloadSig = null;
let uploadSig = null;
let calibrating = null;

// globalBlockActive: mirrors the bridge's globalBlock flag.
// When true, the bridge blocks ALL WS sends unless a matching gate is active+unconsumed.
// Activated at the start of every prompt cycle, deactivated after download (or on error).
let globalBlockActive = false;

let ws = {
  outgoingPrompt: "",
  accepted: false,
  blocked: false,
  blockedReason: "",
  started: false,
  finished: false,
  percent: 0,
  requestId: "",
  lastEventAt: 0
};

let activePromptHash = "";
let sendClickedAt = 0;
let preSendDownloadSnapshot = new Set();
let startClickedAt = 0;
let promptEchoConfirmedAt = 0;
let promptEchoText = "";

injectBridge();
installStyles();
installWsEvents();
boot();

function injectBridge() {
  const run = () => {
    if (document.getElementById("autogrok-v4-bridge-script")) return;
    const s = document.createElement("script");
    s.id = "autogrok-v4-bridge-script";
    s.src = chrome.runtime.getURL("grok-ws-bridge.js");
    s.onload = () => s.remove();
    (document.documentElement || document.head || document.body).appendChild(s);
  };
  if (document.documentElement) run();
  else document.addEventListener("DOMContentLoaded", run, { once: true });
}

function installStyles() {
  const run = () => {
    if (document.getElementById("ag4-style")) return;
    const st = document.createElement("style");
    st.id = "ag4-style";
    st.textContent = `
      .ag4-btn{transition:.12s transform,.12s filter}.ag4-btn:hover{transform:translateY(-1px);filter:brightness(1.08)}.ag4-btn:active{transform:scale(.97)}
      .ag4-input:focus{outline:none!important;border-color:rgba(34,197,94,.75)!important;box-shadow:0 0 0 3px rgba(34,197,94,.14)!important}
      #ag4-menu::-webkit-scrollbar{width:8px}#ag4-menu::-webkit-scrollbar-thumb{background:#334155;border-radius:999px}
    `;
    (document.head || document.documentElement).appendChild(st);
  };
  if (document.head || document.documentElement) run();
  else document.addEventListener("DOMContentLoaded", run, { once: true });
}

function installWsEvents() {
  if (window.__AG4_CONTENT_EVENTS__) return;
  window.__AG4_CONTENT_EVENTS__ = true;

  window.addEventListener("autogrok:v4-ws-outgoing", e => {
    ws.outgoingPrompt = e.detail?.prompt || "";
    ws.lastEventAt = Date.now();

    const currentPrompt = queue[index] || "";
    if (currentPrompt && echoMatchesPrompt(ws.outgoingPrompt, currentPrompt)) {
      setWs("Grok відправляє правильний prompt");
      setText("ag4-protect", "WS outgoing OK");
    } else {
      setWs("Grok отримує промт...");
    }
  });

  window.addEventListener("autogrok:v4-ws-accepted", e => {
    ws.accepted = true;
    ws.blocked = false;
    ws.lastEventAt = Date.now();
    setWs("Промт підтверджено");
  });

  window.addEventListener("autogrok:v4-ws-blocked", e => {
    ws.blocked = true;
    ws.blockedReason = e.detail?.reason || "blocked";
    ws.lastEventAt = Date.now();
    setWs("Заблоковано: " + ws.blockedReason);
  });

  window.addEventListener("autogrok:v4-generation-started", e => {
    ws.started = true;
    ws.requestId = e.detail?.requestId || "";
    ws.lastEventAt = Date.now();
    setWs("Генерація стартувала");
  });

  window.addEventListener("autogrok:v4-generation-progress", e => {
    ws.percent = Number(e.detail?.percent || 0);
    ws.lastEventAt = Date.now();
    setWs(ws.percent + "%");
    if (ws.percent >= 100) ws.finished = true;
  });

  window.addEventListener("autogrok:v4-generation-finished", () => {
    ws.finished = true;
    ws.percent = 100;
    ws.lastEventAt = Date.now();
    setWs("100%, чекаю Download");
  });
}

async function boot() {
  await loadState();
  createFloatingButton();
  startAccessWatcher();
  if (menuOpen || runningWanted) setTimeout(openMenu, 600);
  if (runningWanted && queue.length && logged) setTimeout(resumeFlow, 1800);
}

async function loadState() {
  const d = await storageGet(Object.values(S));
  promptsText = d[S.prompts] || "";
  queue = parsePrompts(promptsText);
  index = Number(d[S.index] || 0);
  runningWanted = !!d[S.running] || !!d[S.resume];
  mode = d[S.mode] || "video";
  menuOpen = d[S.menuOpen] !== false;
  currentUser = d[S.user] || null;
  currentRole = d[S.role] || "user";
  logged = !!d[S.logged];
  stats = d[S.stats] || {};
  refData = d[S.refData] || null;
  refName = d[S.refName] || null;
  refMime = d[S.refMime] || null;
  useRef = !!d[S.useRef];
  sendSig = d[S.sendSig] || null;
  downloadSig = d[S.downloadSig] || null;
  uploadSig = d[S.uploadSig] || null;
  if (refData && refName && refMime) refFile = await dataUrlToFile(refData, refName, refMime);
}

function saveState() {
  return storageSet({
    [S.prompts]: promptsText,
    [S.index]: index,
    [S.running]: runningWanted,
    [S.resume]: runningWanted,
    [S.mode]: mode,
    [S.menuOpen]: menuOpen,
    [S.user]: currentUser,
    [S.role]: currentRole,
    [S.logged]: logged,
    [S.stats]: stats,
    [S.refData]: refData,
    [S.refName]: refName,
    [S.refMime]: refMime,
    [S.useRef]: useRef,
    [S.sendSig]: sendSig,
    [S.downloadSig]: downloadSig,
    [S.uploadSig]: uploadSig
  });
}

function saveProgress() {
  return storageSet({
    [S.prompts]: promptsText,
    [S.index]: index,
    [S.running]: runningWanted,
    [S.resume]: runningWanted,
    [S.stats]: stats
  });
}

async function resetRunOnly() {
  running = false;
  paused = false;
  stopped = true;
  runningWanted = false;
  activePromptHash = "";
  resetWsState();
  deactivateBlock(); // resets gate + global block in bridge
  promptEchoConfirmedAt = 0;
  promptEchoText = "";
  downloadClickedForThisPrompt = false;
  await storageSet({ [S.running]: false, [S.resume]: false });
}

function createFloatingButton() {
  const run = () => {
    if (document.getElementById("ag4-float")) return;
    const b = document.createElement("button");
    b.id = "ag4-float";
    b.textContent = "AG";
    b.className = "ag4-btn";
    Object.assign(b.style, {
      position: "fixed", right: "20px", bottom: "20px", zIndex: 9999999,
      width: "58px", height: "58px", borderRadius: "20px", border: "1px solid rgba(255,255,255,.28)",
      background: "linear-gradient(135deg,#22c55e,#06b6d4,#6366f1)", color: "white", fontWeight: "950", fontSize: "18px",
      cursor: "pointer", boxShadow: "0 20px 60px rgba(34,197,94,.35)"
    });
    b.onclick = () => openMenu(true);
    document.body.appendChild(b);
  };
  if (document.body) run(); else document.addEventListener("DOMContentLoaded", run, { once: true });
}

function openMenu(force = false) {
  if (!document.body) return;
  const old = document.getElementById("ag4-menu");
  if (old) { if (force) old.style.display = "block"; return; }
  menuOpen = true; saveState();

  const m = document.createElement("div");
  m.id = "ag4-menu";
  Object.assign(m.style, {
    position: "fixed", top: "28px", left: "28px", width: "640px", maxHeight: "92vh", overflowY: "auto", zIndex: 9999998,
    background: "radial-gradient(circle at top left,rgba(34,197,94,.22),transparent 35%),linear-gradient(180deg,#111827,#020617)",
    border: "1px solid rgba(148,163,184,.24)", borderRadius: "24px", color: "white", padding: "16px", fontFamily: "Inter,Arial,sans-serif",
    boxShadow: "0 25px 90px rgba(0,0,0,.62)", backdropFilter: "blur(14px)"
  });

  m.innerHTML = `
    <div id="ag4-head" style="display:flex;justify-content:space-between;gap:12px;align-items:center;padding-bottom:12px;border-bottom:1px solid rgba(148,163,184,.18);cursor:move;user-select:none">
      <div style="display:flex;gap:12px;align-items:center">
        <div style="width:52px;height:52px;border-radius:18px;background:linear-gradient(135deg,#22c55e,#06b6d4,#6366f1);display:flex;align-items:center;justify-content:center;font-weight:950;font-size:18px">AG</div>
        <div><div style="font-size:22px;font-weight:950">AutoGrok Team <span style="color:#22c55e">${AG_VERSION}</span></div><div style="font-size:12px;color:#cbd5e1;margin-top:5px;font-weight:750">created by Geron1mmO · @${escapeHtml(displayUserName())} / ${escapeHtml(currentRole)}</div></div>
      </div>
      <div style="display:flex;gap:7px"><button id="ag4-min" class="ag4-btn" style="width:38px;height:38px;border:0;border-radius:13px;background:#eab308;font-weight:950;cursor:pointer">—</button><button id="ag4-x" class="ag4-btn" style="width:38px;height:38px;border:0;border-radius:13px;background:#dc2626;color:white;font-weight:950;cursor:pointer">×</button></div>
    </div>

    <div id="ag4-login" style="${logged ? "display:none" : ""};margin-top:14px;padding:14px;border-radius:18px;background:rgba(2,6,23,.78);border:1px solid rgba(148,163,184,.18)">
      <div style="font-weight:950;margin-bottom:10px">🔐 Вхід команди</div>
      <div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) 118px;gap:8px"><input id="ag4-name" class="ag4-input" placeholder="імʼя" style="background:#020617;color:white;border:1px solid #334155;border-radius:12px;padding:11px"><input id="ag4-pass" class="ag4-input" type="password" placeholder="пароль" style="background:#020617;color:white;border:1px solid #334155;border-radius:12px;padding:11px"><button id="ag4-login-btn" class="ag4-btn" style="border:0;border-radius:12px;background:#16a34a;color:white;font-weight:950;padding:0 10px;min-height:42px;cursor:pointer;white-space:nowrap">Увійти</button></div>
      <div id="ag4-login-status" style="margin-top:8px;font-size:12px;color:#94a3b8">Введи логін і пароль.</div>
    </div>

    <div id="ag4-main" style="${logged ? "" : "display:none"};margin-top:14px">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-bottom:10px"><button id="ag4-img" class="ag4-btn" style="border:0;padding:13px;border-radius:15px;color:white;font-weight:950;cursor:pointer">🖼 Фото</button><button id="ag4-vid" class="ag4-btn" style="border:0;padding:13px;border-radius:15px;color:white;font-weight:950;cursor:pointer">🎥 Відео</button></div>
      <textarea id="ag4-prompts" class="ag4-input" placeholder="Промт 1...\n\nПромт 2..." style="width:100%;height:190px;background:#020617;color:white;border:1px solid #334155;border-radius:18px;padding:14px;box-sizing:border-box;resize:none;line-height:1.5">${escapeHtml(promptsText)}</textarea>
      <div style="margin-top:10px;padding:13px;border-radius:18px;background:rgba(15,23,42,.72);border:1px solid rgba(148,163,184,.16);display:flex;justify-content:space-between;gap:10px;align-items:center">
        <div><div style="font-size:13px;font-weight:950">🧩 Reference Image</div><div id="ag4-ref-status" style="font-size:12px;color:#94a3b8;margin-top:4px">${escapeHtml(refName || "Фото не вибрано")}</div></div>
        <div style="display:flex;gap:8px;align-items:center"><label style="font-size:12px;color:#cbd5e1;white-space:nowrap"><input id="ag4-use-ref" type="checkbox" ${useRef ? "checked" : ""}> додавати</label><button id="ag4-pick-ref" class="ag4-btn" style="border:0;border-radius:14px;background:#10b981;color:white;font-weight:950;padding:12px;cursor:pointer">Вибрати</button></div>
      </div>
      <div style="margin-top:10px;display:grid;grid-template-columns:1fr 1fr;gap:9px"><div style="padding:12px;border-radius:16px;border:1px solid #1e293b;background:#020617"><div style="font-size:11px;color:#94a3b8">СТАРТ З ПРОМТА</div><input id="ag4-start" type="number" min="1" value="${index + 1}" class="ag4-input" style="margin-top:8px;width:100%;box-sizing:border-box;background:#020617;color:white;border:1px solid #334155;border-radius:12px;padding:10px"></div><div style="padding:12px;border-radius:16px;border:1px solid #1e293b;background:#020617;font-size:12px;color:#cbd5e1;line-height:1.45"><b>Logic:</b> reference → prompt echo → safe delay → 100% → confirmed download → next.</div></div>
      <div style="margin-top:11px;display:grid;grid-template-columns:1.1fr 1fr 1fr 1fr;gap:8px"><button id="ag4-run" class="ag4-btn" style="border:0;border-radius:15px;background:#22c55e;color:white;font-weight:950;padding:14px;cursor:pointer">▶ Почати</button><button id="ag4-pause" class="ag4-btn" style="border:0;border-radius:15px;background:#f59e0b;color:white;font-weight:950;padding:14px;cursor:pointer">⏸ Пауза</button><button id="ag4-stop" class="ag4-btn" style="border:0;border-radius:15px;background:#dc2626;color:white;font-weight:950;padding:14px;cursor:pointer">⛔ Стоп</button><button id="ag4-refresh" class="ag4-btn" style="border:0;border-radius:15px;background:#2563eb;color:white;font-weight:950;padding:14px;cursor:pointer">🔄 Reload</button></div>
      <div style="margin-top:8px;display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px"><button id="ag4-clear" class="ag4-btn" style="border:0;border-radius:13px;background:#ea580c;color:white;font-weight:900;padding:10px;cursor:pointer">🧹 Скинути</button><button id="ag4-admin" class="ag4-btn" style="border:1px solid #334155;border-radius:13px;background:#1e293b;color:#e2e8f0;font-weight:900;padding:10px;cursor:pointer">⚙ Admin</button><button id="ag4-out" class="ag4-btn" style="border:1px solid #7f1d1d;border-radius:13px;background:#450a0a;color:#fecaca;font-weight:900;padding:10px;cursor:pointer">Вийти</button></div>
      <div style="margin-top:11px;display:grid;grid-template-columns:1fr 1fr;gap:9px"><div style="padding:14px;border-radius:17px;background:#020617;border:1px solid #1e293b"><div style="font-size:11px;color:#94a3b8">ASSETS</div><div id="ag4-assets" style="font-size:27px;font-weight:950;margin-top:5px">${queue.length}</div></div><div style="padding:14px;border-radius:17px;background:#020617;border:1px solid #1e293b"><div style="font-size:11px;color:#94a3b8">PROGRESS</div><div id="ag4-progress" style="font-size:27px;font-weight:950;margin-top:5px">${index} / ${queue.length}</div></div></div>
      <div style="margin-top:10px;padding:13px;border-radius:17px;background:#020617;border:1px solid #1e293b;font-size:12px;color:#cbd5e1;line-height:1.85">
        <div style="display:flex;justify-content:space-between"><span>🎭 Режим</span><b id="ag4-mode-text">${mode === "video" ? "Відео" : "Фото"}</b></div>
        <div style="display:flex;justify-content:space-between"><span>⚡ Статус</span><b id="ag4-status">Готовий</b></div>
        <div style="display:flex;justify-content:space-between"><span>📡 Grok</span><b id="ag4-ws">очікує</b></div>
        <div style="display:flex;justify-content:space-between"><span>👤 Згенеровано</span><b id="ag4-user-count">${currentUser && stats[currentUser] ? stats[currentUser].total : 0}</b></div>
        <div style="display:flex;justify-content:space-between"><span>🛡 Захист</span><b id="ag4-protect">активний</b></div>
      </div>
    </div>`;

  document.body.appendChild(m);
  makeDraggable(m, document.getElementById("ag4-head"));
  bindMenu();
  refreshModeButtons();
  updateStats();
}

function bindMenu() {
  on("ag4-x", () => { menuOpen = false; saveState(); document.getElementById("ag4-menu")?.remove(); });
  on("ag4-min", () => { document.getElementById("ag4-menu").style.display = "none"; menuOpen = true; saveState(); });
  on("ag4-login-btn", login);
  on("ag4-img", () => { mode = "image"; saveState(); refreshModeButtons(); setText("ag4-mode-text", "Фото"); });
  on("ag4-vid", () => { mode = "video"; saveState(); refreshModeButtons(); setText("ag4-mode-text", "Відео"); });
  on("ag4-pick-ref", chooseRef);
  on("ag4-run", startFlow);
  on("ag4-pause", () => { paused = !paused; setStatus(paused ? "Пауза." : "Продовжую."); });
  on("ag4-stop", async () => { await resetRunOnly(); setStatus("Зупинено."); });
  on("ag4-refresh", async () => { await saveProgress(); location.href = "https://grok.com/imagine"; });
  on("ag4-clear", clearAll);
  on("ag4-admin", showAdmin);
  on("ag4-out", () => { logged = false; currentUser = null; currentRole = "user"; saveState(); document.getElementById("ag4-menu")?.remove(); openMenu(true); });
  const ta = document.getElementById("ag4-prompts");
  if (ta) ta.addEventListener("input", () => { promptsText = ta.value; queue = parsePrompts(promptsText); saveState(); updateStats(); });
  const ur = document.getElementById("ag4-use-ref");
  if (ur) ur.onchange = e => { useRef = !!e.target.checked; saveState(); setStatus(useRef ? "Reference увімкнено." : "Reference вимкнено."); };
}

async function login() {
  const name = (document.getElementById("ag4-name")?.value || "").trim().toLowerCase();
  const pass = document.getElementById("ag4-pass")?.value || "";
  setText("ag4-login-status", "Перевіряю...");
  const r = await checkUserAccess(name, pass);
  if (!r.ok) return setText("ag4-login-status", r.error || "Доступ заборонено.");
  currentUser = r.user || name;
  currentRole = r.role || "user";
  logged = true;
  ensureUserStats(currentUser);
  await saveState();
  document.getElementById("ag4-menu")?.remove();
  openMenu(true);
}

async function checkUserAccess(username, password) {
  try {
    const url = AUTH_API_URL + "?action=login&username=" + encodeURIComponent(username) + "&password=" + encodeURIComponent(password) + "&t=" + Date.now();
    const res = await fetch(url, { cache: "no-store" });
    const txt = await res.text();
    return JSON.parse(txt);
  } catch {
    return { ok: false, error: "Не можу підключитись до Google Sheets" };
  }
}

async function checkCurrentUserAccess() {
  try {
    if (!logged || !currentUser) return true;
    const url = AUTH_API_URL + "?action=check&username=" + encodeURIComponent(currentUser) + "&t=" + Date.now();
    const res = await fetch(url, { cache: "no-store" });
    const data = await res.json();
    if (data?.ok === true && data?.active === true) { currentRole = data.role || currentRole; saveState(); return true; }
    return false;
  } catch { return true; }
}

function startAccessWatcher() {
  if (window.__AG4_ACCESS__) return;
  window.__AG4_ACCESS__ = true;
  setInterval(async () => {
    if (!logged || !currentUser) return;
    if (!(await checkCurrentUserAccess())) {
      await resetRunOnly(); logged = false; currentUser = null; currentRole = "user"; await saveState(); alert("Доступ вимкнено. AutoGrok зупинено."); location.reload();
    }
  }, 30000);
}

async function startFlow() {
  if (Date.now() - startClickedAt < 2500) return;
  startClickedAt = Date.now();

  if (!logged) return setStatus("Спочатку увійди в Team Login.");
  if (!(await checkCurrentUserAccess())) return setStatus("Доступ вимкнено.");
  if (running) return setStatus("AutoGrok вже працює.");

  promptsText = document.getElementById("ag4-prompts")?.value || promptsText;
  queue = parsePrompts(promptsText);
  const n = parseInt(document.getElementById("ag4-start")?.value || "1", 10);
  index = Math.max(0, Math.min((Number.isFinite(n) ? n : 1) - 1, Math.max(queue.length - 1, 0)));

  if (!queue.length) return setStatus("Немає промтів.");
  if (useRef && !refFile) return setStatus("Вибери reference image.");

  stopped = false;
  paused = false;
  running = true;
  runningWanted = true;
  await saveProgress();
  await runOneAndReloadLoop();
}

async function resumeFlow() {
  if (running) return;
  if (!runningWanted || !queue.length || !logged) return;
  running = true;
  stopped = false;
  paused = false;
  setStatus("Resume: продовжую з промта " + (index + 1));
  await runOneAndReloadLoop();
}

async function runOneAndReloadLoop() {
  try {
    while (runningWanted && index < queue.length && !stopped) {
      await waitIfPaused();
      const prompt = queue[index];
      if (!prompt || prompt.length < 3) { index++; await saveProgress(); continue; }

      updateStats();
      const ok = await processOnePrompt(prompt);
      if (!ok) {
        setStatus("Помилка. Оновлюю і повторюю цей самий промт...");
        await sleep(2500);
        runningWanted = true;
        await saveProgress();
        location.href = "https://grok.com/imagine";
        return;
      }

      recordGenerated(currentUser, mode, prompt);
      index++;
      await saveProgress();
      updateStats();

      if (index < queue.length) {
        setStatus("Готово. Оновлюю для наступного промта...");
        await sleep(3500);
        location.href = "https://grok.com/imagine";
        return;
      }
    }

    running = false;
    runningWanted = false;
    await saveProgress();
    setStatus("Всі assets готові.");
  } catch (err) {
    console.error("AutoGrok v4 error", err);
    setStatus("Помилка: " + (err?.message || err));
    running = false;
  }
}

async function processOnePrompt(prompt) {
  activePromptHash = hash(prompt);
  resetWsState();
  deactivateBlock(); // ensure clean state first
  await sleep(150);
  activateBlock();   // BLOCK all WS sends until we set the gate and click Send
  promptEchoConfirmedAt = 0;
  promptEchoText = "";
  downloadClickedForThisPrompt = false;

  setStatus(`Промт ${index + 1}/${queue.length}: готую Grok...`);
  await ensureImaginePage();
  await ensureMode();
  await ensureQuality720();

  if (useRef) {
    const refReady = await ensureReferenceFileReady();
    if (!refReady) return failStep("Reference увімкнений, але файл не знайдено. Вибери фото ще раз.");

    setStatus("Вставляю reference image...");
    const refOk = await uploadReferenceAndConfirm();
    if (!refOk) return failStep("Reference не підтверджено. Send заблоковано, щоб не генерувати без фото.");
    setStatus("Grok step OK: reference є. Вставляю prompt...");
  }

  const input = await waitForInput(WAIT.input);
  if (!input) return failStep("Поле промта не знайдено.");

  const inserted = await insertAndConfirmPrompt(input, prompt);
  if (!inserted) return failStep("Промт не підтверджено у полі.");

  setGate(prompt, activePromptHash);
  await ensureQuality720();
  setStatus("Grok step OK: prompt є у полі. Шукаю Send...");

  const sendBtn = await waitForSendButton(input, prompt, 25000);
  if (!sendBtn) return failStep("Send не знайдено або не активний.");

  if (useRef && !findComposerAttachment()) {
    return failStep("Reference зник перед Send. Send заблоковано, повторюю цей промт після reload.");
  }

  preSendDownloadSnapshot = snapshotDownloadButtons();

  if (!(await clickSendOnce(sendBtn, prompt))) return failStep("Send не натиснувся.");

  setStatus("Grok step: Send натиснуто, чекаю підтвердження від Grok...");

  const accepted = await waitForWsAcceptedOrFallback(prompt, WAIT.wsAccept);
  if (!accepted) return failStep("Grok не підтвердив правильний промт.");

  setStatus("Grok step OK: prompt прийнято. Чекаю генерацію/відсотки...");

  const generated = await waitForGenerationOrDownload(WAIT.generation, prompt);
  if (!generated) return failStep("Генерація не завершилась.");

  setStatus("Grok step OK: генерація готова. Чекаю Download...");

  const downloaded = await waitAndClickDownload(WAIT.download, prompt);
  if (!downloaded) return failStep("Download не знайдено.");

  setStatus("Grok step OK: Download виконано.");

  deactivateBlock(); // release global block — prompt cycle complete
  resetGate();
  await sleep(1200);
  return true;
}

function failStep(msg) { setStatus(msg); deactivateBlock(); resetGate(); return false; }

async function ensureImaginePage() {
  if (!location.href.includes("grok.com")) return;
  if (!location.pathname.includes("imagine")) {
    location.href = "https://grok.com/imagine";
    await sleep(10000);
  }
  await sleep(1500);
}

async function ensureMode() {
  await sleep(800);
  const texts = [...document.querySelectorAll("button,div,span,a")].filter(visible).filter(e => !e.closest("#ag4-menu"));
  const image = texts.find(e => ["image", "images", "фото", "зображення", "изображение"].includes(norm(e.innerText).toLowerCase()));
  if (image) { try { (image.closest("button") || image).click(); } catch {} await sleep(900); }
  if (mode === "video") {
    const video = [...document.querySelectorAll("button,div,span,a")].filter(visible).filter(e => !e.closest("#ag4-menu")).find(e => ["video", "відео", "видео"].includes(norm(e.innerText).toLowerCase()));
    if (video) { try { (video.closest("button") || video).click(); } catch {} await sleep(900); }
  }
}

async function ensureQuality720() {
  if (mode !== "video") return true;
  await sleep(350);

  const candidates = [...document.querySelectorAll("button,[role='button'],span,div")]
    .filter(visible)
    .filter(el => !el.closest("#ag4-menu") && norm(el.innerText) === "720p");

  if (!candidates.length) return false;

  let best = null;
  let bestScore = -999;

  for (const el of candidates) {
    const btn = el.closest("button,[role='button']") || el;
    const r = btn.getBoundingClientRect();
    let score = 0;
    if (r.bottom > window.innerHeight - 190) score += 80;
    if (r.left > window.innerWidth * 0.35) score += 20;
    const state = String(btn.getAttribute("aria-pressed") || btn.getAttribute("data-state") || btn.getAttribute("aria-selected") || btn.className || "").toLowerCase();
    if (/true|on|checked|active|selected/.test(state)) score += 50;
    if (score > bestScore) { bestScore = score; best = btn; }
  }

  if (!best) return false;

  const state = String(best.getAttribute("aria-pressed") || best.getAttribute("data-state") || best.getAttribute("aria-selected") || best.className || "").toLowerCase();
  const alreadyActive = /true|on|checked|active|selected/.test(state);

  if (!alreadyActive) {
    setStatus("Перевіряю якість: ставлю 720p...");
    try { best.click(); } catch {}
    await sleep(800);
  }

  return true;
}


async function ensureReferenceFileReady() {
  if (refFile) return true;

  if (refData && refName && refMime) {
    try {
      refFile = await dataUrlToFile(refData, refName, refMime);
      return !!refFile;
    } catch {}
  }

  return false;
}

async function uploadReferenceAndConfirm() {
  // v4.4 PLUS UPLOAD:
  // Do NOT treat the saved circular preview near Grok as a valid reference.
  // The image must be inserted through Grok's + button and then confirmed in the composer.
  if (!(await ensureReferenceFileReady())) return false;

  for (let attempt = 1; attempt <= 5; attempt++) {
    setStatus(`Reference: натискаю плюс і додаю фото (${attempt}/5)...`);

    const beforeComposerCount = countStrictComposerAttachments();
    const uploadedByInput = await uploadReferenceViaFileInput(attempt);

    if (uploadedByInput) {
      const ok = await waitReferenceVisible(beforeComposerCount, null, attempt, 22000);
      if (ok) {
        setStatus("Grok отримав reference через плюс. Йду до промта...");
        await sleep(1200);
        return true;
      }
    }

    setStatus(`Плюс/input не підтвердив thumbnail. Пробую drag/drop у composer (${attempt}/5)...`);
    const beforeDropCount = countStrictComposerAttachments();
    const uploadedByDrop = await uploadReferenceViaDrop();
    if (uploadedByDrop && await waitReferenceVisible(beforeDropCount, null, attempt, 18000)) {
      setStatus("Grok отримав reference через drop у composer. Йду до промта...");
      await sleep(1200);
      return true;
    }

    setStatus(`Reference ще не в composer. Повторюю додавання через плюс (${attempt}/5)...`);
    await sleep(1600);
  }

  setStatus("Reference не додався через плюс. Prompt і Send заблоковані, щоб не генерувати без фото.");
  return false;
}

async function uploadReferenceViaFileInput(attempt) {
  const input = await openPlusAndGetFileInput();
  if (!input) {
    setStatus("Не знайшов file input після натискання плюса.");
    return false;
  }

  try { input.value = ""; } catch {}

  const dt = new DataTransfer();
  dt.items.add(refFile);

  try {
    input.files = dt.files;
  } catch (e) {
    setStatus("File input не прийняв reference file.");
    return false;
  }

  const events = [
    new Event("input", { bubbles: true }),
    new Event("change", { bubbles: true }),
    new Event("blur", { bubbles: true })
  ];

  for (const ev of events) {
    try { input.dispatchEvent(ev); } catch {}
    await sleep(160);
  }

  setStatus(`Reference файл переданий після плюса (${attempt}/5). Чекаю thumbnail у composer...`);
  await sleep(1400);
  return true;
}

async function openPlusAndGetFileInput() {
  const before = new Set([...document.querySelectorAll('input[type="file"]')]);
  const plus = findUploadButton();

  if (plus) {
    setStatus("Натискаю саме плюс біля prompt поля...");
    await singleClick(plus);
    await sleep(1200);
  } else {
    setStatus("Плюс біля prompt поля не знайдено. Не натискаю saved-кружки, повторюю пошук...");
    return null;
  }

  const start = Date.now();
  while (Date.now() - start < 6000) {
    const all = [...document.querySelectorAll('input[type="file"]')].filter(x => !x.closest('#ag4-menu'));
    const fresh = all.find(x => !before.has(x));
    if (fresh) return fresh;

    const imageInput = all.find(x => {
      const acc = String(x.accept || "").toLowerCase();
      return acc.includes("image") || acc.includes("*") || !acc;
    });
    if (imageInput) return imageInput;

    await sleep(300);
  }

  return null;
}

async function uploadReferenceViaDrop() {
  const target = findDropTargetForReference();
  if (!target) return false;

  const dt = new DataTransfer();
  dt.items.add(refFile);

  const events = ["dragenter", "dragover", "drop"];
  for (const name of events) {
    try {
      const ev = new DragEvent(name, { bubbles: true, cancelable: true, dataTransfer: dt });
      target.dispatchEvent(ev);
      await sleep(250);
    } catch {}
  }

  return true;
}

function findDropTargetForReference() {
  const input = findInputNow();
  if (input) return input.closest("form, div") || input;

  const plus = findUploadButton();
  if (plus) return plus.closest("form, div") || plus;

  return document.body;
}

async function waitReferenceVisible(beforeCount, fileInput, attempt, customTimeout) {
  const start = Date.now();
  const timeout = customTimeout || WAIT.reference;

  while (Date.now() - start < timeout) {
    await waitIfPaused();

    const preview = findComposerAttachmentStrict();
    if (preview) return true;

    const now = countStrictComposerAttachments();
    if (now > beforeCount) return true;

    setStatus(`Чекаю reference thumbnail саме в composer (${attempt}/5)...`);
    await sleep(650);
  }

  return false;
}

async function getFileInputForUpload(forceClick = false) {
  let inp = findUsableFileInput();

  if (forceClick || !inp) {
    const btn = uploadSig ? findBySignature(uploadSig, "upload") : findUploadButton();
    if (btn) {
      setStatus("Натискаю Upload / плюс для reference...");
      await singleClick(btn);
      await sleep(1600);
    }
  }

  inp = findUsableFileInput() || inp;
  return inp || null;
}

function findUsableFileInput() {
  return [...document.querySelectorAll('input[type="file"]')].find(x => !x.closest("#ag4-menu")) || null;
}

function countReferencePreviews() {
  return countStrictComposerAttachments();
}

function countStrictComposerAttachments() {
  return [...document.querySelectorAll("img, video, canvas, [style*='background-image']")]
    .filter(el => isStrictComposerAttachment(el, findInputNow())).length;
}

function findComposerAttachment() {
  return findComposerAttachmentStrict();
}

function findComposerAttachmentStrict() {
  const input = findInputNow();
  const items = [...document.querySelectorAll("img, video, canvas, [style*='background-image']")]
    .filter(el => isStrictComposerAttachment(el, input));

  items.sort((a, b) => {
    const ar = a.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    return distanceToInput(ar, input) - distanceToInput(br, input);
  });

  return items[0] || null;
}

function distanceToInput(rect, input) {
  if (!input) return 999999;
  const ir = input.getBoundingClientRect();
  const cx = (rect.left + rect.right) / 2;
  const cy = (rect.top + rect.bottom) / 2;
  const ix = (ir.left + ir.right) / 2;
  const iy = (ir.top + ir.bottom) / 2;
  return Math.abs(cx - ix) + Math.abs(cy - iy);
}

function isLikelyReferencePreview(el, input) {
  return isStrictComposerAttachment(el, input);
}

function isStrictComposerAttachment(el, input) {
  if (!el || el.closest?.("#ag4-menu") || el.closest?.("#ag4-admin-popup")) return false;
  if (!visible(el)) return false;

  const r = el.getBoundingClientRect();
  if (!r || r.width < 12 || r.height < 12) return false;
  if (r.width > 180 || r.height > 180) return false;

  const inputRect = input ? input.getBoundingClientRect() : null;
  if (!inputRect) return false;

  const cy = (r.top + r.bottom) / 2;
  const cx = (r.left + r.right) / 2;
  const inputCy = (inputRect.top + inputRect.bottom) / 2;

  // Must be in the same composer band as the text input, not in Grok's saved/history circle.
  const sameVerticalBand = Math.abs(cy - inputCy) < 95;
  const nearComposerBottom = r.bottom > window.innerHeight - 210 && r.top > window.innerHeight - 340;

  // Thumbnail inserted through + normally appears immediately around the left side of the prompt input.
  // Saved/history circles are usually farther left or outside the composer container.
  const closeToInputLeft = r.right >= inputRect.left - 85 && r.left <= inputRect.left + 95;
  const insideInputBand = cx >= inputRect.left - 95 && cx <= inputRect.right + 35;

  if (sameVerticalBand && nearComposerBottom && (closeToInputLeft || insideInputBand)) return true;

  // Structural fallback: same nearby form/container as prompt input.
  const root = findComposerRoot(input);
  if (root && root.contains(el) && sameVerticalBand && r.right >= inputRect.left - 140) return true;

  return false;
}

function findComposerRoot(input) {
  if (!input) return null;
  let node = input;
  for (let i = 0; i < 8 && node; i++) {
    const r = node.getBoundingClientRect?.();
    if (r && r.width > 260 && r.height < 220 && r.bottom > window.innerHeight - 260) return node;
    node = node.parentElement;
  }
  return input.closest("form") || input.parentElement;
}

function findAnyBottomComposerImage() {
  return !!findComposerAttachmentStrict();
}

async function waitForInput(timeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    wake();
    const input = findInputNow();
    if (input) return input;
    setStatus("Чекаю поле промта...");
    await sleep(700);
  }
  return null;
}

function findInputNow() {
  const els = [
    ...document.querySelectorAll("textarea"),
    ...document.querySelectorAll('[contenteditable="true"]'),
    ...document.querySelectorAll('[role="textbox"]'),
    ...document.querySelectorAll(".ProseMirror")
  ].filter(el => {
    if (!visible(el)) return false;
    if (el.closest("#ag4-menu")) return false;
    const r = el.getBoundingClientRect();
    const txt = getInputText(el);
    return r.width > 220 && r.height > 20 && r.bottom > window.innerHeight * 0.45 && txt.length < 20000;
  });
  els.sort((a,b)=>scoreInput(a)-scoreInput(b));
  return els[els.length-1] || null;
}

function scoreInput(el) {
  const r = el.getBoundingClientRect();
  let s = 0;
  if (el.tagName === "TEXTAREA") s += 80;
  if (el.getAttribute("contenteditable") === "true") s += 55;
  if (el.getAttribute("role") === "textbox") s += 45;
  if (el.classList.contains("ProseMirror")) s += 45;
  if (r.bottom > window.innerHeight - 230) s += 45;
  if (r.width > 420) s += 20;
  return s;
}

async function insertAndConfirmPrompt(input, prompt) {
  for (let i = 1; i <= 7; i++) {
    setStatus(`Вставляю промт. Спроба ${i}/7...`);
    await clearInput(input);
    await sleep(300);
    await insertText(input, prompt);
    const ok = await waitPromptInSameInput(input, prompt, 4500);
    if (ok) {
      const stable = await promptStable(input, prompt, 3);
      if (stable) return true;
    }
    await sleep(800);
  }
  return false;
}

async function clearInput(input) {
  input.focus();
  if (input.tagName === "TEXTAREA" || input.tagName === "INPUT") {
    setNativeValue(input, "");
  } else {
    input.textContent = "";
    input.innerHTML = "";
  }
  fireInput(input);
}

async function insertText(input, text) {
  input.scrollIntoView({ block: "center", inline: "center" });
  input.focus();
  try { input.click(); } catch {}
  await sleep(150);
  if (input.tagName === "TEXTAREA" || input.tagName === "INPUT") {
    setNativeValue(input, text);
  } else {
    input.textContent = text;
  }
  fireInput(input);
  await sleep(700);
}

function setNativeValue(el, value) {
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const d = Object.getOwnPropertyDescriptor(proto, "value");
  if (d?.set) d.set.call(el, value); else el.value = value;
}

function fireInput(el) {
  try { el.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText" })); } catch {}
  try { el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" })); } catch {}
  try { el.dispatchEvent(new Event("input", { bubbles: true })); } catch {}
  try { el.dispatchEvent(new Event("change", { bubbles: true })); } catch {}
}

async function waitPromptInSameInput(input, prompt, timeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const expected = norm(prompt).slice(0, 90);
    if (norm(getInputText(input)).includes(expected)) return true;
    await sleep(300);
  }
  return false;
}

async function promptStable(input, prompt, times) {
  for (let i = 0; i < times; i++) {
    if (!(await waitPromptInSameInput(input, prompt, 800))) return false;
    await sleep(650);
  }
  return true;
}

async function waitForSendButton(input, prompt, timeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    wake();
    if (!(await waitPromptInSameInput(input, prompt, 500))) return null;
    const b = sendSig ? findBySignature(sendSig, "send") : findSendButton(input);
    if (b && buttonUsable(b)) return b;
    setStatus("Промт є. Чекаю активний Send...");
    await sleep(700);
  }
  return null;
}

async function clickSendOnce(btn, prompt) {
  if (!btn || !buttonUsable(btn)) return false;

  // ВАЖЛИВО: для Send використовуємо тільки один native click.
  // PointerDown + MouseDown + Click для Grok інколи запускає 2 генерації.
  const input = findInputNow();
  if (!input || !(await promptStable(input, prompt, 3))) return false;

  const expected = norm(prompt).slice(0, 90);
  if (!norm(getInputText(input)).includes(expected)) {
    setStatus("Перед Send промта вже немає в полі. Не натискаю.");
    return false;
  }

  if (Date.now() - sendClickedAt < 20000) {
    setStatus("Send cooldown активний. Другий Send заблоковано.");
    return false;
  }

  setStatus("Перед Send: роблю фінальну людську паузу і перевірку prompt...");
  await sleep(1600);
  const finalInput = findInputNow();
  if (!finalInput || !norm(getInputText(finalInput)).includes(expected)) {
    setStatus("Перед самим Send prompt мигнув/зник. Не клікаю, повторюю крок.");
    return false;
  }

  setStatus("Натискаю Send рівно один раз native-click...");
  sendClickedAt = Date.now();

  try { btn.scrollIntoView({ block: "center", inline: "center" }); } catch {}
  await sleep(250);
  try { btn.focus(); } catch {}
  await sleep(120);
  try { btn.click(); } catch { return false; }
  blockSendClicksTemporarily(45000);

  await sleep(5500);
  return true;
}

async function waitForWsAcceptedOrFallback(prompt, timeout) {
  const start = Date.now();
  let hiddenWithoutProofSince = 0;
  let mismatchSince = 0;
  let stillInInputSince = 0;
  const expected = norm(prompt).slice(0, 90);
  const key = firstWordsKey(prompt, 9);

  while (Date.now() - start < timeout) {
    const echo = findLatestPromptEcho();
    const input = findInputNow();
    const stillHasPrompt = input && norm(getInputText(input)).includes(expected);
    const hasGenerationSignal = ws.started || ws.percent > 0 || ws.finished || !!findNewDownloadButton();

    if (echo && echoMatchesPrompt(echo.text, prompt)) {
      promptEchoConfirmedAt = Date.now();
      promptEchoText = echo.text;
      setStatus("Grok step OK: echo підтвердив prompt. Чекаю генерацію...");
      setWs("echo OK: " + key);
      return true;
    }

    if (outgoingPromptMatches(prompt)) {
      ws.accepted = true;
      promptEchoConfirmedAt = promptEchoConfirmedAt || Date.now();
      setStatus("Grok step OK: WebSocket прийняв правильний prompt. Далі слухаю Grok.");
      setWs("WS outgoing OK");
      return true;
    }

    if (ws.accepted) {
      setWs("Grok accepted");
      return true;
    }

    if (ws.blocked && ws.blockedReason !== "duplicate-send" && ws.blockedReason !== "instant-duplicate-send") {
      setStatus("Grok заблокував пустий/не той prompt. Повторюю цей самий prompt.");
      await emergencyResetBadSend("ws-blocked-" + ws.blockedReason);
      return false;
    }

    if (hasGenerationSignal && !outgoingPromptMatches(prompt) && !promptEchoConfirmedAt) {
      // Якщо генерація стартувала, але ми ні разу не бачили правильний outgoing/echo,
      // не ризикуємо качати пусте або чуже відео.
      if (!hiddenWithoutProofSince) hiddenWithoutProofSince = Date.now();
      setStatus("Генерація стартувала, але Grok не підтвердив prompt. Чекаю коротко...");
      if (Date.now() - hiddenWithoutProofSince > 8500) {
        await emergencyResetBadSend("generation-started-without-prompt-proof");
        return false;
      }
    }

    if (echo && echo.looksLikeUserPrompt && !echoMatchesPrompt(echo.text, prompt)) {
      if (!mismatchSince) mismatchSince = Date.now();
      setStatus("Бачу інший prompt. Чекаю, чи Grok переключиться на правильний...");
      if (Date.now() - mismatchSince > 6000 && !outgoingPromptMatches(prompt) && !ws.accepted) {
        await emergencyResetBadSend("visible-prompt-mismatch-before-accept");
        return false;
      }
    } else {
      mismatchSince = 0;
    }

    if (stillHasPrompt) {
      if (!stillInInputSince) stillInInputSince = Date.now();
      hiddenWithoutProofSince = 0;
      setStatus("Prompt ще в полі. Чекаю, поки Grok прийме його після Send...");
      // Якщо після Send prompt досі в полі дуже довго, значить клік міг не пройти.
      // Не клікаємо другий раз, щоб не створити дубль, а робимо чистий retry через reload.
      if (Date.now() - stillInInputSince > 18000 && !hasGenerationSignal && !outgoingPromptMatches(prompt)) {
        await emergencyResetBadSend("send-did-not-leave-composer");
        return false;
      }
    } else {
      stillInInputSince = 0;
      if (!hiddenWithoutProofSince) hiddenWithoutProofSince = Date.now();
      setStatus("Prompt зник з поля. Чекаю підтвердження Grok, не вважаю це успіхом без WS/echo...");

      // Prompt може сховатися на 2–3 секунди навіть при нормальному старті.
      // Але якщо за 14 секунд немає WS/outgoing/echo/progress — це не нормальний старт.
      if (Date.now() - hiddenWithoutProofSince > 14000 && !hasGenerationSignal && !outgoingPromptMatches(prompt) && !promptEchoConfirmedAt) {
        await emergencyResetBadSend("prompt-hidden-without-grok-proof");
        return false;
      }
    }

    await sleep(500);
  }

  if (ws.accepted || outgoingPromptMatches(prompt) || promptEchoConfirmedAt > 0) {
    setStatus("Grok підтвердив prompt із затримкою. Продовжую чекати результат.");
    return true;
  }

  const echo = findLatestPromptEcho();
  if (echo && echoMatchesPrompt(echo.text, prompt)) {
    promptEchoConfirmedAt = Date.now();
    promptEchoText = echo.text;
    setStatus("Prompt echo підтвердився в кінці очікування. Продовжую.");
    return true;
  }

  await emergencyResetBadSend("no-grok-confirmation-after-send");
  return false;
}

function firstWordsKey(text, count = 9) {
  return norm(text)
    .toLowerCase()
    .replace(/[“”"'`.,!?;:()\[\]{}]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, count)
    .join(" ");
}

function echoMatchesPrompt(echoText, prompt) {
  const a = firstWordsKey(echoText, 9);
  const b = firstWordsKey(prompt, 9);
  if (!a || !b) return false;
  if (a === b) return true;
  // allow tiny truncation/ellipsis differences in Grok's visible bubble
  return a.includes(b.slice(0, Math.min(45, b.length))) || b.includes(a.slice(0, Math.min(45, a.length)));
}

function outgoingPromptMatches(prompt) {
  return !!(ws.outgoingPrompt && echoMatchesPrompt(ws.outgoingPrompt, prompt));
}

function promptConfirmedByGrok(prompt) {
  return !!(ws.accepted || outgoingPromptMatches(prompt) || promptEchoConfirmedAt > 0);
}

function findLatestPromptEcho() {
  const input = findInputNow();
  const inputRect = input ? input.getBoundingClientRect() : null;
  const candidates = [...document.querySelectorAll("div, span, p")]
    .filter(el => {
      if (!visible(el)) return false;
      if (el.closest("#ag4-menu")) return false;
      if (input && (el === input || input.contains(el))) return false;
      const t = norm(el.innerText || el.textContent || "");
      if (t.length < 18 || t.length > 900) return false;
      const r = el.getBoundingClientRect();
      // User prompt echo is usually just above / near composer bottom area.
      if (r.bottom < window.innerHeight * 0.45) return false;
      if (inputRect && Math.abs(r.bottom - inputRect.top) > 260 && Math.abs(r.top - inputRect.top) > 260) return false;
      // avoid giant containers that include too much unrelated text
      if (r.width > window.innerWidth * 0.95 && t.length > 250) return false;
      return true;
    })
    .map(el => {
      const r = el.getBoundingClientRect();
      const text = norm(el.innerText || el.textContent || "");
      let score = 0;
      if (inputRect) {
        const dy = Math.abs(r.bottom - inputRect.top);
        score += Math.max(0, 260 - dy);
      }
      if (r.right > window.innerWidth * 0.45) score += 40;
      if (r.bottom > window.innerHeight * 0.65) score += 45;
      if (text.includes("...")) score += 10;
      return { el, text, rect: r, score, looksLikeUserPrompt: true };
    })
    .sort((a, b) => b.score - a.score);

  return candidates[0] || null;
}

async function emergencyResetBadSend(reason) {
  // Не натискаємо Download і не переходимо до наступного prompt.
  // Просто чистимо gate та дозволяємо головному циклу reload + повтор цього ж prompt.
  try { resetGate(); } catch {}
  setText("ag4-protect", "self-heal: " + reason);
  await sleep(1200);
}

async function waitForGenerationOrDownload(timeout, prompt) {
  const start = Date.now();
  const minFallbackMs = mode === "video" ? 70000 : 25000;
  let lastGoodEchoAt = promptEchoConfirmedAt || Date.now();
  let badEchoSince = 0;
  let missingEchoSince = 0;
  let lastStatusAt = 0;
  const ignoreEchoUntil = (sendClickedAt || start) + POST_SEND_IGNORE_ECHO_MS;

  while (Date.now() - start < timeout) {
    await waitIfPaused();

    if (ws.blocked && ws.blockedReason !== "duplicate-send" && ws.blockedReason !== "instant-duplicate-send") {
      setStatus("WebSocket заблокував неправильний/пустий prompt. Повторюю цей самий prompt.");
      return false;
    }

    const now = Date.now();
    const acceptedByWsOrEcho = promptConfirmedByGrok(prompt);
    const realGenerationSignal = ws.started || ws.percent > 0 || ws.finished || findNewDownloadButton();
    const echo = findLatestPromptEcho();
    const echoOk = echo && echoMatchesPrompt(echo.text, prompt);
    const echoBad = echo && echo.looksLikeUserPrompt && !echoOk;

    if (echoOk) {
      lastGoodEchoAt = now;
      promptEchoConfirmedAt = now;
      promptEchoText = echo.text;
      badEchoSince = 0;
      missingEchoSince = 0;
      setText("ag4-protect", "prompt visible OK");
    }

    // v6.0 HUMAN-GROK:
    // після accept головне — Grok signals. Але без accept не качаємо і не рахуємо generation нормальним.
    if (acceptedByWsOrEcho && realGenerationSignal) {
      if (ws.percent > 0) setText("ag4-protect", "Grok trusted: " + ws.percent + "%");
      else setText("ag4-protect", "Grok trusted generation");
    }

    if (!acceptedByWsOrEcho && realGenerationSignal && now > ignoreEchoUntil) {
      if (!badEchoSince) badEchoSince = now;
      setStatus("Є сигнал генерації, але правильний prompt не підтверджено. Не ризикуємо...");
      if (now - badEchoSince > 9000) {
        await emergencyResetBadSend("generation-without-confirmed-prompt-v6");
        return false;
      }
    }

    if (!acceptedByWsOrEcho && !realGenerationSignal && now > ignoreEchoUntil) {
      if (echoBad) {
        if (!badEchoSince) badEchoSince = now;
        if (now - badEchoSince > 4500) {
          setStatus("Бачу інший prompt до старту генерації. Reload і повторюю цей самий prompt.");
          await emergencyResetBadSend("prompt-echo-mismatch-before-start");
          return false;
        }
      } else if (!echoOk) {
        if (!missingEchoSince) missingEchoSince = now;
        if (now - missingEchoSince > 14000) {
          setStatus("Prompt не підтверджений і генерація не стартувала. Reload і повторюю цей самий prompt.");
          await emergencyResetBadSend("prompt-missing-before-start");
          return false;
        }
      }
    }

    if (ws.finished || ws.percent >= 100) {
      setStatus("Grok показав 100%. Тепер чекаю Download...");
      return true;
    }

    const dl = findNewDownloadButton();
    const elapsedSinceSend = sendClickedAt ? now - sendClickedAt : now - start;

    if (dl && buttonUsable(dl) && elapsedSinceSend > minFallbackMs && ws.percent <= 0) {
      if (acceptedByWsOrEcho || ws.started || ws.percent > 0 || now - lastGoodEchoAt < 30000) {
        setStatus("WebSocket мовчить, але Download зʼявився після підтвердженого prompt.");
        return true;
      }
      setStatus("Download є, але prompt не був підтверджений. Не скачую, повторюю prompt.");
      return false;
    }

    if (now - lastStatusAt > 1200) {
      if (ws.percent > 0) setStatus(`Відео генерується: ${ws.percent}%`);
      else if (ws.started) setStatus("Генерація стартувала. Чекаю прогрес/Download...");
      else if (now < ignoreEchoUntil) setStatus("Після Send даю Grok час сховати/показати prompt...");
      else setStatus("Чекаю старт генерації...");
      lastStatusAt = now;
    }

    await sleep(650);
  }
  return false;
}

async function waitAndClickDownload(timeout, prompt) {
  const start = Date.now();
  let firstSeen = 0;
  let chosen = null;
  let clickedAt = 0;
  let wrongEchoSince = 0;
  let noEchoSince = 0;
  let safeEchoSeenAt = promptEchoConfirmedAt || 0;

  while (Date.now() - start < timeout) {
    await waitIfPaused();

    if (downloadClickedForThisPrompt) {
      setStatus("Download уже був натиснутий для цього prompt. Не дублюю.");
      return true;
    }

    const context = getPromptContextForDownload(prompt);

    if (context.ok) {
      safeEchoSeenAt = Date.now();
      wrongEchoSince = 0;
      noEchoSince = 0;
      setText("ag4-protect", "download context OK");
    } else if (context.wrong) {
      if (!wrongEchoSince) wrongEchoSince = Date.now();
      firstSeen = 0;
      chosen = null;

      setStatus("Бачу інший prompt біля результату. Download заблоковано, чекаю правильний результат...");
      setText("ag4-protect", "wrong echo before download");

      if (Date.now() - wrongEchoSince > DOWNLOAD_PROMPT_CONTEXT_GRACE_MS) {
        // Якщо WebSocket точно підтвердив цей prompt і Grok показав 100%,
        // не робимо миттєвий reset через кривий UI echo — просто чекаємо ще трохи,
        // щоб Grok переключився на правильний результат.
        if (promptConfirmedByGrok(prompt) && (ws.finished || ws.percent >= 100)) {
          setStatus("Grok підтвердив правильний prompt, але UI показує інший echo. Чекаю правильний Download-контекст...");
          wrongEchoSince = Date.now() - Math.floor(DOWNLOAD_PROMPT_CONTEXT_GRACE_MS / 2);
        } else {
          setStatus("Перед Download активний не той prompt. Reload і повторюю цей самий prompt, щоб не скачати неправильне відео.");
          await emergencyResetBadSend("wrong-prompt-before-download");
          return false;
        }
      }
    } else {
      if (!noEchoSince) noEchoSince = Date.now();
      wrongEchoSince = 0;

      // Якщо Grok/WebSocket уже підтвердив prompt, відсутність visible echo не блокує назавжди:
      // Grok інколи ховає prompt або перекидає UI. Даємо коротку паузу і потім дозволяємо Download.
      if (promptConfirmedByGrok(prompt) && Date.now() - noEchoSince > DOWNLOAD_NO_ECHO_SAFE_DELAY_MS) {
        setText("ag4-protect", "WS trusted, echo hidden");
      } else {
        firstSeen = 0;
        chosen = null;
        setStatus("Download майже готовий, але ще перевіряю що це правильний prompt...");
        await sleep(800);
        continue;
      }
    }

    const b = downloadSig ? findBySignature(downloadSig, "download") : findNewDownloadButton();

    if (b && buttonUsable(b)) {
      if (!firstSeen || chosen !== b) {
        firstSeen = Date.now();
        chosen = b;
        setStatus("Download знайдено. Перевіряю стабільність і правильний prompt...");
      }

      // Не качаємо миттєво: якщо Grok переключається між 2 генераціями, echo за ці секунди встигне показати mismatch.
      if (Date.now() - firstSeen > 6500) {
        const finalContext = getPromptContextForDownload(prompt);
        if (finalContext.wrong) {
          if (promptConfirmedByGrok(prompt) && (ws.finished || ws.percent >= 100)) {
            setStatus("Final check: UI echo інший, але Grok підтвердив правильний prompt і 100%. Чекаю ще 3 сек і перевіряю кнопку...");
            await sleep(3000);
            const retryContext = getPromptContextForDownload(prompt);
            if (retryContext.wrong && !retryContext.ok) {
              setStatus("Все ще бачу інший prompt перед Download. Не скачую, повторюю цей prompt.");
              await emergencyResetBadSend("final-wrong-prompt-before-download");
              return false;
            }
          } else {
            setStatus("Перед самим Download бачу не той prompt. Не скачую. Повторюю цей prompt.");
            await emergencyResetBadSend("final-wrong-prompt-before-download");
            return false;
          }
        }

        if (!finalContext.ok && !promptConfirmedByGrok(prompt)) {
          setStatus("Download є, але правильний prompt не підтверджено. Не скачую.");
          await emergencyResetBadSend("download-without-prompt-context");
          return false;
        }

        downloadClickedForThisPrompt = true;
        setStatus("Скачую тільки підтверджений asset. Повторний download заблокований...");
        clickedAt = Date.now();
        await singleClick(chosen || b);

        const done = await waitForBrowserDownloadComplete(clickedAt, DOWNLOAD_COMPLETE_WAIT_MS);
        if (done) {
          setStatus("Браузер підтвердив: файл скачано. Одразу йду далі.");
          await sleep(900);
          return true;
        }

        // Навіть якщо Chrome API не дав підтвердження, НЕ тиснемо Download вдруге.
        setStatus("Download натиснуто. Підтвердження браузера немає, але дубль не роблю — йду далі.");
        await sleep(2500);
        return true;
      }
    } else {
      firstSeen = 0;
      chosen = null;
      setStatus("Чекаю кнопку Download після 100%...");
    }

    await sleep(900);
  }
  return false;
}

function getPromptContextForDownload(prompt) {
  const echo = findLatestPromptEcho();
  if (echo && echoMatchesPrompt(echo.text, prompt)) {
    promptEchoConfirmedAt = Date.now();
    promptEchoText = echo.text;
    return { ok: true, wrong: false, missing: false, text: echo.text };
  }

  if (echo && echo.looksLikeUserPrompt && !echoMatchesPrompt(echo.text, prompt)) {
    return { ok: false, wrong: true, missing: false, text: echo.text };
  }

  if (promptConfirmedByGrok(prompt)) {
    return { ok: false, wrong: false, missing: true, trustedByWs: true, text: "" };
  }

  return { ok: false, wrong: false, missing: true, trustedByWs: false, text: "" };
}

function waitForBrowserDownloadComplete(sinceMs, timeoutMs) {
  return new Promise((resolve) => {
    try {
      if (!chrome?.runtime?.sendMessage) return resolve(false);
      chrome.runtime.sendMessage({
        source: "autogrok",
        to: "background",
        type: "waitForRecentDownloadComplete",
        since: sinceMs,
        timeout: timeoutMs
      }, (res) => {
        if (chrome.runtime.lastError) return resolve(false);
        resolve(!!res?.ok);
      });
    } catch {
      resolve(false);
    }
  });
}



function blockSendClicksTemporarily(ms = 15000) {
  const until = Date.now() + ms;
  const handler = (e) => {
    if (Date.now() > until) {
      document.removeEventListener("click", handler, true);
      return;
    }
    const btn = e.target?.closest?.("button,a");
    if (!btn) return;
    if (btn.closest("#ag4-menu")) return;
    const input = findInputNow();
    const maybeSend = input && findSendButton(input) === btn;
    if (maybeSend) {
      e.preventDefault();
      e.stopImmediatePropagation();
      setStatus("Другий Send заблоковано після кліку.");
    }
  };
  document.addEventListener("click", handler, true);
  setTimeout(() => document.removeEventListener("click", handler, true), ms + 500);
}

function findSendButton(input) {
  const r = input?.getBoundingClientRect();
  const composer = nearestComposer(input);
  const cr = composer?.getBoundingClientRect?.();
  const buttons = allButtons().filter(b => !isQualityOrOptionButton(b));
  let best = null, bestScore = -999;

  for (const b of buttons) {
    const br = b.getBoundingClientRect();
    const label = buttonLabel(b);
    let s = 0;

    if (/send|submit|arrow|відправ|отправ|надсил/.test(label)) s += 95;
    if (/download|upload|attach|add|plus|image|video|720|480|6s|10s|agent|beta|model|скач|завантаж|прикр|изображ|зображ/.test(label)) s -= 160;

    if (r) {
      const cy = (br.top + br.bottom) / 2;
      const iy = (r.top + r.bottom) / 2;
      if (Math.abs(cy - iy) < 90) s += 70;
      if (br.left > r.left + r.width * 0.72) s += 90;
      if (br.right > r.right - 90) s += 65;
      if (br.left < r.left + 120) s -= 130;
    }

    if (cr) {
      if (br.left >= cr.left && br.right <= cr.right && br.top >= cr.top && br.bottom <= cr.bottom + 30) s += 40;
      if (br.right > cr.right - 90) s += 55;
    }

    if (br.width >= 28 && br.width <= 64 && br.height >= 28 && br.height <= 64) s += 30;
    if (!norm(b.innerText)) s += 20;
    if (b.querySelector("svg")) s += 15;

    if (s > bestScore) { bestScore = s; best = b; }
  }

  return bestScore >= 85 ? best : null;
}

function isQualityOrOptionButton(b) {
  const label = buttonLabel(b);
  const txt = norm(b.innerText).toLowerCase();
  return /720|480|6s|10s|16:9|agent|beta|video|image|модель|качество|quality/.test(label) || ["720p","480p","6s","10s","16:9"].includes(txt);
}

function findUploadButton() {
  const input = findInputNow();
  const r = input?.getBoundingClientRect();
  let best = null, bestScore = -999;

  for (const b of allButtons()) {
    const br = b.getBoundingClientRect();
    const label = buttonLabel(b);
    const txt = norm(b.innerText || "");

    // IMPORTANT v4.7:
    // Never click Grok saved/history image circles. Those buttons contain an img/canvas/video
    // or a background-image thumbnail. Reference must be added only through the real + button
    // inside the bottom composer.
    if (isSavedOrHistoryImageButton(b, input)) continue;

    let s = 0;

    const looksLikeRealPlus = txt === "+" || label === "+" || label.includes("+");
    const hasUploadWords = /upload|attach|add|plus|прикр|дод|image|file|файл|зображ|изображ/.test(label);

    if (looksLikeRealPlus) s += 130;
    if (hasUploadWords) s += 80;

    // SVG alone is NOT enough anymore, because the saved image circle can also be icon-like.
    if (b.querySelector("svg") && (looksLikeRealPlus || hasUploadWords)) s += 20;

    if (/download|send|submit|720|480|video|agent|beta|model|скач|завантаж/.test(label)) s -= 120;

    if (r) {
      const cy = (br.top + br.bottom) / 2;
      const iy = (r.top + r.bottom) / 2;
      const sameLine = Math.abs(cy - iy) < 70;

      // The real + is in the composer: close to the left edge of the text input,
      // not the saved/history image circle farther left.
      const composerLeftZone = br.left >= r.left - 72 && br.right <= r.left + 72;
      const tooFarLeft = br.right < r.left - 90;
      const sendSide = br.left > r.right - 95;

      if (sameLine) s += 75;
      if (composerLeftZone) s += 150;
      if (tooFarLeft) s -= 260;
      if (sendSide) s -= 160;
    }

    if (br.width >= 24 && br.width <= 62 && br.height >= 24 && br.height <= 62) s += 40;
    if (br.bottom > window.innerHeight - 175) s += 45;
    if (!txt && !hasUploadWords && !looksLikeRealPlus) s -= 60;

    if (s > bestScore) { bestScore = s; best = b; }
  }

  if (best) {
    try {
      const br = best.getBoundingClientRect();
      console.log("[AutoGrok] selected plus/upload button", { score: bestScore, text: best.innerText, aria: best.getAttribute("aria-label"), rect: { left: br.left, top: br.top, width: br.width, height: br.height } });
    } catch {}
  }

  return bestScore >= 110 ? best : null;
}

function isSavedOrHistoryImageButton(btn, input) {
  if (!btn || btn.closest?.("#ag4-menu") || btn.closest?.("#ag4-admin-popup")) return true;

  const br = btn.getBoundingClientRect();
  const ir = input?.getBoundingClientRect?.();

  const hasMedia = !!btn.querySelector?.("img, video, canvas, picture");
  let hasBgImage = false;
  try {
    const bg = getComputedStyle(btn).backgroundImage || "";
    hasBgImage = bg && bg !== "none" && bg.includes("url(");
  } catch {}

  // saved/history buttons are circular thumbnails and usually sit left of the real plus
  const circular = Math.abs(br.width - br.height) < 12 && br.width >= 26 && br.width <= 70;
  const label = buttonLabel(btn);
  const txt = norm(btn.innerText || "");
  const looksLikePlus = txt === "+" || label === "+" || label.includes("+") || /upload|attach|add|plus|прикр|дод/.test(label);

  if ((hasMedia || hasBgImage) && !looksLikePlus) return true;

  if (ir) {
    const sameLine = Math.abs(((br.top + br.bottom) / 2) - ((ir.top + ir.bottom) / 2)) < 85;
    const tooFarLeft = br.right < ir.left - 90;
    if (sameLine && tooFarLeft && circular) return true;
  }

  return false;
}
function snapshotDownloadButtons() {
  const set = new Set();
  for (const b of allButtons()) {
    const label = buttonLabel(b);
    if (/download|save|скач|завантаж/.test(label)) {
      set.add(downloadButtonKey(b));
    }
  }
  return set;
}

function downloadButtonKey(b) {
  const r = b.getBoundingClientRect();
  return [buttonLabel(b), Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join("|");
}

function findNewDownloadButton() {
  const b = findDownloadButton();
  if (!b) return null;
  const key = downloadButtonKey(b);
  if (preSendDownloadSnapshot && preSendDownloadSnapshot.has(key) && (!ws.finished && ws.percent < 100)) return null;
  return b;
}

function findDownloadButton() {
  let best = null, bestScore = -999;
  for (const b of allButtons()) {
    const br = b.getBoundingClientRect();
    const label = buttonLabel(b);
    let s = 0;
    if (label.match(/download|save|скач|завантаж/)) s += 100;
    if (label.match(/send|submit|upload|attach|add|plus|720|480|video|image/)) s -= 60;
    if (br.right > window.innerWidth * .55) s += 10;
    if (br.top > 60 && br.bottom < window.innerHeight - 40) s += 10;
    if (br.width >= 24 && br.width <= 75 && br.height >= 24 && br.height <= 75) s += 15;
    if (s > bestScore) { bestScore = s; best = b; }
  }
  return bestScore >= 40 ? best : null;
}

function allButtons() {
  return [...document.querySelectorAll("button,a,[role='button']")].filter(b => visible(b) && !b.closest("#ag4-menu") && b.id !== "ag4-float");
}

function buttonLabel(b) {
  return norm([b.innerText, b.getAttribute("aria-label"), b.title, b.getAttribute("data-testid"), b.className].join(" ")).toLowerCase();
}

function buttonUsable(b) {
  if (!visible(b)) return false;
  if (b.disabled || b.getAttribute("disabled") !== null || b.getAttribute("aria-disabled") === "true") return false;
  const cs = getComputedStyle(b);
  if (cs.pointerEvents === "none") return false;
  if (parseFloat(cs.opacity || "1") < .45) return false;
  return true;
}

async function singleClick(el) {
  el.scrollIntoView({ block: "center", inline: "center" });
  await sleep(250);
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  try { el.focus(); } catch {}
  await sleep(120);
  el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true }));
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: x, clientY: y }));
  el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true }));
  el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: x, clientY: y }));
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: x, clientY: y }));
  await sleep(700);
}

function setGate(prompt, hashValue) {
  window.dispatchEvent(new CustomEvent("autogrok:v4-gate-set", { detail: { expected: prompt, hash: hashValue } }));
  setText("ag4-protect", "очікую правильний промт");
}

function resetGate() {
  window.dispatchEvent(new CustomEvent("autogrok:v4-gate-reset"));
  setText("ag4-protect", "активний");
}

// ── GLOBAL BLOCK HELPERS ─────────────────────────────────────────────────────
// activateBlock: tells the bridge to block ALL WS sends until a matching gate
// is set. Call this at the start of every prompt cycle so that Grok cannot
// auto-send a stale/empty prompt while AutoGrok is preparing the next one.
function activateBlock() {
  globalBlockActive = true;
  window.dispatchEvent(new CustomEvent("autogrok:v4-global-block-on"));
  setText("ag4-protect", "global block ON");
}

// deactivateBlock: releases the global block and resets gate state in the bridge.
// Call this after a successful download or on any error/stop.
function deactivateBlock() {
  globalBlockActive = false;
  window.dispatchEvent(new CustomEvent("autogrok:v4-global-block-off"));
  setText("ag4-protect", "активний");
}
// ─────────────────────────────────────────────────────────────────────────────

function resetWsState() {
  ws = { outgoingPrompt: "", accepted: false, blocked: false, blockedReason: "", started: false, finished: false, percent: 0, requestId: "", lastEventAt: 0 };
  setWs("очікує");
}

function nearestComposer(input) {
  let node = input;
  for (let i = 0; i < 6 && node; i++, node = node.parentElement) {
    const r = node.getBoundingClientRect?.();
    if (r && r.width > 300 && r.height > 70 && r.bottom > window.innerHeight * .45) return node;
  }
  return input.parentElement || document.body;
}

function getInputText(input) {
  if (!input) return "";
  if (input.tagName === "TEXTAREA" || input.tagName === "INPUT") return input.value || "";
  return input.innerText || input.textContent || "";
}

function wake() {
  try { window.focus(); } catch {}
  try { document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 220, clientY: 220 })); } catch {}
}

async function waitIfPaused() {
  while (paused && !stopped) await sleep(500);
}

function chooseRef() {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = "image/*";
  inp.onchange = () => {
    const f = inp.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = async () => {
      refFile = f;
      refData = reader.result;
      refName = f.name;
      refMime = f.type || "image/png";
      await saveState();
      setText("ag4-ref-status", refName);
      setStatus("Reference image вибрано.");
    };
    reader.readAsDataURL(f);
  };
  inp.click();
}

async function clearAll() {
  promptsText = ""; queue = []; index = 0; refFile = null; refData = null; refName = null; refMime = null; useRef = false; runningWanted = false;
  const t = document.getElementById("ag4-prompts"); if (t) t.value = "";
  const c = document.getElementById("ag4-use-ref"); if (c) c.checked = false;
  setText("ag4-ref-status", "Фото не вибрано");
  await saveState(); updateStats(); setStatus("Скинуто.");
}

function showAdmin() {
  if (currentRole !== "admin") return setStatus("Адмін панель тільки для admin.");
  document.getElementById("ag4-admin-popup")?.remove();
  const p = document.createElement("div");
  p.id = "ag4-admin-popup";
  Object.assign(p.style, { position:"fixed", top:"80px", left:"80px", width:"520px", zIndex:10000000, background:"linear-gradient(180deg,#111827,#020617)", color:"white", border:"1px solid #334155", borderRadius:"22px", padding:"16px", boxShadow:"0 25px 80px rgba(0,0,0,.6)", fontFamily:"Arial,sans-serif" });
  p.innerHTML = `<div id="ag4-admin-head" style="display:flex;justify-content:space-between;cursor:move;padding-bottom:10px;border-bottom:1px solid #1e293b"><b>⚙ Admin Panel</b><button id="ag4-admin-close" style="background:#dc2626;color:white;border:0;border-radius:10px;padding:7px 10px;cursor:pointer">×</button></div><div style="margin-top:12px;font-size:12px;color:#94a3b8">Пароль адміна</div><input id="ag4-admin-pass" type="password" style="margin-top:6px;width:100%;box-sizing:border-box;background:#020617;color:white;border:1px solid #334155;border-radius:12px;padding:10px"><button id="ag4-admin-enter" class="ag4-btn" style="margin-top:9px;width:100%;border:0;border-radius:12px;background:#16a34a;color:white;padding:11px;font-weight:950;cursor:pointer">Увійти</button><div id="ag4-admin-body" style="margin-top:12px"></div>`;
  document.body.appendChild(p);
  makeDraggable(p, document.getElementById("ag4-admin-head"));
  document.getElementById("ag4-admin-close").onclick = () => p.remove();
  document.getElementById("ag4-admin-enter").onclick = () => {
    if (document.getElementById("ag4-admin-pass").value.trim() !== ADMIN_PASSWORD) return alert("Невірний пароль");
    renderAdminBody();
  };
}

function renderAdminBody() {
  const body = document.getElementById("ag4-admin-body");
  const users = Object.keys(stats).length ? Object.keys(stats) : ["geronimo", "vadim", "ilya", "dorosh", "misha"];
  body.innerHTML = `<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px"><button id="ag4-set-send" class="ag4-btn" style="background:#2563eb;color:white;border:0;border-radius:11px;padding:10px;cursor:pointer">Set Send</button><button id="ag4-set-download" class="ag4-btn" style="background:#7c3aed;color:white;border:0;border-radius:11px;padding:10px;cursor:pointer">Set Download</button><button id="ag4-set-upload" class="ag4-btn" style="background:#0891b2;color:white;border:0;border-radius:11px;padding:10px;cursor:pointer">Set Upload</button></div><button id="ag4-clear-cal" style="margin-top:8px;width:100%;background:#475569;color:white;border:0;border-radius:11px;padding:10px;cursor:pointer">Очистити backup calibration</button><div style="margin-top:14px;font-weight:900">📊 Статистика</div>${users.map(u => { const s=stats[u]||{total:0,image:0,video:0,lastGeneratedAt:"",history:[]}; return `<div style="margin-top:8px;padding:10px;border-radius:12px;background:#020617;border:1px solid #1e293b"><div style="display:flex;justify-content:space-between"><b>${escapeHtml(u)}</b><span style="color:#22c55e;font-weight:900">${s.total||0}</span></div><div style="font-size:12px;color:#94a3b8;margin-top:4px">Фото: ${s.image||0} | Відео: ${s.video||0} | Last: ${escapeHtml(s.lastGeneratedAt||"—")}</div></div>`; }).join("")}`;
  document.getElementById("ag4-set-send").onclick = () => startCalibration("send");
  document.getElementById("ag4-set-download").onclick = () => startCalibration("download");
  document.getElementById("ag4-set-upload").onclick = () => startCalibration("upload");
  document.getElementById("ag4-clear-cal").onclick = async () => { sendSig = downloadSig = uploadSig = null; await saveState(); setStatus("Backup calibration очищено."); };
}

function startCalibration(type) {
  calibrating = type;
  setStatus("Клікни по кнопці " + type + " у Grok.");
  const p = document.getElementById("ag4-admin-popup"); if (p) p.style.opacity = ".35";
}

document.addEventListener("click", e => {
  if (!calibrating) return;
  if (e.target.closest("#ag4-menu") || e.target.closest("#ag4-admin-popup") || e.target.id === "ag4-float") return;
  e.preventDefault(); e.stopPropagation();
  const el = e.target.closest("button,a,[role='button']") || e.target;
  const sig = signature(el);
  if (calibrating === "send") sendSig = sig;
  if (calibrating === "download") downloadSig = sig;
  if (calibrating === "upload") uploadSig = sig;
  const done = calibrating;
  calibrating = null;
  saveState();
  const p = document.getElementById("ag4-admin-popup"); if (p) p.style.opacity = "1";
  setStatus("Backup " + done + " збережено.");
}, true);

function findBySignature(sig, type) {
  if (!sig) return null;
  let best = null, bestScore = -999;
  for (const b of allButtons()) {
    const r = b.getBoundingClientRect();
    const label = buttonLabel(b);
    let s = 0;
    if ((b.getAttribute("aria-label")||"") === sig.aria) s += 20;
    if ((b.title||"") === sig.title) s += 15;
    if (norm(b.innerText) === sig.text && sig.text) s += 12;
    if (Math.abs(Math.round(r.width)-sig.w)<20) s += 3;
    if (Math.abs(Math.round(r.height)-sig.h)<20) s += 3;
    if (type === "send" && label.match(/download|upload|attach/)) s -= 50;
    if (type === "download" && label.match(/send|upload|attach/)) s -= 50;
    if (s > bestScore) { bestScore = s; best = b; }
  }
  return bestScore >= 6 ? best : null;
}

function signature(el) {
  const r = el.getBoundingClientRect();
  return { aria: el.getAttribute("aria-label") || "", title: el.title || "", text: norm(el.innerText), cls: String(el.className || ""), w: Math.round(r.width), h: Math.round(r.height) };
}

function refreshModeButtons() {
  const img = document.getElementById("ag4-img"), vid = document.getElementById("ag4-vid");
  if (!img || !vid) return;
  img.style.background = mode === "image" ? "#22c55e" : "#1e293b";
  vid.style.background = mode === "video" ? "#22c55e" : "#1e293b";
}

function recordGenerated(user, m, prompt) {
  if (!user) return;
  ensureUserStats(user);
  stats[user].total++;
  if (m === "image") stats[user].image++;
  else stats[user].video++;
  const item = { at: new Date().toLocaleString(), mode: m, prompt: prompt.slice(0,120) };
  stats[user].lastGeneratedAt = item.at;
  stats[user].history.unshift(item);
  stats[user].history = stats[user].history.slice(0,30);
  saveState();
}

function ensureUserStats(user) { if (!stats[user]) stats[user] = { total:0, image:0, video:0, lastGeneratedAt:"", history:[] }; }
function updateStats() { setText("ag4-assets", String(queue.length)); setText("ag4-progress", `${index} / ${queue.length}`); setText("ag4-user-count", String(currentUser && stats[currentUser] ? stats[currentUser].total : 0)); const st=document.getElementById("ag4-start"); if(st && document.activeElement!==st) st.value=String(index+1); }
function parsePrompts(t) { return String(t||"").split(/\n\s*\n/g).map(x=>x.trim()).filter(Boolean); }
function norm(t) { return String(t||"").replace(/\s+/g," ").trim(); }
function visible(el) { if (!el || el.closest?.("#ag4-menu")) return false; const r=el.getBoundingClientRect?.(); if(!r || r.width<2 || r.height<2) return false; const cs=getComputedStyle(el); return cs.display!=="none" && cs.visibility!=="hidden" && parseFloat(cs.opacity||"1")>.05; }
function sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }
function storageGet(keys) { return new Promise(r=>chrome.storage.local.get(keys,r)); }
function storageSet(obj) { return new Promise(r=>chrome.storage.local.set(obj,r)); }
async function dataUrlToFile(dataUrl, name, mime) { const res=await fetch(dataUrl); const blob=await res.blob(); return new File([blob], name, {type:mime}); }
function escapeHtml(s) { return String(s||"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;"); }
function hash(s) { let h=0; s=String(s||""); for(let i=0;i<s.length;i++){ h=((h<<5)-h)+s.charCodeAt(i); h|=0; } return String(h); }
function setStatus(t) { setText("ag4-status", t); }
function setWs(t) { setText("ag4-ws", t); }
function setText(id,t) { const el=document.getElementById(id); if(el) el.innerText=String(t); }
function on(id,fn) { const el=document.getElementById(id); if(el) el.onclick=fn; }
function displayUserName() { if (!currentUser) return "not logged in"; return currentUser === "geronimo" ? "Admin" : currentUser; }
function makeDraggable(box, head) { if(!box||!head) return; let drag=false,ox=0,oy=0; head.addEventListener("mousedown",e=>{ if(e.target.tagName==="BUTTON") return; drag=true; const r=box.getBoundingClientRect(); ox=e.clientX-r.left; oy=e.clientY-r.top; box.style.transform="none"; box.style.left=r.left+"px"; box.style.top=r.top+"px"; }); document.addEventListener("mousemove",e=>{ if(!drag) return; box.style.left=(e.clientX-ox)+"px"; box.style.top=(e.clientY-oy)+"px"; }); document.addEventListener("mouseup",()=>drag=false); }
