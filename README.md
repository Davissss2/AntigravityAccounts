# 🌌 Antigravity Hub

<p align="center">
  <img src="resources/icons/logo_with_title_bordered.png" alt="Antigravity Hub Logo" width="200" style="border-radius: 12px;" />
</p>

<p align="center">
  <b>Manage multiple Antigravity accounts seamlessly — switch, monitor credits, and auto-rotate with one click.</b>
</p>

<p align="center">
  <a href="https://github.com/devhakeem5/antigravity-hub-extension"><img src="https://img.shields.io/github/stars/devhakeem5/antigravity-hub?style=for-the-badge&color=7c3aed" alt="GitHub Stars" /></a>
  <a href="https://github.com/devhakeem5/antigravity-hub-extension/issues"><img src="https://img.shields.io/github/issues/devhakeem5/antigravity-hub?style=for-the-badge&color=f14c4c" alt="GitHub Issues" /></a>
  <img src="https://img.shields.io/badge/Security-100%25%20Local-success?style=for-the-badge" alt="Security local badge" />
</p>

---

## 🗺️ Multilingual Navigation / التنقل بين اللغات
- 🇺🇸 [English Version](#-english)
- 🇪🇸 [Versión en Español](#-español)
- 🇸🇾 [النسخة العربية](#-العربية)

---

# 🇺🇸 English

**Antigravity Hub** is the ultimate companion extension for users of the Antigravity desktop application. Designed to supercharge your workflow, this tool provides seamless multi-account management directly within VS Code, eliminating the hassle of manual logins.

<p align="center">
  <img src="resources/accounts-panel.png" alt="Antigravity Hub Accounts Panel" width="80%" style="border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.15);" />
</p>

## ✨ Features

- 👤 **Multi-Account Management:** Securely add and store multiple Google/Antigravity accounts.
- ⚡ **One-Click Seamless Switching:** Switch active Antigravity accounts instantly from the sidebar. Re-authenticating is a thing of the past.
- 📊 **Real-Time Credit Monitoring:** Live track your remaining credits for all models (Claude, Gemini, etc.) directly in the sidebar or status bar.
- 🔄 **Automatic Account Rotation:** Automatically cycles to the next healthy account with credits when your current one becomes depleted.
- 🔐 **Secure Export & Import:** Encrypt backup files with a password to safely move accounts across machines.
- 🌐 **Multilingual Support:** Fully translated UI in English, Spanish (Español), and Arabic (العربية).

## 🚀 Prerequisites

To use this extension, you **must** have the core Antigravity application installed on your machine.
- **Minimum Supported Version:** Antigravity `v1.23.2` or newer.
- Ensure you launch Antigravity and log in at least once before using this extension.

## 💻 Usage

1. Open the **Antigravity Hub** panel from the VS Code Activity Bar (sidebar).
2. Click **Add Account** to authenticate securely via your browser.
3. Once authenticated, monitor your balances and model quotas in real-time.
4. Click **Activate** on any account to inject its session. VS Code will safely reload to apply.

## 🔒 Privacy & Anti-Ban Security

> [!IMPORTANT]
> **100% Local Operations:** Your credentials, access tokens, and account keys never leave your machine. No telemetry or analytics data is collected, stored, or sent to external servers. All requests are made directly and securely from your computer to Google's official developer API endpoints.

- **Session Fingerprint Randomization:** To prevent account cross-correlation, the extension maps a unique, randomized machine ID/device profile fingerprint to each account's session.
- **Anti-Ban Protection:** Built-in randomized request delays (between 3 to 7 seconds) mimic human behavior, protecting you from automatic API rate-limiting or temporary IP blocks.

## 🤝 Support & Feedback

If you encounter any issues, bugs, or have feature requests, please reach out:
- 🐛 **Issue Tracker:** [GitHub Issues](https://github.com/devhakeem5/antigravity-hub-extension/issues)
- 💻 **Repository:** [GitHub](https://github.com/devhakeem5/antigravity-hub-extension)
- 📧 **Email:** [devhakeem5@gmail.com](mailto:devhakeem5@gmail.com)

---

# 🇪🇸 Español

**Antigravity Hub** es la extensión definitiva para los usuarios de la aplicación de escritorio Antigravity. Diseñada para potenciar tu flujo de trabajo, esta herramienta ofrece una gestión fluida de múltiples cuentas directamente dentro de VS Code, eliminando las molestias de los inicios de sesión manuales.

## ✨ Características

- 👤 **Gestión Multicuenta:** Agrega y almacena de forma segura múltiples cuentas de Google/Antigravity.
- ⚡ **Cambio con un Solo Clic:** Cambia la cuenta activa de Antigravity instantáneamente desde la barra lateral. Olvídate de iniciar y cerrar sesión constantemente.
- 📊 **Monitoreo de Créditos en Tiempo Real:** Realiza un seguimiento en vivo de tus créditos restantes para todos los modelos (Claude, Gemini, etc.) directamente en la barra lateral o de estado.
- 🔄 **Rotación Automática de Cuentas:** Cambia automáticamente al siguiente cuenta con saldo cuando la cuenta activa agote sus créditos.
- 🔐 **Importación y Exportación Segura:** Respalda tus cuentas cifrando el archivo con contraseña para moverlas de forma segura entre dispositivos.
- 🌐 **Soporte Multilingüe:** Interfaz de usuario completamente traducida al inglés, español y árabe.

## 🚀 Requisitos Previos

Para utilizar esta extensión, **debes** tener instalada la aplicación principal de Antigravity en tu máquina.
- **Versión Mínima Soportada:** Antigravity `v1.23.2` o posterior.
- Asegúrate de iniciar Antigravity e iniciar sesión al menos una vez antes de usar esta extensión.

## 💻 Modo de Uso

1. Abre el panel de **Antigravity Hub** desde la barra de actividad de VS Code (barra lateral).
2. Haz clic en **Agregar cuenta (Add Account)** para autenticarte de forma segura a través de tu navegador.
3. Una vez autenticado, podrás monitorear tus saldos y cuotas de modelos en tiempo real.
4. Haz clic en **Activar** en cualquier cuenta para inyectar su sesión. VS Code se recargará de forma segura para aplicar los cambios.

## 🔒 Privacidad y Seguridad Anti-Bloqueo

> [!IMPORTANT]
> **Operaciones 100% Locales:** Tus credenciales, tokens de acceso y llaves de cuenta nunca salen de tu máquina. No se recopilan, almacenan ni envían datos de telemetría o análisis a servidores externos. Todas las solicitudes se realizan de manera directa y segura desde tu computadora a los endpoints oficiales de la API de desarrolladores de Google.

- **Aleatorización de Huella de Sesión:** Para evitar la correlación cruzada de cuentas, la extensión asigna un identificador de máquina y una huella de perfil de dispositivo únicos y aleatorios a la sesión de cada cuenta.
- **Protección Anti-Bloqueo:** Retrasos aleatorios integrados (de entre 3 y 7 segundos) entre consultas de saldo para imitar el comportamiento humano natural y protegerte de límites de tasa de API o bloqueos temporales de IP.

## 🤝 Soporte y Comentarios

Si encuentras algún problema, error o deseas solicitar una nueva característica:
- 🐛 **Reportar Errores:** [GitHub Issues](https://github.com/devhakeem5/antigravity-hub-extension/issues)
- 💻 **Repositorio:** [GitHub](https://github.com/devhakeem5/antigravity-hub-extension)
- 📧 **Correo Electrónico:** [devhakeem5@gmail.com](mailto:devhakeem5@gmail.com)

---

# 🇸🇾 العربية

تُعد **أداة مساعد Antigravity** الرفيق المثالي لمستخدمي تطبيق Antigravity المكتبي. صُممت هذه الإضافة خصيصاً لتسريع بيئة عملك من خلال توفير إدارة سلسة لعدة حسابات مباشرة من داخل محرر VS Code، مما يقضي على عناء تسجيل الدخول والخروج اليدوي.

## ✨ الميزات الرئيسية

- 👤 **إدارة حسابات متعددة:** إضافة وتخزين عدة حسابات Google/Antigravity بأمان.
- ⚡ **تبديل سلس بنقرة واحدة:** يمكنك التبديل بين حسابات Antigravity النشطة فوراً من الشريط الجانبي دون الحاجة لإعادة المصادقة.
- 📊 **مراقبة الأرصدة لحظياً:** تتبع الأرصدة المتبقية لجميع النماذج المتاحة (Claude, Gemini، وغيرها) ومعرفة مواعيد تجديدها بسهولة في الشريط الجانبي أو شريط الحالة.
- 🔄 **التبديل التلقائي للحسابات:** الانتقال تلقائياً إلى الحساب النشط التالي الذي يحتوي على رصيد عند نفاد رصيد الحساب الحالي.
- 🔐 **تصدير واستيراد آمن:** إمكانية أخذ نسخة احتياطية مشفرة بكلمة مرور من حساباتك لنقلها بين الأجهزة المختلفة بأمان.
- 🌐 **واجهة متعددة اللغات:** تدعم الإضافة اللغات العربية، الإسبانية، والإنجليزية بشكل كامل.

## 🚀 المتطلبات المسبقة

لاستخدام هذه الإضافة بنجاح، **يجب** أن يكون تطبيق Antigravity الأساسي مثبتاً على جهازك.
- **الحد الأدنى للإصدار المطلوب:** تطبيق Antigravity إصدار `1.23.2` فما أحدث.
- يُرجى تشغيل تطبيق Antigravity وتسجيل الدخول مرة واحدة على الأقل قبل بدء استخدام هذه الإضافة حتى يتم إنشاء قاعدة البيانات الخاصة به.

## 💻 طريقة الاستخدام

1. افتح لوحة **Antigravity Hub** من الشريط الجانبي في VS Code.
2. انقر على **إضافة حساب (Add Account)** للمصادقة بشكل آمن عبر المتصفح.
3. بمجرد إضافته، ستتمكن من رؤية الرصيد المتبقي والنماذج المتاحة للحساب لحظة بلحظة.
4. اضغط على زر **تنشيط (Activate)** بجوار أي حساب ليتم نقل الجلسة فوراً. (سيعيد المحرر تحميل نفسه بأمان لتطبيق الحساب الجديد).

## 🔒 الخصوصية والأمان ضد الحظر

> [!IMPORTANT]
> **عمليات محلية 100%:** لا تغادر بيانات اعتمادك أو رموز الوصول أو مفاتيح حسابك جهازك مطلقاً. لا يتم جمع أو تخزين أو إرسال أي بيانات تتبع أو تحليلات إلى خوادم خارجية. يتم إجراء جميع الطلبات بشكل مباشر وآمن من جهاز الكمبيوتر الخاص بك إلى خوادم واجهة برمجة التطبيقات (API) الرسمية من Google.

- **عشوائية بصمة الجهاز:** لمنع الربط والارتباط بين حساباتك المختلفة لدى Google، تقوم الإضافة بربط معرّف جهاز فريد وبصمة عشوائية لكل ملف تعريف حساب وجلسة.
- **الحماية ضد الحظر:** تأتي الإضافة بتأخيرات زمنية عشوائية مدمجة (بين 3 إلى 7 ثوانٍ) بين عمليات فحص الأرصدة لمحاكاة السلوك البشري الطبيعي وحمايتك من حظر عنوان IP مؤقتاً أو تقييد الطلبات.

## 🤝 الدعم الفني

إذا واجهت أي مشاكل فنية، أو كان لديك استفسارات أو مقترحات للتطوير:
- 🐛 **التبليغ عن مشكلة:** [GitHub Issues](https://github.com/devhakeem5/antigravity-hub-extension/issues)
- 💻 **رابط المستودع:** [GitHub](https://github.com/devhakeem5/antigravity-hub-extension)
- 📧 **البريد الإلكتروني:** [devhakeem5@gmail.com](mailto:devhakeem5@gmail.com)
