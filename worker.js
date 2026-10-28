// Настройки читаются из KV (ключ "cfg", правится в админке). Если там пусто, берётся config.json с сайта.
const SITE = "https://kennaiki.github.io";
const CONFIG_URL = SITE + "/barbershop-demo/config.json";
const CONSENT_VERSION = "26.10.2026";
const DAYKEYS = { "Пн":1, "Вт":2, "Ср":3, "Чт":4, "Пт":5, "Сб":6, "Вс":0 };
const hm = m => String(Math.floor(m/60)).padStart(2,"0") + ":" + (m%60 ? "30" : "00");
const TTL = { expirationTtl: 60*86400 };
const enc = new TextEncoder();

const parseHours = o => {
  const r = {};
  for (const k in o) {
    const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(String(o[k]).trim());
    if (m && k in DAYKEYS) r[DAYKEYS[k]] = [+m[1] + m[2]/60, +m[3] + m[4]/60];
  }
  return r;
};
async function rawCfg(env) {
  const s = await env.SLOTS.get("cfg");
  if (s) return JSON.parse(s);
  const r = await fetch(CONFIG_URL, { cf: { cacheTtl: 60, cacheEverything: true } });
  if (!r.ok) throw new Error("config");
  return r.json();
}
const compile = c => {
  const v = { ahead: c.ahead, services: Object.create(null), masters: Object.create(null) };
  for (const s of c.services) v.services[s.name] = s.minutes;
  for (const m of c.masters) v.masters[m.id] = { name: m.name, h: parseHours(m.hours) };
  return v;
};
let cache = { t: 0, v: null };
async function getCfg(env) {
  if (cache.v && Date.now() - cache.t < 15000) return cache.v;
  const v = compile(await rawCfg(env));
  cache = { t: Date.now(), v };
  return v;
}

function validate(c) {
  const str = (v, n) => typeof v === "string" && v.length <= n;
  if (!c || typeof c !== "object") return "Неверный формат данных";
  if (!Number.isInteger(c.ahead) || c.ahead < 1 || c.ahead > 120) return "Дней вперёд: число от 1 до 120";
  const s = c.shop;
  if (!s || !str(s.name, 60) || !s.name.trim() || !str(s.address, 120) || !str(s.note, 120) || !str(s.phone, 30)
    || !Array.isArray(s.hours) || s.hours.length > 10
    || !s.hours.every(r => Array.isArray(r) && r.length === 2 && str(r[0], 30) && str(r[1], 30)))
    return "Проверьте данные салона";
  if (!Array.isArray(c.services) || !c.services.length || c.services.length > 30) return "Нужна хотя бы одна услуга";
  const names = new Set();
  for (const x of c.services) {
    if (!x || !str(x.name, 80) || !x.name.trim() || names.has(x.name) || !str(x.desc, 120)
      || !Number.isInteger(x.minutes) || x.minutes < 10 || x.minutes > 480
      || !Number.isFinite(x.price) || x.price < 0 || x.price > 1e6)
      return "Проверьте услугу: " + (x && x.name || "без названия") + " (названия не должны повторяться)";
    names.add(x.name);
  }
  if (!Array.isArray(c.masters) || !c.masters.length || c.masters.length > 30) return "Нужен хотя бы один мастер";
  const ids = new Set();
  for (const m of c.masters) {
    if (!m || !/^m\d{1,3}$/.test(m.id) || ids.has(m.id) || !str(m.name, 60) || !m.name.trim()
      || !str(m.exp, 30) || !m.hours || typeof m.hours !== "object") return "Проверьте мастера: " + (m && m.name || "без имени");
    ids.add(m.id);
    for (const k of Object.keys(m.hours)) {
      if (!(k in DAYKEYS)) return "Неверный день у мастера " + m.name;
      const v = String(m.hours[k]).trim();
      if (v === "") continue;
      const p = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(v);
      if (!p) return m.name + ", " + k + ": формат часов 10:00-21:00";
      const a = +p[1] + p[2]/60, b = +p[3] + p[4]/60;
      if (a*2 % 1 !== 0 || b*2 % 1 !== 0 || a >= b || b > 24) return m.name + ", " + k + ": время кратно 30 минутам, начало раньше конца";
    }
  }
  return null;
}

