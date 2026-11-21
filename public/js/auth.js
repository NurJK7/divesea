"use strict";

(async function () {
  if (await window.ready) { location.href = "profile.html"; return; }

  const $ = (id) => document.getElementById(id);
  const form = $("auth-form");
  const errorBox = $("auth-error");
  let mode = new URLSearchParams(location.search).get("mode") === "register" ? "register" : "login";

  function setMode(next) {
    mode = next;
    const reg = mode === "register";
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("is-active", t.dataset.mode === mode));
    $("email-row").hidden = !reg;
    $("nick-row").hidden = !reg;
    $("confirm-row").hidden = !reg;
    $("forgot-btn").hidden = reg; // «Forgot password?» только в окне входа (пока без действия)
    $("auth-note").hidden = !reg;
    $("auth-submit").textContent = reg ? "Create account" : "Log in";
    $("password").autocomplete = reg ? "new-password" : "current-password";
    errorBox.textContent = "";
  }

  function validate() {
    const username = $("username").value.trim();
    const password = $("password").value;
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return "Username: 3–20 letters, digits or _.";
    if (password.length < 6) return "Password must be at least 6 characters.";
    if (mode === "register") {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test($("email").value.trim())) return "Enter a valid email address.";
      const nick = $("nickname").value.trim();
      if (nick && (nick.length < 2 || nick.length > 20)) return "Nickname: 2–20 characters.";
      if ($("confirm").value !== password) return "Passwords do not match.";
    }
    return "";
  }

  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => setMode(t.dataset.mode)));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const error = validate();
    if (error) { errorBox.textContent = error; return; }
    const body = { username: $("username").value.trim(), password: $("password").value };
    if (mode === "register") {
      body.nickname = $("nickname").value.trim();
      body.email = $("email").value.trim();
    }
    await withBusy($("auth-submit"), async () => {
      try {
        await api(mode === "register" ? "/register" : "/login", { method: "POST", body });
        const next = new URLSearchParams(location.search).get("next");
        location.href = /^[a-z]+\.html$/.test(next || "") ? next : "profile.html";
      } catch (err) {
        errorBox.textContent = err.message;
      }
    });
  });

  setMode(mode);
})();
