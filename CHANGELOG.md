# Changelog

All notable changes to the "Antigravity Hub" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.3] - 2026-09-30

### 📁 Workflows & Account Categorization System
- **Custom Workflows / Categorization**: Users can now organize and categorize their Google Antigravity accounts into custom Workflows (e.g., *"Casa"*, *"Trabajo"*, *"Clientes"*, *"Testing"*).
- **Interactive Workflow Navigation Bar**:
  - Horizontal chip/pill bar displayed above account cards: `[Todos (N)] [📁 Casa (X)] [📁 Trabajo (Y)] [Sin categoría (Z)] [+ Nuevo]`.
  - Instant client-side filtering by workflow with smooth animations.
  - Active workflow state is persistently saved across sessions and IDE reloads.
  - Context menu on workflow chips to easily rename or delete workflows (deleting a workflow unlinks accounts safely without deleting the accounts themselves).
- **Account Card Workflow Badges & Assignment**:
  - Each account card now displays an interactive workflow badge (`📁 Casa` or `+ Sin categoría`).
  - Clicking the badge opens a quick picker to reassign the account, unlink it, or create a brand new workflow on the fly.
  - Automatically associates newly logged-in OAuth accounts with the currently active workflow.

### 🛡️ Targeted Workflow-Only Quota Refresh & Safe Scans
- **Workflow-Scoped Refresh**: When a specific workflow is selected, clicking the global Refresh button (`⚡`) only refreshes and scans accounts belonging to that workflow, dramatically reducing API requests and further minimizing any risk of hitting Google rate limits or heuristic triggers.
- **Segment Scans Respect Workflows**: Toolbar segment scans (*"Escanear con cuota"*, *"Escanear sin cuota"*) now exclusively target accounts within the active workflow.

### 📦 Workflow-Aware Encrypted Backup & Import
- **Selective Encrypted Export**: When exporting accounts, users can choose between exporting **all accounts**, exporting only accounts from the **currently active workflow**, or exporting accounts from any individual workflow.
- **Targeted Workflow Import**:
  - During backup import, users are prompted to choose whether to keep original workflows, assign all imported accounts to an existing workflow, or create a new workflow specifically for the import.
  - Backup files store and restore workflow assignments seamlessly across devices with AES-256-GCM encryption.

## [0.3.2] - 2026-09-29

### 🛡️ Enhanced Anti-Ban Protection & Safe Defaults
- **Auto-Refresh Disabled by Default**: `antigravityAccount.autoRefreshEnabled` is now set to `false` by default. Accounts and cached quota data load instantly from local storage on webview open without firing unexpected network requests.
- **Background Periodic Refresh Off by Default**: `antigravityAccount.refreshIntervalMinutes` is now set to `0` (disabled) by default. When enabled by user, it strictly respects `isAutoRefreshEnabled()` and preserves cached balances (`force: false`).
- **Eliminated Aggressive 30-Second Polling**: Removed unconditional 30-second active account polling from the background event loop. Quota depletion checks now only run if `autoRotateEnabled` is explicitly enabled, with a safe 10-minute interval.
- **Account Switch Cooldown**: Added a 5-minute cooldown before requesting balance updates for newly activated accounts to avoid duplicate requests.
- **Dynamic User-Agent**: Replaced static version string in HTTP headers with real-time detection of the installed Antigravity IDE version (`getAntigravityVersion()`).

### ⏳ High-Entropy Randomized Delays & Human-Like Breaks
- **Extended Random Delays**: Increased random delays between account queries from `3s–7s` to **`12s–28s`**.
- **Natural Human Breaks**: Introduced a randomized pause of **15s–35s** every 3 to 6 accounts processed, breaking automated linear patterns and evading Google's bot heuristic detectors.

