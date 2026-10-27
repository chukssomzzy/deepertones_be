import { sha256Hex } from '../../lib/crypto'
import { stableJson } from '../../lib/stable-json'
import { hasLinkOrMarkup } from '../../lib/text-safety'
import { isSafePublicHttpsUrl } from '../../lib/url-safety'
import { SHOWN_CONCERNS, SKIN_TYPE_LABELS, type ShownConcern, type SkinTypeLabel } from '../face-scans/face-scans.tables'
import { GOALS, type Goal } from '../goals/goals.vocabulary'
import { FORBIDDEN_WORDING } from '../routines/routines.wording'
import { identityKey } from './catalog.identity'
import { normaliseIngredient } from './catalog.ingredients'
import {
  BUDGET_BANDS,
  CATEGORIES,
  CONCERN_KINDS,
  FREQUENCIES,
  INGREDIENT_GROUPS,
  ORIGINS,
  PRODUCT_FORMS,
  ROUTINE_STEPS,
  TAPER_KINDS,
  type Category,
  type ConcernKind,
  type Frequency,
  type IngredientGroup,
  type Origin,
  type ProductForm,
  type RoutineStep,
  type TaperKind,
} from './catalog.vocabulary'

// The workbook contract: what the recommendation catalog's spreadsheet (seven tabs: Products, Availability, Ingredients, Countries, Claim words, Tapers, Guides) may hold, as
// data, and the one function that checks a workbook against it. Pure: no I/O, no clock, so the same rows always give the same answer. The data
// is plain JSON (a pattern is a string), so it can be fingerprinted, and `npm run catalog:contract-doc` writes it out for the people who fill the
// workbook in. Change it, and the version, fingerprint and that document all have to move with it.
// The file is `.schema.ts`, not `.contract.ts`: dependency-cruiser treats a `*.contract.ts` as test-only, and the import service has to use this.
// The HTTP shapes that carry a workbook (the raw tabs a request and the export hold) are zod schemas in catalog.workbook.schemas.ts; a tab or cell type changed here changes those too.

/** Bumped when a tab, column, accepted value or rule changes, so a file written to an older contract is known to be. */
export const CONTRACT_VERSION = '2.2.0'

/** What a spreadsheet library gives for a cell. */
export type Cell = string | number | boolean | null
/** One row, keyed by its header names. A key the row leaves out is an empty cell, so reading one may give undefined. */
export type RawRow = Record<string, Cell | undefined>
/** A tab as a spreadsheet library gives it: the header row, and the rows below it. The headers say what the columns are, whatever keys the rows have. */
export type RawTab = { headers: string[]; rows: RawRow[] }
export type RawWorkbook = { products: RawTab; availability: RawTab; ingredients: RawTab; countries: RawTab; claimWords: RawTab; tapers: RawTab; guides: RawTab }
export type TabKey = keyof RawWorkbook

// --- the definitions ----------------------------------------------------------------------------------------------------------------------------

/** Every rule code a problem can carry, with what it means in plain words. A code never holds a cell value. */
const RULES = {
  UNKNOWN_COLUMN: 'The tab has a column the contract does not know. Remove it, or correct its spelling.',
  MISSING_COLUMN: "A column the contract needs is not in the tab's header row. Add it; its cells may stay empty where the column is optional.",
  REQUIRED: 'The cell must be filled in.',
  REQUIRED_WHEN_APPROVED: 'The cell must be filled in once the status is approved. Fill it in, or leave the row as a draft.',
  NOT_IN_VOCABULARY: 'A value is not one of the accepted values listed for this column. Spelling and case must match exactly.',
  BAD_CODE: 'The code is not in the required format. Product and rule codes are capital letters, digits and hyphens, 2 to 40 characters, starting with a letter or digit. A country code is two capital letters.',
  BAD_CURRENCY: 'The currency is not a three-letter ISO 4217 code in capitals, such as NGN.',
  BAD_DATE: 'The date is not a real calendar day written as YYYY-MM-DD, such as 2026-10-21.',
  NOT_HTTPS_URL: 'A link is not an https web address. A link must start with https:// and name a public website (no port, no IP address).',
  NOT_A_WHOLE_NUMBER: 'The value is not a whole number of zero or more. No decimals, no thousands separators, no minus sign.',
  TOO_LONG: 'The text is longer than this column allows. A cell that is too long is reported for its length only, and nothing else is checked about it until it is cut down.',
  ITEM_TOO_LONG: 'One item of the list is longer than this column allows. An item that is too long is reported for its length only.',
  TOO_MANY_ITEMS: 'The list has more items than this column allows.',
  HAS_LINK_OR_MARKUP: 'The text holds a link (https://, www.) or markup (a tag such as `<b>`). Free text is plain words; put links in the columns made for them.',
  NOT_NORMALISED:
    'The name is not written the way ingredients are compared: single spaces, and no trailing full stop, asterisk or dagger. Capitals are fine, since names are lower-cased for you. Write "alcohol denat", not "alcohol denat.".',
  ALL_MIXED_WITH_OTHERS: '"all" means every skin type, so it cannot be listed next to another one. Use "all" alone, or list the types.',
  AUDIT_INCOMPLETE: 'An audit needs both who did it and when. Fill in both audited columns, or leave both empty.',
  APPROVED_WITH_DRAFT_CELLS: 'An approved row cannot have draft cells: a cell that is still a draft has not been reviewed. Review the cells and clear draft_cells, or set the status back to draft.',
  INVALID_DRAFT_CELL: 'A draft cell is not written as column=https-link. Both a column and a link are needed.',
  DRAFT_CELL_COLUMN:
    'A draft cell names a column that cannot be marked as a draft: it is not a Products column, or it is one that identifies or signs off the row, or it is draft_cells itself.',
  PRICE_RANGE: 'The lowest price is above the highest price.',
  LOW_NOT_BELOW_MID: 'The top of the low band must be lower than the top of the mid band.',
  UNKNOWN_PRODUCT: 'The product code is not in the Products tab. It must match a code there exactly.',
  UNKNOWN_COUNTRY: 'The country is not in the Countries tab. It must match a code there exactly.',
  DUPLICATE_CODE: 'Two rows of the tab have the same code. Every row is reported, so both sides of the clash can be seen.',
  DUPLICATE_IDENTITY:
    'Two products are the same product: their brand, name, variant and form read the same once case, accents, punctuation and pack sizes are ignored. Keep one row, or tell them apart with the variant or form.',
  DUPLICATE_AVAILABILITY: 'A product has two rows for the same country. Keep one row with the price range for that country.',
  DUPLICATE_RULE:
    'Two ingredient rules of the same kind name the same ingredient, by name or by alias, in lower case. Draft rules count; retired rules do not. Keep one rule for each ingredient and kind.',
  CLASH_NOT_SYMMETRIC:
    'A rule says its group clashes with another group, but no rule of that group says the same back (or the other group has no rule at all). Both sides are reported. Retired rules neither ask for an answer nor give one; draft rules count.',
  CLASH_WITHOUT_GROUP: 'A rule lists groups in clashes_with but has no group of its own. The clash is between groups, so give the rule its group, or clear clashes_with.',
  SELF_CLASH: 'A rule lists its own group in clashes_with. A group does not clash with itself.',
  STRENGTH_WITHOUT_INGREDIENT: 'A product has a strength but no key ingredient. A strength on its own means nothing, so name the key ingredient it belongs to, or clear the strength.',
  DUPLICATE_PHRASE: 'Two claim words that are not retired have the same phrase. Every such row is reported. A retired word may share the phrase of a live one.',
  NOT_A_LIGHTENING_CLAIM:
    'The phrase holds "brightening" or "glow" as a whole word. Brightening and glow are goals people have, not claims to lighten skin, so a product named with them is never flagged for lightening. Leave the phrase out.',
  NOT_LOWER_CASE: 'The phrase has a capital letter. Claim phrases are written in lower case, since a product name is compared with them in lower case.',
  BAD_SCHEDULE:
    'The schedule is not written as steps like `1-2: alternate-days; 3-4: weekly; 5: stop`. Each step is its weeks (a week number from 1, or two with a hyphen, such as 1-2), a colon, and one frequency; steps are separated by semicolons. The frequency is one of the accepted frequencies, or stop. A schedule is at most 52 weeks long.',
  SCHEDULE_NOT_CONTIGUOUS: 'The weeks of the schedule do not run on from week 1 one step after another: it starts after week 1, or leaves a gap, or two steps share a week, or the steps are out of order.',
  SCHEDULE_MISSING_STOP: 'The schedule never says stop. A step-down ends with a step whose frequency is stop.',
  SCHEDULE_STOP_NOT_LAST: 'A step whose frequency is stop is followed by another step. Stop ends the schedule, so it is the last step.',
  SCHEDULE_FREQUENCY_INCREASES: 'A step uses the product more often than the step before it. A step-down only ever goes down: am-pm, then am or pm, then alternate-days, then weekly, then as-needed, then stop.',
  UNQUALIFIED_APPROVER:
    'In production only: a Tapers or Guides row is approved by someone who is not on the list of qualified approvers the server holds. The name is never repeated. A step-down template and a guide are shown to people, so a qualified person has to approve them. It is raised by the server, not by the contract check on the file.',
  GUIDE_BASE_MISSING:
    'A routine step has no approved guide without a goal. Each of the four steps (cleanse, treat, moisturise, protect) needs one approved row with the goal column empty: it is what a person sees when no row is written for their goal. A draft or retired row does not count. It is reported once, on the header row of the Guides tab.',
  GUIDE_DUPLICATE: 'Two rows of the Guides tab are for the same step and goal (or the same step with no goal). Every such row is reported, whatever its status, since a retired row keeps its place. Keep one row for each.',
  GUIDE_WORDING:
    'A guide text holds words a routine never uses: the name of a condition, a diagnosis ("you have ..."), a promise of lighter, fairer or whiter skin, or a score. The same words are refused in every part of the routine. Say what the product does for the skin in plain words, without them.',
} as const
export type RuleCode = keyof typeof RULES

