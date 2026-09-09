import type { LocatorSpec } from '../types/locator.js';

/**
 * Input-bound targeting. A capability can locate a control by an input value:
 * "the link whose text is {accountId}", "the row anchored on {memberId}". At
 * record time the recorder marks such targets with `fromInput`; here, at replay
 * time, we substitute the caller's actual input value before resolving. This is
 * the locator analogue of value parameterization, and it's what real back-office
 * tasks need ("find entity X and act on its row").
 */
export function bindSpec(spec: LocatorSpec, inputs: Record<string, string>): LocatorSpec {
  return {
    ...spec,
    strategies: spec.strategies.map((s) => {
      if (s.kind === 'text' && s.fromInput && inputs[s.fromInput] != null) {
        return { ...s, text: inputs[s.fromInput]! };
      }
      if (s.kind === 'relative' && s.anchor.fromInput && inputs[s.anchor.fromInput] != null) {
        return { ...s, anchor: { ...s.anchor, text: inputs[s.anchor.fromInput]! } };
      }
      return s;
    }),
  };
}
