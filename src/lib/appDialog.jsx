import { useEffect, useRef, useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';

const listeners = new Set();
let nextDialogId = 1;

const asDialogOptions = (options, fallbackTitle) => (
  typeof options === 'string'
    ? { title: fallbackTitle, message: options }
    : { title: fallbackTitle, ...(options || {}) }
);

const fallbackMessage = (dialog) => (
  [
    dialog.title,
    dialog.message,
    dialog.requiredText ? (dialog.inputLabel || `Type ${dialog.requiredText} to continue.`) : '',
  ].filter(Boolean).join('\n\n')
);

const browserConfirmFallback = (dialog) => {
  if (dialog.requiredText) {
    if (typeof window !== 'undefined' && typeof window.prompt === 'function') {
      return window.prompt(fallbackMessage(dialog)) === dialog.requiredText;
    }
    return false;
  }
  if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
    return window.confirm(fallbackMessage(dialog));
  }
  return false;
};

const browserAlertFallback = (dialog) => {
  if (typeof window !== 'undefined' && typeof window.alert === 'function') {
    window.alert(fallbackMessage(dialog));
  }
};

const enqueueDialog = (dialog) => new Promise((resolve) => {
  if (!listeners.size) {
    if (dialog.type === 'confirm') resolve(browserConfirmFallback(dialog));
    else {
      browserAlertFallback(dialog);
      resolve();
    }
    return;
  }
  const item = {
    id: nextDialogId,
    ...dialog,
    resolve,
  };
  nextDialogId += 1;
  listeners.forEach((listener) => listener(item));
});

export const requestAppConfirm = (options) => {
  const dialog = asDialogOptions(options, 'Please confirm');
  return enqueueDialog({
    type: 'confirm',
    title: dialog.title || 'Please confirm',
    message: dialog.message || '',
    confirmLabel: dialog.confirmLabel || 'Continue',
    cancelLabel: dialog.cancelLabel || 'Cancel',
    destructive: dialog.destructive === true,
    requiredText: dialog.requiredText || '',
    inputLabel: dialog.inputLabel || '',
  });
};

export const requestAppAlert = (options) => {
  const dialog = asDialogOptions(options, 'Road Sage');
  return enqueueDialog({
    type: 'alert',
    title: dialog.title || 'Road Sage',
    message: dialog.message || '',
    confirmLabel: dialog.confirmLabel || 'OK',
  });
};

export function AppDialogHost() {
  const [queue, setQueue] = useState([]);
  const [confirmationText, setConfirmationText] = useState('');
  const settlingRef = useRef(false);
  const current = queue[0] || null;

  useEffect(() => {
    const listener = (dialog) => setQueue((items) => [...items, dialog]);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const settle = (result) => {
    if (!current || settlingRef.current) return;
    settlingRef.current = true;
    current.resolve(result);
    setQueue((items) => items.slice(1));
  };

  const isConfirm = current?.type === 'confirm';
  const confirmationMatches = !current?.requiredText || confirmationText === current.requiredText;

  useEffect(() => {
    settlingRef.current = false;
    setConfirmationText('');
  }, [current?.id]);

  return (
    <AlertDialog
      open={Boolean(current)}
      onOpenChange={(open) => {
        if (!open && current) settle(isConfirm ? false : undefined);
      }}
    >
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>{current?.title || 'Road Sage'}</AlertDialogTitle>
          {current?.message && (
            <AlertDialogDescription className="whitespace-pre-line">
              {current.message}
            </AlertDialogDescription>
          )}
        </AlertDialogHeader>
        {current?.requiredText && (
          <label className="grid gap-2 text-sm">
            <span className="font-medium text-foreground">
              {current.inputLabel || `Type ${current.requiredText} to continue.`}
            </span>
            <input
              value={confirmationText}
              onChange={(event) => setConfirmationText(event.target.value)}
              className="h-10 rounded-lg border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              autoComplete="off"
            />
          </label>
        )}
        <AlertDialogFooter>
          {isConfirm && (
            <AlertDialogCancel onClick={(event) => {
              event.preventDefault();
              settle(false);
            }}>
              {current.cancelLabel || 'Cancel'}
            </AlertDialogCancel>
          )}
          <AlertDialogAction
            onClick={(event) => {
              event.preventDefault();
              if (!confirmationMatches) return;
              settle(isConfirm ? true : undefined);
            }}
            disabled={!confirmationMatches}
            className={cn(
              current?.destructive &&
                'bg-red-600 text-white hover:bg-red-700 focus:ring-red-600 dark:bg-red-600 dark:hover:bg-red-500'
            )}
          >
            {current?.confirmLabel || (isConfirm ? 'Continue' : 'OK')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