/** The words that are never a claim word: a goal people have, not a claim to lighten skin. */
const NOT_CLAIM_WORDS = /\b(?:brightening|glow)\b/

const VOCABULARIES = {
  skinConcerns: [...SHOWN_CONCERNS],
  skinTypes: [...SKIN_TYPE_LABELS, 'all'],
  steps: [...ROUTINE_STEPS],
  frequencies: [...FREQUENCIES],
  budgetBands: [...BUDGET_BANDS],
  origins: [...ORIGINS],
  categories: [...CATEGORIES],
  forms: [...PRODUCT_FORMS],
  cautionKinds: [...CONCERN_KINDS],
  productStatuses: ['draft', 'approved', 'retired'],
  countryStatuses: ['active', 'retired'],
  claimWordStatuses: ['approved', 'retired'],
  claims: ['lightening'],
  ingredientGroups: [...INGREDIENT_GROUPS],
  taperKinds: [...TAPER_KINDS],
  goals: [...GOALS],
  scheduleFrequencies: [...FREQUENCIES, 'stop'],
}
type VocabularyName = keyof typeof VOCABULARIES

// What each value means, in the plain words of the people who fill the workbook in. The record types make a value added to a vocabulary without
// its words a compile error.
const SKIN_CONCERN_WORDS: Record<ShownConcern, string> = {
  hd_acne: 'spots and breakouts',
  hd_pore: 'visible pores',
  hd_oiliness: 'oily shine',
  hd_age_spot: 'dark spots and marks',
  hd_redness: 'redness',
  hd_radiance: 'dullness / lack of glow',
  hd_texture: 'uneven texture',
  hd_dark_circle: 'dark circles under the eyes',
  hd_moisture: 'dryness / low moisture',
}

const CAUTION_WORDS: Record<ConcernKind, string> = {
  irritation: 'can sting or redden skin',
  allergen: 'a known trigger of allergic reactions',
  'pore-clogging': 'tends to block pores and cause breakouts',
  'sun-sensitivity': 'makes skin burn more easily in the sun',
  'hyperpigmentation-risk': 'can leave dark marks on skin',
  'pregnancy-caution': 'advised against while pregnant or breastfeeding',
  interaction: 'does not mix well with another ingredient',
  'restricted-substance': 'allowed only up to a limit, or for some uses only',
  'banned-substance': 'banned in cosmetics',
  drying: 'can dry the skin out',
}

type ColumnType =
  | 'text'
  | 'list'
  | 'inci'
  | 'inci-list'
  | 'vocabulary'
  | 'vocabulary-list'
  | 'url'
  | 'url-list'
  | 'date'
  | 'integer'
  | 'pattern'
  | 'reference'
  | 'draft-cells'
  | 'schedule'

export type ColumnDefinition = {
  name: string
  type: ColumnType
  /** `unless-retired`: a draft or approved row must have it; a retired row may leave it empty. */
  required: 'always' | 'unless-retired' | 'when-approved' | 'optional'
  /** What the cell holds, in words for the person filling the workbook in. */
  about: string
  vocabulary?: VocabularyName
  /** A value that is only accepted alone, never listed next to another. */
  exclusive?: string
  /** A regular expression, as text, that the whole cell must match; `patternRule` is the code of the problem when it does not. */
  pattern?: string
  patternRule?: 'BAD_CODE' | 'BAD_CURRENCY'
  /** What the pattern asks for, in plain words: the document prints this, never the expression. */
  patternAbout?: string
  maxLength?: number
  maxItems?: number
  itemMaxLength?: number
  /** Free text: no link and no markup. */
  plainText?: true
  /** Text with no capital letter in it. */
  lowerCase?: true
  /** Text that passes the routine's wording gate (`FORBIDDEN_WORDING`): no condition name, diagnosis, promise of lighter skin or score. */
  routineWording?: true
  /** The cell is a code of another tab, and must match one exactly. */
  refersTo?: { tab: TabKey; column: string; rule: 'UNKNOWN_PRODUCT' | 'UNKNOWN_COUNTRY' }
  /** No two rows of the tab have the same value. */
  unique?: true
  /** The column cannot be named in `draft_cells`. */
  draftable?: false
}

export type TabDefinition = {
  key: TabKey
  /** The tab's name in the workbook. */
  title: string
  about: string
  columns: ColumnDefinition[]
  /** The rules that look across cells or rows, which no single column holds. */
  checks: { rule: RuleCode; about: string }[]
}

export type Contract = {
  version: string
  cells: { listSeparator: string; dateFormat: string; text: string }
  vocabularies: Record<VocabularyName, string[]>
  /** What a value of a vocabulary means, for the vocabularies whose values are not plain from their names. */
  vocabularyWords: { skinConcerns: Record<ShownConcern, string>; cautionKinds: Record<ConcernKind, string> }
  /** A word about a vocabulary as a whole, where it needs one. */
  vocabularyNotes: Partial<Record<VocabularyName, string>>
  tabs: TabDefinition[]
  rules: Record<RuleCode, string>
}

const CODE_PATTERN = '^[A-Z0-9][A-Z0-9-]{1,39}$'
const CODE_ABOUT = 'Capital letters, digits and hyphens, 2 to 40 characters, starting with a letter or digit'

// The longest a person's name may be in an approval or an audit, and the longest of the free-text names of a product or an ingredient. A cell is
// measured against these before anything else is read from it.
const NAME_LENGTH = 120
const SIGNER_LENGTH = 80

const statusColumn = (about: string, vocabulary: VocabularyName = 'productStatuses'): ColumnDefinition => ({ name: 'status', type: 'vocabulary', required: 'always', vocabulary, about })

// The longest a step-down may run, in weeks, and the longest its cell may be: ten steps of `52-52: alternate-days` fit in 300 characters with room.
const SCHEDULE_MAX_WEEKS = 52
const SCHEDULE_LENGTH = 300
const SCHEDULE_EXAMPLE = '1-2: alternate-days; 3-4: weekly; 5: stop'
const PHRASE_LENGTH = 60
const TAPER_TEXT_LENGTH = 400
const GUIDE_TEXT_LENGTH = 300

// The sign-off columns are the same on every tab but Availability and Countries.
const signOff = (what: string): ColumnDefinition[] => [
  { name: 'approved_by', type: 'text', required: 'when-approved', maxLength: SIGNER_LENGTH, about: `Who approved this ${what}. Needed when the status is approved.` },
  { name: 'approved_on', type: 'date', required: 'when-approved', about: `The day it was approved. Needed when the status is approved.` },
  { name: 'audited_by', type: 'text', required: 'optional', maxLength: SIGNER_LENGTH, about: `Who checked the approval afterwards. Optional, but given together with audited_on.` },
  { name: 'audited_on', type: 'date', required: 'optional', about: `The day of that check. Optional, but given together with audited_by.` },
]

