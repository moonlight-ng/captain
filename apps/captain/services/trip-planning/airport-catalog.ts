import {
  AIRPORT_ALIAS_ROWS,
  AIRPORT_ROWS,
  COUNTRY_CITY_ROWS
} from "./airport-data.generated.js";
import {
  COUNTRY_ALTERNATIVE_CITIES,
  COUNTRY_PRIMARY_AIRPORTS
} from "./country-catalog.js";

export type AirportMarket = {
  code: string;
  label: string;
  country: string;
  currency: string;
};

export type AirportMention = {
  code: string;
  index: number;
  evidence: string;
  /**
   * True when the traveller named a country and Captain picked its primary
   * airport. The city is Captain's guess, so it has to be reviewable rather
   * than silently searched.
   */
  assumed: boolean;
};

export type CountryAirportGuess = {
  code: string;
  /** The country as named, for copy: "Tokyo — Japan's main airport". */
  countryLabel: string;
  /** Other cities in the same country the catalog can actually search. */
  alternatives: string[];
};

type Airport = AirportMarket & { latitude: number; longitude: number };
type Alias = {
  code: string;
  /**
   * The alias is also an ordinary English word — Nice, Split, Reading. It
   * resolves only with a capital letter or a place preposition in front of
   * it, so "a nice flight" stays a sentence.
   */
  ambiguous: boolean;
  /** Named a country, so the city is Captain's pick and must be reviewable. */
  assumed: boolean;
};

/** Longest alias in the index, in words: "united states of america". */
const MAX_ALIAS_WORDS = 4;
/**
 * A word in front of a place name that says it is one. Enough on its own to
 * read an ambiguous alias as a city: "then Nice for two nights" is a stop,
 * "that's a nice flight" is not.
 */
const PLACE_PREPOSITIONS = new Set([
  "from", "to", "via", "in", "into", "through", "toward", "towards",
  "then", "at", "near", "visiting", "visit", "reach", "reaching",
  "arrive", "arriving", "depart", "departing", "leaving", "stopping", "stop"
]);

function parseRows(block: string): string[][] {
  return block.split("\n").filter(Boolean).map((line) => line.split("\t"));
}

const AIRPORTS: ReadonlyMap<string, Airport> = new Map(
  parseRows(AIRPORT_ROWS).map(([code, label, country, currency, latitude, longitude]) => [
    code!,
    {
      code: code!,
      label: label!,
      country: country!,
      currency: currency!,
      latitude: Number(latitude),
      longitude: Number(longitude)
    }
  ])
);

const ALIASES: ReadonlyMap<string, Alias> = (() => {
  const index = new Map<string, Alias>();
  for (const [alias, code, flags] of parseRows(AIRPORT_ALIAS_ROWS)) {
    index.set(alias!, { code: code!, ambiguous: flags === "a", assumed: false });
  }
  // Countries resolve too, or an itinerary naming three places reads as two.
  // They are always a guess at a city, so they carry `assumed`.
  for (const [alias, entry] of Object.entries(COUNTRY_PRIMARY_AIRPORTS)) {
    index.set(alias, { code: entry.code, ambiguous: false, assumed: true });
  }
  return index;
})();

const COUNTRY_CITIES: ReadonlyMap<string, Array<{ code: string; label: string }>> = new Map(
  parseRows(COUNTRY_CITY_ROWS).map(([country, cities]) => [
    country!,
    (cities ?? "").split("|").filter(Boolean).map((entry) => {
      const [code, ...label] = entry.split("=");
      return { code: code!, label: label.join("=") };
    })
  ])
);

export function airportMarket(code: string): AirportMarket | null {
  const airport = AIRPORTS.get(code.trim().toUpperCase());
  if (!airport) return null;
  const { latitude: _latitude, longitude: _longitude, ...market } = airport;
  return market;
}

/**
 * Every code this catalog can resolve a traveller's words to. Exposed so the
 * metropolitan-overlay invariant can be asserted: a city-level code that no
 * provider recognises passes planning and then discards every offer.
 */
