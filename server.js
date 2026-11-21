"use strict";
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const PORT = process.env.PORT || 3000;
const START_BALANCE = Number(process.env.STARTING_BALANCE) || 10;
// SameSite=None нужен только если сайт и сервер на разных доменах без прокси (тогда обязателен и Secure)
const SAME_SITE = process.env.COOKIE_SAMESITE || "Lax";
const COOKIE_FLAGS = `HttpOnly; SameSite=${SAME_SITE}; Path=/` + (process.env.COOKIE_SECURE === "true" || SAME_SITE === "None" ? "; Secure" : "");
const db = new DatabaseSync(path.join(__dirname, process.env.DB_FILE || "divesea.db"));
// совместимость с API better-sqlite3 (pragma / transaction)
db.pragma = (str) => db.exec("PRAGMA " + str);
db.transaction = (fn) => (...args) => {
  db.exec("BEGIN");
  try {
    const result = fn(...args);
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
};
db.pragma("journal_mode = WAL");

/* ---------- Database ---------- */
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  nickname TEXT NOT NULL,
  avatar TEXT,
  balance REAL NOT NULL DEFAULT 10
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS nfts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  image TEXT NOT NULL,
  price REAL NOT NULL,
  buy_now INTEGER NOT NULL DEFAULT 0,
  ends_in TEXT NOT NULL,
  owner_id INTEGER REFERENCES users(id),
  creator_id INTEGER REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  topic TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  nft_id INTEGER NOT NULL REFERENCES nfts(id),
  type TEXT NOT NULL,
  amount REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);`);

if (!db.prepare("PRAGMA table_info(nfts)").all().some((c) => c.name === "creator_id")) {
  db.exec("ALTER TABLE nfts ADD COLUMN creator_id INTEGER REFERENCES users(id)"); // миграция старой базы
}

if (!db.prepare("PRAGMA table_info(users)").all().some((c) => c.name === "email")) {
  // email для будущего подтверждения почты (email_verified = 0 пока не подтверждён)
  db.exec("ALTER TABLE users ADD COLUMN email TEXT");
  db.exec("ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0");
}
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email COLLATE NOCASE)");

if (!db.prepare("PRAGMA table_info(nfts)").all().some((c) => c.name === "seller_id")) {
  // seller_id — кто сейчас продаёт NFT (получит деньги при покупке)
  db.exec("ALTER TABLE nfts ADD COLUMN seller_id INTEGER REFERENCES users(id)");
  db.exec("UPDATE nfts SET seller_id = creator_id WHERE owner_id IS NULL AND creator_id IS NOT NULL");
}

if (!db.prepare("PRAGMA table_info(nfts)").all().some((c) => c.name === "ends_at")) {
  // ends_at — реальное время окончания лота (мс, Unix); у уже выставленных лотов даём 24 часа
  db.exec("ALTER TABLE nfts ADD COLUMN ends_at INTEGER");
  db.prepare("UPDATE nfts SET ends_at = ? WHERE owner_id IS NULL").run(Date.now() + 24 * 60 * 60 * 1000);
}

try {
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_nfts_title ON nfts(title COLLATE NOCASE)");
} catch { /* в старой базе уже есть одинаковые названия — полагаемся на проверку в API */ }

if (db.prepare("SELECT COUNT(*) c FROM nfts").get().c === 0) {
  const seed = [
    ["Sun-Glass #1", "nft-orange.svg", 2.5, 1, "07h 09m 12s"],
    ["Sun-Glass #2", "nft-blue.png", 1.75, 0, "07h 09m 12s"],
    ["Sun-Glass #3", "nft-pink.png", 3.2, 1, "07h 09m 12s"],
    ["NuEvey #1", "nft-white.png", 1.25, 0, "19H 09m 12s"],
    ["Sun-Glass #4", "nft-pink.png", 1.9, 0, "07h 09m 12s"],
    ["Sun-Glass #5", "nft-orange.svg", 4.0, 1, "07h 09m 12s"],
    ["NuEvey #2", "nft-white.png", 0.85, 1, "19H 09m 12s"],
    ["Sun-Glass #6", "nft-blue.png", 2.1, 0, "07h 09m 12s"],
  ];
  const leftMs = (t) => { const m = /(\d+)h\s+(\d+)m\s+(\d+)s/i.exec(t); return ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000; };
  const ins = db.prepare("INSERT INTO nfts(title,image,price,buy_now,ends_in,ends_at) VALUES(?,?,?,?,?,?)");
  seed.forEach((row) => ins.run(...row, Date.now() + leftMs(row[4])));
}

/* ---------- Helpers ---------- */
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const round = (n) => Math.round(n * 10000) / 10000;
const hashPassword = (password, salt) => crypto.scryptSync(password, salt, 64).toString("hex");

function publicUser(u) {
  const stats = db.prepare(
    "SELECT (SELECT COUNT(*) FROM nfts WHERE owner_id=?) owned, (SELECT COUNT(*) FROM activity WHERE user_id=? AND type='bid') bids"
  ).get(u.id, u.id);
  return { id: u.id, username: u.username, email: u.email, email_verified: u.email_verified, nickname: u.nickname, avatar: u.avatar, balance: u.balance, ...stats };
}

function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions(token,user_id) VALUES(?,?)").run(token, userId);
  res.setHeader("Set-Cookie", `sid=${token}; ${COOKIE_FLAGS}; Max-Age=604800`);
}

function currentUser(req) {
  const m = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie || "");
  if (!m) return null;
  return db.prepare("SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?").get(m[1]) || null;
}

const wrap = (fn) => (req, res) => {
  try {
    fn(req, res);
  } catch (e) {
    if (!e.status) console.error(e);
    res.status(e.status || 500).json({ error: e.status ? e.message : "Server error" });
  }
};
const needAuth = (fn) => wrap((req, res) => {
  req.user = currentUser(req);
  if (!req.user) throw new HttpError(401, "Please log in first.");
  fn(req, res);
});

const NFT_SQL = `SELECT n.id, n.title, n.image, n.price, n.buy_now, n.ends_at,
                        (CAST(strftime('%s','now') AS INTEGER) * 1000 + CAST(substr(strftime('%f','now'), 4, 3) AS INTEGER)) AS server_now,
                        n.owner_id, n.creator_id, n.seller_id, u.nickname AS owner,
                        EXISTS(SELECT 1 FROM activity a WHERE a.nft_id = n.id AND a.type = 'buy') AS was_sold
                 FROM nfts n LEFT JOIN users u ON u.id = n.owner_id`;

/* ---------- App ---------- */
const app = express();
app.set("trust proxy", 1); // сервер стоит за прокси хостинга (Render, Netlify)
const clientIp = (req) => req.headers["x-nf-client-connection-ip"] || req.ip;
app.use(cors({
  origin: (process.env.CORS_ORIGIN || "http://localhost:3000").split(",").map((o) => o.trim()),
  credentials: true,
}));
app.use(express.json({ limit: "400kb" }));
app.get("/api/health", (req, res) => res.json({ status: "ok", time: new Date().toISOString() }));

app.use("/api", (req, res, next) => {
  try { settleExpired(); } catch (e) { console.error("settle error:", e.message); }
  next();
});
app.use(express.static(path.join(__dirname, "public")));

/* Auth */
app.post("/api/register", wrap((req, res) => {
  const { username, password, nickname } = req.body;
  const email = String(req.body.email || "").trim();
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username || "")) throw new HttpError(400, "Username: 3–20 letters, digits or _.");
  if (typeof password !== "string" || password.length < 6 || password.length > 64) throw new HttpError(400, "Password: 6–64 characters.");
  if (email.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new HttpError(400, "Enter a valid email address.");
  const nick = (nickname || username).trim();
  if (nick.length < 2 || nick.length > 20) throw new HttpError(400, "Nickname: 2–20 characters.");
  if (db.prepare("SELECT 1 FROM users WHERE username=?").get(username)) throw new HttpError(409, "This username is already taken.");
  if (db.prepare("SELECT 1 FROM users WHERE email=? COLLATE NOCASE").get(email)) throw new HttpError(409, "This email is already registered.");
  const salt = crypto.randomBytes(16).toString("hex");
  const id = db.prepare("INSERT INTO users(username,email,salt,password_hash,nickname,balance) VALUES(?,?,?,?,?,?)")
    .run(username, email, salt, hashPassword(password, salt), nick, START_BALANCE).lastInsertRowid;
  startSession(res, id);
  res.status(201).json({ user: publicUser(db.prepare("SELECT * FROM users WHERE id=?").get(id)) });
}));

app.post("/api/login", wrap((req, res) => {
  const { username, password } = req.body;
  const u = db.prepare("SELECT * FROM users WHERE username=?").get(String(username || ""));
  const ok = u && crypto.timingSafeEqual(
    Buffer.from(hashPassword(String(password || ""), u.salt), "hex"), Buffer.from(u.password_hash, "hex"));
  if (!ok) throw new HttpError(401, "Wrong username or password.");
  startSession(res, u.id);
  res.json({ user: publicUser(u) });
}));

app.post("/api/logout", wrap((req, res) => {
  const m = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie || "");
  if (m) db.prepare("DELETE FROM sessions WHERE token=?").run(m[1]);
  res.setHeader("Set-Cookie", `sid=; ${COOKIE_FLAGS}; Max-Age=0`);
  res.json({ ok: true });
}));

/* Profile */
app.get("/api/me", wrap((req, res) => {
  const u = currentUser(req);
  if (!u) throw new HttpError(401, "Not logged in.");
  res.json({ user: publicUser(u) });
}));

app.patch("/api/me", needAuth((req, res) => {
  const nick = String(req.body.nickname ?? req.user.nickname).trim();
  if (nick.length < 2 || nick.length > 20) throw new HttpError(400, "Nickname: 2–20 characters.");
  let avatar = req.user.avatar;
  if (req.body.avatar !== undefined) {
    if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(req.body.avatar) || req.body.avatar.length > 300000)
      throw new HttpError(400, "Avatar must be a JPEG, PNG or WebP image up to ~200 KB.");
    avatar = req.body.avatar;
  }
  db.prepare("UPDATE users SET nickname=?, avatar=? WHERE id=?").run(nick, avatar, req.user.id);
  res.json({ user: publicUser(db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id)) });
}));

app.get("/api/me/collection", needAuth((req, res) => {
  res.json({ nfts: db.prepare(
    `SELECT n.id, n.title, n.image, n.price,
            (SELECT a.amount FROM activity a WHERE a.nft_id=n.id AND a.user_id=n.owner_id AND a.type='buy' ORDER BY a.id DESC LIMIT 1) AS paid
     FROM nfts n WHERE n.owner_id=? ORDER BY n.id`).all(req.user.id) });
}));

app.get("/api/me/listings", needAuth((req, res) => {
  res.json({ nfts: db.prepare(NFT_SQL + " WHERE n.seller_id=? OR n.creator_id=? ORDER BY n.id DESC").all(req.user.id, req.user.id) });
}));

app.get("/api/me/activity", needAuth((req, res) => {
  res.json({ items: db.prepare(
    `SELECT a.id, a.type, a.amount, a.created_at, n.title, n.image
     FROM activity a JOIN nfts n ON n.id=a.nft_id WHERE a.user_id=? ORDER BY a.id DESC`).all(req.user.id) });
}));

/* NFTs */
// GET /api/nfts?search=sun&type=instant|auction&sort=price_asc|price_desc|newest|oldest
const SORTS = { oldest: "n.id ASC", newest: "n.id DESC", price_asc: "n.price ASC, n.id ASC", price_desc: "n.price DESC, n.id ASC" };
const TYPES = { instant: "n.buy_now = 1", auction: "n.buy_now = 0" };

app.get("/api/nfts", wrap((req, res) => {
  const { type = "", sort = "oldest" } = req.query;
  if (type && !TYPES[type]) throw new HttpError(400, "Invalid type. Use instant or auction.");
  if (!SORTS[sort]) throw new HttpError(400, "Invalid sort. Use oldest, newest, price_asc or price_desc.");
  const where = ["n.owner_id IS NULL"];
  if (type) where.push(TYPES[type]);
  let nfts = db.prepare(`${NFT_SQL} WHERE ${where.join(" AND ")} ORDER BY ${SORTS[sort]}`).all();
  const search = String(req.query.search || "").trim().toLowerCase();
  if (search) nfts = nfts.filter((n) => n.title.toLowerCase().includes(search)); // без учёта регистра, в том числе кириллица
  res.json({ nfts });
}));

/* NFT CRUD: GET list (above), GET by id, POST, PATCH, DELETE */
const IMAGES = ["nft-orange.svg", "nft-blue.png", "nft-pink.png", "nft-white.png"];

const normTitle = (t) => String(t || "").trim().replace(/\s+/g, " ");

// Защита от копий: одинаковое название (без учёта регистра) или та же загруженная картинка
function assertNotDuplicate(title, image, exceptId = 0) {
  if (title && db.prepare("SELECT 1 FROM nfts WHERE title = ? COLLATE NOCASE AND id <> ?").get(title, exceptId)) {
    throw new HttpError(409, "An NFT with this title already exists. Choose another title.");
  }
  if (image && image.startsWith("data:") && db.prepare("SELECT 1 FROM nfts WHERE image = ? AND id <> ?").get(image, exceptId)) {
    throw new HttpError(409, "This image is already used by another NFT.");
  }
}

// есть ли ставки в текущем аукционе (после последней покупки)
const hasBids = (nftId) => !!db.prepare(
  `SELECT 1 FROM activity a WHERE a.nft_id=? AND a.type='bid'
     AND a.id > COALESCE((SELECT MAX(b.id) FROM activity b WHERE b.nft_id=a.nft_id AND b.type='buy'), 0)`).get(nftId);

app.get("/api/nfts/:id", wrap((req, res) => {
  const nft = db.prepare(NFT_SQL + " WHERE n.id=?").get(Number(req.params.id));
  if (!nft) throw new HttpError(404, "NFT not found.");
  res.json({ nft });
}));

app.post("/api/nfts", needAuth((req, res) => {
  const title = normTitle(req.body.title);
  const price = round(Number(req.body.price));
  if (title.length < 2 || title.length > 40) throw new HttpError(400, "Title: 2–40 characters.");
  const image = req.body.image;
  const validUpload = typeof image === "string" && image.length <= 300000 && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(image);
  if (!validUpload && !IMAGES.includes(image)) throw new HttpError(400, "Upload a JPEG, PNG or WebP image (up to ~200 KB after resizing).");
  if (!(price > 0 && price <= 1000)) throw new HttpError(400, "Price must be between 0 and 1000 ETH.");
  assertNotDuplicate(title, image);
  const endsAt = Date.now() + parseDuration(req.body.duration);
  const id = db.prepare("INSERT INTO nfts(title,image,price,buy_now,ends_in,ends_at,creator_id,seller_id) VALUES(?,?,?,?,?,?,?,?)")
    .run(title, image, price, req.body.buy_now ? 1 : 0, "", endsAt, req.user.id, req.user.id).lastInsertRowid;
  res.status(201).json({ nft: db.prepare(NFT_SQL + " WHERE n.id=?").get(id) });
}));

// Update: продавец меняет свой активный лот (название — только создатель; цену и тип — пока нет ставок)
app.patch("/api/nfts/:id", needAuth((req, res) => {
  const nft = db.prepare("SELECT * FROM nfts WHERE id=?").get(Number(req.params.id));
  if (!nft) throw new HttpError(404, "NFT not found.");
  if (nft.owner_id || nft.seller_id !== req.user.id) throw new HttpError(403, "You can edit only your own active listings.");

  const { title: rawTitle, price: rawPrice, buy_now } = req.body;
  if (rawTitle === undefined && rawPrice === undefined && buy_now === undefined) throw new HttpError(400, "Nothing to update.");

  let title = nft.title;
  if (rawTitle !== undefined) {
    if (nft.creator_id !== req.user.id) throw new HttpError(403, "Only the creator can rename an NFT.");
    title = normTitle(rawTitle);
    if (title.length < 2 || title.length > 40) throw new HttpError(400, "Title: 2–40 characters.");
    assertNotDuplicate(title, null, nft.id);
  }

  let price = nft.price;
  let sale = nft.buy_now;
  if (rawPrice !== undefined || buy_now !== undefined) {
    if (hasBids(nft.id)) throw new HttpError(409, "The price and sale type cannot be changed after bids have been placed.");
    if (rawPrice !== undefined) {
      price = round(Number(rawPrice));
      if (!(price > 0 && price <= 1000)) throw new HttpError(400, "Price must be between 0 and 1000 ETH.");
    }
    if (buy_now !== undefined) sale = buy_now ? 1 : 0;
  }

  db.prepare("UPDATE nfts SET title=?, price=?, buy_now=? WHERE id=?").run(title, price, sale, nft.id);
  res.json({ nft: db.prepare(NFT_SQL + " WHERE n.id=?").get(nft.id) });
}));

app.delete("/api/nfts/:id", needAuth((req, res) => {
  const nft = db.prepare("SELECT * FROM nfts WHERE id=?").get(Number(req.params.id));
  if (!nft) throw new HttpError(404, "NFT not found.");
  if (nft.owner_id || nft.seller_id !== req.user.id) throw new HttpError(403, "You can remove only your own active listings.");
  const wasSold = db.prepare("SELECT 1 FROM activity WHERE nft_id=? AND type='buy'").get(nft.id);
  db.transaction(() => {
    if (nft.creator_id === req.user.id && !wasSold) {
      // собственный лот, который ещё ни разу не продавался — удаляем полностью
      db.prepare("DELETE FROM activity WHERE nft_id=?").run(nft.id);
      db.prepare("DELETE FROM nfts WHERE id=?").run(nft.id);
    } else {
      // NFT был куплен и выставлен повторно — снимаем с продажи, возвращаем в коллекцию
      db.prepare("UPDATE nfts SET owner_id=?, seller_id=NULL, ends_at=NULL WHERE id=?").run(req.user.id, nft.id);
    }
  })();
  res.status(204).end();
}));

/* Resell: owner puts a bought NFT back on the marketplace */
app.post("/api/nfts/:id/sell", needAuth((req, res) => {
  const price = round(Number(req.body.price));
  if (!(price > 0 && price <= 1000)) throw new HttpError(400, "Price must be between 0 and 1000 ETH.");
  const nft = db.prepare("SELECT * FROM nfts WHERE id=?").get(Number(req.params.id));
  if (!nft) throw new HttpError(404, "NFT not found.");
  if (nft.owner_id !== req.user.id) throw new HttpError(403, "You can sell only NFTs from your collection.");
  const endsAt = Date.now() + parseDuration(req.body.duration);
  db.transaction(() => {
    db.prepare("UPDATE nfts SET owner_id=NULL, seller_id=?, price=?, buy_now=?, ends_at=? WHERE id=?")
      .run(req.user.id, price, req.body.buy_now ? 1 : 0, endsAt, nft.id);
    db.prepare("INSERT INTO activity(user_id,nft_id,type,amount) VALUES(?,?,'list',?)").run(req.user.id, nft.id, price);
  })();
  res.json({ nft: db.prepare(NFT_SQL + " WHERE n.id=?").get(nft.id), user: publicUser(db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id)) });
}));

app.get("/api/nfts/:id/bids", wrap((req, res) => {
  res.json({ bids: db.prepare(
    `SELECT u.nickname, a.amount, a.created_at FROM activity a JOIN users u ON u.id=a.user_id
     WHERE a.nft_id=? AND a.type='bid'
       AND a.id > COALESCE((SELECT MAX(b.id) FROM activity b WHERE b.nft_id=a.nft_id AND b.type='buy'), 0)
     ORDER BY a.id DESC LIMIT 10`).all(req.params.id) });
}));

/* ---------- Таймер лотов ---------- */
// Допустимая длительность листинга, в минутах (по умолчанию 24 часа)
const DURATIONS = [1, 5, 60, 1440, 4320];
function parseDuration(value) {
  const minutes = value === undefined || value === null || value === "" ? 1440 : Number(value);
  if (!DURATIONS.includes(minutes)) throw new HttpError(400, "Duration must be one of (minutes): " + DURATIONS.join(", ") + ".");
  return minutes * 60 * 1000;
}

// Продажа: деньги списываются у покупателя и идут продавцу, NFT переходит покупателю
function completeSale(nft, buyerId, price) {
  db.prepare("UPDATE users SET balance=ROUND(balance-?, 4) WHERE id=?").run(price, buyerId);
  db.prepare("UPDATE nfts SET owner_id=?, seller_id=NULL, ends_at=NULL, price=? WHERE id=?").run(buyerId, price, nft.id);
  db.prepare("INSERT INTO activity(user_id,nft_id,type,amount) VALUES(?,?,'buy',?)").run(buyerId, nft.id, price);
  if (nft.seller_id) { // деньги получает продавец
    db.prepare("UPDATE users SET balance=ROUND(balance+?, 4) WHERE id=?").run(price, nft.seller_id);
    db.prepare("INSERT INTO activity(user_id,nft_id,type,amount) VALUES(?,?,'sale',?)").run(nft.seller_id, nft.id, price);
  }
}

// Завершение лота по истечении времени
function settleOne(nft) {
  if (!nft.buy_now) {
    // аукцион: побеждает самая высокая ставка, у которой хватает денег (иначе — следующая)
    const bids = db.prepare(
      `SELECT a.user_id, a.amount FROM activity a WHERE a.nft_id=? AND a.type='bid'
         AND a.id > COALESCE((SELECT MAX(b.id) FROM activity b WHERE b.nft_id=a.nft_id AND b.type='buy'), 0)
       ORDER BY a.amount DESC, a.id ASC`).all(nft.id);
    for (const bid of bids) {
      if (bid.user_id === nft.seller_id) continue;
      const buyer = db.prepare("SELECT balance FROM users WHERE id=?").get(bid.user_id);
      if (buyer && buyer.balance >= bid.amount) { completeSale(nft, bid.user_id, bid.amount); return; }
    }
  }
  if (nft.seller_id) {
    // никто не купил — NFT возвращается продавцу в коллекцию
    db.prepare("UPDATE nfts SET owner_id=seller_id, seller_id=NULL, ends_at=NULL WHERE id=?").run(nft.id);
    db.prepare("INSERT INTO activity(user_id,nft_id,type,amount) VALUES(?,?,'expired',?)").run(nft.seller_id, nft.id, nft.price);
  } else {
    // лот самой площадки (тестовые данные) — просто продлеваем на 24 часа
    db.prepare("UPDATE nfts SET ends_at=? WHERE id=?").run(Date.now() + 24 * 60 * 60 * 1000, nft.id);
  }
}

function settleExpired() {
  const rows = db.prepare("SELECT * FROM nfts WHERE owner_id IS NULL AND ends_at IS NOT NULL AND ends_at <= ?").all(Date.now());
  for (const nft of rows) db.transaction(() => settleOne(nft))();
}
setInterval(() => { try { settleExpired(); } catch (e) { console.error("settle error:", e.message); } }, 5000);

const getNft = (id) => {
  const nft = db.prepare("SELECT * FROM nfts WHERE id=?").get(id);
  if (!nft) throw new HttpError(404, "NFT not found.");
  if (nft.owner_id) throw new HttpError(409, "This NFT is already sold.");
  if (nft.ends_at && nft.ends_at <= Date.now()) throw new HttpError(409, "The time for this NFT is over.");
  return nft;
};

const placeBid = db.transaction((user, nftId, amount) => {
  const nft = getNft(nftId);
  if (nft.seller_id === user.id) throw new HttpError(400, "You cannot bid on your own NFT.");
  if (nft.buy_now) throw new HttpError(400, "This NFT is sold instantly. Use Buy now.");
  if (!(amount > nft.price)) throw new HttpError(400, `Bid must be higher than ${nft.price} ETH.`);
  if (amount > user.balance) throw new HttpError(400, "Not enough balance.");
  db.prepare("UPDATE nfts SET price=? WHERE id=?").run(amount, nftId);
  db.prepare("INSERT INTO activity(user_id,nft_id,type,amount) VALUES(?,?,'bid',?)").run(user.id, nftId, amount);
});

const buyNft = db.transaction((user, nftId) => {
  const nft = getNft(nftId);
  if (nft.seller_id === user.id) throw new HttpError(400, "You cannot buy your own NFT.");
  if (!nft.buy_now) throw new HttpError(400, "This NFT is an auction: place a bid.");
  if (user.balance < nft.price) throw new HttpError(400, "Not enough balance.");
  completeSale(nft, user.id, nft.price);
});

app.post("/api/nfts/:id/bid", needAuth((req, res) => {
  const amount = round(Number(req.body.amount));
  if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(400, "Enter a valid amount.");
  placeBid(req.user, Number(req.params.id), amount);
  res.json({ user: publicUser(db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id)) });
}));

app.post("/api/nfts/:id/buy", needAuth((req, res) => {
  buyNft(req.user, Number(req.params.id));
  res.json({ user: publicUser(db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id)) });
}));

/* Contact form: сообщение сохраняется в таблицу messages */
const CONTACT_TOPICS = ["General question", "Problem with a purchase", "Account and profile", "Partnership"];
const contactLog = new Map(); // ip -> время последних отправок (простая защита от спама)

app.post("/api/contact", wrap((req, res) => {
  const now = Date.now();
  const recent = (contactLog.get(clientIp(req)) || []).filter((t) => now - t < 10 * 60 * 1000);
  if (recent.length >= 5) throw new HttpError(429, "Too many messages. Please try again later.");

  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim();
  const topic = String(req.body.topic || "");
  const message = String(req.body.message || "").trim();
  if (name.length < 2 || name.length > 60) throw new HttpError(400, "Please enter your name.");
  if (email.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new HttpError(400, "Please enter a valid email.");
  if (!CONTACT_TOPICS.includes(topic)) throw new HttpError(400, "Choose a topic.");
  if (message.length < 10 || message.length > 1000) throw new HttpError(400, "Message: 10–1000 characters.");

  const user = currentUser(req); // если пользователь вошёл — привязываем сообщение к аккаунту
  db.prepare("INSERT INTO messages(user_id,name,email,topic,message) VALUES(?,?,?,?,?)")
    .run(user ? user.id : null, name, email, topic, message);
  recent.push(now);
  contactLog.set(clientIp(req), recent);
  res.status(201).json({ ok: true });
}));

app.use("/api", (req, res) => res.status(404).json({ error: "Not found." }));

app.listen(PORT, () => console.log(`DiveSea is running: http://localhost:${PORT}`));