export const CONTRACT: Contract = {
  version: CONTRACT_VERSION,
  cells: {
    listSeparator: ';',
    dateFormat: 'YYYY-MM-DD',
    text: 'Free text is plain words: no links and no markup. Every cell is trimmed, and a cell of only spaces is empty.',
  },
  vocabularies: VOCABULARIES,
  vocabularyWords: { skinConcerns: SKIN_CONCERN_WORDS, cautionKinds: CAUTION_WORDS },
  vocabularyNotes: {
    scheduleFrequencies:
      'The frequencies of a step-down schedule: the usual frequencies, and stop. A schedule goes only down the ladder, strongest first: am-pm, then am or pm (the same strength), then alternate-days, then weekly, then as-needed, then stop. It never goes back up, and it ends with stop.',
    claims: 'What a claim word says about a product. For now there is one: a product whose brand, name or variant holds the phrase is sold for lightening.',
    ingredientGroups:
      'What an ingredient is, for the rules that look across a shelf, as opposed to what it does. Most ingredient rules have no group. Mercury is stopped at once; steroid and lightening-agent are stopped with a step-down plan.',
    taperKinds: 'The groups that are stopped with a step-down plan and not at once. Mercury is not on the list: it is stopped at once.',
    goals: 'The goals a person can pick. A guide row with a goal is shown to people with that goal instead of the step\'s guide with no goal; the list is the goals the app offers, so it moves when they do.',
    budgetBands:
      'Not a column of any tab. A budget band is a rough answer about how much a person can spend on one new product, and where each band ends is set per country by low_max and mid_max in the Countries tab. It is used when shopping facts are matched to products.',
  },
  tabs: [
    {
      key: 'products',
      title: 'Products',
      about:
        'The products we recommend, one row each. Once approved, a product can be recommended to a person whose skin concerns, skin type and routine step match, in a country where it is sold.',
      columns: [
        { name: 'code', type: 'pattern', required: 'always', pattern: CODE_PATTERN, patternRule: 'BAD_CODE', patternAbout: CODE_ABOUT, unique: true, draftable: false, about: 'Our own short code for the product, such as PRD-CERAVE-CLEANSER. It never changes once the product is in the workbook.' },
        { name: 'brand', type: 'text', required: 'always', maxLength: NAME_LENGTH, plainText: true, about: 'The brand, as printed on the pack.' },
        { name: 'name', type: 'text', required: 'always', maxLength: NAME_LENGTH, plainText: true, about: 'The product name, as printed on the pack, without the brand.' },
        { name: 'variant', type: 'text', required: 'optional', maxLength: NAME_LENGTH, plainText: true, about: 'The variant, shade or scent, when the name alone does not tell two products apart.' },
        { name: 'form', type: 'vocabulary', required: 'optional', vocabulary: 'forms', about: 'What the product is, when the name does not say.' },
        { name: 'category', type: 'vocabulary', required: 'always', vocabulary: 'categories', about: 'What the product is for.' },
        {
          name: 'ingredients',
          type: 'list',
          required: 'unless-retired',
          maxItems: 150,
          itemMaxLength: NAME_LENGTH,
          plainText: true,
          about: 'The full ingredient list in label order (INCI names), separated by ;. A retired product may leave it empty.',
        },
        { name: 'ingredients_source_url', type: 'url', required: 'when-approved', about: 'The page the ingredient list was read from. Needed when the status is approved.' },
        {
          name: 'key_ingredient',
          type: 'text',
          required: 'optional',
          maxLength: 80,
          plainText: true,
          about: 'The ingredient that does the main job, in plain words: for example "Azelaic acid". Shown to users in \'what to look for\'; never used by a rule.',
        },
        { name: 'strength', type: 'text', required: 'optional', maxLength: 40, plainText: true, about: 'Its strength as the label states it: for example "10%". Leave empty when the label does not say.' },
        { name: 'skin_concerns', type: 'vocabulary-list', required: 'always', vocabulary: 'skinConcerns', about: 'The skin concerns the product is for: one or more, separated by ;. These are the concerns a face scan can show.' },
        { name: 'skin_types', type: 'vocabulary-list', required: 'always', vocabulary: 'skinTypes', exclusive: 'all', about: 'The skin types it suits: one or more, separated by ;, or "all" on its own.' },
        { name: 'steps', type: 'vocabulary-list', required: 'always', vocabulary: 'steps', about: 'The routine steps it is used for: one or more, separated by ;.' },
        { name: 'frequency', type: 'vocabulary', required: 'always', vocabulary: 'frequencies', about: 'How often it is used. One value.' },
        { name: 'own_cautions', type: 'vocabulary-list', required: 'optional', vocabulary: 'cautionKinds', about: 'Cautions that come with the product itself, separated by ;, over and above what its ingredients flag.' },
        { name: 'evidence_urls', type: 'url-list', required: 'optional', about: 'Links to the evidence for the recommendation, separated by ;.' },
        { name: 'origin', type: 'vocabulary', required: 'always', vocabulary: 'origins', about: 'Where the recommendation came from. A brand-submitted product has paid for a review only, never for a place.' },
        {
          ...statusColumn('draft: still being worked on, and never recommended. approved: reviewed and recommendable. retired: no longer recommended; the row stays so its code is never reused.'),
          draftable: false,
        },
        ...signOff('product').map((column): ColumnDefinition => ({ ...column, draftable: false })),
        {
          name: 'draft_cells',
          type: 'draft-cells',
          required: 'optional',
          draftable: false,
          about:
            'Cells filled in by the drafting tool and not yet reviewed, written as column=https-link and separated by ;, where the link is the page the value came from. A reviewer clears each entry once the cell is checked. Any Products column can be listed except the code, the status, the approval and audit columns and this one. Not allowed on an approved row.',
        },
      ],
      checks: [
        { rule: 'DUPLICATE_IDENTITY', about: 'No two rows are the same product: brand, name, variant and form, compared without case, accents, punctuation or pack sizes. A retired row counts.' },
        { rule: 'APPROVED_WITH_DRAFT_CELLS', about: 'An approved row has no draft cells.' },
        { rule: 'AUDIT_INCOMPLETE', about: 'audited_by and audited_on are given together, or not at all.' },
        { rule: 'ALL_MIXED_WITH_OTHERS', about: 'skin_types is "all" alone, or a list of types without "all".' },
        { rule: 'STRENGTH_WITHOUT_INGREDIENT', about: 'A product with a strength has a key_ingredient.' },
      ],
    },
    {
      key: 'availability',
      title: 'Availability',
      about: 'Where each product is sold and what it costs there, one row for each product and country. A product with no row for a country is never recommended in it.',
      columns: [
        { name: 'product_code', type: 'reference', required: 'always', refersTo: { tab: 'products', column: 'code', rule: 'UNKNOWN_PRODUCT' }, about: 'The code of a product in the Products tab.' },
        { name: 'country', type: 'reference', required: 'always', refersTo: { tab: 'countries', column: 'code', rule: 'UNKNOWN_COUNTRY' }, about: 'The code of a country in the Countries tab.' },
        { name: 'price_min', type: 'integer', required: 'always', about: 'The lowest price in the country, in whole units of its currency.' },
        { name: 'price_max', type: 'integer', required: 'always', about: 'The highest price in the country, in whole units of its currency.' },
        { name: 'where_sold', type: 'text', required: 'optional', maxLength: 200, plainText: true, about: 'Where to find it, in plain words: for example "Pharmacies and online".' },
        { name: 'source_url', type: 'url', required: 'optional', about: 'Where the price and shop were found.' },
      ],
      checks: [
        { rule: 'PRICE_RANGE', about: 'price_min is not above price_max.' },
        { rule: 'DUPLICATE_AVAILABILITY', about: 'Each product and country pair appears once.' },
      ],
    },
    {
      key: 'ingredients',
      title: 'Ingredients',
      about:
        'The ingredient rules: a fact about an ingredient that every analysis of a product containing it must explain. Only approved rules are used; a draft applies to nothing.',
      columns: [
        { name: 'code', type: 'pattern', required: 'always', pattern: CODE_PATTERN, patternRule: 'BAD_CODE', patternAbout: CODE_ABOUT, unique: true, about: 'Our own short code for the rule, such as ING-RETINOL-SUN-SENSITIVITY. It never changes once the rule is in the workbook.' },
        { name: 'name', type: 'inci', required: 'always', maxLength: NAME_LENGTH, about: 'The ingredient, by its INCI name, in lower case with single spaces and no trailing full stop or asterisk.' },
        { name: 'aliases', type: 'inci-list', required: 'optional', itemMaxLength: NAME_LENGTH, about: 'Other names the ingredient goes by on labels, separated by ;, written the same way as the name.' },
        { name: 'kind', type: 'vocabulary', required: 'always', vocabulary: 'cautionKinds', about: 'What kind of caution this is. An ingredient with two cautions has two rules.' },
        { name: 'strength_limit', type: 'text', required: 'optional', maxLength: 80, plainText: true, about: 'The strength above which the caution applies, in plain words: for example "2% in leave-on products".' },
        { name: 'statement', type: 'text', required: 'always', maxLength: 600, plainText: true, about: 'What is said about the ingredient, in plain words a person can read. No links and no markup.' },
        { name: 'source_url', type: 'url', required: 'optional', about: 'A link to the regulation or listing behind the statement. Leave it empty for a commonly cited caution that no regulation lists.' },
        { name: 'helps', type: 'vocabulary-list', required: 'optional', vocabulary: 'skinConcerns', about: 'The skin concerns the ingredient helps with, separated by ;. Optional.' },
        { name: 'group', type: 'vocabulary', required: 'optional', vocabulary: 'ingredientGroups', about: 'What kind of ingredient this is, where it matters for a shelf: for example retinoid or steroid. Empty for most rules. It does not change how the rule is matched.' },
        {
          name: 'clashes_with',
          type: 'vocabulary-list',
          required: 'optional',
          vocabulary: 'ingredientGroups',
          about:
            'The groups that should not be used together with this rule\'s group, separated by ;. The relation goes both ways: if retinoid lists exfoliating-acid, a rule of the exfoliating-acid group lists retinoid. Needs a group on the rule.',
        },
        statusColumn('draft: still being worked on, and applies to nothing. approved: in force. retired: no longer in force; the row stays so its code is never reused.'),
        ...signOff('rule'),
      ],
      checks: [
        { rule: 'DUPLICATE_RULE', about: 'One rule for each ingredient name or alias and kind among the rules that are not retired; a draft counts.' },
        { rule: 'AUDIT_INCOMPLETE', about: 'audited_by and audited_on are given together, or not at all.' },
        { rule: 'CLASH_WITHOUT_GROUP', about: 'A rule that lists clashes_with has a group.' },
        { rule: 'SELF_CLASH', about: 'A rule does not list its own group in clashes_with.' },
        { rule: 'CLASH_NOT_SYMMETRIC', about: 'If a rule\'s group lists another group, a rule of that group lists the first back. Retired rules are not counted; a draft is.' },
      ],
    },
    {
      key: 'countries',
      title: 'Countries',
      about:
        'The countries the catalog serves, and where each one\'s price bands end. A price in the low band is at most low_max; in the mid band, at most mid_max; the high band has no upper limit. A country is retired, never deleted.',
      columns: [
        { name: 'code', type: 'pattern', required: 'always', pattern: '^[A-Z]{2}$', patternRule: 'BAD_CODE', patternAbout: 'Two capital letters', unique: true, about: 'The ISO 3166 two-letter country code, in capitals, such as NG.' },
        { name: 'currency', type: 'pattern', required: 'always', pattern: '^[A-Z]{3}$', patternRule: 'BAD_CURRENCY', patternAbout: 'Three capital letters', about: 'The ISO 4217 three-letter currency code, in capitals, such as NGN.' },
        { name: 'low_max', type: 'integer', required: 'always', about: 'The top of the low band, in whole units of the currency.' },
        { name: 'mid_max', type: 'integer', required: 'always', about: 'The top of the mid band, in whole units of the currency. Above low_max.' },
        { name: 'status', type: 'vocabulary', required: 'always', vocabulary: 'countryStatuses', about: 'active: recommendations are made here. retired: no longer served; the row stays.' },
      ],
      checks: [{ rule: 'LOW_NOT_BELOW_MID', about: 'low_max is below mid_max.' }],
    },
    {
      key: 'claimWords',
      title: 'Claim words',
      about:
        'Phrases that say a product is sold for lightening or bleaching. A product whose brand, name or variant holds an approved phrase is flagged by the shelf verdict. "Brightening" and "glow" are never claim words. A claim word is retired, never deleted.',
      columns: [
        { name: 'code', type: 'pattern', required: 'always', pattern: CODE_PATTERN, patternRule: 'BAD_CODE', patternAbout: CODE_ABOUT, unique: true, about: 'Our own short code for the claim word, such as CLM-WHITENING. It never changes once the word is in the workbook.' },
        { name: 'phrase', type: 'text', required: 'always', maxLength: PHRASE_LENGTH, plainText: true, lowerCase: true, about: 'The words, in lower case, as they appear in a product name: for example "whitening".' },
        { name: 'claim', type: 'vocabulary', required: 'always', vocabulary: 'claims', about: 'What the phrase claims. Only lightening, for now.' },
        statusColumn('approved: in force. retired: no longer in force; the row stays so its code is never reused. A claim word has no draft: leave a word you are unsure of out of the workbook.', 'claimWordStatuses'),
        ...signOff('claim word'),
      ],
      checks: [
        { rule: 'DUPLICATE_PHRASE', about: 'One claim word for each phrase among the words that are not retired.' },
        { rule: 'NOT_A_LIGHTENING_CLAIM', about: 'No phrase, retired or not, holds "brightening" or "glow" as a whole word (any case).' },
        { rule: 'AUDIT_INCOMPLETE', about: 'audited_by and audited_on are given together, or not at all.' },
      ],
    },
    {
      key: 'tapers',
      title: 'Tapers',
      about:
        'Step-down templates: how a person stops a steroid or a lightening product without the flare of stopping at once. A template is shown to people, so a qualified person approves it; in production the server refuses an approved template whose approver is not on its list. A template is retired, never deleted, so a past routine can still say which plan it used.',
      columns: [
        { name: 'code', type: 'pattern', required: 'always', pattern: CODE_PATTERN, patternRule: 'BAD_CODE', patternAbout: CODE_ABOUT, unique: true, about: 'Our own short code for the template, such as TPR-STEROID-1. It never changes once the template is in the workbook.' },
        { name: 'kind', type: 'vocabulary', required: 'always', vocabulary: 'taperKinds', about: 'The kind of product the template is for.' },
        {
          name: 'schedule',
          type: 'schedule',
          required: 'always',
          vocabulary: 'scheduleFrequencies',
          maxLength: SCHEDULE_LENGTH,
          about: `The steps, separated by ;. Each step is its weeks, a colon and a frequency: a single week (3) or a run of weeks (1-2), then the frequency. Weeks run on from week 1 with no gap, up to week ${SCHEDULE_MAX_WEEKS}. The frequency never goes up, and the last step is stop. For example: ${SCHEDULE_EXAMPLE}`,
        },
        { name: 'what_to_expect', type: 'text', required: 'always', maxLength: TAPER_TEXT_LENGTH, plainText: true, about: 'What a person should expect while stepping down, in plain words: for example that a flare after a step is expected and passes.' },
        { name: 'see_a_professional_if', type: 'text', required: 'always', maxLength: TAPER_TEXT_LENGTH, plainText: true, about: 'When to stop and see a professional, in plain words.' },
        statusColumn('draft: still being worked on, and never shown. approved: reviewed by a qualified person and shown. retired: no longer used; the row stays so its code is never reused.'),
        ...signOff('template'),
      ],
      checks: [{ rule: 'AUDIT_INCOMPLETE', about: 'audited_by and audited_on are given together, or not at all.' }],
    },
    {
      key: 'guides',
      title: 'Guides',
      about:
        'What each routine step is for, what to look for on the label and what suits deeper skin: the guide a person reads before buying a product they do not own. A guide is written here and never by a model, and a qualified person approves it; in production the server refuses an approved guide whose approver is not on its list. A row is one step, and a goal when it is for one: a row with a goal is shown, whole, to people with that goal in place of the step\'s row with no goal, so each of the four steps needs one approved row with no goal. A row is identified by its step and goal, and is retired, never deleted. The pregnancy rule for reviewers: a row with no look_for_when_pregnant is shown to people who are pregnant or breastfeeding as it is, so its look_for must name only things that are safe in pregnancy; write look_for_when_pregnant when it cannot be.',
      columns: [
        { name: 'step', type: 'vocabulary', required: 'always', vocabulary: 'steps', about: 'The routine step the guide is for.' },
        { name: 'goal', type: 'vocabulary', required: 'optional', vocabulary: 'goals', about: 'The goal the guide is for. Leave it empty for the step\'s base guide, which people with any other goal are shown.' },
        { name: 'what_it_does', type: 'text', required: 'always', maxLength: GUIDE_TEXT_LENGTH, plainText: true, routineWording: true, about: 'What this kind of product does for the person, in plain words.' },
        { name: 'look_for', type: 'text', required: 'always', maxLength: GUIDE_TEXT_LENGTH, plainText: true, routineWording: true, about: 'What to check on the label, in plain words. Without look_for_when_pregnant, this is shown to people who are pregnant or breastfeeding too, so name only what is safe for them.' },
        { name: 'for_deeper_skin', type: 'text', required: 'always', maxLength: GUIDE_TEXT_LENGTH, plainText: true, routineWording: true, about: 'What works on deeper skin: for example a finish that leaves no grey or white film.' },
        {
          name: 'look_for_when_pregnant',
          type: 'text',
          required: 'optional',
          maxLength: GUIDE_TEXT_LENGTH,
          plainText: true,
          routineWording: true,
          about: 'What to check on the label for a person who is pregnant or breastfeeding, shown instead of look_for. Leave it empty only when look_for is already safe in pregnancy.',
        },
        statusColumn('draft: still being worked on, and never shown. approved: reviewed by a qualified person and shown. retired: no longer used; the row stays so its step and goal are never reused.'),
        ...signOff('guide'),
      ],
      checks: [
        { rule: 'GUIDE_BASE_MISSING', about: 'Each routine step has one approved row with no goal. A draft or retired row does not count.' },
        { rule: 'GUIDE_DUPLICATE', about: 'Each step and goal pair appears once, a step with no goal counting as a pair. A draft or retired row counts.' },
        { rule: 'GUIDE_WORDING', about: 'No text holds a word the routine never uses (a condition, a diagnosis, lighter, fairer or whiter skin, a score). Every row is checked, drafts too.' },
        { rule: 'AUDIT_INCOMPLETE', about: 'audited_by and audited_on are given together, or not at all.' },
      ],
    },
  ],
  rules: { ...RULES },
}

