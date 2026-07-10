// CAM subscription price for a client. Fixed option set requested by management.
// Used by the data layer (supabaseStore) and by the client form dropdown so both
// share one source of truth.

export const SUBSCRIPTION_PRICES = ['$500', '$250', 'Free', 'Undetermined'];

export const DEFAULT_SUBSCRIPTION_PRICE = 'Undetermined';

// Coerce any stored/incoming value to a valid option, falling back to the default.
export function normalizeSubscriptionPrice(value) {
  return SUBSCRIPTION_PRICES.includes(value) ? value : DEFAULT_SUBSCRIPTION_PRICE;
}