### ⚡ Non-Blocking Account Switching During Scan & Auto-Resume
- **Interactive Switching During Scan**: The "Activar" (Switch Account) buttons and search bar remain fully clickable and interactive even while an account scan is running in the background.
- **Pending Queue Persistence**: If an account switch is triggered while accounts are being refreshed, the remaining un-scanned account queue is automatically saved to persistent storage.
- **Automatic Resume on Relaunch**: After Antigravity IDE reloads with the new active account, the extension automatically detects the saved queue and seamlessly resumes refreshing from where it left off.

### 🛑 HTTP 429 Safety Brake & Single-Card Debounce
- **Emergency Stop on Rate Limit**: If Google APIs return HTTP 429 (Too Many Requests), the entire scan sequence halts immediately with a native warning, protecting all remaining accounts in the pool from cascaded bans.
- **Single-Card Debounce**: Added a 30-second cooldown per card to prevent button spamming.

## [0.3.1] - 2026-08-25

### 🛠️ Fixed Settings Persistence & Cross-Platform Stability
- **Cross-Platform Settings Save Fix (Linux & Windows)**: Resolved a critical issue where clicking the "Save" button in the Settings modal failed to persist changes or re-render properly across Ubuntu Linux and Windows environments.
- **Configuration Schema Constraints**: Updated `antigravityAccount.refreshIntervalMinutes` schema in `package.json` to allow `minimum: 0` (for Immediate on launch mode) and `maximum: 1440` (for 1 Day interval), eliminating VS Code schema validation rejections.
- **Sequential Configuration Writes**: Replaced parallel `Promise.all` configuration updates with robust sequential execution, preventing write collisions and lockouts on VS Code's global `settings.json`.
- **Instant Language Switching**: Synchronously updated the internal internationalization engine (`I18nService`) locale during settings save, ensuring immediate panel re-rendering in the newly selected language.
- **Enhanced Error Handling & Feedback**: Added comprehensive `try/catch` error handling with detailed logging and native notification toasts (`vscode.window.showInformationMessage`) upon successful settings updates.
- **Internationalization Updates**: Added localized `"settings.saved"` confirmation messages across all 10 supported languages (English, Español, 中文, Português, Français, Deutsch, 日本語, Русский, 한국어, العربية).

## [0.3.0] - 2026-08-24

### 🌌 Brand Identity & Visual Evolution
- **Striking New Extension Logo**: Introduced a futuristic emblem featuring a levitating geometric 'A' monogram with luminous orbital energy rings in electric violet, cyan, and deep purple gradients over an obsidian background.
- **Multi-Theme Customization Engine**: Choose between four curated visual themes directly in Settings:
  - 🟣 **Dark Purple (Original / Default)**: The iconic obsidian `#0c0a17` dark aesthetic with rich `#161327` cards, glowing purple active borders, and emerald indicators.
  - 🖤 **Midnight Black (OLED Pure)**: Deep `#06070a` OLED background with `#0c0e14` minimalist cards and neon cyan highlights.
  - 🌊 **Deep Ocean Blue**: Navy blue `#060c1a` surfaces with sapphire accents.
  - 🪟 **VS Code Adaptive**: Native binding to active editor theme colors (`--vscode-*`).

### 🛠️ Balance & Model Quota Enhancements
- **Accurate Model Quota Matching**: Fixed an issue where legacy model keys (`Gemini 3.7 Flash Tiered`, `Gemini 3.7 Flash`, `gemini-3.7-flash`) failed exact match against formatted balances, showing phantom 0% badges. Bidirectional normalization (`normalizeModelKey`) now guarantees accurate quota extraction across all model variants.
- **Smart Fallback Display**: If a preferred model is not configured on an account, the card automatically falls back to showing the account's best available model instead of an artificial 0% badge.
- **Full Gemini 3.7 Flash & Claude Support**: Native support and friendly names for **Gemini 3.7 Flash**, **Claude Sonnet 4.6**, **Claude Opus 4.6**, **Gemini 3.5 Flash**, **Gemini 3.1 Pro**, and **GPT-OSS 120B**.