/** The sha256 of the definitions as stable JSON (keys sorted), as 64 hex digits: it changes when any column, value or rule does. */
export const contractFingerprint = (contract: Contract = CONTRACT): Promise<string> => sha256Hex(stableJson(contract))

// --- the output ---------------------------------------------------------------------------------------------------------------------------------

type RowStatus = 'draft' | 'approved' | 'retired'

export type ProductRow = {
  code: string
  brand: string
  name: string
  variant: string | null
  form: ProductForm | null
  category: Category
  ingredients: string[]
  ingredientsSourceUrl: string | null
  keyIngredient: string | null
  strength: string | null
  skinConcerns: ShownConcern[]
  skinTypes: (SkinTypeLabel | 'all')[]
  steps: RoutineStep[]
  frequency: Frequency
  ownCautions: ConcernKind[]
  evidenceUrls: string[]
  origin: Origin
  status: RowStatus
  approvedBy: string | null
  approvedOn: Date | null
  auditedBy: string | null
  auditedOn: Date | null
  draftCells: { column: string; url: string }[]
}

export type AvailabilityRow = { productCode: string; country: string; priceMin: number; priceMax: number; whereSold: string | null; sourceUrl: string | null }

export type IngredientRule = {
  code: string
  name: string
  aliases: string[]
  kind: ConcernKind
  strengthLimit: string | null
  statement: string
  sourceUrl: string | null
  helps: ShownConcern[]
  /** Rule metadata for the shelf verdict, not part of what the matcher reads. */
  group: IngredientGroup | null
  clashesWith: IngredientGroup[]
  status: RowStatus
  approvedBy: string | null
  approvedOn: Date | null
  auditedBy: string | null
  auditedOn: Date | null
}

