// Вебхук бота: сюда Telegram присылает все сообщения, которые пишут @sebeverenbot.
const { tg, redis, getUser, saveUser, getAdmins, esc, fmtPhone } = require("./_lib");

const WEBAPP_URL = process.env.WEBAPP_URL; // например https://verensebe12.vercel.app

const WELCOME =
  "Добро пожаловать в обучение от <b>Верен себе</b> 🎤\n\n" +
  "Чтобы зарегистрироваться, нажми кнопку <b>«Поделиться профилем»</b> внизу — " +
  "данные сами подтянутся в твой профиль в приложении.";

const SHARE_KB = {
  keyboard: [[{ text: "📱 Поделиться профилем", request_contact: true }]],
  resize_keyboard: true,
  one_time_keyboard: true,
};

const appKb = () => ({
  inline_keyboard: [[{ text: "🎧 Открыть приложение", web_app: { url: WEBAPP_URL } }]],
});

const REVIEW_ASK =
  "🎧 <b>Бесплатный разбор трека</b>\n\n" +
  "Пришли сюда свой трек — файлом, ссылкой или голосовым. " +
  "Я послушаю и отвечу, что круто и что подтянуть.";
const REVIEW_KB = { inline_keyboard: [[{ text: "🎧 Бесплатный разбор трека", callback_data: "review" }]] };

async function askForTrack(chat_id, uid) {
  await redis("SET", `await_review:${uid}`, "1", "EX", 7 * 24 * 3600);
  return tg("sendMessage", { chat_id, text: REVIEW_ASK, parse_mode: "HTML", reply_markup: { remove_keyboard: true } });
}

const isMedia = (m) => m.audio || m.voice || m.document || m.video || m.video_note;

