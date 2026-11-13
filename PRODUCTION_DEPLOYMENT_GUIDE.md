# الدليل الشامل لتطبيق نظام RadiusPro على الشبكة الحقيقية
## (Ubuntu 24.04 LTS + MariaDB + FreeRADIUS 3.x + MikroTik RouterOS)

---

### جدول محتويات الدليل:
1. [المتطلبات الأساسية ومخطط الشبكة](#1-المتطلبات-الأساسية-ومخطط-الشبكة)
2. [تجهيز سيرفر Ubuntu 24.04 وتثبيت MariaDB و FreeRADIUS 3.x](#2-تجهيز-سيرفر-ubuntu-2404-وتثبيت-mariadb-و-freeradius-3x)
3. [تفعيل وضبط موديول SQL في FreeRADIUS](#3-تفعيل-وضبط-موديول-sql-في-freeradius)
4. [إضافة راوتر الميكروتك في جدول `nas` ومطابقة القواميس](#4-إضافة-راوتر-الميكروتك-في-جدول-nas-ومطابقة-القواميس)
5. [برمجة راوتر MikroTik RouterOS بالكامل (Hotspot + RADIUS + CoA)](#5-برمجة-راوتر-mikrotik-routeros-بالكامل-hotspot--radius--coa)
6. [إعداد صفحة الهوت سبوت والدخول التلقائي عبر QR كود و Walled Garden](#6-إعداد-صفحة-الهوت-سبوت-والدخول-التلقائي-عبر-qr-كود-و-walled-garden)
7. [تشغيل لوحة التحكم عبر PM2 وإعداد Nginx كخادم وسيط](#7-تشغيل-لوحة-التحكم-عبر-pm2-وإعداد-nginx-كخادم-وسيط)
8. [أتمتة إنهاء الجلسات المنتهية والصلاحية (Cron Job)](#8-أتمتة-إنهاء-الجلسات-المنتهية-والصلاحية-cron-job)
9. [قائمة الفحص والاختبار الشامل للتشغيل الحي](#9-قائمة-الفحص-والاختبار-الشامل-للتشغيل-الحي)

---

## 1. المتطلبات الأساسية ومخطط الشبكة

في هذا التطبيق العملي، سنفترض البنية النموذجية التالية (استبدل الـ IPs بما يتوافق مع شبكتك):
- **سيرفر Ubuntu 24.04 (FreeRADIUS + MariaDB + لوحة التحكم):** `10.10.0.100`
- **راوتر الميكروتك الرئيسي (MikroTik RouterOS Gateway):** `10.10.0.1`
- **نطاق شبكة المشتركين (Hotspot Subnet):** `10.1.234.0/24`
- **كلمة السر المشتركة (RADIUS Secret):** `RadSecret2026!`
- **منفذ المصادقة (Auth Port):** `1812/UDP`
- **منفذ المحاسبة (Acct Port):** `1813/UDP`
- **منفذ الفصل الفوري (CoA / PoD Port):** `3799/UDP`

```
  [ هواتف / أجهزة المشتركين ]
             │ (Wi-Fi)
  [ مودمات وأكسس بوينت Access Points ]
             │ (VLANs / LAN)
  [ راوتر MikroTik RouterOS v7/v6 ] (10.10.0.1)
             │ (UDP 1812 / 1813 / 3799)
  [ سيرفر Ubuntu 24.04 - RadiusPro ] (10.10.0.100)
     ├── MariaDB (`radius` database)
     ├── FreeRADIUS 3.x
     └── Node.js Dashboard (Port 4000 / Nginx Port 80)
```

---

## 2. تجهيز سيرفر Ubuntu 24.04 وتثبيت MariaDB و FreeRADIUS 3.x

افتح الـ Terminal على سيرفر Ubuntu ونفّذ الأوامر التالية:

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y mariadb-server freeradius freeradius-mysql freeradius-utils curl git nginx
```

### إعداد وتأمين قاعدة بيانات `radius` في MariaDB:
```bash
sudo mysql -u root
```
داخل موجه أوامر MySQL، نفّذ التالي:
```sql
CREATE DATABASE radius CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'radius'@'localhost' IDENTIFIED BY 'RadPass2026!';
GRANT ALL PRIVILEGES ON radius.* TO 'radius'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

### استيراد ملفات الجداول الرسمية وجداول النظام:
```bash
# 1. استيراد مخطط FreeRADIUS 3.x القياسي
sudo mysql -u radius -p'RadPass2026!' radius < /etc/freeradius/3.0/mods-config/sql/main/mysql/schema.sql

# 2. استيراد جداول النظام والإضافات (الموجودة في مجلد المشروع)
sudo mysql -u radius -p'RadPass2026!' radius < /var/www/NewUserManager/database/migrations/001_hotspot_manager_schema.sql
sudo mysql -u radius -p'RadPass2026!' radius < /var/www/NewUserManager/database/migrations/002_production_additions.sql
```

---

## 3. تفعيل وضبط موديول SQL في FreeRADIUS

1. تفعيل موديول SQL بإنشاء الرابط الرمزي:
```bash
sudo ln -sf /etc/freeradius/3.0/mods-available/sql /etc/freeradius/3.0/mods-enabled/sql
sudo chgrp -h freerad /etc/freeradius/3.0/mods-enabled/sql
```

2. تعديل ملف الاتصال بقاعدة البيانات `/etc/freeradius/3.0/mods-available/sql`:
```bash
sudo nano /etc/freeradius/3.0/mods-available/sql
```
اضبط إعدادات الاتصال كالتالي:
```text
sql {
    driver = "rlm_sql_mysql"
    dialect = "mysql"

    server = "localhost"
    port = 3306
    login = "radius"
    password = "RadPass2026!"
    radius_db = "radius"

    # تفعيل قراءة أجهزة الراوتر مباشرة من جدول nas في قاعدة البيانات
    read_clients = yes
    client_table = "nas"
}
```

3. تفعيل الـ SQL في موقع FreeRADIUS الافتراضي `/etc/freeradius/3.0/sites-enabled/default`:
افتح الملف:
```bash
sudo nano /etc/freeradius/3.0/sites-enabled/default
```
تأكد من إزالة علامة `#` من كلمة `sql` في الأقسام التالية:
- داخل قسم `authorize { ... }` ⬅ أضف أو أزل `#` من `sql`
- داخل قسم `accounting { ... }` ⬅ أضف أو أزل `#` من `sql`
- داخل قسم `session { ... }` ⬅ فعّل `sql` (لتشغيل `Simultaneous-Use = 1` ومنع تشغيل الكرت على جهازين)
- داخل قسم `post-auth { ... }` ⬅ فعّل `sql`

4. التأكد من تضمين قاموس ميكروتك في `/etc/freeradius/3.0/dictionary`:
```bash
sudo grep -q "dictionary.mikrotik" /etc/freeradius/3.0/dictionary || echo '$INCLUDE /usr/share/freeradius/dictionary.mikrotik' | sudo tee -a /etc/freeradius/3.0/dictionary
```

5. اختبار الإعدادات وتشغيل الخدمة:
```bash
sudo freeradius -Cx
sudo systemctl restart freeradius
sudo systemctl enable freeradius
```

---

## 4. إضافة راوتر الميكروتك في جدول `nas` ومطابقة القواميس

أضف راوتر الميكروتك إلى قاعدة البيانات:
```sql
USE radius;
INSERT INTO nas (nasname, shortname, type, secret, description)
VALUES ('10.10.0.1', 'MikroTik-Main', 'other', 'RadSecret2026!', 'Main Hotspot Gateway')
ON DUPLICATE KEY UPDATE secret = 'RadSecret2026!';
```
ثم أعد تحميل خدمة FreeRADIUS:
```bash
sudo systemctl restart freeradius
```

---

## 5. برمجة راوتر MikroTik RouterOS بالكامل (Hotspot + RADIUS + CoA)

افتح برنامج **WinBox** واتصل براوتر الميكروتك، ثم افتح نافذة **Terminal** وانسخ الأوامر التالية دفعة واحدة:

```routeros
# ========================================================
# 1. إعداد خادم RADIUS للمصادقة والمحاسبة
# ========================================================
/radius add service=hotspot address=10.10.0.100 secret="RadSecret2026!" \
    authentication-port=1812 accounting-port=1813 timeout=3s comment="RadiusPro-Server"

# ========================================================
# 2. تفعيل استقبال حزم الفصل الفوري (CoA / Disconnect Requests)
# ========================================================
/radius incoming set accept=yes port=3799

# ========================================================
# 3. إعداد Hotspot Server Profile لاستخدام RADIUS مع إرسال تحديثات لحظية كل دقيقة
# ========================================================
/ip hotspot profile
set [find default=yes] use-radius=yes radius-accounting=yes radius-interim-update=1m \
    login-by=http-pap,http-chap,cookie split-user-domain=no

# ========================================================
# 4. فتح جدار الحماية (Firewall Filter) للسماح بحزم RADIUS و CoA
# ========================================================
/ip firewall filter
add chain=input action=accept protocol=udp src-address=10.10.0.100 dst-port=3799 \
    comment="Accept CoA / PoD from RadiusPro Server" place-before=0
```

---

## 6. إعداد صفحة الهوت سبوت والدخول التلقائي عبر QR كود و Walled Garden

### أ) تفعيل ميزة الدخول التلقائي بالـ QR كود في MikroTik:
الكروت المطبوعة من لوحة التحكم تحتوي على QR كود بالصيغة:
`http://wifi.lan/login?username=XXXXX&password=XXXXX`

لكي يتعرف الميكروتك على رابط تسجيل الدخول المباشر:
1. افتح صفحة الهوت سبوت في الميكروتك (ملف `login.html`).
2. تأكد من تفعيل `HTTP PAP` في بروفايل الهوت سبوت (تم تفعيله بالأمر السابق `login-by=http-pap,http-chap`).
3. أضف الكود البرمجي البسيط التالي داخل وسم `<script>` في صفحة `login.html` لتسجيل الدخول تلقائياً بمجرد مسح الكود:
```javascript
window.addEventListener('load', function() {
    const params = new URLSearchParams(window.location.search);
    const u = params.get('username');
    const p = params.get('password');
    if (u && p) {
        document.getElementById('username').value = u;
        document.getElementById('password').value = p;
        document.forms['login'].submit();
    }
});
```

### ب) السماح للزبائن بمسح الكود وتصفح لوحة التحكم (Walled Garden):
إذا أردت السماح للزبائن بالوصول لسيرفر الكروت أو أي صفحات خاصة قبل تسجيل الدخول:
```routeros
/ip hotspot walled-garden ip
add dst-host=10.10.0.100 action=accept comment="Allow Access to Local Server"
```

---

## 7. تشغيل لوحة التحكم عبر PM2 وإعداد Nginx كخادم وسيط

1. تثبيت Node.js 20 LTS وأداة PM2 على سيرفر أوبونتو:
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

2. وضع المشروع في مجلد التشغيل `/var/www/NewUserManager`:
```bash
sudo mkdir -p /var/www/NewUserManager
sudo cp -r /path/to/your/files/* /var/www/NewUserManager/
cd /var/www/NewUserManager
npm install mysql2 dotenv
```

3. إنشاء ملف متغيرات البيئة `/var/www/NewUserManager/.env`:
```env
PORT=4000
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=radius
DB_PASSWORD=RadPass2026!
DB_NAME=radius
DEFAULT_NAS_SECRET=RadSecret2026!
MikroTik_COA_PORT=3799
```

4. تشغيل اللوحة عبر PM2 كخدمة خلفية دائمة تعمل تلقائياً مع إقلاع السيرفر:
```bash
pm2 start start-server.mjs --name "radiuspro-app"
pm2 save
pm2 startup
```

5. ضبط Nginx لتوجيه المنفذ 80 مباشرة للوحة التحكم:
أنشئ ملف الإعدادات:
```bash
sudo nano /etc/nginx/sites-available/radiuspro
```
أضف بداخله:
```nginx
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;
    }
}
```
فعّل الموقع وأعد تشغيل Nginx:
```bash
sudo ln -sf /etc/nginx/sites-available/radiuspro /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl restart nginx
```

الآن يمكنك فتح لوحة التحكم بمجرد كتابة الـ IP المباشر في المتصفح:
👉 `http://10.10.0.100`

---

## 8. أتمتة إنهاء الجلسات المنتهية والصلاحية (Cron Job)

في كروت الهوت سبوت، يقوم ميكروتك تلقائياً بفصل المستخدم عند استهلاك الكوتا (`Mikrotik-Total-Limit`) أو انتهاء مدة الجلسة (`Session-Timeout`).

لضمان تحديث حالة الكروت في قاعدة البيانات إلى `EXPIRED` فور انتهاء صلاحيتها بالأيام (مثلاً بعد مرور 3 أيام من أول استخدام):
أنشئ ملف صيانة دوري `/var/www/NewUserManager/cleanup-expired.sql`:
```sql
USE radius;

-- تحديث حالة الكروت المنتهية حسب تاريخ الصلاحية
UPDATE voucher_cards vc
JOIN profiles_meta pm ON pm.id = vc.profile_id
SET vc.status = 'EXPIRED'
WHERE vc.status = 'ACTIVE'
  AND vc.first_used_at IS NOT NULL
  AND pm.validity_days IS NOT NULL
  AND NOW() > DATE_ADD(vc.first_used_at, INTERVAL pm.validity_days DAY);
```

أضف مهمة مجدولة في الـ Cron تعمل كل 5 دقائق:
```bash
(crontab -l 2>/dev/null; echo "*/5 * * * * mysql -u radius -p'RadPass2026!' < /var/www/NewUserManager/cleanup-expired.sql > /dev/null 2>&1") | crontab -
```

---

## 9. قائمة الفحص والاختبار الشامل للتشغيل الحي

قبل بدء بيع الكروت للمشتركين، قم بتنفيذ هذه الاختبارات الأربعة:

1. **اختبار قراءة FreeRADIUS من قاعدة البيانات (radtest):**
   من شاشة التيرمينال على سيرفر Ubuntu:
   ```bash
   radtest 77018417 77018417 127.0.0.1 0 testing123
   ```
   *النتيجة المتوقعة:* ظهور رسالة `Received Access-Accept` مع ظهور خصائص السرعة مثل `Mikrotik-Rate-Limit = 2M/2M`.

2. **اختبار الاتصال بين راوتر الميكروتك وسيرفر الـ RADIUS:**
   في تيرمينال الميكروتك:
   ```routeros
   /radius monitor [find]
   ```
   *النتيجة المتوقعة:* ظهور عداد `requests` و `accepts` يزداد مع كل محاولة دخول، وحالة الـ Server هي `reachable`.

3. **اختبار تسجيل الدخول الحقيقي من هاتف محمول:**
   - اتصل بشبكة الواي فاي للهوت سبوت.
   - امسح رمز الـ QR أو اكتب الكود.
   - افتح لوحة التحكم في المتصفح ⬅ قسم **🟢 المتصلون الآن (Live CoA)**.
   - ستظهر جلسة هاتفك مباشرة مع الـ IP، والماك أدريس، وعنوان المودم/الأكسس بوينت، ومعدل التحميل والرفع لحظياً.

4. **اختبار الطرد الفوري (Kick CoA):**
   - اضغط على زر **⛔ فصل** أمام جلسة هاتفك في لوحة التحكم.
   - *النتيجة المتوقعة:* يتم قطع الإنترنت عن هاتفك في نفس اللحظة عبر حزمة `CoA` المرسلة إلى منفذ `UDP 3799`.
