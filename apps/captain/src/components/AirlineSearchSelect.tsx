import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import {
  airlineLabel,
  normalizeAirlineCode,
  searchAirlines
} from "../airline-catalog";

export function AirlineSearchSelect({
  values = [],
  placeholder,
  onChange,
  max = 12
}: {
  values: string[];
  placeholder: string;
  onChange: (values: string[]) => void;
  max?: number;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const suggestions = useMemo(() => searchAirlines(query, values), [query, values]);

  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, []);

  function add(code: string) {
    const normalized = normalizeAirlineCode(code);
    if (!normalized || values.includes(normalized) || values.length >= max) return;
    onChange([...values, normalized]);
    setQuery("");
    setOpen(false);
  }

  function remove(code: string) {
    onChange(values.filter((value) => value !== code));
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      const exact = suggestions.find((airline) => airline.code === query.trim().toUpperCase())
        ?? suggestions[0];
      if (exact) add(exact.code);
      else {
        const code = normalizeAirlineCode(query);
        if (code) add(code);
      }
    } else if (event.key === "Backspace" && !query && values.length > 0) {
      remove(values.at(-1)!);
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div className="airline-search" ref={rootRef}>
      <div className={`airline-search-field ${open ? "open" : ""}`}>
        {values.map((code) => (
          <button
            type="button"
            className="airline-chip"
            key={code}
            onClick={() => remove(code)}
            aria-label={`Remove ${airlineLabel(code)}`}
          >
            <strong>{code}</strong>
            <span>{airlineLabel(code)}</span>
            <i aria-hidden="true">×</i>
          </button>
        ))}
        <input
          value={query}
          placeholder={values.length === 0 ? placeholder : "Add another"}
          disabled={values.length >= max}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
      </div>
      {open && suggestions.length > 0 && values.length < max && (
        <ul className="airline-search-results" role="listbox">
          {suggestions.map((airline) => (
            <li key={airline.code}>
              <button type="button" onClick={() => add(airline.code)}>
                <strong>{airline.code}</strong>
                <span>{airline.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
