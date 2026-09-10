/**
 * Commission eligibility — unpaid sales are never eligible.
 * Business day is Africa/Nairobi calendar date of paid_at.
 */

function isCommissionEligible(sale, businessDayEAT) {
  if (!sale || sale.status !== 'paid' || !sale.paid_at) {
    return false;
  }
  const paidDay = toEatDate(sale.paid_at);
  return paidDay === businessDayEAT;
}

function toEatDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  // en-CA gives YYYY-MM-DD; timeZone forces EAT calendar day.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Nairobi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

function filterEligibleSales(sales, businessDayEAT) {
  return sales.filter((s) => isCommissionEligible(s, businessDayEAT));
}

module.exports = {
  isCommissionEligible,
  filterEligibleSales,
  toEatDate,
};
