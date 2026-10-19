import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadPhotoSet, loadVerdicts, parseVerdictFlag, parseVerdicts, PhotoSetError, recordVerdicts, SEEDS, seededShuffle, VerdictsError } from './matching-set'

// The loader is exercised against a real temp directory (node:fs + os.tmpdir, removed after each test): the set IS a
// directory layout, so this is simpler and more faithful than a fake file-system interface.

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'matching-set-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const LABEL = (extra: Record<string, unknown> = {}) => ({ brand: 'Glow Co', name: 'Bright Serum', category: 'skin', ...extra })

const writeLabels = (labels: unknown) => writeFile(join(root, 'labels.json'), typeof labels === 'string' ? labels : JSON.stringify(labels))
const writePhotos = async (folder: string, files: string[]) => {
  await mkdir(join(root, folder), { recursive: true })
  for (const f of files) await writeFile(join(root, folder, f), 'x')
}
/** A valid two-product set that each test then breaks in one place. */
const validSet = async () => {
  await writeLabels({ serum: LABEL(), cream: LABEL({ name: 'Soft Cream', form: 'cream' }) })
  await writePhotos('serum', ['b.jpg', 'a.jpg'])
  await writePhotos('cream', ['1.png', '2.webp'])
}

describe('loadPhotoSet', () => {
  it('loads each labelled folder with its label and its photos sorted by name', async () => {
    await validSet()

    const set = await loadPhotoSet(root)

    expect(set.products.map((p) => p.folder)).toEqual(['cream', 'serum'])
    const serum = set.products.find((p) => p.folder === 'serum')!
    expect(serum.label).toEqual(LABEL())
    expect(serum.photos.map((p) => p.name)).toEqual(['a.jpg', 'b.jpg'])
    expect(serum.photos[0]!.path).toBe(join(root, 'serum', 'a.jpg'))
    expect(set.products.find((p) => p.folder === 'cream')!.label.form).toBe('cream')
  })

  it('accepts jpg, jpeg, png and webp in any letter case, and ignores dotfiles and loose files beside the folders', async () => {
    await writeLabels({ serum: LABEL() })
    await writePhotos('serum', ['a.JPG', 'b.jpeg', 'c.png', 'd.webp', '.DS_Store'])
    await writeFile(join(root, 'verdicts.json'), '{}')

    const set = await loadPhotoSet(root)

    expect(set.products[0]!.photos.map((p) => p.name)).toEqual(['a.JPG', 'b.jpeg', 'c.png', 'd.webp'])
  })

  it('accepts look-alikes declared on both sides', async () => {
    await writeLabels({ serum: LABEL({ lookalikes: ['cream'] }), cream: LABEL({ name: 'Soft Cream', lookalikes: ['serum'] }) })
    await writePhotos('serum', ['a.jpg', 'b.jpg'])
    await writePhotos('cream', ['a.jpg', 'b.jpg'])

    const set = await loadPhotoSet(root)

    expect(set.products.find((p) => p.folder === 'serum')!.label.lookalikes).toEqual(['cream'])
  })

  it('rejects a missing labels file, naming labels.json', async () => {
    await writePhotos('serum', ['a.jpg', 'b.jpg'])

    await expect(loadPhotoSet(root)).rejects.toThrow(PhotoSetError)
    await expect(loadPhotoSet(root)).rejects.toThrow(/labels\.json.*(missing|not found)/i)
  })

  it('rejects a missing photo directory with a message naming it', async () => {
    await expect(loadPhotoSet(join(root, 'nope'))).rejects.toThrow(PhotoSetError)
  })

  it('rejects a labels file that is not valid JSON', async () => {
    await validSet()
    await writeLabels('{ not json')

    await expect(loadPhotoSet(root)).rejects.toThrow(/labels\.json.*malformed/i)
  })

  it('rejects a labels file that is not an object of labels', async () => {
    await validSet()
    await writeLabels([LABEL()])

    await expect(loadPhotoSet(root)).rejects.toThrow(/labels\.json.*malformed/i)
  })

  it('rejects a label with no brand, naming the folder', async () => {
    await validSet()
    await writeLabels({ serum: { name: 'Bright Serum', category: 'skin' }, cream: LABEL() })

    await expect(loadPhotoSet(root)).rejects.toThrow(/serum.*brand/i)
  })

  it('rejects a folder with no label, naming the folder', async () => {
    await validSet()
    await writePhotos('toner', ['a.jpg', 'b.jpg'])

    await expect(loadPhotoSet(root)).rejects.toThrow(/toner.*no label/i)
  })

  it('rejects a label with no folder, naming the label', async () => {
    await validSet()
    await writeLabels({ serum: LABEL(), cream: LABEL(), toner: LABEL() })

    await expect(loadPhotoSet(root)).rejects.toThrow(/toner.*no folder/i)
  })

  it('rejects a product with fewer than 2 photos, naming the folder', async () => {
    await validSet()
    await rm(join(root, 'serum', 'b.jpg'))

    await expect(loadPhotoSet(root)).rejects.toThrow(/serum.*at least 2 photos/i)
  })

  it('accepts a product with exactly 2 photos', async () => {
    await validSet()

    await expect(loadPhotoSet(root)).resolves.toBeDefined()
  })

  it('rejects an unsupported file inside a product folder, naming the file', async () => {
    await validSet()
    await writePhotos('serum', ['notes.txt'])

    await expect(loadPhotoSet(root)).rejects.toThrow(/notes\.txt.*unsupported/i)
  })

  it('rejects a look-alike that names an unknown folder, naming both', async () => {
    await validSet()
    await writeLabels({ serum: LABEL({ lookalikes: ['ghost'] }), cream: LABEL() })

    await expect(loadPhotoSet(root)).rejects.toThrow(/serum.*lookalike.*ghost.*unknown|serum.*unknown.*ghost/i)
  })

  it('rejects a product that lists its own folder as a look-alike', async () => {
    await writeLabels({ serum: LABEL({ lookalikes: ['serum'] }), cream: LABEL({ name: 'Soft Cream' }) })
    await writePhotos('serum', ['a.jpg', 'b.jpg'])
    await writePhotos('cream', ['1.png', '2.webp'])

    await expect(loadPhotoSet(root)).rejects.toThrow(PhotoSetError)
    await expect(loadPhotoSet(root)).rejects.toThrow(/serum/)
  })

  it('rejects look-alikes declared on only one side', async () => {
    await validSet()
    await writeLabels({ serum: LABEL({ lookalikes: ['cream'] }), cream: LABEL() })

    await expect(loadPhotoSet(root)).rejects.toThrow(/symmetric.*(serum|cream)|(serum|cream).*symmetric/i)
  })

  it('rejects a category outside the vocabulary, naming the folder and the value', async () => {
    await validSet()
    await writeLabels({ serum: LABEL({ category: 'perfume' }), cream: LABEL() })

    await expect(loadPhotoSet(root)).rejects.toThrow(/serum.*category.*perfume/i)
  })

  it('rejects a form outside the vocabulary, naming the folder and the value', async () => {
    await validSet()
    await writeLabels({ serum: LABEL({ form: 'foam' }), cream: LABEL() })

    await expect(loadPhotoSet(root)).rejects.toThrow(/serum.*form.*foam/i)
  })
})

