// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Implementation moved to shared/ so the insert-time stamp and the client
// render-time evaluation run the exact same matcher (no hand-mirrored drift).
// This re-export keeps the local import path (./highlightEngine.js) stable.
export * from '../../shared/highlightMatch.js';
