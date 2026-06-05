import { toast } from '@/components/ui/use-toast';
import { logError } from '@/lib/errorReporting';

const DEFAULT_ERROR_TITLE = 'Something went wrong';
const DEFAULT_ERROR_DESCRIPTION = 'Road Sage could not finish that action. Please try again.';
const USER_MESSAGE_DEDUPE_MS = 2500;
const recentMessages = new Map();

const CONTEXT_TITLES = {
  app_bootstrap: 'App startup problem',
  api_request: 'Connection problem',
  query_error: 'Could not load data',
  mutation_error: 'Could not save changes',
  react_section_error: 'Section unavailable',
  storage_key_migration: 'Storage update delayed',
};

const CONTEXT_DESCRIPTIONS = {
  app_bootstrap: 'Some startup checks failed. The app will keep running, but a few settings may refresh later.',
  api_request: 'Check your connection or backend settings, then try again.',
  query_error: 'Road Sage could not load the latest local data. Stored information may be temporarily stale.',
  mutation_error: 'Your change was not saved. Please try again.',
  react_section_error: 'This section could not be displayed. Reload the page to try again.',
  storage_key_migration: 'Road Sage could not finish updating old storage keys. Your existing data was left in place.',
};

const isAbortError = (error) => (
  error?.name === 'AbortError' ||
  String(error?.message || '').toLowerCase().includes('abort')
);

const trimSentence = (value, maxLength = 180) => {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trim()}...` : text;
};

export function describeUserError(error, fallbackDescription = DEFAULT_ERROR_DESCRIPTION) {
  if (!error) return fallbackDescription;
  if (isAbortError(error)) return 'The request was cancelled before it finished.';
  if (error.status === 401 || error.status === 403) {
    return 'You do not have permission to complete this action. Sign in again or check app permissions.';
  }
  if (error.status === 404) return 'The requested item could not be found.';
  if (error.status >= 500) return 'The server could not complete the request. Try again in a moment.';
  if (error.name === 'ApiError' && /No backend API configured/i.test(error.message || '')) {
    return 'No backend is configured, so Road Sage is using local storage when available.';
  }
  if (error.name === 'ApiError' && /not trusted/i.test(error.message || '')) {
    return trimSentence(error.message);
  }
  if (/network|fetch|failed to fetch|load failed|internet/i.test(error.message || '')) {
    return 'Network access failed. Check your connection and try again.';
  }
  return trimSentence(error.message, 180) || fallbackDescription;
}

export function notifyUserError(context, error, options = {}) {
  if (isAbortError(error) && options.showAbort !== true) return null;

  const title = options.title || CONTEXT_TITLES[context] || DEFAULT_ERROR_TITLE;
  const description = options.description || describeUserError(
    error,
    CONTEXT_DESCRIPTIONS[context] || DEFAULT_ERROR_DESCRIPTION
  );
  const dedupeKey = options.dedupeKey || `${context}|${title}|${description}`;
  const now = Date.now();
  const recent = recentMessages.get(dedupeKey);
  if (recent && now - recent < USER_MESSAGE_DEDUPE_MS) {
    if (options.log !== false) logError(context, error, options.extra);
    return null;
  }

  recentMessages.set(dedupeKey, now);
  if (options.log !== false) logError(context, error, options.extra);

  return toast({
    title,
    description,
    variant: options.variant || 'destructive',
    dedupeKey,
    duration: options.duration,
  });
}

export function notifyUserMessage(context, options = {}) {
  const title = options.title || 'Done';
  const description = options.description || '';
  const dedupeKey = options.dedupeKey || `${context}|${title}|${description}`;
  const now = Date.now();
  const recent = recentMessages.get(dedupeKey);
  if (recent && now - recent < USER_MESSAGE_DEDUPE_MS) return null;

  recentMessages.set(dedupeKey, now);

  return toast({
    title,
    description,
    variant: options.variant || 'default',
    dedupeKey,
    duration: options.duration,
  });
}

export function notifyUserSuccess(context, options = {}) {
  return notifyUserMessage(context, {
    ...options,
    variant: options.variant || 'default',
  });
}

export async function runWithUserError(context, task, options = {}) {
  try {
    return await task();
  } catch (error) {
    notifyUserError(context, error, options);
    if (options.rethrow !== false) throw error;
    return options.fallback;
  }
}
