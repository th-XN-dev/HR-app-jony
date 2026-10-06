// ============================================================
// CONFIG — Supabase
// ============================================================
const SUPABASE_URL = 'https://ovqzfqklulgfwmpxmjaa.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im92cXpmcWtsdWxnZndtcHhtamFhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE0MzcyNTUsImV4cCI6MjA5NzAxMzI1NX0.z5sPn_hN3GfDxqp2WKw_y4qUm7vd27oKgi16aSykgi0';
// anon kalitning ochiq turishi normal — himoya Supabase Auth + RLS orqali (supabase_setup.sql)
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'jony-auth' }
});

// Login → Supabase Auth email.
// supabase/functions/admin-users va scripts/migrate-users.mjs dagi bilan BIR XIL bo'lishi shart.
const EMAIL_DOMAIN = 'jonykids.local';
function loginToEmail(login) {
  const l = String(login).trim().toLowerCase();
  const plain = /^[a-z0-9][a-z0-9._-]{0,62}$/.test(l) && !l.includes('..') && !l.endsWith('.');
  const local = plain
    ? l
    : 'u' + Array.from(new TextEncoder().encode(l)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 63);
  return `${local}@${EMAIL_DOMAIN}`;
}
const MIN_PASS = 6;

// Admin ruxsatlari (multi-permission). supabase_setup.sql dagi permission_keys() va
// Edge Function'dagi PERMISSION_KEYS bilan BIR XIL bo'lishi shart.
const PERMISSIONS = [
  { group: 'Davomat Dashboard', icon: 'bar-chart', items: [
    ['dashboard', 'Dashboard: umumiy ko\'rsatkichlar'],
    ['dashboard_late', 'Dashboard: kechikkanlar ro\'yxati'],
    ['dashboard_absent', 'Dashboard: kelmagan / Ketdim qilmaganlar'],
    ['dashboard_penalties', 'Dashboard: jarima va intizom xulosasi']] },
  { group: 'Davomat', icon: 'calendar', items: [
    ['attendance', 'Davomatni ko\'rish (bugungi, kechikkanlar, muammoli)'],
    ['attendance_edit', 'Davomatni qo\'lda belgilash'],
    ['reports', 'Hisobot va Excel eksport'],
    ['attendance_permit', 'Kechikishga ruxsat berish (ish boshlanishini surish)'],
    ['attendance_delete', 'Davomat yozuvini o\'chirish']] },
  { group: 'Vazifalar', icon: 'clipboard', items: [
    ['tasks_view', 'Vazifa va bildirishnomalarni ko\'rish'],
    ['tasks_manage', 'Vazifa yaratish / tahrirlash / o\'chirish']] },
  { group: 'Boshqaruv', icon: 'sliders', items: [
    ['staff_view', 'Xodimlar ro\'yxatini ko\'rish'],
    ['staff_manage', 'Xodim qo\'shish / tahrirlash / o\'chirish'],
    ['branches', 'Filiallarni boshqarish'],
    ['penalty_settings', 'Jarima va intizom sozlamalari'],
    ['staff_freeze', 'Muzlatish: chegara belgilash va muzlatishdan chiqarish'],
    ['penalty_cancel', 'Berilgan jarima va intizomiy choralarni bekor qilish']] }
];
const PERMISSION_KEYS = PERMISSIONS.flatMap(g => g.items.map(i => i[0]));

// Ruxsat tekshiruvi: Super Admin — hammasi; admin — faqat aniq berilganlari; xodim — hech biri
function can(perm) {
  if (!currentUser) return false;
  if (currentUser.role === 'superadmin') return true;
  if (currentUser.role !== 'admin') return false;
  return (currentUser.permissions || {})[perm] === true;
}
function canAny(...perms) { return perms.some(can); }
const isSuper = () => !!currentUser && currentUser.role === 'superadmin';
const isAdminUser = () => !!currentUser && (currentUser.role === 'admin' || currentUser.role === 'superadmin');

// Supabase javobini tekshirish: xato bo'lsa throw qiladi
function must(res) {
  if (res.error) throw res.error;
  return res.data;
}

// PostgREST bir so'rovda ko'pi bilan 1000 qator beradi — sahifalab hammasini olamiz
async function fetchAll(buildQuery, pageSize = 1000) {
  const out = [];
  for (let from = 0; ; from += pageSize) {
    const data = must(await buildQuery().range(from, from + pageSize - 1)) || [];
    out.push(...data);
    if (data.length < pageSize) break;
  }
  return out;
}

// Server/tarmoq xatosini o'qiladigan xabarga aylantirish
const SERVER_ERRORS = {
  NOT_STAFF: 'Siz xodim sifatida ro\'yxatdan o\'tmagansiz.',
  NO_GPS: 'Joylashuv aniqlanmadi.',
  NO_BRANCH: 'Filial topilmadi yoki unga GPS o\'rnatilmagan.',
  OUT_OF_RANGE: 'Siz filial hududida emassiz — davomat qabul qilinmadi.',
  ALREADY_IN: 'Avval "Ketdim" qiling, keyin yana "Keldim".',
  NOT_IN: 'Avval "Keldim" qiling!',
  NEED_REASON: 'Bekor qilish sababini yozing.',
  ALREADY_CANCELLED: 'Bu jarima allaqachon bekor qilingan.',
  FROZEN: 'Profilingiz muzlatilgan. Rahbariyatga murojaat qiling.',
  BAD_LIMIT: 'Chegara noto\'g\'ri.',
  NEED_COMMENT: 'Izoh yozish majburiy.',
  BAD_TIME: 'Vaqtni to\'g\'ri kiriting (SS:DD).',
  PAST_DATE: 'O\'tgan kunga ruxsat berib bo\'lmaydi.',
  NO_SHIFT_DAY: 'Bu kunga xodimga smena belgilanmagan.',
  TIME_OUT_OF_SHIFT: 'Ruxsat vaqti smena boshlanishidan keyin va tugashidan oldin bo\'lishi kerak.',
  ALREADY_CHECKED_IN: 'Xodim bu kuni allaqachon "Keldim" qilgan. Jarimani bekor qilish orqali hal qiling.',
  PERMIT_USED: 'Ruxsat allaqachon ishlatilgan (xodim kelgan) — bekor qilib bo\'lmaydi.',
  NO_STAFF: 'Xodim topilmadi.',
  FORBIDDEN: 'Bu amal uchun ruxsat yo\'q.',
  BAD_NAME: 'Ism noto\'g\'ri.',
  NOT_FOUND: 'Ma\'lumot topilmadi (o\'chirilgan bo\'lishi mumkin).',
  penalty_thresholds_ok: 'Chegaralar noto\'g\'ri: Ogohlantirish < Tanbeh < Qattiq tanbeh bo\'lishi kerak.'
};
function errMsg(e) {
  const m = (e && (e.message || e.details || e.code)) || '';
  for (const k in SERVER_ERRORS) if (m.includes(k)) return SERVER_ERRORS[k];
  if (/row-level security|permission denied|42501/i.test(m)) return 'Bu amal uchun ruxsat yo\'q.';
  if (/JWT|not authenticated|session/i.test(m)) return 'Sessiya tugagan. Qayta kiring.';
  if (/network|failed to fetch|load failed/i.test(m)) return 'Internet aloqasi yo\'q. Qayta urinib ko\'ring.';
  return m ? 'Xatolik: ' + m : t('error');
}

// Async amal: loader + xato bo'lsa toast. Muvaffaqiyatda true qaytaradi
async function run(text, fn) {
  try {
    await withLoader(text, fn);
    return true;
  } catch (e) {
    console.warn(e);
    showToast(errMsg(e), 4500);
    return false;
  }
}

// Foydalanuvchi boshqaruvi — faqat serverda (supabase/functions/admin-users)
async function adminUsers(body) {
  const { data, error } = await sb.functions.invoke('admin-users', { body });
  if (error) {
    let msg = error.message;
    try { const j = await error.context.json(); if (j && j.error) msg = j.error; } catch (_) { }
    throw new Error(msg);
  }
  return data;
}

// Tashkent vaqti yordamchilari (qurilma vaqt zonasidan qat'i nazar)
const TZ = 'Asia/Tashkent';
function pad2(n) { return String(n).padStart(2, '0'); }
function tashkentDayStart(dateStr) { return new Date(`${dateStr}T00:00:00+05:00`); }
// <input type="datetime-local"> qiymati (Tashkent vaqti deb) → ISO
function tashkentInputToISO(v) {
  if (!v) return null;
  return new Date((v.length === 16 ? v + ':00' : v) + '+05:00').toISOString();
}
// Sana → datetime-local qiymati (Tashkent)
function toTashkentInput(d) {
  const p = uzParts(d);
  return `${p.dateStr}T${pad2(p.hour)}:${pad2(p.minute)}`;
}
function fmtUzDate(d) { const p = uzParts(new Date(d)); return `${pad2(p.day)}.${pad2(p.month)}.${p.year}`; }
function fmtUzTime(d) { const p = uzParts(new Date(d)); return `${pad2(p.hour)}:${pad2(p.minute)}`; }
function fmtUzDateTime(d) { return `${fmtUzDate(d)} ${fmtUzTime(d)}`; }
function initialsOf(name) { return String(name || '?').split(' ').filter(Boolean).map(w => w[0]).join('').toUpperCase().slice(0, 2); }

// ============================================================
// STATE
// ============================================================
const APP_VERSION = 'upg 24';
let currentUser = null;
let staffList = [], branches = [], tasks = [], attendances = [], admins = [];
let penaltySettings = null;
let selectedCIType = 'checkin', selectedTaskType = 'task';
let currentTaskId = null, currentEditStaffId = null, editingTaskId = null;

// SVG ikonka (index.html dagi #i-* to'plamidan)
function ic(name, cls) {
  return `<svg class="ic${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

// Emojilarni olib tashlash — serverdan kelgan (jumladan eski) bildirishnoma matnlari uchun
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2300}-\u{23FF}\u{27F0}-\u{27FF}\u{21A9}\u{FE0F}\u{200D}]\s?/gu;
function noEmoji(s) {
  return String(s == null ? '' : s).split('\n').map(l => l.replace(EMOJI_RE, '').trim()).join('\n').trim();
}

// Tizim bildirishnomasi matnini qatorma-qator ikonkalar bilan chiqarish
const LINE_ICONS = [
  [/^(Kun|Kechikish kuni):/, 'calendar'], [/^Ish boshlanishi/, 'clock'], [/^Kelgan vaqt/, 'door'],
  [/^Kechikish:/, 'timer'], [/^Hisob:/, 'banknote'], [/^Intizomiy chora/, 'scale'], [/bo'yicha:/, 'bar-chart'],
  [/^(Izoh|Ruxsat izohi)/, 'file-text'], [/^Sabab/, 'message'], [/^(Ruxsat berdi|O'chirdi|Bekor qildi)/, 'user'],
  [/^Qo'lda/, 'pen-line'], [/^Bekor qilindi/, 'x-circle'], [/bekor qilindi\.?$/, 'check-circle'],
  [/almashtirildi/, 'repeat'], [/surildi$/, 'clock'], [/— (Keldim|Ketdim)/, 'calendar']
];
function richText(text) {
  return noEmoji(text).split('\n').map(line => {
    if (!line.trim()) return '<div style="height:6px"></div>';
    const m = LINE_ICONS.find(([re]) => re.test(line));
    return `<div class="ic-line">${m ? ic(m[1]) : ''}<span>${esc(line)}</span></div>`;
  }).join('');
}

// XSS himoyasi: HTML maxsus belgilarini xavfsizlash
function esc(s) {
  if (s == null) return '';
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}

// Daqiqani "S soat D daqiqa" formatiga o'giradi. 60 dan kichik bo'lsa faqat daqiqa.
function fmtDuration(mins) {
  const m = Math.abs(Math.round(mins));
  if (m < 60) return m + ' daqiqa';
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${h} soat ${rem} daqiqa` : `${h} soat`;
}

// Custom tasdiqlash dialogi (brauzer confirm o'rniga) — Promise<boolean>
function confirmDialog(title, text) {
  return new Promise(resolve => {
    document.getElementById('confirm-title').textContent = title || 'Tasdiqlang';
    document.getElementById('confirm-text').textContent = text || '';
    const yes = document.getElementById('confirm-yes');
    const no = document.getElementById('confirm-no');
    const cleanup = () => { yes.onclick = null; no.onclick = null; closeModal('modal-confirm'); };
    yes.onclick = () => { cleanup(); resolve(true); };
    no.onclick = () => { cleanup(); resolve(false); };
    openModal('modal-confirm');
  });
}
let reportPeriod = 'daily';
let notifEnabled = localStorage.getItem('notifEnabled') !== '0';
let lang = localStorage.getItem('lang') || 'uz';

// TRANSLATIONS
const T = {
  uz: {
    dashboard: 'Dashboard', attend: 'Davomat', tasks: 'Vazifalar', mgmt: 'Boshqaruv', settings: 'Sozlamalar',
    trial: 'Sinov', contract: 'Shartnoma', frozen: 'Muzlatilgan', left: 'Ketgan', returned: 'Qaytgan',
    add: 'Qo\'shish', save: 'Saqlash', cancel: 'Bekor', close: 'Yopish', edit: 'Tahrirlash', del: 'O\'chirish',
    login: 'Login', pass: 'Parol', enter: 'Kirish', logout: 'Chiqish',
    theme: 'Qorong\'i tema', notif: 'Bildirishnomalar',
    fullname: 'To\'liq ism', newpass: 'Yangi parol',
    save_profile: 'Saqlash', checkin: 'Keldi', checkout: 'Ketdi',
    search: 'Qidirish...', daily: 'Kunlik', weekly: 'Haftalik', monthly: 'Oylik',
    task: 'Vazifa', note: 'Eslatma', alert: 'Xabarnoma',
    branch: 'Filial', staff: 'Xodim', reply: 'Javob',
    late: 'Kechikkan', on_time: 'Vaqtida', no_data: 'Ma\'lumot yo\'q',
    saved: 'Saqlandi', deleted: 'O\'chirildi', error: 'Xatolik yuz berdi',
    auth_sub: 'O\'quv markazi boshqaruv tizimi', wrong_creds: 'Login yoki parol noto\'g\'ri'
  },
  ru: {
    dashboard: 'Дашборд', attend: 'Посещаемость', tasks: 'Задачи', mgmt: 'Управление', settings: 'Настройки',
    trial: 'Пробный', contract: 'Договор', frozen: 'Заморожен', left: 'Ушёл', returned: 'Вернулся',
    add: 'Добавить', save: 'Сохранить', cancel: 'Отмена', close: 'Закрыть', edit: 'Изменить', del: 'Удалить',
    login: 'Логин', pass: 'Пароль', enter: 'Войти', logout: 'Выйти',
    theme: 'Тёмная тема', notif: 'Уведомления',
    fullname: 'Полное имя', newpass: 'Новый пароль',
    save_profile: 'Сохранить', checkin: 'Пришёл', checkout: 'Ушёл',
    search: 'Поиск...', daily: 'Ежедневно', weekly: 'Еженедельно', monthly: 'Ежемесячно',
    task: 'Задача', note: 'Заметка', alert: 'Уведомление',
    branch: 'Филиал', staff: 'Сотрудник', reply: 'Ответ',
    late: 'Опоздавшие', on_time: 'Вовремя', no_data: 'Нет данных',
    saved: 'Сохранено', deleted: 'Удалено', error: 'Произошла ошибка',
    auth_sub: 'Система управления учебным центром', wrong_creds: 'Неверный логин или пароль'
  },
  en: {
    dashboard: 'Dashboard', attend: 'Attendance', tasks: 'Tasks', mgmt: 'Management', settings: 'Settings',
    trial: 'Trial', contract: 'Contract', frozen: 'Frozen', left: 'Left', returned: 'Returned',
    add: 'Add', save: 'Save', cancel: 'Cancel', close: 'Close', edit: 'Edit', del: 'Delete',
    login: 'Login', pass: 'Password', enter: 'Enter', logout: 'Logout',
    theme: 'Dark theme', notif: 'Notifications',
    fullname: 'Full name', newpass: 'New password',
    save_profile: 'Save', checkin: 'Checked in', checkout: 'Checked out',
    search: 'Search...', daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly',
    task: 'Task', note: 'Note', alert: 'Notification',
    branch: 'Branch', staff: 'Staff', reply: 'Reply',
    late: 'Late', on_time: 'On time', no_data: 'No data',
    saved: 'Saved', deleted: 'Deleted', error: 'An error occurred',
    auth_sub: 'Learning Center Management System', wrong_creds: 'Wrong login or password'
  }
};

function t(key) { return (T[lang] && T[lang][key]) || key; }

function setLang(l) {
  lang = l;
  localStorage.setItem('lang', l);
  applyLang();
}

// Element bo'lmasa (masalan, tugma spinner holatida) xato bermasdan o'tkazib yuboradi
function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function applyLang() {
  document.querySelectorAll('.lang-btn').forEach(b => b.classList.remove('active'));
  const lb = document.querySelector(`.lang-btn[onclick="setLang('${lang}')"]`);
  if (lb) lb.classList.add('active');
  setText('auth-subtitle', t('auth_sub'));
  setText('lbl-login', t('login'));
  setText('lbl-pass', t('pass'));
  setText('lbl-enter', t('enter'));
  setText('nav-lbl-dashboard', t('dashboard'));
  const myAttLbl = document.getElementById('nav-lbl-myattend');
  if (myAttLbl) myAttLbl.textContent = t('attend');
  setText('nav-lbl-attend', t('attend'));
  setText('nav-lbl-tasks', t('tasks'));
  setText('nav-lbl-admin', t('mgmt'));
  setText('nav-lbl-settings', t('settings'));
  setText('lbl-theme', t('theme'));
  setText('lbl-notif', t('notif'));
  setText('lbl-fullname', t('fullname'));
  setText('lbl-newpass', t('newpass'));
  setText('lbl-save-profile', t('save_profile'));
  setText('lbl-logout', t('logout'));
  if (currentUser) {
    renderTasks(); renderTodayAttendance();
  }
}

// ============================================================
// THEME
// ============================================================
function toggleTheme() {
  const goingDark = !document.body.classList.contains('dark');
  if (goingDark) { document.body.classList.add('dark'); localStorage.setItem('theme', 'dark'); }
  else { document.body.classList.remove('dark'); localStorage.setItem('theme', 'light'); }
  const tog = document.getElementById('theme-toggle');
  if (tog) tog.classList.toggle('on', goingDark);
  const tb = document.getElementById('btn-theme');
  if (tb) tb.innerHTML = ic(goingDark ? 'sun' : 'moon');
}
function initTheme() {
  const saved = localStorage.getItem('theme');
  const tog = document.getElementById('theme-toggle');
  const tb = document.getElementById('btn-theme');
  if (saved === 'dark') {
    document.body.classList.add('dark');
    if (tog) tog.classList.add('on');
    if (tb) tb.innerHTML = ic('sun');
  } else {
    document.body.classList.remove('dark');
    if (tog) tog.classList.remove('on');
    if (tb) tb.innerHTML = ic('moon');
  }
}

function toggleNotif() {
  notifEnabled = !notifEnabled;
  document.getElementById('notif-toggle').classList.toggle('on', notifEnabled);
  localStorage.setItem('notifEnabled', notifEnabled ? '1' : '0');
  if (notifEnabled && 'Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().then(p => {
      if (p === 'granted') showToast('Bildirishnomalar yoqildi', 1800, 'ok');
    });
  }
}

