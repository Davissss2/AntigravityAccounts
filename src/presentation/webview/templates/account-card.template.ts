/**
 * Account Card Template
 * Renders individual account cards, model quotas, countdown badges, and container structure.
 */

import { I18nService } from '../../../i18n';
import { AccountStatus } from '../../../core/domain/models/account.model';
import {
  formatResetTime,
  parseAccountBalances,
  resolvePreferredAndCountdown,
  ProcessedModel
} from '../utils/account-card-balances.utils';
import {
  renderCardActionsHtml,
  renderWorkflowBadgeHtml
} from './account-card-actions.template';

export function renderAccountCardHtml(acc: any, effectivePreferred: string, workflows: any[]): string {
  const i18n = I18nService.getInstance();
  const displayName = acc.alias || acc.name || acc.displayName || acc.email;

  const { processedModels, creditBalances } = parseAccountBalances(acc.balances);
  const { preferredModelData, nextResetTime } = resolvePreferredAndCountdown(
    processedModels,
    effectivePreferred,
    acc.balances
  );

  const nextResetHtml = nextResetTime
    ? `<div class="quota-countdown" style="font-size:0.75rem; color:var(--text-secondary); opacity:0.85; margin-top:3px; display:flex; align-items:center; gap:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%;" title="${formatResetTime(nextResetTime)}">
         <svg class="icon-svg" style="width:11px; height:11px; stroke-width:2.5; flex-shrink:0;" viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
         <span style="overflow:hidden; text-overflow:ellipsis;">${formatResetTime(nextResetTime)}</span>
       </div>`
    : '';

  const creditsHtml = creditBalances.length > 0
    ? `<div class="credits-container">` + creditBalances.map(c => `
      <div class="credit-badge">
        <span class="credit-name">${c.key.replace(/_/g, ' ').toUpperCase()}</span>
        <span class="credit-value">${c.value.toLocaleString()}</span>
      </div>
    `).join('') + `</div>`
    : '';

  const modelsHtml = processedModels.length > 0
    ? processedModels.map(m => renderModelItemHtml(m, acc.email, i18n)).join('')
    : `<div class="empty-models">${i18n.t('accounts.noAvailableModels')}</div>`;

  const wrapperId = `collapse-${acc.email.replace(/[@.]/g, '-')}`;
  const collapseHeaderHtml = renderCollapseHeaderHtml(preferredModelData, processedModels.length, wrapperId, acc.email, i18n);

  const isExpired = acc.status === AccountStatus.TOKEN_EXPIRED;
  const isScopeMissing = acc.status === AccountStatus.SCOPE_MISSING;
  const isError = acc.status === AccountStatus.ERROR;
  const activeBadge = acc.isActive
    ? `<div class="badge active-badge">${i18n.t('accounts.active')}</div>`
    : isExpired
      ? `<div class="badge expired-badge">${i18n.t('accounts.expired')}</div>`
      : isScopeMissing
        ? `<div class="badge scope-missing-badge">${i18n.t('accounts.status.scopeMissing')}</div>`
        : isError
          ? `<div class="badge error-badge">${i18n.t('accounts.status.error')}</div>`
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

  const actionsHtml = renderCardActionsHtml(acc, isExpired, isScopeMissing);
  const avatarClass = isExpired || isScopeMissing ? 'avatar-expired' : '';
  const safeEmailId = acc.email.replace(/[@.]/g, '-');

  const modelBalancesMap: Record<string, number> = {};
  processedModels.forEach(m => {
    modelBalancesMap[m.key.toLowerCase()] = m.value;
  });
  if (preferredModelData) {
    modelBalancesMap[preferredModelData.key.toLowerCase()] = preferredModelData.value;
  }
  const modelBalancesStr = JSON.stringify(modelBalancesMap).replace(/'/g, '&apos;');
  const workflowBadgeHtml = renderWorkflowBadgeHtml(acc, workflows);

  return `
    <div class="account-card ${acc.isActive ? 'active' : ''} ${isExpired ? 'expired' : ''} ${isScopeMissing ? 'scope-missing' : ''} ${isError ? 'error' : ''} ${acc.status === AccountStatus.DEPLETED ? 'depleted' : ''}" data-email="${acc.email}" data-name="${displayName}" data-alias="${acc.alias || ''}" data-status="${acc.status}" data-workflow="${acc.workflow || ''}" data-model-balances='${modelBalancesStr}'>
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
            <button class="btn-card-reauth" id="reauth-btn-${safeEmailId}" onclick="event.stopPropagation(); sendMessage('reAuthenticate', '${acc.email}')" title="${i18n.t('accounts.reAuthenticate')}">
              <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
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

function renderModelItemHtml(m: ProcessedModel, email: string, i18n: any): string {
  const displayKey = m.key.endsWith('image')
    ? `${m.key} <svg class="icon-svg icon-image" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`
    : m.key;
  const timeStr = formatResetTime(m.resetTime);

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
  <div class="model-card" data-model-key="${m.key}" onclick="selectModel(this, '${email}', '${m.key}')" style="cursor: pointer;" title="${i18n.t('webview.selectThisModel')}">
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
}

function renderCollapseHeaderHtml(
  pref: ProcessedModel | null,
  availableCount: number,
  wrapperId: string,
  email: string,
  i18n: any
): string {
  if (pref) {
    const displayKey = pref.key.endsWith('image')
      ? `${pref.key} <svg class="icon-svg icon-image" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`
      : pref.key;

    let colorClass = 'bg-high';
    let alertIcon = '';
    if (pref.value < 20) {
      colorClass = 'bg-low';
      alertIcon = ` <svg class="icon-svg icon-warning" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" title="${i18n.t('webview.veryLowBalance')}"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
    } else if (pref.value < 32) {
      colorClass = 'bg-low';
    } else if (pref.value < 60) {
      colorClass = 'bg-med';
    }

    return `
    <div class="collapse-header unified-collapse" onclick="toggleModels(this, '${wrapperId}')" title="${i18n.t('webview.showAvailableModels')}">
      <span class="collapse-title">${i18n.t('accounts.models')}</span>
      <div class="collapse-header-right">
        <div class="pref-badge preferred-model-card" data-model-key="${pref.key}" onclick="event.stopPropagation(); selectModel(this, '${email}', '${pref.key}')" title="${i18n.t('webview.activatePreferredModel')}">
          <span class="pref-badge-name">${displayKey}</span>
          <div class="pref-badge-bar"><div class="progress-bar ${colorClass}" style="width: ${pref.value}%"></div></div>
          <span class="pref-badge-val ${colorClass}-text">${pref.value}%${alertIcon}</span>
        </div>
        <svg class="chevron-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
    </div>
    `;
  }

  return `
  <div class="collapse-header normal-collapse" onclick="toggleModels(this, '${wrapperId}')" title="${i18n.t('webview.showAvailableModels')}">
    <span class="collapse-title">${i18n.t('accounts.availableModels', { count: availableCount })}</span>
    <svg class="chevron-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
  </div>
  `;
}
