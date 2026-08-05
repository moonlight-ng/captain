import type { PassengerFormValues } from "./components/PassengerForm";

const MOCK_ACCESS = "design";

const FAKE_PEOPLE = [
  { givenName: "Ada", familyName: "Lovelace", title: "ms" as const, gender: "f" as const },
  { givenName: "Alan", familyName: "Turing", title: "mr" as const, gender: "m" as const },
  { givenName: "Grace", familyName: "Hopper", title: "ms" as const, gender: "f" as const },
  { givenName: "Katherine", familyName: "Johnson", title: "ms" as const, gender: "f" as const },
  { givenName: "Tim", familyName: "Berners-Lee", title: "mr" as const, gender: "m" as const }
];

/** Local design / prototype mode (`#access=design`). */
export function isMockMode(): boolean {
  const hash = new URLSearchParams(window.location.hash.slice(1)).get("access")?.trim();
  if (hash === MOCK_ACCESS) return true;
  // Vite local proxy runs against the design mock API.
  return import.meta.env.DEV && (hash === MOCK_ACCESS || !hash);
}

/**
 * In local Vite, force `#access=design` so the whole app stays on the mock API
 * without needing a Telegram login link.
 */
export function ensureMockAccess(): boolean {
  if (!import.meta.env.DEV) {
    return new URLSearchParams(window.location.hash.slice(1)).get("access")?.trim() === MOCK_ACCESS;
  }
  const url = new URL(window.location.href);
  const hash = new URLSearchParams(url.hash.slice(1));
  const current = hash.get("access")?.trim();
  if (current === MOCK_ACCESS) return true;
  if (current) return false;
  hash.set("access", MOCK_ACCESS);
  url.hash = hash.toString();
  window.history.replaceState(null, "", url.toString());
  return true;
}

/** Complete booking-ready traveller details for mock / design flows. */
export function fakeTravellerDetails(index = 0): PassengerFormValues {
  const person = FAKE_PEOPLE[index % FAKE_PEOPLE.length]!;
  const stamp = String(1000 + (index % 9000)).padStart(4, "0");
  const slug = `${person.givenName}.${person.familyName}`
    .toLowerCase()
    .replace(/[^a-z.]+/gu, "");
  return {
    givenName: person.givenName,
    middleName: "",
    familyName: person.familyName,
    title: person.title,
    gender: person.gender,
    bornOn: "1990-01-15",
    email: `${slug}@example.com`,
    phoneNumber: `+44770090${stamp}`,
    nationality: "GB",
    countryOfResidence: "GB",
    passportNumber: `GB${stamp}${String(100000 + index).slice(-6)}`,
    passportIssuingCountry: "GB",
    passportExpiresOn: "2032-06-01"
  };
}
