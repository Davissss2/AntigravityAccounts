/**
 * Webview Styles
 * Contains all themes, layout, card styling, and responsive queries.
 */

export function getWebviewStyles(): string {
  return `
          /* ── Default: Dark Purple (Original Antigravity Theme) ── */
          :root,
          [data-theme="dark-purple"],
          .theme-dark-purple {
            --background-dark: #0c0a17;
            --surface-color: #161327;
            --surface-light: #211c3b;
            --surface-subtle: #110e20;
            
            --primary-color: #7c3aed;
            --primary-dark: #6d28d9;
            --primary-light: #a78bfa;
            --secondary-color: #262042;
            
            --text-primary: #f9fafb;
            --text-secondary: #9ca3af;
            --text-muted: #6b7280;
            
            --border-color: rgba(139, 92, 246, 0.18);
            --focus-border: #8b5cf6;
            
            --danger-color: #ef4444;
            --success-color: #10b981;
            --warning-color: #f59e0b;
            
            --glass-bg: #161327;
            --glass-border: rgba(139, 92, 246, 0.22);
            --shadow-color: rgba(0, 0, 0, 0.45);
            --hover-bg: #1f1a38;
            
            --active-glow: 0 0 16px rgba(139, 92, 246, 0.35);
            --primary-gradient: linear-gradient(135deg, #7c3aed, #4f46e5);
            --primary-gradient-hover: linear-gradient(135deg, #8b5cf6, #6366f1);
            --danger-gradient: linear-gradient(135deg, #ef4444, #b91c1c);
            --warning-gradient: linear-gradient(135deg, #f59e0b, #b45309);
          }

          [data-theme="midnight"],
          .theme-midnight {
            --background-dark: #050608;
            --surface-color: #0d0f14;
            --surface-light: #141720;
            --surface-subtle: #08090d;
            
            --primary-color: #0284c7;
            --primary-dark: #0369a1;
            --primary-light: #38bdf8;
            --secondary-color: #161b24;
            
            --text-primary: #f8fafc;
            --text-secondary: #94a3b8;
            --text-muted: #64748b;
            
            --border-color: rgba(255, 255, 255, 0.08);
            --focus-border: #38bdf8;
            
            --danger-color: #f43f5e;
            --success-color: #10b981;
            --warning-color: #fbbf24;
            
            --glass-bg: #0d0f14;
            --glass-border: rgba(255, 255, 255, 0.1);
            --shadow-color: rgba(0, 0, 0, 0.6);
            --hover-bg: #141720;
            
            --active-glow: 0 0 16px rgba(56, 189, 248, 0.25);
            --primary-gradient: linear-gradient(135deg, #0284c7, #6366f1);
            --primary-gradient-hover: linear-gradient(135deg, #38bdf8, #818cf8);
            --danger-gradient: linear-gradient(135deg, #f43f5e, #be123c);
            --warning-gradient: linear-gradient(135deg, #f59e0b, #b45309);
          }

          [data-theme="deep-blue"],
          .theme-deep-blue {
            --background-dark: #050b18;
            --surface-color: #0a1326;
            --surface-light: #111f3d;
            --surface-subtle: #070e1c;
            
            --primary-color: #2563eb;
            --primary-dark: #1d4ed8;
            --primary-light: #60a5fa;
            --secondary-color: #152344;
            
            --text-primary: #f0f9ff;
            --text-secondary: #94a3b8;
            --text-muted: #64748b;
            
            --border-color: rgba(96, 165, 250, 0.18);
            --focus-border: #60a5fa;
            
            --danger-color: #ef4444;
            --success-color: #10b981;
            --warning-color: #f59e0b;
            
            --glass-bg: #0a1326;
            --glass-border: rgba(96, 165, 250, 0.2);
            --shadow-color: rgba(0, 0, 0, 0.5);
            --hover-bg: #111f3d;
            
            --active-glow: 0 0 18px rgba(96, 165, 250, 0.3);
            --primary-gradient: linear-gradient(135deg, #2563eb, #0284c7);
            --primary-gradient-hover: linear-gradient(135deg, #3b82f6, #38bdf8);
            --danger-gradient: linear-gradient(135deg, #ef4444, #b91c1c);
            --warning-gradient: linear-gradient(135deg, #f59e0b, #b45309);
          }

          [data-theme="vscode"],
          .theme-vscode {
            --background-dark: transparent;
            --surface-color: var(--vscode-sideBarSectionHeader-background, var(--vscode-editor-background, rgba(128, 128, 128, 0.05)));
            --surface-light: var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.09));
            --surface-subtle: var(--vscode-input-background, rgba(128, 128, 128, 0.06));
            
            --primary-color: var(--vscode-button-background, #007acc);
            --primary-dark: var(--vscode-button-hoverBackground, #0062a3);
            --primary-light: var(--vscode-textLink-foreground, var(--vscode-focusBorder, #3b82f6));
            --secondary-color: var(--vscode-button-secondaryBackground, rgba(128, 128, 128, 0.14));
            
            --text-primary: var(--vscode-foreground, var(--vscode-editor-foreground, #e5e7eb));
            --text-secondary: var(--vscode-descriptionForeground, #9ca3af);
            --text-muted: var(--vscode-disabledForeground, rgba(128, 128, 128, 0.55));
            
            --border-color: var(--vscode-widget-border, var(--vscode-panel-border, var(--vscode-sideBar-border, rgba(128, 128, 128, 0.18))));
            --focus-border: var(--vscode-focusBorder, var(--vscode-button-background, #007acc));
            
            --danger-color: var(--vscode-errorForeground, var(--vscode-charts-red, #ef4444));
            --success-color: var(--vscode-testing-iconPassed, var(--vscode-charts-green, #10b981));
            --warning-color: var(--vscode-editorWarning-foreground, var(--vscode-charts-yellow, #f59e0b));
            
            --glass-bg: var(--surface-color);
            --glass-border: var(--border-color);
            --shadow-color: var(--vscode-widget-shadow, rgba(0, 0, 0, 0.18));
            --hover-bg: var(--surface-light);
            
            --active-glow: 0 0 14px rgba(124, 58, 237, 0.22);
            --primary-gradient: linear-gradient(135deg, var(--vscode-button-background, #007acc), var(--vscode-textLink-foreground, #3b82f6));
            --primary-gradient-hover: linear-gradient(135deg, var(--vscode-button-hoverBackground, #0062a3), var(--vscode-textLink-activeForeground, #60a5fa));
            --danger-gradient: linear-gradient(135deg, #ef4444, #b91c1c);
            --warning-gradient: linear-gradient(135deg, #f59e0b, #b45309);
          }

          /* Modern Scrollbar Styling */
          ::-webkit-scrollbar {
            width: 6px;
            height: 6px;
          }
          ::-webkit-scrollbar-track {
            background: transparent;
          }
          ::-webkit-scrollbar-thumb {
            background: var(--vscode-scrollbarSlider-background, rgba(128, 128, 128, 0.25));
            border-radius: 4px;
          }
          ::-webkit-scrollbar-thumb:hover {
            background: var(--vscode-scrollbarSlider-hoverBackground, rgba(128, 128, 128, 0.45));
          }

          html, body {
            overflow-x: hidden;
            max-width: 100vw;
          }

          body {
            padding: 12px;
            background-color: var(--background-dark);
            color: var(--text-primary);
            font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif);
            font-size: 13px;
            line-height: 1.4;
            margin: 0;
            container-type: inline-size;
            box-sizing: border-box;
            transition: background-color 0.2s ease, color 0.2s ease;
          }

          *, *::before, *::after {
            box-sizing: border-box;
          }
          
          .header-actions {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 14px;
            padding-bottom: 10px;
            border-bottom: 1px solid var(--border-color);
          }

          .header-actions h2 { 
            margin: 0; 
            font-size: 1.05rem; 
            color: var(--text-primary); 
            font-weight: 700;
            letter-spacing: -0.01em;
          }

          .quota-count-badge {
            display: inline-flex;
            align-items: center;
            gap: 5px;
            font-size: 0.72rem;
            font-weight: 600;
            padding: 2px 8px;
            border-radius: 12px;
            letter-spacing: 0.02em;
          }
          .quota-count-badge.has-quota {
            background: rgba(16, 185, 129, 0.12);
            color: var(--success-color);
            border: 1px solid rgba(16, 185, 129, 0.25);
          }
          .quota-count-badge.has-quota .quota-count-dot {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background-color: var(--success-color);
            box-shadow: 0 0 6px var(--success-color);
          }
          .quota-count-badge.no-quota {
            background: rgba(245, 158, 11, 0.12);
            color: var(--warning-color);
            border: 1px solid rgba(245, 158, 11, 0.25);
          }
          .quota-count-badge.no-quota .quota-count-dot {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background-color: var(--warning-color);
          }
          
          .btn-icon {
            background: var(--surface-light);
            border: 1px solid var(--border-color);
            color: var(--text-primary);
            cursor: pointer;
            padding: 6px 10px;
            border-radius: 6px;
            transition: all 0.15s cubic-bezier(0.16, 1, 0.3, 1);
            display: inline-flex;
            align-items: center;
            justify-content: center;
            font-size: 0.9rem;
            margin-inline-start: 4px;
          }
          .btn-icon:hover {
            background: var(--primary-color);
            color: var(--vscode-button-foreground, #ffffff);
            border-color: var(--primary-color);
            transform: translateY(-1px);
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
          }
          .btn-icon:active {
            transform: translateY(0);
          }

          .account-card {
            background: var(--surface-color);
            border: 1px solid var(--border-color);
            border-radius: 12px;
            padding: 14px;
            margin-bottom: 12px;
            transition: transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease;
            position: relative;
            box-shadow: 0 2px 6px var(--shadow-color);
          }

          .account-card:hover {
            transform: translateY(-1.5px);
            box-shadow: 0 6px 16px var(--shadow-color);
            border-color: var(--focus-border);
          }

          .account-card.active {
            border: 1.5px solid var(--focus-border);
            box-shadow: var(--active-glow), 0 3px 10px var(--shadow-color);
            background: var(--surface-color);
          }

          .account-card.refreshing {
            border-color: var(--primary-light) !important;
            box-shadow: 0 0 12px rgba(124, 58, 237, 0.2), 0 2px 6px var(--shadow-color);
            opacity: 0.88;
            animation: cardRefreshPulse 2s infinite ease-in-out;
          }
          @keyframes cardRefreshPulse {
            0%, 100% { opacity: 0.75; }
            50% { opacity: 0.98; }
          }

          .btn-card-refresh {
            background: none;
            border: none;
            color: var(--text-secondary);
            cursor: pointer;
            padding: 2px 4px;
            border-radius: 4px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
            opacity: 0.7;
          }
          .btn-card-refresh:hover {
            color: var(--primary-light);
            background: var(--surface-light);
            opacity: 1;
            transform: rotate(45deg);
          }
          .btn-card-refresh .icon-svg {
            width: 12px;
            height: 12px;
          }
          .btn-card-reauth {
            background: none;
            border: none;
            color: var(--text-secondary);
            cursor: pointer;
            padding: 2px 4px;
            border-radius: 4px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
            opacity: 0.7;
          }
          .btn-card-reauth:hover {
            color: var(--warning-color);
            background: var(--surface-light);
            opacity: 1;
          }
          .btn-card-reauth .icon-svg {
            width: 12px;
            height: 12px;
          }
          .account-card.refreshing .btn-card-refresh {
            animation: spin 1s linear infinite;
            pointer-events: none;
            opacity: 1;
          }
          .btn-card-refresh.spinning .icon-svg,
          .btn-icon.spinning .icon-svg,
          .toolbar-scan.loading .icon-svg {
            animation: spin 0.8s linear infinite !important;
          }
          .toolbar-scan.loading {
            opacity: 0.75;
            pointer-events: none;
          }

          /* ── Toolbar ── */
          .toolbar-container {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            margin-bottom: 12px;
          }
          .toolbar-sort, .toolbar-scan {
            position: relative;
            flex: 1 1 110px;
            min-width: 0;
            display: flex;
            align-items: center;
            gap: 4px;
            background: var(--surface-subtle);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 6px 10px;
            box-sizing: border-box;
            transition: all 0.15s cubic-bezier(0.16, 1, 0.3, 1);
            user-select: none;
            -webkit-user-select: none;
            cursor: pointer;
          }
          .toolbar-sort:hover, .toolbar-scan:hover {
            border-color: var(--focus-border);
            background: var(--surface-light);
          }
          .toolbar-bulk-btn, .toolbar-autoswitch-btn {
            display: inline-flex;
            flex: 1 1 70px;
            min-width: 0;
            align-items: center;
            justify-content: center;
            gap: 4px;
            background: var(--surface-subtle);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 6px 9px;
            color: var(--text-secondary);
            font-size: 0.72rem;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.15s ease;
            white-space: nowrap;
            user-select: none;
          }
          .toolbar-bulk-btn:hover, .toolbar-autoswitch-btn:hover {
            border-color: var(--focus-border);
            color: var(--text-primary);
            background: var(--surface-light);
          }
          .toolbar-autoswitch-btn.active {
            border-color: rgba(16, 185, 129, 0.4);
            color: var(--success-color);
            background: rgba(16, 185, 129, 0.12);
          }
          .toolbar-sort select, .toolbar-scan select {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            opacity: 0;
            cursor: pointer;
            -webkit-appearance: none;
            appearance: none;
          }
          .toolbar-sort select option, .toolbar-scan select option {
            background: var(--vscode-dropdown-background, var(--vscode-editor-background));
            color: var(--vscode-dropdown-foreground, var(--text-primary));
          }
          .toolbar-label {
            font-size: 0.72rem;
            color: var(--text-secondary);
            white-space: nowrap;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            user-select: none;
            -webkit-user-select: none;
            pointer-events: none;
          }

          .card-header {
            display: flex;
            align-items: flex-start;
            gap: 12px;
            margin-bottom: 12px;
            min-width: 0;
          }

          .avatar {
            width: 38px;
            height: 38px;
            border-radius: 10px;
            background: var(--primary-gradient);
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: 700;
            font-size: 1.1rem;
            color: white;
            box-shadow: 0 2px 6px rgba(0, 0, 0, 0.15);
            object-fit: cover;
            border: 1px solid var(--border-color);
            flex-shrink: 0;
          }

          .user-info { flex: 1; overflow: hidden; min-width: 0; }
          .user-info h4 { 
            margin: 0 0 2px 0; 
            font-size: 0.94rem; 
            font-weight: 600;
            white-space: nowrap; 
            overflow: hidden; 
            text-overflow: ellipsis;
            color: var(--text-primary);
          }
          .user-info p { 
            margin: 0; 
            font-size: 0.78rem; 
            color: var(--text-secondary); 
            white-space: nowrap; 
            overflow: hidden; 
            text-overflow: ellipsis;
          }

          .badge {
            font-size: 0.68rem;
            padding: 3px 8px;
            border-radius: 12px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.04em;
            flex-shrink: 0;
          }
          
          .active-badge {
            background: rgba(16, 185, 129, 0.12);
            color: var(--success-color);
            border: 1px solid rgba(16, 185, 129, 0.3);
            box-shadow: 0 0 8px rgba(16, 185, 129, 0.15);
            position: relative;
            padding-inline-start: 18px;
          }
          
          .active-badge::before {
            content: '';
            position: absolute;
            left: 6px;
            top: 50%;
            transform: translateY(-50%);
            width: 5px;
            height: 5px;
            border-radius: 50%;
            background: var(--success-color);
            box-shadow: 0 0 6px var(--success-color);
            animation: badgePulse 2s infinite;
          }
          [dir="rtl"] .active-badge {
            padding-inline-start: 8px;
            padding-inline-end: 18px;
          }
          [dir="rtl"] .active-badge::before {
            left: auto;
            right: 6px;
          }

          @keyframes badgePulse {
            0% { transform: translateY(-50%) scale(0.9); opacity: 0.6; }
            50% { transform: translateY(-50%) scale(1.2); opacity: 1; }
            100% { transform: translateY(-50%) scale(0.9); opacity: 0.6; }
          }

          .balances-container {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            margin-bottom: 12px;
            padding: 10px;
            background: var(--surface-subtle);
            border-radius: 8px;
            border: 1px solid var(--border-color);
          }

          .balance-badge {
            display: flex;
            flex-direction: column;
            background: var(--surface-color);
            padding: 6px 8px;
            border-radius: 6px;
            flex: 1;
            min-width: 70px;
            text-align: center;
            border: 1px solid var(--border-color);
          }

          .balance-name { 
            font-size: 0.65rem; 
            color: var(--text-secondary); 
            margin-bottom: 2px; 
            text-transform: uppercase; 
            letter-spacing: 0.5px;
            font-weight: 600;
          }
          .balance-value { 
            font-size: 1.05rem; 
            font-weight: 700; 
            color: var(--primary-light); 
          }

          .card-actions {
            display: flex;
            gap: 8px;
            justify-content: flex-end;
            margin-top: 12px;
            padding-top: 10px;
            border-top: 1px solid var(--border-color);
          }

          .credits-container {
            display: flex;
            margin-bottom: 12px;
            padding: 10px;
            background: var(--surface-subtle);
            border-radius: 8px;
            border: 1px solid var(--border-color);
          }

          .credit-badge {
            display: flex;
            justify-content: space-between;
            align-items: center;
            width: 100%;
          }

          .credit-name {
            font-size: 0.78rem;
            color: var(--text-secondary);
            font-weight: 600;
            letter-spacing: 0.02em;
          }

          .credit-value {
            font-size: 1.1rem;
            color: var(--primary-light);
            font-weight: 800;
            letter-spacing: -0.01em;
          }

          .models-section {
            margin-bottom: 10px;
          }

          .collapse-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            background: var(--surface-subtle);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            cursor: pointer;
            user-select: none;
            transition: all 0.15s cubic-bezier(0.16, 1, 0.3, 1);
            min-width: 0;
            gap: 6px;
          }
          
          .normal-collapse {
            padding: 8px 12px;
          }
          
          .normal-collapse:hover {
            background: var(--hover-bg);
            border-color: var(--focus-border);
          }

          .collapse-title {
            font-size: 0.8rem;
            font-weight: 600;
            color: var(--text-primary);
            white-space: nowrap;
            flex-shrink: 0;
          }

          .unified-collapse {
            padding: 6px 10px;
          }
          
          .unified-collapse:hover {
            background: var(--hover-bg);
            border-color: var(--focus-border);
          }
          
          .collapse-header-right {
            display: flex;
            align-items: center;
            gap: 6px;
            min-width: 0;
            flex-shrink: 1;
            overflow: hidden;
          }

          .pref-badge {
            display: flex;
            align-items: center;
            gap: 6px;
            background: var(--surface-color);
            padding: 3px 8px;
            border-radius: 6px;
            border: 1px solid var(--border-color);
            font-size: 0.72rem;
            transition: all 0.15s cubic-bezier(0.16, 1, 0.3, 1);
            cursor: pointer;
            min-width: 0;
            flex-shrink: 1;
            overflow: hidden;
          }

          .pref-badge:hover {
            background: var(--hover-bg);
            border-color: var(--focus-border);
          }

          .pref-badge.active-model {
            background: var(--primary-gradient);
            color: white;
            border-color: transparent;
            box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2);
          }

          .pref-badge-name {
            font-weight: 600;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            color: inherit;
            min-width: 0;
            flex-shrink: 1;
          }

          .pref-badge-bar {
            width: 34px;
            min-width: 20px;
            height: 4px;
            background: rgba(128, 128, 128, 0.2);
            border-radius: 2px;
            overflow: hidden;
            flex-shrink: 1;
          }

          .pref-badge-val {
            font-weight: 700;
            white-space: nowrap;
            flex-shrink: 0;
            color: inherit;
          }

          .collapse-icon {
            font-size: 0.75rem;
            color: var(--text-secondary);
            transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
            margin-inline-end: 2px;
          }
          
          .collapse-header.expanded .collapse-icon {
            transform: rotate(180deg);
          }

          .icon-svg {
            width: 14px;
            height: 14px;
            display: inline-block;
            vertical-align: middle;
            stroke-width: 2.2px;
          }
          .btn-icon .icon-svg {
            width: 15px;
            height: 15px;
          }
          .chevron-svg {
            width: 12px;
            height: 12px;
            color: var(--text-secondary);
            transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
            margin-inline-end: 2px;
            vertical-align: middle;
          }
          .collapse-header.expanded .chevron-svg {
            transform: rotate(180deg);
          }
          .icon-warning {
            color: var(--warning-color);
            margin-inline-start: 4px;
          }
          .icon-error {
            color: var(--danger-color);
          }
          .icon-image {
            margin-inline-start: 4px;
            opacity: 0.8;
          }
          .empty-state-svg {
            color: var(--text-secondary);
            opacity: 0.5;
            margin-bottom: 14px;
            animation: floatAnimation 4s ease-in-out infinite;
          }
          @keyframes floatAnimation {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-4px); }
          }

          .collapsible-wrapper {
            display: grid;
            grid-template-rows: 0fr;
            transition: grid-template-rows 0.25s cubic-bezier(0.16, 1, 0.3, 1);
          }

          .collapsible-wrapper.expanded {
            grid-template-rows: 1fr;
          }

          .collapsible-inner {
            overflow: hidden;
          }

          .models-container {
            display: flex;
            flex-direction: column;
            gap: 6px;
            padding-top: 8px;
          }

          .model-card {
            background: var(--surface-subtle);
            padding: 8px 10px;
            border-radius: 8px;
            border: 1px solid var(--border-color);
            display: flex;
            flex-direction: column;
            transition: all 0.15s cubic-bezier(0.16, 1, 0.3, 1);
          }

          .model-card.active-model {
            border-color: var(--focus-border);
            background: var(--surface-light);
            box-shadow: 0 0 8px rgba(0, 0, 0, 0.12);
          }

          .model-card:hover {
            background: var(--surface-light);
            border-color: var(--focus-border);
            transform: translateX(2px);
          }
          [dir="rtl"] .model-card:hover {
            transform: translateX(-2px);
          }

          .model-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 5px;
            gap: 6px;
            min-width: 0;
          }

          .model-name {
            font-size: 0.8rem;
            font-weight: 600;
            color: var(--text-primary);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            min-width: 0;
            flex-shrink: 1;
          }

          .model-reset {
            font-size: 0.68rem;
            color: var(--text-secondary);
            white-space: nowrap;
            flex-shrink: 0;
          }

          .progress-bar-container {
            width: 100%;
            height: 6px;
            background: rgba(128, 128, 128, 0.18);
            border-radius: 3px;
            overflow: hidden;
            margin-bottom: 3px;
            box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.1);
          }

          .progress-bar {
            height: 100%;
            border-radius: 3px;
            transition: width 0.4s cubic-bezier(0.4, 0, 0.2, 1);
            position: relative;
            overflow: hidden;
          }

          /* Subtle shimmer animation */
          .progress-bar::after {
            content: '';
            position: absolute;
            top: 0; left: 0; right: 0; bottom: 0;
            background: linear-gradient(
              90deg,
              rgba(255, 255, 255, 0) 0%,
              rgba(255, 255, 255, 0.18) 50%,
              rgba(255, 255, 255, 0) 100%
            );
            transform: translateX(-100%);
            animation: shimmer-effect 2.5s infinite;
          }

          @keyframes shimmer-effect {
            100% {
              transform: translateX(100%);
            }
          }

          .bg-high {
            background: linear-gradient(90deg, #10b981, #059669);
          }
          .bg-med {
            background: linear-gradient(90deg, #f59e0b, #d97706);
          }
          .bg-low {
            background: linear-gradient(90deg, #ef4444, #dc2626);
          }
          
          .bg-high-text { color: var(--success-color); font-weight: 600; }
          .bg-med-text { color: var(--warning-color); font-weight: 600; }
          .bg-low-text { color: var(--danger-color); font-weight: 600; }

          .model-percentage {
            font-size: 0.72rem;
            align-self: flex-end;
            font-weight: 700;
          }

          .empty-models {
            font-size: 0.78rem;
            color: var(--text-secondary);
            text-align: center;
            padding: 10px;
          }

          .btn {
            padding: 6px 14px;
            border-radius: 6px;
            font-size: 0.8rem;
            cursor: pointer;
            font-weight: 500;
            transition: all 0.15s cubic-bezier(0.16, 1, 0.3, 1);
            border: 1px solid transparent;
            color: var(--vscode-button-foreground, #ffffff);
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 5px;
          }
          .btn:active {
            transform: scale(0.98);
          }

          .btn-primary {
            background: var(--primary-color);
            color: var(--vscode-button-foreground, #ffffff);
          }
          .btn-primary:hover { 
            background: var(--primary-dark); 
          }

          .btn-danger {
            background: rgba(239, 68, 68, 0.08);
            color: var(--danger-color);
            border: 1px solid rgba(239, 68, 68, 0.2);
          }
          .btn-danger:hover {
            background: #ef4444;
            color: white;
            border-color: transparent;
            box-shadow: 0 2px 8px rgba(239, 68, 68, 0.25);
          }

          .btn-warning {
            background: rgba(245, 158, 11, 0.12);
            color: var(--warning-color);
            border: 1px solid rgba(245, 158, 11, 0.25);
          }
          .btn-warning:hover {
            background: #f59e0b;
            color: #000;
            border-color: transparent;
            box-shadow: 0 2px 8px rgba(245, 158, 11, 0.25);
          }

          .account-card.expired {
            border: 1px dashed var(--warning-color);
            opacity: 0.92;
          }
          .account-card.expired:hover {
            border-color: var(--warning-color);
          }

          .account-card.scope-missing {
            border: 1px dashed var(--warning-color);
            opacity: 0.95;
          }
          .account-card.scope-missing:hover {
            border-color: var(--warning-color);
          }

          .avatar-expired {
            opacity: 0.5;
            filter: grayscale(80%);
          }

          .expired-badge {
            background: rgba(245, 158, 11, 0.12);
            color: var(--warning-color);
            border: 1px solid rgba(245, 158, 11, 0.25);
            white-space: nowrap;
          }

          .error-badge {
            background: rgba(239, 68, 68, 0.12);
            color: var(--danger-color);
            border: 1px solid rgba(239, 68, 68, 0.25);
            white-space: nowrap;
          }

          .account-card.error {
            border: 1px dashed rgba(239, 68, 68, 0.5);
            opacity: 0.95;
          }
          .account-card.error:hover {
            border-color: var(--danger-color);
          }

          .scope-missing-badge {
            background: rgba(245, 158, 11, 0.12);
            color: var(--warning-color);
            border: 1px solid rgba(245, 158, 11, 0.25);
            white-space: nowrap;
          }

          .expired-banner {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 10px;
            margin-bottom: 12px;
            background: rgba(245, 158, 11, 0.06);
            border: 1px solid rgba(245, 158, 11, 0.2);
            border-radius: 6px;
            animation: subtlePulse 3s ease-in-out infinite;
          }
          .expired-banner-icon {
            font-size: 1.1rem;
            flex-shrink: 0;
          }
          .expired-banner-text {
            font-size: 0.76rem;
            color: var(--warning-color);
            line-height: 1.4;
            font-weight: 500;
          }


          .scope-missing-banner {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 10px;
            margin-bottom: 12px;
            background: rgba(245, 158, 11, 0.06);
            border: 1px solid rgba(245, 158, 11, 0.2);
            border-radius: 6px;
            animation: subtlePulse 3s ease-in-out infinite;
          }
          .scope-missing-banner-icon {
            font-size: 1.1rem;
            flex-shrink: 0;
          }
          .scope-missing-banner-text {
            font-size: 0.76rem;
            color: var(--warning-color);
            line-height: 1.4;
            font-weight: 500;
          }

          @keyframes subtlePulse {
            0%, 100% { border-color: rgba(245, 158, 11, 0.2); }
            50% { border-color: rgba(245, 158, 11, 0.45); }
          }

          @keyframes redSubtlePulse {
            0%, 100% { border-color: rgba(239, 68, 68, 0.2); }
            50% { border-color: rgba(239, 68, 68, 0.45); }
          }

          .empty-state {
            text-align: center;
            padding: 36px 16px;
            color: var(--text-secondary);
            background: var(--surface-color);
            border-radius: 10px;
            border: 1px dashed var(--border-color);
          }
          .empty-icon { font-size: 2.8rem; margin-bottom: 12px; opacity: 0.6; }
          .main-btn { margin-top: 14px; padding: 8px 20px; font-size: 0.9rem; width: 100%;}

          /* ── Responsive: Container Queries for narrow sidebar ── */
          @container (max-width: 340px) {
            .toolbar-container { gap: 4px; }
            .toolbar-sort, .toolbar-scan { padding: 5px 6px; }
            .toolbar-label-prefix { display: none; }
            .scan-text-long { display: none !important; }
            .scan-text-short { display: inline !important; }
            .toolbar-value { font-size: 0.72rem !important; }
            .toolbar-label { font-size: 0.72rem; }
          }

          @container (max-width: 280px) {
            body { padding: 8px; }
            .account-card { padding: 10px; }
            .card-header { gap: 8px; }
            .avatar { width: 32px; height: 32px; font-size: 0.95rem; }
            .user-info h4 { font-size: 0.85rem; }
            .user-info p { font-size: 0.7rem; }
            .collapse-header { padding: 6px 8px; }
            .collapse-title { font-size: 0.76rem; }
            .pref-badge { gap: 4px; padding: 2px 5px; font-size: 0.68rem; }
            .pref-badge-bar { display: none; }
            .model-card { padding: 6px 8px; }
            .model-name { font-size: 0.76rem; }
            .model-reset { font-size: 0.65rem; }
            .model-percentage { font-size: 0.68rem; }
            .btn { padding: 5px 8px; font-size: 0.74rem; }
            .header-actions h2 { font-size: 0.92rem; }
            .btn-icon { padding: 5px 7px; font-size: 0.78rem; }
          }

          @container (max-width: 220px) {
            .pref-badge-name { max-width: 38px; }
            .collapse-title { font-size: 0.7rem; }
            .avatar { width: 26px; height: 26px; font-size: 0.8rem; border-radius: 6px; }
            .card-header { gap: 6px; }
            .badge { font-size: 0.58rem; padding: 2px 5px; }
          }

          /* ── Search ── */
          .search-container {
            position: relative;
            margin-bottom: 12px;
          }
          .search-input {
            width: 100%;
            padding: 7px 30px 7px 10px;
            background: var(--vscode-input-background, rgba(128, 128, 128, 0.08));
            border: 1px solid var(--vscode-input-border, var(--border-color));
            border-radius: 6px;
            color: var(--vscode-input-foreground, var(--text-primary));
            font-size: 0.82rem;
            font-family: inherit;
            outline: none;
            transition: border-color 0.15s ease, box-shadow 0.15s ease;
            box-sizing: border-box;
          }
          [dir="rtl"] .search-input {
            padding: 7px 10px 7px 30px;
          }
          .search-input:focus {
            border-color: var(--focus-border);
            box-shadow: 0 0 6px rgba(0, 0, 0, 0.15);
          }
          .search-input::placeholder {
            color: var(--vscode-input-placeholderForeground, var(--text-secondary));
            opacity: 0.75;
          }
          .search-input:disabled {
            opacity: 0.4;
            cursor: not-allowed;
          }
          .search-clear-btn {
            position: absolute;
            top: 50%;
            right: 6px;
            transform: translateY(-50%);
            background: none;
            border: none;
            color: var(--text-secondary);
            cursor: pointer;
            font-size: 0.82rem;
            padding: 2px 5px;
            border-radius: 4px;
            transition: all 0.15s;
            line-height: 1;
            display: none;
          }
          [dir="rtl"] .search-clear-btn {
            right: auto;
            left: 6px;
          }
          .search-clear-btn:hover {
            color: var(--text-primary);
            background: var(--surface-light);
          }
          .search-no-results {
            text-align: center;
            padding: 28px 16px;
            color: var(--text-secondary);
            display: none;
          }
          .search-no-results-icon {
            font-size: 1.8rem;
            margin-bottom: 8px;
            opacity: 0.45;
          }
          .search-no-results p {
            font-size: 0.82rem;
            margin: 0;
          }

          .account-card.search-hidden {
            display: none !important;
          }

          /* ── Premium Top progress banner for refresh ── */
          .refresh-progress-banner {
            display: none;
            flex-direction: column;
            gap: 8px;
            padding: 12px 14px;
            margin-bottom: 14px;
            background: linear-gradient(135deg, rgba(99, 102, 241, 0.08) 0%, rgba(139, 92, 246, 0.04) 50%, rgba(20, 20, 28, 0.6) 100%), var(--surface-color);
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            border: 1px solid rgba(139, 92, 246, 0.35);
            border-radius: 10px;
            box-shadow: 0 4px 20px -2px rgba(0, 0, 0, 0.35), 0 0 15px -3px rgba(139, 92, 246, 0.18);
            animation: fadeIn 0.25s cubic-bezier(0.16, 1, 0.3, 1);
            position: relative;
            overflow: hidden;
          }
          .refresh-progress-banner::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 1px;
            background: linear-gradient(90deg, transparent 0%, rgba(167, 139, 250, 0.6) 50%, transparent 100%);
          }
          .refresh-progress-banner.visible {
            display: flex;
          }
          .refresh-progress-info {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 12px;
            min-width: 0;
          }
          .refresh-progress-leading {
            display: flex;
            align-items: center;
            gap: 8px;
            min-width: 0;
            flex: 1;
          }
          .refresh-pulse-glow {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #8b5cf6;
            box-shadow: 0 0 8px #8b5cf6, 0 0 16px rgba(139, 92, 246, 0.6);
            flex-shrink: 0;
            animation: pulseGlow 1.8s infinite ease-in-out;
          }
          .refresh-pulse-glow.paused {
            background: #f59e0b;
            box-shadow: 0 0 8px #f59e0b, 0 0 16px rgba(245, 158, 11, 0.6);
            animation: pulseGlowAmber 1.4s infinite ease-in-out;
          }
          @keyframes pulseGlow {
            0%, 100% { transform: scale(0.9); opacity: 0.7; }
            50% { transform: scale(1.3); opacity: 1; box-shadow: 0 0 12px #a78bfa, 0 0 20px rgba(167, 139, 250, 0.8); }
          }
          @keyframes pulseGlowAmber {
            0%, 100% { transform: scale(0.9); opacity: 0.7; }
            50% { transform: scale(1.3); opacity: 1; box-shadow: 0 0 12px #fbbf24, 0 0 20px rgba(251, 191, 36, 0.8); }
          }
          .refresh-progress-email {
            font-size: 0.82rem;
            color: var(--text-primary);
            font-weight: 500;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            min-width: 0;
            display: flex;
            align-items: center;
            gap: 6px;
          }
          .refresh-status-badge {
            font-size: 0.68rem;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            font-weight: 700;
            padding: 2px 6px;
            border-radius: 4px;
            background: rgba(139, 92, 246, 0.2);
            color: #c4b5fd;
            border: 1px solid rgba(139, 92, 246, 0.4);
            white-space: nowrap;
            flex-shrink: 0;
          }
          .refresh-status-badge.scanning {
            background: rgba(99, 102, 241, 0.2);
            color: #a5b4fc;
            border-color: rgba(99, 102, 241, 0.4);
          }
          .refresh-status-badge.paused {
            background: rgba(245, 158, 11, 0.18);
            color: #fcd34d;
            border-color: rgba(245, 158, 11, 0.45);
          }
          .refresh-email-highlight {
            color: var(--primary-light, #a78bfa);
            font-weight: 600;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
          }
          .refresh-status-text {
            color: var(--text-secondary);
            font-size: 0.8rem;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
          }
          .refresh-progress-stats {
            display: flex;
            align-items: center;
            gap: 6px;
            flex-shrink: 0;
          }
          .refresh-progress-pill {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 0.74rem;
            font-weight: 700;
            color: #c4b5fd;
            background: rgba(139, 92, 246, 0.15);
            padding: 3px 8px;
            border-radius: 6px;
            border: 1px solid rgba(139, 92, 246, 0.35);
            white-space: nowrap;
          }
          .refresh-progress-pill-sep {
            opacity: 0.4;
          }
          .refresh-progress-bar-track {
            width: 100%;
            height: 6px;
            background: rgba(255, 255, 255, 0.08);
            border-radius: 999px;
            overflow: hidden;
            position: relative;
            box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.3);
          }
          .refresh-progress-bar-fill {
            height: 100%;
            border-radius: 999px;
            background: linear-gradient(90deg, #6366f1 0%, #8b5cf6 50%, #ec4899 100%);
            box-shadow: 0 0 10px rgba(168, 85, 247, 0.5);
            transition: width 0.4s cubic-bezier(0.16, 1, 0.3, 1);
            position: relative;
            overflow: hidden;
            width: 0%;
          }
          .refresh-progress-bar-fill::after {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            bottom: 0;
            right: 0;
            background: linear-gradient(90deg, transparent 0%, rgba(255, 255, 255, 0.35) 50%, transparent 100%);
            animation: progressShimmer 1.8s infinite linear;
          }
          @keyframes progressShimmer {
            0% { transform: translateX(-100%); }
            100% { transform: translateX(100%); }
          }

          /* Toast notification */
          .refresh-toast {
            display: none;
            padding: 8px 12px;
            margin-bottom: 12px;
            background: rgba(16, 185, 129, 0.1);
            border: 1px solid var(--success-color);
            border-radius: 8px;
            font-size: 0.8rem;
            color: var(--success-color);
            font-weight: 600;
            text-align: center;
            animation: fadeIn 0.2s ease;
          }
          .refresh-toast.visible {
            display: block;
          }
          @keyframes spin { to { transform: rotate(360deg); } }

          /* ── Cancel / Loading bar in header ── */
          .btn-cancel-refresh {
            background: rgba(239, 68, 68, 0.12);
            color: var(--danger-color);
            border: 1px solid rgba(239, 68, 68, 0.25);
            cursor: pointer;
            padding: 5px 10px;
            border-radius: 6px;
            font-size: 0.76rem;
            font-weight: 600;
            display: none;
            align-items: center;
            gap: 4px;
            animation: fadeIn 0.15s ease;
            transition: all 0.15s;
          }
          .btn-cancel-refresh:hover { background: #ef4444; color: white; border-color: transparent; }

          /* ── Cancel Confirmation Dialog ── */
          .cancel-confirm-overlay {
            position: fixed;
            inset: 0;
            background: rgba(0,0,0,0.5);
            z-index: 1100;
            display: none;
            align-items: center;
            justify-content: center;
            animation: fadeIn 0.15s ease;
            backdrop-filter: blur(6px);
          }
          .cancel-confirm-box {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-widget-border, var(--border-color));
            border-radius: 10px;
            padding: 18px 20px;
            min-width: 240px;
            max-width: 320px;
            box-shadow: 0 8px 24px var(--shadow-color);
            text-align: center;
          }
          .cancel-confirm-box h4 {
            margin: 0 0 6px 0;
            font-size: 0.95rem;
            font-weight: 700;
            color: var(--text-primary);
          }
          .cancel-confirm-box p {
            margin: 0 0 16px 0;
            font-size: 0.8rem;
            color: var(--text-secondary);
            line-height: 1.4;
          }
          .cancel-confirm-actions {
            display: flex;
            gap: 8px;
            justify-content: center;
          }
          .cancel-confirm-actions .btn { min-width: 75px; }

          /* Disabled state for all action buttons during refresh */
          .actions-disabled .btn,
          .actions-disabled .btn-icon,
          .actions-disabled .dropdown-item {
            opacity: 0.4;
            pointer-events: none;
            cursor: not-allowed;
          }
          .actions-disabled .cancel-confirm-actions .btn {
            opacity: 1;
            pointer-events: auto;
            cursor: pointer;
          }
          .actions-disabled .btn-activate {
            opacity: 1 !important;
            pointer-events: auto !important;
            cursor: pointer !important;
          }

          /* Loading overlay for export/import */
          .loading-overlay {
            position: fixed;
            inset: 0;
            background: rgba(0,0,0,0.5);
            z-index: 1000;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 14px;
            backdrop-filter: blur(6px);
          }
          .loading-spinner {
            width: 32px; height: 32px;
            border: 3px solid rgba(128, 128, 128, 0.2);
            border-top-color: var(--primary-color);
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
          }
          .loading-text {
            color: var(--text-secondary);
            font-size: 0.82rem;
            font-weight: 600;
          }

          /* ── Dropdown Menu ── */
          .menu-wrapper { position: relative; }
          .dropdown-menu {
            display: none;
            position: absolute;
            top: calc(100% + 6px);
            right: 0;
            min-width: 175px;
            background: var(--vscode-dropdown-background, var(--vscode-menu-background, var(--vscode-editor-background)));
            border: 1px solid var(--vscode-dropdown-border, var(--vscode-menu-border, var(--border-color)));
            border-radius: 6px;
            box-shadow: 0 6px 20px var(--shadow-color);
            z-index: 100;
            overflow: hidden;
            animation: fadeIn 0.15s ease;
          }
          .dropdown-menu.show { display: block; }
          @keyframes fadeIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
          .dropdown-item {
            display: flex;
            align-items: center;
            gap: 8px;
            width: 100%;
            padding: 8px 12px;
            background: none;
            border: none;
            color: var(--vscode-dropdown-foreground, var(--vscode-menu-foreground, var(--text-primary)));
            font-size: 0.8rem;
            cursor: pointer;
            text-align: start;
            transition: background 0.12s;
            font-weight: 500;
          }
          .dropdown-item:hover { background: var(--vscode-list-hoverBackground, var(--surface-light)); }
          .dropdown-item:disabled {
            opacity: 0.4;
            cursor: not-allowed;
          }
          .dropdown-item:disabled:hover { background: none; }
          .dropdown-icon { font-size: 0.95rem; display: inline-flex; align-items: center; justify-content: center; }

          /* ── Workflows Bar ── */
          .workflow-bar {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 4px 2px 8px 2px;
            margin-bottom: 6px;
            overflow-x: auto;
            scrollbar-width: thin;
            scrollbar-color: var(--border-color) transparent;
          }
          .workflow-bar::-webkit-scrollbar {
            height: 3px;
          }
          .workflow-bar::-webkit-scrollbar-thumb {
            background: var(--border-color);
            border-radius: 3px;
          }
          .workflow-chip {
            display: inline-flex;
            align-items: center;
            gap: 5px;
            padding: 4px 10px;
            border-radius: 12px;
            font-size: 0.74rem;
            font-weight: 500;
            background: var(--surface-light);
            color: var(--text-secondary);
            border: 1px solid var(--border-color);
            cursor: pointer;
            white-space: nowrap;
            transition: all 0.15s ease;
            user-select: none;
            outline: none;
          }
          .workflow-chip:hover {
            background: var(--hover-bg);
            color: var(--text-primary);
            border-color: var(--focus-border);
          }
          .workflow-chip.active {
            background: var(--primary-gradient);
            color: #fff;
            border-color: transparent;
            box-shadow: 0 2px 8px rgba(124, 58, 237, 0.35);
            font-weight: 600;
          }
          .workflow-chip-count {
            font-size: 0.68rem;
            opacity: 0.85;
            background: rgba(255, 255, 255, 0.12);
            padding: 1px 5px;
            border-radius: 8px;
            margin-inline-start: 2px;
          }
          .workflow-chip.active .workflow-chip-count {
            background: rgba(0, 0, 0, 0.25);
            color: #fff;
          }
          .workflow-chip-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            padding: 2px;
            margin-inline-start: 2px;
            border-radius: 4px;
            opacity: 0.65;
            transition: opacity 0.12s, background 0.12s;
            cursor: pointer;
          }
          .workflow-chip-btn:hover {
            opacity: 1;
            background: rgba(255, 255, 255, 0.15);
          }
          .btn-new-workflow {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 4px 10px;
            border-radius: 12px;
            font-size: 0.74rem;
            font-weight: 500;
            background: transparent;
            color: var(--primary-light, #a78bfa);
            border: 1px dashed var(--focus-border);
            cursor: pointer;
            white-space: nowrap;
            transition: all 0.15s ease;
            outline: none;
          }
          .btn-new-workflow:hover {
            background: rgba(124, 58, 237, 0.12);
            color: #fff;
            border-style: solid;
          }

          /* ── Card Workflow Badge & Bulk Selection ── */
          .card-wf-tag {
            display: inline-flex;
            align-items: center;
            gap: 3px;
            padding: 1px 5px;
            border-radius: 4px;
            font-size: 0.65rem;
            font-weight: 500;
            line-height: 1.2;
            background: rgba(124, 58, 237, 0.15);
            color: #c4b5fd;
            border: 1px solid rgba(124, 58, 237, 0.35);
            cursor: pointer;
            max-width: 95px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            user-select: none;
            transition: all 0.15s ease;
            flex-shrink: 0;
          }
          .card-wf-tag:hover {
            background: rgba(124, 58, 237, 0.3);
            border-color: var(--focus-border);
            color: #fff;
          }
          .card-wf-add-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            background: transparent;
            border: none;
            padding: 1px 3px;
            cursor: pointer;
            color: var(--text-muted);
            opacity: 0.45;
            transition: opacity 0.15s ease, color 0.15s ease;
            flex-shrink: 0;
          }
          .card-wf-add-btn:hover {
            opacity: 1;
            color: var(--primary-light);
          }
          .account-card:hover .card-wf-add-btn {
            opacity: 0.85;
          }
          .card-bulk-check {
            display: none;
            width: 15px;
            height: 15px;
            cursor: pointer;
            accent-color: var(--primary-color);
            align-self: center;
            flex-shrink: 0;
            margin-inline-end: 6px;
          }
          body.bulk-mode .card-bulk-check {
            display: block;
          }
          body.bulk-mode .account-card {
            cursor: pointer;
          }
          body.bulk-mode .account-card.selected-for-bulk {
            border-color: var(--primary-light) !important;
            background: rgba(124, 58, 237, 0.08) !important;
          }
          .toolbar-bulk-btn {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 4px 8px;
            font-size: 0.74rem;
            font-weight: 500;
            background: var(--surface-light);
            color: var(--text-secondary);
            border: 1px solid var(--border-color);
            border-radius: 6px;
            cursor: pointer;
            transition: all 0.15s ease;
            white-space: nowrap;
          }
          .toolbar-bulk-btn:hover, body.bulk-mode .toolbar-bulk-btn {
            background: var(--primary-color);
            color: #fff;
            border-color: var(--primary-color);
          }
          .bulk-action-bar {
            position: sticky;
            bottom: 10px;
            margin-top: 10px;
            padding: 8px 12px;
            background: var(--surface-color);
            border: 1px solid var(--focus-border);
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.45);
            border-radius: 10px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            z-index: 999;
            backdrop-filter: blur(8px);
            animation: slideUp 0.2s ease-out;
          }
          @keyframes slideUp {
            from { transform: translateY(20px); opacity: 0; }
            to { transform: translateY(0); opacity: 1; }
          }
          .bulk-info {
            font-size: 0.78rem;
            font-weight: 600;
            color: var(--text-primary);
          }
          .bulk-buttons {
            display: flex;
            align-items: center;
            gap: 6px;
          }
          .btn-bulk-action {
            padding: 3px 8px;
            font-size: 0.72rem;
            font-weight: 500;
            background: var(--surface-light);
            color: var(--text-primary);
            border: 1px solid var(--border-color);
            border-radius: 5px;
            cursor: pointer;
          }
          .btn-bulk-action:hover {
            background: var(--surface-color);
            border-color: var(--text-secondary);
          }
          .btn-bulk-primary {
            background: var(--primary-color) !important;
            color: #fff !important;
            border-color: var(--primary-color) !important;
          }
          .btn-bulk-primary:hover {
            background: var(--primary-light) !important;
          }
          .btn-bulk-export {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            padding: 3px 7px;
          }
          .workflow-hidden {
            display: none !important;
          }
        </style>

  `;
}
