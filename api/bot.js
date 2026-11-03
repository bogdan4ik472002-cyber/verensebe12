// Вебхук бота: сюда Telegram присылает все сообщения, которые пишут @sebeverenbot.
const { tg, getUser, saveUser } = require("./_lib");

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

module.exports = async (req, res) => {
  // принимаем запросы только от Telegram (секрет задаётся при установке вебхука)
  if (req.method !== "POST" ||
      req.headers["x-telegram-bot-api-secret-token"] !== process.env.WEBHOOK_SECRET) {
    return res.status(403).send("forbidden");
  }

  const m = req.body && req.body.message;
  if (!m || !m.from || m.chat.type !== "private") return res.status(200).send("ok");
  const chat_id = m.chat.id;

  try {
    if (m.contact) {
      // принимаем только свой контакт, а не пересланный чужой
      if (m.contact.user_id !== m.from.id) {
        await tg("sendMessage", {
          chat_id, text: "Нужно поделиться именно своим профилем — нажми кнопку ниже 👇",
          reply_markup: SHARE_KB,
        });
      } else {
        const old = await getUser(m.from.id);
        await saveUser({
          tg_id: m.from.id,
          first_name: m.contact.first_name || m.from.first_name || "",
          last_name: m.contact.last_name || m.from.last_name || "",
          username: m.from.username || "",
          phone: m.contact.phone_number,
          registered_at: (old && old.registered_at) || new Date().toISOString(),
        });
        await tg("sendMessage", {
          chat_id, text: "Готово, ты зарегистрирован ✅",
          reply_markup: { remove_keyboard: true },
        });
        await tg("sendMessage", {
          chat_id, text: "Открывай приложение — профиль уже заполнен:",
          reply_markup: appKb(),
        });
      }
    } else if (await getUser(m.from.id)) {
      await tg("sendMessage", { chat_id, text: "С возвращением! Открывай приложение 👇", reply_markup: appKb() });
    } else {
      await tg("sendMessage", { chat_id, text: WELCOME, parse_mode: "HTML", reply_markup: SHARE_KB });
    }
  } catch (e) {
    console.error(e);
  }
  // всегда отвечаем 200, иначе Telegram будет повторять одно и то же сообщение
  res.status(200).send("ok");
};
