const METROPOLITAN_AIRPORTS: Readonly<Record<string, readonly string[]>> = {
  NYC: ["JFK", "EWR", "LGA", "NYC"],
  LON: ["LHR", "LGW", "STN", "LCY", "LTN", "LON"],
  PAR: ["CDG", "ORY", "PAR"],
  TYO: ["HND", "NRT", "TYO"]
};

/**
 * Whether an airport returned by inventory belongs to one of the requested
 * airport or metropolitan codes. The same rule is shared by every provider
 * and by Captain's per-leg result canonicalizer so a valid EWR result cannot
 * pass discovery and then disappear merely because the traveller wrote NYC.
 */
export function airportCodeMatches(
  requestedCodes: readonly string[],
  actualCode: string
): boolean {
  const actual = actualCode.trim().toUpperCase();
  return requestedCodes.some((requestedCode) => {
    const requested = requestedCode.trim().toUpperCase();
    if (requested === actual) return true;
    const requestedGroup = METROPOLITAN_AIRPORTS[requested];
    if (requestedGroup?.includes(actual)) return true;
    return false;
  });
}
