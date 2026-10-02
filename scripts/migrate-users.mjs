#!/usr/bin/env node
// JONY KIDS — mavjud xodim/adminlarni Supabase Auth'ga BIR MARTA ko'chirish.
// Talab: Node 18+ (fetch). Hech qanday npm paket kerak emas.
//
// Ishga tushirish (supabase_setup.sql dan KEYIN, supabase_finalize.sql dan OLDIN):
//   SUPABASE_URL=https://xxxx.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=... \
//   SUPERADMIN_PASSWORD='kuchli-parol' \
//   node scripts/migrate-users.mjs
//
// Ixtiyoriy: SUPERADMIN_LOGIN (standart: superadmin), DRY_RUN=1 (hech narsa yozmaydi)
// service_role kalitini HECH QACHON klient kodiga yoki git'ga qo'ymang.

import { randomBytes } from 'node:crypto';

const URL_ = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPER_LOGIN = process.env.SUPERADMIN_LOGIN || 'superadmin';
const SUPER_PASS = process.env.SUPERADMIN_PASSWORD || '';
const DRY = process.env.DRY_RUN === '1';
const MIN_PASS = 6;

if (!URL_ || !KEY) { console.error('SUPABASE_URL va SUPABASE_SERVICE_ROLE_KEY kerak'); process.exit(1); }

// app.js va Edge Function'dagi bilan BIR XIL
const EMAIL_DOMAIN = 'jonykids.local';
function loginToEmail(login) {
  const l = String(login).trim().toLowerCase();
  const plain = /^[a-z0-9][a-z0-9._-]{0,62}$/.test(l) && !l.includes('..') && !l.endsWith('.');
  const local = plain
    ? l
    : 'u' + Array.from(new TextEncoder().encode(l)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 63);
  return `${local}@${EMAIL_DOMAIN}`;
}

const headers = { apikey: KEY, 'Content-Type': 'application/json' };
if (!KEY.startsWith('sb_')) headers.Authorization = `Bearer ${KEY}`; // eski JWT kalitlar uchun

async function api(method, path, body) {
  const res = await fetch(URL_ + path, { method, headers: { ...headers, Prefer: 'return=representation' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) { const err = new Error(`${method} ${path} → ${res.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`); err.status = res.status; throw err; }
  return data;
}

// Vaqtinchalik parol: 8 belgi, faqat oson o'qiladigan harf/raqamlar
const tempPassword = () => {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(randomBytes(8), b => abc[b % abc.length]).join('');
};

async function listAuthUsers() {
  const map = new Map();
  for (let page = 1; ; page++) {
    const r = await api('GET', `/auth/v1/admin/users?page=${page}&per_page=1000`);
    const users = r.users || [];
    users.forEach(u => u.email && map.set(u.email.toLowerCase(), u.id));
    if (users.length < 1000) break;
  }
  return map;
}

async function main() {
  console.log(DRY ? '— DRY RUN: hech narsa yozilmaydi —\n' : '');
  const staff = await api('GET', '/rest/v1/staff?select=id,name,login,password,user_id');
  const admins = await api('GET', '/rest/v1/admins?select=id,name,login,password,user_id,is_super');
  const authByEmail = await listAuthUsers();

  // Login to'qnashuvi (masalan "Ali" va "ali", yoki staff va admin'da bir xil login)
  const seen = new Map();
  for (const [table, rows] of [['staff', staff], ['admins', admins]]) {
    for (const r of rows) {
      const e = loginToEmail(r.login);
      if (seen.has(e)) { console.error(`✕ Login to'qnashuvi: ${seen.get(e)} va ${table}:${r.login}. Birini o'zgartirib qayta ishga tushiring.`); process.exit(1); }
      seen.set(e, `${table}:${r.login}`);
    }
  }

  const report = [];
  async function migrate(table, row, forcedPassword) {
    if (row.user_id) { report.push([table, row.login, 'allaqachon bog\'langan', '']); return; }
    const email = loginToEmail(row.login);
    let uid = authByEmail.get(email);
    let note = '', shownPass = '';
    if (!uid) {
      let pass = forcedPassword || row.password || '';
      if (pass.length < MIN_PASS) { pass = tempPassword(); shownPass = pass; note = 'VAQTINCHA PAROL (eski parol juda qisqa/bo\'sh edi)'; }
      if (!DRY) {
        const u = await api('POST', '/auth/v1/admin/users', { email, password: pass, email_confirm: true });
        uid = u.id || u.user?.id;
      }
    } else note = 'Auth\'da bor edi — bog\'landi';
    if (!DRY) await api('PATCH', `/rest/v1/${table}?id=eq.${row.id}`, { user_id: uid });
    report.push([table, row.login, note || 'ko\'chirildi (eski parol bilan)', shownPass]);
  }

  for (const r of staff) await migrate('staff', r);
  for (const r of admins.filter(a => !a.is_super)) await migrate('admins', r);

  // Superadmin
  const sup = admins.find(a => a.is_super);
  if (sup) await migrate('admins', sup, SUPER_PASS || undefined);
  else {
    if (SUPER_PASS.length < 8) { console.error('✕ SUPERADMIN_PASSWORD kerak (kamida 8 belgi)'); process.exit(1); }
    if (seen.has(loginToEmail(SUPER_LOGIN))) { console.error(`✕ "${SUPER_LOGIN}" login band. SUPERADMIN_LOGIN ni o'zgartiring.`); process.exit(1); }
    if (!DRY) {
      const email = loginToEmail(SUPER_LOGIN);
      let uid = authByEmail.get(email);
      if (!uid) uid = (await api('POST', '/auth/v1/admin/users', { email, password: SUPER_PASS, email_confirm: true })).id;
      await api('POST', '/rest/v1/admins', {
        name: 'Super Admin', login: SUPER_LOGIN, user_id: uid, is_super: true,
        permissions: { _v: 2 } // superadmin barcha ruxsatlarga ega
      });
    }
    report.push(['admins', SUPER_LOGIN, 'superadmin yaratildi', '']);
  }

  console.table(report.map(([table, login, holat, parol]) => ({ jadval: table, login, holat, parol })));
  console.log('\n✓ Tayyor. Vaqtinchalik parollarni egalariga xavfsiz yetkazing.');
  console.log('Keyingi qadam: supabase_finalize.sql ni ishga tushiring.');
}

main().catch(e => { console.error('✕', e.message); process.exit(1); });
