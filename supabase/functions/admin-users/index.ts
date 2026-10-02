// JONY KIDS — foydalanuvchilarni boshqarish (faqat serverda, service_role bilan).
// Deploy: supabase functions deploy admin-users
// Klient: sb.functions.invoke('admin-users', { body: { action, ... } })
import { createClient } from "npm:@supabase/supabase-js@2.117.2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Klient (app.js) va scripts/migrate-users.mjs dagi bilan BIR XIL bo'lishi shart
const EMAIL_DOMAIN = "jonykids.local";
function loginToEmail(login: string): string {
  const l = String(login).trim().toLowerCase();
  const plain = /^[a-z0-9][a-z0-9._-]{0,62}$/.test(l) && !l.includes("..") && !l.endsWith(".");
  const local = plain
    ? l
    : "u" + Array.from(new TextEncoder().encode(l)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 63);
  return `${local}@${EMAIL_DOMAIN}`;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const MIN_PASS = 6;
// supabase_setup.sql dagi permission_keys() va app.js dagi PERMISSIONS bilan BIR XIL
const PERMISSION_KEYS = [
  "dashboard", "dashboard_late", "dashboard_absent", "dashboard_penalties",
  "attendance", "attendance_edit", "reports",
  "tasks_view", "tasks_manage",
  "staff_view", "staff_manage", "branches",
  "penalty_settings", "staff_freeze", "penalty_cancel",
];
const str = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    // 1) Chaqiruvchini aniqlash — uning o'z tokeni bilan whoami()
    const authHeader = req.headers.get("Authorization") ?? "";
    const asCaller = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });
    const { data: me, error: meErr } = await asCaller.rpc("whoami");
    if (meErr || !me) throw new HttpError(401, "Avtorizatsiya yo'q");

    const isSuper = me.role === "superadmin";
    const isAdmin = isSuper || me.role === "admin";
    // Multi-permission: faqat aniq true qilib berilgan ruxsat hisobga olinadi
    const can = (perm: string) => isSuper || (isAdmin && me.permissions?.[perm] === true);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
    const body = await req.json().catch(() => ({}));

    // Login band emasligini tekshirish (staff + admins bo'yicha, email ko'rinishida)
    async function assertLoginFree(login: string, except: { table: string; id?: string }) {
      const email = loginToEmail(login);
      for (const table of ["staff", "admins"]) {
        const { data, error } = await admin.from(table).select("id, login");
        if (error) throw error;
        for (const row of data ?? []) {
          if (table === except.table && row.id === except.id) continue;
          if (loginToEmail(row.login) === email) throw new HttpError(409, "Bu login band");
        }
      }
    }

    async function createAuthUser(login: string, password: string) {
      const { data, error } = await admin.auth.admin.createUser({
        email: loginToEmail(login), password, email_confirm: true,
      });
      if (error) throw new HttpError(400, "Auth: " + error.message);
      return data.user!.id;
    }

    switch (body.action) {
      // ---------- XODIM: qo'shish / tahrirlash ----------
      case "save_staff": {
        if (!can("staff_manage")) throw new HttpError(403, "Ruxsat yo'q");
        const id = str(body.id, 64) || null;
        const name = str(body.name, 120);
        const login = str(body.login, 64);
        const password = typeof body.password === "string" ? body.password : "";
        if (!name || !login) throw new HttpError(400, "Ism va login kerak");
        if (password && password.length < MIN_PASS) throw new HttpError(400, `Parol kamida ${MIN_PASS} belgi`);
        const shifts = Array.isArray(body.shifts) ? body.shifts : [];

        let branch_name: string | null = null;
        const branch_id = str(body.branch_id, 64) || null;
        if (branch_id) {
          const { data: br } = await admin.from("branches").select("name").eq("id", branch_id).maybeSingle();
          branch_name = br?.name ?? null;
        }
        const fields = { name, login, position: str(body.position, 120) || null, branch_id, branch_name, shifts };

        await assertLoginFree(login, { table: "staff", id: id ?? undefined });

        if (!id) {
          if (!password) throw new HttpError(400, "Parol kerak");
          const user_id = await createAuthUser(login, password);
          const { data, error } = await admin.from("staff").insert([{ ...fields, role: "staff", user_id }]).select("id").single();
          if (error) { await admin.auth.admin.deleteUser(user_id); throw error; }
          return json({ ok: true, id: data.id });
        }

        const { data: cur, error: curErr } = await admin.from("staff").select("id, login, user_id").eq("id", id).single();
        if (curErr || !cur) throw new HttpError(404, "Xodim topilmadi");
        let user_id = cur.user_id as string | null;
        if (user_id) {
          const upd: Record<string, unknown> = {};
          if (loginToEmail(cur.login) !== loginToEmail(login)) upd.email = loginToEmail(login);
          if (password) upd.password = password;
          if (Object.keys(upd).length) {
            const { error } = await admin.auth.admin.updateUserById(user_id, upd);
            if (error) throw new HttpError(400, "Auth: " + error.message);
          }
        } else {
          if (!password) throw new HttpError(400, "Bu xodim hali Auth'ga ko'chirilmagan — yangi parol kiriting");
          user_id = await createAuthUser(login, password);
        }
        const { error } = await admin.from("staff").update({ ...fields, user_id }).eq("id", id);
        if (error) throw error;
        return json({ ok: true, id });
      }

      // ---------- XODIM: o'chirish ----------
      // Davomat va jarima tarixi saqlanadi (FK: on delete set null). Kirish huquqi darhol yopiladi:
      // staff qatori o'chgani uchun RLS hech narsa bermaydi, Auth foydalanuvchisi o'chgani uchun
      // eski login/parol bilan qayta kirib bo'lmaydi.
      case "delete_staff": {
        if (!can("staff_manage")) throw new HttpError(403, "Ruxsat yo'q");
        const id = str(body.id, 64);
        const { data: cur } = await admin.from("staff").select("id, user_id").eq("id", id).maybeSingle();
        if (!cur) throw new HttpError(404, "Xodim topilmadi");
        const { error } = await admin.from("staff").delete().eq("id", id);
        if (error) throw error;
        if (cur.user_id) {
          const { error: authErr } = await admin.auth.admin.deleteUser(cur.user_id);
          if (authErr) {
            // Qatori yo'q foydalanuvchi baribir hech narsaga kira olmaydi; qayta urinish uchun xabar beramiz
            return json({ ok: true, warning: "Auth foydalanuvchisini o'chirib bo'lmadi: " + authErr.message });
          }
        }
        return json({ ok: true });
      }

      // ---------- ADMIN: qo'shish (faqat superadmin) ----------
      case "save_admin": {
        if (!isSuper) throw new HttpError(403, "Faqat superadmin");
        const name = str(body.name, 120);
        const login = str(body.login, 64);
        const password = typeof body.password === "string" ? body.password : "";
        if (!name || !login || !password) throw new HttpError(400, "Barcha maydonlarni to'ldiring");
        if (password.length < MIN_PASS) throw new HttpError(400, `Parol kamida ${MIN_PASS} belgi`);
        const p = body.permissions ?? {};
        const permissions: Record<string, unknown> = { _v: 2 };
        for (const k of PERMISSION_KEYS) if (p[k] === true) permissions[k] = true;
        await assertLoginFree(login, { table: "admins" });
        const user_id = await createAuthUser(login, password);
        const { error } = await admin.from("admins").insert([{ name, login, permissions, user_id, is_super: false }]);
        if (error) { await admin.auth.admin.deleteUser(user_id); throw error; }
        return json({ ok: true });
      }

      // ---------- ADMIN: o'chirish (faqat superadmin) ----------
      case "delete_admin": {
        if (!isSuper) throw new HttpError(403, "Faqat superadmin");
        const id = str(body.id, 64);
        const { data: cur } = await admin.from("admins").select("id, user_id, is_super").eq("id", id).maybeSingle();
        if (!cur) throw new HttpError(404, "Admin topilmadi");
        if (cur.is_super) throw new HttpError(400, "Superadminni o'chirib bo'lmaydi");
        const { error } = await admin.from("admins").delete().eq("id", id);
        if (error) throw error;
        if (cur.user_id) await admin.auth.admin.deleteUser(cur.user_id);
        return json({ ok: true });
      }

      default:
        throw new HttpError(400, "Noma'lum amal");
    }
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    const message = e instanceof Error ? e.message : (e as { message?: string })?.message ?? "Server xatosi";
    return json({ error: message }, status);
  }
});
