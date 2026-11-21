"use strict";

/* ---------- Helpers shared by all pages ---------- */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// картинка NFT: либо файл из images/, либо загруженная пользователем (data URL)
const imgSrc = (img) => (/^data:image\//.test(img) ? img : "images/" + esc(img));
const fmt = (n) => Number(n).toFixed(2);
const fmtDate = (s) => new Date(s.replace(" ", "T") + "Z").toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

/* ---------- Таймер лотов ---------- */
function formatLeft(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86400), h = Math.floor((total % 86400) / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const p = (n) => String(n).padStart(2, "0");
  if (d > 0) return `${d}d ${p(h)}h ${p(m)}m`;
  if (h > 0) return `${p(h)}h ${p(m)}m ${p(s)}s`;
  return `${p(m)}m ${p(s)}s`;
}

// плашка с обратным отсчётом; время считается по часам сервера, поэтому не зависит от часов на компьютере
function timerHTML(n) {
  if (n.ends_at == null) return "";
  const deadline = Date.now() + (n.ends_at - n.server_now);
  return `<span class="card__timer" data-deadline="${deadline}">${formatLeft(deadline - Date.now())}</span>`;
}

// раз в секунду обновляет все плашки; когда время вышло, вызывает onExpire (обновить списки)
function startTimers(onExpire) {
  setInterval(() => {
    let expired = false;
    document.querySelectorAll("[data-deadline]").forEach((el) => {
      const left = Number(el.dataset.deadline) - Date.now();
      if (left > 0) { el.textContent = formatLeft(left); return; }
      el.textContent = "Ended";
      if (!el.dataset.done) { el.dataset.done = "1"; expired = true; }
    });
    if (expired && typeof onExpire === "function") setTimeout(onExpire, 1200);
  }, 1000);
}

/* ---------- Адрес API, уведомления, загрузчик ---------- */
const API_URL = ((window.APP_CONFIG && window.APP_CONFIG.API_URL) || "/api").replace(/\/+$/, "");
const API_TIMEOUT = 12000; // мс: дольше ждать ответа сервера не будем

// Выплывающее уведомление (type: "error" | "success")
function toast(message, type = "error") {
  let box = document.getElementById("toasts");
  if (!box) {
    box = document.createElement("div");
    box.id = "toasts";
    document.body.appendChild(box);
  }
  if ([...box.children].some((t) => t.textContent === message)) return; // одинаковое сообщение не дублируем
  const el = document.createElement("div");
  el.className = "toast toast--" + type;
  el.setAttribute("role", type === "error" ? "alert" : "status");
  el.textContent = message;
  el.addEventListener("click", () => el.remove());
  box.appendChild(el);
  setTimeout(() => el.remove(), type === "error" ? 6000 : type === "info" ? 5000 : 3500);
}
// ошибки сети и сервера api() уже показывает сам, остальные показываем здесь
const notifyError = (err) => { if (!err.toasted) toast(err.message, "error"); };

// блок с индикатором загрузки и блок с ошибкой и кнопкой «Retry»
const loaderHTML = (text = "Loading…") => `<div class="loader" role="status"><span class="spinner"></span><span>${esc(text)}</span></div>`;
const errorBlockHTML = (message) => `<div class="loader loader--error" role="alert"><span>${esc(message)}</span><button class="btn btn--dark js-retry" type="button">Retry</button></div>`;

// блокирует кнопку и показывает на ней крутилку, пока выполняется запрос
async function withBusy(btn, fn) {
  if (!btn) return fn();
  if (btn.disabled) return;
  btn.disabled = true;
  btn.classList.add("is-busy");
  try { return await fn(); } finally { btn.disabled = false; btn.classList.remove("is-busy"); }
}

// Один запрос к серверу. Ошибки сети и таймаут превращаем в понятные сообщения.
async function requestOnce(path, { method, body }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT);
  let res;
  try {
    res = await fetch(API_URL + path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: "include",
      signal: controller.signal,
    });
  } catch (e) {
    // нет сети, сервер выключен или не ответил вовремя
    const err = new Error(e.name === "AbortError"
      ? "The server is not responding. Please try again in a moment."
      : "No connection to the server. Check your internet and try again.");
    err.network = true;
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const waking = [502, 503, 504].includes(res.status); // бесплатный хостинг «просыпается»
    const err = new Error(waking ? "The server is starting up. Please wait a few seconds and try again."
      : res.status >= 500 ? "Server error. Please try again later."
      : data.error || "Something went wrong.");
    err.status = res.status;
    err.waking = waking;
    throw err;
  }
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// GET-запросы повторяются, если сервер не отвечает или только просыпается (бесплатный хостинг засыпает при простое)
async function api(path, { method = "GET", body } = {}) {
  const attempts = method === "GET" ? 3 : 1;
  for (let i = 1; ; i++) {
    try {
      return await requestOnce(path, { method, body });
    } catch (err) {
      const retryable = err.network || err.waking;
      if (retryable && i < attempts) {
        if (i === 1) toast("The server is waking up, please wait…", "info");
        await sleep(2500);
        continue;
      }
      if (err.network || (err.status && err.status >= 500)) { err.toasted = true; toast(err.message); }
      throw err;
    }
  }
}

