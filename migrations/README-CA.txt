sha256 Fingerprint=80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA
subject=C=US, ST=Delware, L=New Castle, O=Supabase Inc, CN=Supabase Root 2021 CA

Supabase Root 2021 CA — الشهادة الجذرية لـ *.pooler.supabase.com
═════════════════════════════════════════════════════════════════

⚠️ تحقق المستقل إجباري قبل الاعتماد:
   هذه الشهادة استُخرجت من الاتصال الحي بالـ pooler يوم 2026-11-18.
   قبل تفعيل الوضع الصارم، تحقق من البصمة أعلاه مقابل ما يعرضه
   Supabase Dashboard (Settings → Database → SSL) أو supabase.com/certificates.

التفعيل (Render → Environment):
   1) افتح migrations/supabase-root-ca.pem وانسخ محتواه كاملاً (BEGIN..END)
   2) زيد متغير PGSSL_ROOT_CA بالقيمة (raw PEM)
   3) Manual Deploy
   → عند الإقلاع: 🔐 [DBFIX] PGSSL_ROOT_CA مضبوط — تحقق صارم مفعّل

من دون التفعيل: الاتصال مشفر لكن بلا تحقق (تحذير ⚠️ كل إقلاع).
