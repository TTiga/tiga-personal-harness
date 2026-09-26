/**
 * Shared preparation failure type carried over from the bundled-plugin
 * mechanism. The full candidate transaction system it belongs to upstream is
 * out of scope here; the seed installer only consumes this marker type to stop
 * deferring the rest of a startup batch after a shared preparation failure.
 */
export class CandidatePreparationError extends Error {}
