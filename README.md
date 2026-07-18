# Flight Agent

A voice-first flight exploration interface. The frontend turns a loose travel
brief into a searchable inquiry, establishes a fare baseline, explores parallel
directions, and configures ongoing monitoring.

## Local development

Requires Node.js 24+ and pnpm 11.

```sh
pnpm install
pnpm dev
```

The app runs at <http://127.0.0.1:4178>.

## Project status

This repository currently contains the interaction prototype and a typed React
implementation of its complete mocked flow. Flight search, persistence, live
voice transcription, and monitoring are still local simulations. The next
integration boundary is Captain's versioned flight-app API.

The original generated design artifact is retained under
`prototype/voice-first-flight-exploration/` for reference.
