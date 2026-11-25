/**
 * Webview Client Script
 * Contains all client-side JavaScript for DOM manipulation, messaging, search, drag & drop, and modals.
 */

export interface WebviewClientScriptOptions {
  availableModelKeys: string[];
  effectivePreferred: string;
  configTheme: string;
  configLanguage: string;
  hasAccounts: boolean;
  configAutoRefresh: boolean;
  configAutoRotate: boolean;
  configLowCreditNotifications: boolean;
  configRefreshInterval: number;
  configSortBy: string;
  configCacheDurationDays: number;
  configAutoCapture: boolean;
  configAdaptivePolling: boolean;
  configAutoResumeChat: boolean;
  configAutoResumePrompt?: string;
  configNoticeDuration: number;
  configConfirmOnSwitch: boolean;
  configShowNotifications: boolean;
  isRtl: boolean;
  searchQuery: string;
  isRefreshing: boolean;
  activeWorkflowId?: string;
  i18n: any;
}

export function getWebviewClientScript(opts: WebviewClientScriptOptions): string {
  const {
    availableModelKeys,
    effectivePreferred,
    configTheme,
    configLanguage,
    hasAccounts,
    configAutoRefresh,
    configAutoRotate,
    configLowCreditNotifications,
    configRefreshInterval,
    configSortBy,
    configCacheDurationDays,
    configAutoCapture,
    configAdaptivePolling,
    configAutoResumeChat,
    configAutoResumePrompt,
    configNoticeDuration,
    configConfirmOnSwitch,
    configShowNotifications,
    isRtl,
    searchQuery,
    isRefreshing,
    activeWorkflowId,
    i18n
  } = opts;

  return `
        <script>
          const vscode = acquireVsCodeApi();
          
          window.onerror = function(message, source, lineno, colno, error) {
            vscode.postMessage({
              command: 'logError',
              message: message,
              source: source,
              lineno: lineno,
              colno: colno,
              stack: error ? error.stack : 'No stack'
            });
            return false;
          };

          // Redirect console logs to extension host for debugging
          const originalLog = console.log;
          const originalError = console.error;
          const originalWarn = console.warn;
          
          console.log = function(...args) {
            originalLog.apply(console, args);
            vscode.postMessage({ command: 'consoleLog', level: 'info', args: args.map(String) });
          };
          console.error = function(...args) {
            originalError.apply(console, args);
            vscode.postMessage({ command: 'consoleLog', level: 'error', args: args.map(String) });
          };
          console.warn = function(...args) {
            originalWarn.apply(console, args);
            vscode.postMessage({ command: 'consoleLog', level: 'warn', args: args.map(String) });
          };
        </script>
        <script>
          const availableModelKeys = ${JSON.stringify(availableModelKeys)};
          let currentPreferredModel = ${JSON.stringify(effectivePreferred)};
          let currentTheme = ${JSON.stringify(configTheme)};
          let currentLanguage = ${JSON.stringify(configLanguage)};
          let hasAccounts = ${hasAccounts};
          let currentAutoRefresh = ${configAutoRefresh};
          let currentAutoRotate = ${configAutoRotate};
          let currentLowCreditNotifications = ${configLowCreditNotifications};
          let currentRefreshInterval = ${configRefreshInterval};
          let currentSortBy = ${JSON.stringify(configSortBy)};
          let currentCacheDurationDays = ${configCacheDurationDays};
          let currentAutoCapture = ${configAutoCapture};
          let currentAdaptivePolling = ${configAdaptivePolling};
          let currentAutoResumeChat = ${configAutoResumeChat};
          let currentAutoResumePrompt = ${JSON.stringify(configAutoResumePrompt)};
          let currentNoticeDuration = ${configNoticeDuration};
          let currentConfirmOnSwitch = ${configConfirmOnSwitch};
          let currentShowNotifications = ${configShowNotifications};
          const isRtlDir = ${isRtl};
          const savedSearchQuery = ${JSON.stringify(searchQuery)};

          let settingsInactivityTimer = null;
          function resetSettingsInactivityTimer() {
            if (settingsInactivityTimer) clearTimeout(settingsInactivityTimer);
            // 3-minute inactivity timeout (resets on mouse/keyboard activity)
            settingsInactivityTimer = setTimeout(() => {
              const modal = document.getElementById('settingsModal');
              if (modal && modal.style.display !== 'none') {
                closeSettings();
              }
            }, 180000);
          }
          
          // vscode is now defined in the first script tag globally to allow window.onerror logging before this script runs.
          let state = vscode.getState() || { activeModels: {} };
          if (!state) state = { activeModels: {} };
          if (!state.activeModels) state.activeModels = {};

          function applyLiveTheme(theme) {
            if (!theme) return;
            document.documentElement.setAttribute('data-theme', theme);
            document.body.setAttribute('data-theme', theme);
            document.body.className = 'theme-' + theme;
          }

          function toggleModels(headerElement, wrapperId) {
            const wrapper = document.getElementById(wrapperId);
            if (wrapper) {
              wrapper.classList.toggle('expanded');
              headerElement.classList.toggle('expanded');
            }
          }

          function handleSwitchAccount(btn, email) {
            if (btn.disabled) return;
            btn.disabled = true;
            const originalText = btn.innerText;
            btn.innerText = '${i18n.t('webview.activating')}';
            btn.style.opacity = '0.7';
            btn.style.cursor = 'not-allowed';
            btn.dataset.originalText = originalText;
            
            sendMessage('switchAccount', email);

            if (btn.dataset.timeoutId) {
              clearTimeout(parseInt(btn.dataset.timeoutId, 10));
            }
            const tId = setTimeout(() => {
              btn.disabled = false;
              btn.innerText = originalText;
              btn.style.opacity = '';
              btn.style.cursor = '';
              delete btn.dataset.timeoutId;
            }, 10000);
            btn.dataset.timeoutId = tId;
          }

          // ── Refresh button ──
          let isRefreshing = ${isRefreshing};
          if (isRefreshing) {
            setTimeout(() => {
              setActionsDisabled(true);
              setSearchDisabled(true);
            }, 0);
          }

          function handleRefresh() {
            if (isRefreshing) return;
            const searchInput = document.getElementById('searchInput');
            const query = searchInput ? searchInput.value.trim() : '';
            if (query) {
              // Flush any pending debounce and apply filter immediately
              if (searchDebounceTimer) {
                clearTimeout(searchDebounceTimer);
                searchDebounceTimer = null;
              }
              applySearchFilter(query);
            }

            // Immediately provide visual feedback in the UI
            isRefreshing = true;
            setActionsDisabled(true);
            const refreshBtn = document.getElementById('refreshBtn');
            if (refreshBtn) refreshBtn.classList.add('spinning');
            const scanBtn = document.querySelector('.toolbar-scan');
            if (scanBtn) scanBtn.classList.add('loading');

            // If a specific workflow is active (or search query is active), refresh only visible accounts!
            if (currentWorkflowFilter !== 'all' || query) {
              const visibleCards = document.querySelectorAll('.account-card:not(.workflow-hidden):not(.search-hidden)');
              if (visibleCards.length === 0) {
                isRefreshing = false;
                setActionsDisabled(false);
                if (refreshBtn) refreshBtn.classList.remove('spinning');
                if (scanBtn) scanBtn.classList.remove('loading');
                return;
              }
              showProgressBanner(visibleCards.length);
              const filteredEmails = Array.from(visibleCards).map(c => c.dataset.email);
              vscode.postMessage({ command: 'refreshAccounts', filteredEmails });
            } else {
              const allCards = document.querySelectorAll('.account-card');
              showProgressBanner(allCards.length);
              sendMessage('refreshAccounts');
            }
          }

          function handleSortChange() {
            const select = document.getElementById('sortSelect');
            const sortBy = select.value;
            const labelDisplay = document.getElementById('sortLabelDisplay');
            if (labelDisplay) {
              const selectedText = select.options[select.selectedIndex].text;
              labelDisplay.innerHTML = '<span class="toolbar-label-prefix">${i18n.t('webview.sortBy')}: </span><span class="toolbar-value" style="color: var(--text-primary); font-size: 0.78rem; font-weight: 500; text-transform: none; margin-inline-start: 4px;">' + selectedText + '</span>';
            }
            vscode.postMessage({
              command: 'saveSettings',
              sortBy: sortBy
            });
            // Show loading overlay briefly
            vscode.postMessage({ command: 'showLoading' });
          }

          function handleScanChange() {
            const select = document.getElementById('scanSelect');
            const segment = select.value;
            if (!segment) return;

            // Reset select value to default placeholder immediately
            select.value = '';

            let targetEmails = [];
            // Target only cards currently visible in the active workflow
            const cards = document.querySelectorAll('.account-card:not(.workflow-hidden)');

            const getCheckModel = (card) => {
              const email = card.dataset.email;
              const activeModel = state.activeModels && state.activeModels[email];
              if (activeModel) return activeModel.toLowerCase();
              const globalPref = (typeof currentPreferredModel === 'string' ? currentPreferredModel : '').toLowerCase();
              if (globalPref) return globalPref;
              return null;
            };

            const hasQuota = (card) => {
              try {
                const balances = JSON.parse(card.dataset.modelBalances || '{}');
                const checkModel = getCheckModel(card);
                if (checkModel) {
                  if (balances[checkModel] !== undefined) {
                    return balances[checkModel] > 0;
                  }
                  const matchingKey = Object.keys(balances).find(k => k.toLowerCase() === checkModel.toLowerCase() || k.toLowerCase().includes(checkModel.toLowerCase()) || checkModel.toLowerCase().includes(k.toLowerCase()));
                  if (matchingKey !== undefined) {
                    return balances[matchingKey] > 0;
                  }
                }
                return Object.values(balances).some(val => typeof val === 'number' && val > 0);
              } catch (e) {
                return false;
              }
            };

            if (segment === 'all') {
              targetEmails = Array.from(cards).map(c => c.dataset.email);
            } else if (segment === 'with-quota') {
              targetEmails = Array.from(cards)
                .filter(c => {
                  const status = c.dataset.status;
                  const isAvailable = (status === 'active' || status === 'low_balance');
                  return isAvailable && hasQuota(c);
                })
                .map(c => c.dataset.email);
            } else if (segment === 'without-quota') {
              targetEmails = Array.from(cards)
                .filter(c => {
                  const status = c.dataset.status;
                  const isDepletedOrError = (status === 'depleted' || status === 'token_expired' || status === 'error' || status === 'scope_missing');
                  return isDepletedOrError || !hasQuota(c);
                })
                .map(c => c.dataset.email);
            }

            if (targetEmails.length === 0) {
              vscode.postMessage({
                command: 'showWarning',
                text: '${i18n.t('webview.noAccountsInSegment')}'
              });
              return;
            }

            vscode.postMessage({
              command: 'refreshAccounts',
              filteredEmails: targetEmails
            });
          }

          function handleSingleRefresh(btn, email) {
            // Find the closest account-card element
            const card = btn ? btn.closest('.account-card') : null;
            if (card) {
              card.classList.add('refreshing');
            }
            if (btn) {
              btn.classList.add('spinning');
            }
            vscode.postMessage({
              command: 'refreshSingleAccount',
              email: email
            });
          }

          // ── Search ──
          let searchDebounceTimer = null;

          function applySearchFilter(query) {
            const cards = document.querySelectorAll('.account-card');
            const noResults = document.getElementById('searchNoResults');
            const clearBtn = document.getElementById('searchClearBtn');
            const q = (query || '').toLowerCase().trim();

            if (clearBtn) clearBtn.style.display = q ? 'block' : 'none';

            let visibleCount = 0;
            cards.forEach(card => {
              const email = (card.dataset.email || '').toLowerCase();
              const name = (card.dataset.name || '').toLowerCase();
              const alias = (card.dataset.alias || '').toLowerCase();
              const status = (card.dataset.status || '').toLowerCase();
              const plan = (card.dataset.plan || '').toLowerCase();
              const planLabel = (card.dataset.planLabel || '').toLowerCase();
              const badgeEl = card.querySelector('.badge');
              const badgeText = (badgeEl ? badgeEl.textContent || '' : '').toLowerCase();
              const statusMatches = status.includes(q) || badgeText.includes(q) || plan.includes(q) || planLabel.includes(q);
              const textMatches = !q || email.includes(q) || name.includes(q) || alias.includes(q) || statusMatches;

              if (textMatches) {
                card.classList.remove('search-hidden');
                if (!card.classList.contains('workflow-hidden')) {
                  visibleCount++;
                }
              } else {
                card.classList.add('search-hidden');
              }
            });

            if (noResults) noResults.style.display = (visibleCount === 0 && cards.length > 0) ? 'block' : 'none';
          }

          function onSearchInput(e) {
            const query = e.target.value;
            // Notify provider to preserve query across re-renders
            vscode.postMessage({ command: 'searchChanged', query });
            if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
            searchDebounceTimer = setTimeout(() => {
              applySearchFilter(query);
            }, 300);
          }

          function clearSearch() {
            const input = document.getElementById('searchInput');
            if (input) { input.value = ''; input.focus(); }
            if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
            applySearchFilter('');
            vscode.postMessage({ command: 'searchChanged', query: '' });
          }

          function setSearchDisabled(disabled) {
            // Keep search input available during refresh so users can search and switch accounts freely
            const input = document.getElementById('searchInput');
            if (input) input.disabled = false;
          }

          // ── Workflows ──
          let currentWorkflowFilter = ${JSON.stringify(activeWorkflowId || 'all')};

          function selectWorkflowFilter(workflowId) {
            currentWorkflowFilter = workflowId;
            document.querySelectorAll('#workflowBar .workflow-chip').forEach(chip => {
              chip.classList.toggle('active', chip.dataset.workflowId === workflowId);
            });
            applyWorkflowFilter(workflowId);
            vscode.postMessage({
              command: 'setActiveWorkflow',
              workflowId: workflowId === 'all' ? null : workflowId
            });
          }

          function applyWorkflowFilter(workflowId) {
            const cards = document.querySelectorAll('.account-card');
            const noResults = document.getElementById('searchNoResults');
            let visibleCount = 0;
            cards.forEach(card => {
              const cardWf = card.dataset.workflow || '';
              let match = false;
              if (workflowId === 'all') {
                match = true;
              } else if (workflowId === 'uncategorized') {
                match = !cardWf;
              } else {
                match = (cardWf === workflowId);
              }

              if (match) {
                card.classList.remove('workflow-hidden');
                if (!card.classList.contains('search-hidden')) {
                  visibleCount++;
                }
              } else {
                card.classList.add('workflow-hidden');
              }
            });

            if (noResults) noResults.style.display = (visibleCount === 0 && cards.length > 0) ? 'block' : 'none';
          }

          function handleAssignWorkflow(email) {
            vscode.postMessage({
              command: 'assignAccountWorkflow',
              email: email
            });
          }

          function handleCreateWorkflow() {
            vscode.postMessage({
              command: 'createWorkflow'
            });
          }

          function showWorkflowActions(e, wfId, wfName) {
            e.stopPropagation();
            vscode.postMessage({
              command: 'workflowOptions',
              workflowId: wfId,
              workflowName: wfName
            });
          }

          let isBulkMode = false;
          const selectedBulkEmails = new Set();

          function toggleBulkSelectMode() {
            isBulkMode = !isBulkMode;
            document.body.classList.toggle('bulk-mode', isBulkMode);
            const bar = document.getElementById('bulkActionBar');
            if (bar) bar.style.display = isBulkMode ? 'flex' : 'none';
            if (!isBulkMode) {
              selectedBulkEmails.clear();
            }
            updateBulkUI();
          }

          function handleCardCheck(checkbox, email) {
            if (checkbox.checked) {
              selectedBulkEmails.add(email);
            } else {
              selectedBulkEmails.delete(email);
            }
            updateBulkUI();
          }

          function updateBulkUI() {
            const countEl = document.getElementById('bulkSelectedText');
            if (countEl) {
              countEl.textContent = selectedBulkEmails.size + ' ${i18n.t('workflows.bulkSelected')}';
            }
            document.querySelectorAll('.account-card').forEach(card => {
              const email = card.dataset.email;
              const chk = card.querySelector('.card-bulk-check');
              if (selectedBulkEmails.has(email)) {
                card.classList.add('selected-for-bulk');
                if (chk) chk.checked = true;
              } else {
                card.classList.remove('selected-for-bulk');
                if (chk) chk.checked = false;
              }
            });
          }

          function selectAllBulk(select) {
            const cards = document.querySelectorAll('.account-card:not(.workflow-hidden):not(.search-hidden)');
            cards.forEach(card => {
              const email = card.dataset.email;
              if (select) {
                selectedBulkEmails.add(email);
              } else {
                selectedBulkEmails.delete(email);
              }
            });
            updateBulkUI();
          }

          function bulkAssignWorkflow() {
            if (selectedBulkEmails.size === 0) return;
            vscode.postMessage({
              command: 'bulkAssignWorkflow',
              emails: Array.from(selectedBulkEmails)
            });
          }

          function bulkExportSelected() {
            if (selectedBulkEmails.size === 0) return;
            vscode.postMessage({
              command: 'bulkExportAccounts',
              emails: Array.from(selectedBulkEmails)
            });
          }

          function bulkDeleteSelected() {
            if (selectedBulkEmails.size === 0) return;
            vscode.postMessage({
              command: 'bulkDeleteAccounts',
              emails: Array.from(selectedBulkEmails)
            });
          }

          document.addEventListener('click', function(e) {
            if (!isBulkMode) return;
            const card = e.target.closest('.account-card');
            if (!card) return;
            if (e.target.closest('button') || e.target.closest('input') || e.target.closest('select') || e.target.closest('a')) return;
            const email = card.dataset.email;
            if (email) {
              if (selectedBulkEmails.has(email)) {
                selectedBulkEmails.delete(email);
              } else {
                selectedBulkEmails.add(email);
              }
              updateBulkUI();
            }
          });

          // Attach search listener and restore state
          (function initSearch() {
            const input = document.getElementById('searchInput');
            if (input) {
              input.addEventListener('input', onSearchInput);
              
              // Track focus state to restore it after re-renders
              input.addEventListener('focus', () => {
                const st = vscode.getState() || {};
                vscode.setState({ ...st, searchFocused: true });
              });
              input.addEventListener('blur', () => {
                const st = vscode.getState() || {};
                vscode.setState({ ...st, searchFocused: false });
              });

              // Restore search query from provider state
              if (savedSearchQuery) {
                input.value = savedSearchQuery;
                applySearchFilter(savedSearchQuery);
              }

              // Restore focus if it was focused before re-render
              const currentState = vscode.getState() || {};
              if (currentState.searchFocused && !input.disabled) {
                input.focus();
              }
            }
            // Apply initial workflow filter
            applyWorkflowFilter(currentWorkflowFilter);
          })();

          // ── Cancel confirmation ──
          function showCancelConfirm() {
            const promptView = document.getElementById('cancelPromptView');
            const spinnerView = document.getElementById('cancelSpinnerView');
            if (promptView) promptView.style.display = 'block';
            if (spinnerView) spinnerView.style.display = 'none';
            document.getElementById('cancelConfirmOverlay').style.display = 'flex';
          }
          function dismissCancelConfirm() {
            document.getElementById('cancelConfirmOverlay').style.display = 'none';
            const promptView = document.getElementById('cancelPromptView');
            const spinnerView = document.getElementById('cancelSpinnerView');
            if (promptView) promptView.style.display = 'block';
            if (spinnerView) spinnerView.style.display = 'none';
          }
          function confirmCancel() {
            dismissCancelConfirm();
            isRefreshing = false;
            hideProgressBanner(true);
            setActionsDisabled(false);
            setSearchDisabled(false);
            const rBtn = document.getElementById('refreshBtn');
            if (rBtn) rBtn.classList.remove('spinning');
            const sBtn = document.querySelector('.toolbar-scan');
            if (sBtn) sBtn.classList.remove('loading');
            document.querySelectorAll('.btn-card-refresh.spinning').forEach(b => b.classList.remove('spinning'));
            document.querySelectorAll('.account-card.refreshing').forEach(c => c.classList.remove('refreshing'));
            if (typeof clearAntiBanTimer === 'function') {
              clearAntiBanTimer();
            }
            sendMessage('cancelRefresh');
          }

          function applyActiveModels() {
             document.querySelectorAll('.account-card').forEach(card => {
                const email = card.dataset?.email || card.querySelector('.user-info p').innerText.trim();
                const activeModelKey = state.activeModels[email];
                const container = card.querySelector('.models-container');
                
                if (activeModelKey && container) {
                   if (!container.originalOrder) {
                      container.originalOrder = Array.from(container.children);
                   }
                   
                   // Restore original sorted order first
                   container.innerHTML = '';
                   container.originalOrder.forEach(el => {
                      el.classList.remove('active-model');
                      container.appendChild(el);
                   });
                   
                   // Also remove active-model from preferred header if it exists
                   const preferredHeader = card.querySelector('.preferred-model-card');
                   if (preferredHeader) {
                      preferredHeader.classList.remove('active-model');
                   }
                   
                   // Find the active model inside the container and move it to top
                   const targetModel = container.querySelector('.model-card[data-model-key="' + activeModelKey + '"]');
                   if (targetModel) {
                      container.prepend(targetModel);
                      targetModel.classList.add('active-model');
                   } else if (preferredHeader && preferredHeader.dataset.modelKey === activeModelKey) {
                      // If the active model is the preferred model (which is in the header now)
                      preferredHeader.classList.add('active-model');
                   }
                }
             });
          }

          // Run immediately on load
          try {
             document.querySelectorAll('.models-container').forEach(container => {
                container.originalOrder = Array.from(container.children);
             });
             applyActiveModels();
          } catch (err) {
             console.error("Error on load:", err);
          }

          let pendingModelKey = null;

          function selectModel(element, email, modelKey) {
             if (pendingModelKey) return;
             pendingModelKey = modelKey;
             
             element.style.opacity = '0.5';
             element.style.pointerEvents = 'none';
             
             sendMessage('switchModel', email, modelKey);
             
             // Fallback timeout in case of no response
             setTimeout(() => {
                if (pendingModelKey === modelKey) {
                   pendingModelKey = null;
                   element.style.opacity = '1';
                   element.style.pointerEvents = 'auto';
                }
             }, 3000);
          }

          window.addEventListener('message', event => {
             const message = event.data;
             if (message.command === 'modelSwitched') {
                const email = message.email;
                const modelKey = message.modelKey;
                pendingModelKey = null;
                
                state.activeModels[email] = modelKey;
                vscode.setState(state);
                applyActiveModels();
                
                document.querySelectorAll('.model-card').forEach(c => {
                   c.style.opacity = '1';
                   c.style.pointerEvents = 'auto';
                });
             } else if (message.command === 'accountSwitchCancelled') {
                const card = document.querySelector('.account-card[data-email="' + message.email + '"]');
                const btn = card ? card.querySelector('.btn-primary') : null;
                if (btn) {
                   if (btn.dataset.timeoutId) {
                      clearTimeout(parseInt(btn.dataset.timeoutId, 10));
                      delete btn.dataset.timeoutId;
                   }
                   btn.disabled = false;
                   btn.innerText = btn.dataset.originalText || '${i18n.t('accounts.activate')}';
                   btn.style.opacity = '';
                   btn.style.cursor = '';
                 }
              }
           });

          // ── Dropdown Menu ──
          function toggleMenu(e) {
            e.stopPropagation();
            const menu = document.getElementById('dropdownMenu');
            menu.classList.toggle('show');
          }
          document.addEventListener('click', () => {
            const m = document.getElementById('dropdownMenu');
            if (m) m.classList.remove('show');
          });

          function handleMenuAction(action) {
            try {
              const m = document.getElementById('dropdownMenu');
              if (m) m.classList.remove('show');
              if (action === 'export') {
                sendMessage('exportAccounts');
              } else if (action === 'import') {
                sendMessage('importAccounts');
              } else if (action === 'settings') {
                openSettings();
              }
            } catch (err) {
              alert("Error in handleMenuAction: " + err.message + "\\nStack:\\n" + err.stack);
            }
          }

          // ── Settings Modal ──
          let _previousIntervalValue = String(currentRefreshInterval);

          function onAutoRefreshToggle() {
            const toggle = document.getElementById('autoRefreshToggle');
            const intervalGroup = document.getElementById('refreshIntervalGroup');
            const slider = document.getElementById('autoRefreshSlider');
            const track = document.getElementById('autoRefreshTrack');
            if (toggle.checked) {
              intervalGroup.style.opacity = '1';
              intervalGroup.style.pointerEvents = 'auto';
              slider.style[isRtlDir ? 'right' : 'left'] = '20px';
              track.style.background = '#4caf50';
              track.style.boxShadow = '0 0 6px rgba(76,175,80,0.4)';
            } else {
              intervalGroup.style.opacity = '0.4';
              intervalGroup.style.pointerEvents = 'none';
              slider.style[isRtlDir ? 'right' : 'left'] = '2px';
              track.style.background = 'var(--glass-border)';
              track.style.boxShadow = 'none';
            }
          }

          function onAutoRotateToggle() {
            const toggle = document.getElementById('autoRotateToggle');
            const slider = document.getElementById('autoRotateSlider');
            const track = document.getElementById('autoRotateTrack');
            if (toggle.checked) {
              slider.style[isRtlDir ? 'right' : 'left'] = '20px';
              track.style.background = '#4caf50';
              track.style.boxShadow = '0 0 6px rgba(76,175,80,0.4)';
            } else {
              slider.style[isRtlDir ? 'right' : 'left'] = '2px';
              track.style.background = 'var(--glass-border)';
              track.style.boxShadow = 'none';
            }
          }

          function onLowCreditNotificationsToggle() {
            const toggle = document.getElementById('lowCreditNotificationsToggle');
            const slider = document.getElementById('lowCreditNotificationsSlider');
            const track = document.getElementById('lowCreditNotificationsTrack');
            if (toggle.checked) {
              slider.style[isRtlDir ? 'right' : 'left'] = '20px';
              track.style.background = '#4caf50';
              track.style.boxShadow = '0 0 6px rgba(76,175,80,0.4)';
            } else {
              slider.style[isRtlDir ? 'right' : 'left'] = '2px';
              track.style.background = 'var(--glass-border)';
              track.style.boxShadow = 'none';
            }
          }

          function onAutoCaptureToggle() {
            const toggle = document.getElementById('autoCaptureToggle');
            const slider = document.getElementById('autoCaptureSlider');
            const track = document.getElementById('autoCaptureTrack');
            if (!toggle) return;
            if (toggle.checked) {
              slider.style[isRtlDir ? 'right' : 'left'] = '20px';
              track.style.background = '#4caf50';
              track.style.boxShadow = '0 0 6px rgba(76,175,80,0.4)';
            } else {
              slider.style[isRtlDir ? 'right' : 'left'] = '2px';
              track.style.background = 'var(--glass-border)';
              track.style.boxShadow = 'none';
            }
          }

          function onAdaptivePollingToggle() {
            const toggle = document.getElementById('adaptivePollingToggle');
            const slider = document.getElementById('adaptivePollingSlider');
            const track = document.getElementById('adaptivePollingTrack');
            if (!toggle) return;
            if (toggle.checked) {
              slider.style[isRtlDir ? 'right' : 'left'] = '20px';
              track.style.background = '#4caf50';
              track.style.boxShadow = '0 0 6px rgba(76,175,80,0.4)';
            } else {
              slider.style[isRtlDir ? 'right' : 'left'] = '2px';
              track.style.background = 'var(--glass-border)';
              track.style.boxShadow = 'none';
            }
          }

          function onAutoResumeChatToggle() {
            const toggle = document.getElementById('autoResumeChatToggle');
            const slider = document.getElementById('autoResumeChatSlider');
            const track = document.getElementById('autoResumeChatTrack');
            const promptGroup = document.getElementById('autoResumePromptGroup');
            if (!toggle) return;
            if (toggle.checked) {
              slider.style[isRtlDir ? 'right' : 'left'] = '20px';
              track.style.background = '#4caf50';
              track.style.boxShadow = '0 0 6px rgba(76,175,80,0.4)';
              if (promptGroup) {
                promptGroup.style.opacity = '1';
                promptGroup.style.pointerEvents = 'auto';
              }
            } else {
              slider.style[isRtlDir ? 'right' : 'left'] = '2px';
              track.style.background = 'var(--glass-border)';
              track.style.boxShadow = 'none';
              if (promptGroup) {
                promptGroup.style.opacity = '0.4';
                promptGroup.style.pointerEvents = 'none';
              }
            }
          }

          function onConfirmOnSwitchToggle() {
            const toggle = document.getElementById('confirmOnSwitchToggle');
            const slider = document.getElementById('confirmOnSwitchSlider');
            const track = document.getElementById('confirmOnSwitchTrack');
            if (!toggle) return;
            if (toggle.checked) {
              slider.style[isRtlDir ? 'right' : 'left'] = '20px';
              track.style.background = '#4caf50';
              track.style.boxShadow = '0 0 6px rgba(76,175,80,0.4)';
            } else {
              slider.style[isRtlDir ? 'right' : 'left'] = '2px';
              track.style.background = 'var(--glass-border)';
              track.style.boxShadow = 'none';
            }
          }

          function onShowNotificationsToggle() {
            const toggle = document.getElementById('showNotificationsToggle');
            const slider = document.getElementById('showNotificationsSlider');
            const track = document.getElementById('showNotificationsTrack');
            if (!toggle) return;
            if (toggle.checked) {
              slider.style[isRtlDir ? 'right' : 'left'] = '20px';
              track.style.background = '#4caf50';
              track.style.boxShadow = '0 0 6px rgba(76,175,80,0.4)';
            } else {
              slider.style[isRtlDir ? 'right' : 'left'] = '2px';
              track.style.background = 'var(--glass-border)';
              track.style.boxShadow = 'none';
            }
          }

          function onIntervalChange() {
            const select = document.getElementById('refreshIntervalSelect');
            if (select.value === '0') {
              // Show confirmation dialog for immediate mode
              document.getElementById('immediateConfirmOverlay').style.display = 'flex';
            } else {
              _previousIntervalValue = select.value;
            }
          }

          function confirmImmediateMode() {
            document.getElementById('immediateConfirmOverlay').style.display = 'none';
            _previousIntervalValue = '0';
          }

          function cancelImmediateMode() {
            document.getElementById('immediateConfirmOverlay').style.display = 'none';
            const select = document.getElementById('refreshIntervalSelect');
            select.value = _previousIntervalValue;
          }

          // Attach change listener to interval dropdown after settings open
          function attachIntervalListener() {
            const select = document.getElementById('refreshIntervalSelect');
            if (select && !select._listenerAttached) {
              select.addEventListener('change', onIntervalChange);
              select._listenerAttached = true;
            }
          }

          function openSettings() {
            try {
              const modal = document.getElementById('settingsModal');
              const select = document.getElementById('preferredModelSelect');
              const helpText = document.getElementById('settingsHelpText');
              
              // Sync theme and language dropdowns
              const themeSelect = document.getElementById('themeSelect');
              if (themeSelect) {
                themeSelect.value = currentTheme;
              }
              const langSelect = document.getElementById('languageSelect');
              if (langSelect) {
                langSelect.value = currentLanguage;
              }

              // Populate preferred model options
              select.innerHTML = '<option value="">${i18n.t('webview.noSelectionDefault')}</option>';
            
            if (!hasAccounts || availableModelKeys.length === 0) {
              select.disabled = true;
              helpText.innerText = "${i18n.t('webview.loginRequired')}";
              helpText.style.color = "var(--vscode-errorForeground)";
            } else {
              select.disabled = false;
              helpText.innerText = "${i18n.t('webview.sortExplanation')}";
              helpText.style.color = "";
              
              availableModelKeys.forEach(key => {
                const option = document.createElement('option');
                option.value = key;
                option.innerText = key;
                if (key === currentPreferredModel) {
                  option.selected = true;
                }
                select.appendChild(option);
              });
            }
            
            // Reset interval dropdown to current value
            const intervalSelect = document.getElementById('refreshIntervalSelect');
            if (intervalSelect) {
              intervalSelect.value = String(currentRefreshInterval);
              _previousIntervalValue = String(currentRefreshInterval);
            }

            const autoRefreshToggle = document.getElementById('autoRefreshToggle');
            if (autoRefreshToggle) {
              autoRefreshToggle.checked = currentAutoRefresh;
              onAutoRefreshToggle();
            }

            const autoRotateToggle = document.getElementById('autoRotateToggle');
            if (autoRotateToggle) {
              autoRotateToggle.checked = currentAutoRotate;
              onAutoRotateToggle();
            }

            const lowCreditNotificationsToggle = document.getElementById('lowCreditNotificationsToggle');
            if (lowCreditNotificationsToggle) {
              lowCreditNotificationsToggle.checked = currentLowCreditNotifications;
              onLowCreditNotificationsToggle();
            }

            // Reset sort-by and cache-duration to current values
            const sortBySettingsSelect = document.getElementById('sortBySettingsSelect');
            if (sortBySettingsSelect) {
              sortBySettingsSelect.value = currentSortBy;
            }
            const cacheDurationSelect = document.getElementById('cacheDurationSelect');
            if (cacheDurationSelect) {
              cacheDurationSelect.value = String(currentCacheDurationDays);
            }

            const autoCaptureToggle = document.getElementById('autoCaptureToggle');
            if (autoCaptureToggle) {
              autoCaptureToggle.checked = currentAutoCapture;
              onAutoCaptureToggle();
            }

            const adaptivePollingToggle = document.getElementById('adaptivePollingToggle');
            if (adaptivePollingToggle) {
              adaptivePollingToggle.checked = currentAdaptivePolling;
              onAdaptivePollingToggle();
            }

            const autoResumeChatToggle = document.getElementById('autoResumeChatToggle');
            if (autoResumeChatToggle) {
              autoResumeChatToggle.checked = currentAutoResumeChat;
              onAutoResumeChatToggle();
            }

            const autoResumePromptInput = document.getElementById('autoResumePromptInput');
            if (autoResumePromptInput) {
              autoResumePromptInput.value = currentAutoResumePrompt || 'continua';
            }

            const noticeDurationSelect = document.getElementById('noticeDurationSelect');
            if (noticeDurationSelect) {
              noticeDurationSelect.value = String(currentNoticeDuration);
            }

            const confirmOnSwitchToggle = document.getElementById('confirmOnSwitchToggle');
            if (confirmOnSwitchToggle) {
              confirmOnSwitchToggle.checked = currentConfirmOnSwitch;
              onConfirmOnSwitchToggle();
            }

            const showNotificationsToggle = document.getElementById('showNotificationsToggle');
            if (showNotificationsToggle) {
              showNotificationsToggle.checked = currentShowNotifications;
              onShowNotificationsToggle();
            }

            modal.style.display = 'flex';
            vscode.postMessage({ command: 'settingsOpened' });
            resetSettingsInactivityTimer();
            if (!modal._activityListenersAttached) {
              const resetTimer = () => resetSettingsInactivityTimer();
              modal.addEventListener('mousemove', resetTimer);
              modal.addEventListener('keydown', resetTimer);
              modal.addEventListener('click', resetTimer);
              modal._activityListenersAttached = true;
            }
            attachIntervalListener();
            } catch (err) {
              alert("Error in openSettings: " + err.message + "\\nStack:\\n" + err.stack);
            }
          }

          function closeSettingsModalOnly() {
            if (settingsInactivityTimer) {
              clearTimeout(settingsInactivityTimer);
              settingsInactivityTimer = null;
            }
            document.getElementById('settingsModal').style.display = 'none';
            document.getElementById('immediateConfirmOverlay').style.display = 'none';
            vscode.postMessage({ command: 'settingsClosed' });
          }

          function closeSettings() {
            closeSettingsModalOnly();
            // Revert live preview back to current active theme if user cancelled
            applyLiveTheme(currentTheme);
            const themeSelect = document.getElementById('themeSelect');
            if (themeSelect) themeSelect.value = currentTheme;
          }

          function saveSettings() {
            try {
              const themeSelect = document.getElementById('themeSelect');
              const selectedTheme = themeSelect ? themeSelect.value : 'dark-purple';
              currentTheme = selectedTheme;
              applyLiveTheme(selectedTheme);

              const select = document.getElementById('preferredModelSelect');
              const selectedModel = select ? select.value : '';
              const langSelect = document.getElementById('languageSelect');
              const selectedLang = langSelect ? langSelect.value : 'auto';
              const autoRefreshToggle = document.getElementById('autoRefreshToggle');
              const autoRefreshEnabled = autoRefreshToggle ? autoRefreshToggle.checked : true;
              const autoRotateToggle = document.getElementById('autoRotateToggle');
              const autoRotateEnabled = autoRotateToggle ? autoRotateToggle.checked : false;
              const lowCreditNotificationsToggle = document.getElementById('lowCreditNotificationsToggle');
              const lowCreditNotificationsEnabled = lowCreditNotificationsToggle ? lowCreditNotificationsToggle.checked : true;
              const intervalSelect = document.getElementById('refreshIntervalSelect');
              const refreshInterval = intervalSelect ? (parseInt(intervalSelect.value, 10) || 0) : 15;
              
              const sortBySettingsSelect = document.getElementById('sortBySettingsSelect');
              const selectedSortBy = sortBySettingsSelect ? sortBySettingsSelect.value : 'default';
              const cacheDurationSelect = document.getElementById('cacheDurationSelect');
              const selectedCacheDuration = cacheDurationSelect ? (parseInt(cacheDurationSelect.value, 10) || 7) : 7;

              const autoCaptureToggle = document.getElementById('autoCaptureToggle');
              const autoCaptureEnabled = autoCaptureToggle ? autoCaptureToggle.checked : true;

              const adaptivePollingToggle = document.getElementById('adaptivePollingToggle');
              const adaptivePollingEnabled = adaptivePollingToggle ? adaptivePollingToggle.checked : true;

              const autoResumeChatToggle = document.getElementById('autoResumeChatToggle');
              const autoResumeChatEnabled = autoResumeChatToggle ? autoResumeChatToggle.checked : true;

              const autoResumePromptInput = document.getElementById('autoResumePromptInput');
              const autoResumePrompt = autoResumePromptInput ? (autoResumePromptInput.value.trim() || 'continua') : 'continua';

              const noticeDurationSelect = document.getElementById('noticeDurationSelect');
              const noticeDuration = noticeDurationSelect ? (parseInt(noticeDurationSelect.value, 10) || 0) : 0;

              const confirmOnSwitchToggle = document.getElementById('confirmOnSwitchToggle');
              const confirmOnSwitch = confirmOnSwitchToggle ? confirmOnSwitchToggle.checked : false;

              const showNotificationsToggle = document.getElementById('showNotificationsToggle');
              const showNotificationsEnabled = showNotificationsToggle ? showNotificationsToggle.checked : false;

              currentLanguage = selectedLang;
              currentPreferredModel = selectedModel;
              currentAutoRefresh = autoRefreshEnabled;
              currentAutoRotate = autoRotateEnabled;
              currentLowCreditNotifications = lowCreditNotificationsEnabled;
              currentRefreshInterval = refreshInterval;
              currentSortBy = selectedSortBy;
              currentCacheDurationDays = selectedCacheDuration;
              currentAutoCapture = autoCaptureEnabled;
              currentAdaptivePolling = adaptivePollingEnabled;
              currentAutoResumeChat = autoResumeChatEnabled;
              currentAutoResumePrompt = autoResumePrompt;
              currentNoticeDuration = noticeDuration;
              currentConfirmOnSwitch = confirmOnSwitch;
              currentShowNotifications = showNotificationsEnabled;

              closeSettingsModalOnly();
              vscode.postMessage({ command: 'showLoading' });

              vscode.postMessage({
                command: 'saveSettings',
                theme: selectedTheme,
                language: selectedLang,
                preferredModel: selectedModel,
                autoRefreshEnabled: autoRefreshEnabled,
                autoRotateEnabled: autoRotateEnabled,
                lowCreditNotificationsEnabled: lowCreditNotificationsEnabled,
                refreshIntervalMinutes: refreshInterval,
                sortBy: selectedSortBy,
                cacheDurationDays: selectedCacheDuration,
                autoCaptureAccounts: autoCaptureEnabled,
                adaptiveQuotaPolling: adaptivePollingEnabled,
                autoResumeChat: autoResumeChatEnabled,
                autoResumePrompt: autoResumePrompt,
                noticeDurationSeconds: noticeDuration,
                confirmOnSwitch: confirmOnSwitch,
                showNotifications: showNotificationsEnabled
              });
            } catch (err) {
              console.error('Error in saveSettings:', err);
              vscode.postMessage({ command: 'logError', message: 'Error in saveSettings: ' + err.message, stack: err.stack });
            }
          }
          
          // Modify sendMessage to handle additional payload if needed
          function sendMessage(command, email = null, modelKey = null) {
            vscode.postMessage({ command, email, modelKey });
          }

          function openLeaksModal() {
            const m = document.getElementById('leaksModal');
            if (m) m.style.display = 'flex';
          }

          function closeLeaksModal() {
            const m = document.getElementById('leaksModal');
            if (m) m.style.display = 'none';
          }

          function startEditAlias(email) {
            const safeId = email.replace(/[@.]/g, '-');
            const displayEl = document.getElementById('name-display-' + safeId);
            const inputEl = document.getElementById('name-input-' + safeId);
            const editBtn = document.getElementById('edit-btn-' + safeId);
            const refreshBtn = document.getElementById('refresh-btn-' + safeId);
            
            if (displayEl && inputEl && editBtn) {
              vscode.postMessage({ command: 'aliasEditingStarted', email });
              displayEl.style.display = 'none';
              editBtn.style.display = 'none';
              if (refreshBtn) refreshBtn.style.display = 'none';
              inputEl.style.display = 'inline-block';
              inputEl.focus();
              inputEl.select();
            }
          }

          function cancelEditAlias(email) {
            vscode.postMessage({ command: 'aliasEditingFinished', email });
            const safeId = email.replace(/[@.]/g, '-');
            const displayEl = document.getElementById('name-display-' + safeId);
            const inputEl = document.getElementById('name-input-' + safeId);
            const editBtn = document.getElementById('edit-btn-' + safeId);
            const refreshBtn = document.getElementById('refresh-btn-' + safeId);
            
            if (displayEl && inputEl && editBtn) {
              inputEl.style.display = 'none';
              displayEl.style.display = 'block';
              editBtn.style.display = 'inline-block';
              if (refreshBtn) refreshBtn.style.display = 'inline-block';
              const card = document.querySelector('.account-card[data-email="' + email + '"]');
              if (card) {
                inputEl.value = card.getAttribute('data-alias') || '';
              }
            }
          }

          function saveAlias(email) {
            vscode.postMessage({ command: 'aliasEditingFinished', email });
            const safeId = email.replace(/[@.]/g, '-');
            const displayEl = document.getElementById('name-display-' + safeId);
            const inputEl = document.getElementById('name-input-' + safeId);
            const editBtn = document.getElementById('edit-btn-' + safeId);
            const refreshBtn = document.getElementById('refresh-btn-' + safeId);
            
            if (inputEl && inputEl.style.display !== 'none') {
              const newValue = inputEl.value.trim();
              
              inputEl.style.display = 'none';
              if (displayEl) displayEl.style.display = 'block';
              if (editBtn) editBtn.style.display = 'inline-block';
              if (refreshBtn) refreshBtn.style.display = 'inline-block';
              
              vscode.postMessage({
                command: 'updateAlias',
                email: email,
                alias: newValue
              });
            }
          }

          function handleAliasKey(event, email) {
            if (event.key === 'Enter') {
              event.preventDefault();
              saveAlias(email);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              cancelEditAlias(email);
            }
          }



          // ── Progressive refresh messages ──
          function setActionsDisabled(disabled) {
            const body = document.body;
            if (disabled) {
              body.classList.add('actions-disabled');
            } else {
              body.classList.remove('actions-disabled');
            }
            // Toggle cancel button visibility
            const cancelBtn = document.getElementById('cancelRefreshBtn');
            if (cancelBtn) cancelBtn.style.display = disabled ? 'inline-flex' : 'none';
            // Toggle refresh button visibility (hide when refreshing)
            const refreshBtn = document.getElementById('refreshBtn');
            if (refreshBtn) refreshBtn.style.display = disabled ? 'none' : 'inline-flex';
          }

          // ── Progress Banner Management ──
          let refreshToastTimeout = null;
          let antiBanTimer = null;

          function clearAntiBanTimer() {
            if (antiBanTimer) {
              clearInterval(antiBanTimer);
              antiBanTimer = null;
            }
          }

          function showProgressBanner(totalAccounts = 0) {
            clearAntiBanTimer();
            // Clear any existing toast
            const toast = document.getElementById('refreshToast');
            if (toast) { toast.classList.remove('visible'); }
            if (refreshToastTimeout) { clearTimeout(refreshToastTimeout); refreshToastTimeout = null; }
            
            const dot = document.getElementById('refreshPulseDot');
            if (dot) {
              dot.className = 'refresh-pulse-glow';
            }

            // Initialize count and percentage display
            const countEl = document.getElementById('refreshProgressCount');
            if (countEl) countEl.textContent = '0 / ' + totalAccounts;

            const percentEl = document.getElementById('refreshProgressPercent');
            if (percentEl) percentEl.textContent = '0%';

            const barEl = document.getElementById('refreshProgressBar');
            if (barEl) barEl.style.width = '2%'; // Initial visual activity cue

            const emailEl = document.getElementById('refreshProgressEmail');
            if (emailEl) {
              emailEl.innerHTML = '<span class="refresh-status-badge">Iniciando</span> <span class="refresh-status-text">Preparando escaneo seguro de cuentas...</span>';
            }
            
            const banner = document.getElementById('refreshProgressBanner');
            if (banner) banner.classList.add('visible');
          }

          function updateProgressBanner(email, currentIndex, totalAccounts) {
            clearAntiBanTimer();
            const emailEl = document.getElementById('refreshProgressEmail');
            const percentEl = document.getElementById('refreshProgressPercent');
            const countEl = document.getElementById('refreshProgressCount');
            const barEl = document.getElementById('refreshProgressBar');
            const dot = document.getElementById('refreshPulseDot');
            
            if (dot) {
              dot.className = 'refresh-pulse-glow';
            }

            const rawPercent = totalAccounts > 0 ? Math.round((currentIndex / totalAccounts) * 100) : 0;
            const visualWidth = Math.max(rawPercent === 0 ? 0 : 2, rawPercent);
            
            if (emailEl) {
              emailEl.innerHTML = '<span class="refresh-status-badge scanning">${i18n.t('accounts.refreshingAccount')}</span> <span class="refresh-email-highlight">' + email + '</span>';
            }
            if (percentEl) percentEl.textContent = rawPercent + '%';
            if (countEl) countEl.textContent = currentIndex + ' / ' + totalAccounts;
            if (barEl) barEl.style.width = visualWidth + '%';
          }

          function showAntiBanWait(seconds, nextEmail, currentIndex, totalAccounts) {
            clearAntiBanTimer();
            const emailEl = document.getElementById('refreshProgressEmail');
            const dot = document.getElementById('refreshPulseDot');
            if (dot) {
              dot.className = 'refresh-pulse-glow paused';
            }
            let remaining = seconds;
            const updateWaitText = () => {
              if (emailEl) {
                const nextTxt = nextEmail ? ' · Siguiente: <span class="refresh-email-highlight">' + nextEmail + '</span>' : '';
                emailEl.innerHTML = '<span class="refresh-status-badge paused">Protección</span> <span class="refresh-status-text">Pausa anti-ban (' + remaining + 's)' + nextTxt + '</span>';
              }
            };
            updateWaitText();
            antiBanTimer = setInterval(() => {
              remaining--;
              if (remaining <= 0) {
                clearAntiBanTimer();
                if (emailEl && nextEmail) {
                  emailEl.innerHTML = '<span class="refresh-status-badge scanning">${i18n.t('accounts.refreshingAccount')}</span> <span class="refresh-email-highlight">' + nextEmail + '</span>';
                }
              } else {
                updateWaitText();
              }
            }, 1000);
          }

          function hideProgressBanner(wasCancelled) {
            clearAntiBanTimer();
            const banner = document.getElementById('refreshProgressBanner');
            if (banner) banner.classList.remove('visible');

            // Show success toast only if not cancelled
            if (!wasCancelled) {
              const toast = document.getElementById('refreshToast');
              if (toast) {
                toast.textContent = '${i18n.t('accounts.refreshSuccess')}';
                toast.classList.add('visible');
                refreshToastTimeout = setTimeout(() => {
                  toast.classList.remove('visible');
                  refreshToastTimeout = null;
                }, 4000);
              }
            }
          }

          window.addEventListener('message', event => {
            const msg = event.data;

            if (msg.command === 'refreshStarted') {
              isRefreshing = true;
              setActionsDisabled(true);
              setSearchDisabled(true);
              showProgressBanner(msg.totalAccounts);

            } else if (msg.command === 'accountRefreshStart') {
              updateProgressBanner(msg.email, msg.currentIndex, msg.totalAccounts);
              const targetEmail = (msg.email || '').toLowerCase();
              let card = document.querySelector('.account-card[data-email="' + msg.email + '" i]');
              if (!card && targetEmail) {
                card = Array.from(document.querySelectorAll('.account-card')).find(c => (c.dataset.email || '').toLowerCase() === targetEmail);
              }
              if (card) {
                card.classList.add('refreshing');
              }

            } else if (msg.command === 'accountAntiBanWait') {
              showAntiBanWait(msg.seconds, msg.nextEmail, msg.currentIndex, msg.totalAccounts);

            } else if (msg.command === 'accountRefreshDone') {
              const targetEmail = (msg.email || '').toLowerCase();
              let oldCard = document.querySelector('.account-card[data-email="' + msg.email + '" i]');
              if (!oldCard && targetEmail) {
                oldCard = Array.from(document.querySelectorAll('.account-card')).find(c => (c.dataset.email || '').toLowerCase() === targetEmail);
              }
              if (oldCard && msg.html) {
                const parser = new DOMParser();
                const doc = parser.parseFromString(msg.html, 'text/html');
                const newCard = doc.querySelector('.account-card');
                
                if (newCard) {
                  // Preserve collapse expanded state
                  const oldWrapper = oldCard.querySelector('.collapsible-wrapper');
                  const newWrapper = newCard.querySelector('.collapsible-wrapper');
                  if (oldWrapper && newWrapper && oldWrapper.classList.contains('expanded')) {
                    newWrapper.classList.add('expanded');
                  }
                  
                  const oldHeader = oldCard.querySelector('.collapse-header');
                  const newHeader = newCard.querySelector('.collapse-header');
                  if (oldHeader && newHeader && oldHeader.classList.contains('expanded')) {
                    newHeader.classList.add('expanded');
                  }

                  // Replace oldCard with newCard in the DOM
                  oldCard.replaceWith(newCard);
                  
                  // Initialize the model container's originalOrder on the new card
                  const container = newCard.querySelector('.models-container');
                  if (container) {
                    container.originalOrder = Array.from(container.children);
                  }
                  
                  // Apply active model styling to the new card
                  const email = newCard.dataset.email;
                  const activeModelKey = state.activeModels[email];
                  if (activeModelKey && container) {
                    container.innerHTML = '';
                    container.originalOrder.forEach(el => {
                       el.classList.remove('active-model');
                       container.appendChild(el);
                    });
                    
                    const preferredHeader = newCard.querySelector('.preferred-model-card');
                    if (preferredHeader) {
                       preferredHeader.classList.remove('active-model');
                    }
                    
                    const targetModel = container.querySelector('.model-card[data-model-key="' + activeModelKey + '"]');
                    if (targetModel) {
                       container.prepend(targetModel);
                       targetModel.classList.add('active-model');
                    } else if (preferredHeader && preferredHeader.dataset.modelKey === activeModelKey) {
                       preferredHeader.classList.add('active-model');
                    }
                  }

                  // Re-apply workflow and search filters to preserve active view
                  applyWorkflowFilter(currentWorkflowFilter);
                  const sInput = document.getElementById('searchInput');
                  if (sInput && sInput.value.trim()) {
                    applySearchFilter(sInput.value);
                  }
                }
              }

            } else if (msg.command === 'refreshFinished') {
              clearAntiBanTimer();
              isRefreshing = false;
              setActionsDisabled(false);
              setSearchDisabled(false);
              const rBtn = document.getElementById('refreshBtn');
              if (rBtn) rBtn.classList.remove('spinning');
              const sBtn = document.querySelector('.toolbar-scan');
              if (sBtn) sBtn.classList.remove('loading');
              document.querySelectorAll('.btn-card-refresh.spinning').forEach(b => b.classList.remove('spinning'));
              // Dismiss cancel dialog if still open (refresh finished naturally)
              dismissCancelConfirm();
              hideProgressBanner(!!msg.wasCancelled);
              // Remove refreshing class from all cards
              document.querySelectorAll('.account-card').forEach(c => {
                c.classList.remove('refreshing');
              });

            } else if (msg.command === 'showLoading') {
              const overlay = document.getElementById('loadingOverlay');
              const text = document.getElementById('loadingText');
              if (overlay) overlay.style.display = 'flex';
              if (text && msg.text) text.innerText = msg.text;

            } else if (msg.command === 'hideLoading') {
              const overlay = document.getElementById('loadingOverlay');
              if (overlay) overlay.style.display = 'none';

            } else if (msg.command === 'settingsSavedToast') {
              const toast = document.getElementById('refreshToast');
              if (toast) {
                toast.textContent = '${i18n.t('settings.saved')}';
                toast.classList.add('visible');
                if (refreshToastTimeout) { clearTimeout(refreshToastTimeout); }
                refreshToastTimeout = setTimeout(() => {
                  toast.classList.remove('visible');
                  refreshToastTimeout = null;
                }, 4000);
              }
            }
          });
        </script>

  `;
}
