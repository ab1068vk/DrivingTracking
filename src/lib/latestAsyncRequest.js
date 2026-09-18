export const createLatestAsyncRequestGuard = () => {
  let generation = 0;
  return Object.freeze({
    begin: () => ++generation,
    isCurrent: (candidate) => candidate === generation,
    invalidate: () => { generation += 1; },
  });
};