### 🎨 UI/UX Polish & Ergonomics
- **Enhanced Card Hierarchy**: Crisp distinction between Account Display Name, custom editable Alias (with pencil trigger), and Google Account email.
- **Renewal Timer Pill**: Dedicated renewal countdown badge with clock icon and live renewal calculation (*"Recarga en 2h 45m"* / *"Disponible ahora"*).
- **Collapsible Model Drawer**: Interactive 1-click model switcher with real-time preview and semantic color gradients (Emerald ≥60%, Amber 20%–59%, Red <20%).
- **Integrated Search Toolbar**: Client-side filtering with search icon and instant clear button (`✕`).
- **Interactive Settings Modal**: Direct theme switching, auto-refresh toggles, and cache duration options with smooth glassmorphism.

## [0.2.6] - 2026-08-17

### Fixed
- **Accurate Quota & Renewal Sorting**: Resolved internal autocompletion token interference in balance calculations, correctly identifying accounts with usable Gemini model quota vs depleted accounts.
- **Renewal Countdown Precision**: Prioritized primary Gemini model reset times, displaying accurate renewal countdowns and "Available now" states.

## [0.2.5] - 2026-08-17

### Added
- **Expanded Internationalization (10 Languages)**: Full native localization support for **English**, **Español**, **中文 (简体)**, **Português (Brasil)**, **Français**, **Deutsch**, **日本語**, **Русский**, **한국어**, and **العربية** (with RTL text support), plus automatic editor language detection.
- **Quota Accounts Counter Badge**: Discreet header counter (`● X/Y`) showing the exact number of accounts with available quota at a glance.
- **Intelligent Renewal-Aware Sorting**: Default sorting (`default`) now automatically organizes accounts into distinct, intuitive priority tiers:
  1. Active pinned account at the top.
  2. Accounts with available quota (> 0%) ordered by highest remaining quota percentage descending.
  3. Depleted accounts (0% quota) ordered by **soonest recharge/renewal countdown** ascending (accounts closest to renewing appear first; accounts already recharged appear at the top of this group).
  4. Inactive, expired, and error accounts grouped at the bottom.
- **Persistent Scan Progress**: The refresh/scan progress banner state is now fully tracked in the backend provider and preserved across tab switches, webview reopens, and focus changes without losing percentage or current account details.

### Fixed
- **Segment Scanning Reliability**: Fixed `hasQuota` evaluation in Webview to accurately match friendly model names (`3.5 Flash (High)`, `Sonnet 4.6`, etc.) and ensure "Scan With Quota" and "Scan Without Quota" segments query live balance data without cache skips.
- **Elapsed Renewal Time Calculation**: Fixed an issue where accounts whose reset time had already passed (`diffMs <= 0`) were assigned infinite duration and sent to the bottom of the list. They are now correctly identified as "Available now" and prioritized for use.
- **DOM Stability During Refresh**: Removed destructive full-DOM rebuilds during progressive scans to ensure smooth, flicker-free single-card updates.
- **Antigravity IDE 2.0 Compatibility**: Resolved legacy `%APPDATA%\Antigravity` path conflict that caused recurring *"Migrate Settings, Keybindings, and Extensions"* prompt on IDE startup.

## [0.2.4] - 2026-06-24

### Fixed
- **Segment Scanning for Unset Global Models**: Fixed a bug where "Scan With Quota" and "Scan Without Quota" segment buttons did not correctly filter accounts when no global preferred model was selected in settings. The scan logic now correctly evaluates each account's specific active/selected model before falling back to the global preference or checking overall model balances.
- **VSIX Untracking**: Corrected Git tracking status for compiled `.vsix` files to prevent uploading compiled extension packages.

## [0.2.3] - 2026-06-12

### Added
- **Sort by Email**: Added options to sort registered accounts strictly by their Gmail address in alphabetical (A-Z) or reverse alphabetical (Z-A) order.
- **Model-Aware Segment Scanning**: Enhanced "Scan segment" functionality so that if a preferred model is selected, "Scan With Quota" and "Scan Without Quota" segments filter accounts based on whether they have quota for that specific preferred model.