// ============================================================
// TOAST
// ============================================================
let _toastTimer = null;
const TOAST_ICONS = { ok: 'check-circle', warn: 'alert-triangle' };
function showToast(msg, dur = 2000, kind = '', icon) {
  const el = document.getElementById('toast');
  el.innerHTML = ic(icon || TOAST_ICONS[kind] || 'info') + `<span>${esc(noEmoji(msg))}</span>`;
  el.classList.remove('warn', 'ok');
  if (kind) el.classList.add(kind);
  el.classList.add('show');
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), dur);
}

// ============================================================
// LOADER
// ============================================================
let loaderCount = 0;
function showLoader(text) {
  loaderCount++;
  const ov = document.getElementById('loader-overlay');
  document.getElementById('loader-text').textContent = text || 'Yuklanmoqda...';
  ov.classList.add('show');
}
function hideLoader() {
  loaderCount = Math.max(0, loaderCount - 1);
  if (loaderCount === 0) document.getElementById('loader-overlay').classList.remove('show');
}
// Tugmani spinner holatiga o'tkazish; tiklash funksiyasini qaytaradi
function btnLoading(btn) {
  if (!btn) return () => { };
  const orig = btn.innerHTML;
  const disabled = btn.disabled;
  btn.classList.add('loading'); btn.disabled = true;
  btn.innerHTML = '<span class="btn-spinner"></span>';
  return () => { btn.classList.remove('loading'); btn.disabled = disabled; btn.innerHTML = orig; };
}
// Wrapper: async amalni loader bilan o'rab bajarish
async function withLoader(text, fn) {
  showLoader(text);
  try { return await fn(); }
  finally { hideLoader(); }
}

// ============================================================
// AUTH — Supabase Auth (parollar serverda xeshlangan holda)
// ============================================================
async function doLogin() {
  const login = document.getElementById('login-input').value.trim();
  const pass = document.getElementById('pass-input').value.trim();
  if (!login || !pass) return;
  const loginBtn = document.querySelector('#auth-screen .btn-primary');
  const restore = btnLoading(loginBtn);
  const errEl = document.getElementById('auth-error');
  errEl.style.display = 'none';

  try {
    const { error } = await sb.auth.signInWithPassword({ email: loginToEmail(login), password: pass });
    if (error) throw error;
    if (!await loadMe()) {
      await sb.auth.signOut();
      throw new Error('NO_PROFILE');
    }
    document.getElementById('pass-input').value = '';
  } catch (e) {
    const m = (e && e.message) || '';
    errEl.textContent = m === 'NO_PROFILE'
      ? 'Akkaunt tizimga bog\'lanmagan. Administratorga murojaat qiling.'
      : /failed to fetch|network|load failed/i.test(m) ? 'Internet aloqasi yo\'q.' : t('wrong_creds');
    errEl.style.display = 'block';
    return;
  } finally {
    restore();
  }
  // Tugma asl holiga qaytgandan keyin UI quriladi (aks holda #lbl-enter vaqtincha DOM'da bo'lmaydi)
  afterLogin();
}

// Joriy foydalanuvchi profili — rol FAQAT serverdan olinadi (localStorage'ga ishonilmaydi)
async function loadMe() {
  const me = must(await sb.rpc('whoami'));
  if (!me) return false;
  currentUser = me;
  return true;
}

// Top header — barcha ma'lumotni qayta yuklash
async function refreshAll(btn) {
  if (btn) { btn.style.transition = 'transform 0.6s'; btn.style.transform = 'rotate(360deg)'; }
  try {
    await loadAll();
    const active = document.querySelector('.page.active');
    const pid = active ? active.id.replace('page-', '') : null;
    if (pid === 'myattend') refreshMyAttendance();
    else if (pid === 'dashboard') renderDashboard();
    else if (pid === 'tasks') { renderTasks(); markTasksSeen(); }
    else if (pid === 'attendance') { refreshAttendancePage(); }
    else if (pid === 'admin') { renderStaff(); renderBranches(); renderAdmins(); }
    showToast('Yangilandi', 1200, 'ok');
  } catch (e) {
    showToast('Yangilashda xatolik', 2500);
  } finally {
    if (btn) setTimeout(() => { btn.style.transition = 'none'; btn.style.transform = 'rotate(0deg)'; }, 600);
  }
}

let taskPollTimer = null, taskChannel = null, accessTimer = null;
// Muzlatilgan xodim: ilova o'rniga faqat ogohlantirish ekrani
function showFrozenScreen(message) {
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('main-app').style.display = 'none';
  document.getElementById('frozen-message').textContent = message || '';
  document.getElementById('frozen-screen').style.display = 'flex';
  if (myClockTimer) clearInterval(myClockTimer);
  if (taskPollTimer) clearInterval(taskPollTimer);
  if (taskChannel) { sb.removeChannel(taskChannel); taskChannel = null; }
}

function afterLogin() {
  if (currentUser.frozen) {
    showFrozenScreen(currentUser.freeze_message);
    // Muzlatishdan chiqarilsa yoki akkaunt o'chirilsa — avtomatik aniqlanadi
    if (accessTimer) clearInterval(accessTimer);
    accessTimer = setInterval(verifyAccess, 60000);
    return;
  }
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('main-app').style.display = 'block';
  setupUI();
  // Ma'lumot yuklangach ochiq sahifani qayta chizamiz (Dashboard xodimlar ro'yxatiga tayanadi)
  run('Ma\'lumotlar yuklanmoqda...', () => loadAll()).then(ok => {
    if (!ok) return;
    const active = document.querySelector('.page.active');
    const pid = active ? active.id.replace('page-', '') : null;
    if (pid === 'dashboard') renderDashboard();
    if (pid === 'admin') showPage('admin');
  });
  // Bildirishnoma ruxsatini so'rash
  if ('Notification' in window && Notification.permission === 'default') {
    setTimeout(() => { try { Notification.requestPermission(); } catch (e) { } }, 2000);
  }
  // Yangi vazifalar: Realtime orqali darhol; polling — faqat zaxira
  subscribeTasks();
  if (taskPollTimer) clearInterval(taskPollTimer);
  taskPollTimer = setInterval(() => { loadTasks().catch(e => console.warn('loadTasks:', e)); }, 120000);
  // O'chirilgan xodim / o'zgargan ruxsatlar darhol kuchga kirsin
  if (accessTimer) clearInterval(accessTimer);
  accessTimer = setInterval(verifyAccess, 60000);
}

// Akkaunt hali ham mavjudmi va ruxsatlar o'zgarmadimi — serverdan tekshirish
async function verifyAccess() {
  if (!currentUser) return;
  try {
    const me = must(await sb.rpc('whoami'));
    if (!me) return forceLogout('Akkauntingiz tizimdan o\'chirilgan. Administratorga murojaat qiling.');
    // Muzlatildi yoki muzlatishdan chiqarildi — ilovani qayta ochamiz
    if (!!me.frozen !== !!currentUser.frozen) { location.reload(); return; }
    const changed = me.role !== currentUser.role || JSON.stringify(me.permissions || {}) !== JSON.stringify(currentUser.permissions || {});
    currentUser = { ...currentUser, ...me };
    if (changed) {
      setupUI(true);
      run('Yangilanmoqda...', () => loadAll());
      showToast('Ruxsatlaringiz yangilandi', 2500, 'ok');
    }
  } catch (e) {
    if (/JWT|not authenticated|permission denied for function/i.test((e && e.message) || '')) forceLogout('Sessiya tugagan. Qayta kiring.');
  }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') verifyAccess(); });

async function forceLogout(message) {
  if (!currentUser) return;
  currentUser = null;
  try { sessionStorage.setItem('logoutMsg', message || ''); } catch (e) { }
  try { await sb.auth.signOut(); } catch (e) { }
  location.reload();
}

function subscribeTasks() {
  if (taskChannel) sb.removeChannel(taskChannel);
  taskChannel = sb.channel('tasks-live')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, () => {
      loadTasks().catch(e => console.warn('loadTasks:', e));
    })
    .subscribe();
}

async function doLogout() {
  if (myClockTimer) clearInterval(myClockTimer);
  if (taskPollTimer) clearInterval(taskPollTimer);
  if (accessTimer) clearInterval(accessTimer);
  if (taskChannel) sb.removeChannel(taskChannel);
  try { await sb.auth.signOut(); } catch (e) { }
  currentUser = null;
  location.reload();
}

async function saveProfile() {
  const name = document.getElementById('edit-fullname').value.trim();
  const pass = document.getElementById('edit-password').value.trim();
  if (!name) return;
  if (pass && pass.length < MIN_PASS) { showToast(`Parol kamida ${MIN_PASS} belgidan iborat bo'lsin`); return; }
  const ok = await run(t('save') + '...', async () => {
    if (name !== currentUser.name) must(await sb.rpc('update_my_name', { p_name: name }));
    if (pass) {
      const { error } = await sb.auth.updateUser({ password: pass });
      if (error) throw error;
    }
  });
  if (!ok) return;
  currentUser = { ...currentUser, name };
  document.getElementById('edit-password').value = '';
  updateProfileDisplay();
  showToast(t('saved'));
}

function updateProfileDisplay() {
  const initials = initialsOf(currentUser.name);
  document.getElementById('user-avatar').textContent = initials;
  document.getElementById('settings-avatar').textContent = initials;
  document.getElementById('settings-name').textContent = currentUser.name;
  document.getElementById('settings-role-text').textContent = currentUser.role === 'superadmin' ? 'Super Admin' : currentUser.role === 'admin' ? 'Admin' : 'Xodim';
  document.getElementById('edit-fullname').value = currentUser.name;
  const rb = document.getElementById('user-role-badge');
  rb.innerHTML = `<span class="role-badge ${currentUser.role === 'superadmin' ? 'role-super' : currentUser.role === 'admin' ? 'role-admin' : 'role-staff'}">${currentUser.role === 'superadmin' ? 'Super Admin' : currentUser.role === 'admin' ? 'Admin' : 'Staff'}</span>`;
}

// Bo'lim (sahifa) ruxsatlari
const PAGE_ACCESS = {
  dashboard: () => canAny('dashboard', 'dashboard_late', 'dashboard_absent', 'dashboard_penalties'),
  attendance: () => canAny('attendance', 'attendance_edit', 'reports', 'attendance_permit', 'attendance_delete'),
  tasks: () => !isAdminUser() || canAny('tasks_view', 'tasks_manage'),
  admin: () => isSuper() || canAny('staff_view', 'staff_manage', 'branches', 'penalty_settings', 'staff_freeze'),
  myattend: () => !isAdminUser(),
  settings: () => true
};
function pageAllowed(page) { return !!(PAGE_ACCESS[page] && PAGE_ACCESS[page]()); }
const show = (id, on) => { const el = document.getElementById(id); if (el) el.style.display = on ? '' : 'none'; };

function setupUI(keepPage) {
  updateProfileDisplay();
  const isStaff = !isAdminUser();

  // Navigatsiya — faqat ruxsat berilgan bo'limlar
  ['myattend', 'dashboard', 'attendance', 'tasks', 'admin', 'settings'].forEach(pg => show('nav-' + pg, pageAllowed(pg)));

  // Bo'lim ichidagi elementlar
  show('btn-add-task', can('tasks_manage'));
  show('btn-add-checkin', can('attendance_edit'));
  show('att-tab-checkin', canAny('attendance', 'attendance_edit', 'attendance_delete'));
  show('att-tab-report', can('reports'));
  show('att-tab-late', can('attendance'));
  show('att-tab-issues', can('attendance'));
  show('att-tab-permits', can('attendance_permit'));
  show('btn-add-staff', can('staff_manage'));
  show('adm-tab-staff', canAny('staff_view', 'staff_manage'));
  show('adm-tab-branches', can('branches'));
  show('btn-add-branch', can('branches'));
  show('adm-tab-penalty', can('penalty_settings'));
  show('adm-tab-freeze', can('staff_freeze'));
  show('adm-tab-admins', isSuper());
  show('adm-tab-tags', isSuper());
  if (isStaff) { try { setupMyAttendance(); } catch (e) { console.warn('setupMyAttendance:', e); } }

  initTheme();
  applyLang();
  const notifTog = document.getElementById('notif-toggle');
  if (notifTog) notifTog.classList.toggle('on', notifEnabled);

  // Joriy sahifa hali ham ruxsat etilgan bo'lsa — qolamiz
  const active = document.querySelector('.page.active');
  const cur = active ? active.id.replace('page-', '') : null;
  if (keepPage && cur && pageAllowed(cur)) { showPage(cur); return; }

  // Boshlang'ich sahifa
  if (isStaff) {
    // Xodim shu qurilmada birinchi marta ochsa — vazifalar oynasi ko'rsatiladi
    const seenKey = 'firstOpen_' + currentUser.id;
    if (!localStorage.getItem(seenKey)) {
      localStorage.setItem(seenKey, '1');
      showPage('tasks');
    } else {
      showPage('myattend');
    }
  } else {
    showPage(['dashboard', 'attendance', 'tasks', 'admin'].find(pageAllowed) || 'settings');
  }
}

// ============================================================
// NAVIGATION
// ============================================================
function showPage(page) {
  if (!pageAllowed(page)) page = 'settings';
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const pageEl = document.getElementById('page-' + page);
  const navEl = document.getElementById('nav-' + page);
  if (pageEl) pageEl.classList.add('active');
  if (navEl) navEl.classList.add('active');
  const titles = { myattend: t('attend'), dashboard: t('dashboard'), attendance: t('attend'), tasks: t('tasks'), admin: t('mgmt'), settings: t('settings') };
  const titleEl = document.getElementById('page-title');
  if (titleEl) titleEl.textContent = titles[page] || '';
  if (page === 'myattend') refreshMyAttendance().catch(e => showToast(errMsg(e), 4000));
  if (page === 'dashboard') renderDashboard();
  if (page === 'attendance') refreshAttendancePage();
  if (page === 'tasks') { renderTasks(); markTasksSeen(); }
  if (page === 'admin') {
    const firstTab = ['staff', 'branches', 'penalty', 'freeze', 'admins', 'tags'].find(tb => document.getElementById('adm-tab-' + tb).style.display !== 'none');
    const curTab = document.querySelector('#page-admin .tab.active');
    const curId = curTab ? curTab.id.replace('adm-tab-', '') : null;
    if (firstTab) switchAdminTab(curId && curTab.style.display !== 'none' ? curId : firstTab);
  }
}

// Davomat sahifasi: joriy yoki birinchi ruxsat berilgan tab
function refreshAttendancePage() {
  const curTab = document.querySelector('#page-attendance .tab.active');
  const curId = curTab ? curTab.id.replace('att-tab-', '') : null;
  const firstTab = ['checkin', 'report', 'late', 'issues', 'permits'].find(tb => document.getElementById('att-tab-' + tb).style.display !== 'none');
  if (firstTab) switchAttTab(curId && curTab.style.display !== 'none' ? curId : firstTab);
}

// ============================================================
// LOAD DATA
// ============================================================
async function loadAll() {
  const jobs = [loadBranches(), loadTasks(), loadTags(), loadPenaltySettings()];
  if (isAdminUser()) jobs.push(loadStaff(), loadAdmins());
  await Promise.all(jobs);
}

let appTags = [];
async function loadTags() {
  appTags = must(await sb.from('app_tags').select('id, kind, label, sort').order('sort')) || [];
}
function tagsByKind(kind) { return appTags.filter(t => t.kind === kind); }

const STAFF_COLUMNS = 'id, name, login, role, position, branch_id, branch_name, shifts, permissions, created_at, user_id, penalty_enabled, '
  + 'frozen, frozen_at, frozen_late_seconds, frozen_limit_minutes, late_counter_from';
let staffLateTotals = {}; // staff_id -> joriy hisoblagichdagi jami kechikish (soniya)
async function loadStaff() {
  const [list, totals] = await Promise.all([
    sb.from('staff').select(STAFF_COLUMNS).order('name').then(must),
    sb.rpc('staff_late_totals').then(must)
  ]);
  staffList = list || [];
  staffLateTotals = {};
  (totals || []).forEach(r => { staffLateTotals[r.staff_id] = Number(r.late_seconds) || 0; });
  populateStaffSelects();
}

async function loadBranches() {
  branches = must(await sb.from('branches').select('id, name, address, lat, lng, radius').order('name')) || [];
  populateBranchSelects();
}

async function loadTasks() {
  let query = sb.from('tasks').select('*').order('created_at', { ascending: false });
  const isAdminRole = currentUser.role === 'admin' || currentUser.role === 'superadmin';
  if (!isAdminRole) {
    // O'ziga berilgan + "Barcha xodimlar"ga berilgan vazifalar
    query = query.or(`assigned_to.eq.${currentUser.id},assigned_to.is.null`);
  }
  const data = must(await query);
  const prevIds = tasks.map(t => t.id);
  tasks = data || [];
  // Yangi kelgan vazifalarni aniqlash (oldingi yuklashga nisbatan)
  if (prevIds.length) {
    const fresh = tasks.filter(t => !prevIds.includes(t.id));
    fresh.forEach(t => notifyNewTask(t));
  }
  renderTasks();
  updateTasksBadge();
}

// Ko'rilgan vazifalar (localStorage)
function seenTaskIds() {
  try { return JSON.parse(localStorage.getItem('seenTasks_' + currentUser.id) || '[]'); }
  catch { return []; }
}
function markTasksSeen() {
  localStorage.setItem('seenTasks_' + currentUser.id, JSON.stringify(tasks.map(t => t.id)));
  updateTasksBadge();
}
function updateTasksBadge() {
  const seen = seenTaskIds();
  const unseen = tasks.filter(t => !seen.includes(t.id)).length;
  const badge = document.getElementById('tasks-badge');
  if (!badge) return;
  if (unseen > 0) {
    badge.textContent = unseen > 9 ? '9+' : unseen;
    badge.style.display = 'flex';
  } else {
    badge.style.display = 'none';
  }
}

// Yangi vazifa bildirishnomasi
function notifyNewTask(task) {
  const typeLabel = { task: 'Yangi vazifa', note: 'Yangi eslatma', alert: 'Yangi xabarnoma', fine: 'Jarima', discipline: 'Intizomiy bildirishnoma' }[task.type] || 'Yangi vazifa';
  showToast(`${typeLabel}: ${noEmoji(task.title)}`, 4000, 'ok', 'inbox');
  if (!notifEnabled) return;
  // Bildirishnoma — service worker orqali (ishonchliroq, mobil fonда ham)
  if ('Notification' in window && Notification.permission === 'granted') {
    const opts = { body: noEmoji(task.title), icon: './icon-192.png', badge: './icon-192.png', vibrate: [100, 50, 100], tag: 'task-' + task.id };
    if ('serviceWorker' in navigator && navigator.serviceWorker.ready) {
      navigator.serviceWorker.ready.then(reg => reg.showNotification(typeLabel, opts)).catch(() => {
        try { new Notification(typeLabel, opts); } catch (e) { }
      });
    } else {
      try { new Notification(typeLabel, opts); } catch (e) { }
    }
  }
}

async function loadAdmins() {
  if (currentUser.role !== 'superadmin') return;
  admins = must(await sb.from('admins').select('id, name, login, permissions, is_super, user_id, created_at').order('name')) || [];
}

async function loadAttendance() {
  const from = tashkentDayStart(uzNow().dateStr);
  const to = new Date(from.getTime() + 24 * 3600 * 1000);
  attendances = must(await sb.from('attendance').select('*')
    .gte('time', from.toISOString()).lt('time', to.toISOString())
    .order('time', { ascending: false })) || [];
  renderTodayAttendance();
}

async function loadLate() {
  const data = must(await sb.from('attendance').select('*').eq('type', 'checkin').gt('late_minutes', 0)
    .order('time', { ascending: false }).limit(100));
  renderLate(data || []);
}


// ============================================================
// GEOLOCATION (GPS geofence)
// ============================================================
const GEOFENCE_DEFAULT_RADIUS = 100; // metr

