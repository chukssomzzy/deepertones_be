import type { ReferenceEntry } from './catalog.reference'
import type { CatalogWorkbookService } from './catalog.workbook.service'
import type { RoutineStep } from './catalog.vocabulary'

type Country = Awaited<ReturnType<CatalogWorkbookService['countries']>>[number]
type Recommendation = Awaited<ReturnType<CatalogWorkbookService['approvedFor']>>[number]
type LiveRules = Awaited<ReturnType<CatalogWorkbookService['liveRules']>>

/**
 * The read side of CatalogWorkbookService for unit tests of its consumers (the interface fixed between PR 3 and PR 5): countries, the approved rows
 * on offer in a country for a step, and the live rules. `approvedFor` keeps the real one's promise (only rows sold in that country that fill that
 * step), so a consumer that forgot to pass the country or the step gets the wrong rows, as it would from D1. It records every question it was asked.
 * Not a stand-in for the import: what an upload does is PR 3's own tests.
 */
export class FakeCatalogWorkbook implements Pick<CatalogWorkbookService, 'countries' | 'approvedFor' | 'liveRules'> {
  readonly asked: { country: string; step: RoutineStep }[] = []
  private countryRows: Country[] = []
  private offers: { country: string; row: Recommendation }[] = []
  private rules: ReferenceEntry[] = []

  /** Adds a country. A retired one is kept in `countries()`, as the real table keeps it. */
  addCountry(country: Country): this {
    this.countryRows.push({ ...country })
    return this
  }

  /** Retires a country the way a later upload does: the row stays, its status changes. */
  retireCountry(code: string): void {
    this.countryRows = this.countryRows.map((country) => (country.code === code ? { ...country, status: 'retired' } : country))
  }

  /** Puts an approved row on offer in a country (its availability row). */
  offer(country: string, row: Recommendation): this {
    this.offers.push({ country, row: { ...row } })
    return this
  }

  /** Makes `rules` the live approved rules. */
  setRules(rules: ReferenceEntry[]): this {
    this.rules = rules
    return this
  }

  async countries(): Promise<Country[]> {
    return this.countryRows.map((country) => ({ ...country }))
  }

  async approvedFor(q: { country: string; step: RoutineStep }): Promise<Recommendation[]> {
    this.asked.push({ ...q })
    return this.offers.filter((offer) => offer.country === q.country && offer.row.steps.includes(q.step)).map((offer) => ({ ...offer.row }))
  }

  async liveRules(): Promise<LiveRules> {
    return { version: 'rules-fake', entries: this.rules.map((rule) => ({ ...rule })) } as LiveRules
  }
}
