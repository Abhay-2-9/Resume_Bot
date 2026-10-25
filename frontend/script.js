const API_URL = "http://127.0.0.1:8000"; // change this to your deployed backend URL later
const KEY = "resumebot_chats";           // localStorage key for saved chats
const MAX_CHATS = 30;                    // oldest chats are dropped after this
const MAX_HISTORY = 10;                  // how many past messages are sent with each question

const $ = (id) => document.getElementById(id);
const stage = $("stage"), list = $("messages"), form = $("form"), input = $("input");
const sendBtn = $("send"), stopBtn = $("stop"), banner = $("banner");
const histBtn = $("hist-btn"), panel = $("panel"), historyEl = $("history");

let chats = [];      // saved chats: { id, title, messages: [{role, content}], updated }
let current = null;  // the chat on screen
let controller = null;
let busy = false;

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") { // links in bot answers open in a new tab
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

/* ---------- saved chats (localStorage) ---------- */
function loadChats() {
  try {
    const data = JSON.parse(localStorage.getItem(KEY));
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}
function saveChats() {
  try { localStorage.setItem(KEY, JSON.stringify(chats)); } catch {}
}
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2);

function newChat() {
  current = { id: newId(), title: "New chat", messages: [], updated: Date.now() };
  showChat();
}
function openChat(id) {
  current = chats.find((c) => c.id === id) || current;
  showChat();
}
function removeChat(id) {
  chats = chats.filter((c) => c.id !== id);
  saveChats();
  if (current.id === id) newChat(); else renderHistory();
}
// called after an answer is complete: store the question and answer in the chat
function commit(question, answer) {
  current.messages.push({ role: "user", content: question }, { role: "assistant", content: answer });
  if (current.title === "New chat") current.title = question.slice(0, 40);
  current.updated = Date.now();
  if (!chats.includes(current)) chats.push(current);
  chats.sort((a, b) => b.updated - a.updated).splice(MAX_CHATS);
  saveChats();
  renderHistory();
}

/* ---------- drawing the chat ---------- */
function renderHistory() {
  historyEl.innerHTML = "";
  chats.forEach((c) => {
    const row = document.createElement("div");
    row.className = "item" + (c.id === current.id ? " active" : "");
    const open = document.createElement("button");
    open.type = "button"; open.textContent = c.title; open.onclick = () => openChat(c.id);
    const del = document.createElement("button");
    del.type = "button"; del.className = "del"; del.textContent = "\u00d7";
    del.title = "Delete chat"; del.setAttribute("aria-label", "Delete chat"); del.onclick = () => removeChat(c.id);
    row.append(open, del);
    historyEl.append(row);
  });
}
function addMsg(cls, text = "") {
  const div = document.createElement("div");
  div.className = "msg " + cls;
  if (cls === "bot" && text) div.innerHTML = DOMPurify.sanitize(marked.parse(text));
  else div.textContent = text; // user and error text never go through innerHTML
  list.appendChild(div);
  return div;
}
function showChat() {
  list.innerHTML = "";
  current.messages.forEach((m) => addMsg(m.role === "user" ? "user" : "bot", m.content));
  const hasMessages = current.messages.length > 0;
  stage.classList.toggle("empty", !hasMessages); // empty = big heading, centered prompt bar
  list.hidden = !hasMessages;
  list.scrollTop = list.scrollHeight;
  renderHistory();
  closePanel();
}
const nearBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 80;
function setBusy(value) {
  busy = value;
  input.disabled = value;
  sendBtn.hidden = value;
  stopBtn.hidden = !value;
  panel.inert = value; // can't switch chats while an answer is streaming
  histBtn.disabled = value;
  if (!value) input.focus();
}
const grow = () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 150) + "px"; };
function closePanel() { panel.hidden = true; histBtn.setAttribute("aria-expanded", "false"); }

/* ---------- talking to the backend ---------- */
class ApiError extends Error {}

async function errorText(res) {
  let t = "";
  try { t = (await res.text()).trim(); } catch {}
  try {
    const d = JSON.parse(t).detail; // some errors are JSON like {"detail": "..."}
    t = typeof d === "string" ? d : "";
  } catch {} // plain text (like our 422 message) is not JSON, so keep it
  return t || "Something went wrong. Please try again.";
}

async function ask(question) {
  stage.classList.remove("empty");
  list.hidden = false;
  addMsg("user", question);
  const bot = addMsg("bot");
  bot.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>'; // typing indicator
  list.scrollTop = list.scrollHeight;
  setBusy(true);
  controller = new AbortController();

  // CONTEXT: the backend remembers nothing, so we send the earlier messages every time
  const history = current.messages.slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));

  let text = "", frame = 0;
  const render = () => {
    frame = 0;
    const stick = nearBottom();
    bot.innerHTML = DOMPurify.sanitize(marked.parse(text));
    if (stick) list.scrollTop = list.scrollHeight;
  };

  try {
    const res = await fetch(API_URL + "/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, history }),
      signal: controller.signal,
    });
    if (!res.ok) throw new ApiError(await errorText(res));
    banner.hidden = true;

    // STREAMING: read the response piece by piece instead of waiting for all of it
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true }); // stream:true keeps split characters intact
      if (!frame) frame = requestAnimationFrame(render); // redraw at most once per frame
    }
    text += decoder.decode();
    cancelAnimationFrame(frame);
    render();
    if (text) commit(question, text);
  } catch (e) {
    cancelAnimationFrame(frame);
    if (e.name === "AbortError") { // user pressed Stop: keep the partial answer
      if (text) { render(); commit(question, text); } else bot.remove();
    } else {
      const msg = e instanceof ApiError ? e.message : "Can't reach the server. Please try again in a moment.";
      if (text) { render(); addMsg("error", msg); }
      else { bot.className = "msg error"; bot.textContent = msg; }
    }
  } finally {
    setBusy(false);
  }
}

