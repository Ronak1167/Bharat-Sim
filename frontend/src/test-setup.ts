// React 18/19 test utilities use this flag to enable act() environment checks.
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  configurable: true,
  value: true,
});
