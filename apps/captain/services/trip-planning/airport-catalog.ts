import { COUNTRY_ALIASES, COUNTRY_PRIMARY_AIRPORTS } from "./country-catalog.js";

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

const AIRPORTS: Readonly<Record<string, Omit<AirportMarket, "code">>> = {
  LOS: { label: "Lagos", country: "NG", currency: "NGN" },
  ANA: { label: "Anambra/Umuerri", country: "NG", currency: "NGN" },
  ABV: { label: "Abuja", country: "NG", currency: "NGN" },
  KAN: { label: "Kano", country: "NG", currency: "NGN" },
  PHC: { label: "Port Harcourt", country: "NG", currency: "NGN" },
  ENU: { label: "Enugu", country: "NG", currency: "NGN" },
  ABB: { label: "Asaba", country: "NG", currency: "NGN" },
  BNI: { label: "Benin City", country: "NG", currency: "NGN" },
  QUO: { label: "Uyo", country: "NG", currency: "NGN" },
  QOW: { label: "Owerri", country: "NG", currency: "NGN" },
  CBQ: { label: "Calabar", country: "NG", currency: "NGN" },
  ILR: { label: "Ilorin", country: "NG", currency: "NGN" },
  AKR: { label: "Akure", country: "NG", currency: "NGN" },
  IBA: { label: "Ibadan", country: "NG", currency: "NGN" },
  QRW: { label: "Warri", country: "NG", currency: "NGN" },
  KAD: { label: "Kaduna", country: "NG", currency: "NGN" },
  JOS: { label: "Jos", country: "NG", currency: "NGN" },
  BCU: { label: "Bauchi", country: "NG", currency: "NGN" },
  GMO: { label: "Gombe", country: "NG", currency: "NGN" },
  MIU: { label: "Maiduguri", country: "NG", currency: "NGN" },
  YOL: { label: "Yola", country: "NG", currency: "NGN" },
  SKO: { label: "Sokoto", country: "NG", currency: "NGN" },
  ACC: { label: "Accra", country: "GH", currency: "GHS" },
  ABJ: { label: "Abidjan", country: "CI", currency: "XOF" },
  DSS: { label: "Dakar", country: "SN", currency: "XOF" },
  DLA: { label: "Douala", country: "CM", currency: "XAF" },
  NSI: { label: "Yaoundé", country: "CM", currency: "XAF" },
  NBO: { label: "Nairobi", country: "KE", currency: "KES" },
  MBA: { label: "Mombasa", country: "KE", currency: "KES" },
  DAR: { label: "Dar es Salaam", country: "TZ", currency: "TZS" },
  JRO: { label: "Kilimanjaro", country: "TZ", currency: "TZS" },
  ZNZ: { label: "Zanzibar", country: "TZ", currency: "TZS" },
  JNB: { label: "Johannesburg", country: "ZA", currency: "ZAR" },
  CPT: { label: "Cape Town", country: "ZA", currency: "ZAR" },
  DUR: { label: "Durban", country: "ZA", currency: "ZAR" },
  ADD: { label: "Addis Ababa", country: "ET", currency: "ETB" },
  KGL: { label: "Kigali", country: "RW", currency: "RWF" },
  EBB: { label: "Entebbe", country: "UG", currency: "UGX" },
  CAI: { label: "Cairo", country: "EG", currency: "EGP" },
  CMN: { label: "Casablanca", country: "MA", currency: "MAD" },
  LON: { label: "London", country: "GB", currency: "GBP" },
  LHR: { label: "London Heathrow", country: "GB", currency: "GBP" },
  LGW: { label: "London Gatwick", country: "GB", currency: "GBP" },
  LCY: { label: "London City", country: "GB", currency: "GBP" },
  STN: { label: "London Stansted", country: "GB", currency: "GBP" },
  NYC: { label: "New York", country: "US", currency: "USD" },
  JFK: { label: "New York JFK", country: "US", currency: "USD" },
  EWR: { label: "Newark", country: "US", currency: "USD" },
  LGA: { label: "New York LaGuardia", country: "US", currency: "USD" },
  ATL: { label: "Atlanta", country: "US", currency: "USD" },
  LAX: { label: "Los Angeles", country: "US", currency: "USD" },
  SFO: { label: "San Francisco", country: "US", currency: "USD" },
  ORD: { label: "Chicago O'Hare", country: "US", currency: "USD" },
  YYZ: { label: "Toronto", country: "CA", currency: "CAD" },
  YVR: { label: "Vancouver", country: "CA", currency: "CAD" },
  PAR: { label: "Paris", country: "FR", currency: "EUR" },
  CDG: { label: "Paris Charles de Gaulle", country: "FR", currency: "EUR" },
  ORY: { label: "Paris Orly", country: "FR", currency: "EUR" },
  BER: { label: "Berlin", country: "DE", currency: "EUR" },
  FRA: { label: "Frankfurt", country: "DE", currency: "EUR" },
  MUC: { label: "Munich", country: "DE", currency: "EUR" },
  AMS: { label: "Amsterdam", country: "NL", currency: "EUR" },
  MAD: { label: "Madrid", country: "ES", currency: "EUR" },
  BCN: { label: "Barcelona", country: "ES", currency: "EUR" },
  LIS: { label: "Lisbon", country: "PT", currency: "EUR" },
  FCO: { label: "Rome Fiumicino", country: "IT", currency: "EUR" },
  MXP: { label: "Milan Malpensa", country: "IT", currency: "EUR" },
  TYO: { label: "Tokyo", country: "JP", currency: "JPY" },
  HND: { label: "Tokyo Haneda", country: "JP", currency: "JPY" },
  NRT: { label: "Tokyo Narita", country: "JP", currency: "JPY" },
  SIN: { label: "Singapore", country: "SG", currency: "SGD" }
};

