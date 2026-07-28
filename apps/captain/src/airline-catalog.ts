export type AirlineOption = {
  code: string;
  name: string;
};

const AIRLINES: readonly AirlineOption[] = [
  { code: "W3", name: "Arik Air" },
  { code: "P4", name: "Air Peace" },
  { code: "QU", name: "Azman Air" },
  { code: "9J", name: "Dana Air" },
  { code: "VK", name: "ValueJet" },
  { code: "OF", name: "Overland Airways" },
  { code: "UN", name: "United Nigeria" },
  { code: "NG", name: "Aero Contractors" },
  { code: "KQ", name: "Kenya Airways" },
  { code: "ET", name: "Ethiopian Airlines" },
  { code: "MS", name: "EgyptAir" },
  { code: "AT", name: "Royal Air Maroc" },
  { code: "SA", name: "South African Airways" },
  { code: "FA", name: "FlySafair" },
  { code: "TM", name: "LAM Mozambique" },
  { code: "WB", name: "RwandAir" },
  { code: "UR", name: "Uganda Airlines" },
  { code: "TC", name: "Air Tanzania" },
  { code: "PW", name: "Precision Air" },
  { code: "KP", name: "ASKY Airlines" },
  { code: "HF", name: "Air Côte d’Ivoire" },
  { code: "HC", name: "Air Senegal" },
  { code: "AH", name: "Air Algérie" },
  { code: "TU", name: "Tunisair" },
  { code: "BA", name: "British Airways" },
  { code: "VS", name: "Virgin Atlantic" },
  { code: "U2", name: "easyJet" },
  { code: "FR", name: "Ryanair" },
  { code: "EI", name: "Aer Lingus" },
  { code: "AF", name: "Air France" },
  { code: "KL", name: "KLM" },
  { code: "LH", name: "Lufthansa" },
  { code: "LX", name: "SWISS" },
  { code: "OS", name: "Austrian Airlines" },
  { code: "SN", name: "Brussels Airlines" },
  { code: "IB", name: "Iberia" },
  { code: "TP", name: "TAP Air Portugal" },
  { code: "AZ", name: "ITA Airways" },
  { code: "AY", name: "Finnair" },
  { code: "SK", name: "SAS" },
  { code: "TK", name: "Turkish Airlines" },
  { code: "EK", name: "Emirates" },
  { code: "QR", name: "Qatar Airways" },
  { code: "EY", name: "Etihad Airways" },
  { code: "SV", name: "Saudia" },
  { code: "WY", name: "Oman Air" },
  { code: "RJ", name: "Royal Jordanian" },
  { code: "DL", name: "Delta Air Lines" },
  { code: "AA", name: "American Airlines" },
  { code: "UA", name: "United Airlines" },
  { code: "B6", name: "JetBlue" },
  { code: "AS", name: "Alaska Airlines" },
  { code: "WN", name: "Southwest Airlines" },
  { code: "AC", name: "Air Canada" },
  { code: "WS", name: "WestJet" },
  { code: "SQ", name: "Singapore Airlines" },
  { code: "CX", name: "Cathay Pacific" },
  { code: "NH", name: "ANA" },
  { code: "JL", name: "Japan Airlines" },
  { code: "QF", name: "Qantas" },
  { code: "VA", name: "Virgin Australia" },
  { code: "AI", name: "Air India" },
  { code: "UK", name: "Vistara" },
  { code: "6E", name: "IndiGo" },
  { code: "MU", name: "China Eastern" },
  { code: "CA", name: "Air China" },
  { code: "CZ", name: "China Southern" },
  { code: "KE", name: "Korean Air" },
  { code: "OZ", name: "Asiana Airlines" },
  { code: "TG", name: "Thai Airways" },
  { code: "MH", name: "Malaysia Airlines" },
  { code: "GA", name: "Garuda Indonesia" },
  { code: "PR", name: "Philippine Airlines" },
  { code: "LA", name: "LATAM" },
  { code: "AV", name: "Avianca" },
  { code: "CM", name: "Copa Airlines" },
  { code: "AM", name: "Aeroméxico" },
  { code: "G3", name: "GOL" },
  { code: "AD", name: "Azul" },
  { code: "JJ", name: "LATAM Brasil" },
  { code: "LY", name: "El Al" },
  { code: "FZ", name: "flydubai" },
  { code: "XY", name: "flynas" },
  { code: "PC", name: "Pegasus" },
  { code: "W6", name: "Wizz Air" },
  { code: "VY", name: "Vueling" },
  { code: "LS", name: "Jet2" },
  { code: "DY", name: "Norwegian" },
  { code: "FI", name: "Icelandair" },
  { code: "NP", name: "Nile Air" },
  { code: "SM", name: "Air Cairo" }
];

const byCode = new Map(AIRLINES.map((airline) => [airline.code, airline]));

export function airlineLabel(code: string): string {
  return byCode.get(code.toUpperCase())?.name ?? code.toUpperCase();
}

export function searchAirlines(query: string, selected: readonly string[]): AirlineOption[] {
  const needle = query.trim().toUpperCase();
  const taken = new Set(selected.map((code) => code.toUpperCase()));
  const matches = AIRLINES.filter((airline) => !taken.has(airline.code));
  if (!needle) return matches.slice(0, 8);

  const scored = matches.flatMap((airline) => {
    const name = airline.name.toUpperCase();
    let score = 0;
    if (airline.code === needle) score = 100;
    else if (airline.code.startsWith(needle)) score = 80;
    else if (name.startsWith(needle)) score = 60;
    else if (name.split(/[\s’'-]+/u).some((part) => part.startsWith(needle))) score = 40;
    else if (needle.length >= 3 && name.includes(needle)) score = 20;
    else if (needle.length >= 3 && airline.code.includes(needle)) score = 10;
    else return [];
    return [{ airline, score }];
  });

  return scored
    .sort((left, right) => right.score - left.score || left.airline.name.localeCompare(right.airline.name))
    .slice(0, 12)
    .map((entry) => entry.airline);
}

export function normalizeAirlineCode(value: string): string | null {
  const code = value.trim().toUpperCase();
  return /^[A-Z0-9]{2,3}$/u.test(code) ? code : null;
}