export type CountryRow = { code: string; currency: string; lowMax: number; midMax: number; status: 'active' | 'retired' }

export type ClaimWordRow = {
  code: string
  phrase: string
  claim: 'lightening'
  status: 'approved' | 'retired'
  approvedBy: string | null
  approvedOn: Date | null
  auditedBy: string | null
  auditedOn: Date | null
}

/**
 * One step of a step-down: `toWeek` is `fromWeek` for a single week. The frequency is one of the usual frequencies or `stop`, which the contract
 * checks when it reads a schedule; it is typed as text so that a step read back from storage needs no cast.
 */
export type ScheduleStep = { fromWeek: number; toWeek: number; frequency: string }

export type TaperRow = {
  code: string
  kind: TaperKind
  schedule: ScheduleStep[]
  whatToExpect: string
  seeAProfessionalIf: string
  status: RowStatus
  approvedBy: string | null
  approvedOn: Date | null
  auditedBy: string | null
  auditedOn: Date | null
}

/** A guide is identified by its step and goal, not a code; a null goal is the step's base guide. */
export type GuideRow = {
  step: RoutineStep
  goal: Goal | null
  whatItDoes: string
  lookFor: string
  forDeeperSkin: string
  lookForWhenPregnant: string | null
  status: RowStatus
  approvedBy: string | null
  approvedOn: Date | null
  auditedBy: string | null
  auditedOn: Date | null
}

export type Workbook = {
  products: ProductRow[]
  availability: AvailabilityRow[]
  ingredients: IngredientRule[]
  countries: CountryRow[]
  claimWords: ClaimWordRow[]
  tapers: TaperRow[]
  guides: GuideRow[]
}

/** A guide's key where one is needed (a diff, a stored row): its step, and `step:goal` when it is for a goal. No step or goal has a colon in it. */
export const guideKey = (row: { step: string; goal: string | null }): string => (row.goal === null ? row.step : `${row.step}:${row.goal}`)

/** Guides in the order the export lists them: routine step order, a step's base guide first, then its goal guides in the order the goals are offered. */
export const compareGuides = (a: { step: RoutineStep; goal: Goal | null }, b: { step: RoutineStep; goal: Goal | null }): number => {
  const goalAt = (goal: Goal | null) => (goal === null ? -1 : GOALS.indexOf(goal))
  return ROUTINE_STEPS.indexOf(a.step) - ROUTINE_STEPS.indexOf(b.step) || goalAt(a.goal) - goalAt(b.goal)
}

/** Where in the workbook, and which rule: never what the cell held. `row` is the spreadsheet row, so the header is 1 and the first data row 2. */
export type WorkbookProblem = { tab: TabKey; row: number; column: string; rule: RuleCode }

export type WorkbookResult = { ok: true; workbook: Workbook } | { ok: false; problems: WorkbookProblem[] }

// --- reading a schedule -------------------------------------------------------------------------------------------------------------------------

/** How strong a step is, so that a schedule can be held to only ever going down. am and pm are the same strength. */
const STRENGTH: Record<Frequency | 'stop', number> = { 'am-pm': 5, am: 4, pm: 4, 'alternate-days': 3, weekly: 2, 'as-needed': 1, stop: 0 }

const SCHEDULE_ENTRY = /^(\d{1,3})(?:-(\d{1,3}))?\s*:\s*(\S+)$/

/** The steps of a schedule cell, or null when any entry is not `<weeks>: <frequency>` (weeks from 1, a run written low to high). */
const readSchedule = (text: string): ScheduleStep[] | null => {
  const entries = text.split(';').map((entry) => entry.trim()).filter((entry) => entry !== '')
  if (entries.length === 0) return null
  const steps: ScheduleStep[] = []
  for (const entry of entries) {
    const found = SCHEDULE_ENTRY.exec(entry)
    if (found === null) return null
    const fromWeek = Number(found[1])
    const toWeek = found[2] === undefined ? fromWeek : Number(found[2])
    const frequency = found[3]!
    if (fromWeek < 1 || toWeek < fromWeek || toWeek > SCHEDULE_MAX_WEEKS || !Object.hasOwn(STRENGTH, frequency)) return null
    steps.push({ fromWeek, toWeek, frequency })
  }
  return steps
}

/** The rules a read schedule breaks. A schedule with one fault breaks one rule: a stop in the middle does not also count as a rise after it. */
const scheduleFaults = (steps: ScheduleStep[]): RuleCode[] => {
  const faults: RuleCode[] = []
  let expected = 1
  const contiguous = steps.every((step) => {
    const here = step.fromWeek === expected
    expected = step.toWeek + 1
    return here
  })
  if (!contiguous) faults.push('SCHEDULE_NOT_CONTIGUOUS')
  const firstStop = steps.findIndex((step) => step.frequency === 'stop')
  if (firstStop < 0) faults.push('SCHEDULE_MISSING_STOP')
  else if (firstStop < steps.length - 1 || steps.filter((step) => step.frequency === 'stop').length > 1) faults.push('SCHEDULE_STOP_NOT_LAST')
  // Only the steps up to the first stop are compared: what follows a misplaced stop is already reported.
  const until = firstStop < 0 ? steps : steps.slice(0, firstStop + 1)
  const strength = (step: ScheduleStep) => STRENGTH[step.frequency as keyof typeof STRENGTH]
  if (until.some((step, i) => i > 0 && strength(step) > strength(until[i - 1]!))) faults.push('SCHEDULE_FREQUENCY_INCREASES')
  return faults
}

// --- reading one tab ----------------------------------------------------------------------------------------------------------------------------

/**
 * One tab's rows read through its column definitions. Each reader checks a cell against what its column says, records every problem it finds, and
 * returns what it could read. A cell that fails gives null (or an empty list), so the rows built from the readers are used only when no problem
 * was recorded anywhere.
 */
class Sheet {
  private static readonly DATE = /^(\d{4})-(\d{2})-(\d{2})$/
  private static readonly WHOLE_NUMBER = /^\d+$/
  /** A header the contract does not know is named in a problem, so a long one is cut: a header can be as long as a cell. */
  private static readonly UNKNOWN_COLUMN_NAME = 80

  private readonly columns: Map<string, ColumnDefinition>
  /** The columns the tab has: its header row, whatever keys the rows carry. A key a row has that is no header is never read. */
  private readonly headers: Set<string>
  readonly rows: RawRow[]

  constructor(
    readonly key: TabKey,
    tab: RawTab,
    private readonly report: (problem: WorkbookProblem) => void,
  ) {
    const definition = CONTRACT.tabs.find((candidate) => candidate.key === key)!
    this.columns = new Map(definition.columns.map((column) => [column.name, column]))
    this.headers = new Set(tab.headers)
    this.rows = tab.rows
  }

  /** The header row is checked even when the tab has no rows: the file is still written to the contract, or not. */
  checkHeader(): void {
    for (const name of this.columns.keys()) if (!this.headers.has(name)) this.report({ tab: this.key, row: 1, column: name, rule: 'MISSING_COLUMN' })
    for (const name of this.headers) {
      if (!this.columns.has(name)) this.report({ tab: this.key, row: 1, column: name.slice(0, Sheet.UNKNOWN_COLUMN_NAME), rule: 'UNKNOWN_COLUMN' })
    }
  }

  /** Whether the tab has the column. A column that is missing is reported once, as missing, and nothing more is said about its cells. */
  has(column: string): boolean {
    return this.headers.has(column)
  }

  /** The trimmed text of a cell that is not empty, whatever it holds, with no checking: for a row's own status, and for the clashes between rows. */
  value(i: number, column: string): string | null {
    const cell = this.cell(i, column)
    return cell === null || cell === '' ? null : String(cell)
  }

  /**
   * Whether the cell is over its column's length cap. Such a cell is already a problem, and what it would clash with is not worked out: that is
   * work a huge cell must not be able to cost.
   */
  overCap(i: number, column: string): boolean {
    const cap = this.columns.get(column)?.maxLength
    return cap !== undefined && this.has(column) && (this.value(i, column)?.length ?? 0) > cap
  }

  /** The items of a list cell that are within the column's item cap, for the clashes between rows; the others are already a problem. */
  itemsWithinCap(i: number, column: string): string[] {
    const cap = this.columns.get(column)?.itemMaxLength
    return (this.items(i, column) ?? []).filter((item) => cap === undefined || item.length <= cap)
  }