// Qurilma lokatsiyasini olish (Promise)
function getPosition() {
  return new Promise((resolve, reject) => {
    // Xavfsiz kontekst tekshiruvi (HTTPS yoki localhost shart)
    if (!window.isSecureContext) {
      reject({ code: 'insecure', message: 'HTTPS kerak' });
      return;
    }
    if (!navigator.geolocation) {
      reject({ code: 'unsupported', message: 'Geolocation yo\'q' });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      pos => resolve(pos.coords),
      err => reject(err),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  });
}

// Geolocation xatosini o'qiladigan xabarga aylantirish
function geoErrorMessage(e) {
  if (!e) return 'Noma\'lum xatolik.';
  if (e.code === 'insecure') return 'Lokatsiya faqat HTTPS saytда ishlaydi. Saytни https:// orqали oching (file:// yoki http:// emas).';
  if (e.code === 'unsupported') return 'Bu qurilma/brauzer geolocation\'ни qo\'llab-quvvatlamaydi.';
  // Brauzerнинг standart kodlari
  switch (e.code) {
    case 1: return 'Lokatsiyага ruxsat berilmaган. Brauzer sozlamаларидан ruxsat bering.';
    case 2: return 'Joylashuvни aniqlаб bo\'lmади (GPS/internet signali yo\'q).';
    case 3: return 'Vaqт tugади. GPS\'ни yoqиб, ochiq joyда qayta urinиб ko\'ring.';
    default: return e.message || 'Noma\'lum xatolik.';
  }
}

// Ikki nuqta orasidagi masofa (metr) — Haversine
function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Berilgan koordinataga mos eng yaqin filialni topish (radius ichida)
function findMatchingBranch(lat, lng) {
  let best = null;
  branches.forEach(b => {
    if (b.lat == null || b.lng == null) return;
    const r = b.radius || GEOFENCE_DEFAULT_RADIUS;
    const dist = distanceMeters(lat, lng, Number(b.lat), Number(b.lng));
    if (dist <= r && (!best || dist < best.dist)) {
      best = { branch: b, dist: Math.round(dist) };
    }
  });
  return best; // { branch, dist } yoki null
}

// Radius ichidagi BARCHA filiallar (yaqinlikka qarab tartiblangan)
function findBranchesInRange(lat, lng) {
  const list = [];
  branches.forEach(b => {
    if (b.lat == null || b.lng == null) return;
    const r = b.radius || GEOFENCE_DEFAULT_RADIUS;
    const dist = distanceMeters(lat, lng, Number(b.lat), Number(b.lng));
    if (dist <= r) list.push({ branch: b, dist: Math.round(dist) });
  });
  list.sort((a, b) => a.dist - b.dist);
  return list;
}

// Bir nechta smena mos kelganda — xodim qaysisini tanlaydi (Promise)
let _shiftResolve = null;
function pickShift(candidates) {
  return new Promise(resolve => {
    _shiftResolve = resolve;
    const box = document.getElementById('shift-pick-list');
    box.innerHTML = candidates.map((c, i) => {
      const statusTxt = c.lateMin > 0
        ? `<span style="color:var(--red);font-size:12px;">${c.lateMin} min kech</span>`
        : c.earlyMin > 0
          ? `<span style="color:var(--green);font-size:12px;">${c.earlyMin} min oldin</span>`
          : `<span style="color:var(--green);font-size:12px;">Vaqtida</span>`;
      return `<button class="btn btn-secondary btn-full" style="margin-bottom:10px;justify-content:space-between;" data-idx="${i}">
    <span>${ic('clock')} ${esc(c.shift.label)}</span>${statusTxt}
  </button>`;
    }).join('');
    box.querySelectorAll('button').forEach(btnEl => {
      btnEl.onclick = () => {
        const c = candidates[Number(btnEl.dataset.idx)];
        closeModal('modal-shift-pick');
        const r = _shiftResolve; _shiftResolve = null;
        if (r) r(c);
      };
    });
    openModal('modal-shift-pick');
  });
}
function cancelShiftPick() {
  closeModal('modal-shift-pick');
  const r = _shiftResolve; _shiftResolve = null;
  if (r) r(null);
}

// Bir nechta filial radiusida bo'lsa — xodim qaysisini tanlaydi (Promise)
function pickBranch(matches) {
  return new Promise(resolve => {
    const box = document.getElementById('branch-pick-list');
    box.innerHTML = matches.map(m =>
      `<button class="btn btn-secondary btn-full" style="margin-bottom:10px;justify-content:space-between;" data-bid="${esc(m.branch.id)}">
    <span>${ic('building')} ${esc(m.branch.name)}</span>
    <span style="font-size:12px;color:var(--text2);">~${m.dist}m</span>
  </button>`
    ).join('');
    box.querySelectorAll('button').forEach(btnEl => {
      btnEl.onclick = () => {
        const b = matches.find(m => m.branch.id === btnEl.dataset.bid).branch;
        closeModal('modal-branch-pick');
        resolve(b);
      };
    });
    // Bekor qilganda null
    const ov = document.getElementById('modal-branch-pick');
    ov._onCancel = () => resolve(null);
    openModal('modal-branch-pick');
  });
}

// Kechikish sababini so'rash (Promise) — teg + ixtiyoriy izoh
let _lateResolve = null, _lateSelected = null;
function pickLateReason(lateMin) {
  return new Promise(resolve => {
    _lateResolve = resolve;
    _lateSelected = null;
    document.getElementById('late-reason-sub').textContent = `Siz ${lateMin} daqiqa kech keldingiz. Iltimos, sababini ko'rsating.`;
    document.getElementById('late-comment').value = '';
    const pills = document.getElementById('late-reason-pills');
    const tags = tagsByKind('late');
    pills.innerHTML = tags.length
      ? tags.map(tg => `<button type="button" class="pill" data-r="${esc(tg.label)}" onclick="selectLatePill(this)">${esc(tg.label)}</button>`).join('')
      : `<span style="font-size:12px;color:var(--text3);">Teglar yo'q — izohда yozing</span>`;
    openModal('modal-late-reason');
  });
}
function selectLatePill(el) {
  document.querySelectorAll('#late-reason-pills .pill').forEach(p => p.classList.remove('selected'));
  el.classList.add('selected');
  _lateSelected = el.dataset.r;
}
function submitLateReason() {
  const comment = document.getElementById('late-comment').value.trim();
  if (!_lateSelected && !comment) { showToast('Sabab tanlang yoki izoh yozing'); return; }
  closeModal('modal-late-reason');
  const res = { reason: _lateSelected || null, comment: comment || null };
  const r = _lateResolve; _lateResolve = null;
  if (r) r(res);
}
function cancelLateReason() {
  closeModal('modal-late-reason');
  const r = _lateResolve; _lateResolve = null;
  if (r) r(null);
}

// Motivatsion / tanbeh xabari (yuqorida kichik message)
function motivationalMessage(type, lateMin, earlyMin) {
  let msg, dur = 3000, kind = 'ok';
  if (type === 'checkin') {
    const rahmat = [
      `Xush kelibsiz! Davomat qayd etildi`,
      `Keldingiz qayd etildi. Samarali ish kuni tilaymiz`,
      `Xush kelibsiz — barakali ish kuni bo'lsin!`
    ];
    msg = rahmat[Math.floor(Math.random() * rahmat.length)];
  } else {
    const yakun = [
      `Bugungi mehnatingiz uchun rahmat! Yaxshi dam oling`,
      `Ish kuni yakunlandi. Zo'r ishladingiz, rahmat!`,
      `Mehnatingiz uchun tashakkur. Ko'rishguncha!`
    ];
    msg = yakun[Math.floor(Math.random() * yakun.length)];
  }
  showToast(msg, dur, kind);
}

// Admin: filial qo'shishda hozirgi joyni olish
async function grabBranchLocation(btn) {
  const status = document.getElementById('br-loc-status');
  const restore = btnLoading(btn);
  status.textContent = 'Joylashuv aniqlanmoqda...';
  status.style.color = 'var(--text2)';
  try {
    const c = await getPosition();
    document.getElementById('br-lat').value = c.latitude.toFixed(6);
    document.getElementById('br-lng').value = c.longitude.toFixed(6);
    status.innerHTML = `${ic('check')} Olindi (aniqlik: ±${Math.round(c.accuracy)}m)`;
    status.style.color = 'var(--accent)';
  } catch (e) {
    status.innerHTML = ic('x') + ' ' + esc(geoErrorMessage(e));
    status.style.color = 'var(--red)';
  } finally {
    restore();
  }
}


let myClockTimer = null;
let myTodayRecords = [];

// O'zbekiston (Tashkent, UTC+5) vaqtini olish
// Tashkent (Asia/Tashkent, UTC+5) vaqtini ishonchli olish.
// Qurilma soatining vaqt zonasidan qat'i nazar, har doim Tashkent vaqtini qaytaradi.
function uzParts(date) {
  // Berilgan (yoki hozirgi) lahzani Tashkent zonasidagi qism-qismlarga ajratadi
  const d = date || new Date();
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tashkent', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short'
  });
  const p = {};
  fmt.formatToParts(d).forEach(x => { p[x.type] = x.value; });
  let hour = parseInt(p.hour, 10);
  if (hour === 24) hour = 0; // ba'zi muhitlarda 24:00 chiqadi
  const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: +p.year, month: +p.month, day: +p.day,
    hour, minute: +p.minute, second: +p.second,
    dow: dowMap[p.weekday] ?? 0,
    dateStr: `${p.year}-${p.month}-${p.day}`
  };
}
// Soat/daqiqa ko'rsatish uchun
function uzNow() { return uzParts(); }

function setupMyAttendance() {
  document.getElementById('my-avatar').textContent = initialsOf(currentUser.name);
  document.getElementById('my-name').textContent = currentUser.name;
  document.getElementById('my-position').textContent = (currentUser.position || '') + (currentUser.branch_name ? ' • ' + currentUser.branch_name : '');
  if (myClockTimer) clearInterval(myClockTimer);
  tickClock();
  myClockTimer = setInterval(tickClock, 1000);
}

function tickClock() {
  const n = uzNow();
  const hh = String(n.hour).padStart(2, '0');
  const mm = String(n.minute).padStart(2, '0');
  const ss = String(n.second).padStart(2, '0');
  const clk = document.getElementById('my-clock');
  if (clk) clk.textContent = `${hh}:${mm}:${ss}`;
  const dt = document.getElementById('my-date');
  if (dt) {
    const dowNames = ['Yakshanba', 'Dushanba', 'Seshanba', 'Chorshanba', 'Payshanba', 'Juma', 'Shanba'];
    const monNames = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentyabr', 'oktyabr', 'noyabr', 'dekabr'];
    dt.textContent = `${dowNames[n.dow]}, ${n.day}-${monNames[n.month - 1]}`;
  }
}

async function refreshMyAttendance() {
  // Avval unutilgan (eski) sessiyani avtomatik yopamiz
  try { await autoCloseStaleSession(); } catch (e) { console.warn(e); }
  // Bugungi (Tashkent) kun chegarasi. Tashkent UTC+5 (DST yo'q).
  const n = uzNow();
  // Tashkent 00:00 = UTC (kun-1) 19:00
  const fromUtc = new Date(`${n.dateStr}T00:00:00+05:00`);
  const toUtc = new Date(fromUtc.getTime() + 24 * 3600 * 1000);
  const data = must(await sb.from('attendance').select('*')
    .eq('staff_id', currentUser.id)
    .gte('time', fromUtc.toISOString())
    .lt('time', toUtc.toISOString())
    .order('time', { ascending: true }));
  myTodayRecords = data || [];
  renderMyToday();
  // Bugungi ruxsat (ish boshlanishi surilgan bo'lsa) — xodimga ko'rsatiladi
  const pb = document.getElementById('my-permit-banner');
  try {
    const pm = must(await sb.from('attendance_permits').select('allowed_until, comment')
      .eq('staff_id', currentUser.id).eq('permit_date', n.dateStr).eq('cancelled', false).maybeSingle());
    if (pm && pb) {
      pb.innerHTML = `${ic('clock')} Bugun sizga ${esc(String(pm.allowed_until).slice(0, 5))} gacha kelishga ruxsat berilgan. Izoh: ${esc(pm.comment)}`;
      pb.style.display = '';
    } else if (pb) pb.style.display = 'none';
  } catch (e) { if (pb) pb.style.display = 'none'; }
}

function renderMyToday() {
  const box = document.getElementById('my-status-box');
  const rows = document.getElementById('my-today-rows');
  const session = openSession(); // ochiq sessiya bo'lsa — keldim qilingan, ketdim kutilmoqda

  // Tugmalar holati: sessiya ochiq bo'lsa faqat Ketdim, aks holda faqat Keldim
  const inBtn = document.getElementById('btn-checkin');
  const outBtn = document.getElementById('btn-checkout');
  inBtn.disabled = !!session;
  inBtn.style.opacity = session ? '0.45' : '1';
  outBtn.disabled = !session;
  outBtn.style.opacity = session ? '1' : '0.45';
  outBtn.title = !session ? 'Avval Keldim qiling' : `Ketdim: ${session.branch_name || ''}`;

  // Holat matni
  if (session) {
    outBtn.innerHTML = `${ic('log-out')} Ketdim — ${esc(session.branch_name || '')}`;
  } else {
    outBtn.innerHTML = ic('log-out') + ' Ketdim';
  }

  // Fokusni faol (bosilishi mumkin) tugmaga qaratish
  setTimeout(() => {
    const target = session ? outBtn : inBtn;
    if (target && !target.disabled) { try { target.focus({ preventScroll: true }); } catch (e) { try { target.focus(); } catch (_) { } } }
  }, 50);

  // Holat ko'rsatkichi
  const banner = document.getElementById('my-state-banner');
  if (banner) {
    if (session) {
      banner.style.display = '';
      banner.style.background = 'rgba(79,184,154,0.16)';
      banner.style.color = 'var(--green)';
      banner.innerHTML = `<span class="dot dot-green"></span>Ish vaqtidasiz — ${esc(session.branch_name || '')}`;
    } else if (myTodayRecords.length) {
      banner.style.display = '';
      banner.style.background = 'var(--inset-bg)';
      banner.style.color = 'var(--text2)';
      banner.innerHTML = '<span class="dot dot-gray"></span>Hozir ish vaqtida emassiz';
    } else {
      banner.style.display = 'none';
    }
  }

  if (!myTodayRecords.length) { box.style.display = 'none'; return; }
  box.style.display = '';
  rows.innerHTML = myTodayRecords.map(r => {
    const lp = uzParts(new Date(r.time));
    const hm = String(lp.hour).padStart(2, '0') + ':' + String(lp.minute).padStart(2, '0');
    const isIn = r.type === 'checkin';
    const autoClosed = r.auto_closed;
    return `<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;">
  <span style="font-weight:600;">${isIn ? ic('log-in') + ' Keldim' : ic('log-out') + ' Ketdim'}${r.branch_name ? ` <span style="color:var(--text2);font-weight:400;font-size:12px;">• ${esc(r.branch_name)}</span>` : ''}</span>
  <span style="display:flex;gap:6px;align-items:center;">
    <span class="time-badge">${hm}</span>
    ${autoClosed ? `<span class="late-badge" title="Avtomatik yopilgan">${ic('alert-triangle')} Tugatmagan</span>` : ''}
  </span>
</div>`;
  }).join('');
}

// Ochiq sessiyani aniqlash: oxirgi yozuv 'checkin' bo'lsa — sessiya ochiq
function openSession() {
  if (!myTodayRecords.length) return null;
  const last = myTodayRecords[myTodayRecords.length - 1];
  return last.type === 'checkin' ? last : null;
}

// Unutilgan Ketdim'ni avtomatik yopish — SERVERDA (close_my_stale_session):
// smena tugashi + 60 daqiqa o'tgan bo'lsa, smena tugash vaqti bilan "Ketdim (avto)" yoziladi.
// Qaytaradi: true (yopildi) yoki false.
async function autoCloseStaleSession() {
  return !!must(await sb.rpc('close_my_stale_session'));
}

// Yo'qolmaydigan eslatma modali (close tugmali)
// icon — ikonka nomi (ic()); rich — matn tizim bildirishnomasi (qatorlar ikonkalar bilan)
function infoModal(title, text, icon, rich) {
  document.getElementById('info-title').textContent = noEmoji(title) || 'Eslatma';
  const body = document.getElementById('info-text');
  if (rich) { body.innerHTML = richText(text); body.style.textAlign = 'left'; }
  else { body.textContent = text || ''; body.style.textAlign = ''; }
  document.getElementById('info-icon').innerHTML = ic(icon || 'clock', 'ic-xl');
  openModal('modal-info');
}


// Bugun qaysi smenalar bor (ish kunlari bo'yicha), boshlanish vaqti bilan tartiblangan
// Kelgan vaqtga tegishli smenani tanlash — serverdagi pick_shift() bilan BIR XIL qoida:
//   1) davom etayotgan smena (bir nechta bo'lsa eng kech boshlangani);
//   2) bo'lmasa — hali boshlanmagan eng yaqin smena (erta keldi);
//   3) bo'lmasa — eng kech tugagan smena (hammasi tugagandan keyin keldi).
// list elementlari: { startMin, endMin } (endMin yo'q bo'lsa oyna 4 soat)
function pickShiftAt(list, hm) {
  let inProg = null, upcoming = null, last = null;
  list.forEach(sh => {
    let end = sh.endMin != null ? sh.endMin : sh.startMin + 240;
    if (end <= sh.startMin) end += 1440; // yarim tundan o'tadigan smena
    if (hm >= sh.startMin && hm < end) { if (!inProg || sh.startMin > inProg.startMin) inProg = sh; }
    else if (hm < sh.startMin) { if (!upcoming || sh.startMin < upcoming.startMin) upcoming = sh; }
    else if (!last || end > last._end) { last = Object.assign({}, sh, { _end: end }); }
  });
  return inProg || upcoming || last;
}

function todayShiftsFor(dow) {
  let shifts = currentUser.shifts;
  if (typeof shifts === 'string') { try { shifts = JSON.parse(shifts); } catch (_) { shifts = []; } }
  if (!Array.isArray(shifts)) shifts = [];
  const list = shifts.filter(sh => {
    if (!sh || !sh.start) return false;
    if (!sh.days || !sh.days.length) return true; // kun belgilanmagan = har kun
    return sh.days.some(d => Number(d) === dow);
  }).map(sh => {
    const [sh_h, sh_m] = sh.start.split(':').map(Number);
    let endMin = sh_h * 60 + sh_m + 240;
    if (sh.end) { const [eh, em] = sh.end.split(':').map(Number); endMin = eh * 60 + em; }
    return { start: sh.start, end: sh.end || '', startMin: sh_h * 60 + sh_m, endMin, label: sh.start + (sh.end ? ('–' + sh.end) : '') };
  });
  list.sort((a, b) => a.startMin - b.startMin);
  return list;
}