const LOCATION_CODES: Readonly<Record<string, string>> = {
  lagos: "LOS",
  "murtala muhammed": "LOS",
  "murtala mohammed": "LOS",
  anambra: "ANA",
  umueri: "ANA",
  umuleri: "ANA",
  "chinua achebe": "ANA",
  abuja: "ABV",
  kano: "KAN",
  "port harcourt": "PHC",
  enugu: "ENU",
  asaba: "ABB",
  "benin city": "BNI",
  uyo: "QUO",
  owerri: "QOW",
  calabar: "CBQ",
  ilorin: "ILR",
  akure: "AKR",
  ibadan: "IBA",
  warri: "QRW",
  kaduna: "KAD",
  jos: "JOS",
  bauchi: "BCU",
  gombe: "GMO",
  maiduguri: "MIU",
  yola: "YOL",
  sokoto: "SKO",
  accra: "ACC",
  abidjan: "ABJ",
  dakar: "DSS",
  douala: "DLA",
  yaounde: "NSI",
  yaoundé: "NSI",
  nairobi: "NBO",
  mombasa: "MBA",
  "dar es salaam": "DAR",
  dar: "DAR",
  kilimanjaro: "JRO",
  zanzibar: "ZNZ",
  johannesburg: "JNB",
  "cape town": "CPT",
  durban: "DUR",
  "addis ababa": "ADD",
  kigali: "KGL",
  kampala: "EBB",
  entebbe: "EBB",
  cairo: "CAI",
  casablanca: "CMN",
  london: "LON",
  heathrow: "LHR",
  gatwick: "LGW",
  "london city": "LCY",
  stansted: "STN",
  "new york": "NYC",
  nyc: "NYC",
  jfk: "JFK",
  newark: "EWR",
  laguardia: "LGA",
  atlanta: "ATL",
  "los angeles": "LAX",
  "san francisco": "SFO",
  chicago: "ORD",
  "o'hare": "ORD",
  toronto: "YYZ",
  vancouver: "YVR",
  paris: "PAR",
  "charles de gaulle": "CDG",
  orly: "ORY",
  berlin: "BER",
  frankfurt: "FRA",
  munich: "MUC",
  amsterdam: "AMS",
  madrid: "MAD",
  barcelona: "BCN",
  lisbon: "LIS",
  rome: "FCO",
  fiumicino: "FCO",
  milan: "MXP",
  malpensa: "MXP",
  tokyo: "TYO",
  haneda: "HND",
  narita: "NRT",
  singapore: "SIN"
};

/**
 * Cities and countries share one alias table so a country reads as a location
 * everywhere a city does — the mention count that gates itinerary planning is
 * the same counter, and a country that resolves to nothing silently shortens
 * an itinerary.
 */
