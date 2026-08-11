/**
 * Hand-held corrections applied over the generated airport catalog.
 *
 * Everything here exists because the source data is wrong, is shaped for
 * aviation rather than conversation, or predates the generator. Keep each
 * entry's reason with it — an override nobody can justify later is one nobody
 * dares delete.
 */

/**
 * Display labels. Seeded with the exact wording of the hand-written catalog
 * this replaced, so swapping in the dataset changed no user-facing copy. The
 * generator's own labels are city names, which read fine; these mostly
 * survive where a city has several airports worth telling apart.
 */
export const LABEL_OVERRIDES: Readonly<Record<string, string>> = {
  ANA: "Anambra/Umuerri",
  NSI: "Yaoundé",
  DSS: "Dakar",
  LHR: "London Heathrow",
  LGW: "London Gatwick",
  LCY: "London City",
  STN: "London Stansted",
  JFK: "New York JFK",
  EWR: "Newark",
  LGA: "New York LaGuardia",
  ORD: "Chicago O'Hare",
  CDG: "Paris Charles de Gaulle",
  ORY: "Paris Orly",
  FCO: "Rome Fiumicino",
  MXP: "Milan Malpensa",
  HND: "Tokyo Haneda",
  NRT: "Tokyo Narita",
  DEL: "Delhi",
  ENU: "Enugu",
  // Airports sited in a commune next door, where the dataset's municipality is
  // a suburb nobody names. The city still resolves — its name is an alias
  // either way — but the label is what Captain prints back.
  MRS: "Marseille",
  BRU: "Brussels",
  EDI: "Edinburgh",
  ATH: "Athens",
  LYS: "Lyon",
  TLS: "Toulouse",
  FRA: "Frankfurt",
  CGN: "Cologne",
  LEJ: "Leipzig",
  FMO: "Münster",
  PAD: "Paderborn",
  FKB: "Karlsruhe",
  KSF: "Kassel",
  KRK: "Kraków",
  WMI: "Warsaw Modlin",
  NYO: "Stockholm Skavsta",
  OST: "Ostend",
  NOC: "Knock",
  NCL: "Newcastle",
  EMA: "East Midlands",
  IOM: "Isle of Man",
  DJE: "Djerba",
  GJL: "Jijel",
  ILR: "Ilorin",
  DAR: "Dar es Salaam",
  KEF: "Reykjavík"
};

/** Metropolitan codes are named for the city, not for any one airport. */
export const METROPOLITAN_LABELS: Readonly<Record<string, string>> = {
  LON: "London",
  NYC: "New York",
  PAR: "Paris",
  TYO: "Tokyo"
};

/**
 * Airports the filter drops but Captain still searches. The dataset lists
 * Anambra as a small field with no scheduled service; it has served flights
 * since, and travellers ask for it by three different names.
 */
export const AIRPORT_ADDITIONS: Readonly<Record<string, {
  label: string;
  country: string;
  currency: string;
  latitude: number;
  longitude: number;
  large: boolean;
  aliases: string[];
}>> = {
  ANA: {
    label: "Anambra/Umuerri",
    country: "NG",
    currency: "NGN",
    latitude: 6.334,
    longitude: 6.933,
    large: false,
    aliases: ["anambra", "umueri", "umuleri", "chinua achebe"]
  }
};

/**
 * Aliases the data cannot produce. Each is a name travellers use that the
 * source spells differently, abbreviates, or gets wrong.
 */
export const ALIAS_ADDITIONS: Readonly<Record<string, string>> = {
  // The source spells Enugu's municipality "Enegu".
  enugu: "ENU",
  // Municipality is "New Delhi"; nobody books a flight to New Delhi.
  delhi: "DEL",
  // Airport names, not city names — but they are what people say.
  heathrow: "LHR",
  gatwick: "LGW",
  stansted: "STN",
  luton: "LTN",
  "london city": "LCY",
  jfk: "JFK",
  "john f kennedy": "JFK",
  newark: "EWR",
  laguardia: "LGA",
  "la guardia": "LGA",
  "charles de gaulle": "CDG",
  orly: "ORY",
  haneda: "HND",
  narita: "NRT",
  "o'hare": "ORD",
  ohare: "ORD",
  fiumicino: "FCO",
  malpensa: "MXP",
  schiphol: "AMS",
  "murtala muhammed": "LOS",
  "murtala mohammed": "LOS",
  // Metropolitan codes: the city name resolves to the whole group.
  london: "LON",
  "new york": "NYC",
  nyc: "NYC",
  paris: "PAR",
  tokyo: "TYO",
  // Common spellings the dataset does not carry.
  marseilles: "MRS",
  bombay: "BOM",
  calcutta: "CCU",
  madras: "MAA",
  saigon: "SGN",
  "ho chi minh": "SGN",
  peking: "PEK",
  "cologne": "CGN",
  "the hague": "AMS",
  dar: "DAR",
  kampala: "EBB"
};

