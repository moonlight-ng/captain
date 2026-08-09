import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

export default defineEval({
  description: "Captain preserves routes, relative dates, windows, repeated cities, and constraints from the website examples.",
  tags: ["trip-planning", "request-understanding", "website", "regression"],
  async test(t) {
    const berlin = await t.send(
      "Conference in Berlin on the 12th, then a weekend in Lisbon on the 18th — flying from New York."
    );
    berlin.expectOk();
    t.check(berlin.message, includes("NYC → BER → LIS"));
    t.check(berlin.message, includes(/12\s+[A-Z][a-z]{2}\s+20\d{2}/u));
    t.check(berlin.message, includes(/18\s+[A-Z][a-z]{2}\s+20\d{2}/u));
    (await t.send("Cancel")).expectOk();

    const singapore = await t.send(
      "Tokyo to Singapore — what’s the price range looking like?"
    );
    singapore.expectOk();
    t.check(singapore.message, includes("TYO → SIN"));
    t.check(singapore.message, includes(/7[- ]day|–| to /iu));
    (await t.send("Cancel")).expectOk();

    const newYork = await t.send(
      "San Francisco to New York in the first week of May — cheapest day in that window?"
    );
    newYork.expectOk();
    t.check(newYork.message, includes("SFO → NYC"));
    t.check(newYork.message, includes(/1 May 20\d{2}/u));
    t.check(newYork.message, includes(/7 May 20\d{2}/u));
    (await t.send("Cancel")).expectOk();

    const barcelona = await t.send(
      "Need to be in London before Wednesday, then Barcelona by Friday — starting from Chicago next week."
    );
    barcelona.expectOk();
    t.check(barcelona.message, includes("ORD → LON → BCN"));
    (await t.send("Cancel")).expectOk();

    const repeatedCity = await t.send(
      "Fly from Lagos to New York on September 2 2030, then London on September 8 2030, back to New York on September 12 2030."
    );
    repeatedCity.expectOk();
    t.check(repeatedCity.message, includes("LOS → NYC → LON → NYC"));
    (await t.send("Cancel")).expectOk();

    const relative = await t.send(
      "Starting in Lagos next week, need to be in London by Wednesday and Paris by Saturday."
    );
    relative.expectOk();
    t.check(relative.message, includes("LOS → LON → PAR"));
    (await t.send("Cancel")).expectOk();

    const constrained = await t.send(
      "Tokyo to London September 3–7 2030, nonstop, premium economy, under $1,200."
    );
    constrained.expectOk();
    t.check(constrained.message, includes("TYO → LON"));
    t.check(constrained.message, includes("Premium economy"));
    t.check(constrained.message, includes("Nonstop"));
    t.check(constrained.message, includes(/1,?200/iu));
    t.judge.autoevals.closedQA([
      "The final proposal is Tokyo to London for 3 through 7 September 2030.",
      "It preserves nonstop, premium economy, and the 1,200 dollar maximum.",
      "Captain asks for confirmation and does not invent live fares before a search runs."
    ].join(" ")).atLeast(0.95);
  }
});
