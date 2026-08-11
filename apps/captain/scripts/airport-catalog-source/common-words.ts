/**
 * Ordinary English words that are also city names. Nice, Split, Reading, Same,
 * Best, Of — an alias in this set resolves only with a capital letter or a
 * place preposition in front of it, so "a nice flight" stays a sentence and
 * "then Nice for two nights" is a stop.
 *
 * Being here does not remove a city from the catalog; it only asks for
 * evidence before reading the word as one.
 */
export const COMMON_WORDS: ReadonlySet<string> = new Set([
  // Words a traveller is overwhelmingly more likely to mean literally.
  "a", "an", "the", "and", "or", "but", "not", "no", "yes", "of", "in", "on",
  "at", "to", "for", "from", "with", "by", "as", "so", "if", "it", "is", "be",
  "am", "are", "was", "were", "do", "does", "did", "has", "have", "had",
  "i", "me", "my", "we", "us", "our", "you", "your", "he", "she", "they",
  "him", "her", "them", "this", "that", "these", "those", "here", "there",
  "what", "when", "where", "which", "who", "why", "how", "all", "any", "both",
  "each", "few", "more", "most", "other", "some", "such", "only", "own",
  "same", "than", "then", "too", "very", "can", "will", "just", "now", "also",
  // Verbs and nouns that double as place names.
  "come", "back", "call", "find", "give", "know", "like", "look", "make",
  "need", "next", "over", "part", "take", "want", "well", "work", "read",
  "reading", "split", "best", "long", "man", "bar", "fort", "green", "home",
  "mine", "pass", "union", "water", "why", "nice", "hope", "friend", "buffalo",
  "eagle", "bird", "swan", "crane", "hunt", "hall", "field", "wood", "stone",
  "rock", "sandy", "sunny", "summer", "winter", "spring", "may", "march",
  "august", "june", "hero", "victory", "liberty", "freedom", "unity",
  "peace", "progress", "future", "star", "sun", "moon", "gold", "silver",
  "iron", "coal", "salt", "sugar", "rice", "corn", "orange", "lemon", "olive",
  "cherry", "apple", "plum", "pine", "oak", "elm", "ash", "birch", "maple",
  "single", "double", "triple", "first", "second", "third", "middle", "final",
  "open", "close", "clear", "bright", "dark", "light", "quick", "slow", "fast",
  "safe", "clean", "fair", "true", "real", "wild", "free", "rich", "poor",
  "young", "small", "large", "short", "tall", "deep", "wide", "narrow",
  "happy", "lucky", "sweet", "bitter", "cold", "warm", "hot", "cool",
  "normal", "energy", "eight", "nine", "ten", "one", "two", "three"
]);