/**
 * Which airport a city name means, where the data cannot say.
 *
 * Two cases, both ties the dataset has no way to break: one city with two big
 * airports (Chicago has O'Hare and Midway, Rome has Fiumicino and Ciampino),
 * and one name in two countries (Barcelona is in Spain and in Venezuela).
 * Ranking by size settles most of these; what is left is here.
 *
 * The generator prints every unresolved tie it finds, so this table is
 * extended by reading its output rather than by guessing.
 */
export const PREFERRED_CITY_CODE: Readonly<Record<string, string>> = {
  chicago: "ORD",
  rome: "FCO",
  milan: "MXP",
  barcelona: "BCN",
  washington: "IAD",
  houston: "IAH",
  moscow: "SVO",
  seoul: "ICN",
  osaka: "KIX",
  jakarta: "CGK",
  "sao paulo": "GRU",
  "rio de janeiro": "GIG",
  belfast: "BFS",
  glasgow: "GLA",
  aberdeen: "ABZ",
  birmingham: "BHX",
  valencia: "VLC",
  santiago: "SCL",
  "san jose": "SJC",
  columbus: "CMH",
  charleston: "CHS",
  springfield: "SGF",
  hamilton: "YHM",
  victoria: "YYJ",
  alexandria: "HBE",
  tripoli: "TIP",
  naples: "NAP",
  athens: "ATH",
  odessa: "ODS",
  cordoba: "COR",
  brussels: "BRU",
  bucharest: "OTP",
  dallas: "DFW",
  warsaw: "WAW",
  newcastle: "NCL",
  porto: "OPO",
  kochi: "COK",
  aden: "ADE",
  brest: "BES",
  wichita: "ICT",
  eugene: "EUG",
  belgrade: "BEG",
  bergen: "BGO"
};

/**
 * Aliases the generator produces that are not names anyone would use for a
 * city, or that would hijack ordinary sentences. Dropped outright rather than
 * marked ambiguous: no amount of context makes these a route.
 */
export const ALIAS_SUPPRESSIONS: ReadonlySet<string> = new Set([
  // Time words. Captain reads dates out of the same sentence as cities, and
  // Christmas Island cost a traveller their Lagos leg: "Christmas in Lagos"
  // resolved the holiday to an airport in the Indian Ocean. These are a closed
  // set, so they are refused outright rather than merely gated.
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "christmas", "easter", "ramadan", "eid", "diwali", "hanukkah", "thanksgiving",
  "new year", "easter island", "independence", "carnival", "festival",
  // Ordinary words that describe a trip rather than name a place.
  "plan", "plans", "trip", "flight", "flights", "route", "return", "holiday",
  "vacation", "wedding", "birthday", "conference", "meeting", "event",
  "airport", "airfield", "aerodrome", "island", "islands", "city", "town",
  "north", "south", "east", "west", "central", "upper", "lower", "grand",
  "great", "little", "big", "high", "low", "old", "new", "national", "state",
  "county", "district", "province", "region", "valley", "river", "lake",
  "mount", "mountain", "hill", "bay", "beach", "cape", "point", "harbour",
  "harbor", "base", "camp", "post", "junction", "centre", "center", "park",
  "army", "navy", "marine", "force", "memorial", "executive", "business",
  "private", "public", "civil", "general", "sir", "lady", "saint", "santa",
  "san", "sao", "santo", "president", "presidente", "capitan", "captain",
  "governor", "king", "queen", "prince", "princess", "sultan", "sheikh",
  "doctor", "professor"
]);
