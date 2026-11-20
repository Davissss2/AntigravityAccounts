/**
 * Account Card Actions & Badges Template
 * Generates action buttons and workflow badges for account cards.
 */

import { I18nService } from '../../../i18n';

export function renderCardActionsHtml(acc: any, isExpired: boolean, isScopeMissing: boolean): string {
  const i18n = I18nService.getInstance();

  if (isExpired) {
    return `
      <button class="btn btn-warning btn-reauth" onclick="sendMessage('reAuthenticate', '${acc.email}')" title="${i18n.t('accounts.reAuthenticate')}">${i18n.t('accounts.reAuthenticate')}</button>
      <button class="btn btn-danger" onclick="sendMessage('deleteAccount', '${acc.email}')">${i18n.t('accounts.remove')}</button>
    `;
  }
  if (isScopeMissing) {
    return `
      <button class="btn btn-warning btn-reauth" onclick="sendMessage('reAuthenticate', '${acc.email}')" title="${i18n.t('accounts.reAuthorize')}">${i18n.t('accounts.reAuthorize')}</button>
      <button class="btn btn-danger" onclick="sendMessage('deleteAccount', '${acc.email}')">${i18n.t('accounts.remove')}</button>
    `;
  }
  if (acc.isActive) {
    return `
      <button class="btn btn-danger" onclick="sendMessage('deleteAccount', '${acc.email}')">${i18n.t('accounts.remove')}</button>
    `;
  }
  return `
    <button class="btn btn-primary btn-activate" onclick="handleSwitchAccount(this, '${acc.email}')">${i18n.t('accounts.activate')}</button>
    <button class="btn btn-danger" onclick="sendMessage('deleteAccount', '${acc.email}')">${i18n.t('accounts.remove')}</button>
  `;
}

export function renderWorkflowBadgeHtml(acc: any, workflows: any[]): string {
  const i18n = I18nService.getInstance();
  const currentWf = acc.workflow ? workflows.find(w => w.id === acc.workflow) : undefined;
  const currentWfName = currentWf ? currentWf.name : (acc.workflow || '');

  if (currentWfName) {
    return `
      <span class="card-wf-tag" onclick="event.stopPropagation(); handleAssignWorkflow('${acc.email}')" title="${currentWfName} · ${i18n.t('workflows.badgeTooltip')}">
        <svg class="icon-svg" style="width:10px; height:10px; flex-shrink:0;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        <span>${currentWfName}</span>
      </span>
    `;
  }

  return `
    <button class="card-wf-add-btn" onclick="event.stopPropagation(); handleAssignWorkflow('${acc.email}')" title="${i18n.t('workflows.badgeTooltip')}">
      <svg class="icon-svg" style="width:11px; height:11px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>
    </button>
  `;
}
