# JONY KIDS — xavfsiz versiyaga o'tish

Yangi versiyada kirish Supabase Auth orqali ishlaydi, parollar serverda xeshlangan holda saqlanadi, ruxsatlar esa rolga qarab RLS bilan cheklanadi.
**Pastdagi qadamlar ketma-ket bajariladi.** 1-qadamdan keyin eski sayt ishlamay qoladi, shuning uchun 1–5 qadamlarni bir vaqtda (kam foydalaniladigan paytda) bajaring.

## 0. Tayyorgarlik
- Supabase Dashboard → **Project Settings → API** bo'limidan `service_role` (yoki `sb_secret_...`) kalitini oling. **Bu kalitni hech qachon klient kodiga yoki git'ga qo'ymang.**
- Supabase Dashboard → **Authentication → Sign In / Providers**:
  - **Email** provider yoqilgan bo'lsin, **Confirm email** — o'chiq.
  - **Allow new users to sign up** — o'chiq (foydalanuvchilarni faqat admin yaratadi).
- Bazaning zaxira nusxasini oling (Database → Backups).

## 1. Baza
SQL Editor'da `supabase_setup.sql` ni to'liq ishga tushiring. Qayta ishga tushirish xavfsiz.

> ⚠️ **"Talabalar" bo'limi olib tashlangan.** Bu fayl `students`, `teachers`, `groups` jadvallarini **butunlay o'chiradi**. Kerak bo'lsa, ishga tushirishdan oldin ularni eksport qilib oling (Table Editor → Export to CSV).

Fayl bundan tashqari:
- mavjud adminlarning eski ruxsatlarini yangi multi-permission ro'yxatiga bir marta ko'chiradi (avval ko'rgan bo'limlari saqlanadi);
- jarima va intizom jadvallarini yaratadi. Standart sozlamalar: 1 daqiqa uchun 0 UZS, Ogohlantirish 6 daqiqadan, Tanbeh 16 daqiqadan, Qattiq tanbeh 31 daqiqadan.

## 2. Edge Function
```bash
supabase login
supabase link --project-ref ovqzfqklulgfwmpxmjaa
supabase functions deploy admin-users
```
(`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` Supabase tomonidan avtomatik beriladi.)

## 3. Foydalanuvchilarni ko'chirish (bir marta)
```bash
SUPABASE_URL=https://ovqzfqklulgfwmpxmjaa.supabase.co \
SUPABASE_SERVICE_ROLE_KEY='...' \
SUPERADMIN_PASSWORD='kamida-8-belgili-kuchli-parol' \
node scripts/migrate-users.mjs
```
- Avval `DRY_RUN=1` bilan sinab ko'ring — hech narsa yozilmaydi.
- Xodimlar **eski login va paroli** bilan kiraveradi.
- Paroli 6 belgidan qisqa bo'lganlarga **vaqtinchalik parol** beriladi (jadvalda chiqadi). Ularni egalariga yetkazing.
- Superadmin login: `superadmin` (yoki `SUPERADMIN_LOGIN`), parol: siz bergan `SUPERADMIN_PASSWORD`. Eski `super123` endi ishlamaydi.

## 4. Ochiq parollarni o'chirish
SQL Editor'da `supabase_finalize.sql` ni ishga tushiring. Agar Auth'ga bog'lanmagan foydalanuvchi qolgan bo'lsa, skript xato beradi va hech narsani o'chirmaydi.

## 5. Saytni yangilash
Quyidagi fayllarni hostingga joylang: `index.html`, `app.js`, `styles.css`, `sw.js`, `manifest.json`, ikonkalar.
Service worker keshi (`jony-kids-v9`) yangilangani uchun telefonlar yangi versiyani o'zi yuklab oladi. Hamma bir marta qayta login qiladi.

## 6. Jarima tizimini sozlash (Super Admin)
1. **Boshqaruv → Jarima:** hisoblash birligini (soniya / daqiqa / soat), summani, valyutani va intizom chegaralarini kiriting.
2. **Boshqaruv → Xodimlar:** pul jarimasi qo'llanadigan xodimlar uchun 💰 tugmasini yoqing. Qolgan xodimlarga kechikish davomiyligiga qarab intizomiy chora qo'llanadi.
3. **Boshqaruv → Adminlar → ✏️:** har bir adminga kerakli ruxsatlarni belgilang.
4. **Boshqaruv → Muzlatish** ("staff_freeze" ruxsati kerak): jami kechikish chegarasini belgilang (standart: 24 soat). Xodimning kechikishlari shu chegaraga yetsa, profili avtomatik muzlatiladi. Muzlatishdan faqat shu ruxsatga ega admin chiqara oladi (🔓).
5. **Jarimani bekor qilish** ("penalty_cancel" ruxsati): Dashboard → "Barcha yozuvlar" ro'yxatida yoki Vazifalar panelidagi jarima bildirishnomasida "Bekor qilish" tugmasi. Sabab yozish majburiy, xodimga xabar boradi, yozuv tarixda saqlanadi.

## Tekshirish ro'yxati
- [ ] Xodim kira oladi va faqat "Davomat" bilan "Vazifalar"ni ko'radi
- [ ] Filial hududidan tashqarida "Keldim" bosilsa, server rad etadi
- [ ] Admin xodim qo'sha oladi, uning paroli 6+ belgi bo'ladi
- [ ] Superadmin admin qo'sha oladi va uning ruxsatlarini o'zgartira oladi
- [ ] Ruxsati cheklangan admin faqat ruxsat berilgan bo'lim va tugmalarni ko'radi
- [ ] Jarima tizimidagi xodim kechiksa, unga jarima bildirishnomasi keladi (Vazifalar panelida ham ko'rinadi)
- [ ] Jarima tizimida bo'lmagan xodim kechiksa, unga intizomiy bildirishnoma keladi
- [ ] Kechikishlari chegaraga yetgan xodimning profili muzlatiladi va unga ogohlantirish ekrani ko'rinadi
- [ ] O'chirilgan xodim eski login bilan kira olmaydi, tizimda ochiq qolgan ilovasi 1 daqiqa ichida yopiladi
- [ ] Brauzer konsolida `sb.from('staff').select('*')` → ruxsat xatosi (parol ustuni yopiq)

## Eslatmalar
- Login → Auth email: `ali` → `ali@jonykids.local`. Bo'sh joy yoki kirill harfli loginlar hex ko'rinishga o'tkaziladi. Bu qoida `app.js`, Edge Function va migratsiya skriptida bir xil bo'lishi shart.
- Xodim o'chirilsa, uning davomat va jarima tarixi hisobotlarda saqlanib qoladi. Unga berilgan vazifalar o'chadi.
- Muzlatish uchun kechikishlar shu versiya o'rnatilgan paytdan (yoki oxirgi marta muzlatishdan chiqarilgan paytdan) boshlab yig'iladi. Eski kechikishlar hisobga olinmaydi.
- Jarima kechikish aniqlangan paytdagi sozlamalar bilan hisoblanadi. Sozlamalar keyin o'zgartirilsa, eski jarimalar qayta hisoblanmaydi.
- GPS soxtalashtiruvchi ilovalardan veb ilova to'liq himoyalana olmaydi. Server faqat yuborilgan koordinatani tekshiradi.