// ---- авторизация администратора ----
const safeEq = (a, b) => { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; };
async function sign(env, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode(env.ADMIN_PASSWORD), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const s = await crypto.subtle.sign("HMAC", k, enc.encode(msg));
  return [...new Uint8Array(s)].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function checkToken(env, request) {
  const t = (request.headers.get("Authorization") || "").replace(/^Bearer /, "");
  const [exp, sig] = t.split(".");
  if (!exp || !sig || +exp < Date.now()) return false;
  return safeEq(sig, await sign(env, exp));
}

// ---- записи ----
async function createBooking(C, env, data, manual) {
  const clean = (v, n) => String(v ?? "").trim().slice(0, n);
  const name = clean(data.name, 80) || (manual ? "Запись администратора" : "");
  const phone = clean(data.phone, 30) || (manual ? "—" : "");
  const service = clean(data.service, 80), date = clean(data.date, 10), time = clean(data.time, 5);
  const label = clean(data.label, 40), master = clean(data.master, 8);
  const dur = C.services[service], M = C.masters[master];
  if (!manual && data.consent !== true) return [400, "consent", "Нужно согласие"];
  if (!name || !phone || !dur || !M || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:(00|30)$/.test(time))
    return [400, "bad fields", "Проверьте поля: услуга, мастер, дата и время (:00 или :30)"];
  const t = new Date(date + "T00:00:00Z").getTime(), now = Date.now();
  if (isNaN(t) || t < now - 2*864e5 || t > now + (C.ahead + 2)*864e5) return [400, "closed", "Дата вне допустимого диапазона"];
  const start = +time.slice(0, 2) * 60 + (time.endsWith("30") ? 30 : 0);
  const h = M.h[new Date(t).getUTCDay()];
  if (!h || start < h[0]*60 || start + dur > h[1]*60) return [400, "closed", "В это время мастер не работает или услуга не помещается в график"];
  const need = [];
  for (let m = start; m < start + dur; m += 30) need.push(hm(m));
  const key = "d:" + master + ":" + date;
  const busy = JSON.parse((await env.SLOTS.get(key)) || "[]");
  if (need.some(c => busy.includes(c))) return [409, "taken", "Это время уже занято"];
  await env.SLOTS.put(key, JSON.stringify(busy.concat(need)), TTL);
  const id = crypto.randomUUID().slice(0, 8);
  const rec = { master, date, time, cells: need, name, phone, service, label: label || date,
    status: manual ? "ok" : "new", manual: !!manual, at: new Date().toISOString() };
  await env.SLOTS.put("b:" + id, JSON.stringify(rec), TTL);
  return [200, "ok", "", { id, rec, M, key, busy }];
}
async function cancelBooking(env, id) {
  const bk = JSON.parse((await env.SLOTS.get("b:" + id)) || "null");
  if (!bk) return null;
  const key = "d:" + bk.master + ":" + bk.date;
  const busy = JSON.parse((await env.SLOTS.get(key)) || "[]").filter(c => !bk.cells.includes(c));
  await env.SLOTS.put(key, JSON.stringify(busy), TTL);
  await env.SLOTS.delete("b:" + id);
  return bk;
}
async function confirmBooking(env, id) {
  const bk = JSON.parse((await env.SLOTS.get("b:" + id)) || "null");
  if (!bk) return null;
  bk.status = "ok";
  await env.SLOTS.put("b:" + id, JSON.stringify(bk), TTL);
  return bk;
}

export default {
  async fetch(request, env, ctx) {
    const cors = {
      "Access-Control-Allow-Origin": SITE,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };
    const json = (o, s = 200) => new Response(JSON.stringify(o), {
      status: s, headers: { ...cors, "Content-Type": "application/json" } });
    const tg = (m, b) => fetch("https://api.telegram.org/bot" + env.BOT_TOKEN + "/" + m, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
    const path = new URL(request.url).pathname;

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    // Нажатия на кнопки в Telegram
    if (request.method === "POST" && path === "/tg") {
      if (!env.WEBHOOK_SECRET || request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET)
        return new Response("forbidden", { status: 403 });
      const u = await request.json().catch(() => ({}));
      const cq = u.callback_query;
      if (!cq || String(cq.message?.chat?.id) !== String(env.CHAT_ID)) return new Response("ok");
      const [act, id] = String(cq.data || "").split(":");
      let bk = null, mark = "", markup;
      if (act === "ok") {
        bk = await confirmBooking(env, id);
        mark = "\n\n✅ Подтверждено";
        markup = { inline_keyboard: [[{ text: "❌ Отменить", callback_data: "no:" + id }]] };
      }
      if (act === "no") { bk = await cancelBooking(env, id); mark = "\n\n❌ Отменено, время снова свободно"; }
      await tg("answerCallbackQuery", { callback_query_id: cq.id, text: bk ? "Готово" : "Запись не найдена" });
      if (bk) await tg("editMessageText", { chat_id: cq.message.chat.id, message_id: cq.message.message_id,
        text: cq.message.text.split("\n\n")[0] + mark, reply_markup: markup });
      return new Response("ok");
    }

    // Админка
    if (path.startsWith("/admin/")) {
      if (!env.ADMIN_PASSWORD) return json({ error: "Пароль администратора не задан в Cloudflare" }, 503);
      if (path === "/admin/login" && request.method === "POST") {
        const ip = request.headers.get("CF-Connecting-IP") || "x", rk = "rl:" + ip;
        const fails = +(await env.SLOTS.get(rk)) || 0;
        if (fails >= 5) return json({ error: "Слишком много попыток. Подождите 15 минут." }, 429);
        const body = await request.json().catch(() => ({}));
        const pw = String(body.password || "");
        if (!safeEq(await sign(env, "login:" + pw), await sign(env, "login:" + env.ADMIN_PASSWORD))) {
          await env.SLOTS.put(rk, String(fails + 1), { expirationTtl: 900 });
          return json({ error: "Неверный пароль" }, 401);
        }
        await env.SLOTS.delete(rk);
        const exp = Date.now() + 12*3600e3;
        return json({ token: exp + "." + await sign(env, String(exp)) });
      }
      if (!(await checkToken(env, request))) return json({ error: "Войдите заново" }, 401);

      if (path === "/admin/bookings" && request.method === "GET") {
        const list = await env.SLOTS.list({ prefix: "b:", limit: 1000 });
        const items = (await Promise.all(list.keys.map(async k => {
          const v = JSON.parse((await env.SLOTS.get(k.name)) || "null");
          return v && { id: k.name.slice(2), ...v };
        }))).filter(Boolean);
        const from = new Date(Date.now() - 2*864e5).toISOString().slice(0, 10);
        items.sort((a, b) => (a.date + (a.time || "")).localeCompare(b.date + (b.time || "")));
        return json(items.filter(b => b.date >= from));
      }
      if (request.method !== "POST") return json({ error: "method" }, 405);
      const body = await request.json().catch(() => ({}));

      if (path === "/admin/action") {
        const id = String(body.id || "");
        const bk = body.act === "ok" ? await confirmBooking(env, id) : body.act === "no" ? await cancelBooking(env, id) : null;
        return bk ? json({ ok: true }) : json({ error: "Запись не найдена" }, 404);
      }
      if (path === "/admin/book") {
        let C; try { C = await getCfg(env); } catch { return json({ error: "Не удалось загрузить настройки" }, 503); }
        const [s, , msg] = await createBooking(C, env, body, true);
        return s === 200 ? json({ ok: true }) : json({ error: msg }, s);
      }
      if (path === "/admin/config") {
        const err = validate(body.config);
        if (err) return json({ error: err }, 400);
        await env.SLOTS.put("cfg", JSON.stringify(body.config));
        cache = { t: 0, v: null };
        return json({ ok: true });
      }
      return json({ error: "not found" }, 404);
    }

    // Публичные настройки для сайта
    if (request.method === "GET" && path === "/config") {
      try { return json(await rawCfg(env)); } catch { return json({ error: "config" }, 503); }
    }

    let C;
    try { C = await getCfg(env); } catch { return json({ error: "config" }, 503); }

    if (request.method === "GET") {
      const q = new URL(request.url).searchParams;
      const d = q.get("date") || "", m = q.get("master") || "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !C.masters[m]) return json({ error: "bad request" }, 400);
      return json(JSON.parse((await env.SLOTS.get("d:" + m + ":" + d)) || "[]"));
    }
    if (request.method !== "POST") return json({ error: "method" }, 405);

    let data;
    try { data = await request.json(); } catch { return json({ error: "bad request" }, 400); }
    const [s, e, , x] = await createBooking(C, env, data, false);
    if (s !== 200) return json({ error: e }, s);
    const { id, rec, M } = x;
    // Telegram необязателен: если бот не настроен или недоступен, запись всё равно сохраняется (смотреть в админке)
    if (env.BOT_TOKEN && env.CHAT_ID) {
      const text = "Новая заявка\nМастер: " + M.name + "\nИмя: " + rec.name + "\nТелефон: " + rec.phone +
        "\nУслуга: " + rec.service + "\nВремя: " + rec.label + ", " + rec.time +
        "\nСогласие на обработку данных: дано, версия от " + CONSENT_VERSION + ", " + rec.at;
      const p = tg("sendMessage", { chat_id: env.CHAT_ID, text, reply_markup: { inline_keyboard: [[
        { text: "✅ Подтвердить", callback_data: "ok:" + id },
        { text: "❌ Отменить", callback_data: "no:" + id }]] } }).catch(() => {});
      if (ctx && ctx.waitUntil) ctx.waitUntil(p);
    }
    return json({ ok: true });
  },
};
