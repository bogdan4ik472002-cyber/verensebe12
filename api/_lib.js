// Общие функции: Telegram API, база (Upstash Redis через REST), проверка подписи Mini App.
// Файл начинается с "_" — Vercel не делает из него отдельный адрес.
const crypto = require("crypto");

const BOT_TOKEN = process.env.BOT_TOKEN;

// ---------- Telegram ----------
async function tg(method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const j = await r.json();
  if (!j.ok) console.error("tg error", method, j);
  return j;
}

// ---------- База (Upstash Redis REST) ----------
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(...cmd) {
  const r = await fetch(REDIS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  const j = await r.json();
  if (j.error) throw new Error("redis: " + j.error);
  return j.result;
}

async function getUser(id) {
  const v = await redis("GET", `user:${id}`);
  return v ? JSON.parse(v) : null;
}

async function saveUser(u) {
  await redis("SET", `user:${u.tg_id}`, JSON.stringify(u));
}

// ---------- Проверка, что данные Mini App пришли действительно от Telegram ----------
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
function checkInitData(initData, maxAgeSec = 24 * 3600) {
  if (!initData) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get("hash");
  if (!hash) return null;
  p.delete("hash");
  const dataCheck = [...p.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const calc = crypto.createHmac("sha256", secret).update(dataCheck).digest("hex");
  if (calc.length !== hash.length ||
      !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
  const age = Date.now() / 1000 - Number(p.get("auth_date") || 0);
  if (age > maxAgeSec) return null;
  try { return JSON.parse(p.get("user")); } catch { return null; }
}

// ---------- Админы (кому приходят заявки и демки) ----------
async function getAdmins() {
  return ((await redis("SMEMBERS", "admins")) || []).map(Number);
}

const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

function fmtPhone(p) {
  const d = String(p || "").replace(/\D/g, "");
  if (d.length === 11 && (d[0] === "7" || d[0] === "8"))
    return `+7 ${d.slice(1, 4)} ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9)}`;
  return d ? "+" + d : "";
}

module.exports = { tg, redis, getUser, saveUser, checkInitData, getAdmins, esc, fmtPhone };
