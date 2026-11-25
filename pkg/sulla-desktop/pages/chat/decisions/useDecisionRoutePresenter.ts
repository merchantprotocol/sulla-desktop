// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { useSullaSetting } from '@pkg/composables/preferences/useSullaSetting';

import { DecisionRoutePresenter, type DecisionRouteClock } from './DecisionRoutePresenter';

/** Renderer entry point; keeps the presenter pure while supplying the signed-in display name. */
export function useDecisionRoutePresenter(clock: DecisionRouteClock): DecisionRoutePresenter {
  const humanName = useSullaSetting('primaryUserName', '', 'string', { refreshOnFocus: true });
  return new DecisionRoutePresenter(clock, () => humanName.value.value);
}