  /** Whether the cell is empty. A missing column has no cells to be empty, so it is not. */
  isEmpty(i: number, column: string): boolean {
    return this.has(column) && this.value(i, column) === null
  }

  text(i: number, column: string): string | null {
    const definition = this.define(column, 'text')
    if (!this.has(column)) return null
    const value = this.value(i, column)
    if (value === null) return this.missing(i, definition)
    this.checkText(i, definition, value)
    return value
  }

  list(i: number, column: string): string[] {
    const definition = this.define(column, 'list')
    const items = this.items(i, column)
    if (items === null) return []
    if (items.length === 0) {
      this.missing(i, definition)
      return []
    }
    if (definition.maxItems !== undefined && items.length > definition.maxItems) this.fail(i, column, 'TOO_MANY_ITEMS')
    const kept = this.withinItemCap(i, column, items, definition)
    if (definition.plainText && kept.some(hasLinkOrMarkup)) this.fail(i, column, 'HAS_LINK_OR_MARKUP')
    return items
  }

  /** An INCI name, lower-cased. Whether it is written the way the matcher compares names is checked, never silently fixed beyond case. */
  inci(i: number, column: string): string | null {
    const definition = this.define(column, 'inci')
    if (!this.has(column)) return null
    const value = this.value(i, column)
    if (value === null) return this.missing(i, definition)
    if (definition.maxLength !== undefined && value.length > definition.maxLength) {
      this.fail(i, column, 'TOO_LONG')
      return null
    }
    const name = value.toLowerCase()
    if (normaliseIngredient(name) !== name) this.fail(i, column, 'NOT_NORMALISED')
    return name
  }

  inciList(i: number, column: string): string[] {
    const definition = this.define(column, 'inci-list')
    const items = this.items(i, column) ?? []
    const names = this.withinItemCap(i, column, items, definition).map((item) => item.toLowerCase())
    if (names.some((name) => normaliseIngredient(name) !== name)) this.fail(i, column, 'NOT_NORMALISED')
    return names
  }

  vocabulary<T extends string>(i: number, column: string): T | null {
    const definition = this.define(column, 'vocabulary')
    if (!this.has(column)) return null
    const value = this.value(i, column)
    if (value === null) return this.missing(i, definition)
    if (!Sheet.accepted(definition).includes(value)) {
      this.fail(i, column, 'NOT_IN_VOCABULARY')
      return null
    }
    return value as T
  }

  vocabularyList<T extends string>(i: number, column: string): T[] {
    const definition = this.define(column, 'vocabulary-list')
    const items = this.items(i, column)
    if (items === null) return []
    if (items.length === 0) {
      this.missing(i, definition)
      return []
    }
    const accepted = Sheet.accepted(definition)
    if (items.some((item) => !accepted.includes(item))) {
      this.fail(i, column, 'NOT_IN_VOCABULARY')
      return []
    }
    if (definition.exclusive !== undefined && items.length > 1 && items.includes(definition.exclusive)) this.fail(i, column, 'ALL_MIXED_WITH_OTHERS')
    return items as T[]
  }

  url(i: number, column: string): string | null {
    const definition = this.define(column, 'url')
    if (!this.has(column)) return null
    const value = this.value(i, column)
    if (value === null) return this.missing(i, definition)
    if (!isSafePublicHttpsUrl(value)) {
      this.fail(i, column, 'NOT_HTTPS_URL')
      return null
    }
    return value
  }

  urlList(i: number, column: string): string[] {
    this.define(column, 'url-list')
    const items = this.items(i, column) ?? []
    if (items.some((item) => !isSafePublicHttpsUrl(item))) {
      this.fail(i, column, 'NOT_HTTPS_URL')
      return []
    }
    return items
  }

  /** A calendar day written YYYY-MM-DD, as midnight UTC. A date a spreadsheet turned into a number or a date type is refused: the cell must be text. */
  date(i: number, column: string): Date | null {
    const definition = this.define(column, 'date')
    if (!this.has(column)) return null
    const cell = this.cell(i, column)
    if (cell === null || cell === '') return this.missing(i, definition)
    const date = typeof cell === 'string' && Sheet.DATE.test(cell) ? new Date(`${cell}T00:00:00.000Z`) : null
    // A day that does not exist ("2030-02-30") is read by the parser as another day, so it must read back as written.
    if (date === null || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== cell) {
      this.fail(i, column, 'BAD_DATE')
      return null
    }
    return date
  }

  integer(i: number, column: string): number | null {
    const definition = this.define(column, 'integer')
    if (!this.has(column)) return null
    const cell = this.cell(i, column)
    if (cell === null || cell === '') return this.missing(i, definition)
    const number = typeof cell === 'number' ? cell : typeof cell === 'string' && Sheet.WHOLE_NUMBER.test(cell) ? Number(cell) : Number.NaN
    if (!Number.isSafeInteger(number) || number < 0) {
      this.fail(i, column, 'NOT_A_WHOLE_NUMBER')
      return null
    }
    return number
  }

  /** A cell that must match the column's pattern as a whole. */
  pattern(i: number, column: string): string | null {
    const definition = this.define(column, 'pattern')
    if (!this.has(column)) return null
    const value = this.value(i, column)
    if (value === null) return this.missing(i, definition)
    if (!new RegExp(definition.pattern!).test(value)) this.fail(i, column, definition.patternRule!)
    return value
  }

  /** A code of another tab: `known` holds that tab's codes as they were written. */
  reference(i: number, column: string, known: ReadonlySet<string>): string | null {
    const definition = this.define(column, 'reference')
    if (!this.has(column)) return null
    const value = this.value(i, column)
    if (value === null) return this.missing(i, definition)
    if (!known.has(value)) this.fail(i, column, definition.refersTo!.rule)
    return value
  }

  /** `column=https-link` pairs, split at the first "=" so a link may carry its own. `draftable` is the columns a pair may name. */
  draftCells(i: number, column: string, draftable: ReadonlySet<string>, approved: boolean): { column: string; url: string }[] {
    this.define(column, 'draft-cells')
    const items = this.items(i, column) ?? []
    if (approved && items.length > 0) this.fail(i, column, 'APPROVED_WITH_DRAFT_CELLS')
    const cells: { column: string; url: string }[] = []
    for (const item of items) {
      const at = item.indexOf('=')
      const named = at < 0 ? '' : item.slice(0, at).trim()
      const url = at < 0 ? '' : item.slice(at + 1).trim()
      if (named === '' || url === '') this.fail(i, column, 'INVALID_DRAFT_CELL')
      else if (!draftable.has(named)) this.fail(i, column, 'DRAFT_CELL_COLUMN')
      else if (!isSafePublicHttpsUrl(url)) this.fail(i, column, 'NOT_HTTPS_URL')
      else cells.push({ column: named, url })
    }
    return cells
  }

  /** An audit is a name and a day together or not at all: reports the half that is missing. Whether either half is valid is for its own reader. */
  checkAudit(i: number): void {
    if (!this.has('audited_by') || !this.has('audited_on')) return
    const by = this.isEmpty(i, 'audited_by')
    const on = this.isEmpty(i, 'audited_on')
    if (by && !on) this.fail(i, 'audited_by', 'AUDIT_INCOMPLETE')
    if (on && !by) this.fail(i, 'audited_on', 'AUDIT_INCOMPLETE')
  }

  fail(i: number, column: string, rule: RuleCode): void {
    this.report({ tab: this.key, row: i + 2, column, rule })
  }

  /** A problem of the tab as a whole, which has no row to point at: it sits on the header row, as a missing column does. */
  failOnHeader(column: string, rule: RuleCode): void {
    this.report({ tab: this.key, row: 1, column, rule })
  }

  private cell(i: number, column: string): Cell {
    const cell = this.rows[i]![column] ?? null
    return typeof cell === 'string' ? cell.trim() : cell
  }

  /** The items of a list cell, trimmed, empty ones dropped, with no checking; null when the column is missing. */
  items(i: number, column: string): string[] | null {
    if (!this.has(column)) return null
    const value = this.value(i, column)
    return value === null ? [] : value.split(';').map((item) => item.trim()).filter((item) => item !== '')
  }

  /** Reports ITEM_TOO_LONG when an item is over the column's cap, and gives the items that are not: only those are read any further. */
  private withinItemCap(i: number, column: string, items: string[], definition: ColumnDefinition): string[] {
    const cap = definition.itemMaxLength
    if (cap === undefined) return items
    const kept = items.filter((item) => item.length <= cap)
    if (kept.length < items.length) this.fail(i, column, 'ITEM_TOO_LONG')
    return kept
  }

  private checkText(i: number, definition: ColumnDefinition, value: string): void {
    // The length is checked first, and a cell over it says only that: a huge cell is refused for what it costs to measure, not to read.
    if (definition.maxLength !== undefined && value.length > definition.maxLength) this.fail(i, definition.name, 'TOO_LONG')
    else {
      if (definition.plainText && hasLinkOrMarkup(value)) this.fail(i, definition.name, 'HAS_LINK_OR_MARKUP')
      if (definition.lowerCase && value !== value.toLowerCase()) this.fail(i, definition.name, 'NOT_LOWER_CASE')
      if (definition.routineWording && FORBIDDEN_WORDING.some(({ pattern }) => pattern.test(value))) this.fail(i, definition.name, 'GUIDE_WORDING')
    }
  }

