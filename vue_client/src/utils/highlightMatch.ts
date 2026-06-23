// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Implementation lives in shared/ so the client render-time highlight check and
// the server insert-time stamp run one shared copy. This re-export keeps the
// local import path (../utils/highlightMatch.js) stable.
export * from '../../../shared/highlightMatch.js';