async function handle(m) {
  const chat_id = m.chat.id;
  const text = (m.text || "").trim();

  // 1) Стать админом: /admin <WEBHOOK_SECRET>
  if (text.startsWith("/admin")) {
    if (text.split(/\s+/)[1] === process.env.WEBHOOK_SECRET) {
      await redis("SADD", "admins", String(m.from.id));
      return tg("sendMessage", { chat_id, text: "Готово 👑 Теперь заявки и демки будут приходить сюда." });
    }
    return tg("sendMessage", { chat_id, text: "Неверный код." });
  }
  if (text === "/unadmin") {
    await redis("SREM", "admins", String(m.from.id));
    return tg("sendMessage", { chat_id, text: "Больше не присылаю сюда заявки." });
  }

  // 1б) Пришёл по ссылке t.me/sebeverenbot?start=review или из кнопки в приложении
  if (text === "/start review" || text === "/review") {
    if (!(await getUser(m.from.id))) {
      await redis("SET", `pending_review:${m.from.id}`, "1", "EX", 7 * 24 * 3600);
      return tg("sendMessage", {
        chat_id, parse_mode: "HTML", reply_markup: SHARE_KB,
        text: "Привет! Разберу твой трек бесплатно 🎧\n\nСначала нажми <b>«Поделиться профилем»</b> внизу — так я буду знать, кому ответить.",
      });
    }
    return askForTrack(chat_id, m.from.id);
  }

  // 2) Поделился контактом → регистрация
  if (m.contact) {
    // принимаем только свой контакт, а не пересланный чужой
    if (m.contact.user_id !== m.from.id) {
      return tg("sendMessage", {
        chat_id, text: "Нужно поделиться именно своим профилем — нажми кнопку ниже 👇",
        reply_markup: SHARE_KB,
      });
    }
    const old = await getUser(m.from.id);
    await saveUser({
      tg_id: m.from.id,
      first_name: m.contact.first_name || m.from.first_name || "",
      last_name: m.contact.last_name || m.from.last_name || "",
      username: m.from.username || "",
      phone: m.contact.phone_number,
      registered_at: (old && old.registered_at) || new Date().toISOString(),
    });
    await tg("sendMessage", { chat_id, text: "Готово, ты зарегистрирован ✅", reply_markup: { remove_keyboard: true } });
    if ((await redis("GET", `pending_review:${m.from.id}`)) === "1") {
      await redis("DEL", `pending_review:${m.from.id}`);
      return askForTrack(chat_id, m.from.id);
    }
    return tg("sendMessage", { chat_id, text: "Открывай приложение — профиль уже заполнен:", reply_markup: appKb() });
  }

  const user = await getUser(m.from.id);

  const review = (await redis("GET", `await_review:${m.from.id}`)) === "1";
  const isLink = review && /https?:\/\/\S+/i.test(text);

  // 3) Прислал аудио / файл / голосовое (или ссылку на трек при разборе) → пересылаем наставнику
  if (isMedia(m) || isLink) {
    const admins = await getAdmins();
    const who = user
      ? `${esc([user.first_name, user.last_name].filter(Boolean).join(" "))}` +
        (user.username ? ` · @${esc(user.username)}` : "") +
        (user.phone ? ` · ${esc(fmtPhone(user.phone))}` : "")
      : `${esc(m.from.first_name || "")}${m.from.username ? " · @" + esc(m.from.username) : ""}`;
    for (const id of admins) {
      if (id === m.from.id) continue;
      await tg("sendMessage", {
        chat_id: id, parse_mode: "HTML",
        text: `${review ? "🆓 <b>Бесплатный разбор трека</b>" : "🎧 <b>Демка</b>"} от ${who}\n<a href="tg://user?id=${m.from.id}">Открыть профиль</a>`,
      });
      await tg("copyMessage", { chat_id: id, from_chat_id: chat_id, message_id: m.message_id });
    }
    await redis("DEL", `await_demo:${m.from.id}`, `await_review:${m.from.id}`);
    if (review) {
      return tg("sendMessage", {
        chat_id,
        text: "Трек у меня 🔥 Послушаю и отвечу сюда.\n\nА пока — приходи на бесплатный урок: познакомимся и разберём твою музыку вживую.",
        reply_markup: appKb(),
      });
    }
    return tg("sendMessage", {
      chat_id,
      text: "Демка получена 🔥 Наставник послушает и напишет тебе.",
      reply_markup: user ? appKb() : SHARE_KB,
    });
  }

  // 4) Любой другой текст
  if (review) return tg("sendMessage", { chat_id, text: "Жду трек 🎧 Пришли файл, ссылку или голосовое." });
  if (user) {
    return tg("sendMessage", { chat_id, text: "С возвращением! Открывай приложение 👇", reply_markup: { inline_keyboard: [...appKb().inline_keyboard, ...REVIEW_KB.inline_keyboard] } });
  }
  return tg("sendMessage", { chat_id, text: WELCOME, parse_mode: "HTML", reply_markup: SHARE_KB });
}

module.exports = async (req, res) => {
  // принимаем запросы только от Telegram (секрет задаётся при установке вебхука)
  if (req.method !== "POST" ||
      req.headers["x-telegram-bot-api-secret-token"] !== process.env.WEBHOOK_SECRET) {
    return res.status(403).send("forbidden");
  }
  const cq = req.body && req.body.callback_query;
  if (cq && cq.data === "review" && cq.message) {
    try {
      await tg("answerCallbackQuery", { callback_query_id: cq.id });
      if (await getUser(cq.from.id)) await askForTrack(cq.message.chat.id, cq.from.id);
      else await handle({ ...cq.message, from: cq.from, text: "/review", contact: undefined });
    } catch (e) { console.error(e); }
    return res.status(200).send("ok");
  }
  const m = req.body && req.body.message;
  if (m && m.from && m.chat.type === "private") {
    try { await handle(m); } catch (e) { console.error(e); }
  }
  // всегда отвечаем 200, иначе Telegram будет повторять одно и то же сообщение
  res.status(200).send("ok");
};
