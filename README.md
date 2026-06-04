# 🌌 Antigravity Account

<p align="center">
  <img src="resources/icons/logo_with_title_bordered.png" alt="Antigravity Account Logo" width="200" style="border-radius: 12px;" />
</p>

<p align="center">
  <b>Manage multiple Antigravity accounts seamlessly — switch, monitor credits, and auto-rotate with one click.</b>
</p>

<p align="center">
  <a href="https://github.com/Davissss2/AntigravityAccounts"><img src="https://img.shields.io/github/stars/Davissss2/AntigravityAccounts?style=for-the-badge&color=7c3aed" alt="GitHub Stars" /></a>
  <a href="https://github.com/Davissss2/AntigravityAccounts/issues"><img src="https://img.shields.io/github/issues/Davissss2/AntigravityAccounts?style=for-the-badge&color=f14c4c" alt="GitHub Issues" /></a>
  <img src="https://img.shields.io/badge/Security-100%25%20Local-success?style=for-the-badge" alt="Security local badge" />
</p>

---

**Antigravity Account** is the ultimate companion extension for users of the Antigravity desktop application. Designed to supercharge your workflow, this tool provides seamless multi-account management directly within VS Code, eliminating the hassle of manual logins.

<p align="center">
  <img src="resources/accounts-panel.png" alt="Antigravity Account Panel" width="80%" style="border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.15);" />
</p>

## ✨ Features

- 👤 **Multi-Account Management:** Securely add and store multiple Google/Antigravity accounts.
- ⚡ **One-Click Seamless Switching:** Switch active Antigravity accounts instantly from the sidebar. Re-authenticating is a thing of the past.
- 📊 **Real-Time Credit Monitoring:** Live track your remaining credits for all models (Claude, Gemini, etc.) directly in the sidebar or status bar.
- 🔄 **Automatic Account Rotation:** Automatically cycles to the next healthy account with credits when your current one becomes depleted.
- 🔐 **Secure Export & Import:** Encrypt backup files with a password to safely move accounts across machines.

## 🚀 Prerequisites

To use this extension, you **must** have the core Antigravity application installed on your machine.
- **Minimum Supported Version:** Antigravity `v1.23.2` or newer.
- Ensure you launch Antigravity and log in at least once before using this extension.

## 💻 Usage

1. Open the **Antigravity Account** panel from the VS Code Activity Bar (sidebar).
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
- 🐛 **Issue Tracker:** [GitHub Issues](https://github.com/Davissss2/AntigravityAccounts/issues)
- 💻 **Repository:** [GitHub](https://github.com/Davissss2/AntigravityAccounts)