const ALL_LOCATION_CODES: Readonly<Record<string, string>> = {
  ...LOCATION_CODES,
  ...Object.fromEntries(
    Object.entries(COUNTRY_PRIMARY_AIRPORTS).map(([alias, entry]) => [alias, entry.code])
  )
};

const ORDERED_ALIASES = Object.keys(ALL_LOCATION_CODES)
  .sort((left, right) => right.length - left.length);
const LOCATION_PATTERN = new RegExp(
  String.raw`\b(${ORDERED_ALIASES.map(escapeRegex).join("|")})\b`,
  "giu"
);

export function airportMarket(code: string): AirportMarket | null {
  const normalized = code.trim().toUpperCase();
  const airport = AIRPORTS[normalized];
  return airport ? { code: normalized, ...airport } : null;
}

/**
 * Every code this catalog can resolve a traveller's words to. Exposed so the
 * metropolitan-overlay invariant can be asserted: a city-level code that no
 * provider recognises passes planning and then discards every offer.
 */
export function knownAirportCodes(): ReadonlySet<string> {
  return new Set([...Object.keys(AIRPORTS), ...Object.values(ALL_LOCATION_CODES)]);
}

export function airportCodeForLocation(value: string): string | null {
  const trimmed = value.trim();
  if (/^[A-Z]{3}$/u.test(trimmed)) return trimmed;
  return ALL_LOCATION_CODES[normalizeText(trimmed)] ?? null;
}

export function airportCodeAtStart(value: string): string | null {
  const normalized = normalizeText(value);
  const alias = ORDERED_ALIASES.find((candidate) =>
    normalized === candidate || normalized.startsWith(`${candidate} `)
  );
  return alias ? ALL_LOCATION_CODES[alias] ?? null : null;
}

/**
 * Explains a country guess so it can be reviewed. Alternatives are derived
 * from the catalog rather than listed by hand, so Captain only ever offers a
 * city it can actually search — and offers none where the catalog holds a
 * single city for the country, as it does for Japan.
 */
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

export function countryAirportGuess(alias: string): CountryAirportGuess | null {
  const entry = COUNTRY_PRIMARY_AIRPORTS[normalizeText(alias)];
  if (!entry) return null;
  const primary = AIRPORTS[entry.code];
  if (!primary) return null;
  const alternatives = Object.entries(AIRPORTS)
    .filter(([code, airport]) =>
      code !== entry.code
      && airport.country === primary.country
      // Sub-airports of the same city are the same choice, not another one:
      // "Tokyo Haneda" is not an alternative to Tokyo.
      && !airport.label.startsWith(primary.label)
    )
    .map(([, airport]) => airport.label)
    .slice(0, 3);
  return { code: entry.code, countryLabel: entry.label, alternatives };
}

export function orderedAirportCodesFromText(value: string): string[] {
  const codes = orderedAirportMentionsFromText(value).map((mention) => mention.code);
  return uniqueAdjacent(codes);
}

/**
 * Location evidence with source offsets. Planning constraints use the offsets
 * to associate presence dates with cities before any flight legs exist.
 */
export function orderedAirportMentionsFromText(value: string): AirportMention[] {
  const normalized = normalizeTextWithOffsets(value);
  return [...normalized.text.matchAll(LOCATION_PATTERN)]
    .map((match) => {
      const normalizedIndex = match.index;
      const sourceStart = normalized.offsets[normalizedIndex] ?? 0;
      const sourceEndIndex = normalizedIndex + match[0].length - 1;
      const sourceEnd = (normalized.offsets[sourceEndIndex] ?? sourceStart) + 1;
      return {
        code: ALL_LOCATION_CODES[match[1]!]!,
        index: sourceStart,
        evidence: value.slice(sourceStart, sourceEnd),
        assumed: COUNTRY_ALIASES.has(match[1]!)
      };
    })
    .filter((mention, index, all) =>
      index === 0 || mention.code !== all[index - 1]!.code
    );
}

export function allowedModelAirportCodes(value: string): ReadonlySet<string> {
  const explicitCodes = [...value.matchAll(/\b[A-Z]{3}\b/gu)].map((match) => match[0]!);
  return new Set([...orderedAirportCodesFromText(value), ...explicitCodes]);
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

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function uniqueAdjacent(values: string[]): string[] {
  return values.filter((value, index) => index === 0 || value !== values[index - 1]);
}
