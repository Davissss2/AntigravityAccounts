# Changelog

All notable changes to the "Antigravity Hub" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.5] - 2026-08-17

### Added
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
