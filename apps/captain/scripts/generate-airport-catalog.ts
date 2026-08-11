/**
 * Regenerates `services/trip-planning/airport-data.generated.ts` from the
 * OurAirports public-domain dataset.
 *
 *   pnpm --filter @agents/captain catalog:generate
 *
 * IATA codes barely move, so this is an occasional chore rather than part of
 * the build: fetching at build time would make a deploy depend on somebody
 * else's uptime. Run it, read the diff, commit the result.
 *
 * The generated file carries airports only. Metropolitan codes — LON, NYC and
 * the rest — are a curated overlay in `@agents/flight-domain`, because a
 * city-level code that no provider recognises passes planning and then
 * discards every offer.
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { METROPOLITAN_AIRPORT_GROUPS } from "@agents/flight-domain";

import { COUNTRY_CURRENCIES } from "./airport-catalog-source/currencies.js";
import {
  AIRPORT_ADDITIONS,
  ALIAS_ADDITIONS,
  ALIAS_SUPPRESSIONS,
  LABEL_OVERRIDES,
  METROPOLITAN_LABELS,
  PREFERRED_CITY_CODE
} from "./airport-catalog-source/overrides.js";
import { COMMON_WORDS } from "./airport-catalog-source/common-words.js";

const SOURCE_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv";
const KEPT_TYPES = new Set(["large_airport", "medium_airport"]);
/** Words that describe an airport rather than name its city. */
const FACILITY_WORDS =
  /\b(?:international|intl|regional|municipal|metropolitan|domestic|airport|airports|airfield|aerodrome|airbase|air\s+base|air\s+force\s+base|air\s+station|field|terminal|apt)\b/giu;

type Airport = {
  code: string;
  label: string;
  country: string;
  currency: string;
  latitude: number;
  longitude: number;
  large: boolean;
  cityKey: string;
  aliases: string[];
  /** Aliases that need a place preposition or a mid-sentence capital. */
  contextualAliases: string[];
};

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quoted) {
      if (character !== '"') { field += character; continue; }
      if (text[index + 1] === '"') { field += '"'; index += 1; continue; }
      quoted = false;
      continue;
    }
    if (character === '"') { quoted = true; continue; }
    if (character === ",") { row.push(field); field = ""; continue; }
    if (character === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    if (character === "\r") continue;
    field += character;
  }
  if (field || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}']+/gu, " ")
    .trim();
}

/** Title-cased for display, preserving words the source already cased oddly. */
function titleCase(value: string): string {
  return value.split(" ").filter(Boolean).map((word) =>
    word.charAt(0).toLocaleUpperCase("en") + word.slice(1)
  ).join(" ");
}

/**
 * The city a row is about, as the traveller would name it. `municipality`
 * carries a commune and a region often enough — "Marignane, Bouches-du-Rhône"
 * for Marseille, "Paris (Roissy-en-France, Val-d'Oise)" for CDG — that the
 * airport's own name has to be read too.
 */
/**
 * Which of the candidates to print. The municipality wins: an airport's own
 * name is as often a person as a place — Murtala Muhammed, Chhatrapati
 * Shivaji, Indira Gandhi — and reading the label off it renames Lagos after a
 * head of state. Where a municipality really is a suburb, as Marignane is for
 * Marseille, the label is corrected by hand in overrides.ts. The suburb still
 * answers to the city's name either way: aliases carry every candidate.
 */
function cityLabel(candidates: string[], name: string): string {
  return titleCase(candidates[0] ?? normalize(name));
}

function cityCandidates(
  name: string,
  municipality: string
): { certain: string[]; contextual: string[] } {
  // The municipality is a place name. An airport's own name is marketing —
  // "Range Regional Airport" is in Hibbing, and indexing "range" as a certain
  // city turned "what's the price range?" into a flight to Minnesota. So only
  // the municipality is trusted outright; everything read off the name needs
  // a place preposition or a mid-sentence capital in front of it.
  const certain = new Set<string>();
  const contextual = new Set<string>();
  const plainMunicipality = municipality.replace(/\([^)]*\)/gu, " ").split(",")[0] ?? "";
  if (plainMunicipality.trim()) certain.add(normalize(plainMunicipality));
  const stripped = normalize(name.replace(FACILITY_WORDS, " "));
  if (stripped) {
    contextual.add(stripped);
    const lead = normalize(name.split(/[-–/(]/u)[0]!.replace(FACILITY_WORDS, " "));
    if (lead) contextual.add(lead);
    // Airports are usually "City Qualifier" — Marseille Provence, Sydney
    // Kingsford Smith, Milan Malpensa — so the first word alone is the only
    // route to those cities. It is also the route to "Plan" from Plan de
    // Guadalupe and "General" from every airport named after one.
    const [first] = stripped.split(" ");
    if (first && first.length >= 4) contextual.add(first);
  }
  certain.delete("");
  contextual.delete("");
  for (const value of certain) contextual.delete(value);
  return { certain: [...certain], contextual: [...contextual] };
}

