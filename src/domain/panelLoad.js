// The tri-state a panel that fetches its own data renders.
//
// `idle` nobody has asked for this panel's rows yet
// `loading` the request is out
// `loaded` the rows are in hand and a finding may be stated
// `error` the request failed, and the panel says what and offers to retry
//
// IDLE AND LOADING ARE NOT EMPTY. "Every algorithm cohort with a clear majority
// is running one configuration" is a finding; printing it over rows that never
// arrived is this change's worst possible outcome, and it is exactly what a
// panel does if it tests its own output for emptiness instead of asking here.
//
// A panel with no load state at all reads as loaded, so every existing caller
// and every test fixture keeps working: a component rendered with rows already
// in its props has nothing to wait for.

export function panelIsLoaded(load) {
  return (load?.status || 'loaded') === 'loaded';
}

export const PANEL_LOAD_STATES = ['idle', 'loading', 'loaded', 'error'];
