# SnapCht - Platform Video Pendek

Platform video pendek ala TikTok yang dibina dengan HTML, CSS, JavaScript dan Supabase.

## ✨ Ciri-ciri

- 📱 Feed video menegak (scroll snap)
- ❤️ Like & Unlike video
- 📌 Simpan video kegemaran
- 👥 Sistem ikut-mengikut (follow)
- 💬 Sistem komen
- 💬 Chat real-time antara pengguna
- 🔍 Carian video & hashtag
- 🔥 Trending videos (mengikut tontonan)
- 👁️ Kaunter tontonan video
- 🌙 Dark/Light mode
- 🔄 Pull to refresh
- 🚩 Lapor video tidak sesuai
- 🔗 Kongsi pautan video

## 🚀 Deployment ke Netlify

1. Push kod ke GitHub repository
2. Log masuk ke [Netlify](https://app.netlify.com)
3. Klik "Add new site" → "Import an existing project"
4. Pilih GitHub dan repo SnapCht
5. Build settings: 
   - Base directory: (biarkan kosong)
   - Build command: (biarkan kosong)
   - Publish directory: `.`
6. Klik "Deploy site"

## 🗄️ Persediaan Supabase

1. Buka [Supabase Dashboard](https://app.supabase.com)
2. Buat project baru
3. Jalankan SQL di bawah dalam SQL Editor:

\`\`\`sql
-- Salin semua SQL dari fail database.sql
\`\`\`

4. Dapatkan URL Project dan Anon Key
5. Gantikan di `index.html`:

```javascript
const SB_URL = 'https://your-project.supabase.co';
const SB_ANON_KEY = 'your-anon-key';
