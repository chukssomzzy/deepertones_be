/**
 * A mistake in what the person gave `catalog:draft` (a flag, a country, a workbook with nothing to work from), found before any call is spent. Its
 * message is fixed text plus the person's own words, never a key or what Claude said, so the shell prints it; the message of every other error it hides.
 */
export class DraftInputError extends Error {}
