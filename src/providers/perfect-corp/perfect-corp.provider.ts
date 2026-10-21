/*
 * The port the face scan uses to reach Perfect Corp (YouCam), which analyses a face photo. Implementations: RestPerfectCorpClient (the
 * real API) and MemoryPerfectCorpClient (tests). A call that fails throws one of the four error classes below, so a caller decides what to
 * do by class and never reads a vendor message.
 */

/** Why a front photo cannot be analysed, in words the app can turn into one instruction. A fixed set: the vendor's own codes stop here. */
export const REJECTED_PHOTO_REASONS = ['too-dark', 'turn-to-camera', 'move-closer', 'face-not-centred', 'no-face', 'image-size'] as const
export type RejectedPhotoReason = (typeof REJECTED_PHOTO_REASONS)[number]

/** The vendor is down, throttling us, unreachable, or answered something unreadable. The same call may work later. */
export class PerfectCorpUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PerfectCorpUnavailableError'
  }
}

/** The photo itself cannot be analysed, and a retake can fix it. Costs nothing: Perfect Corp charges only on success. */
export class PerfectCorpRejectedPhotoError extends Error {
  readonly reason: RejectedPhotoReason

  constructor(reason: RejectedPhotoReason) {
    super(`Perfect Corp rejected the photo: ${reason}`)
    this.name = 'PerfectCorpRejectedPhotoError'
    this.reason = reason
  }
}

/** The account has no units left. Retrying cannot help until someone tops it up, so it is not an outage. */
export class PerfectCorpCreditError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PerfectCorpCreditError'
  }
}

/** Our request, key or link is wrong or expired, or an answer is over the size we allow. Retrying the same call cannot help. */
export class PerfectCorpBadRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PerfectCorpBadRequestError'
  }
}

/** One score for one concern in one region. Perfect Corp's scores run 1 to 100 and HIGHER IS HEALTHIER. `rawScore` is the one rules read. */
export type ConcernScore = {
  /** Perfect Corp's HD name, e.g. `hd_age_spot`. */
  concern: string
  /** `whole`, or a part of the face such as `left_cheek`. */
  region: string
  rawScore: number
  uiScore: number
  /** Links to the overlay PNGs, which expire; `downloadMask` fetches one. Empty when the vendor sent none. */
  maskUrls: string[]
}

export type SkinAnalysisResult =
  | { status: 'running' }
  | {
      status: 'success'
      concerns: ConcernScore[]
      /** The vendor's own text per region, e.g. `Dry & Redness`; the rules in the face tables turn it into a label. */
      skinTypes: { region: string; skinType: string }[]
      skinAge: number | null
      /** The overall score. Kept for the routine stage; it is never shown. */
      all: number | null
      /** The `hd_*` items left out of `concerns` because a score was missing, by type (only when it is an hd code), for the log. */
      skipped: { type: string; problem: 'no-scores' }[]
    }

export const FITZPATRICK_TYPES = ['I', 'II', 'III', 'IV', 'V', 'VI'] as const
export type FitzpatrickType = (typeof FITZPATRICK_TYPES)[number]

export type FitzpatrickResult = { status: 'running' } | { status: 'success'; fitzpatrick: FitzpatrickType }

/** A delivery whose signature checked out. `running` is never sent: the vendor calls only when a task ends. */
export type VerifiedWebhook = { webhookId: string; taskId: string; taskStatus: 'success' | 'error' }

/**
 * Why a webhook delivery was refused. For the log, so it holds a reason, counts, yes-or-no flags and key names, and never the secret,
 * a signature, a header value or a value from the body (but for an enum-like task status, see `bad-task-status`).
 */
export type WebhookRejection =
  | { reason: 'missing-headers'; missing: ('webhook-id' | 'webhook-timestamp' | 'webhook-signature')[] }
  /** `webhook-timestamp` is not digits only. */
  | { reason: 'bad-timestamp' }
  /** `skewSeconds` is positive for a timestamp in the past. `signatureValid` says whether a v1 signature matched anyway, so a wrong clock or unit is told from a wrong secret. */
  | { reason: 'stale-timestamp'; skewSeconds: number; skewIfMilliseconds: number | null; signatureValid: boolean }
  /** Our configured secret cannot be decoded. */
  | { reason: 'unreadable-secret' }
  /** The `would match` flags say which wrong reading of the secret or the id (the id up to its first `:`) the sender used. */
  | {
      reason: 'signature-mismatch'
      versions: string[]
      signatureCount: number
      undecodedSecretWouldMatch: boolean
      idWithoutSuffixWouldMatch: boolean
      undecodedAndIdWithoutSuffixWouldMatch: boolean
      topLevelKeys: string[]
      dataKeys: string[]
    }
  | { reason: 'bad-shape'; problem: 'not-json' | 'no-data' | 'no-task-id'; topLevelKeys: string[]; dataKeys: string[] }
  /** `taskStatusValue` is the status as sent, only when it is an enum-like word (letters, `_` and `-`, up to 20), so it is safe to log. */
  | { reason: 'bad-shape'; problem: 'bad-task-status'; taskStatusValue?: string; topLevelKeys: string[]; dataKeys: string[] }

export type WebhookCheck = { ok: true; delivery: VerifiedWebhook } | { ok: false; rejection: WebhookRejection }

export interface PerfectCorpClient {
  /** Uploads a photo and resolves to the file id the tasks take. No link to our own storage is ever given to the vendor. */
  uploadFile(bytes: Uint8Array, options: { contentType: 'image/jpeg'; fileName: string }): Promise<string>
  /** Starts a skin analysis for the given HD actions. Resolves to the task id; the result comes by webhook and `getSkinAnalysis`. */
  createSkinAnalysis(input: { fileId: string; actions: string[] }): Promise<string>
  createFitzpatrick(input: { fileId: string }): Promise<string>
  /** The task's state. Throws PerfectCorpRejectedPhotoError when the task ended on a photo problem the user can fix. */
  getSkinAnalysis(taskId: string): Promise<SkinAnalysisResult>
  getFitzpatrick(taskId: string): Promise<FitzpatrickResult>
  /** Their copy of the photo and the results goes with the task. */
  deleteTask(taskId: string): Promise<void>
  downloadMask(url: string): Promise<Uint8Array>
  /** The Standard Webhooks check on the RAW body. Never throws on bad input. A rejection says why, with nothing secret and nothing from the body but key names. */
  checkWebhook(body: string, headers: Headers): Promise<WebhookCheck>
}
