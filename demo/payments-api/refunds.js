// payments-api: refund helpers.
// Fixture for the Sentinel offline demo.
export function isFreeRefund(refund) {
  return refund.amount == 0;
}

export function formatAmount(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}
