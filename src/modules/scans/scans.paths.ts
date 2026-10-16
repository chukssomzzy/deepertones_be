import { API_V1_PREFIX } from '../../lib/api-version'

// `as const`: the typed client (hc<AppType>) reads the mount path from its literal type. /scans/faces is reserved for face scans.
/** Where scans.routes.ts is mounted, under the API prefix. */
export const PRODUCT_SCANS_PATH = '/scans/products' as const

/** The link a client opens for a user's own photo. Matches the `GET /photos/{token}` route in scans.routes.ts. */
export const productPhotoUrl = (token: string) => `${API_V1_PREFIX}${PRODUCT_SCANS_PATH}/photos/${token}`
