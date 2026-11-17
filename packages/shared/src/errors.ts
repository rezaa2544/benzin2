/** Stable, user-facing error codes. Clients map them to Persian copy; never parse messages. */
export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'TOKEN_EXPIRED',
  'TOKEN_INVALID',
  'REFRESH_TOKEN_INVALID',
  'REFRESH_TOKEN_REUSED',
  'FORBIDDEN',
  'NOT_FOUND',
  'RATE_LIMITED',
  'OTP_INVALID',
  'OTP_EXPIRED',
  'OTP_ATTEMPTS_EXCEEDED',
  'PHONE_LOCKED',
  'SMS_UNAVAILABLE',
  'ACCOUNT_SUSPENDED',
  'SUBSCRIPTION_REQUIRED',
  /** G-26: the plan's monthly allowance is spent; the app offers the cheapest paid plan. */
  'RESERVATION_QUOTA_EXHAUSTED',
  /** G-19: seeing a number is part of a paid plan. */
  'PHONE_REQUIRES_SUBSCRIPTION',
  /** The catalogue lost its free plan — a deployment bug the API must not paper over. */
  'FREE_PLAN_MISSING',
  'ZONE_NOT_SUPPORTED',
  'ZONE_MISMATCH',
  'OUTSIDE_ZONE',
  'ORDER_NOT_AVAILABLE',
  'ORDER_LIMIT_REACHED',
  'RESERVATION_LIMIT_REACHED',
  'RESERVATION_NOT_FOUND',
  'RESERVATION_NOT_ACTIVE',
  'TRADE_CYCLE_BLOCKED',
  'NOT_ORDER_OWNER',
  'NOT_RESERVATION_PARTY',
  'NOT_RESERVATION_TAKER',
  'EXTENSION_LIMIT_REACHED',
  'PLAN_CODE_TAKEN',
  'PLAN_NOT_FOUND',
  /** G-13: two infrastructure rows cannot share a name. */
  'INFRA_NAME_TAKEN',
  'INFRA_NOT_FOUND',
  'FREE_PLAN_REQUIRED',
  'CONVERSATION_NOT_FOUND',
  'CONVERSATION_CLOSED',
  'NOT_CONVERSATION_PARTY',
  'CONTACT_SHARING_BLOCKED',
  'MESSAGE_TOO_LONG',
  'NOTIFICATION_NOT_FOUND',
  'ALREADY_RATED',
  'PLAN_NOT_FOUND',
  'PAYMENT_NOT_FOUND',
  'PAYMENT_ALREADY_SETTLED',
  'PAYMENT_NOT_PAYABLE',
  'NO_PAYMENT_CARD',
  'PAYMENT_VERIFICATION_FAILED',
  'USER_NOT_FOUND',
  'ZONE_NOT_FOUND',
  'PROVIDER_NOT_FOUND',
  'PROVIDER_TEST_FAILED',
  'DISPUTE_NOT_OPEN',
  'OWNER_ALREADY_EXISTS',
  'INVALID_STATE_TRANSITION',
  'ALREADY_DECIDED',
  'CONFLICT',
  'NODE_TOKEN_INVALID',
  'NODE_AGENT_DISABLED',
  // G-09 — the four-digit hand-over code.
  'DELIVERY_CODE_REQUIRED',
  'DELIVERY_CODE_INVALID',
  'DELIVERY_CODE_LOCKED',
  'DELIVERY_CODE_BUYER_ONLY',
  /** G-10: admin tried to relist a seller whose listings were never paused. */
  'NOT_DELISTED',
  /** G-11: the buyer sent a tracking number while the platform confirms transfers automatically. */
  'CARD_REVIEW_DISABLED',
  /** G-11: the deposit webhook is switched off (no secret configured) or the signature is wrong. */
  'CARD_WEBHOOK_DISABLED',
  'CARD_WEBHOOK_UNAUTHORIZED',
  'DEPOSIT_NOT_FOUND',
  'DEPOSIT_ALREADY_MATCHED',
  'INTERNAL_ERROR',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, httpStatus: number, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }

  static notFound(code: ErrorCode = 'NOT_FOUND', message = 'Resource not found'): AppError {
    return new AppError(code, 404, message);
  }

  static forbidden(code: ErrorCode = 'FORBIDDEN', message = 'Not allowed'): AppError {
    return new AppError(code, 403, message);
  }

  static conflict(code: ErrorCode = 'CONFLICT', message = 'Conflicting state'): AppError {
    return new AppError(code, 409, message);
  }

  static validation(message = 'Invalid input', details?: unknown): AppError {
    return new AppError('VALIDATION_ERROR', 422, message, details);
  }

  static unauthorized(message = 'Authentication required'): AppError {
    return new AppError('UNAUTHORIZED', 401, message);
  }
}

export const isAppError = (error: unknown): error is AppError => error instanceof AppError;
