// Заявка из приложения → сообщение наставнику (всем админам) в Telegram.
const { tg, redis, getUser, checkInitData, getAdmins, esc, fmtPhone } = require("./_lib");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).send("method not allowed");
  const b = req.body || {};
  const tgUser = checkInitData(b.initData);
  if (!tgUser) return res.status(401).json({ error: "bad initData" });

  // не чаще одной заявки в минуту от одного человека
  const lock = await redis("SET", `lead_lock:${tgUser.id}`, "1", "NX", "EX", 60);
  if (lock !== "OK") return res.status(429).json({ error: "too_often" });

  const u = (await getUser(tgUser.id)) || {};
  const lead = {
    tg_id: tgUser.id,
    level: String(b.level || "—").slice(0, 80),
    name: String(b.name || "").slice(0, 120),
    contact: String(b.contact || "").slice(0, 80),
    username: tgUser.username || u.username || "",
    phone: u.phone || "",
    created_at: new Date().toISOString(),
  };
  await redis("LPUSH", "leads", JSON.stringify(lead));
  await redis("SET", `await_demo:${tgUser.id}`, "1", "EX", 3 * 24 * 3600);

  const text =
    "🆕 <b>Новая заявка</b>\n\n" +
    `<b>Уровень:</b> ${esc(lead.level)}\n` +
    `<b>ФИО:</b> ${esc(lead.name)}\n` +
    `<b>Контакт:</b> ${esc(lead.contact)}\n` +
    (lead.username ? `<b>Ник:</b> @${esc(lead.username)}\n` : "") +
    (lead.phone ? `<b>Телефон:</b> ${esc(fmtPhone(lead.phone))}\n` : "") +
    `\n<a href="tg://user?id=${lead.tg_id}">Открыть профиль</a>`;
  const kb = lead.username
    ? { inline_keyboard: [[{ text: "✉️ Написать", url: `https://t.me/${lead.username}` }]] }
    : undefined;

  const admins = await getAdmins();
  for (const id of admins) {
    await tg("sendMessage", { chat_id: id, text, parse_mode: "HTML", reply_markup: kb });
  }
  if (!admins.length) console.warn("lead received but no admins registered");

  // просим демку прямо в чате бота
  await tg("sendMessage", {
    chat_id: tgUser.id,
    text: "Заявка принята ✅\n\nПришли сюда свою демку — аудиофайлом или голосовым, " +
          "я передам её наставнику. Он напишет тебе в Telegram.",
  });

  res.status(200).json({ ok: true });
};
