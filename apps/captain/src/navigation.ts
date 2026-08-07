import type { MouseEvent } from "react";

/**
 * A left click with no modifier is navigation Captain handles in-page: every
 * screen renders from data already loaded, so there is nothing to fetch and no
 * reason to tear the app down and show a loading splash.
 *
 * Anything else — a new tab, a middle click, a download — belongs to the
 * browser, and the anchor's href is left to do its job.
 */
export function isPlainClick(event: Pick<
  MouseEvent,
  "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "defaultPrevented"
>): boolean {
  return event.button === 0
    && !event.metaKey
    && !event.ctrlKey
    && !event.shiftKey
    && !event.altKey
    && !event.defaultPrevented;
}

/** Wires an anchor to in-page navigation while keeping its href honest. */
export function inPageLink(
  href: string,
  navigate: (href: string) => void
): (event: MouseEvent) => void {
  return (event) => {
    if (!isPlainClick(event)) return;
    event.preventDefault();
    navigate(href);
  };
}
