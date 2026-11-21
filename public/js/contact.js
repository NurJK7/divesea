"use strict";

(async function () {
  const form = document.getElementById("contact-form");
  const errorBox = document.getElementById("c-error");
  const submit = form.querySelector("button[type=submit]");
  const $ = (id) => document.getElementById(id);

  // если пользователь вошёл — подставляем его данные
  const user = await window.ready;
  if (user) {
    $("c-name").value = user.nickname || "";
    $("c-email").value = user.email || "";
  }

  function validate() {
    const name = $("c-name").value.trim();
    const email = $("c-email").value.trim();
    const message = $("c-message").value.trim();
    if (name.length < 2) return "Please enter your name.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return "Please enter a valid email.";
    if (message.length < 10) return "Message must be at least 10 characters.";
    return "";
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const error = validate();
    if (error) { errorBox.classList.remove("is-ok"); errorBox.textContent = error; return; }
    await withBusy(submit, async () => {
      try {
        await api("/contact", { method: "POST", body: {
          name: $("c-name").value.trim(),
          email: $("c-email").value.trim(),
          topic: $("c-topic").value,
          message: $("c-message").value.trim(),
        } });
        errorBox.classList.add("is-ok");
        errorBox.textContent = "Thank you! Your message has been received.";
        toast("Message sent. Thank you!", "success");
        $("c-message").value = "";
      } catch (err) {
        errorBox.classList.remove("is-ok");
        errorBox.textContent = err.message;
      }
    });
  });

  form.addEventListener("input", () => { errorBox.textContent = ""; });
})();
