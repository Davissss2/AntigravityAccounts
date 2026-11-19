/**
 * Account Card Template
 * Renders individual account cards, model quotas, countdown badges, and action buttons.
 */

import { I18nService } from '../../../i18n';
import { AccountStatus } from '../../../core/domain/models/account.model';
import { getFriendlyModelName, normalizeModelKey, getModelBalanceEntry } from '../../../core/utils/model.utils';

  export function renderAccountCardHtml(acc: any, effectivePreferred: string, workflows: any[]): string {
    const i18n = I18nService.getInstance();
    const displayName = acc.alias || acc.name || acc.displayName || acc.email;
    
    const formatTime = (resetTimeStr?: string) => {
       if (!resetTimeStr) return i18n.t('webview.unspecified');
       const date = new Date(resetTimeStr);
       const diffMs = date.getTime() - Date.now();
       if (diffMs <= 0) return i18n.t('webview.availableNow');
       
       const totalHours = Math.floor(diffMs / (1000 * 60 * 60));
       const mins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
       
       if (totalHours >= 24) {
         const days = Math.floor(totalHours / 24);
         const remainingHours = totalHours % 24;
         if (remainingHours === 0) {
           return i18n.t('webview.renewsInDaysMins', { days, mins });
         }
         return i18n.t('webview.renewsInDaysHoursMins', { days, hours: remainingHours, mins });
       }
       if (totalHours === 0 && mins === 0) {
         return '<1m';
       }
       
       return i18n.t('webview.renewsInHoursMins', { hours: totalHours, mins });
    };

    // Process balances according to display rules
    let processedModels: Array<{ key: string, value: number, resetTime?: string }> = [];
    let creditBalances: Array<{ key: string, value: number }> = [];
    
    if (acc.balances) {
      // ── Collect all model entries, separate credits from models ──
      const allModelEntries: Array<{ key: string, lowerKey: string, value: number, resetTime?: string }> = [];

      for (const [k, rawV] of Object.entries(acc.balances)) {
        if (!k) continue;
        const lowerKey = k.toLowerCase();
        
        let value: number;
        let resetTime: string | undefined;
        
        if (typeof rawV === 'object' && rawV !== null && 'value' in rawV) {
           const obj = rawV as any;
           value = typeof obj.value === 'number' ? obj.value : Number(obj.value);
           resetTime = obj.resetTime;
        } else {
           value = typeof rawV === 'number' ? rawV : Number(rawV);
           if (value > 0) {
             creditBalances.push({ key: k, value });
           }
           continue;
        }

        allModelEntries.push({ key: k, lowerKey, value, resetTime });
      }

      // ── Phase 1 (FIRST exclusion): Remove models by prefix ──
      const afterPrefixFilter = allModelEntries.filter(m => {
        return !m.lowerKey.startsWith('chat')
            && !m.lowerKey.startsWith('tap')
            && !m.lowerKey.startsWith('tab');
      });

      // ── Phase 2: Exclude gemini-2.5 ──
      const afterGeminiFilter = afterPrefixFilter.filter(m => !m.lowerKey.includes('gemini-2.5'));

      // ── Phase 3: Unconditional exclusion of "lite" models ──
      const afterLiteFilter = afterGeminiFilter.filter(m => !m.lowerKey.match(/[-_\s]?lite$/i));

      // ── Phase 4: Apply friendly names, filter out deprecated keys, and deduplicate by friendly name ──
      const friendlyModelMap = new Map<string, { key: string, value: number, resetTime?: string }>();
      for (const entry of afterLiteFilter) {
        const friendlyName = getFriendlyModelName(entry.key);
        if (friendlyName) {
          const existing = friendlyModelMap.get(friendlyName);
          if (!existing) {
            friendlyModelMap.set(friendlyName, { key: friendlyName, value: entry.value, resetTime: entry.resetTime });
          } else if (entry.key.includes('tiered') && !existing.key.includes('tiered')) {
            // Prioritize canonical 'tiered' model key over legacy alias
            friendlyModelMap.set(friendlyName, { key: friendlyName, value: entry.value, resetTime: entry.resetTime });
          }
        }
      }
      processedModels = Array.from(friendlyModelMap.values());
    }

    // Sort processedModels
    processedModels.sort((a, b) => {
       const aCritical = a.value < 20;
       const bCritical = b.value < 20;
       
       const timeA = a.resetTime ? new Date(a.resetTime).getTime() : 0;
       const timeB = b.resetTime ? new Date(b.resetTime).getTime() : 0;
       
       if (aCritical && !bCritical) return 1; // b is better (>= 20%), put a lower
       if (!aCritical && bCritical) return -1;
       
       if (aCritical && bCritical) {
          if (timeA && timeB && timeA !== timeB) return timeA - timeB;
          return a.value - b.value;
       }
       
       if (a.value !== b.value) return b.value - a.value;
       if (timeA && timeB) return timeA - timeB;
       return 0;
    });

    // Move preferred model to top of the list if set
    let preferredModelData: { key: string, value: number, resetTime?: string } | null = null;
    if (effectivePreferred) {
      const normalizedPref = normalizeModelKey(effectivePreferred).toLowerCase();
      let prefIdx = processedModels.findIndex(m =>
        normalizeModelKey(m.key).toLowerCase() === normalizedPref ||
        m.key.toLowerCase() === normalizedPref ||
        m.key.toLowerCase() === effectivePreferred.toLowerCase()
      );
      if (prefIdx === -1) {
        prefIdx = processedModels.findIndex(m => {
          const k = m.key.toLowerCase();
          const normK = normalizeModelKey(m.key).toLowerCase();
          return k.includes(normalizedPref) || normalizedPref.includes(k) ||
                 normK.includes(normalizedPref) || normalizedPref.includes(normK) ||
                 k.replace(/\s+/g, '') === normalizedPref.replace(/\s+/g, '');
        });
      }
      if (prefIdx > -1) {
        const [prefModel] = processedModels.splice(prefIdx, 1);
        preferredModelData = prefModel;
      } else {
        // Preferred model not in processedModels: check acc.balances directly
        const balanceEntry = getModelBalanceEntry(acc.balances, effectivePreferred);
        if (balanceEntry) {
          preferredModelData = balanceEntry;
        } else {
          preferredModelData = { key: effectivePreferred, value: 0 };
        }
      }
    } else if (processedModels.length > 0) {
      preferredModelData = processedModels[0];
    }

    // Determine the next reset time for countdown display in card header:
    // 1. If preferred model is set and has resetTime:
    //    - If depleted (< 100%), it takes top priority so the user tracks when their active model is ready.
    //    - If 100%, check if any other model is depleted (< 100%) and will recharge sooner.
    //    - If all models are 100%, preferred model's own resetTime is the canonical countdown for the card.
    let nextResetTime: string | undefined = undefined;
    const now = Date.now();

    // 1. Check if preferred model has a future resetTime
    if (preferredModelData && preferredModelData.resetTime) {
      const prefDate = new Date(preferredModelData.resetTime);
      const prefTime = prefDate.getTime();
      if (!isNaN(prefTime) && prefTime > now) {
        nextResetTime = preferredModelData.resetTime;
      }
    }

    // 2. If any depleted model (< 100%) recharges sooner, prioritize that earlier recharge countdown
    const depletedWithReset = processedModels.filter(m => m.resetTime && m.value < 100);
    for (const m of depletedWithReset) {
      const t = new Date(m.resetTime!).getTime();
      if (!isNaN(t) && t > now) {
        if (!nextResetTime || t < new Date(nextResetTime).getTime()) {
          nextResetTime = m.resetTime;
        }
      }
    }

    // 3. Fallback: find soonest future reset time among any processed model
    if (!nextResetTime) {
      let minDiffMs = Infinity;
      for (const m of processedModels) {
        if (m.resetTime) {
          const t = new Date(m.resetTime).getTime();
          if (!isNaN(t) && t > now) {
            const diffMs = t - now;
            if (diffMs < minDiffMs) {
              minDiffMs = diffMs;
              nextResetTime = m.resetTime;
            }
          }
        }
      }
    }

    const nextResetHtml = nextResetTime 
      ? `<div class="quota-countdown" style="font-size:0.75rem; color:var(--text-secondary); opacity:0.85; margin-top:3px; display:flex; align-items:center; gap:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%;" title="${formatTime(nextResetTime)}">
           <svg class="icon-svg" style="width:11px; height:11px; stroke-width:2.5; flex-shrink:0;" viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
           <span style="overflow:hidden; text-overflow:ellipsis;">${formatTime(nextResetTime)}</span>
         </div>`
      : '';

    // Generate Credits HTML
    const creditsHtml = creditBalances.length > 0 
      ? `<div class="credits-container">` + creditBalances.map(c => `
        <div class="credit-badge">
          <span class="credit-name">${c.key.replace(/_/g, ' ').toUpperCase()}</span>
          <span class="credit-value">${c.value.toLocaleString()}</span>
        </div>
      `).join('') + `</div>`
      : '';

    // Generate Models HTML
    const modelsHtml = processedModels.length > 0
      ? processedModels.map(m => {
          const displayKey = m.key.endsWith('image')
            ? `${m.key} <svg class="icon-svg icon-image" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`
            : m.key;
          const timeStr = formatTime(m.resetTime);
          
          let colorClass = 'bg-high';
          let alertIcon = '';
          
          if (m.value < 20) {
              colorClass = 'bg-low';
              alertIcon = ` <svg class="icon-svg icon-warning" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" title="${i18n.t('webview.veryLowBalance')}"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
          } else if (m.value < 32) {
              colorClass = 'bg-low';
          } else if (m.value < 60) {
              colorClass = 'bg-med';
          }

          return `
          <div class="model-card" data-model-key="${m.key}" onclick="selectModel(this, '${acc.email}', '${m.key}')" style="cursor: pointer;" title="${i18n.t('webview.selectThisModel')}">
            <div class="model-header">
              <span class="model-name">${displayKey}</span>
              <span class="model-reset">${timeStr}</span>
            </div>
            <div class="progress-bar-container">
              <div class="progress-bar ${colorClass}" style="width: ${m.value}%"></div>
            </div>
            <div class="model-percentage ${colorClass}-text">${m.value}%${alertIcon}</div>
          </div>
          `;
        }).join('')
      : `<div class="empty-models">${i18n.t('accounts.noAvailableModels')}</div>`;

    // Generate Collapse Header HTML
    let collapseHeaderHtml = '';
    const wrapperId = `collapse-${acc.email.replace(/[@.]/g, '-')}`;
    
    if (preferredModelData) {
       const displayKey = preferredModelData.key.endsWith('image')
         ? `${preferredModelData.key} <svg class="icon-svg icon-image" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`
         : preferredModelData.key;
       const timeStr = formatTime(preferredModelData.resetTime);
       
       let colorClass = 'bg-high';
       let alertIcon = '';
       
       if (preferredModelData.value < 20) {
           colorClass = 'bg-low';
           alertIcon = ` <svg class="icon-svg icon-warning" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" title="${i18n.t('webview.veryLowBalance')}"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
       } else if (preferredModelData.value < 32) {
           colorClass = 'bg-low';
       } else if (preferredModelData.value < 60) {
           colorClass = 'bg-med';
       }

       collapseHeaderHtml = `
       <div class="collapse-header unified-collapse" onclick="toggleModels(this, '${wrapperId}')" title="${i18n.t('webview.showAvailableModels')}">
          <span class="collapse-title">${i18n.t('accounts.models')}</span>
          <div class="collapse-header-right">
             <div class="pref-badge preferred-model-card" data-model-key="${preferredModelData.key}" onclick="event.stopPropagation(); selectModel(this, '${acc.email}', '${preferredModelData.key}')" title="${i18n.t('webview.activatePreferredModel')}">
               <span class="pref-badge-name">${displayKey}</span>
               <div class="pref-badge-bar"><div class="progress-bar ${colorClass}" style="width: ${preferredModelData.value}%"></div></div>
               <span class="pref-badge-val ${colorClass}-text">${preferredModelData.value}%${alertIcon}</span>
             </div>
             <svg class="chevron-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
          </div>
       </div>
       `;
    } else {
       collapseHeaderHtml = `
       <div class="collapse-header normal-collapse" onclick="toggleModels(this, '${wrapperId}')" title="${i18n.t('webview.showAvailableModels')}">
          <span class="collapse-title">${i18n.t('accounts.availableModels', { count: processedModels.length })}</span>
          <svg class="chevron-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
       </div>
       `;
    }

    const isExpired = acc.status === AccountStatus.TOKEN_EXPIRED;
    const isScopeMissing = acc.status === AccountStatus.SCOPE_MISSING;
    const activeBadge = acc.isActive
      ? `<div class="badge active-badge">${i18n.t('accounts.active')}</div>`
      : isExpired
        ? `<div class="badge expired-badge">${i18n.t('accounts.expired')}</div>`
        : isScopeMissing
          ? `<div class="badge scope-missing-badge">${i18n.t('accounts.status.scopeMissing')}</div>`
          : '';

    const expiredBannerHtml = isExpired ? `
      <div class="expired-banner">
        <span class="expired-banner-icon"><svg class="icon-svg icon-warning" style="width: 16px; height: 16px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></span>
        <span class="expired-banner-text">${i18n.t('accounts.expiredBanner')}</span>
      </div>
    ` : '';

    const scopeMissingBannerHtml = isScopeMissing ? `
      <div class="scope-missing-banner">
        <span class="scope-missing-banner-icon"><svg class="icon-svg icon-warning" style="width: 16px; height: 16px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></span>
        <span class="scope-missing-banner-text">${i18n.t('accounts.scopeMissingBanner')}</span>
      </div>
    ` : '';

    const cardBody = isExpired
      ? expiredBannerHtml
      : `
        ${scopeMissingBannerHtml}
        ${creditsHtml}
        
        <div class="models-section">
          ${collapseHeaderHtml}
          <div class="collapsible-wrapper" id="${wrapperId}">
            <div class="collapsible-inner">
              <div class="models-container">
                ${modelsHtml}
              </div>
            </div>
          </div>
        </div>
    `;

    let actionsHtml = '';
    if (isExpired) {
      actionsHtml = `
        <button class="btn btn-warning" onclick="sendMessage('reAuthenticate', '${acc.email}')">${i18n.t('accounts.reAuthenticate')}</button>
        <button class="btn btn-danger" onclick="sendMessage('deleteAccount', '${acc.email}')">${i18n.t('accounts.remove')}</button>
      `;
    } else if (isScopeMissing) {
      // In-place repair: re-consent grants the agent scope without deleting the card.
      actionsHtml = `
        <button class="btn btn-warning" onclick="sendMessage('reAuthenticate', '${acc.email}')">${i18n.t('accounts.reAuthorize')}</button>
        <button class="btn btn-danger" onclick="sendMessage('deleteAccount', '${acc.email}')">${i18n.t('accounts.remove')}</button>
      `;
    } else {
      actionsHtml = `
        ${!acc.isActive ? `<button class="btn btn-primary btn-activate" onclick="handleSwitchAccount(this, '${acc.email}')">${i18n.t('accounts.activate')}</button>` : ''}
        <button class="btn btn-danger" onclick="sendMessage('deleteAccount', '${acc.email}')">${i18n.t('accounts.remove')}</button>
      `;
    }

    const avatarClass = isExpired || isScopeMissing ? 'avatar-expired' : '';
    const safeEmailId = acc.email.replace(/[@.]/g, '-');

    const modelBalancesMap: Record<string, number> = {};
    if (processedModels) {
      processedModels.forEach(m => {
        modelBalancesMap[m.key.toLowerCase()] = m.value;
      });
    }
    if (preferredModelData) {
      modelBalancesMap[preferredModelData.key.toLowerCase()] = preferredModelData.value;
    }
    const modelBalancesStr = JSON.stringify(modelBalancesMap).replace(/'/g, '&apos;');

    const currentWf = acc.workflow ? workflows.find(w => w.id === acc.workflow) : undefined;
    const currentWfName = currentWf ? currentWf.name : (acc.workflow || '');

    const workflowBadgeHtml = currentWfName
      ? `<span class="card-wf-tag" onclick="event.stopPropagation(); handleAssignWorkflow('${acc.email}')" title="${currentWfName} · ${i18n.t('workflows.badgeTooltip')}">
           <svg class="icon-svg" style="width:10px; height:10px; flex-shrink:0;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
           <span>${currentWfName}</span>
         </span>`
      : `<button class="card-wf-add-btn" onclick="event.stopPropagation(); handleAssignWorkflow('${acc.email}')" title="${i18n.t('workflows.badgeTooltip')}">
           <svg class="icon-svg" style="width:11px; height:11px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>
         </button>`;

    return `
      <div class="account-card ${acc.isActive ? 'active' : ''} ${isExpired ? 'expired' : ''} ${isScopeMissing ? 'scope-missing' : ''} ${acc.status === AccountStatus.DEPLETED ? 'depleted' : ''}" data-email="${acc.email}" data-name="${displayName}" data-alias="${acc.alias || ''}" data-status="${acc.status}" data-workflow="${acc.workflow || ''}" data-model-balances='${modelBalancesStr}'>
        <div class="card-header">
          <input type="checkbox" class="card-bulk-check" data-email="${acc.email}" onclick="event.stopPropagation(); handleCardCheck(this, '${acc.email}')" />
          ${acc.avatarUrl ? `<img class="avatar ${avatarClass}" src="${acc.avatarUrl}" alt="${displayName}" />` : `<div class="avatar ${avatarClass}">${displayName.charAt(0).toUpperCase()}</div>`}
          <div class="user-info">
            <div class="name-container" style="display:flex; align-items:center; gap:6px;">
              <h4 class="display-name-text" id="name-display-${safeEmailId}" style="margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 150px;">${displayName}</h4>
              <input type="text" class="edit-alias-input" id="name-input-${safeEmailId}" value="${acc.alias || ''}" placeholder="${i18n.t('webview.editAliasPlaceholder')}" style="display:none; padding:2px 6px; font-size:0.9em; font-family:inherit; background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border); border-radius:3px; max-width:130px;" onkeydown="handleAliasKey(event, '${acc.email}')" onblur="saveAlias('${acc.email}')" />
              <button class="edit-alias-btn" id="edit-btn-${safeEmailId}" onclick="startEditAlias('${acc.email}')" title="${i18n.t('webview.editAliasTooltip')}" style="background:none; border:none; padding:2px; cursor:pointer; color:var(--text-secondary); opacity:0.6; display:flex; align-items:center;">
                <svg class="icon-svg" style="width:13px; height:13px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
              </button>
              <button class="btn-card-refresh" id="refresh-btn-${safeEmailId}" onclick="event.stopPropagation(); handleSingleRefresh(this, '${acc.email}')" title="${i18n.t('accounts.refreshThisAccount')}">
                <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6"/><path d="M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
              </button>
            </div>
            <div class="user-email-row" style="display:flex; align-items:center; gap:5px; margin-top:2px;">
              <span class="user-email-text" style="font-size:0.75rem; color:var(--text-secondary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:150px;" title="${acc.email}">${acc.email}</span>
              ${workflowBadgeHtml}
            </div>
            ${nextResetHtml}
          </div>
          ${activeBadge}
        </div>
        
        ${cardBody}

        <div class="card-actions">
          ${actionsHtml}
        </div>
      </div>
    `;
  }

