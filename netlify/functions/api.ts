import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { and, desc, eq } from "drizzle-orm";
import { createHmac, randomBytes, scryptSync, timingSafeEqual, randomUUID } from "node:crypto";
import { db } from "../../db/index.js";
import { users, items } from "../../db/schema.js";

const COOKIE = "session";
const MAX_AGE = 60 * 60 * 24 * 30;

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });
const fail = (error: string, status = 400) => json({ error }, status);

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET lipsește");
  return s;
}
const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");

function signToken(uid: number) {
  const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64(JSON.stringify({ uid, exp: Math.floor(Date.now() / 1000) + MAX_AGE }));
  const sig = createHmac("sha256", secret()).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}
function verifyToken(t: string): number | null {
  const [head, body, sig] = t.split(".");
  if (!head || !body || !sig) return null;
  const exp = createHmac("sha256", secret()).update(`${head}.${body}`).digest();
  const got = Buffer.from(sig, "base64url");
  if (got.length !== exp.length || !timingSafeEqual(got, exp)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    return p.exp > Date.now() / 1000 ? p.uid : null;
  } catch { return null; }
}
const cookie = (v: string, age: number) => `${COOKIE}=${v}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;

function hashPw(pw: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(pw, salt, 64).toString("hex")}`;
}
function checkPw(pw: string, stored: string) {
  const [salt, h] = stored.split(":");
  const a = scryptSync(pw, salt, 64), b = Buffer.from(h, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
function newCode() {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(randomBytes(8), (x) => abc[x % abc.length]).join("");
}

async function currentUser(req: Request) {
  const m = (req.headers.get("cookie") || "").match(/(?:^|;\s*)session=([^;]+)/);
  const uid = m ? verifyToken(m[1]) : null;
  if (!uid) return null;
  const [u] = await db.select().from(users).where(eq(users.id, uid));
  return u || null;
}

async function meView(u: typeof users.$inferSelect) {
  let partner = null;
  if (u.partnerId) {
    const [p] = await db.select().from(users).where(eq(users.id, u.partnerId));
    if (p) partner = { id: p.id, username: p.username };
  }
  return { id: u.id, username: u.username, inviteCode: u.inviteCode, partner };
}

const itemView = (i: typeof items.$inferSelect, owner: boolean) => ({
  id: i.id, name: i.name, url: i.url, price: i.price === null ? null : Number(i.price),
  priority: i.priority, notes: i.notes, image: i.image, reserved: owner ? false : i.reserved,
});

const isHttp = (s: string) => { try { return ["http:", "https:"].includes(new URL(s).protocol); } catch { return false; } };
const isPrivateHost = (h: string) =>
  /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$|\[?f[cd])/i.test(h) || h.endsWith(".local") || h.endsWith(".internal");

async function readItemForm(req: Request, existing?: typeof items.$inferSelect) {
  const fd = await req.formData();
  const name = String(fd.get("name") || "").trim().slice(0, 200);
  if (!name) throw new Error("Numele este obligatoriu.");
  const url = String(fd.get("url") || "").trim();
  const priceRaw = String(fd.get("price") || "").trim().replace(",", ".");
  const price = priceRaw && !isNaN(Number(priceRaw)) ? String(Number(priceRaw)) : null;
  const priority = Math.min(3, Math.max(1, parseInt(String(fd.get("priority") || "2")) || 2));
  const notes = String(fd.get("notes") || "").trim().slice(0, 1000) || null;
  let image = existing?.image ?? null;
  const file = fd.get("image");
  if (file && typeof file === "object" && (file as File).size > 0) {
    const f = file as File;
    if (f.size > 5 * 1024 * 1024) throw new Error("Poza e prea mare (max 5 MB).");
    if (!f.type.startsWith("image/")) throw new Error("Fișierul nu este o imagine.");
    const key = randomUUID() + ".jpg";
    await getStore("uploads").set(key, await f.arrayBuffer(), { metadata: { type: f.type } });
    image = "/uploads/" + key;
  } else if (fd.get("image_url")) {
    const iu = String(fd.get("image_url")).trim();
    if (isHttp(iu)) image = iu;
  } else if (fd.get("remove_image")) image = null;
  return { name, url: url && isHttp(url) ? url : null, price, priority, notes, image };
}

function meta(html: string, keys: string[]) {
  for (const k of keys) {
    const re = new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${k}["'][^>]*>`, "i");
    const tag = html.match(re)?.[0];
    const c = tag?.match(/content=["']([^"']*)["']/i)?.[1];
    if (c) return c.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
  }
  return null;
}

async function preview(target: string) {
  if (!isHttp(target)) throw new Error("Link invalid.");
  const u = new URL(target);
  if (isPrivateHost(u.hostname)) throw new Error("Link invalid.");
  const res = await fetch(u, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; WishlistPreview/1.0)", Accept: "text/html" },
    signal: AbortSignal.timeout(8000), redirect: "follow",
  }).catch(() => null);
  if (!res || !res.ok) throw new Error("Nu am putut citi pagina.");
  const html = (await res.text()).slice(0, 800_000);
  const name = meta(html, ["og:title", "twitter:title"]) || html.match(/<title[^>]*>([^<]*)/i)?.[1]?.trim() || null;
  let image = meta(html, ["og:image", "og:image:secure_url", "twitter:image"]);
  if (image) { try { image = new URL(image, u).href; } catch { image = null; } }
  const p = meta(html, ["product:price:amount", "og:price:amount", "price"]);
  const price = p && !isNaN(Number(p.replace(",", "."))) ? Number(p.replace(",", ".")) : null;
  return { name, price, image };
}

export default async (req: Request) => {
  const path = new URL(req.url).pathname.replace(/\/+$/, "");
  const method = req.method;

  try {
    if (path.startsWith("/uploads/")) {
      const key = path.slice("/uploads/".length);
      const r = await getStore("uploads").getWithMetadata(key, { type: "arrayBuffer" });
      if (!r) return new Response("Not found", { status: 404 });
      return new Response(r.data, { headers: { "Content-Type": String(r.metadata?.type || "image/jpeg"), "Cache-Control": "public, max-age=31536000, immutable" } });
    }

    if ((path === "/api/register" || path === "/api/login") && method === "POST") {
      const { username = "", password = "" } = await req.json().catch(() => ({}));
      const un = String(username).trim().toLowerCase();
      if (!/^[a-z0-9_.-]{3,20}$/.test(un)) return fail("Utilizatorul trebuie să aibă 3–20 caractere (litere, cifre, _ . -).");
      if (String(password).length < 6) return fail("Parola trebuie să aibă minim 6 caractere.");
      let u;
      if (path === "/api/register") {
        const [ex] = await db.select().from(users).where(eq(users.username, un));
        if (ex) return fail("Numele de utilizator e deja folosit.", 409);
        [u] = await db.insert(users).values({ username: un, passwordHash: hashPw(String(password)), inviteCode: newCode() }).returning();
      } else {
        [u] = await db.select().from(users).where(eq(users.username, un));
        if (!u || !checkPw(String(password), u.passwordHash)) return fail("Utilizator sau parolă greșite.", 401);
      }
      return json(await meView(u), 200, { "Set-Cookie": cookie(signToken(u.id), MAX_AGE) });
    }

    if (path === "/api/logout" && method === "POST") return json({ ok: true }, 200, { "Set-Cookie": cookie("", 0) });

    const me = await currentUser(req);
    if (!me) return fail("Nu ești autentificat.", 401);

    if (path === "/api/me" && method === "GET") return json(await meView(me));

    if (path === "/api/preview" && method === "POST") {
      const { url = "" } = await req.json().catch(() => ({}));
      return json(await preview(String(url).trim()));
    }

    if (path === "/api/items") {
      if (method === "GET") {
        const rows = await db.select().from(items).where(eq(items.userId, me.id)).orderBy(desc(items.priority), desc(items.createdAt));
        return json(rows.map((i) => itemView(i, true)));
      }
      if (method === "POST") {
        const data = await readItemForm(req);
        const [row] = await db.insert(items).values({ ...data, userId: me.id }).returning();
        return json(itemView(row, true), 201);
      }
    }

    const itemMatch = path.match(/^\/api\/items\/(\d+)$/);
    if (itemMatch) {
      const id = Number(itemMatch[1]);
      const [it] = await db.select().from(items).where(and(eq(items.id, id), eq(items.userId, me.id)));
      if (!it) return fail("Nu am găsit dorința.", 404);
      if (method === "PUT") {
        const data = await readItemForm(req, it);
        const [row] = await db.update(items).set(data).where(eq(items.id, id)).returning();
        return json(itemView(row, true));
      }
      if (method === "DELETE") {
        await db.delete(items).where(eq(items.id, id));
        return json({ ok: true });
      }
    }

    if (path === "/api/partner/link" && method === "POST") {
      const { code = "" } = await req.json().catch(() => ({}));
      const c = String(code).trim().toUpperCase();
      if (me.partnerId) return fail("Ești deja conectat cu un partener.");
      const [p] = await db.select().from(users).where(eq(users.inviteCode, c));
      if (!p || p.id === me.id) return fail("Cod invalid.", 404);
      if (p.partnerId) return fail("Persoana aceasta are deja un partener.", 409);
      await db.update(users).set({ partnerId: p.id }).where(eq(users.id, me.id));
      await db.update(users).set({ partnerId: me.id }).where(eq(users.id, p.id));
      return json(await meView({ ...me, partnerId: p.id }));
    }

    if (path === "/api/partner/unlink" && method === "POST") {
      if (me.partnerId) await db.update(users).set({ partnerId: null }).where(eq(users.id, me.partnerId));
      await db.update(users).set({ partnerId: null }).where(eq(users.id, me.id));
      return json(await meView({ ...me, partnerId: null }));
    }

    if (path.startsWith("/api/partner/items")) {
      if (!me.partnerId) return fail("Nu ai un partener conectat.", 400);
      if (path === "/api/partner/items" && method === "GET") {
        const rows = await db.select().from(items).where(eq(items.userId, me.partnerId)).orderBy(desc(items.priority), desc(items.createdAt));
        return json(rows.map((i) => itemView(i, false)));
      }
      const rm = path.match(/^\/api\/partner\/items\/(\d+)\/reserve$/);
      if (rm && method === "POST") {
        const { reserved = true } = await req.json().catch(() => ({}));
        const [row] = await db.update(items).set({ reserved: !!reserved })
          .where(and(eq(items.id, Number(rm[1])), eq(items.userId, me.partnerId))).returning();
        if (!row) return fail("Nu am găsit dorința.", 404);
        return json(itemView(row, false));
      }
    }

    return fail("Nu există.", 404);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Eroare";
    console.error(e);
    if (/obligatoriu|prea mare|imagine|Link invalid|citi pagina/.test(msg)) return fail(msg, 400);
    return fail("Eroare de server. Încearcă din nou.", 500);
  }
};

export const config: Config = { path: ["/api/*", "/uploads/*"] };