## [0.2.2] - 2026-06-12

### Added
- **Periodic Background Refresh**: Implemented an automated background balance refresh that runs every 30 minutes (or based on `refreshIntervalMinutes`), fetching credits for all accounts silently to keep cache data up-to-date and prevent massive sudden refreshes.

### Fixed
- **Google One AI display**: Hidden zero-value credit badges (like `GOOGLE ONE AI 0`) in the sidebar panel and status bar tooltip for accounts without active paid subscriptions.
- **Segment Refresh Scan**: Bypassed the 30-second cooldown for manually triggered refreshes (such as clicking scan segment filters or refresh button) to execute them immediately.
- **Misleading success toasts**: Fixed a bug where skipped refreshes (cooldown active or empty results) still displayed "refreshed successfully" by checking actual execution run status.
- **Active Account Auto-Update**: Unconditionally refresh the active account balance in the background (every 30 seconds) and immediately trigger a balance update when the active account is changed in the IDE.
- **Auto-Rotation Triggering**: Centralized account status calculation so that if the preferred model's remaining percentage drops to 0%, the status correctly becomes `DEPLETED`, triggering auto-rotation to the next healthy account.
- **Instant Preferred Model Update**: Clicking on a model card in any card now immediately sets it as the preferred model, updating the status bar, re-sorting the list, and pinning it to the top.

## [0.2.1] - 2026-06-09

### Added
- **Background Active Account Balance Polling**: Periodically polls the active account's balance in the background (every 30 seconds) if auto-rotation is enabled, ensuring credit depletion is automatically detected.
- **Scanner Segment Warnings**: Provides immediate feedback/warning to the user if they attempt to scan a segment (with quota or without quota) that contains no accounts.

### Fixed
- **Stuck Activation Button**: Fixed a selector issue in `accountSwitchCancelled` that targeted the refresh button instead of the activate button, which left the button stuck in "Activando..." state when switching was cancelled.
- **Independent Activation Fallbacks**: Stored fallback timeouts directly on the button element's dataset to support multiple independent activations without global variable conflict.

## [0.2.0] - 2026-06-08

### Added
- **Custom OAuth Credentials**: Added new configuration options (`antigravityAccount.oauthClientId` and `antigravityAccount.oauthClientSecret`) to use personal developer credentials, avoiding the default 7-day Google OAuth testing token expiration.

### Improved
- **Robust Background Token Refresh**: Enhanced active account status monitoring. Expired active account tokens are now automatically refreshed during background scans.

### Fixed
- **State DB Initialization Parse**: Corrected typescript syntax/compilation issues in `state-db.service.ts` by restoring the class structure.
- **Terminal output masking**: Fixed indentation in `query_db.py` and restricted database reads to only Antigravity-related keys to prevent telemetry/token leaks, while properly masking active tokens.
- **Diagnostic tool**: Imported the missing `sys` library in `analyze.py`.

## [0.1.9] - 2026-06-05

### Added
- **Cooldown Auto-Queue**: Instead of showing blocking cooldown messages when requesting rapid balance updates, refreshes are now automatically scheduled to run as soon as the cooldown period expires.

### Fixed
- **Deduplicated Card Rendering**: Cleaned up the template structure to resolve inconsistencies where manually refreshed cards lost alias rename controls and initial cards lacked manual refresh buttons. Both buttons are now unified on the card header.
- **Native Dropdown Triggering**: Replaced container elements in the sort and scan toolbar dropdowns with `<label>` tags linked to select elements, resolving clicking capture issues and preventing highlight behavior.
- **Compact Toolbar Layout**: Implemented responsive container queries (`@container (max-width: 340px)`) to hide the "Sort by" label prefix and transition the scan action to a shorter "Refresh" text label on narrow sidebars, preventing layout squeezing or horizontal screen overflow.