function minToHHMM(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

async function myCheck(type) {
  // Smena ma'lumotini bazadan yangilaymiz (admin yangilagan bo'lsa, darhol kuchga kirsin).
  if (type === 'checkin') {
    try {
      const fresh = must(await sb.from('staff').select('shifts').eq('id', currentUser.id).single());
      if (fresh && 'shifts' in fresh) currentUser.shifts = fresh.shifts;
    } catch (e) { console.warn('shifts yangilash:', e); }
  }

  let session = openSession();

  // Keldim bosilganda: avval unutilgan eski sessiyani avtomatik yopishga urinamiz
  if (type === 'checkin' && session) {
    const closed = await autoCloseStaleSession();
    if (closed) {
      await refreshMyAttendance();
      session = openSession(); // qayta tekshiramiz
    }
  }

  // Tartib tekshiruvi
  if (type === 'checkin' && session) {
    showToast('Avval "Ketdim" qiling, keyin yana "Keldim".', 3000);
    return;
  }
  if (type === 'checkout' && !session) {
    showToast('Avval "Keldim" qiling!');
    return;
  }

  const btn = document.getElementById(type === 'checkin' ? 'btn-checkin' : 'btn-checkout');
  const restore = btnLoading(btn);

  try {
    // 1. GPS olish (keldim va ketdim uchun ham)
    showLoader('Joylashuv tekshirilmoqda...');
    let coords;
    try {
      coords = await getPosition();
    } catch (e) {
      hideLoader();
      showToast(geoErrorMessage(e), 4000);
      return;
    }

    // 2. Filialni aniqlash
    let chosenBranch;
    if (type === 'checkout') {
      // Ketdim — majburan o'sha keldim qilingan filialda
      const lockedId = session.branch_id;
      const lockedName = session.branch_name;
      const here = findMatchingBranch(coords.latitude, coords.longitude);
      hideLoader();
      if (!here || here.branch.id !== lockedId) {
        showToast(`Ketdim faqat "${lockedName}" filialida belgilanadi. Siz hozir u yerda emassiz.`, 4500);
        return;
      }
      chosenBranch = here.branch;
    } else {
      // Keldim — radiusdagi mos filial(lar)ni topish
      const matches = findBranchesInRange(coords.latitude, coords.longitude);
      hideLoader();
      if (!matches.length) {
        // Aniq sabab: GPS'li filial bormi? Eng yaqini necha metr?
        const withGps = branches.filter(b => b.lat != null && b.lng != null);
        if (!withGps.length) {
          infoModal('GPS o\'rnatilmagan', 'Hech qaysi filialga joylashuv (GPS) o\'rnatilmagan. Iltimos, administrator bilan bog\'laning — u filialga joylashuvni qo\'shishi kerak.', 'map-pin');
        } else {
          let nearest = Infinity;
          withGps.forEach(b => {
            const d = distanceMeters(coords.latitude, coords.longitude, Number(b.lat), Number(b.lng));
            if (d < nearest) nearest = d;
          });
          infoModal('Filial hududida emassiz',
            `Siz hech qaysi filial hududida emassiz, shuning uchun davomat qabul qilinmadi.\n\nEng yaqin filial ~${Math.round(nearest)} metr uzoqda (ruxsat etilgan masofa: ${GEOFENCE_DEFAULT_RADIUS} metr).\n\nIltimos, filial hududiga kiring va qayta urinib ko'ring.`, 'map-pin');
        }
        return;
      }
      // Har safar filial so'raladi (bitta bo'lsa ham tasdiqlash uchun)
      chosenBranch = await pickBranch(matches);
      if (!chosenBranch) return; // bekor qildi — finally restore qiladi
    }

    // 3. Vaqt va smena tahlili (faqat Keldim uchun)
    const local = uzNow();
    const hm = local.hour * 60 + local.minute;
    const dow = local.dow; // 0=Yakshanba ... 6=Shanba
    let lateMin = 0, earlyMin = 0;

    if (type === 'checkin') {
      const shifts = todayShiftsFor(dow);
      if (shifts.length) {
        // Davom etayotgan smena bo'yicha hisoblanadi (yakuniy hisob serverda — staff_check)
        const chosen = pickShiftAt(shifts, hm);
        const diff = hm - chosen.startMin; // + kech, - erta
        if (diff > 0) lateMin = diff;
        else if (diff < 0) earlyMin = -diff;
      }
    }

    // 4. Saqlash — serverda GPS radius, tartib, kechikish va jarima hisoblanadi (staff_check)
    let result = null;
    await withLoader(t('save') + '...', async () => {
      result = must(await sb.rpc('staff_check', {
        p_type: type,
        p_lat: coords.latitude,
        p_lng: coords.longitude,
        p_branch_id: chosenBranch.id
      }));
    });

    // 5. Kechikish bo'lsa — jarima / intizomiy bildirishnoma, aks holda motivatsion xabar
    if (result && result.freeze) {
      // Chegaradan oshdi — profil muzlatildi
      currentUser.frozen = true;
      currentUser.freeze_message = result.freeze.message;
      showFrozenScreen(result.freeze.message);
      return;
    }
    if (result && result.penalty) showPenaltyNotice(result.penalty);
    else motivationalMessage(type, lateMin, earlyMin);
    await refreshMyAttendance();
    loadTasks().catch(() => { });
  } catch (e) {
    hideLoader();
    showToast(errMsg(e), 5000);
  } finally {
    restore();
    renderMyToday();
  }
}

// ============================================================
// ATTENDANCE (Admin)
// ============================================================
// Tanlangan tab gorizontal ro'yxatda ko'rinib tursin
function scrollTabIntoView(id) {
  const el = document.getElementById(id);
  if (el && el.parentElement) {
    const box = el.parentElement;
    box.scrollTo({ left: el.offsetLeft - (box.clientWidth - el.offsetWidth) / 2, behavior: 'smooth' });
  }
}

function switchAttTab(tab) {
  ['checkin', 'report', 'late', 'issues', 'permits'].forEach(t => {
    document.getElementById('att-' + t).classList.toggle('hidden', t !== tab);
    document.getElementById('att-tab-' + t).classList.toggle('active', t === tab);
  });
  scrollTabIntoView('att-tab-' + tab);
  if (tab === 'checkin') loadAttendance().catch(e => showToast(errMsg(e), 4000));
  if (tab === 'report') { populateReportBranch(); loadReport(); }
  if (tab === 'late') loadLate().catch(e => showToast(errMsg(e), 4000));
  if (tab === 'permits') renderPermits();
  if (tab === 'issues') {
    const di = document.getElementById('issues-date');
    if (di && !di.value) di.value = uzNow().dateStr;
    renderIssues();
  }
}

// ============================================================
// MUAMMOLI: kelmagan / tugatmagan (hisoblanadi)
// ============================================================
// Kun bo'yicha barcha davomat yozuvlari (Tashkent kun chegarasi)
async function fetchDayAttendance(dateStr) {
  const from = tashkentDayStart(dateStr);
  const to = new Date(from.getTime() + 24 * 3600 * 1000);
  return fetchAll(() => sb.from('attendance').select('*')
    .gte('time', from.toISOString()).lt('time', to.toISOString())
    .order('time', { ascending: true }).order('id'));
}

function parseShifts(raw) {
  let shifts = raw;
  if (typeof shifts === 'string') { try { shifts = JSON.parse(shifts); } catch (_) { shifts = []; } }
  return Array.isArray(shifts) ? shifts : [];
}

// Kelmaganlar va Ketdim qilmaganlar (Muammoli tab va Dashboard uchun umumiy hisob)
function computeIssues(dateStr, records) {
  const dowLocal = uzParts(new Date(`${dateStr}T12:00:00+05:00`)).dow;
  const nowLocal = uzNow();
  const isToday = dateStr === nowLocal.dateStr;
  const nowMin = nowLocal.hour * 60 + nowLocal.minute;
  const nowMs = Date.now();
  const toMin = hm => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
  const notCome = [];   // kelmagan
  const notClosed = []; // tugatmagan (checkin bor, checkout yo'q va smena+1soat o'tgan)

  staffList.forEach(st => {
    if (st.frozen) return; // muzlatilgan xodim ishga kelishi kutilmaydi
    // Shu kunga tegishli smenalar
    const todayShifts = parseShifts(st.shifts).filter(sh => {
      if (!sh || !sh.start) return false;
      if (!sh.days || !sh.days.length) return true;
      return sh.days.some(d => Number(d) === dowLocal);
    });
    if (!todayShifts.length) return; // bugun ish kuni emas

    const myRecs = records.filter(r => r.staff_id === st.id);
    if (!myRecs.some(r => r.type === 'checkin')) {
      // KELMAGAN: o'tgan kun bo'lsa, yoki bugun eng erta smena boshlangan bo'lsa
      const earliestStart = Math.min(...todayShifts.map(sh => toMin(sh.start)));
      if (!isToday || nowMin >= earliestStart) {
        notCome.push({ name: st.name, branch: st.branch_name || '', shifts: todayShifts });
      }
      return;
    }

    // TUGATMAGAN: oxirgi yozuvi checkin va smena tugashi + 1 soat o'tgan
    const last = myRecs[myRecs.length - 1];
    if (last.type !== 'checkin') return;
    const lp = uzParts(new Date(last.time));
    const cMin = lp.hour * 60 + lp.minute;
    const near = pickShiftAt(todayShifts.map(sh => ({ start: sh.start, end: sh.end, startMin: toMin(sh.start), endMin: sh.end ? toMin(sh.end) : null })), cMin);
    let dur = 240;
    if (near.end) { dur = near.endMin - near.startMin; if (dur <= 0) dur += 1440; }
    const deadline = new Date(last.time).getTime() + (dur + 60) * 60000;
    if (nowMs >= deadline) notClosed.push({ name: st.name, branch: last.branch_name || '', checkinTime: lp });
  });
  return { notCome, notClosed };
}

function issuesHtml({ notCome, notClosed }) {
  const row = (left, right) => `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-top:1px solid var(--glass-border);">
  <span style="font-weight:600;">${left}</span>
  <span style="font-size:12px;color:var(--text2);">${right}</span>
</div>`;
  const head = (icon, color, title, n) => `<div style="font-weight:700;font-size:14px;margin-bottom:12px;display:flex;align-items:center;gap:8px;">
  <span style="color:${color};display:inline-flex;">${ic(icon)}</span> ${title} <span style="color:var(--text3);font-weight:400;">(${n})</span>
</div>`;
  const none = txt => `<div style="font-size:13px;color:var(--text3);padding:6px 0;display:flex;align-items:center;gap:6px;">${ic('check-circle')} ${txt}</div>`;
  return `<div class="card" style="margin-bottom:14px;">${head('x-circle', 'var(--red)', 'Kelmaganlar', notCome.length)}${notCome.length
      ? notCome.map(x => row(esc(x.name), esc(x.shifts.map(s => s.start + (s.end ? '–' + s.end : '')).join(', ')))).join('')
      : none('Kelmaganlar yo\'q')}</div>
<div class="card">${head('alert-triangle', 'var(--yellow)', 'Ketdim qilmaganlar', notClosed.length)}${notClosed.length
      ? notClosed.map(x => row(esc(x.name), `Keldi: ${pad2(x.checkinTime.hour)}:${pad2(x.checkinTime.minute)} • Ketdim yo'q`)).join('')
      : none('Hammasi Ketdim qilgan')}</div>`;
}

async function renderIssues() {
  const box = document.getElementById('issues-list');
  box.innerHTML = `<div style="text-align:center;padding:20px;color:var(--text2);">Hisoblanmoqda...</div>`;
  const dateStr = document.getElementById('issues-date').value || uzNow().dateStr;
  try {
    const records = await fetchDayAttendance(dateStr);
    box.innerHTML = issuesHtml(computeIssues(dateStr, records));
  } catch (e) {
    box.innerHTML = '';
    showToast(errMsg(e), 4000);
  }
}

// ============================================================
// DAVOMAT DASHBOARD — har bir blok alohida ruxsat bilan
// ============================================================
const LEVEL_LABELS = { notice: 'Bildirishnoma', warning: 'Ogohlantirish', reprimand: 'Tanbeh', severe: 'Qattiq tanbeh' };
const LEVEL_ICONS = { notice: 'bell', warning: 'alert-triangle', reprimand: 'alert-circle', severe: 'ban' };
const MONTHS_UZ = ['Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun', 'Iyul', 'Avgust', 'Sentyabr', 'Oktyabr', 'Noyabr', 'Dekabr'];

// Soniyalarni "1 soat 5 daqiqa 3 soniya" ko'rinishiga o'tkazish
function fmtLate(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  const parts = [];
  if (s >= 3600) parts.push(Math.floor(s / 3600) + ' soat');
  if (Math.floor((s % 3600) / 60) > 0) parts.push(Math.floor((s % 3600) / 60) + ' daqiqa');
  if (s % 60 > 0 || !parts.length) parts.push((s % 60) + ' soniya');
  return parts.join(' ');
}
function fmtMoney(n) {
  return Number(n || 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 }).replace(/ | /g, ' ');
}
const lateSecOf = r => (r.late_seconds > 0 ? r.late_seconds : (r.late_minutes || 0) * 60);

// Tanlangan sana oyidagi jarima / intizom yozuvlari
async function fetchMonthPenalties(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  const from = tashkentDayStart(`${y}-${pad2(m)}-01`);
  const to = tashkentDayStart(m === 12 ? `${y + 1}-01-01` : `${y}-${pad2(m + 1)}-01`);
  return fetchAll(() => sb.from('penalties').select('*')
    .gte('late_at', from.toISOString()).lt('late_at', to.toISOString())
    .order('late_at', { ascending: false }).order('id'));
}

let _dashSeq = 0;
async function renderDashboard() {
  const di = document.getElementById('dash-date');
  if (!di.value) di.value = uzNow().dateStr;
  const dateStr = di.value;
  const seq = ++_dashSeq;
  const showStats = can('dashboard'), showLate = can('dashboard_late'),
    showAbsent = can('dashboard_absent'), showPen = can('dashboard_penalties');
  show('dash-stats', showStats);
  show('dash-late-card', showLate);
  show('dash-absent-card', showAbsent);
  show('dash-pen-card', showPen);
  show('dash-empty', !(showStats || showLate || showAbsent || showPen));
  try {
    const [records, pens] = await Promise.all([
      (showStats || showLate || showAbsent) ? fetchDayAttendance(dateStr) : [],
      showPen ? fetchMonthPenalties(dateStr) : []
    ]);
    if (seq !== _dashSeq) return; // sana o'zgargan — eski javobni tashlaymiz
    const checkins = records.filter(r => r.type === 'checkin');
    const lateRecs = checkins.filter(r => r.late_minutes > 0);
    const issues = (showStats || showAbsent) ? computeIssues(dateStr, records) : null;

    if (showStats) {
      const keyOf = r => r.staff_id || r.staff_name;
      const isToday = dateStr === uzNow().dateStr;
      const lastBy = {};
      records.forEach(r => { lastBy[keyOf(r)] = r; });
      document.getElementById('dash-came').textContent = new Set(checkins.map(keyOf)).size;
      document.getElementById('dash-late').textContent = new Set(lateRecs.map(keyOf)).size;
      document.getElementById('dash-absent').textContent = issues.notCome.length;
      document.getElementById('dash-working').textContent = isToday
        ? Object.values(lastBy).filter(r => r.type === 'checkin').length
        : issues.notClosed.length;
      document.getElementById('dash-working-lbl').textContent = isToday ? 'Hozir ishda' : 'Ketdim qilmagan';
    }

    if (showLate) {
      const rows = lateRecs.slice().sort((a, b) => lateSecOf(b) - lateSecOf(a));
      document.getElementById('dash-late-card').innerHTML = `<div style="font-weight:700;font-size:14px;margin-bottom:12px;display:flex;align-items:center;gap:6px;">${ic('clock')} Kechikkanlar <span style="color:var(--text3);font-weight:400;">(${rows.length})</span></div>`
        + (rows.length ? rows.map(r => `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 0;border-top:1px solid var(--glass-border);">
  <div style="min-width:0;">
    <div style="font-weight:600;">${esc(r.staff_name || '-')}</div>
    <div style="font-size:12px;color:var(--text2);">${esc(r.branch_name || '')} • Keldi: ${fmtUzTime(r.time)}</div>
  </div>
  <span class="late-badge" style="flex-shrink:0;">+${fmtLate(lateSecOf(r))}</span>
</div>`).join('') : `<div style="font-size:13px;color:var(--text3);padding:6px 0;">${ic('check-circle')} Kechikkanlar yo'q</div>`);
    }

    if (showAbsent) document.getElementById('dash-absent-card').innerHTML = issuesHtml(issues);
    if (showPen) renderDashPenalties(pens, dateStr);
  } catch (e) {
    showToast(errMsg(e), 4000);
  }
}

