import { redactSensitiveValue } from '../privacy.js';
/** JSON escapes preserve content boundaries; controls/bidi are visible UTF-16 escapes. */
export function reviewText(value: unknown, pretty = true) {
  return JSON.stringify(value, null, pretty ? 2 : undefined).replace(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
    (c) =>
      c === '\n'
        ? c
        : c
            .split('')
            .map((u) => `\\u${u.charCodeAt(0).toString(16).padStart(4, '0')}`)
            .join(''),
  );
}
/** Values only: object keys and stable protocol names are never rewritten. */
export function redactReview<T>(value: T): T {
  return redactSensitiveValue(value) as T;
}
