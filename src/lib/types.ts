/** The public shape of a class: its methods and fields without private members, so a fake class can implement it. */
export type PublicOf<T> = { [K in keyof T]: T[K] }
