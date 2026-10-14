// One bucket and one domain for every environment: the assets are public and identical
// everywhere, and src/emails/brand.ts points at this host.
export const ASSET_BUCKET = 'deepertones-assets'
export const ASSET_DOMAIN = 'assets.deepertones.com'
// The zone that owns ASSET_DOMAIN, looked up by name to get the id the domain attach needs.
export const ASSET_ZONE = 'deepertones.com'