// Oy bo'yicha jarima va intizom xulosasi (kun / daqiqa / summa kesimida)
let _dashPens = [];
function renderDashPenalties(allPens, dateStr) {
  _dashPens = allPens;
  const pens = allPens.filter(p => !p.cancelled); // bekor qilinganlar jamlanmaga kirmaydi
  const [y, m] = dateStr.split('-').map(Number);
  const fines = pens.filter(p => p.kind === 'fine');
  const sumByCur = list => {
    const acc = {};
    list.forEach(p => { if (p.currency) acc[p.currency] = (acc[p.currency] || 0) + Number(p.amount || 0); });
    return Object.entries(acc).map(([c, v]) => `${fmtMoney(v)} ${esc(c)}`).join(' + ') || '0';
  };
  const levelCounts = Object.keys(LEVEL_LABELS).map(l => [l, pens.filter(p => p.level === l).length]);

  const byStaff = {};
  pens.forEach(p => {
    const k = p.staff_id || p.staff_name;
    const s = byStaff[k] = byStaff[k] || { name: p.staff_name, days: new Set(), sec: 0, fines: [], levels: {} };
    s.days.add(uzParts(new Date(p.late_at)).dateStr);
    s.sec += Number(p.late_seconds || 0);
    if (p.kind === 'fine') s.fines.push(p);
    if (p.level) s.levels[p.level] = (s.levels[p.level] || 0) + 1;
  });
  const staffRows = Object.values(byStaff).sort((a, b) => b.sec - a.sec);
  const cell = 'padding:8px 4px;border-bottom:1px solid var(--card-border);';

  document.getElementById('dash-pen-card').innerHTML = `
<div style="font-weight:700;font-size:14px;margin-bottom:12px;display:flex;align-items:center;gap:6px;">${ic('banknote')} Jarima va intizom — ${MONTHS_UZ[m - 1]} ${y}</div>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;">
  <div style="text-align:center;padding:10px;border-radius:12px;background:var(--inset-bg);box-shadow:var(--shadow-in);">
    <div style="font-size:16px;font-weight:800;color:var(--red);">${sumByCur(fines)}</div>
    <div style="font-size:11px;color:var(--text2);">Jami jarima (${fines.length} ta)</div>
  </div>
  <div style="text-align:center;padding:10px;border-radius:12px;background:var(--inset-bg);box-shadow:var(--shadow-in);">
    <div style="font-size:16px;font-weight:800;color:var(--yellow);">${pens.filter(p => p.kind === 'discipline').length}</div>
    <div style="font-size:11px;color:var(--text2);">Intizomiy bildirishnomalar</div>
  </div>
</div>
<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;">
  ${levelCounts.map(([l, n]) => `<span class="tag tag-yellow">${ic(LEVEL_ICONS[l])} ${LEVEL_LABELS[l]}: ${n}</span>`).join('')}
</div>
${staffRows.length ? `<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:12px;">
  <thead><tr style="color:var(--text2);">
    <th style="text-align:left;${cell}">Xodim</th>
    <th style="text-align:right;${cell}">Kun</th>
    <th style="text-align:right;${cell}">Kechikish</th>
    <th style="text-align:right;${cell}">Jarima</th>
    <th style="text-align:left;${cell}">Choralar</th>
  </tr></thead>
  <tbody>${staffRows.map(s => `<tr>
    <td style="${cell}font-weight:600;">${esc(s.name || '-')}</td>
    <td style="${cell}text-align:right;">${s.days.size}</td>
    <td style="${cell}text-align:right;">${fmtLate(s.sec)}</td>
    <td style="${cell}text-align:right;">${s.fines.length ? sumByCur(s.fines) : '—'}</td>
    <td style="${cell}">${Object.entries(s.levels).map(([l, n]) => `${ic(LEVEL_ICONS[l])}${n}`).join(' ') || '—'}</td>
  </tr>`).join('')}</tbody>
</table></div>` : `<div style="font-size:13px;color:var(--text3);padding:6px 0;">${ic('check-circle')} Bu oyda jarima va intizomiy choralar yo'q</div>`}
${allPens.length ? `<details style="margin-top:12px;"${can('penalty_cancel') ? ' open' : ''}>
  <summary style="cursor:pointer;font-weight:700;font-size:13px;margin-bottom:8px;">${ic('file-text')} Barcha yozuvlar (${allPens.length})</summary>
  ${allPens.map(penaltyRowHtml).join('')}
</details>` : ''}`;
}

function penaltyWhat(p) {
  if (p.kind === 'fine') return `${ic('banknote')} ${fmtMoney(p.amount)} ${esc(p.currency || '')}${p.level ? ' · ' + LEVEL_LABELS[p.level] : ''}`;
  return `${ic(LEVEL_ICONS[p.level] || 'scale')} ${LEVEL_LABELS[p.level] || 'Intizom'}`;
}

function penaltyRowHtml(p) {
  return `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 0;border-top:1px solid var(--glass-border);${p.cancelled ? 'opacity:0.6;' : ''}">
  <div style="min-width:0;">
    <div style="font-weight:600;${p.cancelled ? 'text-decoration:line-through;' : ''}">${esc(p.staff_name || '-')} — ${penaltyWhat(p)}</div>
    <div style="font-size:11px;color:var(--text2);">${fmtUzDateTime(p.late_at)} • +${fmtLate(p.late_seconds)}</div>
    ${p.cancelled ? `<div style="font-size:11px;color:var(--text3);">${ic('x-circle')} Bekor qilingan: ${esc(p.cancelled_by || '')}${p.cancelled_at ? ', ' + fmtUzDateTime(p.cancelled_at) : ''} — ${esc(p.cancel_reason || '')}</div>` : ''}
  </div>
  ${!p.cancelled && can('penalty_cancel') ? `<button class="btn btn-sm btn-danger" style="flex-shrink:0;" onclick="openCancelPenalty('${esc(p.id)}')">Bekor qilish</button>` : ''}
</div>`;
}

// ============================================================
// DAVOMATNI O'CHIRISH ("attendance_delete" ruxsati, izoh majburiy)
// ============================================================
let _deleteAtt = null;

function deleteAttButton(a) {
  if (!can('attendance_delete')) return '';
  return `<button class="icon-btn icon-btn-danger" title="Yozuvni o'chirish" aria-label="Yozuvni o'chirish" onclick="openDeleteAttendance('${esc(a.id)}')">${ic('trash')}</button>`;
}

function openDeleteAttendance(id) {
  const a = attendances.find(x => x.id === id) || _lastReportData.find(x => x.id === id);
  if (!a) return;
  _deleteAtt = a;
  document.getElementById('da-info').innerHTML = `<b>${esc(a.staff_name || '-')}</b>\n`
    + `${a.type === 'checkin' ? ic('log-in') + ' Keldi' : ic('log-out') + ' Ketdi'} — ${fmtUzDateTime(a.time)}${a.branch_name ? ' • ' + esc(a.branch_name) : ''}`
    + (a.late_minutes > 0 ? `\n${ic('timer')} Kechikish: ${fmtDuration(a.late_minutes)} (jarimasi bekor qilinadi)` : '');
  document.getElementById('da-reason').value = '';
  openModal('modal-delete-att');
  setTimeout(() => document.getElementById('da-reason').focus(), 200);
}

async function confirmDeleteAttendance(btn) {
  const reason = document.getElementById('da-reason').value.trim();
  if (!reason) { showToast('O\'chirish sababini yozing (majburiy)', 3000); document.getElementById('da-reason').focus(); return; }
  if (!_deleteAtt) return;
  const restore = btnLoading(btn);
  let res = null;
  const ok = await run(t('del') + '...', async () => {
    res = must(await sb.rpc('delete_attendance', { p_id: _deleteAtt.id, p_reason: reason }));
  });
  restore();
  if (!ok) return;
  closeModal('modal-delete-att');
  _deleteAtt = null;
  showToast(res && res.penalty_cancelled ? 'Yozuv o\'chirildi, jarima bekor qilindi' : 'Yozuv o\'chirildi', 2500, 'ok');
  // Ochiq ro'yxatlarni yangilash
  loadAttendance().catch(() => { });
  if (!document.getElementById('att-report').classList.contains('hidden')) loadReport();
  if (!document.getElementById('att-late').classList.contains('hidden')) loadLate().catch(() => { });
  if (isAdminUser()) loadStaff().catch(() => { });
}

// ============================================================
// KECHIKISHGA RUXSAT ("attendance_permit" ruxsati)
// ============================================================
const DOW_UZ = ['Yakshanba', 'Dushanba', 'Seshanba', 'Chorshanba', 'Payshanba', 'Juma', 'Shanba'];

async function renderPermits() {
  const box = document.getElementById('permits-list');
  box.innerHTML = `<div style="text-align:center;padding:20px;color:var(--text2);">Yuklanmoqda...</div>`;
  const from = new Date(tashkentDayStart(uzNow().dateStr).getTime() - 7 * 864e5);
  let list = [];
  try {
    list = must(await sb.from('attendance_permits').select('*')
      .gte('permit_date', uzParts(from).dateStr)
      .order('permit_date', { ascending: false }).order('created_at', { ascending: false })) || [];
  } catch (e) { box.innerHTML = ''; showToast(errMsg(e), 4000); return; }
  const today = uzNow().dateStr;
  box.innerHTML = list.length ? list.map(pm => {
    const d = String(pm.permit_date);
    const [y, m, dd] = d.split('-');
    const canCancel = !pm.cancelled && d >= today;
    return `<div class="card" style="display:flex;align-items:center;gap:12px;${pm.cancelled ? 'opacity:0.55;' : ''}">
<div style="flex:1;min-width:0;">
  <div style="font-weight:700;font-size:14px;${pm.cancelled ? 'text-decoration:line-through;' : ''}">${esc(pm.staff_name || '-')}</div>
  <div style="font-size:12px;color:var(--text2);">${ic('calendar')} ${dd}.${m}.${y} • ${ic('clock')} ${esc(String(pm.allowed_until).slice(0, 5))} gacha</div>
  <div style="font-size:12px;color:var(--text2);">${ic('file-text')} ${esc(pm.comment)}</div>
  <div style="font-size:11px;color:var(--text3);">${ic('user')} ${esc(pm.created_by || '')}${pm.cancelled ? ` • ${ic('x-circle')} bekor qilingan (${esc(pm.cancelled_by || '')})` : ''}</div>
</div>
${canCancel ? `<button class="btn btn-sm btn-danger" onclick="cancelPermit('${esc(pm.id)}')">Bekor</button>` : ''}
</div>`;
  }).join('') : `<div class="empty"><div class="empty-icon">${ic('clock')}</div><h3>Ruxsatlar yo'q</h3></div>`;
}

function openPermitModal() {
  const sel = document.getElementById('pm-staff');
  sel.innerHTML = '<option value="">Xodimni tanlang</option>' + staffList.filter(s => !s.frozen)
    .map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
  document.getElementById('pm-date').value = uzNow().dateStr;
  document.getElementById('pm-date').min = uzNow().dateStr;
  document.getElementById('pm-until').value = '';
  document.getElementById('pm-comment').value = '';
  updatePermitHint();
  openModal('modal-permit');
}

// Tanlangan kun uchun xodim smenasi va ruxsat natijasini ko'rsatish
function updatePermitHint() {
  const hint = document.getElementById('pm-hint');
  const st = staffList.find(s => s.id === document.getElementById('pm-staff').value);
  const date = document.getElementById('pm-date').value;
  if (!st || !date) { hint.textContent = ''; return; }
  const dow = uzParts(new Date(`${date}T12:00:00+05:00`)).dow;
  const shifts = parseShifts(st.shifts).filter(sh => sh && sh.start && (!sh.days || !sh.days.length || sh.days.some(d => Number(d) === dow)));
  if (!shifts.length) { hint.innerHTML = `<span style="color:var(--red);">${ic('alert-triangle')} ${DOW_UZ[dow]} kuni bu xodimga smena belgilanmagan.</span>`; return; }
  const until = document.getElementById('pm-until').value;
  hint.textContent = `${DOW_UZ[dow]} kungi smena: ${shifts.map(s => s.start + (s.end ? '–' + s.end : '')).join(', ')}`
    + (until ? ` → ${until} gacha kelsa, kechikish hisoblanmaydi.` : '');
}

async function savePermit(btn) {
  const staffId = document.getElementById('pm-staff').value;
  const date = document.getElementById('pm-date').value;
  const until = document.getElementById('pm-until').value;
  const comment = document.getElementById('pm-comment').value.trim();
  if (!staffId || !date || !until) { showToast('Xodim, kun va vaqtni tanlang'); return; }
  if (!comment) { showToast(SERVER_ERRORS.NEED_COMMENT); document.getElementById('pm-comment').focus(); return; }
  const restore = btnLoading(btn);
  let res = null;
  const ok = await run(t('save') + '...', async () => {
    res = must(await sb.rpc('grant_permit', { p_staff: staffId, p_date: date, p_until: until.slice(0, 5), p_comment: comment }));
  });
  restore();
  if (!ok) return;
  closeModal('modal-permit');
  showToast(`${res.staff_name}: ${res.until} gacha ruxsat berildi${res.replaced ? ' (avvalgisi almashtirildi)' : ''}`, 3000, 'ok');
  renderPermits();
}

async function cancelPermit(id) {
  if (!await confirmDialog('Ruxsat bekor qilinsinmi?', 'Xodimning ish vaqti odatdagidek hisoblanadi. Xodimga xabar yuboriladi.')) return;
  const ok = await run(t('save') + '...', async () => { must(await sb.rpc('cancel_permit', { p_id: id })); });
  if (!ok) return;
  showToast('Ruxsat bekor qilindi', 1800, 'ok');
  renderPermits();
}

// ============================================================
// JARIMANI BEKOR QILISH ("penalty_cancel" ruxsati)
// ============================================================
let _cancelPenalty = null;

function openCancelPenalty(id, penObj) {
  const p = penObj || _dashPens.find(x => x.id === id);
  if (!p) return;
  if (p.cancelled) { showToast(SERVER_ERRORS.ALREADY_CANCELLED); return; }
  _cancelPenalty = p;
  document.getElementById('cp-info').innerHTML = `<b>${esc(p.staff_name || '-')}</b>\n${penaltyWhat(p)}\n${ic('calendar')} ${fmtUzDateTime(p.late_at)} • ${ic('timer')} ${fmtLate(p.late_seconds)} kechikish`;
  document.getElementById('cp-reason').value = '';
  openModal('modal-cancel-penalty');
  setTimeout(() => document.getElementById('cp-reason').focus(), 200);
}

// Vazifalar panelidagi jarima bildirishnomasidan bekor qilish
async function cancelPenaltyFromTask(taskId) {
  let pen = null;
  const ok = await run('Yuklanmoqda...', async () => {
    pen = must(await sb.from('penalties').select('*').eq('task_id', taskId).maybeSingle());
  });
  if (!ok) return;
  if (!pen) { showToast('Bu bildirishnomaga bog\'langan jarima topilmadi', 3000); return; }
  closeModal('modal-task-detail');
  openCancelPenalty(pen.id, pen);
}

async function confirmCancelPenalty(btn) {
  const reason = document.getElementById('cp-reason').value.trim();
  if (!reason) { showToast(SERVER_ERRORS.NEED_REASON); return; }
  if (!_cancelPenalty) return;
  const restore = btnLoading(btn);
  const ok = await run(t('save') + '...', async () => {
    must(await sb.rpc('cancel_penalty', { p_id: _cancelPenalty.id, p_reason: reason }));
  });
  restore();
  if (!ok) return;
  closeModal('modal-cancel-penalty');
  _cancelPenalty = null;
  showToast('Jarima bekor qilindi, xodimga xabar yuborildi', 2500, 'ok');
  loadTasks().catch(() => { });
  const active = document.querySelector('.page.active');
  if (active && active.id === 'page-dashboard') renderDashboard();
}

// Xodimga kechikish natijasini ko'rsatish (jarima yoki intizomiy chora)
function showPenaltyNotice(p) {
  infoModal(p.title, p.body, p.kind === 'fine' ? 'banknote' : (LEVEL_ICONS[p.level] || 'alert-triangle'), true);
}

function openCheckIn() {
  document.getElementById('ci-time').value = toTashkentInput(new Date());
  document.getElementById('ci-comment').value = '';
  selectedCIType = 'checkin';
  document.querySelectorAll('#modal-checkin .pill-entity').forEach((p, i) => p.classList.toggle('selected', i === 0));
  openModal('modal-checkin');
}
function selectCIType(t) { selectedCIType = t; document.querySelectorAll('#modal-checkin .pill-entity').forEach(p => { p.classList.toggle('selected', p.textContent.trim() === (t === 'checkin' ? 'Keldi' : 'Ketdi')); }); }

async function saveCheckIn() {
  const staffId = document.getElementById('ci-staff').value;
  const branchId = document.getElementById('ci-branch').value;
  const time = document.getElementById('ci-time').value;
  const comment = document.getElementById('ci-comment').value.trim();
  if (!staffId || !time) { showToast('Ma\'lumot to\'ldiring!'); return; }
  if (!comment) { showToast('Izoh yozish majburiy: nega qo\'lda belgilanmoqda?', 3000); document.getElementById('ci-comment').focus(); return; }
  // Kechikish serverda xodim "Keldim" qilgandagi qoida bilan bir xil hisoblanadi
  let result = null;
  const ok = await run(t('save') + '...', async () => {
    result = must(await sb.rpc('admin_add_attendance', {
      p_staff_id: staffId,
      p_branch_id: branchId || null,
      p_type: selectedCIType,
      p_time: tashkentInputToISO(time),
      p_comment: comment
    }));
    await loadAttendance();
  });
  if (!ok) return;
  if (result && result.freeze) {
    infoModal('Xodim profili muzlatildi', result.freeze.message, 'snowflake');
    loadStaff().catch(() => { });
  } else {
    showToast(result && result.penalty ? `${t('saved')} · ${result.penalty.title}` : t('saved'), result && result.penalty ? 4500 : 2000);
  }
  closeModal('modal-checkin');
}

// Kelish holati belgisi: kechikkan / smena belgilanmagan / vaqtida (Ketdi yozuvlariga belgi qo'yilmaydi)
function attendanceBadge(a) {
  return attendanceStatusBadge(a) + attendanceNotes(a);
}
// Qo'lda belgilangan / ruxsat bilan kelgan yozuvlar uchun izoh
function attendanceNotes(a) {
  let html = '';
  if (a.permit_until) html += `<div style="font-size:11px;color:var(--accent);margin-top:2px;" title="${esc(a.permit_comment || '')}">${ic('clock')} Ruxsat: ${esc(a.permit_until)} gacha</div>`;
  if (a.manual) html += `<div style="font-size:11px;color:var(--text2);margin-top:2px;max-width:220px;text-align:right;">${ic('pen-line')} ${esc(a.manual_by || '')}: ${esc(a.manual_comment || '')}</div>`;
  return html;
}
function attendanceStatusBadge(a) {
  if (a.type !== 'checkin') return a.auto_closed ? `<span class="late-badge" title="Avtomatik yopilgan">avto</span>` : '';
  if (a.late_minutes > 0) return `<span class="late-badge">+${fmtDuration(a.late_minutes)} kech</span>`;
  if (a.no_shift) return `<span class="late-badge" style="background:rgba(224,162,60,0.18);color:var(--yellow);" title="Bu kunga xodimga smena belgilanmagan — kechikishni hisoblab bo'lmaydi">Smena yo'q</span>`;
  return `<span class="on-time-badge">Vaqtida</span>`;
}

function renderTodayAttendance() {
  const el = document.getElementById('today-attendance');
  if (!attendances.length) { el.innerHTML = `<div class="empty"><div class="empty-icon">${ic('clipboard')}</div><h3>${t('no_data')}</h3></div>`; return; }
  el.innerHTML = attendances.map(a => {
    const hm = fmtUzTime(a.time);
    return `<div class="shift-card">
  <div class="shift-row">
    <div>
      <div style="font-weight:700;font-size:14px;">${esc(a.staff_name || '-')}</div>
      <div style="font-size:12px;color:var(--text2);">${esc(a.branch_name || '')}</div>
    </div>
    <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;">
      <div style="display:flex;align-items:center;gap:6px;">
        <span class="time-badge">${ic(a.type === 'checkin' ? 'log-in' : 'log-out')} ${hm}</span>
        ${deleteAttButton(a)}
      </div>
      ${attendanceBadge(a)}
    </div>
  </div>
</div>`;
  }).join('');
}

function renderLate(data) {
  const late = data.filter(a => a.late_minutes > 0);
  const el = document.getElementById('late-list');
  if (!late.length) { el.innerHTML = `<div class="empty"><div class="empty-icon">${ic('check-circle')}</div><h3>Kechikkanlar yo'q</h3></div>`; return; }
  el.innerHTML = late.map(a => {
    return `<div class="shift-card">
  <div class="shift-row">
    <div>
      <div style="font-weight:700;font-size:14px;">${esc(a.staff_name || '-')}</div>
      <div style="font-size:12px;color:var(--text2);">${esc(a.branch_name || '')} • ${fmtUzDateTime(a.time)}</div>
    </div>
    <span class="late-badge">+${fmtDuration(a.late_minutes)}</span>
  </div>
  ${(a.late_reason || a.late_comment) ? `<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--glass-border);">
    ${a.late_reason ? `<span class="tag tag-yellow">${esc(a.late_reason)}</span>` : ''}
    ${a.late_comment ? `<div style="font-size:12px;color:var(--text2);margin-top:4px;">${ic('message')} ${esc(a.late_comment)}</div>` : ''}
  </div>` : ''}
</div>`;
  }).join('');
}

function setReportPeriod(p) {
  reportPeriod = p;
  ['daily', 'weekly', 'monthly', 'custom'].forEach(x => document.getElementById('rp-' + x).classList.toggle('active', x === p));
  const range = document.getElementById('report-date-range');
  if (range) range.style.display = p === 'custom' ? 'flex' : 'none';
  if (p === 'custom') {
    // Default: shu oyning boshidan bugungacha
    const now = uzNow();
    const from = document.getElementById('report-from');
    const to = document.getElementById('report-to');
    if (from && !from.value) from.value = `${now.year}-${String(now.month).padStart(2, '0')}-01`;
    if (to && !to.value) to.value = now.dateStr;
  }
  loadReport();
}

