import type { profiles } from './profiles.table'

export type Profile = typeof profiles.$inferSelect

/** A profile's id and user, with the status of that user: what a job needs to act as the user, and to know whether the user is verified. */
export type ProfileWithOwner = Pick<Profile, 'id' | 'userId'> & { ownerStatus: 'anonymous' | 'verified' }
