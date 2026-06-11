// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Curated "pick a network" catalogue for the add-network flow (#169). The raw
// data is hand-maintained in builtinNetworks.json (seeded from the netsplit.de
// top-100 + MansionNET, connection details verified per network). This module
// just types it and derives the tag facet list for the picker's filter chips.

import data from './builtinNetworks.json';

export interface BuiltinNetwork {
  name: string;
  host: string;
  port: number;
  tls: boolean;
  website: string;
  /** Approximate concurrent users (netsplit snapshot), for sort/popularity. null if unknown. */
  users: number | null;
  /** Approximate channel count (netsplit snapshot). null if unknown. */
  channels: number | null;
  saslSupported: boolean;
  /** True when a client on a cloud/datacenter IP likely needs SASL to connect (e.g. Libera). */
  saslLikelyRequired: boolean;
  tags: string[];
}

// Sorted most-popular-first so the picker's default order is meaningful; entries
// without a user count sink to the bottom but keep their relative input order.
export const builtinNetworks: BuiltinNetwork[] = (data as BuiltinNetwork[]).toSorted(
  (a, b) => (b.users ?? -1) - (a.users ?? -1),
);

// Distinct tags across the catalogue, alphabetised — the picker renders these as
// toggle chips. Derived rather than hardcoded so editing the JSON is enough.
export const builtinNetworkTags: string[] = [
  ...new Set(builtinNetworks.flatMap((n) => n.tags)),
].toSorted();