function populateReportBranch() {
  const sel = document.getElementById('report-branch');
  if (sel) sel.innerHTML = '<option value="">Barcha filiallar</option>' + branches.map(b => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('');
  const staffSel = document.getElementById('report-staff');
  if (staffSel) staffSel.innerHTML = '<option value="">Barcha xodimlar</option>' + staffList.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
}

async function loadReport() {
  const branchId = document.getElementById('report-branch')?.value;
  const staffId = document.getElementById('report-staff')?.value;
  const statusFilter = document.getElementById('report-status')?.value || '';
  // Davr chegaralari — Tashkent vaqti bo'yicha (qurilma vaqt zonasiga bog'liq emas)
  const n = uzNow();
  const today0 = tashkentDayStart(n.dateStr);
  const monthStart = tashkentDayStart(`${n.year}-${pad2(n.month)}-01`);
  let from, to = null;

  if (reportPeriod === 'daily') { from = today0; }
  else if (reportPeriod === 'weekly') { from = new Date(today0.getTime() - ((n.dow + 6) % 7) * 864e5); } // dushanbadan
  else if (reportPeriod === 'monthly') { from = monthStart; }
  else if (reportPeriod === 'custom') {
    const fv = document.getElementById('report-from')?.value;
    const tv = document.getElementById('report-to')?.value;
    from = fv ? tashkentDayStart(fv) : monthStart;
    to = tv ? new Date(tashkentDayStart(tv).getTime() + 864e5) : null;
  }

  let data;
  try {
    data = await fetchAll(() => {
      let query = sb.from('attendance').select('*').gte('time', from.toISOString())
        .order('time', { ascending: false }).order('id');
      if (to) query = query.lt('time', to.toISOString());
      if (branchId) query = query.eq('branch_id', branchId);
      if (staffId) query = query.eq('staff_id', staffId);
      return query;
    });
  } catch (e) {
    showToast(errMsg(e), 4000);
    return;
  }

  // Holat filtri (client-side)
  if (statusFilter === 'late') data = data.filter(r => r.type === 'checkin' && r.late_minutes > 0);
  else if (statusFilter === 'ontime') data = data.filter(r => r.type === 'checkin' && !(r.late_minutes > 0) && !r.no_shift);
  else if (statusFilter === 'auto') data = data.filter(r => r.auto_closed);

  renderReportSummary(data);
  renderReportTable(data);
  renderDonutChart(data);
}

// Hisobot xulosasi (umumiy sonlar)
function renderReportSummary(data) {
  const box = document.getElementById('report-summary');
  if (!box) return;
  const checkins = data.filter(r => r.type === 'checkin');
  const lateCount = checkins.filter(r => r.late_minutes > 0).length;
  const onTimeCount = checkins.filter(r => !(r.late_minutes > 0) && !r.no_shift).length;
  const autoCount = data.filter(r => r.auto_closed).length;
  const totalLateMin = checkins.reduce((s, r) => s + (r.late_minutes > 0 ? r.late_minutes : 0), 0);
  if (!data.length) { box.style.display = 'none'; return; }
  box.style.display = '';
  box.innerHTML = `
<div style="font-weight:700;font-size:14px;margin-bottom:12px;">Xulosa</div>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
  <div style="text-align:center;padding:10px;border-radius:12px;background:var(--inset-bg);box-shadow:var(--shadow-in);">
    <div style="font-size:22px;font-weight:800;color:var(--green);">${onTimeCount}</div>
    <div style="font-size:11px;color:var(--text2);">Vaqtida kelgan</div>
  </div>
  <div style="text-align:center;padding:10px;border-radius:12px;background:var(--inset-bg);box-shadow:var(--shadow-in);">
    <div style="font-size:22px;font-weight:800;color:var(--red);">${lateCount}</div>
    <div style="font-size:11px;color:var(--text2);">Kechikkan</div>
  </div>
  <div style="text-align:center;padding:10px;border-radius:12px;background:var(--inset-bg);box-shadow:var(--shadow-in);">
    <div style="font-size:22px;font-weight:800;color:var(--yellow);">${autoCount}</div>
    <div style="font-size:11px;color:var(--text2);">Tugatmagan (avto)</div>
  </div>
  <div style="text-align:center;padding:10px;border-radius:12px;background:var(--inset-bg);box-shadow:var(--shadow-in);">
    <div style="font-size:16px;font-weight:800;color:var(--accent);">${fmtDuration(totalLateMin)}</div>
    <div style="font-size:11px;color:var(--text2);">Jami kechikish</div>
  </div>
</div>`;
}

// Animatik doirali (donut) diagramma — xodimlar bo'yicha kelishlar soni
function renderDonutChart(data) {
  const card = document.getElementById('report-chart-card');
  const svg = document.getElementById('donut-chart');
  const legend = document.getElementById('donut-legend');
  if (!card || !svg) return;

  // Faqat checkin (kelish) larni xodim bo'yicha sanaймиз
  const counts = {};
  data.filter(r => r.type === 'checkin').forEach(r => {
    const name = r.staff_name || '-';
    counts[name] = (counts[name] || 0) + 1;
  });
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!entries.length) { card.style.display = 'none'; return; }
  card.style.display = '';

  const total = entries.reduce((s, [, v]) => s + v, 0);
  const palette = ['#6c7ce0', '#5fc4a6', '#e0a23c', '#e06b7c', '#8a7cd8', '#4fb89a', '#5b9bd5', '#d05568'];
  const cx = 90, cy = 90, r = 64, sw = 26;
  const circ = 2 * Math.PI * r;

  let offset = 0;
  let segs = '';
  entries.forEach(([name, val], i) => {
    const len = (val / total) * circ;
    const color = palette[i % palette.length];
    segs += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="${sw}"
  stroke-dasharray="${len} ${circ - len}" stroke-dashoffset="${-offset}"
  transform="rotate(-90 ${cx} ${cy})" opacity="0">
  <animate attributeName="opacity" from="0" to="1" dur="0.4s" begin="${i * 0.15}s" fill="freeze"/>
  <animate attributeName="stroke-dasharray" from="0 ${circ}" to="${len} ${circ - len}" dur="0.7s" begin="${i * 0.15}s" fill="freeze" calcMode="spline" keySplines="0.4 0 0.2 1"/>
</circle>`;
    offset += len;
  });

  svg.innerHTML = `
<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--inset-bg)" stroke-width="${sw}"/>
${segs}
<text x="${cx}" y="${cy - 4}" text-anchor="middle" font-size="26" font-weight="800" fill="var(--text)" font-family="Sora,sans-serif">${total}</text>
<text x="${cx}" y="${cy + 16}" text-anchor="middle" font-size="11" fill="var(--text2)" font-family="Manrope,sans-serif">kelish</text>
`;

  legend.innerHTML = entries.map(([name, val], i) => {
    const color = palette[i % palette.length];
    const pct = Math.round(val / total * 100);
    return `<div style="display:flex;align-items:center;gap:8px;font-size:12px;">
  <span style="width:12px;height:12px;border-radius:4px;background:${color};flex-shrink:0;"></span>
  <span style="flex:1;">${esc(name)}</span>
  <span style="font-weight:700;color:var(--text2);">${val} (${pct}%)</span>
</div>`;
  }).join('');
}

function renderReportTable(data) {
  const el = document.getElementById('report-table');
  if (!data.length) { el.innerHTML = `<div class="empty"><h3>${t('no_data')}</h3></div>`; _lastReportData = []; return; }
  const canDel = can('attendance_delete');
  el.innerHTML = `<div class="table-wrap">
<table class="report-table">
  <thead><tr>
    <th>Xodim</th><th>Sana</th><th>Vaqt</th><th>Amal</th><th class="num">Kechikish</th><th>Sabab / izoh</th>${canDel ? '<th class="act"></th>' : ''}
  </tr></thead>
  <tbody>${data.map(r => {
    const lp = uzParts(new Date(r.time));
    const dateStr = `${pad2(lp.day)}.${pad2(lp.month)}.${lp.year}`;
    const timeStr = `${pad2(lp.hour)}:${pad2(lp.minute)}`;
    const reasonCell = (r.late_reason ? `<span class="tag tag-yellow">${esc(r.late_reason)}</span>` : '')
      + (r.late_comment ? `<div class="note">${esc(r.late_comment)}</div>` : '')
      + (r.permit_until ? `<div class="note note-accent">${ic('clock')} Ruxsat ${esc(r.permit_until)} gacha: ${esc(r.permit_comment || '')}</div>` : '')
      + (r.manual ? `<div class="note">${ic('pen-line')} Qo'lda (${esc(r.manual_by || '')}): ${esc(r.manual_comment || '')}</div>` : '');
    const action = r.type === 'checkin'
      ? `<span class="act-in">${ic('log-in')} Keldi</span>`
      : `<span class="act-out">${ic('log-out')} Ketdi</span>`;
    const late = r.late_minutes > 0
      ? `<span class="late-badge">${fmtDuration(r.late_minutes)}</span>`
      : (r.type === 'checkin' && r.no_shift ? `<span class="muted-warn">Smena yo'q</span>` : '');
    return `<tr>
      <td class="name">${esc(r.staff_name || '-')}</td>
      <td class="nowrap muted">${dateStr}</td>
      <td class="nowrap strong">${timeStr}</td>
      <td class="nowrap">${action}${r.auto_closed ? ' <span class="muted-warn">(avto)</span>' : ''}</td>
      <td class="num">${late}</td>
      <td class="reason">${reasonCell}</td>
      ${canDel ? `<td class="act">${deleteAttButton(r)}</td>` : ''}
    </tr>`;
  }).join('')}</tbody>
</table>
</div>`;
  _lastReportData = data;
}

let _lastReportData = [];

// Xom yozuvlarni ish sessiyalariga (Keldi–Ketdi juft) aylantirish
function buildSessions(data) {
  // Xodim bo'yicha, vaqt bo'yicha o'sish tartibida
  const byStaff = {};
  data.slice().sort((a, b) => new Date(a.time) - new Date(b.time)).forEach(r => {
    (byStaff[r.staff_id] = byStaff[r.staff_id] || []).push(r);
  });
  const sessions = [];
  Object.values(byStaff).forEach(recs => {
    let open = null;
    recs.forEach(r => {
      if (r.type === 'checkin') {
        if (open) sessions.push(makeSession(open, null)); // oldingi yopilmagan
        open = r;
      } else { // checkout
        if (open) { sessions.push(makeSession(open, r)); open = null; }
        else sessions.push(makeSession(null, r)); // keldimsiz ketdi
      }
    });
    if (open) sessions.push(makeSession(open, null));
  });
  // Sana bo'yicha teskari (yangi birinchi)
  sessions.sort((a, b) => b.sortTime - a.sortTime);
  return sessions;
}
function makeSession(cin, cout) {
  const ref = cin || cout;
  const lp = uzParts(new Date(ref.time));
  let durMin = null;
  if (cin && cout) durMin = Math.round((new Date(cout.time) - new Date(cin.time)) / 60000);
  return {
    staff_name: ref.staff_name || '-',
    branch_name: ref.branch_name || '-',
    date: `${String(lp.day).padStart(2, '0')}.${String(lp.month).padStart(2, '0')}.${lp.year}`,
    checkin: cin ? uzParts(new Date(cin.time)) : null,
    checkout: cout ? uzParts(new Date(cout.time)) : null,
    lateMin: cin && cin.late_minutes > 0 ? cin.late_minutes : 0,
    noShift: !!(cin && cin.no_shift),
    lateReason: cin ? (cin.late_reason || '') : '',
    autoClosed: cout ? cout.auto_closed : false,
    durMin,
    sortTime: new Date(ref.time).getTime()
  };
}
function hhmm(p) { return p ? `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}` : '—'; }

function exportExcel() {
  if (!_lastReportData.length) { showToast('Ma\'lumot yo\'q'); return; }
  const rows = [['Xodim', 'Sana', 'Vaqt', 'Amal', 'Kechikish', 'Kechikish (daqiqa)', 'Sabab', 'Izoh', 'Filial']];
  _lastReportData.forEach(r => {
    const lp = uzParts(new Date(r.time));
    rows.push([
      r.staff_name || '',
      `${String(lp.day).padStart(2, '0')}.${String(lp.month).padStart(2, '0')}.${lp.year}`,
      `${String(lp.hour).padStart(2, '0')}:${String(lp.minute).padStart(2, '0')}`,
      r.type === 'checkin' ? (r.auto_closed ? 'Keldi' : 'Keldi') : (r.auto_closed ? 'Ketdi (avto)' : 'Ketdi'),
      r.late_minutes > 0 ? fmtDuration(r.late_minutes) : '',
      r.late_minutes > 0 ? r.late_minutes : 0,
      r.late_reason || '',
      [r.late_comment, r.permit_until ? `Ruxsat ${r.permit_until} gacha: ${r.permit_comment || ''}` : '', r.manual ? `Qo'lda (${r.manual_by || ''}): ${r.manual_comment || ''}` : '']
        .filter(Boolean).join('; '),
      r.branch_name || ''
    ]);
  });
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 18 }, { wch: 12 }, { wch: 8 }, { wch: 12 }, { wch: 16 }, { wch: 14 }, { wch: 16 }, { wch: 20 }, { wch: 20 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Davomat');
  XLSX.writeFile(wb, `Davomat_${uzNow().dateStr}.xlsx`);
}

// Ish sessiyalari — Keldi–Ketdi juftlangan, ish soati bilan (o'qish oson)
function exportExcelSessions() {
  if (!_lastReportData.length) { showToast('Ma\'lumot yo\'q'); return; }
  const sessions = buildSessions(_lastReportData);
  const rows = [['Xodim', 'Sana', 'Keldi', 'Ketdi', 'Ish vaqti', 'Kechikish', 'Holat', 'Sabab', 'Filial']];
  sessions.forEach(s => {
    let holat = [];
    if (s.lateMin > 0) holat.push(`${fmtDuration(s.lateMin)} kech`);
    else if (s.checkin) holat.push(s.noShift ? 'Smena yo\'q' : 'Vaqtida');
    if (!s.checkout) holat.push('Ketdim yo\'q');
    if (s.autoClosed) holat.push('Avto-yopilgan');
    if (!s.checkin) holat.push('Keldimsiz');
    rows.push([
      s.staff_name, s.date,
      hhmm(s.checkin), hhmm(s.checkout),
      s.durMin != null ? fmtDuration(s.durMin) : '—',
      s.lateMin > 0 ? fmtDuration(s.lateMin) : '',
      holat.join(', '),
      s.lateReason || '', s.branch_name
    ]);
  });
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 18 }, { wch: 12 }, { wch: 8 }, { wch: 8 }, { wch: 16 }, { wch: 16 }, { wch: 24 }, { wch: 16 }, { wch: 20 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Ish sessiyalari');
  XLSX.writeFile(wb, `Ish_sessiyalari_${uzNow().dateStr}.xlsx`);
}

// ============================================================
// TASKS
// ============================================================
const TASK_ICONS = { task: 'clipboard', note: 'info', alert: 'bell', fine: 'banknote', discipline: 'scale' };
const isSystemTask = task => task.type === 'fine' || task.type === 'discipline' || task.created_by === 'system';

function renderTasks() {
  const el = document.getElementById('tasks-list');
  if (!tasks.length) { el.innerHTML = `<div class="empty"><div class="empty-icon">${ic('clipboard')}</div><h3>${t('no_data')}</h3></div>`; return; }
  el.innerHTML = tasks.map(task => {
    const d = task.deadline ? new Date(task.deadline) : null;
    const isUrgent = d && d < new Date() && !task.done;
    const typeLabel = { task: t('task'), note: t('note'), alert: t('alert'), fine: 'Jarima', discipline: 'Intizom' }[task.type] || task.type;
    const typeCls = { task: 'tag-blue', note: 'tag-blue', alert: 'tag-red', fine: 'tag-red', discipline: 'tag-yellow' }[task.type] || 'tag-blue';
    const created = task.created_at ? fmtUzDate(task.created_at) : '';
    const seen = seenTaskIds();
    const isNew = !seen.includes(task.id) && !task.done;
    return `<div class="task-card ${task.done ? 'done' : (isUrgent ? 'urgent' : 'normal')}" onclick="openTaskDetail('${esc(task.id)}')" style="${task.done ? 'opacity:0.6;' : ''}">
  <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
    ${task.done ? `<span style="color:var(--green);flex-shrink:0;display:inline-flex;">${ic('check')}</span>` : (isNew ? `<span style="width:8px;height:8px;border-radius:50%;background:var(--red);flex-shrink:0;"></span>` : '')}
    <div style="font-size:14px;font-weight:700;${task.done ? 'text-decoration:line-through;' : ''}">${esc(isSystemTask(task) ? noEmoji(task.title) : task.title)}</div>
  </div>
  <div style="font-size:13px;color:var(--text2);margin-bottom:8px;">${(() => { const b = isSystemTask(task) ? noEmoji(task.body).replace(/\n+/g, ' · ') : (task.body || ''); return esc(b.slice(0, 80)) + (b.length > 80 ? '...' : ''); })()}</div>
  <div class="task-meta">
    <span class="tag ${typeCls}">${ic(TASK_ICONS[task.type] || 'clipboard')} ${esc(typeLabel)}</span>
    ${task.assigned_name ? `<span class="tag tag-blue">${ic('user')} ${esc(task.assigned_name)}</span>` : ''}
    ${d ? `<span class="tag ${isUrgent ? 'tag-red' : 'tag-yellow'}">${ic('clock')} ${fmtUzDate(d)}</span>` : ''}
    ${task.done ? `<span class="tag" style="background:rgba(79,184,154,0.18);color:var(--green);">${ic('check')} Bajarilgan</span>` : ''}
  </div>
  <div style="font-size:11px;color:var(--text3);margin-top:8px;">${ic('calendar')} Berilgan: ${created}</div>
</div>`;
  }).join('');
}

function openAddTask() {
  editingTaskId = null;
  const titleEl = document.querySelector('#modal-task .modal-title');
  if (titleEl) titleEl.textContent = 'Yangi vazifa';
  document.getElementById('t-title').value = ''; document.getElementById('t-body').value = '';
  document.getElementById('t-deadline').value = '';
  selectedTaskType = 'task';
  document.querySelectorAll('#modal-task .pill-entity').forEach((p, i) => p.classList.toggle('selected', i === 0));
  populateTaskStaff();
  openModal('modal-task');
}

function selectTaskType(type) {
  selectedTaskType = type;
  const labels = { task: t('task'), note: t('note'), alert: t('alert') };
  document.querySelectorAll('#modal-task .pill-entity').forEach(p => p.classList.toggle('selected', p.textContent.trim() === labels[type]));
}

function populateTaskStaff() {
  const sel = document.getElementById('t-staff');
  sel.innerHTML = '<option value="">Barcha xodimlar</option>' + staffList.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
}

async function saveTask() {
  const title = document.getElementById('t-title').value.trim();
  if (!title) { showToast('Sarlavha kerak!'); return; }
  const staffId = document.getElementById('t-staff').value;
  const staff = staffList.find(s => s.id === staffId);
  const obj = {
    title, body: document.getElementById('t-body').value,
    assigned_to: staffId || null, assigned_name: staff?.name || null,
    type: selectedTaskType, deadline: tashkentInputToISO(document.getElementById('t-deadline').value)
  };
  const ok = await run(t('save') + '...', async () => {
    if (editingTaskId) {
      const { error } = await sb.from('tasks').update(obj).eq('id', editingTaskId);
      if (error) throw error;
    } else {
      const { error } = await sb.from('tasks').insert([{ ...obj, created_by: currentUser.id, replies: [], done: false }]);
      if (error) throw error;
    }
    await loadTasks();
  });
  if (!ok) return;
  showToast(t('saved'), 1500, 'ok');
  editingTaskId = null;
  closeModal('modal-task');
  showPage('tasks');
  renderTasks();
}

