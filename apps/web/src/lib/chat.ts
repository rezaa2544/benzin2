/**
 * G-27 — what the thread says about numbers.
 *
 * The chat masks digits until the trade is accepted *and* the reader's plan includes numbers.
 * Those are two different things to ask of a person, so the banner has to name the actual reason
 * instead of the old one-size «تا تأیید سفارش پنهان می‌شوند» that was wrong half the time.
 */
export type ContactReason = 'TRADE_NOT_ACCEPTED' | 'SUBSCRIPTION_REQUIRED' | null;

export const chatNoticeKey = (reason: ContactReason): string =>
  reason === 'SUBSCRIPTION_REQUIRED' ? 'chat.maskedPlan' : 'chat.masked';

/** A contact card is worth offering only when the server would accept it. */
export const canShareContact = (view: {
  contactAllowed: boolean;
  contactReason: ContactReason;
}): boolean => view.contactAllowed && view.contactReason === null;
