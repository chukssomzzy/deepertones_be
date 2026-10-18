/**
 * Lower case, accents and apostrophes removed, "&" read as "and", a "+" touching a letter or digit read as "plus"
 * ("SPF 50+", "Hydro Boost+"; a standalone " + " is just a space), every other mark a space, a space between a
 * letter and the digit after it ("NC15" is "nc 15"), single spaces. A dot survives only between two digits, so
 * "1.5" is kept and "v.2" is "v 2". A digit followed by a letter is left alone, so "250ml" still reaches stripSizes.
 */
export const normaliseText = (raw: string): string =>
  raw
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/&/g, ' and ')
    .replace(/(?<=[\p{L}\p{N}])\+|\+(?=[\p{L}\p{N}])/gu, ' plus ')
    .replace(/(?<!\d)\.|\.(?!\d)/g, ' ')
    .replace(/[^\p{L}\p{N}.]+/gu, ' ')
    .replace(/(?<=\p{L})(?=\d)/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