async function main(): Promise<void> {
  const response = await fetch(SOURCE_URL);
  if (!response.ok) throw new Error(`${SOURCE_URL} responded ${response.status}`);
  const csv = await response.text();
  const rows = parseCsv(csv);
  const header = rows[0]!;
  const column = Object.fromEntries(header.map((name, index) => [name, index]));
  const at = (row: string[], name: string): string => (row[column[name]!] ?? "").trim();

  const source = rows.slice(1).filter((row) =>
    row.length >= header.length
    && at(row, "iata_code")
    && KEPT_TYPES.has(at(row, "type"))
    && at(row, "scheduled_service") === "yes"
  );

  const metropolitanCodes = new Set(Object.keys(METROPOLITAN_AIRPORT_GROUPS));
  const metropolitanFor = new Map<string, string>();
  for (const [metro, members] of Object.entries(METROPOLITAN_AIRPORT_GROUPS)) {
    for (const member of members) metropolitanFor.set(member, metro);
  }

  const airports = new Map<string, Airport>();
  const cityMembers = new Map<string, string[]>();

  for (const row of source) {
    const code = at(row, "iata_code").toUpperCase();
    if (!/^[A-Z]{3}$/u.test(code) || metropolitanCodes.has(code)) continue;
    const country = at(row, "iso_country").toUpperCase();
    const name = at(row, "name");
    const municipality = at(row, "municipality");
    const { certain, contextual } = cityCandidates(name, municipality);
    const cityKey = `${country}:${certain[0] ?? normalize(name)}`;
    airports.set(code, {
      code,
      label: LABEL_OVERRIDES[code] ?? cityLabel(certain, name),
      country,
      currency: COUNTRY_CURRENCIES[country] ?? "USD",
      latitude: Number(at(row, "latitude_deg")),
      longitude: Number(at(row, "longitude_deg")),
      large: at(row, "type") === "large_airport",
      cityKey,
      aliases: certain,
      contextualAliases: contextual
    });
    cityMembers.set(cityKey, [...(cityMembers.get(cityKey) ?? []), code]);
  }

  for (const [code, addition] of Object.entries(AIRPORT_ADDITIONS)) {
    const cityKey = `${addition.country}:${code.toLowerCase()}`;
    airports.set(code, { ...addition, code, cityKey, contextualAliases: [] });
    cityMembers.set(cityKey, [code]);
  }

  // A metropolitan code stands for its whole group, so it inherits the country
  // and currency of any member the dataset knows.
  for (const [metro, members] of Object.entries(METROPOLITAN_AIRPORT_GROUPS)) {
    const anchor = members.map((member) => airports.get(member)).find(Boolean);
    if (!anchor) throw new Error(`Metropolitan group ${metro} has no known member airport`);
    airports.set(metro, {
      code: metro,
      label: METROPOLITAN_LABELS[metro] ?? anchor.label,
      country: anchor.country,
      currency: anchor.currency,
      latitude: anchor.latitude,
      longitude: anchor.longitude,
      large: true,
      cityKey: `${anchor.country}:${metro.toLowerCase()}`,
      aliases: [],
      contextualAliases: []
    });
  }

  /** The one airport an alias for this city should resolve to. */
  const representative = (codes: string[]): string => {
    const metro = codes.map((code) => metropolitanFor.get(code)).find(Boolean);
    if (metro) return metro;
    const ranked = [...codes].sort((left, right) => {
      const bySize = Number(airports.get(right)!.large) - Number(airports.get(left)!.large);
      return bySize !== 0 ? bySize : left.localeCompare(right);
    });
    return ranked[0]!;
  };

  // An alias earns a place only when it names exactly one city. "Marseille"
  // does; "General" names twenty-seven, and "London" names two countries.
  const aliasCities = new Map<string, Set<string>>();
  const contextualOnly = new Set<string>();
  for (const airport of airports.values()) {
    for (const alias of airport.aliases) {
      if (!aliasCities.has(alias)) aliasCities.set(alias, new Set());
      aliasCities.get(alias)!.add(airport.cityKey);
    }
    for (const alias of airport.contextualAliases) {
      if (!aliasCities.has(alias)) aliasCities.set(alias, new Set());
      aliasCities.get(alias)!.add(airport.cityKey);
      contextualOnly.add(alias);
    }
  }
  // A name some other airport's municipality confirms is a city name outright.
  for (const airport of airports.values()) {
    for (const alias of airport.aliases) contextualOnly.delete(alias);
  }

  /**
   * Which city an alias several places answer to should mean. Barcelona is in
   * Spain and in Venezuela, London is in England and in Ontario, Paris is in
   * France and in Texas — and in each pair one is the airport a traveller
   * writing that word means. Size decides it; a genuine tie is left
   * unresolved, because not knowing beats picking Rome, Georgia.
   */
  const rankCity = (cityKey: string): number => {
    const members = cityMembers.get(cityKey) ?? [];
    const code = representative(members);
    const airport = code ? airports.get(code) : undefined;
    if (!airport) return -1;
    return (airport.large ? 1_000 : 0) + members.length;
  };

  const aliasRows: Array<{ alias: string; code: string; ambiguous: boolean }> = [];
  const claimed = new Set<string>();
  const unresolvedTies: string[] = [];
  for (const [alias, cities] of aliasCities) {
    if (ALIAS_SUPPRESSIONS.has(alias) || alias.length < 3) continue;
    const preferred = PREFERRED_CITY_CODE[alias];
    let code = preferred && airports.has(preferred) ? preferred : null;
    if (!code) {
      const ranked = [...cities]
        .map((cityKey) => ({ cityKey, rank: rankCity(cityKey) }))
        .sort((left, right) => right.rank - left.rank);
      const [best, runnerUp] = ranked;
      if (!best || best.rank < 0) continue;
      if (runnerUp && runnerUp.rank === best.rank) {
        unresolvedTies.push(
          `${alias}: ${ranked.map((entry) =>
            representative(cityMembers.get(entry.cityKey) ?? [])
          ).join(" / ")}`
        );
        continue;
      }
      code = representative(cityMembers.get(best.cityKey) ?? []);
    }
    if (!code || !airports.has(code)) continue;
    aliasRows.push({
      alias,
      code,
      ambiguous: contextualOnly.has(alias) || COMMON_WORDS.has(alias)
    });
    claimed.add(alias);
  }
  // Curated aliases are names travellers actually use, so they are never
  // gated — but a common word stays gated however it got here.
  for (const [alias, code] of Object.entries(ALIAS_ADDITIONS)) {
    const normalized = normalize(alias);
    if (!airports.has(code)) throw new Error(`Alias addition ${alias} points at unknown ${code}`);
    if (claimed.has(normalized)) {
      aliasRows.splice(aliasRows.findIndex((row) => row.alias === normalized), 1);
    }
    aliasRows.push({ alias: normalized, code, ambiguous: COMMON_WORDS.has(normalized) });
  }
  aliasRows.sort((left, right) => left.alias.localeCompare(right.alias));

  // Alternatives to offer when a traveller names a country: the largest other
  // cities Captain can actually search, decided here so the runtime does not
  // scan a few thousand airports to answer it.
  const byCountry = new Map<string, Airport[]>();
  for (const airport of airports.values()) {
    byCountry.set(airport.country, [...(byCountry.get(airport.country) ?? []), airport]);
  }
  const countryRows = [...byCountry.entries()]
    .map(([country, list]) => {
      const seen = new Set<string>();
      const cities = list
        .sort((left, right) => Number(right.large) - Number(left.large) || left.code.localeCompare(right.code))
        .filter((airport) => !seen.has(airport.label) && seen.add(airport.label))
        .map((airport) => `${airport.code}=${airport.label}`);
      return `${country}\t${cities.join("|")}`;
    })
    .sort();

  const airportRows = [...airports.values()]
    .sort((left, right) => left.code.localeCompare(right.code))
    .map((airport) => [
      airport.code,
      airport.label,
      airport.country,
      airport.currency,
      Number.isFinite(airport.latitude) ? airport.latitude.toFixed(3) : "0",
      Number.isFinite(airport.longitude) ? airport.longitude.toFixed(3) : "0"
    ].join("\t"));

  const generated = `/**
 * GENERATED FILE — do not edit by hand.
 *
 * Source:  ${SOURCE_URL}
 * Filter:  iata_code set, type in {${[...KEPT_TYPES].join(", ")}}, scheduled_service = yes
 * Rows:    ${airportRows.length} airports, ${aliasRows.length} aliases
 * Command: pnpm --filter @agents/captain catalog:generate
 *
 * Curated corrections live in scripts/airport-catalog-source/overrides.ts.
 * Rows are one tab-separated line each so this parses in a millisecond and
 * typechecks as a single string rather than a few thousand object literals.
 */

/** code, label, ISO 3166 country, ISO 4217 currency, latitude, longitude */
export const AIRPORT_ROWS = \`
${airportRows.join("\n")}
\`;

/** alias, code, "a" when the alias is also an ordinary English word */
export const AIRPORT_ALIAS_ROWS = \`
${aliasRows.map((row) => `${row.alias}\t${row.code}${row.ambiguous ? "\ta" : ""}`).join("\n")}
\`;

/** ISO 3166 country, then CODE=Label for the cities worth offering */
export const COUNTRY_CITY_ROWS = \`
${countryRows.join("\n")}
\`;
`;

  const target = fileURLToPath(
    new URL("../services/trip-planning/airport-data.generated.ts", import.meta.url)
  );
  await writeFile(target, generated, "utf8");
  console.log(`${airportRows.length} airports, ${aliasRows.length} aliases → ${target}`);
  if (unresolvedTies.length > 0) {
    // Names Captain now refuses to guess at. Adding one to PREFERRED_CITY_CODE
    // teaches it which city was meant; leaving it means the traveller gets
    // asked, which is the safe half of the trade.
    console.log(`\n${unresolvedTies.length} names left unresolved:`);
    for (const tie of unresolvedTies.sort()) console.log(`  ${tie}`);
  }
}

await main();
