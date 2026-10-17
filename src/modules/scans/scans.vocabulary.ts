// The fixed answers to "I don't have the label". The table, the request and response schemas and the caution rules all read these, so a
// word added here is added everywhere at once.

export const NO_LABEL_SOURCES = ['market-vendor', 'pharmacy', 'online', 'gift', 'not-sure'] as const
export type NoLabelSource = (typeof NO_LABEL_SOURCES)[number]

export const NO_LABEL_PURPOSES = ['lighten', 'moisturise', 'treat-spots', 'not-sure'] as const
export type NoLabelPurpose = (typeof NO_LABEL_PURPOSES)[number]

export const NO_LABEL_USED_FOR = ['under-1-month', '1-6-months', '6-months-2-years', 'over-2-years'] as const
export type NoLabelUsedFor = (typeof NO_LABEL_USED_FOR)[number]
