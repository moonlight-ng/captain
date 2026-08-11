/**
 * Countries a traveller names when they mean a city they have not chosen yet:
 * "then Japan for a few days". Without these, a country contributes no airport
 * mention at all, and an itinerary naming three places looks like it names two
 * — which is enough to drop a whole leg on the floor.
 *
 * Every code here must exist in the airport catalog, and every entry is a
 * guess. The resolved airport is marked assumed so the traveller reviews it
 * rather than discovering it after a search ran against the wrong city.
 *
 * City-states are deliberately absent: Singapore is already a city alias, and
 * resolving it as a country guess would mark a certainty as an assumption.
 */
export type CountryAirport = {
  /** Metropolitan or primary airport code, resolved from the airport catalog. */
  code: string;
  /** Display name as it should read mid-sentence: "Japan's main airport". */
  label: string;
};

export const COUNTRY_PRIMARY_AIRPORTS: Readonly<Record<string, CountryAirport>> = {
  nigeria: { code: "LOS", label: "Nigeria" },
  ghana: { code: "ACC", label: "Ghana" },
  "ivory coast": { code: "ABJ", label: "Ivory Coast" },
  "cote d'ivoire": { code: "ABJ", label: "Côte d'Ivoire" },
  senegal: { code: "DSS", label: "Senegal" },
  cameroon: { code: "DLA", label: "Cameroon" },
  kenya: { code: "NBO", label: "Kenya" },
  tanzania: { code: "DAR", label: "Tanzania" },
  "south africa": { code: "JNB", label: "South Africa" },
  ethiopia: { code: "ADD", label: "Ethiopia" },
  rwanda: { code: "KGL", label: "Rwanda" },
  uganda: { code: "EBB", label: "Uganda" },
  egypt: { code: "CAI", label: "Egypt" },
  morocco: { code: "CMN", label: "Morocco" },
  uk: { code: "LON", label: "the UK" },
  "united kingdom": { code: "LON", label: "the UK" },
  britain: { code: "LON", label: "Britain" },
  "great britain": { code: "LON", label: "Britain" },
  england: { code: "LON", label: "England" },
  usa: { code: "NYC", label: "the US" },
  "united states": { code: "NYC", label: "the US" },
  "united states of america": { code: "NYC", label: "the US" },
  america: { code: "NYC", label: "the US" },
  canada: { code: "YYZ", label: "Canada" },
  france: { code: "PAR", label: "France" },
  germany: { code: "FRA", label: "Germany" },
  netherlands: { code: "AMS", label: "the Netherlands" },
  holland: { code: "AMS", label: "the Netherlands" },
  spain: { code: "MAD", label: "Spain" },
  portugal: { code: "LIS", label: "Portugal" },
  italy: { code: "FCO", label: "Italy" },
  japan: { code: "TYO", label: "Japan" }
};

/**
 * The other cities to offer when Captain guessed a country's airport. Written
 * by hand for the same reason the country list above is: ranked off the
 * dataset these came out as Aomori and Makinohara Shimada for Japan, because
 * nothing in it says which airport a traveller has heard of. Every code must
 * exist in the catalog, which the airport-catalog test asserts.
 */
export const COUNTRY_ALTERNATIVE_CITIES: Readonly<Record<string, readonly string[]>> = {
  NG: ["ABV", "PHC", "ENU"],
  GH: ["KMS", "TML"],
  CI: [],
  SN: [],
  CM: ["NSI"],
  KE: ["MBA"],
  TZ: ["JRO", "ZNZ"],
  ZA: ["CPT", "DUR"],
  ET: [],
  RW: [],
  UG: [],
  EG: ["HRG", "SSH"],
  MA: ["RAK", "TNG"],
  GB: ["MAN", "EDI", "BHX"],
  US: ["LAX", "ORD", "SFO"],
  CA: ["YVR", "YUL"],
  FR: ["NCE", "LYS", "MRS"],
  DE: ["MUC", "BER", "HAM"],
  NL: ["EIN"],
  ES: ["BCN", "AGP", "VLC"],
  PT: ["OPO", "FAO"],
  IT: ["MXP", "VCE", "NAP"],
  JP: ["KIX", "FUK", "CTS"]
};

export const COUNTRY_ALIASES: ReadonlySet<string> = new Set(
  Object.keys(COUNTRY_PRIMARY_AIRPORTS)
);