function openTaskDetail(id) {
  const task = tasks.find(x => x.id === id);
  if (!task) return;
  currentTaskId = id;
  const replies = task.replies || [];
  const d = task.deadline ? new Date(task.deadline) : null;
  const isSystem = task.type === 'fine' || task.type === 'discipline'; // avtomatik jarima / intizom bildirishnomasi
  document.getElementById('task-detail-content').innerHTML = `
<div style="margin-bottom:16px;">
  ${task.done ? `<div class="tag" style="background:rgba(79,184,154,0.18);color:var(--green);display:inline-block;margin-bottom:8px;">${ic('check')} Bajarilgan</div>` : ''}
  <div style="font-size:18px;font-weight:700;margin-bottom:8px;">${esc(isSystemTask(task) ? noEmoji(task.title) : task.title)}</div>
  ${isSystemTask(task)
    ? `<div style="font-size:14px;color:var(--text2);margin-bottom:12px;">${richText(task.body)}</div>`
    : `<div style="font-size:14px;color:var(--text2);margin-bottom:12px;white-space:pre-wrap;">${esc(task.body || '')}</div>`}
  ${task.assigned_name ? `<div class="tag tag-blue" style="display:inline-block;margin-bottom:8px;">${ic('user')} ${esc(task.assigned_name)}</div>` : ''}
  ${d ? `<div class="tag tag-yellow" style="display:inline-block;margin-bottom:8px;">${ic('clock')} Muddat: ${fmtUzDateTime(d)}</div>` : ''}
  ${replies.length ? `<div style="margin-top:12px;"><div style="font-size:12px;color:var(--text2);margin-bottom:8px;">Javoblar:</div>${replies.map(r => `<div class="reply-box"><div class="reply-from">${esc(r.from)}</div><div class="reply-item">${esc(r.text)}</div></div>`).join('')}</div>` : ''}
</div>`;

  // Amal tugmalari
  const actions = document.getElementById('task-detail-actions');
  let html = '';
  // Bajarildi/qaytarish — hamma (jumladan tayinlangan xodim)
  if (task.done) {
    html += `<button class="btn btn-secondary btn-full" onclick="toggleTaskDone(false)" style="margin-bottom:8px;">${ic('undo')} ${isSystem ? 'Tanishilmagan' : 'Bajarilmagan'} deb belgilash</button>`;
  } else {
    html += `<button class="btn btn-primary btn-full" onclick="toggleTaskDone(true)" style="margin-bottom:8px;">${ic('check')} ${isSystem ? 'Tanishdim' : 'Bajarildi'}</button>`;
  }
  // Jarima / intizom bildirishnomasi — "penalty_cancel" ruxsati bilan bekor qilish
  const isCancelNotice = /^Bekor qilingan|bekor qilindi$/.test(noEmoji(task.title));
  if (isSystem && !isCancelNotice && can('penalty_cancel')) {
    html += `<button class="btn btn-danger btn-full" onclick="cancelPenaltyFromTask('${esc(task.id)}')" style="margin-bottom:8px;">${ic('x-circle')} ${task.type === 'fine' ? 'Jarimani' : 'Chorani'} bekor qilish</button>`;
  }
  // Tahrirlash/o'chirish — "tasks_manage" ruxsati bilan; avtomatik bildirishnomalar tahrirlanmaydi
  if (can('tasks_manage')) {
    html += `<div style="display:flex;gap:8px;">
  ${isSystem ? '' : `<button class="btn btn-secondary" onclick="editTask()" style="flex:1;">${ic('pencil')} Tahrirlash</button>`}
  <button class="btn btn-danger" onclick="deleteTask()" style="flex:1;">${ic('trash')} O'chirish</button>
</div>`;
  }
  actions.innerHTML = html;

  document.getElementById('reply-section').style.display = '';
  document.getElementById('reply-input').value = '';
  openModal('modal-task-detail');
}

// Bajarildi holatini almashtirish
async function toggleTaskDone(done) {
  if (!currentTaskId) return;
  const ok = await run(t('save') + '...', async () => {
    must(await sb.rpc('task_set_done', { p_task: currentTaskId, p_done: done }));
    await loadTasks();
  });
  if (!ok) return;
  showToast(done ? 'Bajarildi deb belgilandi' : 'Qaytarildi', 1500, done ? 'ok' : '');
  closeModal('modal-task-detail');
}

// Vazifani tahrirlash (admin)
function editTask() {
  const task = tasks.find(x => x.id === currentTaskId);
  if (!task) return;
  closeModal('modal-task-detail');
  document.getElementById('t-title').value = task.title || '';
  document.getElementById('t-body').value = task.body || '';
  document.getElementById('t-deadline').value = task.deadline ? toTashkentInput(new Date(task.deadline)) : '';
  selectedTaskType = task.type || 'task';
  const labels = { task: t('task'), note: t('note'), alert: t('alert') };
  document.querySelectorAll('#modal-task .pill-entity').forEach(p => p.classList.toggle('selected', p.textContent.trim() === labels[selectedTaskType]));
  populateTaskStaff();
  document.getElementById('t-staff').value = task.assigned_to || '';
  editingTaskId = currentTaskId;
  document.querySelector('#modal-task .modal-title').textContent = 'Vazifani tahrirlash';
  openModal('modal-task');
}

// Vazifani o'chirish (admin)
async function deleteTask() {
  if (!currentTaskId) return;
  const ok = await confirmDialog('Vazifa o\'chirilsinmi?', 'Bu amalni qaytarib bo\'lmaydi.');
  if (!ok) return;
  const done = await run(t('del') + '...', async () => {
    must(await sb.from('tasks').delete().eq('id', currentTaskId));
    await loadTasks();
  });
  if (!done) return;
  showToast(t('deleted'), 1500);
  closeModal('modal-task-detail');
}

async function sendReply() {
  const text = document.getElementById('reply-input').value.trim();
  if (!text || !currentTaskId) return;
  // Javob serverda atomar qo'shiladi — bir vaqtda yozilgan javoblar yo'qolmaydi
  const ok = await run(t('save') + '...', async () => {
    must(await sb.rpc('task_add_reply', { p_task: currentTaskId, p_text: text }));
    await loadTasks();
  });
  if (!ok) return;
  showToast(t('saved'));
  closeModal('modal-task-detail');
}

// ============================================================
// STAFF (ADMIN)
// ============================================================
function switchAdminTab(tab) {
  ['staff', 'branches', 'penalty', 'freeze', 'admins', 'tags'].forEach(t => {
    document.getElementById('adm-' + t).classList.toggle('hidden', t !== tab);
    document.getElementById('adm-tab-' + t).classList.toggle('active', t === tab);
  });
  scrollTabIntoView('adm-tab-' + tab);
  if (tab === 'staff') renderStaff();
  if (tab === 'branches') renderBranches();
  if (tab === 'penalty') renderPenaltySettings();
  if (tab === 'freeze') renderFreeze();
  if (tab === 'admins') renderAdmins();
  if (tab === 'tags') renderTags();
}

// ============================================================
// TAGS (Sabab teglari — Super Admin)
// ============================================================
const TAG_KINDS = [
  { kind: 'late', label: 'Kechikish sabablari' }
];

// ============================================================
// JARIMA SOZLAMALARI ("penalty_settings" ruxsati)
// ============================================================
const UNIT_LABELS = { second: 'soniya', minute: 'daqiqa', hour: 'soat' };
const UNIT_SECONDS = { second: 1, minute: 60, hour: 3600 };

async function loadPenaltySettings() {
  penaltySettings = must(await sb.from('penalty_settings').select('*').eq('id', 1).maybeSingle());
}

function renderPenaltySettings() {
  const s = penaltySettings || { unit: 'minute', amount: 0, currency: 'UZS', warning_from: 6, reprimand_from: 16, severe_from: 31 };
  document.getElementById('pen-unit').value = s.unit;
  document.getElementById('pen-amount').value = Number(s.amount);
  document.getElementById('pen-currency').value = s.currency;
  document.getElementById('pen-warning').value = s.warning_from;
  document.getElementById('pen-reprimand').value = s.reprimand_from;
  document.getElementById('pen-severe').value = s.severe_from;
  ['pen-unit', 'pen-amount', 'pen-currency', 'pen-warning', 'pen-reprimand', 'pen-severe']
    .forEach(id => { document.getElementById(id).oninput = updatePenaltyHints; });
  updatePenaltyHints();
}

function readPenaltyForm() {
  return {
    unit: document.getElementById('pen-unit').value,
    amount: Number(document.getElementById('pen-amount').value),
    currency: document.getElementById('pen-currency').value.trim().toUpperCase(),
    warning_from: parseInt(document.getElementById('pen-warning').value, 10),
    reprimand_from: parseInt(document.getElementById('pen-reprimand').value, 10),
    severe_from: parseInt(document.getElementById('pen-severe').value, 10)
  };
}

function penaltyFormError(f) {
  if (!UNIT_SECONDS[f.unit]) return 'Hisoblash birligini tanlang';
  if (!Number.isFinite(f.amount) || f.amount < 0) return 'Summa 0 yoki undan katta son bo\'lishi kerak';
  if (!f.currency || f.currency.length > 10) return 'Valyutani kiriting (masalan: UZS)';
  if (![f.warning_from, f.reprimand_from, f.severe_from].every(Number.isInteger)) return 'Chegaralarni butun son bilan kiriting';
  if (!(f.warning_from >= 2 && f.warning_from < f.reprimand_from && f.reprimand_from < f.severe_from))
    return 'Chegaralar: 2 ≤ Ogohlantirish < Tanbeh < Qattiq tanbeh bo\'lishi kerak';
  return null;
}

function updatePenaltyHints() {
  const f = readPenaltyForm();
  const sample = 17 * 60 + 42; // 17 daqiqa 42 soniya
  const units = UNIT_SECONDS[f.unit] ? Math.floor(sample / UNIT_SECONDS[f.unit]) : 0;
  const amt = Number.isFinite(f.amount) ? f.amount : 0;
  document.getElementById('pen-example').textContent =
    `Masalan: ${fmtLate(sample)} kechiksa → ${units} ${UNIT_LABELS[f.unit] || ''} × ${fmtMoney(amt)} ${f.currency} = ${fmtMoney(units * amt)} ${f.currency}`;
  const err = penaltyFormError(f);
  document.getElementById('pen-levels').innerHTML = err && /Chegara/.test(err) ? ic('alert-triangle') + ' ' + esc(err)
    : `1–${f.warning_from - 1} daq: ${ic('bell')} Bildirishnoma · ${f.warning_from}–${f.reprimand_from - 1}: ${ic('alert-triangle')} Ogohlantirish · `
    + `${f.reprimand_from}–${f.severe_from - 1}: ${ic('alert-circle')} Tanbeh · ${f.severe_from}+: ${ic('ban')} Qattiq tanbeh`;
}

async function savePenaltySettings() {
  const f = readPenaltyForm();
  const err = penaltyFormError(f);
  if (err) { showToast(err, 3500); return; }
  const ok = await run(t('save') + '...', async () => {
    penaltySettings = must(await sb.from('penalty_settings')
      .update({ ...f, updated_at: new Date().toISOString() }).eq('id', 1).select().single());
  });
  if (!ok) return;
  renderPenaltySettings();
  showToast(t('saved'), 1500, 'ok');
}

function renderTags() {
  const box = document.getElementById('tags-groups');
  box.innerHTML = TAG_KINDS.map(k => {
    const list = tagsByKind(k.kind);
    const chips = list.length
      ? list.map(tg => `<span class="branch-chip" style="cursor:default;">${esc(tg.label)}
      <button onclick="deleteTag('${esc(tg.id)}')" style="background:none;border:none;color:var(--red);cursor:pointer;font-weight:700;margin-left:2px;">${ic('x')}</button>
    </span>`).join('')
      : `<span style="font-size:12px;color:var(--text3);">Hali teg yo'q</span>`;
    return `<div class="card">
  <div style="font-weight:700;font-size:14px;margin-bottom:10px;">${k.label}</div>
  <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;">${chips}</div>
  <div style="display:flex;gap:8px;">
    <input type="text" id="tag-input-${k.kind}" placeholder="Yangi teg..." style="flex:1;padding:9px 12px;border-radius:10px;border:none;background:var(--inset-bg);color:var(--text);box-shadow:var(--shadow-in);font-family:'Manrope',sans-serif;font-size:13px;">
    <button class="btn btn-sm btn-primary" onclick="addTag('${k.kind}')">+ Qo'shish</button>
  </div>
</div>`;
  }).join('');
}

async function addTag(kind) {
  const inp = document.getElementById('tag-input-' + kind);
  const label = inp.value.trim();
  if (!label) return;
  const maxSort = Math.max(0, ...tagsByKind(kind).map(t => t.sort || 0));
  const ok = await run(t('save') + '...', async () => {
    must(await sb.from('app_tags').insert([{ kind, label, sort: maxSort + 1 }]));
    await loadTags();
  });
  if (!ok) return;
  showToast(t('saved'), 1500, 'ok');
  renderTags();
}

async function deleteTag(id) {
  if (!await confirmDialog('Teg o\'chirilsinmi?', '')) return;
  const ok = await run(t('del') + '...', async () => {
    must(await sb.from('app_tags').delete().eq('id', id));
    await loadTags();
  });
  if (!ok) return;
  showToast(t('deleted'), 1500);
  renderTags();
}

function renderStaff() {
  const el = document.getElementById('staff-list');
  if (!staffList.length) { el.innerHTML = `<div class="empty"><div class="empty-icon">${ic('user')}</div><h3>${t('no_data')}</h3></div>`; return; }
  const canEdit = can('staff_manage');
  el.innerHTML = staffList.map(s => `<div class="card" style="display:flex;align-items:center;gap:12px;">
<div class="avatar" style="width:40px;height:40px;font-size:14px;flex-shrink:0;">${esc(initialsOf(s.name))}</div>
<div style="flex:1;min-width:0;">
  <div style="font-weight:700;font-size:14px;">${esc(s.name)}</div>
  <div style="font-size:12px;color:var(--text2);">${esc(s.position || '')} ${s.branch_name ? '• ' + esc(s.branch_name) : ''}</div>
  <div style="font-size:11px;color:var(--text3);">Login: ${esc(s.login)}${s.user_id ? '' : ' • <span style="color:var(--red);">Auth\'ga ko\'chirilmagan</span>'}</div>
  ${s.penalty_enabled ? `<span class="tag tag-red" style="display:inline-block;margin-top:4px;">${ic('banknote')} Jarima tizimida</span>` : ''}
  ${s.frozen ? `<span class="tag tag-blue" style="display:inline-block;margin-top:4px;">${ic('snowflake')} Muzlatilgan</span>` : ''}
  ${!s.frozen && penaltySettings ? `<div style="font-size:11px;color:var(--text3);margin-top:2px;">${ic('timer')} Kechikish: ${fmtLate(staffLateTotals[s.id] || 0)} / ${fmtLate((penaltySettings.freeze_limit_minutes || 0) * 60)}</div>` : ''}
</div>
<div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;">
  ${s.frozen && can('staff_freeze') ? `<button class="btn btn-sm btn-primary" onclick="unfreezeStaff('${esc(s.id)}')" title="Muzlatishdan chiqarish">${ic('lock-open')}</button>` : ''}
  ${isSuper() ? `<button class="btn btn-sm ${s.penalty_enabled ? 'btn-primary' : 'btn-secondary'}" onclick="toggleStaffPenalty('${esc(s.id)}', ${!s.penalty_enabled})" title="${s.penalty_enabled ? 'Jarima tizimidan chiqarish' : 'Jarima tizimiga kiritish'}">${ic('banknote')}</button>` : ''}
  ${canEdit ? `<button class="btn btn-sm btn-secondary" onclick="editStaff('${esc(s.id)}')">${ic('pencil')}</button>
  <button class="btn btn-sm btn-danger" onclick="deleteStaff('${esc(s.id)}')">${ic('trash')}</button>` : ''}
</div>
</div>`).join('');
}

// ============================================================
// MUZLATISH ("staff_freeze" ruxsati)
// ============================================================
function renderFreeze() {
  const limit = (penaltySettings && penaltySettings.freeze_limit_minutes) || 1440;
  document.getElementById('frz-hours').value = Math.floor(limit / 60);
  document.getElementById('frz-minutes').value = limit % 60;
  const frozen = staffList.filter(s => s.frozen);
  document.getElementById('frozen-count').textContent = `Muzlatilgan xodimlar (${frozen.length})`;
  document.getElementById('frozen-list').innerHTML = frozen.length ? frozen.map(s => `<div class="card" style="display:flex;align-items:center;gap:12px;">
<div class="avatar" style="width:40px;height:40px;font-size:14px;flex-shrink:0;">${esc(initialsOf(s.name))}</div>
<div style="flex:1;min-width:0;">
  <div style="font-weight:700;font-size:14px;">${esc(s.name)}</div>
  <div style="font-size:12px;color:var(--text2);">Muzlatilgan: ${s.frozen_at ? fmtUzDateTime(s.frozen_at) : '—'}</div>
  <div style="font-size:11px;color:var(--text3);">Jami kechikish: ${fmtLate(s.frozen_late_seconds || 0)} (chegara ${fmtLate((s.frozen_limit_minutes || 0) * 60)})</div>
</div>
<button class="btn btn-sm btn-primary" onclick="unfreezeStaff('${esc(s.id)}')">${ic('lock-open')} Chiqarish</button>
</div>`).join('') : `<div class="empty"><div class="empty-icon">${ic('check-circle')}</div><h3>Muzlatilgan xodim yo'q</h3></div>`;
}

async function saveFreezeLimit() {
  const h = parseInt(document.getElementById('frz-hours').value || '0', 10);
  const m = parseInt(document.getElementById('frz-minutes').value || '0', 10);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || m < 0 || m > 59) { showToast('Soat va daqiqani to\'g\'ri kiriting'); return; }
  const total = h * 60 + m;
  if (total < 1) { showToast('Chegara kamida 1 daqiqa bo\'lishi kerak'); return; }
  const ok = await run(t('save') + '...', async () => {
    must(await sb.rpc('set_freeze_limit', { p_minutes: total }));
    await loadPenaltySettings();
  });
  if (!ok) return;
  renderFreeze();
  showToast(`${t('saved')}: ${fmtLate(total * 60)}`, 2000, 'ok');
}

async function unfreezeStaff(id) {
  const s = staffList.find(x => x.id === id);
  if (!await confirmDialog('Muzlatishdan chiqarilsinmi?', `${s ? s.name : 'Xodim'} yana ilovadan foydalana oladi. Kechikish hisoblagichi noldan boshlanadi.`)) return;
  const ok = await run(t('save') + '...', async () => {
    must(await sb.rpc('unfreeze_staff', { p_staff: id }));
    await loadStaff();
  });
  if (!ok) return;
  showToast('Muzlatishdan chiqarildi', 1800, 'ok');
  renderFreeze();
  renderStaff();
}

// Super Admin: xodimni kechikish jarimasi tizimiga kiritish / chiqarish
async function toggleStaffPenalty(id, enabled) {
  const s = staffList.find(x => x.id === id);
  const ok = await confirmDialog(
    enabled ? 'Jarima tizimiga kiritilsinmi?' : 'Jarima tizimidan chiqarilsinmi?',
    enabled ? `${s ? s.name : ''} kechiksa, endi pul jarimasi hisoblanadi.` : `${s ? s.name : ''} kechiksa, pul jarimasi o'rniga intizomiy chora qo'llanadi.`);
  if (!ok) return;
  const done = await run(t('save') + '...', async () => {
    must(await sb.rpc('set_staff_penalty', { p_staff: id, p_enabled: enabled }));
    await loadStaff();
  });
  if (done) { renderStaff(); showToast(t('saved'), 1500, 'ok'); }
}

function openAddStaff() {
  currentEditStaffId = null;
  document.getElementById('st-name').value = ''; document.getElementById('st-login').value = '';
  document.getElementById('st-password').value = ''; document.getElementById('st-position').value = '';
  document.getElementById('modal-staff-title').textContent = 'Xodim qo\'shish';
  document.getElementById('shifts-container').innerHTML = ''; addShiftRow();
  populateBranchSelect('st-branch');
  openModal('modal-staff');
}

