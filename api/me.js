// Приложение спрашивает «кто я?» — отдаём профиль из базы.
// Подпись initData проверяется, поэтому чужой профиль так не получить.
const { getUser, checkInitData } = require("./_lib");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).send("method not allowed");
  const tgUser = checkInitData(req.body && req.body.initData);
  if (!tgUser) return res.status(401).json({ error: "bad initData" });

  let u = null;
  try { u = await getUser(tgUser.id); } catch (e) { console.error(e); }

  res.status(200).json({
    registered: !!u,
    tg_id: tgUser.id,
    first_name: (u && u.first_name) || tgUser.first_name || "",
    last_name: (u && u.last_name) || tgUser.last_name || "",
    username: tgUser.username || (u && u.username) || "",
    photo_url: tgUser.photo_url || "",
    phone: (u && u.phone) || "",
  });
};