/* ---------- events ---------- */
form.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = input.value.trim();
  if (!q || busy) return; // no empty or spaces-only questions
  input.value = "";
  grow();
  ask(q);
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
});
input.addEventListener("input", grow);
$("chips").addEventListener("click", (e) => { const q = e.target.dataset.q; if (q && !busy) ask(q); });
stopBtn.addEventListener("click", () => controller && controller.abort());
$("new-chat").addEventListener("click", newChat);
histBtn.addEventListener("click", () => {
  panel.hidden = !panel.hidden;
  histBtn.setAttribute("aria-expanded", String(!panel.hidden));
});
document.addEventListener("click", (e) => { if (!e.target.closest(".top")) closePanel(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePanel(); });

/* ---------- ASCII fish swimming in the background ---------- */
const cv = $("fish"), ctx = cv.getContext("2d");
const RAMP = " .:-=+*#%@";   // characters from faint to dense
const CW = 8, CH = 13;       // size of one character cell in pixels
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
let cols = 0, rows = 0, ink = "22,23,29";

// L = length in cells, H = body half-height in cells, speed = cells per second, dir = 1 right / -1 left
const fish = [
  { L: 36, H: 7,   speed: 4,   dir: 1,  yc: 0.30, x: 0 },  // the shark
  { L: 14, H: 3,   speed: 7,   dir: -1, yc: 0.72, x: 0 },
  { L: 10, H: 2.4, speed: 5.5, dir: 1,  yc: 0.52, x: 0 },
];
const readInk = () => { ink = getComputedStyle(document.documentElement).getPropertyValue("--ink-rgb").trim(); };
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", readInk);

function resize() {
  const dpr = window.devicePixelRatio || 1;
  cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  cols = Math.ceil(innerWidth / CW); rows = Math.ceil(innerHeight / CH);
}
function placeFish() { fish.forEach((f) => { f.x = Math.random() * cols; f.yc = f.yc * rows; }); }

function drawFish(f, time) {
  const nose = f.x + f.dir * f.L / 2;
  for (let cx = Math.floor(f.x - f.L / 2); cx <= Math.ceil(f.x + f.L / 2); cx++) {
    const t = f.dir * (nose - cx) / f.L;               // 0 at the nose, 1 at the tail tip
    if (t < 0 || t > 1) continue;
    const s = Math.pow(Math.min(t / 0.8, 1), 0.75);
    let half = f.H * (0.12 + 0.88 * Math.sin(Math.PI * s)); // body is widest near the front
    const q = (t - 0.8) / 0.2;
    if (q > 0) half = f.H * (0.12 + 0.75 * q);          // tail fin widens toward the tip
    const fin = t > 0.28 && t < 0.46 ? f.H * 0.9 * (1 - Math.abs(t - 0.37) / 0.09) : 0;
    const sway = Math.sin(time * 3 - t * 5) * f.H * 0.35 * t; // tail swings side to side
    for (let cy = Math.floor(f.yc - f.H * 2.2); cy <= Math.ceil(f.yc + f.H * 2.2); cy++) {
      const v = cy - f.yc - sway;                       // negative = above the body centre
      if (v < -(half + Math.max(fin, 0)) || v > half) continue;
      if (q > 0.6 && Math.abs(v) < (q - 0.6) * f.H * 2) continue; // notch makes the tail forked
      let b = 0.3 + 0.7 * (1 - Math.abs(v) / (half + 0.5));
      if (v > 0) b *= 0.7;                              // lighter belly
      let ch = RAMP[Math.max(1, Math.floor(b * (RAMP.length - 1)) - ((cx * 7 + cy * 13) % 3 === 0 ? 1 : 0))];
      if (t > 0.06 && t < 0.1 && Math.abs(v + f.H * 0.25) < 0.7) ch = "o"; // eye
      ctx.fillStyle = `rgba(${ink},${0.2 + 0.5 * b})`;
      ctx.fillText(ch, cx * CW, cy * CH);
    }
  }
}
let last = 0;
function swim(now) {
  const time = now / 1000, dt = Math.min(time - last, 0.1);
  last = time;
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  ctx.font = "12px ui-monospace, Menlo, Consolas, monospace";
  ctx.textBaseline = "top";
  for (const f of fish) {
    if (!reduceMotion) f.x += f.dir * f.speed * dt;
    if (f.dir > 0 && f.x > cols + f.L) { f.x = -f.L; f.yc = rows * (0.15 + Math.random() * 0.7); }
    if (f.dir < 0 && f.x < -f.L) { f.x = cols + f.L; f.yc = rows * (0.15 + Math.random() * 0.7); }
    drawFish(f, reduceMotion ? 0 : time);
  }
  requestAnimationFrame(swim);
}

/* ---------- start ---------- */
chats = loadChats();
newChat();
readInk();
resize();
placeFish();
addEventListener("resize", resize);
requestAnimationFrame(swim);

// wake up a sleeping free-tier server as soon as the page opens
const slowTimer = setTimeout(() => (banner.hidden = false), 3000);
fetch(API_URL + "/hiremeAI").catch(() => {}).finally(() => { clearTimeout(slowTimer); banner.hidden = true; });