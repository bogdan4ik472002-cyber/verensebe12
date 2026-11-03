// Список заявок для панели наставника. Отдаём только админам.
const { redis, checkInitData, isAdmin } = require("./_lib");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).send("method not allowed");
  const tgUser = checkInitData(req.body && req.body.initData);
  if (!tgUser) return res.status(401).json({ error: "bad initData" });
  if (!(await isAdmin(tgUser.id))) return res.status(403).json({ error: "not admin" });

  const raw = (await redis("LRANGE", "leads", 0, 499)) || [];
  const leads = raw.map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);

  // «сегодня» считаем по московскому времени
  const mskDay = (d) => new Date(d).toLocaleDateString("ru-RU", { timeZone: "Europe/Moscow" });
  const today = mskDay(Date.now());
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;

  res.status(200).json({
    leads,
    stats: {
      total: await redis("LLEN", "leads"),
      today: leads.filter((l) => mskDay(l.created_at) === today).length,
      week: leads.filter((l) => new Date(l.created_at).getTime() >= weekAgo).length,
      users: await redis("SCARD", "users"),
    },
  });
};