describe('parseVerdicts', () => {
  it('reads a map of image hash to right or wrong', () => {
    expect(parseVerdicts('{"abc":"right","def":"wrong"}')).toEqual({ abc: 'right', def: 'wrong' })
  })

  it('reads an empty file body as no verdicts', () => {
    expect(parseVerdicts('{}')).toEqual({})
  })

  it('rejects text that is not JSON', () => {
    expect(() => parseVerdicts('nope')).toThrow(VerdictsError)
    expect(() => parseVerdicts('nope')).toThrow(/verdicts\.json.*malformed/i)
  })

  it('rejects JSON that is not an object', () => {
    expect(() => parseVerdicts('["right"]')).toThrow(/malformed/i)
  })

  it('rejects a value other than right or wrong, naming the hash', () => {
    expect(() => parseVerdicts('{"abc":"maybe"}')).toThrow(/abc.*maybe|abc.*right.*wrong/i)
  })
})

describe('loadVerdicts', () => {
  it('treats a missing verdicts file as no verdicts', async () => {
    expect(await loadVerdicts(root)).toEqual({})
  })

  it('reads the verdicts file in the photo directory', async () => {
    await writeFile(join(root, 'verdicts.json'), '{"abc":"wrong"}')

    expect(await loadVerdicts(root)).toEqual({ abc: 'wrong' })
  })

  it('rejects a malformed verdicts file', async () => {
    await writeFile(join(root, 'verdicts.json'), '{')

    await expect(loadVerdicts(root)).rejects.toThrow(VerdictsError)
  })
})

