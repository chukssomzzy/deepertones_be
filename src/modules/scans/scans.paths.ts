import { API_V1_PREFIX } from '../../lib/api-version'

// `as const`: the typed client (hc<AppType>) reads the mount path from its literal type.
/** Where scans.routes.ts is mounted, under the API prefix. */
export const PRODUCT_SCANS_PATH = '/scans/products' as const

/** Where face-scans.routes.ts is mounted, under the API prefix. */
export const FACE_SCANS_PATH = '/scans/faces' as const

/** The link a client opens for a user's own photo. Matches the `GET /photos/{token}` route in scans.routes.ts. */
export const productPhotoUrl = (token: string) => `${API_V1_PREFIX}${PRODUCT_SCANS_PATH}/photos/${token}`

/** The link a client opens for a face photo. Matches the `GET /photos/{token}` route in face-scans.routes.ts. */
export const facePhotoUrl = (token: string) => `${API_V1_PREFIX}${FACE_SCANS_PATH}/photos/${token}`
