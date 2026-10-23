import { env } from 'cloudflare:workers'
import { buildContainer } from '../../src/container'
import { runAs } from '../../src/lib/context'
import { createDb } from '../../src/lib/db'
import type { Goal } from '../../src/modules/goals/goals.vocabulary'
import { jpegPhoto } from '../../src/modules/scans/scans.photos.fake'
import { D1UsersRepository } from '../../src/modules/users/users.repository'

// Shared by the integration tests that drive the face scan's background work. A scan here is made the way the create route makes it, through the
// Worker's container (consent, a goal, a front photo in the real bucket, a row in D1), so every state the tests then reach comes from the
// pipeline itself and not from a row written into place. The caller passes the Worker env, whose face-scans queue producer is a recorder.

const users = new D1UsersRepository(createDb(env.DB))

export const FRONT_PHOTO = () => {
  const photo = jpegPhoto({ width: 1080, height: 1440 })
  photo.bytes[photo.bytes.length - 1] = 42
  return photo
}

export const startFaceScan = async (workerEnv: CloudflareBindings, goal: Goal = 'glow') => {
  const container = buildContainer(workerEnv)
  const userId = crypto.randomUUID()
  const profileId = crypto.randomUUID()
  await users.createGuestForDevice({ user: { id: userId, createdAt: new Date() }, device: { deviceHash: `face-support-${userId}`, platform: 'ios' }, profile: { id: profileId } })
  const asUser = <T>(fn: () => Promise<T>) => runAs({ kind: 'user', userId, status: 'verified', profileId }, fn)
  await asUser(() => container.faceScans.giveConsent(1))
  await asUser(() => container.goals.set({ goal }))
  const view = await asUser(() => container.faceScans.create({ front: FRONT_PHOTO() }))
  const prefix = `faces/${env.ENVIRONMENT}/${userId}/${profileId}/${view.id as string}`
  return { id: view.id as string, userId, profileId, asUser, container, frontKey: `${prefix}/front.jpg`, maskKey: (slug: string) => `${prefix}/mask-${slug}.png` }
}
export type StartedFaceScan = Awaited<ReturnType<typeof startFaceScan>>
