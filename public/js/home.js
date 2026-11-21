"use strict";

(async function () {
  let user = await window.ready;
  let nfts = [];      // то, что показано в сетке (с учётом поиска и фильтров)
  let allNfts = [];   // все NFT на продаже (для слайдера и окна ставки)
  let current = null;
  const filters = { search: new URLSearchParams(location.search).get("q") || "", type: "", sort: "oldest" };

  const $ = (id) => document.getElementById(id);
  const slider = $("slider");
  const grid = $("grid");
  const modal = $("modal");
  const form = $("bid-form");
  const input = $("bid-amount");
  const field = $("bid-field");
  const msg = $("modal-msg");
  const buyBtn = $("buy-btn");
  const profileLink = $("profile-link");

  /* ---------- Cards ---------- */
  function cardHTML(n) {
    const sold = n.owner_id !== null;
    const button = sold
      ? `<button class="btn btn--dark" type="button" disabled>${user && n.owner_id === user.id ? "Owned" : "Sold"}</button>`
      : `<button class="btn btn--dark js-open" type="button" data-id="${n.id}">${n.buy_now ? "Buy now" : "Place bid"}</button>`;
    return `
    <article class="card">
      <img class="card__img" src="${imgSrc(n.image)}" alt="${esc(n.title)}">
      ${timerHTML(n)}
      <h3>${esc(n.title)}</h3>
      <div class="card__row">
        <p><small>${n.buy_now ? "Buy now" : "Current bid"}</small><span class="price"><img src="images/eth.svg" alt="ETH">${fmt(n.price)}</span></p>
        ${button}
      </div>
    </article>`;
  }

  function render() {
    slider.innerHTML = allNfts.slice(0, 6).map(cardHTML).join("");
    grid.innerHTML = nfts.map(cardHTML).join("");
    $("grid-empty").textContent = "No NFTs found.";
    $("grid-empty").hidden = nfts.length > 0;
  }

  // поиск, тип и сортировка выполняются на сервере: GET /api/nfts?search=&type=&sort=
  async function loadNfts() {
    const params = new URLSearchParams();
    if (filters.search) params.set("search", filters.search);
    if (filters.type) params.set("type", filters.type);
    if (filters.sort !== "oldest") params.set("sort", filters.sort);
    if (params.toString()) {
      [allNfts, nfts] = (await Promise.all([api("/nfts"), api("/nfts?" + params)])).map((r) => r.nfts);
    } else {
      allNfts = nfts = (await api("/nfts")).nfts;
    }
    render();
  }

  // загрузка с индикатором; при ошибке сети вместо пустой страницы — сообщение и кнопка «Retry»
  async function loadWithLoader() {
    $("grid-empty").hidden = true;
    grid.innerHTML = loaderHTML("Loading NFTs…");
    try {
      await loadNfts();
    } catch (err) {
      slider.innerHTML = "";
      grid.innerHTML = errorBlockHTML("Could not load the marketplace. " + err.message);
    }
  }
  grid.addEventListener("click", (e) => { if (e.target.closest(".js-retry")) loadWithLoader(); });

  let searchTimer;
  function applyFilters() {
    const q = filters.search;
    history.replaceState(null, "", q ? "?q=" + encodeURIComponent(q) : location.pathname);
    loadWithLoader();
  }
  $("filter-search").value = filters.search;
  $("filter-search").addEventListener("input", (e) => {
    filters.search = e.target.value.trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(applyFilters, 300);
  });
  $("filter-type").addEventListener("change", (e) => { filters.type = e.target.value; applyFilters(); });
  $("filter-sort").addEventListener("change", (e) => { filters.sort = e.target.value; applyFilters(); });
  window.onSearch = (q) => {   // строка поиска в шапке
    filters.search = q;
    $("filter-search").value = q;
    applyFilters();
  };

  /* ---------- Slider and follow buttons ---------- */
  const step = () => (slider.querySelector(".card")?.offsetWidth || 220) + 20;
  $("prev").addEventListener("click", () => slider.scrollBy({ left: -step(), behavior: "smooth" }));
  $("next").addEventListener("click", () => slider.scrollBy({ left: step(), behavior: "smooth" }));

  document.querySelectorAll(".follow").forEach((btn) => {
    btn.addEventListener("click", () => {
      const on = btn.classList.toggle("is-on");
      btn.textContent = on ? "Unfollow" : "Follow";
    });
  });

  /* ---------- Modal ---------- */
  function showMessage(text, ok) {
    msg.textContent = text;
    msg.classList.toggle("is-ok", ok);
    field.classList.toggle("is-invalid", text !== "" && !ok);
  }

  function renderBids(bids) {
    $("bids").innerHTML = bids.length
      ? bids.map((b) => `<li><span>${esc(b.nickname)}<small>${fmtDate(b.created_at)}</small></span><b>${fmt(b.amount)} ETH</b></li>`).join("")
      : "<li><span>No bids yet<small>Be the first one!</small></span></li>";
  }

  async function refreshModal() {
    const instant = current.buy_now === 1;
    $("modal-title").textContent = current.title;
    $("modal-sub").textContent = `${instant ? "Instant price" : "Current bid"}: ${fmt(current.price)} ETH · Your balance: ${fmt(user.balance)} ETH`;
    $("bids").hidden = instant;
    form.hidden = instant;
    buyBtn.hidden = instant ? current.owner_id !== null : true;
    buyBtn.textContent = `Buy now for ${fmt(current.price)} ETH`;
    if (!instant) renderBids((await api(`/nfts/${current.id}/bids`)).bids);
  }

  async function openModal(id) {
    if (!user) { location.href = "auth.html?mode=login&next=index.html"; return; }
    current = allNfts.find((n) => n.id === id);
    showMessage("", false);
    profileLink.hidden = true;
    modal.hidden = false;
    document.body.classList.add("no-scroll");
    try {
      await refreshModal();
    } catch (err) {
      closeModal();
      notifyError(err);
      return;
    }
    if (!form.hidden) input.focus();
  }

  function closeModal() {
    modal.hidden = true;
    document.body.classList.remove("no-scroll");
    form.reset();
    showMessage("", false);
  }

  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".js-open");
    if (btn) openModal(Number(btn.dataset.id));
  });
  $("modal-close").addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !modal.hidden) closeModal(); });

  /* ---------- Bid form (client-side validation) ---------- */
  function validate(raw) {
    const value = raw.trim().replace(",", ".");
    if (value === "") return "Enter your bid amount.";
    if (!/^\d+(\.\d{1,4})?$/.test(value)) return "Use digits only, e.g. 1.80.";
    const amount = parseFloat(value);
    if (amount <= current.price) return `Bid must be higher than ${fmt(current.price)} ETH.`;
    if (amount > user.balance) return `Not enough balance (${fmt(user.balance)} ETH).`;
    return "";
  }

  async function afterTrade(newUser, text) {
    user = newUser;
    updateBalance(user.balance);
    await loadNfts();
    // купленный NFT уходит с маркетплейса — оставляем его данные для окна
    current = allNfts.find((n) => n.id === current.id) || { ...current, owner_id: user.id };
    await refreshModal();
    showMessage(text, true);
  }

  input.addEventListener("input", () => showMessage("", false));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const error = validate(input.value);
    if (error) { showMessage(error, false); input.focus(); return; }
    await withBusy(form.querySelector("button[type=submit]"), async () => {
      try {
        const amount = parseFloat(input.value.trim().replace(",", "."));
        const res = await api(`/nfts/${current.id}/bid`, { method: "POST", body: { amount } });
        form.reset();
        await afterTrade(res.user, "Your bid has been placed!");
      } catch (err) {
        showMessage(err.message, false);
      }
    });
  });

  buyBtn.addEventListener("click", () => withBusy(buyBtn, async () => {
    try {
      const title = current.title;
      const res = await api(`/nfts/${current.id}/buy`, { method: "POST" });
      await afterTrade(res.user, `Done! ${title} is now in your profile.`);
      profileLink.hidden = false;
      toast(`${title} is now in your profile.`, "success");
    } catch (err) {
      showMessage(err.message, false);
    }
  }));

  await loadWithLoader();
  startTimers(() => loadNfts().catch(() => {})); // когда время лота вышло — обновляем маркетплейс
})();