  /** A step-down schedule. A cell that is not in the format is one problem; a cell that is, but breaks a rule of schedules, gives each rule it breaks. */
  schedule(i: number, column: string): ScheduleStep[] {
    const definition = this.define(column, 'schedule')
    if (!this.has(column)) return []
    const value = this.value(i, column)
    if (value === null) {
      this.missing(i, definition)
      return []
    }
    // The length first, as for any text: a huge cell is refused for its length alone.
    if (definition.maxLength !== undefined && value.length > definition.maxLength) {
      this.fail(i, column, 'TOO_LONG')
      return []
    }
    const steps = readSchedule(value)
    if (steps === null) {
      this.fail(i, column, 'BAD_SCHEDULE')
      return []
    }
    for (const fault of scheduleFaults(steps)) this.fail(i, column, fault)
    return steps
  }

  /** Records that the cell is empty when its column needs it for this row, and gives null either way. */
  private missing(i: number, definition: ColumnDefinition): null {
    // The status is read as written, so a row with a bad status still gets the right "needed when approved" answers for its other cells.
    const status = this.has('status') ? this.value(i, 'status') : null
    if (definition.required === 'always' || (definition.required === 'unless-retired' && status !== 'retired')) this.fail(i, definition.name, 'REQUIRED')
    else if (definition.required === 'when-approved' && status === 'approved') this.fail(i, definition.name, 'REQUIRED_WHEN_APPROVED')
    return null
  }

  /** The column's definition. The reader a row builder calls must be the one for the column's type, or the builder and the contract have drifted. */
  private define(column: string, type: ColumnType): ColumnDefinition {
    const definition = this.columns.get(column)
    if (definition?.type !== type) throw new Error(`${this.key}.${column} is not a ${type} column in the contract`)
    return definition
  }

  private static accepted(definition: ColumnDefinition): readonly string[] {
    return VOCABULARIES[definition.vocabulary!]
  }
}

// --- checking a workbook ------------------------------------------------------------------------------------------------------------------------

class WorkbookValidator {
  private readonly problems: WorkbookProblem[] = []
  private readonly reported = new Set<string>()

  private readonly products: Sheet
  private readonly availability: Sheet
  private readonly ingredients: Sheet
  private readonly countries: Sheet
  private readonly claimWords: Sheet
  private readonly tapers: Sheet
  private readonly guides: Sheet

  constructor(raw: RawWorkbook) {
    const sheet = (key: TabKey) => new Sheet(key, raw[key], (problem) => this.report(problem))
    this.products = sheet('products')
    this.availability = sheet('availability')
    this.ingredients = sheet('ingredients')
    this.countries = sheet('countries')
    this.claimWords = sheet('claimWords')
    this.tapers = sheet('tapers')
    this.guides = sheet('guides')
  }

  run(): WorkbookResult {
    for (const sheet of [this.products, this.availability, this.ingredients, this.countries, this.claimWords, this.tapers, this.guides]) sheet.checkHeader()
    const workbook: Workbook = {
      products: this.products.rows.map((_, i) => this.product(i)),
      availability: this.availability.rows.map((_, i) => this.availabilityRow(i)),
      ingredients: this.ingredients.rows.map((_, i) => this.ingredient(i)),
      countries: this.countries.rows.map((_, i) => this.country(i)),
      claimWords: this.claimWords.rows.map((_, i) => this.claimWord(i)),
      tapers: this.tapers.rows.map((_, i) => this.taper(i)),
      guides: this.guides.rows.map((_, i) => this.guide(i)),
    }
    this.clashes()
    return this.problems.length === 0 ? { ok: true, workbook } : { ok: false, problems: this.problems }
  }

  // Each builder below uses what its readers give without checking for null: a reader that returned null has recorded the problem, and the
  // rows are used only when there is none.

  private product(i: number): ProductRow {
    const s = this.products
    const status = s.vocabulary<RowStatus>(i, 'status')
    s.checkAudit(i)
    if (s.isEmpty(i, 'key_ingredient') && s.has('strength') && s.value(i, 'strength') !== null) s.fail(i, 'strength', 'STRENGTH_WITHOUT_INGREDIENT')
    return {
      code: s.pattern(i, 'code')!,
      brand: s.text(i, 'brand')!,
      name: s.text(i, 'name')!,
      variant: s.text(i, 'variant'),
      form: s.vocabulary<ProductForm>(i, 'form'),
      category: s.vocabulary<Category>(i, 'category')!,
      ingredients: s.list(i, 'ingredients'),
      ingredientsSourceUrl: s.url(i, 'ingredients_source_url'),
      keyIngredient: s.text(i, 'key_ingredient'),
      strength: s.text(i, 'strength'),
      skinConcerns: s.vocabularyList<ShownConcern>(i, 'skin_concerns'),
      skinTypes: s.vocabularyList<SkinTypeLabel | 'all'>(i, 'skin_types'),
      steps: s.vocabularyList<RoutineStep>(i, 'steps'),
      frequency: s.vocabulary<Frequency>(i, 'frequency')!,
      ownCautions: s.vocabularyList<ConcernKind>(i, 'own_cautions'),
      evidenceUrls: s.urlList(i, 'evidence_urls'),
      origin: s.vocabulary<Origin>(i, 'origin')!,
      status: status!,
      approvedBy: s.text(i, 'approved_by'),
      approvedOn: s.date(i, 'approved_on'),
      auditedBy: s.text(i, 'audited_by'),
      auditedOn: s.date(i, 'audited_on'),
      draftCells: s.draftCells(i, 'draft_cells', this.draftableColumns(), status === 'approved'),
    }
  }

  private availabilityRow(i: number): AvailabilityRow {
    const s = this.availability
    const priceMin = s.integer(i, 'price_min')
    const priceMax = s.integer(i, 'price_max')
    if (priceMin !== null && priceMax !== null && priceMin > priceMax) s.fail(i, 'price_max', 'PRICE_RANGE')
    return {
      productCode: s.reference(i, 'product_code', this.codesOf(this.products))!,
      country: s.reference(i, 'country', this.codesOf(this.countries))!,
      priceMin: priceMin!,
      priceMax: priceMax!,
      whereSold: s.text(i, 'where_sold'),
      sourceUrl: s.url(i, 'source_url'),
    }
  }

  private ingredient(i: number): IngredientRule {
    const s = this.ingredients
    s.checkAudit(i)
    return {
      code: s.pattern(i, 'code')!,
      name: s.inci(i, 'name')!,
      aliases: s.inciList(i, 'aliases'),
      kind: s.vocabulary<ConcernKind>(i, 'kind')!,
      strengthLimit: s.text(i, 'strength_limit'),
      statement: s.text(i, 'statement')!,
      sourceUrl: s.url(i, 'source_url'),
      helps: s.vocabularyList<ShownConcern>(i, 'helps'),
      group: s.vocabulary<IngredientGroup>(i, 'group'),
      clashesWith: s.vocabularyList<IngredientGroup>(i, 'clashes_with'),
      status: s.vocabulary<RowStatus>(i, 'status')!,
      approvedBy: s.text(i, 'approved_by'),
      approvedOn: s.date(i, 'approved_on'),
      auditedBy: s.text(i, 'audited_by'),
      auditedOn: s.date(i, 'audited_on'),
    }
  }

  private country(i: number): CountryRow {
    const s = this.countries
    const lowMax = s.integer(i, 'low_max')
    const midMax = s.integer(i, 'mid_max')
    if (lowMax !== null && midMax !== null && lowMax >= midMax) s.fail(i, 'mid_max', 'LOW_NOT_BELOW_MID')
    return {
      code: s.pattern(i, 'code')!,
      currency: s.pattern(i, 'currency')!,
      lowMax: lowMax!,
      midMax: midMax!,
      status: s.vocabulary<CountryRow['status']>(i, 'status')!,
    }
  }

  private claimWord(i: number): ClaimWordRow {
    const s = this.claimWords
    s.checkAudit(i)
    return {
      code: s.pattern(i, 'code')!,
      phrase: s.text(i, 'phrase')!,
      claim: s.vocabulary<ClaimWordRow['claim']>(i, 'claim')!,
      status: s.vocabulary<ClaimWordRow['status']>(i, 'status')!,
      approvedBy: s.text(i, 'approved_by'),
      approvedOn: s.date(i, 'approved_on'),
      auditedBy: s.text(i, 'audited_by'),
      auditedOn: s.date(i, 'audited_on'),
    }
  }

  private taper(i: number): TaperRow {
    const s = this.tapers
    s.checkAudit(i)
    return {
      code: s.pattern(i, 'code')!,
      kind: s.vocabulary<TaperKind>(i, 'kind')!,
      schedule: s.schedule(i, 'schedule'),
      whatToExpect: s.text(i, 'what_to_expect')!,
      seeAProfessionalIf: s.text(i, 'see_a_professional_if')!,
      status: s.vocabulary<RowStatus>(i, 'status')!,
      approvedBy: s.text(i, 'approved_by'),
      approvedOn: s.date(i, 'approved_on'),
      auditedBy: s.text(i, 'audited_by'),
      auditedOn: s.date(i, 'audited_on'),
    }
  }

