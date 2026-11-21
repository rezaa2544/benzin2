import { describe, expect, it } from 'vitest';
import { canShareContact, chatNoticeKey } from '../src/lib/chat.js';
import { t } from '../src/lib/i18n.js';

/**
 * G-27 in the customer app: the thread has to explain *which* rule is holding the numbers back.
 *
 * Server-side the rule is «accepted trade + a plan that includes numbers». Before this task the
 * screen always said «تا تأیید سفارش پنهان می‌شوند», which left a paying buyer staring at digits
 * they could not get and no hint that the seller had not paid.
 */
describe('chat masking copy (G-27)', () => {
  it('picks a different sentence for each reason', () => {
    expect(chatNoticeKey('TRADE_NOT_ACCEPTED')).toBe('chat.masked');
    expect(chatNoticeKey('SUBSCRIPTION_REQUIRED')).toBe('chat.maskedPlan');
    expect(t('chat.masked')).not.toBe(t('chat.maskedPlan'));
  });

  it('never tells someone to wait when the answer is «subscribe»', () => {
    expect(t('chat.maskedPlan')).toContain('اشتراک');
    expect(t('chat.masked')).not.toContain('اشتراک');
  });

  it('offers the contact card only when the server would accept it', () => {
    expect(canShareContact({ contactAllowed: true, contactReason: null })).toBe(true);
    expect(canShareContact({ contactAllowed: false, contactReason: 'SUBSCRIPTION_REQUIRED' })).toBe(
      false,
    );
    expect(canShareContact({ contactAllowed: false, contactReason: 'TRADE_NOT_ACCEPTED' })).toBe(
      false,
    );
  });
});
