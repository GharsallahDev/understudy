import type { ExpectedCondition } from '../types/conditions.js';

/**
 * A small library of reusable runtime conditions. These encode the "known
 * exceptional states" of the environment once, so every recorded capability
 * inherits sound handling instead of re-deriving it. They are declarative and
 * evaluated deterministically at replay, no model involved.
 *
 * The same condition code carries a deliberate disposition:
 *   - RECORD_NOT_FOUND / VALIDATION_ERROR / PERMISSION_DENIED -> business_outcome
 *     (legitimate results the caller must handle, not crashes)
 *   - UNEXPECTED_DIALOG / TRANSIENT_LOAD -> recoverable (dismiss / wait+retry)
 *   - SESSION_TIMEOUT -> escalate (reauth is a platform concern; hand off)
 *   - APP_ERROR -> hard_failure (stop, surface a debuggable error)
 */

export const conditions = {
  sessionTimeout: (): ExpectedCondition => ({
    code: 'SESSION_TIMEOUT',
    disposition: 'escalate',
    detect: { anyText: ['session has expired', 'please sign in again'] },
    onDetect: 'reauth',
    note: 'Session/auth expired mid-run. Reauth is a platform concern; hand off for re-authentication, then retry the step.',
    maxRetries: 1,
  }),

  interstitial: (): ExpectedCondition => ({
    code: 'UNEXPECTED_DIALOG',
    disposition: 'recoverable',
    detect: { role: 'dialog', roleName: 'System Notice', anyText: ['System Notice', 'maintenance window'] },
    onDetect: 'dismiss_and_retry',
    dismissText: 'Acknowledge',
    note: 'A known interstitial can appear on any screen. Dismiss it and re-attempt the step.',
    maxRetries: 2,
  }),

  appError: (): ExpectedCondition => ({
    code: 'APP_ERROR',
    disposition: 'hard_failure',
    // Either signal is sufficient: a 5xx status or an application-error page (some
    // apps render errors with HTTP 200; some 5xx pages lack magic text).
    detect: {
      anyOf: [
        { httpStatusGte: 500 },
        { anyText: ['application error', 'an unexpected error occurred', 'internal server error', '500 -'] },
      ],
    },
    onDetect: 'fail',
    note: 'Server/app error. Stop and surface a debuggable failure.',
    maxRetries: 0,
  }),

  transientLoad: (): ExpectedCondition => ({
    code: 'TRANSIENT_LOAD',
    disposition: 'recoverable',
    detect: { anyText: ['loading', 'please wait'] },
    onDetect: 'wait_and_retry',
    note: 'Transient slow/partial load. Back off and retry the step.',
    maxRetries: 2,
  }),

  recordNotFound: (entity = 'member'): ExpectedCondition => ({
    code: 'RECORD_NOT_FOUND',
    disposition: 'business_outcome',
    detect: { anyText: [`no ${entity} found`], role: 'alert' },
    onDetect: 'return_outcome',
    outcomeCode: `${entity.toUpperCase()}_NOT_FOUND`,
    note: `A lookup legitimately returned nothing. This is a business outcome the caller needs, not a failure.`,
    maxRetries: 0,
  }),

  validationError: (): ExpectedCondition => ({
    code: 'VALIDATION_ERROR',
    disposition: 'business_outcome',
    detect: { anyText: ['minimum opening deposit', 'must be a valid', 'is required', 'please enter'], role: 'alert' },
    onDetect: 'return_outcome',
    outcomeCode: 'VALIDATION_FAILED',
    note: 'The app rejected the input. Surface it to the caller as a business outcome with the message.',
    maxRetries: 0,
  }),

  loginError: (): ExpectedCondition => ({
    code: 'PERMISSION_DENIED',
    disposition: 'business_outcome',
    detect: { anyText: ['epic sadface', 'locked out', 'do not match', 'could not be verified', 'username is required', 'password is required', 'invalid credentials'] },
    onDetect: 'return_outcome',
    outcomeCode: 'LOGIN_FAILED',
    note: 'Authentication failed (bad/locked credentials). A business outcome the caller must handle, not a crash.',
    maxRetries: 0,
  }),

  permissionDenied: (): ExpectedCondition => ({
    code: 'PERMISSION_DENIED',
    disposition: 'business_outcome',
    detect: { anyText: ['permission denied', 'not permitted', 'supervisor override'] },
    onDetect: 'return_outcome',
    outcomeCode: 'PERMISSION_DENIED',
    note: 'The operation is not allowed for this member/role. A legitimate business outcome.',
    maxRetries: 0,
  }),
};

/** Conditions that can occur on any screen, attached globally to every capability. */
export function globalConditionSet(): ExpectedCondition[] {
  return [conditions.sessionTimeout(), conditions.interstitial(), conditions.appError(), conditions.transientLoad()];
}