function editStaff(id) {
  const s = staffList.find(x => x.id === id);
  if (!s) return;
  currentEditStaffId = id;
  document.getElementById('st-name').value = s.name;
  document.getElementById('st-login').value = s.login;
  document.getElementById('st-password').value = '';
  document.getElementById('st-position').value = s.position || '';
  document.getElementById('modal-staff-title').textContent = 'Tahrirlash';
  populateBranchSelect('st-branch');
  document.getElementById('st-branch').value = s.branch_id || '';
  document.getElementById('shifts-container').innerHTML = '';
  let shifts = s.shifts || [];
  if (typeof shifts === 'string') { try { shifts = JSON.parse(shifts); } catch (_) { shifts = []; } }
  if (!Array.isArray(shifts)) shifts = [];
  if (shifts.length) shifts.forEach(sh => addShiftRow(sh.start, sh.end, sh.days || []));
  else addShiftRow();
  openModal('modal-staff');
}

function addShiftRow(start = '', end = '', days = []) {
  const c = document.getElementById('shifts-container');
  const div = document.createElement('div');
  div.className = 'shift-card';
  div.style.cssText = 'padding:12px;margin-bottom:10px;';
  const dayDefs = [[1, 'Du'], [2, 'Se'], [3, 'Ch'], [4, 'Pa'], [5, 'Ju'], [6, 'Sha'], [0, 'Ya']];
  const dayBtns = dayDefs.map(([d, lbl]) =>
    `<button type="button" class="day-pill${days.includes(d) ? ' on' : ''}" data-day="${d}" onclick="this.classList.toggle('on')">${lbl}</button>`
  ).join('');
  div.innerHTML = `
<div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;">
  <input type="time" value="${esc(start)}" class="sh-start" style="flex:1;padding:9px;border-radius:10px;border:none;background:var(--inset-bg);color:var(--text);box-shadow:var(--shadow-in);font-family:Manrope,sans-serif;">
  <span style="color:var(--text2);">—</span>
  <input type="time" value="${esc(end)}" class="sh-end" style="flex:1;padding:9px;border-radius:10px;border:none;background:var(--inset-bg);color:var(--text);box-shadow:var(--shadow-in);font-family:Manrope,sans-serif;">
  <button class="btn btn-sm btn-danger btn-icon" onclick="this.closest('.shift-card').remove()">${ic('x')}</button>
</div>
<div style="display:flex;gap:5px;flex-wrap:wrap;" class="sh-days">${dayBtns}</div>`;
  c.appendChild(div);
}

async function saveStaff() {
  const name = document.getElementById('st-name').value.trim();
  const login = document.getElementById('st-login').value.trim();
  const pass = document.getElementById('st-password').value.trim();
  if (!name || !login) { showToast('Ism va login kerak!'); return; }
  const shifts = [];
  document.querySelectorAll('#shifts-container .shift-card').forEach(row => {
    const start = row.querySelector('.sh-start')?.value;
    const end = row.querySelector('.sh-end')?.value;
    if (start && end) {
      const days = [...row.querySelectorAll('.sh-days .day-pill.on')].map(b => Number(b.dataset.day));
      shifts.push({ start, end, days });
    }
  });
  const branchId = document.getElementById('st-branch').value;
  if (!currentEditStaffId && !pass) { showToast('Parol kerak!'); return; }
  if (pass && pass.length < MIN_PASS) { showToast(`Parol kamida ${MIN_PASS} belgidan iborat bo'lsin`); return; }
  // Xodim yaratish/login/parol — faqat serverda (Edge Function, service role)
  const ok = await run(t('save') + '...', async () => {
    await adminUsers({
      action: 'save_staff',
      id: currentEditStaffId,
      name, login,
      password: pass || undefined,
      position: document.getElementById('st-position').value,
      branch_id: branchId || null,
      shifts
    });
    await loadStaff();
  });
  if (!ok) return;
  showToast(t('saved')); closeModal('modal-staff'); renderStaff();
}

async function deleteStaff(id) {
  const s = staffList.find(x => x.id === id);
  if (!await confirmDialog('Xodim o\'chirilsinmi?', `${s ? s.name + ' ' : ''}tizimdan o'chiriladi va ilovaga kira olmaydi. Davomat va jarima tarixi hisobotlarda saqlanib qoladi.`)) return;
  let res = null;
  const ok = await run(t('del') + '...', async () => {
    res = await adminUsers({ action: 'delete_staff', id });
    await loadStaff();
  });
  if (ok) { showToast(res && res.warning ? res.warning : t('deleted'), res && res.warning ? 5000 : 1500); renderStaff(); }
}

// ============================================================
// BRANCHES
// ============================================================
function renderBranches() {
  const el = document.getElementById('branches-list');
  if (!branches.length) { el.innerHTML = `<div class="empty"><div class="empty-icon">${ic('building')}</div><h3>${t('no_data')}</h3></div>`; return; }
  el.innerHTML = branches.map(b => `<div class="card" style="display:flex;align-items:center;gap:12px;">
<div style="width:36px;height:36px;border-radius:10px;background:rgba(124,155,255,0.15);display:flex;align-items:center;justify-content:center;font-size:18px;color:var(--accent);">${ic('building')}</div>
<div style="flex:1;">
  <div style="font-weight:700;font-size:14px;">${esc(b.name)}</div>
  <div style="font-size:12px;color:var(--text2);">${esc(b.address || '')}</div>
  <div style="font-size:11px;margin-top:2px;color:${(b.lat != null && b.lng != null) ? 'var(--accent)' : 'var(--red)'};">${(b.lat != null && b.lng != null) ? `${ic('map-pin')} GPS o'rnatilgan • ${esc(b.radius || 100)}m` : ic('alert-triangle') + ' GPS belgilanmagan'}</div>
</div>
<button class="btn btn-sm btn-danger" onclick="deleteBranch('${esc(b.id)}')">${ic('trash')}</button>
</div>`).join('');
}

function openAddBranch() {
  document.getElementById('br-name').value = '';
  document.getElementById('br-address').value = '';
  document.getElementById('br-lat').value = '';
  document.getElementById('br-lng').value = '';
  document.getElementById('br-radius').value = '100';
  const st = document.getElementById('br-loc-status');
  st.textContent = ''; st.style.color = 'var(--text2)';
  openModal('modal-branch');
}
async function saveBranch() {
  const name = document.getElementById('br-name').value.trim();
  if (!name) return;
  const lat = parseFloat(document.getElementById('br-lat').value);
  const lng = parseFloat(document.getElementById('br-lng').value);
  if (isNaN(lat) || isNaN(lng)) { showToast('Filial joylashuvini (GPS) belgilang!'); return; }
  const radius = parseInt(document.getElementById('br-radius').value) || GEOFENCE_DEFAULT_RADIUS;
  let ok = false;
  await withLoader(t('save') + '...', async () => {
    const { error } = await sb.from('branches').insert([{ name, address: document.getElementById('br-address').value, lat, lng, radius }]);
    if (error) throw error;
    await loadBranches();
    ok = true;
  }).catch(e => {
    const msg = /column .* does not exist|lat|lng|radius/i.test(e.message || '')
      ? 'Bazada GPS ustunlari yo\'q! supabase_setup.sql ni qayta ishga tushiring.'
      : 'Saqlashda xatolik: ' + (e.message || e.code || '');
    showToast(msg, 5000);
  });
  if (ok) { showToast(t('saved'), 1500, 'ok'); closeModal('modal-branch'); renderBranches(); }
}
async function deleteBranch(id) {
  if (!await confirmDialog('Filial o\'chirilsinmi?', 'Bu amalni qaytarib bo\'lmaydi.')) return;
  let ok = false;
  await withLoader(t('del') + '...', async () => {
    const { error } = await sb.from('branches').delete().eq('id', id);
    if (error) throw error;
    await loadBranches();
    ok = true;
  }).catch(e => {
    const msg = (e.code === '23503' || /foreign key/i.test(e.message || ''))
      ? 'Bu filialga bog\'langan xodim yoki davomat bor. Avval ularni o\'chiring yoki boshqa filialga o\'tkazing.'
      : 'O\'chirib bo\'lmadi: ' + (e.message || e.code || 'xatolik');
    showToast(msg, 5000);
  });
  if (ok) { showToast(t('deleted'), 1500); renderBranches(); }
}

// ============================================================
// ADMINS (Super Admin only)
// ============================================================
function renderAdmins() {
  if (!isSuper()) return;
  const el = document.getElementById('admins-list');
  if (!admins.length) { el.innerHTML = `<div class="empty"><div class="empty-icon">${ic('user')}</div><h3>${t('no_data')}</h3></div>`; return; }
  el.innerHTML = admins.map(a => {
    const granted = a.is_super ? PERMISSION_KEYS.length : PERMISSION_KEYS.filter(k => (a.permissions || {})[k] === true).length;
    return `<div class="card" style="display:flex;align-items:center;gap:12px;">
<div class="avatar" style="width:38px;height:38px;font-size:14px;flex-shrink:0;background:linear-gradient(135deg,#e0a23c,#d05568);">${esc(initialsOf(a.name))}</div>
<div style="flex:1;min-width:0;">
  <div style="font-weight:700;font-size:14px;">${esc(a.name)} <span class="role-badge ${a.is_super ? 'role-super' : 'role-admin'}">${a.is_super ? 'Super Admin' : 'Admin'}</span></div>
  <div style="font-size:12px;color:var(--text2);">Login: ${esc(a.login)}</div>
  <div style="font-size:11px;color:var(--text3);">Ruxsatlar: ${a.is_super ? 'barchasi' : `${granted} / ${PERMISSION_KEYS.length}`}</div>
</div>
${a.is_super ? '' : `<div style="display:flex;gap:6px;">
  <button class="btn btn-sm btn-secondary btn-icon" onclick="openEditAdmin('${esc(a.id)}')" title="Ruxsatlarni tahrirlash">${ic('pencil')}</button>
  <button class="btn btn-sm btn-danger btn-icon" onclick="deleteAdmin('${esc(a.id)}')">${ic('trash')}</button>
</div>`}
</div>`;
  }).join('');
}

let editingAdminId = null;

// Ruxsatlar ro'yxati (guruhlar bo'yicha checkbox'lar) — bir nechtasini tanlash mumkin
function buildPermChecks(selected) {
  document.getElementById('perm-checks').innerHTML = PERMISSIONS.map(g => `<div>
  <div style="font-size:12px;font-weight:700;color:var(--text2);margin-bottom:6px;display:flex;align-items:center;gap:6px;">${ic(g.icon)} ${esc(g.group)}</div>
  ${g.items.map(([key, label]) => `<label style="display:flex;align-items:center;gap:8px;font-size:14px;margin-bottom:6px;">
    <input type="checkbox" data-perm="${esc(key)}"${selected[key] === true ? ' checked' : ''}> ${esc(label)}</label>`).join('')}
</div>`).join('');
}
function readPermChecks() {
  const perms = {};
  document.querySelectorAll('#perm-checks input[data-perm]').forEach(cb => { if (cb.checked) perms[cb.dataset.perm] = true; });
  return perms;
}
function toggleAllPerms() {
  const boxes = [...document.querySelectorAll('#perm-checks input[data-perm]')];
  const allOn = boxes.every(cb => cb.checked);
  boxes.forEach(cb => { cb.checked = !allOn; });
}

function openAddAdmin() {
  editingAdminId = null;
  document.getElementById('modal-admin-title').textContent = 'Admin qo\'shish';
  document.getElementById('adm-create-fields').style.display = '';
  document.getElementById('adm-name').value = '';
  document.getElementById('adm-login').value = '';
  document.getElementById('adm-password').value = '';
  buildPermChecks({});
  openModal('modal-admin');
}

function openEditAdmin(id) {
  const a = admins.find(x => x.id === id);
  if (!a) return;
  editingAdminId = id;
  document.getElementById('modal-admin-title').textContent = `Ruxsatlar: ${a.name}`;
  document.getElementById('adm-create-fields').style.display = 'none';
  buildPermChecks(a.permissions || {});
  openModal('modal-admin');
}

async function saveAdmin() {
  const permissions = readPermChecks();
  if (editingAdminId) {
    const ok = await run(t('save') + '...', async () => {
      must(await sb.rpc('set_admin_permissions', { p_admin: editingAdminId, p_perms: permissions }));
      await loadAdmins();
    });
    if (!ok) return;
    showToast(t('saved')); closeModal('modal-admin'); renderAdmins();
    return;
  }
  const name = document.getElementById('adm-name').value.trim();
  const login = document.getElementById('adm-login').value.trim();
  const pass = document.getElementById('adm-password').value.trim();
  if (!name || !login || !pass) { showToast('Barcha maydonlarni to\'ldiring!'); return; }
  if (pass.length < MIN_PASS) { showToast(`Parol kamida ${MIN_PASS} belgidan iborat bo'lsin`); return; }
  if (!Object.keys(permissions).length && !await confirmDialog('Ruxsat tanlanmadi', 'Admin hech qaysi bo\'limni ko\'ra olmaydi. Davom etilsinmi?')) return;
  const ok = await run(t('save') + '...', async () => {
    await adminUsers({ action: 'save_admin', name, login, password: pass, permissions });
    await loadAdmins();
  });
  if (!ok) return;
  showToast(t('saved')); closeModal('modal-admin'); renderAdmins();
}

async function deleteAdmin(id) {
  if (!await confirmDialog('Admin o\'chirilsinmi?', 'Admin tizimga kira olmaydi. Bu amalni qaytarib bo\'lmaydi.')) return;
  const ok = await run(t('del') + '...', async () => {
    await adminUsers({ action: 'delete_admin', id });
    await loadAdmins();
  });
  if (ok) { showToast(t('deleted'), 1500); renderAdmins(); }
}

// ============================================================
// HELPERS
// ============================================================
function populateStaffSelects() {
  ['ci-staff', 't-staff'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const isTask = id === 't-staff';
    el.innerHTML = (isTask ? '<option value="">Barcha xodimlar</option>' : '') + staffList.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
  });
}

function populateBranchSelects() {
  ['ci-branch'].forEach(id => populateBranchSelect(id));
  populateReportBranch();
}

function populateBranchSelect(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = '<option value="">Filial tanlang</option>' + branches.map(b => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('');
}

function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

function cancelBranchPick() {
  const ov = document.getElementById('modal-branch-pick');
  closeModal('modal-branch-pick');
  if (ov._onCancel) { const cb = ov._onCancel; ov._onCancel = null; cb(); }
}

// Close modal on overlay click
document.querySelectorAll('.modal-overlay').forEach(ov => {
  ov.addEventListener('click', e => { if (e.target === ov) ov.classList.remove('open'); });
});

// ============================================================
// INIT
// ============================================================
window.addEventListener('DOMContentLoaded', () => {
  // Temani darhol qo'llash (login ekranida ham to'g'ri ko'rinsin)
  if (localStorage.getItem('theme') === 'dark') document.body.classList.add('dark');
  // Tizim versiyasi
  const vl = document.getElementById('app-version-label');
  if (vl) vl.textContent = APP_VERSION;
  // Eski (xavfsiz bo'lmagan) sessiya formatini tozalash
  localStorage.removeItem('session');
  // Sessiya Supabase Auth'da; rol esa serverdan (whoami) olinadi
  const authScreen = document.getElementById('auth-screen');
  authScreen.style.display = 'none';
  (async () => {
    let ok = false, msg = '';
    try { msg = sessionStorage.getItem('logoutMsg') || ''; sessionStorage.removeItem('logoutMsg'); } catch (e) { }
    try {
      const { data: { session } } = await sb.auth.getSession();
      if (session) {
        ok = await loadMe();
        // Sessiya bor, lekin akkaunt o'chirilgan — chiqarib yuboramiz
        if (!ok) { await sb.auth.signOut(); msg = 'Akkauntingiz tizimdan o\'chirilgan. Administratorga murojaat qiling.'; }
      }
    } catch (e) { console.warn('session:', e); }
    if (ok) { afterLogin(); return; }
    authScreen.style.display = 'flex';
    if (msg) {
      const errEl = document.getElementById('auth-error');
      errEl.textContent = msg;
      errEl.style.display = 'block';
    }
  })();
  sb.auth.onAuthStateChange(event => {
    if (event === 'SIGNED_OUT' && currentUser) { currentUser = null; location.reload(); }
  });
  applyLang();
  // Enter key for login
  document.getElementById('pass-input').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

  // Service worker ro'yxatdan o'tkazish (PWA install + push uchun shart)
  if ('serviceWorker' in navigator) {
    // Birinchi o'rnatishda (oldin controller yo'q edi) reload qilinmaydi — aks holda login jarayoni uziladi
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('./sw.js').then(reg => {
      // Har ochilganda yangi versiyani tekshirish
      reg.update();
      // Yangi versiya topilsa — darhol faollashtirish
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            // Yangi versiya tayyor — eski keshni tashlab, yangilaymiz
            nw.postMessage('skipWaiting');
            showToast('Yangi versiya yuklanmoqda...', 2000, 'ok');
            setTimeout(() => window.location.reload(), 800);
          }
        });
      });
    }).catch(err => console.warn('SW:', err));

    // Controller o'zgarsa (yangi SW faollashsa) — bir marta reload
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing || !hadController) return;
      refreshing = true;
      window.location.reload();
    });
  }
  initInstallPrompt();
});

// ============================================================
// PWA INSTALL (ilovani yuklab olish taklifi)
// ============================================================
let deferredInstall = null;
function initInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
    const btn = document.getElementById('install-banner');
    if (btn) btn.style.display = 'flex';
  });
  window.addEventListener('appinstalled', () => {
    deferredInstall = null;
    const btn = document.getElementById('install-banner');
    if (btn) btn.style.display = 'none';
    showToast('Ilova o\'rnatildi', 2000, 'ok');
  });
  // iOS Safari beforeinstallprompt'ni qo'llab-quvvatlamaydi — qo'lda ko'rsatma
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  if (isIOS && !isStandalone) {
    const btn = document.getElementById('install-banner');
    if (btn) {
      btn.style.display = 'flex';
      btn.querySelector('#install-text').textContent = 'Ilovani o\'rnatish: Ulashish → "Bosh ekranga qo\'shish"';
      btn.querySelector('#install-action').style.display = 'none';
    }
  }
}
async function doInstall() {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  const { outcome } = await deferredInstall.userChoice;
  deferredInstall = null;
  if (outcome === 'accepted') {
    document.getElementById('install-banner').style.display = 'none';
  }
}
// ============================================================
// YANGI VERSIYANI O'RNATISH (Sozlamalar)
// ============================================================
// Serverdagi versiyani tekshiradi; farq qilsa eski service worker va keshni tozalab,
// yangi fayllarni yuklaydi. Sessiya (login) saqlanib qoladi.
async function updateApp(btn) {
  const restore = btnLoading(btn);
  try {
    const res = await fetch('./app.js?check=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error('Server javob bermadi (' + res.status + ')');
    const m = (await res.text()).match(/const APP_VERSION = '([^']+)'/);
    const latest = m ? m[1] : null;
    if (latest && latest === APP_VERSION) {
      showToast(`Siz eng so'nggi versiyadasiz (${APP_VERSION})`, 2500, 'ok');
      restore();
      return;
    }
    showToast(`Yangi versiya o'rnatilmoqda${latest ? ': ' + latest : ''}...`, 3000, 'ok');
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
    // Brauzer HTTP keshini ham chetlab o'tib, fayllarni qayta yuklaymiz
    await Promise.all(['./', './index.html', './app.js', './styles.css', './sw.js', './manifest.json']
      .map(u => fetch(u, { cache: 'reload' }).catch(() => { })));
    setTimeout(() => location.reload(), 600);
  } catch (e) {
    showToast(errMsg(e), 4000);
    restore();
  }
}

function dismissInstall() {
  document.getElementById('install-banner').style.display = 'none';
}