function updateBalance(balance) {
  document.querySelectorAll(".user-chip__balance").forEach((el) => { el.textContent = fmt(balance) + " ETH"; });
}

/* ---------- Header and footer ---------- */
function renderHeader(user) {
  const account = user
    ? `<a class="user-chip" href="profile.html" aria-label="My profile">
         <span class="user-chip__balance">${fmt(user.balance)} ETH</span>
         <img src="${user.avatar || "images/avatar.svg"}" alt="">
       </a>`
    : `<a class="btn btn--light" href="auth.html?mode=login">Log in</a>
       <a class="btn btn--dark" href="auth.html?mode=register">Sign up</a>`;

  document.getElementById("site-header").innerHTML = `
    <div class="container header__inner">
      <a class="logo" href="index.html">
        <img src="images/logo.svg" alt="" width="32" height="24"><span class="logo__text">DiveSea</span>
      </a>
      <button class="burger" id="burger" type="button" aria-label="Menu" aria-expanded="false"><span></span><span></span><span></span></button>
      <div class="header__menu" id="menu">
        <nav>
          <ul class="nav">
            <li><a href="index.html#explore">Discover</a></li>
            <li><a href="index.html#collection">Creators</a></li>
            <li><a href="create.html">Sell</a></li>
            <li><a href="index.html#weekly">Stats</a></li>
          </ul>
        </nav>
        <form class="search" id="search-form">
          <label class="visually-hidden" for="search">Search</label>
          <input id="search" type="search" placeholder="Search Art Work / Creator">
        </form>
        ${account}
      </div>
    </div>`;
}

function renderFooter() {
  document.getElementById("site-footer").innerHTML = `
    <div class="container footer__inner">
      <a class="logo logo--light" href="index.html"><img src="images/logo.svg" alt="" width="32" height="24"><span class="logo__text">DiveSea</span></a>
      <ul class="footer__links">
        <li><a href="privacy.html">Privacy Policy</a></li>
        <li><a href="terms.html">Term &amp; Conditions</a></li>
        <li><a href="about.html">About Us</a></li>
        <li><a href="contact.html">Contact</a></li>
      </ul>
      <p>© 2023 DiveSea All Rights Reserved.</p>
    </div>`;
}

function initMenu() {
  const burger = document.getElementById("burger");
  const menu = document.getElementById("menu");

  const setMenu = (open) => {
    menu.classList.toggle("is-open", open);
    burger.classList.toggle("is-open", open);
    burger.setAttribute("aria-expanded", String(open));
  };

  burger.addEventListener("click", () => setMenu(!menu.classList.contains("is-open")));
  menu.addEventListener("click", (e) => { if (e.target.closest("a")) setMenu(false); });
  document.addEventListener("click", (e) => { if (!e.target.closest(".header")) setMenu(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") setMenu(false); });
  window.addEventListener("resize", () => { if (window.innerWidth > 768) setMenu(false); });

  document.getElementById("search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = document.getElementById("search").value.trim();
    if (typeof window.onSearch === "function") window.onSearch(q);
    else location.href = "index.html" + (q ? "?q=" + encodeURIComponent(q) : "") + "#explore";
  });
}

/* Resolves with the logged-in user (or null) once the layout is ready */
window.ready = (async () => {
  let user = null;
  try { user = (await api("/me")).user; } catch { /* not logged in */ }
  renderHeader(user);
  renderFooter();
  initMenu();
  return user;
})();