## [0.1.8] - 2026-06-05

### Added
- **Account Aliases**: Inline editing (pencil button next to account names) to assign custom nicknames (e.g., "Work", "Personal") directly from the sidebar.
- **Customizable Low Credit Notifications**: Integrated settings toggle in sidebar and package.json to enable/disable native alerts when model credits run low.
- **Visual Upgrades**: Modern gradient progress bars (Emerald/Teal, Amber, Red/Rose) with a glassmorphic shimmer micro-animation.
- **Watch & Auto-Sync**: Developer automation script to watch files and compile/sync assets directly to the active IDE extensions directory in real-time.
- **Filtering & Sorting Toolbar**: Visual controls for sorting accounts (Default, Name A-Z, Name Z-A, Date Added, Remaining Quota) and segment scanning (All, With Quota, Without Quota).
- **Local Scanning Cache**: New `cacheDurationDays` setting to cache account balance status and skip scanning recently updated accounts, reducing API hits and rate limiting.
- **Real-Time Card Updates**: The panel UI now updates cards in real-time as they finish scanning instead of waiting for the full process to complete.
- **Per-Account Refresh**: Added a manual refresh icon directly on each account card to force a scan of that specific account.
- **Refreshed Visuals**: Shimmering/glowing border animations on active cards, and a spinning refresh icon next to the account name during scanning.

### Fixed
- **Settings Modal**: Resolved an issue where clicking Settings did not open the modal directly due to type safety compilation errors.
- **Refresh Interruption on Hide**: Configured `retainContextWhenHidden` via provider registration options so background refreshes continue running when switching views (e.g. to search or explorer).

## [0.1.4] - 2026-05-13

### Improved
- **Settings Panel**: Improved auto-refresh controls - clearer toggle states and preset interval options.
- **Refresh UX**: Replaced per-card loading indicators with a unified progress banner showing completion percentage and current account.
## [0.1.3] - 2026-05-13

### Added
- **Session Re-authentication**: "Re-sign in" button for expired sessions — no need to remove and re-add accounts.
- **Encrypted Backups**: Backup files are now password-encrypted. Legacy unencrypted imports still supported.
- **Auto-Refresh Settings**: Configurable automatic balance refresh with enable/disable toggle and customizable interval (default: 15 minutes). Available in both VS Code settings and the in-panel settings modal.
- **Active-Only Refresh**: When auto-refresh is disabled, only the active account's balance is updated on panel open (if stale for 5+ minutes).
- **Editor Compatibility Check**: The extension now detects whether it's running inside Antigravity. Non-Antigravity editors display a dedicated screen with a download link instead of the full panel.

### Fixed
- **Active Account Display**: Fixed a bug where cancelling a balance refresh caused the active account to temporarily lose its active status and be treated as a normal account.
- **Active Account Detection**: Active account now correctly detected on launch regardless of how it was activated.
- **Cancel Dialog**: Cancel confirmation dialog buttons are no longer disabled during refresh — they now respond to clicks as expected.
- **Cancel Flow**: Confirming cancellation now shows a "Cancelling..." loading state while waiting for the current account to finish, then applies sorting and shows a completion toast.

### Changed
- **Inline Balance Refresh**: Per-account loading indicator replaces the full-screen overlay. Buttons are disabled during refresh with a cancellable confirmation dialog.
- Expired accounts now have a distinct visual warning style.

### Security
- **Device Fingerprint Isolation**: Each account gets a fully unique set of telemetry identifiers to prevent cross-account correlation.
- Re-authentication now verifies email match to prevent accidental account mix-ups.

## [0.1.2] - 2026-05-10

### Added
- **Profile Pictures**: Account avatars are now displayed in the sidebar.

### Improved
- **Active Account Sync**: Active account is detected from Antigravity's internal state and pinned to the top of the list.

## [0.1.1] - 2026-05-09

### Added
- Initial release with core account management, OAuth login, multi-language support (EN/AR), and VS Code theme integration.