export function knownAirportCodes(): ReadonlySet<string> {
  return new Set(AIRPORTS.keys());
}

export function airportCodeForLocation(value: string): string | null {
  const trimmed = value.trim();
  // A bare three-letter code is only a code when it names an airport. Before
  // the catalog held every airport this returned anything shaped like one,
  // which made MAX, USD and PDF valid destinations.
  if (/^[A-Z]{3}$/u.test(trimmed)) return AIRPORTS.has(trimmed) ? trimmed : null;
  return ALIASES.get(normalizeText(trimmed))?.code ?? null;
}

export function airportCodeAtStart(value: string): string | null {
  const tokens = tokenize(normalizeText(value));
  for (let words = Math.min(MAX_ALIAS_WORDS, tokens.length); words >= 1; words -= 1) {
    const alias = ALIASES.get(tokens.slice(0, words).join(" "));
    if (alias) return alias.code;
  }
  return null;
}

/**
 * Explains a country guess so it can be reviewed. Alternatives come from the
 * catalog rather than a hand-written list, so Captain only ever offers a city
 * it can actually search.
 */
export function countryAirportGuess(alias: string): CountryAirportGuess | null {
  const entry = COUNTRY_PRIMARY_AIRPORTS[normalizeText(alias)];
  if (!entry) return null;
  const primary = AIRPORTS.get(entry.code);
  if (!primary) return null;
  const alternatives = (COUNTRY_ALTERNATIVE_CITIES[primary.country] ?? [])
    .filter((code) => code !== entry.code)
    .map((code) => AIRPORTS.get(code)?.label)
    .filter((label): label is string =>
      // Sub-airports of the same city are the same choice, not another one:
      // "Tokyo Haneda" is not an alternative to Tokyo.
      Boolean(label) && !label!.startsWith(primary.label) && !primary.label.startsWith(label!)
    )
    .slice(0, 3);
  return { code: entry.code, countryLabel: entry.label, alternatives };
}

/**
 * Reverse of {@link countryAirportGuess}: given an airport Captain assumed,
 * recovers the country that produced it so the confirmation can explain the
 * pick. Several aliases share a code (uk, britain, england all give LON); the
 * first declared wins, which is the one written for prose.
 */
export function countryGuessForAirport(code: string): CountryAirportGuess | null {
  const normalized = code.trim().toUpperCase();
  const alias = Object.keys(COUNTRY_PRIMARY_AIRPORTS)
    .find((candidate) => COUNTRY_PRIMARY_AIRPORTS[candidate]!.code === normalized);
  return alias ? countryAirportGuess(alias) : null;
}

export function orderedAirportCodesFromText(value: string): string[] {
  const codes = orderedAirportMentionsFromText(value).map((mention) => mention.code);
  return uniqueAdjacent(codes);
}

/**
 * Location evidence with source offsets. Planning constraints use the offsets
 * to associate presence dates with cities before any flight legs exist.
 *
 * Matching walks the words left to right and takes the longest alias starting
 * at each one, so "New York" is never also read as "York". A single
 * alternation over every alias in the catalog was fine at sixty cities and is
 * not at several thousand.
 */
export function orderedAirportMentionsFromText(value: string): AirportMention[] {
  const normalized = normalizeTextWithOffsets(value);
  const tokens = tokenizeWithSpans(normalized.text);
  const mentions: AirportMention[] = [];
  let cursor = 0;
  while (cursor < tokens.length) {
    const longest = Math.min(MAX_ALIAS_WORDS, tokens.length - cursor);
    let matched = 0;
    for (let words = longest; words >= 1; words -= 1) {
      const phrase = tokens.slice(cursor, cursor + words).map((token) => token.word).join(" ");
      const alias = ALIASES.get(phrase);
      if (!alias) continue;
      const sourceStart = normalized.offsets[tokens[cursor]!.start] ?? 0;
      const lastIndex = tokens[cursor + words - 1]!.end - 1;
      const sourceEnd = (normalized.offsets[lastIndex] ?? sourceStart) + 1;
      if (
        alias.ambiguous
        && !readsAsAPlace(value, sourceStart, tokens[cursor - 1]?.word)
        && !leadsToAPlace(tokens, cursor + words)
      ) {
        continue;
      }
      mentions.push({
        code: alias.code,
        index: sourceStart,
        evidence: value.slice(sourceStart, sourceEnd),
        assumed: alias.assumed
      });
      matched = words;
      break;
    }
    cursor += matched > 0 ? matched : 1;
  }
  return mentions.filter((mention, index, all) =>
    index === 0 || mention.code !== all[index - 1]!.code
  );
}

