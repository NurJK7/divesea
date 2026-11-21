"use strict";

(async function () {
  if (!(await window.ready)) { location.href = "auth.html?mode=login&next=create.html"; return; }

  const errorBox = document.getElementById("n-error");
  const fileInput = document.getElementById("n-image");
  const preview = document.getElementById("n-preview");
  const NFT_SIZE = 400; // как у существующих NFT: квадрат 400×400
  const MAX_FILE = 8 * 1024 * 1024;
  let imageData = null;

  // обрезаем по центру до квадрата и сжимаем — все NFT получаются одного размера
  function resizeImage(file, size = NFT_SIZE) {
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

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    imageData = null;
    preview.hidden = true;
    if (!file) return;
    if (file.size > MAX_FILE) { errorBox.textContent = "The file is too big (max 8 MB)."; fileInput.value = ""; return; }
    try {
      imageData = await resizeImage(file);
      preview.src = imageData;
      preview.hidden = false;
      errorBox.textContent = "";
    } catch (err) {
      errorBox.textContent = err.message;
      fileInput.value = "";
    }
  });

  function validate(title, price) {
    if (title.length < 2 || title.length > 40) return "Title: 2–40 characters.";
    if (!/^\d+(\.\d{1,4})?$/.test(price)) return "Enter the price as a number, e.g. 1.5.";
    if (parseFloat(price) <= 0 || parseFloat(price) > 1000) return "Price must be between 0 and 1000 ETH.";
    return "";
  }

  document.getElementById("create-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = document.getElementById("n-title").value.trim();
    const price = document.getElementById("n-price").value.trim().replace(",", ".");
    const error = validate(title, price) || (imageData ? "" : "Upload an image for your NFT.");
    if (error) { errorBox.textContent = error; return; }
    await withBusy(e.target.querySelector("button[type=submit]"), async () => {
      try {
        await api("/nfts", { method: "POST", body: {
          title,
          price: parseFloat(price),
          image: imageData,
          buy_now: document.getElementById("n-type").value === "instant",
          duration: Number(document.getElementById("n-duration").value),
        } });
        location.href = "profile.html#listings";
      } catch (err) {
        errorBox.textContent = err.message;
      }
    });
  });
})();
