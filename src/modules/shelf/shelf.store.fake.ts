import type { ShelfEntryRow } from './shelf.types'

/** The in-memory shelf rows, shared between FakeScansRepository (which writes them) and the shelf module's fake repository. Rows are updated in place. */
export class FakeShelfStore {
  rows: ShelfEntryRow[] = []
}
