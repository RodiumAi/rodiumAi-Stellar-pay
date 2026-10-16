/** All DOM writes go through textContent/attributes — never innerHTML (§11.4, Trusted Types). */
export function setText(doc: Document, id: string, text: string): void {
  const el = doc.getElementById(id);
  if (el !== null) el.textContent = text;
}

export function setBusy(doc: Document, busy: boolean): void {
  const button = doc.getElementById('pay-freighter');
  if (button instanceof HTMLButtonElement) {
    button.disabled = busy;
    button.setAttribute('aria-busy', String(busy));
  }
}

const STATUS_TEXT: Readonly<Record<string, string>> = {
  pending: 'Waiting for payment',
  underpaid: 'Partially paid — send the remaining amount',
  confirmed: 'Payment confirmed',
  expired: 'This payment request has expired',
  late_paid: 'Payment received after expiry — our team will review it',
  refunded: 'Payment refunded',
  incomplete: 'Waiting for your signature',
  active: 'Subscription active',
  past_due: 'Subscription payment overdue',
  canceled: 'Subscription canceled',
};

export function statusText(status: string): string {
  return new Map(Object.entries(STATUS_TEXT)).get(status) ?? 'Checking payment status';
}