describe('parseVerdictFlag', () => {
  const HASH = 'a'.repeat(63) + '0'

  it('splits hash=verdict', () => {
    expect(parseVerdictFlag(`${HASH}=right`)).toEqual([HASH, 'right'])
    expect(parseVerdictFlag(`${HASH}=wrong`)).toEqual([HASH, 'wrong'])
  })

  it('rejects a flag with no verdict, an unknown verdict, or no hash', () => {
    expect(() => parseVerdictFlag(HASH)).toThrow(VerdictsError)
    expect(() => parseVerdictFlag(`${HASH}=maybe`)).toThrow(VerdictsError)
    expect(() => parseVerdictFlag('=right')).toThrow(VerdictsError)
  })

  it('rejects a hash that is not 64 lowercase hex characters', () => {
    expect(() => parseVerdictFlag('abc123=right')).toThrow(VerdictsError)
    expect(() => parseVerdictFlag(`${HASH.toUpperCase()}=right`)).toThrow(VerdictsError)
    expect(() => parseVerdictFlag(`${HASH}0=right`)).toThrow(VerdictsError)
    expect(() => parseVerdictFlag(`${'g'.repeat(64)}=right`)).toThrow(VerdictsError)
  })
})

describe('recordVerdicts', () => {
  it('creates the verdicts file when there is none', async () => {
    await recordVerdicts(root, { abc: 'right' })

    expect(JSON.parse(await readFile(join(root, 'verdicts.json'), 'utf8'))).toEqual({ abc: 'right' })
  })

  it('adds a hash and keeps the others', async () => {
    await writeFile(join(root, 'verdicts.json'), '{"abc":"right"}')

    const merged = await recordVerdicts(root, { def: 'wrong' })

    expect(merged).toEqual({ abc: 'right', def: 'wrong' })
    expect(await loadVerdicts(root)).toEqual({ abc: 'right', def: 'wrong' })
  })

  it('overwrites the verdict for a hash it already has', async () => {
    await writeFile(join(root, 'verdicts.json'), '{"abc":"right","def":"wrong"}')

    await recordVerdicts(root, { abc: 'wrong' })

    expect(await loadVerdicts(root)).toEqual({ abc: 'wrong', def: 'wrong' })
  })

  it('refuses to overwrite a malformed verdicts file', async () => {
    await writeFile(join(root, 'verdicts.json'), '{broken')

    await expect(recordVerdicts(root, { abc: 'right' })).rejects.toThrow(VerdictsError)
    expect(await readFile(join(root, 'verdicts.json'), 'utf8')).toBe('{broken')
  })
})

describe('SEEDS', () => {
  it('is three distinct fixed seeds', () => {
    expect(SEEDS).toHaveLength(3)
    expect(new Set(SEEDS).size).toBe(3)
  })
})

describe('seededShuffle', () => {
  const LIST = Array.from({ length: 20 }, (_, i) => i)

  it('gives the same order for the same seed', () => {
    expect(seededShuffle(LIST, 7)).toEqual(seededShuffle(LIST, 7))
  })

  it('gives different orders for different seeds on a non-trivial list', () => {
    const orders = new Set(SEEDS.map((s) => seededShuffle(LIST, s).join(',')))

    expect(orders.size).toBe(SEEDS.length)
  })

  it('is always a permutation: nothing lost, nothing duplicated', () => {
    for (const seed of [0, 1, 2, 3, 99, 12345]) expect(seededShuffle(LIST, seed).slice().sort((a, b) => a - b)).toEqual(LIST)
  })

  it('does not change the list it is given', () => {
    const copy = [...LIST]
    seededShuffle(copy, 3)

    expect(copy).toEqual(LIST)
  })

  it('actually reorders a non-trivial list', () => {
    expect(seededShuffle(LIST, 1)).not.toEqual(LIST)
  })

  it('handles empty and single-item lists', () => {
    expect(seededShuffle([], 1)).toEqual([])
    expect(seededShuffle(['a'], 1)).toEqual(['a'])
  })
})
