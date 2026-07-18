// @ts-check
import { Link } from 'react-router-dom';

export function PageHeader({
  title,
  description = '',
  icon: Icon = null,
  backTo = '',
  backLabel = 'Back',
  actions = null,
  status = null,
}) {
  return (
    <div className="app-page-header flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        {backTo && (
          <Link to={backTo} className="text-xs font-semibold text-primary hover:underline">
            {backLabel}
          </Link>
        )}
        <h1 className={`${backTo ? 'mt-2 ' : ''}break-words text-2xl font-grotesk font-bold tracking-normal`}>
          {title}
        </h1>
        {description && (
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            {description}
          </p>
        )}
        {status && <div className="mt-2 flex flex-wrap gap-2">{status}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {actions}
        {Icon && (
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Icon className="h-5 w-5" />
          </div>
        )}
      </div>
    </div>
  );
}

export function PageEmptyState({
  icon: Icon = null,
  title,
  description = '',
  children = null,
}) {
  return (
    <div className="flex flex-col items-center rounded-3xl border border-dashed border-border bg-card px-4 py-14 text-center">
      {Icon && <Icon className="mb-3 h-12 w-12 text-muted-foreground" />}
      <div className="font-semibold">{title}</div>
      {description && (
        <div className="mt-1 max-w-sm text-sm text-muted-foreground">
          {description}
        </div>
      )}
      {children && <div className="mt-6 w-full">{children}</div>}
    </div>
  );
}