  private guide(i: number): GuideRow {
    const s = this.guides
    s.checkAudit(i)
    return {
      step: s.vocabulary<RoutineStep>(i, 'step')!,
      goal: s.vocabulary<Goal>(i, 'goal'),
      whatItDoes: s.text(i, 'what_it_does')!,
      lookFor: s.text(i, 'look_for')!,
      forDeeperSkin: s.text(i, 'for_deeper_skin')!,
      lookForWhenPregnant: s.text(i, 'look_for_when_pregnant'),
      status: s.vocabulary<RowStatus>(i, 'status')!,
      approvedBy: s.text(i, 'approved_by'),
      approvedOn: s.date(i, 'approved_on'),
      auditedBy: s.text(i, 'audited_by'),
      auditedOn: s.date(i, 'audited_on'),
    }
  }

  /** The Products columns a draft cell may name: every one but those that identify or sign off the row. */
  private draftableColumns(): Set<string> {
    const products = CONTRACT.tabs.find((tab) => tab.key === 'products')!
    return new Set(products.columns.filter((column) => column.draftable !== false).map((column) => column.name))
  }

  /** The codes a tab's rows were written with, as written: a code in the wrong format still names its row, so it is not also "unknown". */
  private codesOf(sheet: Sheet): Set<string> {
    const codes = new Set<string>()
    for (let i = 0; i < sheet.rows.length; i++) {
      const code = sheet.has('code') ? sheet.value(i, 'code') : null
      if (code !== null) codes.add(code)
    }
    return codes
  }

  // --- rules between rows: every row in a clash is reported, so the author sees both sides ------------------------------------------------------

  private clashes(): void {
    const { products, availability, ingredients, countries, claimWords, tapers, guides } = this
    for (const sheet of [products, ingredients, countries, claimWords, tapers]) {
      this.reportClash(sheet, 'DUPLICATE_CODE', (i) => {
        const code = sheet.has('code') ? sheet.value(i, 'code') : null
        return code === null ? [] : [{ key: code, column: 'code' }]
      })
    }
    this.reportClash(products, 'DUPLICATE_IDENTITY', (i) => {
      if (['brand', 'name', 'variant'].some((column) => products.overCap(i, column))) return []
      const brand = products.has('brand') ? products.value(i, 'brand') : null
      const name = products.has('name') ? products.value(i, 'name') : null
      if (brand === null || name === null) return []
      const variant = products.has('variant') ? products.value(i, 'variant') : null
      const form = products.has('form') ? products.value(i, 'form') : null
      return [{ key: identityKey({ brand, name, variant, form }), column: 'name' }]
    })
    this.reportClash(availability, 'DUPLICATE_AVAILABILITY', (i) => {
      const product = availability.has('product_code') ? availability.value(i, 'product_code') : null
      const country = availability.has('country') ? availability.value(i, 'country') : null
      return product === null || country === null ? [] : [{ key: JSON.stringify([product, country]), column: 'country' }]
    })
    this.reportClash(ingredients, 'DUPLICATE_RULE', (i) => {
      const kind = ingredients.has('kind') ? ingredients.value(i, 'kind') : null
      // A retired rule applies to nothing and may be replaced by a new one for the same label; a draft is waiting to become a rule, so it counts.
      if (kind === null || (ingredients.has('status') && ingredients.value(i, 'status') === 'retired')) return []
      // Labels are compared as the matcher compares them, in lower case; the problem names the column a label is written in.
      const label = (text: string, column: string) => ({ key: JSON.stringify([kind, text.toLowerCase()]), column })
      const name = ingredients.has('name') && !ingredients.overCap(i, 'name') ? ingredients.value(i, 'name') : null
      return [...(name === null ? [] : [label(name, 'name')]), ...ingredients.itemsWithinCap(i, 'aliases').map((alias) => label(alias, 'aliases'))]
    })
    claimWords.rows.forEach((_, i) => {
      // Whole words, so "glowing" is not caught; lower-cased first, so a phrase with a capital is told that too (NOT_LOWER_CASE) and this as well.
      if (!claimWords.has('phrase') || claimWords.overCap(i, 'phrase')) return
      const phrase = claimWords.value(i, 'phrase')
      if (phrase !== null && NOT_CLAIM_WORDS.test(phrase.toLowerCase())) claimWords.fail(i, 'phrase', 'NOT_A_LIGHTENING_CLAIM')
    })
    this.reportClash(claimWords, 'DUPLICATE_PHRASE', (i) => {
      // As for a rule: a retired word applies to nothing, and may be replaced by a new one for the same phrase.
      if (!claimWords.has('phrase') || claimWords.overCap(i, 'phrase') || (claimWords.has('status') && claimWords.value(i, 'status') === 'retired')) return []
      const phrase = claimWords.value(i, 'phrase')
      return phrase === null ? [] : [{ key: phrase.toLowerCase(), column: 'phrase' }]
    })
    this.ruleClashes()
    this.guideRules(guides)
  }

  /**
   * The rules between Guides rows. A guide has no code: it is its step and goal, read from the cells as written (trimmed), and a cell that is not in its
   * vocabulary is already a problem of its own and takes no part, so it is reported as that and nothing more.
   */
  private guideRules(s: Sheet): void {
    if (!s.has('step')) return
    const steps: readonly string[] = VOCABULARIES.steps
    const goals: readonly string[] = VOCABULARIES.goals
    const stepOf = (i: number): string | null => {
      const step = s.value(i, 'step')
      return step !== null && steps.includes(step) ? step : null
    }
    // A goal cell that is empty is a base row; one that is not a goal is no row's key.
    const goalOf = (i: number): string | null => (s.has('goal') ? s.value(i, 'goal') : null)
    this.reportClash(s, 'GUIDE_DUPLICATE', (i) => {
      const step = stepOf(i)
      const goal = goalOf(i)
      return step === null || (goal !== null && !goals.includes(goal)) ? [] : [{ key: JSON.stringify([step, goal]), column: 'step' }]
    })
    // Without a status column no row can be said to be approved, and that column is already reported as missing.
    if (!s.has('status')) return
    const covered = new Set(s.rows.flatMap((_, i) => (goalOf(i) === null && s.value(i, 'status') === 'approved' && stepOf(i) !== null ? [stepOf(i)!] : [])))
    if (steps.some((step) => !covered.has(step))) s.failOnHeader('step', 'GUIDE_BASE_MISSING')
  }

  /**
   * The clashes between ingredient groups: a rule lists the groups its own group clashes with, and the relation has to hold both ways. It is read
   * from the cells as written, not from what the readers gave, so a bad item in a list is reported as that and nothing more. A retired rule neither
   * asks for an answer nor gives one.
   */
  private ruleClashes(): void {
    const s = this.ingredients
    if (!s.has('group') || !s.has('clashes_with')) return
    const known = (text: string): text is IngredientGroup => (INGREDIENT_GROUPS as readonly string[]).includes(text)
    const rules: { i: number; group: IngredientGroup; clashes: IngredientGroup[] }[] = []
    s.rows.forEach((_, i) => {
      if (s.has('status') && s.value(i, 'status') === 'retired') return
      const clashes = [...new Set((s.items(i, 'clashes_with') ?? []).filter(known))]
      const written = s.value(i, 'group')
      if (written === null) {
        if (clashes.length > 0) s.fail(i, 'clashes_with', 'CLASH_WITHOUT_GROUP')
        return
      }
      if (!known(written)) return
      if (clashes.includes(written)) s.fail(i, 'clashes_with', 'SELF_CLASH')
      rules.push({ i, group: written, clashes: clashes.filter((other) => other !== written) })
    })
    for (const rule of rules) {
      for (const other of rule.clashes) {
        const answering = rules.filter((candidate) => candidate.group === other)
        if (answering.some((candidate) => candidate.clashes.includes(rule.group))) continue
        s.fail(rule.i, 'clashes_with', 'CLASH_NOT_SYMMETRIC')
        for (const candidate of answering) s.fail(candidate.i, 'group', 'CLASH_NOT_SYMMETRIC')
      }
    }
  }

  /** Reports every row that has a key (a row may have several, each with the column it sits in) another row has too. A row repeating its own key is no clash. */
  private reportClash(sheet: Sheet, rule: RuleCode, keysOf: (i: number) => { key: string; column: string }[]): void {
    const rowsByKey = new Map<string, Set<number>>()
    sheet.rows.forEach((_, i) => {
      for (const { key } of keysOf(i)) rowsByKey.set(key, (rowsByKey.get(key) ?? new Set<number>()).add(i))
    })
    sheet.rows.forEach((_, i) => {
      for (const { key, column } of keysOf(i)) if ((rowsByKey.get(key)?.size ?? 0) > 1) sheet.fail(i, column, rule)
    })
  }

  /** Each problem once, however many checks found it. */
  private report(problem: WorkbookProblem): void {
    const key = `${problem.tab}|${problem.row}|${problem.column}|${problem.rule}`
    if (this.reported.has(key)) return
    this.reported.add(key)
    this.problems.push(problem)
  }
}

/** Checks a workbook against the contract: the parsed workbook, or every problem found. */
export const validateWorkbook = (raw: RawWorkbook): WorkbookResult => new WorkbookValidator(raw).run()
