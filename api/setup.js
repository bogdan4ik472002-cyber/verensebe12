// Одноразовая настройка: открой в браузере
//   https://<твой-сайт>.vercel.app/api/setup?secret=<WEBHOOK_SECRET>
// — бот начнёт получать сообщения через /api/bot, а кнопка меню будет открывать приложение.
const { tg } = require("./_lib");

module.exports = async (req, res) => {
  if (!process.env.WEBHOOK_SECRET || req.query.secret !== process.env.WEBHOOK_SECRET) {
    return res.status(403).send("forbidden");
  }
  const base = `https://${req.headers.host}`;
  const hook = await tg("setWebhook", {
    url: `${base}/api/bot`,
    secret_token: process.env.WEBHOOK_SECRET,
    allowed_updates: ["message"],
    drop_pending_updates: true,
  });
  const menu = await tg("setChatMenuButton", {
    menu_button: { type: "web_app", text: "Приложение", web_app: { url: process.env.WEBAPP_URL || base } },
  });
  const info = await tg("getWebhookInfo", {});
  res.status(200).json({ webhook: hook, menu_button: menu, info: info.result });
};
