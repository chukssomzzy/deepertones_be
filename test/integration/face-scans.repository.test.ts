import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createDb } from '../../src/lib/db'
import { D1FaceScansRepository } from '../../src/modules/face-scans/face-scans.repository'
import { faceScansRepositoryContract } from '../../src/modules/face-scans/face-scans.repository.contract'
import { D1ProfilesRepository } from '../../src/modules/profiles/profiles.repository'
import { D1UsersRepository } from '../../src/modules/users/users.repository'

const BASE = new Date('2030-06-15T12:00:00.000Z')
const MINUTE = 60 * 1000

const db = createDb(env.DB)
const users = new D1UsersRepository(db)
const profiles = new D1ProfilesRepository(db)

// The face tables reference profiles, and D1 enforces it, so each contract account is a real guest (made the way the app makes one, which
// writes the default profile in the same batch).
const newGuest = async () => {
  const userId = crypto.randomUUID()
  const profileId = crypto.randomUUID()
  await users.createGuestForDevice({ user: { id: userId, createdAt: BASE }, device: { deviceHash: `face-contract-${userId}`, platform: 'ios' }, profile: { id: profileId } })
  return { userId, profileId }
}
const newProfile = async (userId: string) => {
  const id = crypto.randomUUID()
  await profiles.insert({ id, userId, displayName: null, isDefault: false, createdAt: BASE })
  return id
}

faceScansRepositoryContract('D1', () => ({ repository: new D1FaceScansRepository(db), newAccount: newGuest, newProfile }))

/** A consent, a scan and its photos for the account, written through the repository. */
const withFaceData = async (account: { userId: string; profileId: string }, repository = new D1FaceScansRepository(db)) => {
  const scan = { id: crypto.randomUUID(), userId: account.userId, profileId: account.profileId, goalAtScan: 'glow' as const, createdAt: new Date(BASE.getTime() + MINUTE) }
  const photo = (position: 'front' | 'right') => ({
    faceScanId: scan.id,
    userId: scan.userId,
    position,
    photoKey: `faces/test/${scan.userId}/${scan.profileId}/${scan.id}/${position}.jpg`,
    createdAt: scan.createdAt,
  })
  await repository.giveConsent({ profileId: account.profileId, userId: account.userId, version: 1, at: scan.createdAt })
  await repository.createFaceScan(scan, [photo('front'), photo('right')])
  return scan
}

