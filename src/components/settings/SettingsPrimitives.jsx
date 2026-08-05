// @ts-check
// Shared building blocks for the Settings page, extracted verbatim from
// src/pages/Settings.jsx.
//
// Two details here are load-bearing and must not be "tidied":
//   - SettingsSection's memo comparator plus its
//     `typeof children === 'function' ? children() : children` body are what
//     keep an inactive section from rendering at all. Collapsing either one
//     turns every section into eager work on every Settings render.
//   - SettingRow's `data-setting-label` attribute and the exact label strings
//     are how e2e/settings-controls.spec.js targets individual controls.
import { cloneElement, isValidElement, memo, useId } from 'react';

export function SectionTitle({ children, id }) {
  return <div id={id} className="scroll-mt-24 text-xs font-bold uppercase tracking-widest text-muted-foreground px-1 mb-2 mt-6">{children}</div>;
}

export function SettingsSubheading({ children }) {
  return <div className="px-1 pt-3 pb-1 text-[11px] font-bold uppercase tracking-widest text-muted-foreground">{children}</div>;
}

/**
 * @param {{ id: string, activeId: string, children: any }} props
 */
export const SettingsSection = /** @type {any} */ (memo(function SettingsSection(props) {
  const { id, activeId, children } = /** @type {{ id: string, activeId: string, children: any }} */ (props);
  if (activeId !== id) return null;
  return (
    <div className="settings-section">
      {typeof children === 'function' ? children() : children}
    </div>
  );
}, (/** @type {any} */ previous, /** @type {any} */ next) => (
  previous.id === next.id && previous.activeId !== previous.id && next.activeId !== next.id
)));

export function SettingRow({ icon: Icon = null, label, sublabel = '', children = null, onClick = null, danger = false, disabled = false }) {
  const actionable = typeof onClick === 'function';
  // The row's label is the control's only visible name, but it lives in a sibling element, so
  // a screen reader announced every toggle here as an unnamed switch. Link them by id, once,
  // rather than repeating an aria-label at each of the many call sites.
  const labelId = `setting-label-${useId()}`;
  const labelledChildren = isValidElement(children) && !children.props['aria-label'] && !children.props['aria-labelledby']
    ? cloneElement(children, /** @type {any} */ ({ 'aria-labelledby': labelId }))
    : children;
  const activate = (event) => {
    if (!actionable || disabled) return;
    onClick(event);
  };

  return (
    <div
      data-setting-label={label}
      role={actionable ? 'button' : undefined}
      tabIndex={actionable && !disabled ? 0 : undefined}
      aria-disabled={actionable && disabled ? true : undefined}
      className={`scroll-mt-24 flex items-center justify-between gap-3 py-3 px-1 border-b border-border/50 last:border-0 ${actionable ? 'rounded-xl -mx-1 px-2 transition-colors' : ''} ${actionable && !disabled ? 'cursor-pointer hover:bg-secondary/50' : ''} ${actionable && disabled ? 'cursor-not-allowed opacity-60' : ''}`}
      onClick={activate}
      onKeyDown={(event) => {
        if (!actionable || disabled || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        activate(event);
      }}
    >
      <div className="flex items-center gap-3 flex-1 min-w-0">
        {Icon && (
          <div className={`w-8 h-8 rounded-xl flex items-center justify-center ${danger ? 'bg-red-50 dark:bg-red-950/30' : 'bg-secondary'}`}>
            <Icon className={`w-4 h-4 ${danger ? 'text-red-500' : 'text-muted-foreground'}`} />
          </div>
        )}
        <div className="min-w-0">
          <div id={labelId} className={`break-words text-sm font-medium ${danger ? 'text-red-600 dark:text-red-400' : ''}`}>{label}</div>
          {sublabel && <div className="mt-0.5 break-words text-xs text-muted-foreground">{sublabel}</div>}
        </div>
      </div>
      <div className="flex-shrink-0 max-w-[46%]">{labelledChildren}</div>
    </div>
  );
}

export function numberDraftValue(value, fallback) {
  return value === '' ? '' : value ?? fallback;
}

export function updateOptionalNumberDraft(updateCfg, key, rawValue) {
  if (rawValue === '') {
    updateCfg({ [key]: '' });
    return;
  }
  const number = Number(rawValue);
  if (Number.isFinite(number)) {
    updateCfg({ [key]: number });
  }
}

export function formatLegalNoticeDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

export const runAfterVisiblePaint = (callback) => {
  const run = () => window.setTimeout(callback, 0);
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(run);
  } else {
    setTimeout(callback, 0);
  }
};
