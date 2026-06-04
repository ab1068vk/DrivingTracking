// Lightweight local toast state inspired by common toast patterns.
import { useState, useEffect } from "react";

const TOAST_LIMIT = 6;
const TOAST_REMOVE_DELAY = 300;
const DEFAULT_TOAST_DURATION = 5000;
const TOAST_DEDUPE_WINDOW_MS = 2500;

const actionTypes = {
  ADD_TOAST: "ADD_TOAST",
  UPDATE_TOAST: "UPDATE_TOAST",
  DISMISS_TOAST: "DISMISS_TOAST",
  REMOVE_TOAST: "REMOVE_TOAST",
};

let count = 0;

function genId() {
  count = (count + 1) % Number.MAX_VALUE;
  return count.toString();
}

const toastTimeouts = new Map();
const autoDismissTimeouts = new Map();
const recentToastKeys = new Map();

const clearAutoDismiss = (toastId) => {
  const timeout = autoDismissTimeouts.get(toastId);
  if (timeout) {
    clearTimeout(timeout);
    autoDismissTimeouts.delete(toastId);
  }
};

const addToRemoveQueue = (toastId) => {
  if (toastTimeouts.has(toastId)) {
    return;
  }

  const timeout = setTimeout(() => {
    toastTimeouts.delete(toastId);
    dispatch({
      type: actionTypes.REMOVE_TOAST,
      toastId,
    });
  }, TOAST_REMOVE_DELAY);

  toastTimeouts.set(toastId, timeout);
};

const _clearFromRemoveQueue = (toastId) => {
  const timeout = toastTimeouts.get(toastId);
  if (timeout) {
    clearTimeout(timeout);
    toastTimeouts.delete(toastId);
  }
};

const scheduleAutoDismiss = (toastId, /** @type {any} */ duration = DEFAULT_TOAST_DURATION) => {
  clearAutoDismiss(toastId);
  if (duration === Infinity || duration === false || duration === null) return;
  const ms = Number(duration);
  if (!Number.isFinite(ms) || ms <= 0) return;

  const timeout = setTimeout(() => {
    autoDismissTimeouts.delete(toastId);
    dispatch({ type: actionTypes.DISMISS_TOAST, toastId });
  }, ms);
  autoDismissTimeouts.set(toastId, timeout);
};

export const reducer = (state, action) => {
  switch (action.type) {
    case actionTypes.ADD_TOAST:
      scheduleAutoDismiss(action.toast.id, action.toast.duration);
      return {
        ...state,
        toasts: [action.toast, ...state.toasts].slice(0, TOAST_LIMIT),
      };

    case actionTypes.UPDATE_TOAST:
      return {
        ...state,
        toasts: state.toasts.map((t) =>
          t.id === action.toast.id ? { ...t, ...action.toast } : t
        ),
      };

    case actionTypes.DISMISS_TOAST: {
      const { toastId } = action;

      // ! Side effects ! - This could be extracted into a dismissToast() action,
      // but I'll keep it here for simplicity
      if (toastId) {
        clearAutoDismiss(toastId);
        addToRemoveQueue(toastId);
      } else {
        state.toasts.forEach((toast) => {
          clearAutoDismiss(toast.id);
          addToRemoveQueue(toast.id);
        });
      }

      return {
        ...state,
        toasts: state.toasts.map((t) =>
          t.id === toastId || toastId === undefined
            ? {
                ...t,
                open: false,
              }
            : t
        ),
      };
    }
    case actionTypes.REMOVE_TOAST:
      if (action.toastId === undefined) {
        autoDismissTimeouts.forEach((timeout) => clearTimeout(timeout));
        autoDismissTimeouts.clear();
        toastTimeouts.forEach((timeout) => clearTimeout(timeout));
        toastTimeouts.clear();
        return {
          ...state,
          toasts: [],
        };
      }
      clearAutoDismiss(action.toastId);
      return {
        ...state,
        toasts: state.toasts.filter((t) => t.id !== action.toastId),
      };
  }
};

const listeners = [];

let memoryState = { toasts: [] };

function dispatch(action) {
  memoryState = reducer(memoryState, action);
  listeners.forEach((listener) => {
    listener(memoryState);
  });
}

function toast({ ...props }) {
  const dedupeKey = props.dedupeKey || [
    props.variant || '',
    props.title || '',
    props.description || '',
  ].join('|');
  const now = Date.now();
  const recent = recentToastKeys.get(dedupeKey);
  if (recent && now - recent.at < TOAST_DEDUPE_WINDOW_MS) {
    dispatch({
      type: actionTypes.UPDATE_TOAST,
      toast: { ...props, id: recent.id, open: true },
    });
    scheduleAutoDismiss(recent.id, props.duration);
    return {
      id: recent.id,
      dismiss: () => dispatch({ type: actionTypes.DISMISS_TOAST, toastId: recent.id }),
      update: (nextProps) => dispatch({
        type: actionTypes.UPDATE_TOAST,
        toast: { ...nextProps, id: recent.id },
      }),
    };
  }

  const id = genId();
  recentToastKeys.set(dedupeKey, { id, at: now });

  const update = (props) =>
    dispatch({
      type: actionTypes.UPDATE_TOAST,
      toast: { ...props, id },
    });

  const dismiss = () =>
    dispatch({ type: actionTypes.DISMISS_TOAST, toastId: id });

  dispatch({
    type: actionTypes.ADD_TOAST,
    toast: {
      ...props,
      id,
      open: true,
      onOpenChange: (open) => {
        if (!open) dismiss();
      },
    },
  });

  return {
    id,
    dismiss,
    update,
  };
}

function useToast() {
  const [state, setState] = useState(memoryState);

  useEffect(() => {
    listeners.push(setState);
    return () => {
      const index = listeners.indexOf(setState);
      if (index > -1) {
        listeners.splice(index, 1);
      }
    };
  }, []);

  return {
    ...state,
    toast,
    dismiss: (toastId) => dispatch({ type: actionTypes.DISMISS_TOAST, toastId }),
  };
}

export { useToast, toast }; 
