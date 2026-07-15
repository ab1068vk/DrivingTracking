const listeners = new Set();
const activeTasks = new Map();
let nextTaskId = 1;

const snapshot = () => {
  const tasks = [...activeTasks.values()];
  return {
    busy: tasks.length > 0,
    count: tasks.length,
    label: tasks.at(-1)?.label || 'Working',
  };
};

const emit = () => {
  const state = snapshot();
  listeners.forEach((listener) => listener(state));
};

export const subscribeToInteractionFeedback = (listener) => {
  listeners.add(listener);
  listener(snapshot());
  return () => {
    listeners.delete(listener);
  };
};

export const beginInteractionTask = (label = 'Working', { timeoutMs = 20_000 } = {}) => {
  const id = `interaction_${nextTaskId++}`;
  const timeout = window.setTimeout(() => {
    if (!activeTasks.delete(id)) return;
    emit();
  }, timeoutMs);
  activeTasks.set(id, { id, label, timeout });
  emit();
  return id;
};

export const endInteractionTask = (id) => {
  const task = activeTasks.get(id);
  if (!task) return;
  window.clearTimeout(task.timeout);
  activeTasks.delete(id);
  emit();
};

let navigationTaskId = null;

export const beginNavigationFeedback = (label = 'Opening page') => {
  if (navigationTaskId) endInteractionTask(navigationTaskId);
  navigationTaskId = beginInteractionTask(label, { timeoutMs: 15_000 });
  return navigationTaskId;
};

export const endNavigationFeedback = () => {
  if (!navigationTaskId) return;
  endInteractionTask(navigationTaskId);
  navigationTaskId = null;
};
