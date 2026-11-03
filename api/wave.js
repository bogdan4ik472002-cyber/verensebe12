// «Волна» — общая лента треков участников.
// Один адрес /api/wave, действие передаётся в поле action.
// Аудио и обложки лежат в Vercel Blob (загружаются с телефона напрямую), данные — в Redis.
const crypto = require("crypto");
const { tg, redis, pipe, getUser, checkInitData, isAdmin, esc } = require("./_lib");

const AUDIO_MAX = 20 * 1024 * 1024; // 20 МБ
const COVER_MAX = 3 * 1024 * 1024;  // 3 МБ (обложку сжимаем на телефоне)
const DAILY_UPLOADS = 5;            // не больше 5 треков в день от одного человека
const LEVELS = { start: "START", beginner: "BUILD", artist: "GROW" };
const WEBAPP_URL = process.env.WEBAPP_URL;

const J = (s) => { try { return JSON.parse(s); } catch { return null; } };
const mskDate = () => new Date().toLocaleDateString("ru-RU", { timeZone: "Europe/Moscow" });
const BLOB_HOST_RE = /^https:\/\/[a-z0-9]+\.public\.blob\.vercel-storage\.com\//i;

// карточка трека + счётчики (лайки, прослушивания, комментарии, лайкнул ли я)
async function hydrate(ids, me) {
  if (!ids.length) return [];
  const cmds = [];
  for (const id of ids) {
    cmds.push(["GET", `track:${id}`], ["SCARD", `likes:${id}`], ["GET", `plays:${id}`],
              ["LLEN", `comments:${id}`], ["SISMEMBER", `likes:${id}`, String(me)]);
  }
  const r = await pipe(cmds);
  const out = [];
  ids.forEach((id, i) => {
    const t = J(r[i * 5]);
    if (!t) return;
    out.push({ ...t, likes: r[i * 5 + 1] || 0, plays: Number(r[i * 5 + 2] || 0),
               comments: r[i * 5 + 3] || 0, liked: r[i * 5 + 4] === 1 });
  });
  return out;
}

// «Горячее»: лайки и прослушивания, но свежие треки весят больше
const hotScore = (t) => (t.likes * 3 + t.plays + t.comments * 2 + (t.mentor ? 10 : 0)) /
  Math.pow((Date.now() - t.created) / 3600e3 + 2, 1.3);

async function blobToken(pathname, max, types) {
  const { generateClientTokenFromReadWriteToken } = require("@vercel/blob/client");
  return generateClientTokenFromReadWriteToken({
    pathname, maximumSizeInBytes: max, allowedContentTypes: types,
    addRandomSuffix: true, validUntil: Date.now() + 30 * 60 * 1000,
  });
}

