/**
 * Echoes the traveller's own route back to them while Captain works.
 *
 * This is an acknowledgement, not a finding. It repeats their words instead of
 * resolving airports, so it can be said before any interpretation has run —
 * which is the whole point, since interpretation is what the traveller is
 * waiting for. Anything it cannot read confidently returns null and the caller
 * falls back to a generic acknowledgement: a wrong echo is worse than a plain
 * one, so this reads only the two phrasings that cannot be misread.
 */

// Words that end a place name. Everything after one of these belongs to the
// dates or the rest of the request, not to the route.
const ROUTE_BOUNDARY = /^(?:in|on|at|for|next|last|around|about|early|mid|late|sometime|from|departing|leaving|returning|return|with|via|and|or|please|before|after|during|between|then|plus|going|coming)$/iu;
const DATE_WORD = /^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|today|tomorrow|tonight|weekend|week|month|year)$/iu;
// "X to Y" is only a route when X is a place. In "I want to fly to Lagos" it is
// not, and echoing "I want to fly" back would read as Captain misunderstanding
// them. Any of these in the origin rejects the whole echo.
const NOT_A_PLACE = new Set([
  "i", "we", "you", "he", "she", "it", "they", "me", "us", "them",
  "my", "our", "your", "their", "his", "her", "its",
  "a", "an", "the", "this", "that", "these", "those", "some", "any", "one",
  "want", "wants", "wanted", "need", "needs", "needed", "like", "liked",
  "would", "will", "can", "could", "should", "must", "may", "might",
  "go", "going", "goes", "went", "fly", "flying", "flies", "flew",
  "get", "getting", "got", "travel", "travels", "travelling", "traveling",
  "head", "heading", "book", "booking", "track", "tracking",
  "plan", "planning", "find", "finding", "search", "searching",
  "look", "looking", "take", "taking", "try", "trying",
  "hope", "hoping", "think", "thinking", "move", "moving",
  "send", "show", "help", "let", "lets", "add",
  "flight", "flights", "trip", "trips", "ticket", "tickets",
  "fare", "fares", "journey", "journeys", "route", "routes",
  "way", "ways", "somewhere", "anywhere", "holiday", "vacation",
  "how", "what", "when", "where", "which", "who", "why",
  "is", "are", "was", "were", "do", "does", "did",
  "have", "has", "had", "am", "be", "been",
  "please", "hi", "hello", "hey", "thanks", "ok", "okay", "yes", "no", "but"
]);
const MAX_PLACE_WORDS = 3;

export function tripRouteEcho(text: string): string | null {
  const normalized = text.trim().replace(/\s+/gu, " ");
  if (!normalized) return null;
  // "from X to Y" states the route outright. Without it, the route is only
  // trusted when the message opens with it, so the words before "to" cannot be
  // the tail of a sentence about wanting to travel.
  const explicit = /\bfrom\s+(.+)$/iu.exec(normalized);
  const candidate = explicit?.[1] ?? normalized;
  const separator = /\sto\s/iu.exec(candidate);
  if (!separator) return null;
  const origin = placeName(candidate.slice(0, separator.index));
  const destination = placeName(candidate.slice(separator.index + separator[0].length));
  if (!origin || !destination) return null;
  return `${origin} to ${destination}`;
}

/**
 * Takes the leading words that can still be part of a place name, and gives up
 * entirely on anything that is plainly not one.
 */
function placeName(raw: string): string | null {
  const words: string[] = [];
  for (const token of raw.trim().split(" ")) {
    const word = token.replace(/[.,;:!?"'’]+$/u, "").replace(/^["'“”]+/u, "");
    if (!word) break;
    if (words.length >= MAX_PLACE_WORDS) break;
    if (/\d/u.test(word) || DATE_WORD.test(word) || ROUTE_BOUNDARY.test(word)) break;
    if (NOT_A_PLACE.has(word.toLocaleLowerCase("en"))) return null;
    words.push(word);
  }
  return words.length > 0 ? words.map(capitalize).join(" ") : null;
}

/**
 * Their words, their spelling — but a lowercase "lagos to london" read back
 * looks careless, and an airport code is not a word to title-case.
 */
function capitalize(word: string): string {
  if (word !== word.toLocaleLowerCase("en")) return word;
  return word.charAt(0).toLocaleUpperCase("en") + word.slice(1);
}
