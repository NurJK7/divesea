"use strict";

(async function () {
  const user = await window.ready;
  if (!user) { location.href = "auth.html?mode=login&next=profile.html"; return; }

  const $ = (id) => document.getElementById(id);
  const modal = $("edit-modal");
  const errorBox = $("edit-error");
  let avatarData; // новое фото (data URL), если выбрано

  /* ---------- Profile data ---------- */
  function showUser(u) {
    $("nick").textContent = u.nickname;
    $("uname").textContent = "@" + u.username;
    $("avatar").src = u.avatar || "images/avatar.svg";
    $("st-balance").textContent = fmt(u.balance) + " ETH";
    $("st-owned").textContent = u.owned;
    $("st-bids").textContent = u.bids;
    document.querySelectorAll(".user-chip img").forEach((img) => { img.src = u.avatar || "images/avatar.svg"; });
    updateBalance(u.balance);
  }

  const ACTIVITY = {
    buy: ["Purchase", ""],
    bid: ["Bid", "up"],
    list: ["Listed for sale", "up"],
    sale: ["Sold", "up"],
    expired: ["Listing ended, returned to collection", ""],
  };

  // индикатор загрузки (только пока блок пуст) и сообщение с кнопкой «Retry» при ошибке
  async function reloadAll() {
    const ids = ["collection", "activity", "listings"];
    ids.forEach((id) => {
      const el = $(id);
      if (!el.children.length) el.innerHTML = id === "activity" ? `<li>${loaderHTML()}</li>` : loaderHTML();
    });
    try {
      await Promise.all([loadLists(), loadListings()]);
    } catch (err) {
      ids.forEach((id) => { $(id).innerHTML = id === "activity" ? `<li>${errorBlockHTML(err.message)}</li>` : errorBlockHTML(err.message); });
    }
  }
  document.addEventListener("click", (e) => { if (e.target.closest(".js-retry")) reloadAll(); });

  async function loadLists() {
    const { nfts } = await api("/me/collection");
    $("collection").innerHTML = nfts.length
      ? nfts.map((n) => `
        <article class="card">
          <img class="card__img" src="${imgSrc(n.image)}" alt="${esc(n.title)}">
          <h3>${esc(n.title)}</h3>
          <div class="card__row">
            <p><small>${n.paid != null ? "Bought for" : "Last price"}</small><span class="price"><img src="images/eth.svg" alt="ETH">${fmt(n.paid ?? n.price)}</span></p>
            <button class="btn btn--dark js-sell" type="button" data-id="${n.id}" data-title="${esc(n.title)}" data-paid="${fmt(n.paid)}">Sell</button>
          </div>
        </article>`).join("")
      : '<p class="muted empty">You do not own any NFTs yet. <a href="index.html#explore"><u>Go to the marketplace</u></a></p>';

    const { items } = await api("/me/activity");
    $("activity").innerHTML = items.length
      ? items.map((a) => `
        <li>
          <img src="${imgSrc(a.image)}" alt="">
          <span>${esc(a.title)}<small>${(ACTIVITY[a.type] || [a.type])[0]} · ${fmtDate(a.created_at)}</small></span>
          <b class="${(ACTIVITY[a.type] || ["", ""])[1]}"><img src="images/eth.svg" alt="ETH" width="8" height="14"> ${fmt(a.amount)}</b>
        </li>`).join("")
      : '<li class="muted">No activity yet.</li>';
  }

  /* ---------- My listings (created NFTs, DELETE) ---------- */
  async function loadListings() {
    const { nfts } = await api("/me/listings");
    $("listings").innerHTML = nfts.length
      ? nfts.map((n) => `
        <article class="card">
          <img class="card__img" src="${imgSrc(n.image)}" alt="${esc(n.title)}">
          ${n.owner_id ? "" : timerHTML(n)}
          <h3>${esc(n.title)}</h3>
          <div class="card__row">
            <p><small>${n.buy_now ? "Buy now" : "Current bid"}</small><span class="price"><img src="images/eth.svg" alt="ETH">${fmt(n.price)}</span></p>
            ${n.owner_id
              ? `<button class="btn btn--dark" type="button" disabled>${n.owner_id === user.id ? "In collection" : "Sold"}</button>`
              : `<div class="card__actions">
                   <button class="btn btn--dark js-edit" type="button" data-id="${n.id}" data-title="${esc(n.title)}" data-price="${n.price}" data-buynow="${n.buy_now ? 1 : 0}" data-creator="${n.creator_id === user.id ? 1 : 0}">Edit</button>
                   <button class="btn btn--light js-delete" type="button" data-id="${n.id}" data-cancel="${n.was_sold ? 1 : 0}">${n.was_sold ? "Cancel sale" : "Delete"}</button>
                 </div>`}
          </div>
        </article>`).join("")
      : '<p class="muted empty">No listings yet. <a href="create.html"><u>Create your first NFT</u></a></p>';
  }

  /* ---------- Edit listing (PATCH) ---------- */
  const nftEditModal = $("nft-edit-modal");
  const nftEditError = $("nft-edit-error");
  let nftEditId = null;
  let nftEditIsCreator = false;

  const closeNftEdit = () => { nftEditModal.hidden = true; document.body.classList.remove("no-scroll"); };

  $("listings").addEventListener("click", (e) => {
    const btn = e.target.closest(".js-edit");
    if (!btn) return;
    nftEditId = Number(btn.dataset.id);
    nftEditIsCreator = btn.dataset.creator === "1";
    $("nft-edit-title-row").hidden = !nftEditIsCreator; // переименовать может только создатель
    $("nft-edit-name").value = btn.dataset.title;
    $("nft-edit-price").value = btn.dataset.price;
    $("nft-edit-type").value = btn.dataset.buynow === "1" ? "instant" : "auction";
    nftEditError.textContent = "";
    nftEditModal.hidden = false;
    document.body.classList.add("no-scroll");
  });
  $("nft-edit-close").addEventListener("click", closeNftEdit);
  nftEditModal.addEventListener("click", (e) => { if (e.target === nftEditModal) closeNftEdit(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !nftEditModal.hidden) closeNftEdit(); });

  $("nft-edit-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const price = $("nft-edit-price").value.trim().replace(",", ".");
    const name = $("nft-edit-name").value.trim();
    if (nftEditIsCreator && (name.length < 2 || name.length > 40)) { nftEditError.textContent = "Title: 2–40 characters."; return; }
    if (!/^\d+(\.\d{1,4})?$/.test(price) || parseFloat(price) <= 0 || parseFloat(price) > 1000) {
      nftEditError.textContent = "Price must be a number between 0 and 1000.";
      return;
    }
    const body = { price: parseFloat(price), buy_now: $("nft-edit-type").value === "instant" };
    if (nftEditIsCreator) body.title = name;
    await withBusy($("nft-edit-form").querySelector("button[type=submit]"), async () => {
      try {
        await api("/nfts/" + nftEditId, { method: "PATCH", body });
        closeNftEdit();
        await loadListings();
        toast("Listing updated.", "success");
      } catch (err) {
        nftEditError.textContent = err.message;
      }
    });
  });

  $("listings").addEventListener("click", async (e) => {
    const btn = e.target.closest(".js-delete");
    if (!btn) return;
    const cancel = btn.dataset.cancel === "1";
    if (!confirm(cancel ? "Take this NFT off the marketplace and return it to your collection?" : "Delete this NFT?")) return;
    await withBusy(btn, async () => {
      try {
        await api("/nfts/" + btn.dataset.id, { method: "DELETE" });
        await reloadAll();
        const fresh = await api("/me");
        showUser(fresh.user);
        toast(cancel ? "The NFT is back in your collection." : "NFT deleted.", "success");
      } catch (err) {
        notifyError(err);
      }
    });
  });

  /* ---------- Sell (resell a bought NFT) ---------- */
  const sellModal = $("sell-modal");
  const sellError = $("sell-error");
  let sellId = null;

  function closeSell() { sellModal.hidden = true; document.body.classList.remove("no-scroll"); }

  $("collection").addEventListener("click", (e) => {
    const btn = e.target.closest(".js-sell");
    if (!btn) return;
    sellId = Number(btn.dataset.id);
    $("sell-title").textContent = "Sell " + btn.dataset.title;
    $("sell-sub").textContent = "You bought it for " + btn.dataset.paid + " ETH. Set a new price to put it back on the marketplace.";
    $("sell-price").value = "";
    $("sell-type").value = "instant";
    $("sell-duration").value = "1440";
    sellError.textContent = "";
    sellModal.hidden = false;
    document.body.classList.add("no-scroll");
    $("sell-price").focus();
  });
  $("sell-close").addEventListener("click", closeSell);
  sellModal.addEventListener("click", (e) => { if (e.target === sellModal) closeSell(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !sellModal.hidden) closeSell(); });

  $("sell-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const price = $("sell-price").value.trim().replace(",", ".");
    if (!/^\d+(\.\d{1,4})?$/.test(price)) { sellError.textContent = "Enter the price as a number, e.g. 1.5."; return; }
    if (parseFloat(price) <= 0 || parseFloat(price) > 1000) { sellError.textContent = "Price must be between 0 and 1000 ETH."; return; }
    await withBusy($("sell-form").querySelector("button[type=submit]"), async () => {
      try {
        const res = await api(`/nfts/${sellId}/sell`, { method: "POST", body: {
          price: parseFloat(price),
          buy_now: $("sell-type").value === "instant",
          duration: Number($("sell-duration").value),
        } });
        closeSell();
        showUser(res.user);
        await reloadAll();
        showTab("listings");
        toast("The NFT is on the marketplace now.", "success");
      } catch (err) {
        sellError.textContent = err.message;
      }
    });
  });

  /* ---------- Tabs ---------- */
  function showTab(name) {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("is-active", t.dataset.tab === name));
    ["collection", "activity", "listings"].forEach((n) => { $("tab-" + n).hidden = n !== name; });
  }
  document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => showTab(tab.dataset.tab)));

  /* ---------- Logout ---------- */
  $("logout-btn").addEventListener("click", async () => {
    try {
      await api("/logout", { method: "POST" });
      location.href = "index.html";
    } catch (err) {
      notifyError(err);
    }
  });

  /* ---------- Edit profile ---------- */
  function resizeImage(file, size = 256) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = size;
        const side = Math.min(img.width, img.height);
        canvas.getContext("2d").drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.onerror = () => reject(new Error("This file is not a valid image."));
      img.src = url;
    });
  }

  function closeEdit() { modal.hidden = true; document.body.classList.remove("no-scroll"); }

  $("edit-btn").addEventListener("click", () => {
    avatarData = undefined;
    errorBox.textContent = "";
    $("edit-nick").value = $("nick").textContent;
    $("edit-preview").src = $("avatar").src;
    $("edit-avatar").value = "";
    modal.hidden = false;
    document.body.classList.add("no-scroll");
    $("edit-nick").focus();
  });
  $("edit-close").addEventListener("click", closeEdit);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeEdit(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !modal.hidden) closeEdit(); });

  $("edit-avatar").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      avatarData = await resizeImage(file);
      $("edit-preview").src = avatarData;
      errorBox.textContent = "";
    } catch (err) {
      avatarData = undefined;
      errorBox.textContent = err.message;
    }
  });

  $("edit-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const nickname = $("edit-nick").value.trim();
    if (nickname.length < 2 || nickname.length > 20) { errorBox.textContent = "Nickname: 2–20 characters."; return; }
    await withBusy($("edit-form").querySelector("button[type=submit]"), async () => {
      try {
        const body = { nickname };
        if (avatarData) body.avatar = avatarData;
        const res = await api("/me", { method: "PATCH", body });
        showUser(res.user);
        closeEdit();
        toast("Profile saved.", "success");
      } catch (err) {
        errorBox.textContent = err.message;
      }
    });
  });

  showUser(user);
  await reloadAll();
  if (location.hash === "#listings") showTab("listings");

  // время лота вышло: NFT вернулся в коллекцию или продан — обновляем списки и баланс
  startTimers(async () => {
    try {
      await reloadAll();
      showUser((await api("/me")).user);
    } catch { /* повторим при следующем действии */ }
  });
})();
