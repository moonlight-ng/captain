import { defineSandbox } from "eve/sandbox";
import { justbash } from "eve/sandbox/just-bash";

/**
 * Captain's authored tools run in the application process and do not need
 * system binaries. Pinning the pure-JS backend keeps self-hosted Fly startup
 * deterministic; Eve's availability heuristic otherwise selects a local VM
 * runtime that is not installed in the production image.
 */
export default defineSandbox({
  backend: justbash()
});
