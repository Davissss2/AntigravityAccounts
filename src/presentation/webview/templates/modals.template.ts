/**
 * Webview Modals Template
 * Settings dialog, immediate mode confirmation, and leak radar modal.
 */

export interface ModalsTemplateOptions {
  i18n: any;
  configTheme: string;
  configLanguage: string;
  configSortBy: string;
  configCacheDurationDays: number;
  configAutoRefresh: boolean;
  configAutoRotate: boolean;
  configLowCreditNotifications: boolean;
  configRefreshInterval: number;
  configAutoCapture: boolean;
  configAdaptivePolling: boolean;
  configAutoResumeChat: boolean;
  configAutoResumePrompt?: string;
  configNoticeDuration: number;
  configConfirmOnSwitch: boolean;
  configShowNotifications: boolean;
  isRtl: boolean;
}

export function getModalsHtml(opts: ModalsTemplateOptions): string {
  const {
    i18n,
    configTheme,
    configLanguage,
    configSortBy,
    configCacheDurationDays,
    configAutoRefresh,
    configAutoRotate,
    configLowCreditNotifications,
    configRefreshInterval,
    configAutoCapture,
    configAdaptivePolling,
    configAutoResumeChat,
    configAutoResumePrompt,
    configNoticeDuration,
    configConfirmOnSwitch,
    configShowNotifications,
    isRtl
  } = opts;

  return `
        <!-- Settings Modal -->
        <div id="settingsModal" class="modal-overlay" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.6); z-index:1000; align-items:center; justify-content:center; backdrop-filter:blur(4px);">
          <div class="modal-content" style="background:var(--surface-color); border:1px solid var(--border-color); color:var(--text-primary); border-radius:10px; width:90%; max-width:400px; padding:20px; box-shadow:0 8px 24px var(--shadow-color); max-height:90vh; overflow-y:auto;">
            <h3 style="margin-top:0; margin-bottom:16px; color:var(--text-primary);">${i18n.t('accounts.settings')}</h3>
            
            <div style="margin-bottom: 16px;">
              <label for="themeSelect" style="display:block; margin-bottom:8px; font-weight:bold; color:var(--text-primary);">${i18n.t('webview.theme')}</label>
              <select id="themeSelect" onchange="applyLiveTheme(this.value)" style="width:100%; padding:8px; background:var(--vscode-dropdown-background, var(--surface-subtle)); color:var(--vscode-dropdown-foreground, var(--text-primary)); border:1px solid var(--vscode-dropdown-border, var(--border-color)); border-radius:6px;">
                <option value="dark-purple" ${configTheme === 'dark-purple' ? 'selected' : ''}>${i18n.t('webview.themeDarkPurple')}</option>
                <option value="vscode" ${configTheme === 'vscode' ? 'selected' : ''}>${i18n.t('webview.themeVsCode')}</option>
                <option value="midnight" ${configTheme === 'midnight' ? 'selected' : ''}>${i18n.t('webview.themeMidnight')}</option>
                <option value="deep-blue" ${configTheme === 'deep-blue' ? 'selected' : ''}>${i18n.t('webview.themeDeepBlue')}</option>
              </select>
            </div>

            <div style="margin-bottom: 16px;">
              <label for="languageSelect" style="display:block; margin-bottom:8px; font-weight:bold; color:var(--text-primary);">${i18n.t('webview.language')}</label>
              <select id="languageSelect" style="width:100%; padding:8px; background:var(--vscode-dropdown-background, var(--surface-subtle)); color:var(--vscode-dropdown-foreground, var(--text-primary)); border:1px solid var(--vscode-dropdown-border, var(--border-color)); border-radius:6px;">
                <option value="auto" ${configLanguage === 'auto' ? 'selected' : ''}>${i18n.t('webview.languageAuto')}</option>
                <option value="en" ${configLanguage === 'en' ? 'selected' : ''}>English</option>
                <option value="es" ${configLanguage === 'es' ? 'selected' : ''}>Español</option>
                <option value="zh-CN" ${configLanguage === 'zh-CN' ? 'selected' : ''}>中文 (简体)</option>
                <option value="pt-BR" ${configLanguage === 'pt-BR' ? 'selected' : ''}>Português (Brasil)</option>
                <option value="fr" ${configLanguage === 'fr' ? 'selected' : ''}>Français</option>
                <option value="de" ${configLanguage === 'de' ? 'selected' : ''}>Deutsch</option>
                <option value="ja" ${configLanguage === 'ja' ? 'selected' : ''}>日本語</option>
                <option value="ru" ${configLanguage === 'ru' ? 'selected' : ''}>Русский</option>
                <option value="ko" ${configLanguage === 'ko' ? 'selected' : ''}>한국어</option>
                <option value="ar" ${configLanguage === 'ar' ? 'selected' : ''}>العربية</option>
              </select>
            </div>

            <div style="margin-bottom: 16px;">
              <label for="preferredModelSelect" style="display:block; margin-bottom:8px; font-weight:bold;">${i18n.t('webview.preferredModelSort')}</label>
              <select id="preferredModelSelect" style="width:100%; padding:8px; background:var(--vscode-dropdown-background); color:var(--vscode-dropdown-foreground); border:1px solid var(--vscode-dropdown-border); border-radius:4px;">
                <option value="">${i18n.t('webview.noSelectionDefault')}</option>
                <!-- Options populated by JS -->
              </select>
              <p style="font-size:0.85em; opacity:0.7; margin-top:8px;" id="settingsHelpText">
                ${i18n.t('webview.sortExplanation')}
              </p>
            </div>

            <div style="margin-bottom: 16px;">
              <label for="sortBySettingsSelect" style="display:block; margin-bottom:8px; font-weight:bold;">${i18n.t('webview.sortBy')}</label>
              <select id="sortBySettingsSelect" style="width:100%; padding:8px; background:var(--vscode-dropdown-background); color:var(--vscode-dropdown-foreground); border:1px solid var(--vscode-dropdown-border); border-radius:4px;">
                <option value="default" ${configSortBy === 'default' ? 'selected' : ''}>${i18n.t('webview.sortDefault')}</option>
                <option value="name-asc" ${configSortBy === 'name-asc' ? 'selected' : ''}>${i18n.t('webview.sortNameAsc')}</option>
                <option value="name-desc" ${configSortBy === 'name-desc' ? 'selected' : ''}>${i18n.t('webview.sortNameDesc')}</option>
                <option value="email-asc" ${configSortBy === 'email-asc' ? 'selected' : ''}>${i18n.t('webview.sortEmailAsc')}</option>
                <option value="email-desc" ${configSortBy === 'email-desc' ? 'selected' : ''}>${i18n.t('webview.sortEmailDesc')}</option>
                <option value="date-added" ${configSortBy === 'date-added' ? 'selected' : ''}>${i18n.t('webview.sortDateAdded')}</option>
                <option value="quota" ${configSortBy === 'quota' ? 'selected' : ''}>${i18n.t('webview.sortQuota')}</option>
                <option value="quota-regen" ${configSortBy === 'quota-regen' ? 'selected' : ''}>${i18n.t('webview.sortQuotaRegen')}</option>
              </select>
            </div>

            <div style="margin-bottom: 16px;">
              <label for="cacheDurationSelect" style="display:block; margin-bottom:8px; font-weight:bold;">${i18n.t('webview.cacheDurationLabel')}</label>
              <select id="cacheDurationSelect" style="width:100%; padding:8px; background:var(--vscode-dropdown-background); color:var(--vscode-dropdown-foreground); border:1px solid var(--vscode-dropdown-border); border-radius:4px;">
                <option value="1" ${configCacheDurationDays === 1 ? 'selected' : ''}>1 ${i18n.t('webview.day')}</option>
                <option value="3" ${configCacheDurationDays === 3 ? 'selected' : ''}>3 ${i18n.t('webview.days')}</option>
                <option value="7" ${configCacheDurationDays === 7 ? 'selected' : ''}>7 ${i18n.t('webview.days')}</option>
                <option value="14" ${configCacheDurationDays === 14 ? 'selected' : ''}>14 ${i18n.t('webview.days')}</option>
                <option value="30" ${configCacheDurationDays === 30 ? 'selected' : ''}>30 ${i18n.t('webview.days')}</option>
              </select>
              <p style="font-size:0.82em; opacity:0.65; margin:6px 0 0 0;">${i18n.t('webview.cacheDurationDescription')}</p>
            </div>

            <div style="border-top: 1px solid var(--border-color); padding-top: 16px; margin-bottom: 16px;">
              <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
                <label for="autoRefreshToggle" style="font-weight:bold; cursor:pointer;">${i18n.t('webview.autoRefreshLabel')}</label>
                <label style="position:relative; display:inline-block; width:40px; height:22px; cursor:pointer;">
                  <input type="checkbox" id="autoRefreshToggle" ${configAutoRefresh ? 'checked' : ''} onchange="onAutoRefreshToggle()" style="opacity:0; width:0; height:0;">
                  <span id="autoRefreshTrack" style="position:absolute; inset:0; background:${configAutoRefresh ? '#4caf50' : 'var(--glass-border)'}; border-radius:11px; transition:background 0.3s, box-shadow 0.3s; ${configAutoRefresh ? 'box-shadow:0 0 6px rgba(76,175,80,0.4);' : ''}"></span>
                  <span id="autoRefreshSlider" style="position:absolute; top:2px; ${isRtl ? 'right' : 'left'}:2px; width:18px; height:18px; background:var(--text-primary); border-radius:50%; transition:0.3s; ${configAutoRefresh ? (isRtl ? 'right:20px' : 'left:20px') : ''}"></span>
                </label>
              </div>
              <p style="font-size:0.82em; opacity:0.65; margin:0 0 12px 0;">${i18n.t('webview.autoRefreshDescription')}</p>

              <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; margin-top:12px;">
                <label for="autoRotateToggle" style="font-weight:bold; cursor:pointer;">${i18n.t('webview.autoRotateLabel')}</label>
                <label style="position:relative; display:inline-block; width:40px; height:22px; cursor:pointer;">
                  <input type="checkbox" id="autoRotateToggle" ${configAutoRotate ? 'checked' : ''} onchange="onAutoRotateToggle()" style="opacity:0; width:0; height:0;">
                  <span id="autoRotateTrack" style="position:absolute; inset:0; background:${configAutoRotate ? '#4caf50' : 'var(--glass-border)'}; border-radius:11px; transition:background 0.3s, box-shadow 0.3s; ${configAutoRotate ? 'box-shadow:0 0 6px rgba(76,175,80,0.4);' : ''}"></span>
                  <span id="autoRotateSlider" style="position:absolute; top:2px; ${isRtl ? 'right' : 'left'}:2px; width:18px; height:18px; background:var(--text-primary); border-radius:50%; transition:0.3s; ${configAutoRotate ? (isRtl ? 'right:20px' : 'left:20px') : ''}"></span>
                </label>
              </div>
              <p style="font-size:0.82em; opacity:0.65; margin:0 0 12px 0;">${i18n.t('webview.autoRotateDescription')}</p>

              <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; margin-top:12px;">
                <label for="lowCreditNotificationsToggle" style="font-weight:bold; cursor:pointer;">${i18n.t('webview.lowCreditNotificationsLabel')}</label>
                <label style="position:relative; display:inline-block; width:40px; height:22px; cursor:pointer;">
                  <input type="checkbox" id="lowCreditNotificationsToggle" ${configLowCreditNotifications ? 'checked' : ''} onchange="onLowCreditNotificationsToggle()" style="opacity:0; width:0; height:0;">
                  <span id="lowCreditNotificationsTrack" style="position:absolute; inset:0; background:${configLowCreditNotifications ? '#4caf50' : 'var(--glass-border)'}; border-radius:11px; transition:background 0.3s, box-shadow 0.3s; ${configLowCreditNotifications ? 'box-shadow:0 0 6px rgba(76,175,80,0.4);' : ''}"></span>
                  <span id="lowCreditNotificationsSlider" style="position:absolute; top:2px; ${isRtl ? 'right' : 'left'}:2px; width:18px; height:18px; background:var(--text-primary); border-radius:50%; transition:0.3s; ${configLowCreditNotifications ? (isRtl ? 'right:20px' : 'left:20px') : ''}"></span>
                </label>
              </div>
              <p style="font-size:0.82em; opacity:0.65; margin:0 0 12px 0;">${i18n.t('webview.lowCreditNotificationsDescription')}</p>

              <div id="refreshIntervalGroup" style="${configAutoRefresh ? '' : 'opacity:0.4; pointer-events:none;'}">
                <label for="refreshIntervalSelect" style="display:block; margin-bottom:6px; font-weight:bold; font-size:0.9em;">${i18n.t('webview.refreshIntervalLabel')}</label>
                <select id="refreshIntervalSelect" style="width:100%; padding:8px; background:var(--vscode-dropdown-background); color:var(--vscode-dropdown-foreground); border:1px solid var(--vscode-dropdown-border); border-radius:4px;">
                  <option value="0" ${configRefreshInterval === 0 ? 'selected' : ''}>${i18n.t('webview.intervalImmediate')}</option>
                  <option value="5" ${configRefreshInterval === 5 ? 'selected' : ''}>${i18n.t('webview.interval5Min')}</option>
                  <option value="15" ${configRefreshInterval === 15 ? 'selected' : ''}>${i18n.t('webview.interval15Min')}</option>
                  <option value="30" ${configRefreshInterval === 30 ? 'selected' : ''}>${i18n.t('webview.interval30Min')}</option>
                  <option value="60" ${configRefreshInterval === 60 ? 'selected' : ''}>${i18n.t('webview.interval1Hour')}</option>
                  <option value="1440" ${configRefreshInterval === 1440 ? 'selected' : ''}>${i18n.t('webview.interval1Day')}</option>
                </select>
                <p style="font-size:0.82em; opacity:0.65; margin:6px 0 0 0;">${i18n.t('webview.refreshIntervalDescription')}</p>
              </div>

              <!-- Auto-Capture Native Logins -->
              <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; margin-top:14px;">
                <label for="autoCaptureToggle" style="font-weight:bold; cursor:pointer;">${i18n.t('webview.autoCaptureLabel')}</label>
                <label style="position:relative; display:inline-block; width:40px; height:22px; cursor:pointer;">
                  <input type="checkbox" id="autoCaptureToggle" ${configAutoCapture ? 'checked' : ''} onchange="onAutoCaptureToggle()" style="opacity:0; width:0; height:0;">
                  <span id="autoCaptureTrack" style="position:absolute; inset:0; background:${configAutoCapture ? '#4caf50' : 'var(--glass-border)'}; border-radius:11px; transition:background 0.3s, box-shadow 0.3s; ${configAutoCapture ? 'box-shadow:0 0 6px rgba(76,175,80,0.4);' : ''}"></span>
                  <span id="autoCaptureSlider" style="position:absolute; top:2px; ${isRtl ? 'right' : 'left'}:2px; width:18px; height:18px; background:var(--text-primary); border-radius:50%; transition:0.3s; ${configAutoCapture ? (isRtl ? 'right:20px' : 'left:20px') : ''}"></span>
                </label>
              </div>
              <p style="font-size:0.82em; opacity:0.65; margin:0 0 12px 0;">${i18n.t('webview.autoCaptureDescription')}</p>

              <!-- Dynamic Adaptive Quota Polling (< 10%) -->
              <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; margin-top:14px;">
                <label for="adaptivePollingToggle" style="font-weight:bold; cursor:pointer;">${i18n.t('webview.adaptiveQuotaPollingLabel')}</label>
                <label style="position:relative; display:inline-block; width:40px; height:22px; cursor:pointer;">
                  <input type="checkbox" id="adaptivePollingToggle" ${configAdaptivePolling ? 'checked' : ''} onchange="onAdaptivePollingToggle()" style="opacity:0; width:0; height:0;">
                  <span id="adaptivePollingTrack" style="position:absolute; inset:0; background:${configAdaptivePolling ? '#4caf50' : 'var(--glass-border)'}; border-radius:11px; transition:background 0.3s, box-shadow 0.3s; ${configAdaptivePolling ? 'box-shadow:0 0 6px rgba(76,175,80,0.4);' : ''}"></span>
                  <span id="adaptivePollingSlider" style="position:absolute; top:2px; ${isRtl ? 'right' : 'left'}:2px; width:18px; height:18px; background:var(--text-primary); border-radius:50%; transition:0.3s; ${configAdaptivePolling ? (isRtl ? 'right:20px' : 'left:20px') : ''}"></span>
                </label>
              </div>
              <p style="font-size:0.82em; opacity:0.65; margin:0 0 12px 0;">${i18n.t('webview.adaptiveQuotaPollingDescription')}</p>

              <!-- Chat Auto-Resume on Depletion -->
              <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; margin-top:14px;">
                <label for="autoResumeChatToggle" style="font-weight:bold; cursor:pointer;">${i18n.t('webview.autoResumeChatLabel')}</label>
                <label style="position:relative; display:inline-block; width:40px; height:22px; cursor:pointer;">
                  <input type="checkbox" id="autoResumeChatToggle" ${configAutoResumeChat ? 'checked' : ''} onchange="onAutoResumeChatToggle()" style="opacity:0; width:0; height:0;">
                  <span id="autoResumeChatTrack" style="position:absolute; inset:0; background:${configAutoResumeChat ? '#4caf50' : 'var(--glass-border)'}; border-radius:11px; transition:background 0.3s, box-shadow 0.3s; ${configAutoResumeChat ? 'box-shadow:0 0 6px rgba(76,175,80,0.4);' : ''}"></span>
                  <span id="autoResumeChatSlider" style="position:absolute; top:2px; ${isRtl ? 'right' : 'left'}:2px; width:18px; height:18px; background:var(--text-primary); border-radius:50%; transition:0.3s; ${configAutoResumeChat ? (isRtl ? 'right:20px' : 'left:20px') : ''}"></span>
                </label>
              </div>
              <p style="font-size:0.82em; opacity:0.65; margin:0 0 12px 0;">${i18n.t('webview.autoResumeChatDescription')}</p>

              <!-- Auto-Resume Prompt -->
              <div id="autoResumePromptGroup" style="margin-bottom: 14px; ${configAutoResumeChat ? '' : 'opacity:0.4; pointer-events:none;'}">
                <label for="autoResumePromptInput" style="display:block; margin-bottom:6px; font-weight:bold; font-size:0.9em;">${i18n.t('webview.autoResumePromptLabel')}</label>
                <input type="text" id="autoResumePromptInput" value="${(configAutoResumePrompt || '').replace(/"/g, '&quot;')}" style="width:100%; box-sizing:border-box; padding:8px; background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border); border-radius:4px;" placeholder="continua">
                <p style="font-size:0.82em; opacity:0.65; margin:6px 0 0 0;">${i18n.t('webview.autoResumePromptDescription')}</p>
              </div>

              <!-- Notice Duration Before Switch -->
              <div style="margin-bottom: 14px; margin-top:14px;">
                <label for="noticeDurationSelect" style="display:block; margin-bottom:6px; font-weight:bold; font-size:0.9em;">${i18n.t('webview.noticeDurationLabel')}</label>
                <select id="noticeDurationSelect" style="width:100%; padding:8px; background:var(--vscode-dropdown-background); color:var(--vscode-dropdown-foreground); border:1px solid var(--vscode-dropdown-border); border-radius:4px;">
                  <option value="0" ${configNoticeDuration === 0 ? 'selected' : ''}>0s (${i18n.t('webview.intervalImmediate')})</option>
                  <option value="3" ${configNoticeDuration === 3 ? 'selected' : ''}>3s</option>
                  <option value="5" ${configNoticeDuration === 5 ? 'selected' : ''}>5s</option>
                  <option value="10" ${configNoticeDuration === 10 ? 'selected' : ''}>10s</option>
                </select>
                <p style="font-size:0.82em; opacity:0.65; margin:6px 0 0 0;">${i18n.t('webview.noticeDurationDescription')}</p>
              </div>

              <!-- Confirm Before Account Switch -->
              <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; margin-top:14px;">
                <label for="confirmOnSwitchToggle" style="font-weight:bold; cursor:pointer;">${i18n.t('webview.confirmOnSwitchLabel')}</label>
                <label style="position:relative; display:inline-block; width:40px; height:22px; cursor:pointer;">
                  <input type="checkbox" id="confirmOnSwitchToggle" ${configConfirmOnSwitch ? 'checked' : ''} onchange="onConfirmOnSwitchToggle()" style="opacity:0; width:0; height:0;">
                  <span id="confirmOnSwitchTrack" style="position:absolute; inset:0; background:${configConfirmOnSwitch ? '#4caf50' : 'var(--glass-border)'}; border-radius:11px; transition:background 0.3s, box-shadow 0.3s; ${configConfirmOnSwitch ? 'box-shadow:0 0 6px rgba(76,175,80,0.4);' : ''}"></span>
                  <span id="confirmOnSwitchSlider" style="position:absolute; top:2px; ${isRtl ? 'right' : 'left'}:2px; width:18px; height:18px; background:var(--text-primary); border-radius:50%; transition:0.3s; ${configConfirmOnSwitch ? (isRtl ? 'right:20px' : 'left:20px') : ''}"></span>
                </label>
              </div>
              <p style="font-size:0.82em; opacity:0.65; margin:0 0 12px 0;">${i18n.t('webview.confirmOnSwitchDescription')}</p>

              <!-- Verbose Notifications Toggle -->
              <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; margin-top:14px;">
                <label for="showNotificationsToggle" style="font-weight:bold; cursor:pointer;">${i18n.t('webview.showNotificationsLabel')}</label>
                <label style="position:relative; display:inline-block; width:40px; height:22px; cursor:pointer;">
                  <input type="checkbox" id="showNotificationsToggle" ${configShowNotifications ? 'checked' : ''} onchange="onShowNotificationsToggle()" style="opacity:0; width:0; height:0;">
                  <span id="showNotificationsTrack" style="position:absolute; inset:0; background:${configShowNotifications ? '#4caf50' : 'var(--glass-border)'}; border-radius:11px; transition:background 0.3s, box-shadow 0.3s; ${configShowNotifications ? 'box-shadow:0 0 6px rgba(76,175,80,0.4);' : ''}"></span>
                  <span id="showNotificationsSlider" style="position:absolute; top:2px; ${isRtl ? 'right' : 'left'}:2px; width:18px; height:18px; background:var(--text-primary); border-radius:50%; transition:0.3s; ${configShowNotifications ? (isRtl ? 'right:20px' : 'left:20px') : ''}"></span>
                </label>
              </div>
              <p style="font-size:0.82em; opacity:0.65; margin:0 0 12px 0;">${i18n.t('webview.showNotificationsDescription')}</p>
            </div>

            <!-- Immediate Mode Confirmation Dialog -->
            <div id="immediateConfirmOverlay" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.6); z-index:2000; align-items:center; justify-content:center;">
              <div style="background:var(--vscode-editor-background); border:1px solid var(--vscode-widget-border); border-radius:10px; width:85%; max-width:360px; padding:20px; box-shadow:0 8px 24px rgba(0,0,0,0.3); text-align:center;">
                <h4 style="margin:0 0 12px 0; color:var(--warning-color); font-size:1em;">${i18n.t('webview.immediateConfirmTitle')}</h4>
                <p style="font-size:0.85em; opacity:0.8; line-height:1.5; margin:0 0 16px 0;">${i18n.t('webview.immediateConfirmMessage')}</p>
                <div style="display:flex; justify-content:center; gap:10px;">
                  <button class="btn" style="background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground);" onclick="cancelImmediateMode()">${i18n.t('webview.immediateConfirmCancel')}</button>
                  <button class="btn" style="background:var(--warning-color); color:#000; font-weight:600;" onclick="confirmImmediateMode()">${i18n.t('webview.immediateConfirmYes')}</button>
                </div>
              </div>
            </div>

            <div style="display:flex; justify-content:flex-end; gap:8px;">
              <button class="btn" style="background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground);" onclick="closeSettings()">${i18n.t('common.cancel')}</button>
              <button class="btn btn-primary" onclick="saveSettings()">${i18n.t('common.save')}</button>
            </div>
          </div>
        </div>

        <!-- Radar de Filtraciones Modal -->
        <div id="leaksModal" class="modal-overlay" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.65); z-index:1000; align-items:center; justify-content:center; backdrop-filter:blur(4px);">
          <div class="modal-content" style="background:var(--surface-color); border:1px solid rgba(0,229,255,0.3); color:var(--text-primary); border-radius:12px; width:92%; max-width:440px; padding:20px; box-shadow:0 8px 32px rgba(0,229,255,0.15); max-height:85vh; overflow-y:auto;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; border-bottom:1px solid var(--border-color); padding-bottom:10px;">
              <div style="display:flex; align-items:center; gap:8px;">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#00e5ff" stroke-width="2.5"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                <h3 style="margin:0; font-size:1.05rem; color:#00e5ff; font-weight:700;">Radar de Filtraciones</h3>
              </div>
              <button onclick="closeLeaksModal()" style="background:transparent; border:none; color:var(--text-secondary); cursor:pointer; font-size:1.2rem; line-height:1;">&times;</button>
            </div>
            
            <div style="background:rgba(34,197,94,0.08); border:1px solid rgba(34,197,94,0.3); border-radius:8px; padding:12px; margin-bottom:14px;">
              <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:6px;">
                <span style="font-size:0.95rem; font-weight:700; color:#fff;">Gemini 4 Neon</span>
                <span style="background:rgba(34,197,94,0.2); color:#4ade80; font-size:0.68rem; font-weight:700; padding:2px 7px; border-radius:10px; border:1px solid rgba(34,197,94,0.4);">LANZAMIENTO OFICIAL</span>
              </div>
              <div style="font-size:0.78rem; color:var(--text-secondary); margin-bottom:6px;">
                <strong>Identificador de ruteo:</strong> <code style="background:rgba(0,0,0,0.3); color:#4ade80; padding:2px 5px; border-radius:4px;">gemini-pro-orchestrator-neon</code>
              </div>
              <div style="font-size:0.78rem; color:var(--text-secondary); margin-bottom:6px;">
                <strong>Estado:</strong> Oficialmente activo en inferencia y ruteo orquestado
              </div>
              <div style="font-size:0.78rem; color:var(--text-secondary); line-height:1.4;">
                Modelo orquestador Pro para agentes. Gestiona planificacion compleja, coordinacion multi-agente y ejecucion de subagentes en paralelo. Disponible en el selector de modelos preferidos.
              </div>
            </div>

            <div style="background:var(--surface-light); border:1px solid var(--border-color); border-radius:8px; padding:12px; margin-bottom:14px;">
              <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:6px;">
                <span style="font-size:0.95rem; font-weight:700; color:var(--text-primary);">Gemini 4 Hydrogen</span>
                <span style="background:rgba(34,197,94,0.15); color:#4ade80; font-size:0.68rem; font-weight:700; padding:2px 7px; border-radius:10px; border:1px solid rgba(34,197,94,0.3);">ACTIVO EN STAGING</span>
              </div>
              <div style="font-size:0.78rem; color:var(--text-secondary); margin-bottom:6px;">
                <strong>Identificador de ruteo:</strong> <code style="background:rgba(0,0,0,0.3); color:var(--text-primary); padding:2px 5px; border-radius:4px;">gemini-4-hydrogen-sonar</code>
              </div>
              <div style="font-size:0.78rem; color:var(--text-secondary); line-height:1.4;">
                Modelo de ejecucion ultra-rapida y alta eficiencia integrado para generacion de codigo y flujos reactivos. Seleccionable en el menu de modelos preferidos.
              </div>
            </div>

            <div style="text-align:right;">
              <button class="btn btn-primary" onclick="closeLeaksModal()" style="padding:6px 14px; font-size:0.8rem;">Entendido</button>
            </div>
          </div>
        </div>


  `;
}