const actions = {
  // 1) разрешение загрузить файл (аудио или обложку)
  async upload_token({ me, b }) {
    if (!process.env.BLOB_READ_WRITE_TOKEN) return { status: 500, error: "no_blob_store" };
    const kind = b.kind === "cover" ? "cover" : "audio";
    const ext = String(b.filename || "").split(".").pop().toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5) || (kind === "cover" ? "jpg" : "mp3");
    const pathname = `wave/${me}/${kind}-${Date.now()}.${ext}`;
    const token = kind === "cover"
      ? await blobToken(pathname, COVER_MAX, ["image/*"])
      : await blobToken(pathname, AUDIO_MAX, ["audio/*", "video/mp4", "application/octet-stream"]);
    return { token, pathname };
  },

  // 2) опубликовать трек после загрузки файлов
  async create({ me, user, tgUser, b }) {
    if (!user) return { status: 403, error: "not_registered" };
    const audio = String(b.audio || "");
    const cover = String(b.cover || "");
    const mine = (u) => BLOB_HOST_RE.test(u) && new URL(u).pathname.startsWith(`/wave/${me}/`);
    if (!mine(audio) || (cover && !mine(cover))) return { status: 400, error: "bad_file" };
    const title = String(b.title || "").trim().slice(0, 60);
    if (!title) return { status: 400, error: "no_title" };

    const cnt = await redis("INCR", `upcount:${me}:${mskDate()}`);
    if (cnt === 1) await redis("EXPIRE", `upcount:${me}:${mskDate()}`, 86400);
    if (cnt > DAILY_UPLOADS) return { status: 429, error: "daily_limit" };

    const peaks = Array.isArray(b.peaks) ? b.peaks.slice(0, 120).map((x) => Math.max(0, Math.min(1, Number(x) || 0))) : [];
    const t = {
      id: crypto.randomBytes(6).toString("hex"),
      uid: me,
      author: String(b.author || [user.first_name, user.last_name].filter(Boolean).join(" ") || "Участник").trim().slice(0, 40),
      username: tgUser.username || user.username || "",
      photo: tgUser.photo_url || "",
      level: LEVELS[b.level] ? b.level : "start",
      title, audio, cover,
      dur: Math.max(0, Math.min(3600, Number(b.dur) || 0)),
      peaks,
      created: Date.now(),
      mentor: null,
    };
    await pipe([
      ["SET", `track:${t.id}`, JSON.stringify(t)],
      ["ZADD", "tracks", t.created, t.id],
      ["ZADD", `utracks:${me}`, t.created, t.id],
    ]);
    return { track: t };
  },

  // 3) лента: new | hot | picks (выбор наставника) | liked (мои лайки)
  async feed({ me, b }) {
    let ids;
    if (b.sort === "picks") ids = await redis("ZREVRANGE", "picks", 0, 49);
    else if (b.sort === "liked") ids = (await redis("SMEMBERS", `ulikes:${me}`)) || [];
    else ids = await redis("ZREVRANGE", "tracks", 0, b.sort === "hot" ? 299 : 49);
    let list = await hydrate(ids || [], me);
    if (b.sort === "hot") list = list.sort((a, c) => hotScore(c) - hotScore(a)).slice(0, 50);
    if (b.sort === "liked") list = list.sort((a, c) => c.created - a.created);
    return { tracks: list };
  },

  // 4) один трек + комментарии
  async track({ me, b }) {
    const [t] = await hydrate([String(b.id)], me);
    if (!t) return { status: 404, error: "not_found" };
    const raw = (await redis("LRANGE", `comments:${t.id}`, 0, 499)) || [];
    return { track: t, comments: raw.map(J).filter(Boolean) };
  },

  async like({ me, b }) {
    const id = String(b.id);
    if (!(await redis("EXISTS", `track:${id}`))) return { status: 404, error: "not_found" };
    const was = (await redis("SISMEMBER", `likes:${id}`, String(me))) === 1;
    if (was) await pipe([["SREM", `likes:${id}`, String(me)], ["SREM", `ulikes:${me}`, id]]);
    else await pipe([["SADD", `likes:${id}`, String(me)], ["SADD", `ulikes:${me}`, id]]);
    return { liked: !was, likes: await redis("SCARD", `likes:${id}`) };
  },

  // прослушивание засчитывается не чаще раза в 30 минут от одного человека
  async play({ me, b }) {
    const id = String(b.id);
    const ok = await redis("SET", `playlock:${id}:${me}`, "1", "NX", "EX", 1800);
    if (ok === "OK" && (await redis("EXISTS", `track:${id}`))) await redis("INCR", `plays:${id}`);
    return { ok: true };
  },

  // комментарий на таймкоде
  async comment({ me, user, tgUser, b }) {
    if (!user) return { status: 403, error: "not_registered" };
    const id = String(b.id);
    const text = String(b.text || "").trim().slice(0, 300);
    if (!text) return { status: 400, error: "empty" };
    if (!(await redis("EXISTS", `track:${id}`))) return { status: 404, error: "not_found" };
    const lock = await redis("SET", `cmlock:${me}`, "1", "NX", "EX", 3);
    if (lock !== "OK") return { status: 429, error: "too_fast" };
    const c = {
      uid: me, name: [user.first_name, user.last_name].filter(Boolean).join(" ") || "Участник",
      photo: tgUser.photo_url || "", t: Math.max(0, Math.round(Number(b.t) || 0)), text,
      created: Date.now(), mentor: await isAdmin(me),
    };
    await redis("RPUSH", `comments:${id}`, JSON.stringify(c));
    return { comment: c };
  },

  // удалить: автор или наставник
  async del({ me, b }) {
    const id = String(b.id);
    const t = J(await redis("GET", `track:${id}`));
    if (!t) return { status: 404, error: "not_found" };
    if (t.uid !== me && !(await isAdmin(me))) return { status: 403, error: "forbidden" };
    const likers = (await redis("SMEMBERS", `likes:${id}`)) || [];
    await pipe([
      ["DEL", `track:${id}`, `likes:${id}`, `plays:${id}`, `comments:${id}`],
      ["ZREM", "tracks", id], ["ZREM", "picks", id], ["ZREM", `utracks:${t.uid}`, id],
      ...likers.map((u) => ["SREM", `ulikes:${u}`, id]),
    ]);
    try {
      // файлы удаляем «в фоне»: если хранилище тормозит, не держим человека дольше 4 секунд
      const { del } = require("@vercel/blob");
      await Promise.race([del([t.audio, t.cover].filter(Boolean)), new Promise((r) => setTimeout(r, 4000))]);
    } catch (e) { console.error("blob del", e.message); }
    return { ok: true };
  },

  // оценка наставника: бейдж + разбор, трек попадает в «Выбор наставника»
  async mentor({ me, b }) {
    if (!(await isAdmin(me))) return { status: 403, error: "forbidden" };
    const id = String(b.id);
    const t = J(await redis("GET", `track:${id}`));
    if (!t) return { status: 404, error: "not_found" };
    if (b.remove) {
      t.mentor = null;
      await pipe([["SET", `track:${id}`, JSON.stringify(t)], ["ZREM", "picks", id]]);
      return { track: t };
    }
    const first = !t.mentor;
    t.mentor = { text: String(b.text || "").trim().slice(0, 600), at: Date.now() };
    await pipe([["SET", `track:${id}`, JSON.stringify(t)], ["ZADD", "picks", Date.now(), id]]);
    if (first) {
      await tg("sendMessage", {
        chat_id: t.uid, parse_mode: "HTML",
        text: `🔥 <b>Верен себе оценил твой трек</b> «${esc(t.title)}»` +
              (t.mentor.text ? `\n\n${esc(t.mentor.text)}` : "") +
              "\n\nТрек попал в подборку «Выбор наставника».",
        reply_markup: { inline_keyboard: [[{ text: "🎧 Открыть «Волну»", web_app: { url: WEBAPP_URL + "/?p=wave" } }]] },
      });
    }
    return { track: t };
  },

  // страница артиста
  async artist({ me, b }) {
    const uid = Number(b.uid);
    const ids = (await redis("ZREVRANGE", `utracks:${uid}`, 0, 99)) || [];
    const tracks = await hydrate(ids, me);
    const u = await getUser(uid);
    const first = tracks[0];
    return {
      artist: {
        uid,
        name: (first && first.author) || (u && [u.first_name, u.last_name].filter(Boolean).join(" ")) || "Участник",
        username: (u && u.username) || (first && first.username) || "",
        photo: (first && first.photo) || "",
        level: first ? first.level : "start",
        tracks: tracks.length,
        likes: tracks.reduce((s, t) => s + t.likes, 0),
        plays: tracks.reduce((s, t) => s + t.plays, 0),
        picks: tracks.filter((t) => t.mentor).length,
      },
      tracks,
    };
  },
};

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).send("method not allowed");
  const b = req.body || {};
  const tgUser = checkInitData(b.initData);
  if (!tgUser) return res.status(401).json({ error: "bad initData" });
  const fn = actions[b.action];
  if (!fn) return res.status(400).json({ error: "unknown action" });
  try {
    const me = tgUser.id;
    const user = await getUser(me);
    const out = await fn({ me, user, tgUser, b });
    const { status = 200, ...rest } = out || {};
    res.status(status).json(rest);
  } catch (e) {
    console.error(b.action, e);
    res.status(500).json({ error: "server" });
  }
};