/**
 * Whether a word that is also ordinary English is being used as a place here.
 * A preposition that only ever precedes somewhere you go is evidence, and so
 * is a capital letter — but only mid-sentence. Every sentence starts with a
 * capital, so "Nice, thanks" would otherwise be a flight to the Riviera.
 */
function readsAsAPlace(
  value: string,
  sourceStart: number,
  previousWord: string | undefined
): boolean {
  if (previousWord !== undefined && PLACE_PREPOSITIONS.has(previousWord)) return true;
  const first = value[sourceStart] ?? "";
  if (first === first.toLocaleLowerCase("en")) return false;
  return !startsASentence(value, sourceStart);
}

/**
 * Whether what follows is "to somewhere Captain knows" — which makes the word
 * in front of it the other end of a route. Opening a message with "Marseille
 * to New York on Dec 9" offers no capital worth trusting and no preposition,
 * but the shape of the sentence is evidence enough.
 */
function leadsToAPlace(
  tokens: ReadonlyArray<{ word: string }>,
  index: number
): boolean {
  if (!PLACE_PREPOSITIONS.has(tokens[index]?.word ?? "")) return false;
  for (let words = MAX_ALIAS_WORDS; words >= 1; words -= 1) {
    const phrase = tokens.slice(index + 1, index + 1 + words).map((token) => token.word).join(" ");
    const alias = phrase ? ALIASES.get(phrase) : undefined;
    if (alias && !alias.ambiguous) return true;
  }
  return false;
}

function startsASentence(value: string, index: number): boolean {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const character = value[cursor]!;
    if (/\s/u.test(character)) continue;
    return /[.!?;:]/u.test(character);
  }
  return true;
}

export function allowedModelAirportCodes(value: string): ReadonlySet<string> {
  const explicitCodes = [...value.matchAll(/\b[A-Z]{3}\b/gu)]
    .map((match) => match[0]!)
    .filter((code) => AIRPORTS.has(code));
  return new Set([...orderedAirportCodesFromText(value), ...explicitCodes]);
}

function tokenize(text: string): string[] {
  return text.split(" ").filter(Boolean);
}

function tokenizeWithSpans(
  text: string
): Array<{ word: string; start: number; end: number }> {
  const tokens: Array<{ word: string; start: number; end: number }> = [];
  let start = -1;
  for (let index = 0; index <= text.length; index += 1) {
    const isSpace = index === text.length || text[index] === " ";
    if (!isSpace && start < 0) start = index;
    if (isSpace && start >= 0) {
      tokens.push({ word: text.slice(start, index), start, end: index });
      start = -1;
    }
  }
  return tokens;
}

function normalizeText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}']+/gu, " ")
    .trim();
}

function normalizeTextWithOffsets(value: string): { text: string; offsets: number[] } {
  let text = "";
  const offsets: number[] = [];
  let pendingSpace = false;
  for (let index = 0; index < value.length; index += 1) {
    const source = value[index]!;
    const normalized = source.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLowerCase();
    for (const character of normalized) {
      if (/[\p{Letter}\p{Number}']/u.test(character)) {
        if (pendingSpace && text.length > 0) {
          text += " ";
          offsets.push(index);
        }
        pendingSpace = false;
        text += character;
        offsets.push(index);
      } else {
        pendingSpace = true;
      }
    }
  }
  return { text, offsets };
}

function uniqueAdjacent(values: string[]): string[] {
  return values.filter((value, index) => index === 0 || value !== values[index - 1]);
}