describe('the face tables in D1', () => {
  const repository = new D1FaceScansRepository(db)

  it('removes a profile\'s consent, face scans and photos with the profile, and leaves the account\'s other profile and other accounts', async () => {
    const account = await newGuest()
    const otherProfile = await newProfile(account.userId)
    const stranger = await newGuest()
    const scan = await withFaceData(account)
    const kept = await withFaceData({ userId: account.userId, profileId: otherProfile })
    const strangers = await withFaceData(stranger)

    await env.DB.prepare('DELETE FROM profiles WHERE id = ?').bind(account.profileId).run()

    expect(await repository.consentOf(account.profileId)).toBeNull()
    expect(await repository.findFaceScan(scan.id)).toBeNull()
    expect(await repository.photosOf(scan.id)).toEqual([])
    expect(await repository.findFaceScan(kept.id)).not.toBeNull()
    expect(await repository.photosOf(kept.id)).toHaveLength(2)
    expect(await repository.findFaceScan(strangers.id)).not.toBeNull()
  })

  it('removes the face data of every profile of a user with the user (a guest purged by the cleanup), and leaves other accounts\'', async () => {
    const guest = await newGuest()
    const second = await newProfile(guest.userId)
    const kept = await newGuest()
    const first = await withFaceData(guest)
    const firstOfSecond = await withFaceData({ userId: guest.userId, profileId: second })
    const strangers = await withFaceData(kept)

    expect(await users.deleteUsers([guest.userId])).toBe(1)

    for (const scan of [first, firstOfSecond]) {
      expect(await repository.findFaceScan(scan.id)).toBeNull()
      expect(await repository.photosOf(scan.id)).toEqual([])
    }
    expect(await repository.consentOf(guest.profileId)).toBeNull()
    expect(await repository.consentOf(second)).toBeNull()
    expect(await repository.findFaceScan(strangers.id)).not.toBeNull()
    expect(await repository.consentOf(kept.profileId)).not.toBeNull()
  })

  it('refuses a consent for a profile that does not exist', async () => {
    const { userId } = await newGuest()

    await expect(repository.giveConsent({ profileId: crypto.randomUUID(), userId, version: 1, at: BASE })).rejects.toThrow()
  })

  it('refuses a face scan for a profile that does not exist, and stores none of its photos', async () => {
    const { userId } = await newGuest()
    const scan = { id: crypto.randomUUID(), userId, profileId: crypto.randomUUID(), goalAtScan: 'glow' as const, createdAt: BASE }
    const photo = { faceScanId: scan.id, userId, position: 'front' as const, photoKey: `faces/test/${userId}/${scan.profileId}/${scan.id}/front.jpg`, createdAt: BASE }

    await expect(repository.createFaceScan(scan, [photo])).rejects.toThrow()

    expect(await repository.findFaceScan(scan.id)).toBeNull()
    expect(await repository.photosOf(scan.id)).toEqual([])
  })

  // The analysis writes masks and results later; until it does, a row is made here with SQL, as the profile cascade above is exercised. A mask is a bucket
  // key like a photo is, so every delete that must empty the bucket first has to list it.
  describe('masks and results of a scan', () => {
    const maskKeyOf = (scan: { id: string; userId: string; profileId: string }, concern: string) => `faces/test/${scan.userId}/${scan.profileId}/${scan.id}/mask-${concern}.png`
    const addMask = (scan: { id: string; userId: string; profileId: string }, concern: string) =>
      env.DB.prepare('INSERT INTO face_masks (face_scan_id, user_id, concern, mask_key) VALUES (?, ?, ?, ?)').bind(scan.id, scan.userId, concern, maskKeyOf(scan, concern)).run()
    const addResult = (scan: { id: string; userId: string }, concern: string) =>
      env.DB.prepare('INSERT INTO face_results (face_scan_id, user_id, concern, region, raw_score, ui_score) VALUES (?, ?, ?, ?, ?, ?)').bind(scan.id, scan.userId, concern, 'whole', 40, 60).run()
    const rowsOf = async (table: 'face_masks' | 'face_results', column: 'face_scan_id' | 'user_id', value: string) =>
      (await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`).bind(value).first<{ n: number }>())!.n
    const photoKeyOf = (scan: { id: string; userId: string; profileId: string }, position: string) => `faces/test/${scan.userId}/${scan.profileId}/${scan.id}/${position}.jpg`
    const seeded = async () => {
      const account = await newGuest()
      const scan = await withFaceData(account)
      await addMask(scan, 'hd-acne')
      await addMask(scan, 'hd-redness')
      await addResult(scan, 'hd_acne')
      await addResult(scan, 'hd_redness')
      return { account, scan }
    }

    it('lists the keys of a scan\'s masks with the keys of its photos', async () => {
      const { scan } = await seeded()

      expect((await repository.keysOfFaceScan(scan.id)).sort()).toEqual([photoKeyOf(scan, 'front'), photoKeyOf(scan, 'right'), maskKeyOf(scan, 'hd-acne'), maskKeyOf(scan, 'hd-redness')].sort())
    })

    it('lists the mask keys of those users\' scans with their photo keys, and nobody else\'s', async () => {
      const { account, scan } = await seeded()
      const stranger = await seeded()

      const keys = await repository.photoKeysForUsers([account.userId])

      expect(keys.sort()).toEqual([photoKeyOf(scan, 'front'), photoKeyOf(scan, 'right'), maskKeyOf(scan, 'hd-acne'), maskKeyOf(scan, 'hd-redness')].sort())
      expect(keys).not.toContain(maskKeyOf(stranger.scan, 'hd-acne'))
    })

    it('lists the mask keys of more users than D1 can bind to one statement', async () => {
      const { account, scan } = await seeded()

      const keys = await repository.photoKeysForUsers([...Array.from({ length: 250 }, () => crypto.randomUUID()), account.userId])

      expect(keys).toContain(maskKeyOf(scan, 'hd-acne'))
      expect(keys).toHaveLength(4)
    })

    it('deletes the scan\'s masks and results with it, and the other scans\' alone', async () => {
      const { account, scan } = await seeded()
      const other = await seeded()

      await repository.deleteFaceScan(scan.id)

      expect(await rowsOf('face_masks', 'face_scan_id', scan.id)).toBe(0)
      expect(await rowsOf('face_results', 'face_scan_id', scan.id)).toBe(0)
      expect(await repository.keysOfFaceScan(scan.id)).toEqual([])
      expect(await rowsOf('face_masks', 'face_scan_id', other.scan.id)).toBe(2)
      expect(await rowsOf('face_results', 'face_scan_id', other.scan.id)).toBe(2)
      expect(await repository.consentOf(account.profileId)).not.toBeNull()
    })

    it('deletes those users\' masks and results with their face data, and other users\' alone', async () => {
      const { account } = await seeded()
      const other = await seeded()

      await repository.deleteForUsers([account.userId])

      expect(await rowsOf('face_masks', 'face_scan_id', other.scan.id)).toBe(2)
      expect(await rowsOf('face_results', 'face_scan_id', other.scan.id)).toBe(2)
      expect(await rowsOf('face_masks', 'user_id', account.userId)).toBe(0)
      expect(await rowsOf('face_results', 'user_id', account.userId)).toBe(0)
      expect(await repository.photoKeysForUsers([account.userId])).toEqual([])
    })
  })

  // Every query of the guest cleanup looks a user's rows up by user_id, so each table needs an index that leads with it.
  describe.each(['face_consents', 'face_scans', 'face_scan_photos', 'face_results', 'face_masks', 'profile_fitzpatrick'])('indexes of %s', (table) => {
    it('has an index that starts with user_id', async () => {
      const { results } = await env.DB.prepare(
        `SELECT l.name AS name, i.name AS first_column FROM pragma_index_list('${table}') l JOIN pragma_index_info(l.name) i ON i.seqno = 0`,
      ).all<{ name: string; first_column: string }>()

      expect(results.map((index) => index.first_column)).toContain('user_id')
    })
  })

  // Six tables, named as the design names them. face_results, face_masks and profile_fitzpatrick are not used by any route yet (the analysis
  // pipeline writes them), so the schema is what is pinned: they exist, each carries user_id for the guest cleanup, and every foreign key
  // cascades, so a profile or a user going takes them with it.
  describe.each(['face_consents', 'face_scans', 'face_scan_photos', 'face_results', 'face_masks', 'profile_fitzpatrick'])('table %s', (table) => {
    it('exists, with a user_id column', async () => {
      const { results } = await env.DB.prepare(`SELECT name FROM pragma_table_info('${table}')`).all<{ name: string }>()

      expect(results.map((column) => column.name)).toContain('user_id')
    })

    it('has foreign keys, and every one cascades on delete', async () => {
      const { results } = await env.DB.prepare(`SELECT "table" AS parent, on_delete FROM pragma_foreign_key_list('${table}')`).all<{ parent: string; on_delete: string }>()

      expect(results.length).toBeGreaterThan(0)
      expect(results.every((fk) => fk.on_delete === 'CASCADE')).toBe(true)
      expect(results.map((fk) => fk.parent).every((parent) => ['profiles', 'face_scans', 'users'].includes(parent))).toBe(true)
    })
  })
})
