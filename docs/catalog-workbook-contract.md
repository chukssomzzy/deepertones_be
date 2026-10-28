# Catalog workbook contract

Version 2.3.0. Fingerprint `e7dac0f7b0facd74446e8ed6dc566c3501fefca23c450e65fc1e9c82868fc8b7`.

This document is written by `npm run catalog:contract-doc` from `src/modules/catalog/catalog.workbook.schema.ts`. Do not edit it by hand: change the
contract, and run the command again.

## How the workbook is read

The workbook has eleven tabs: Products, Availability, Ingredients, Countries, Claim words, Tapers, Guides, Reintroductions, Escalations, Responses and Weeks. The first row of a tab is its header: one column name for each
column below, spelled exactly as written here. Every column is needed in the header, even one whose cells may stay empty, and a column that is not
listed here is a problem. A tab with no rows is fine, but it still needs its header row.

- A list is written in one cell, its items separated by `;`. Spaces around an item are ignored, and so is an empty item.
- A date is written `YYYY-MM-DD`, as text.
- Free text is plain words: no links and no markup. Every cell is trimmed, and a cell of only spaces is empty.
- A link is an https web address of a public website.
- Every problem found is listed, never only the first. A problem names the tab, the row, the column and a problem code, and never repeats what the cell
  held. Row 1 is the header and the first row of data is row 2, as the spreadsheet numbers them. A problem on the header row is about a column as a
  whole, and where two rows clash, both rows are listed.

## Tabs

### Products

The products we recommend, one row each. Once approved, a product can be recommended to a person whose skin concerns, skin type and routine step match, in a country where it is sold.

| Column | Needed | What it holds | Format and accepted values | Problems it can raise |
| --- | --- | --- | --- | --- |
| `code` | Required | Our own short code for the product, such as PRD-CERAVE-CLEANSER. It never changes once the product is in the workbook. | Capital letters, digits and hyphens, 2 to 40 characters, starting with a letter or digit. Unique in the tab. Cannot be a draft cell. | `REQUIRED` `BAD_CODE` `DUPLICATE_CODE` |
| `brand` | Required | The brand, as printed on the pack. | Text. Up to 120 characters. No links or markup. | `REQUIRED` `TOO_LONG` `HAS_LINK_OR_MARKUP` |
| `name` | Required | The product name, as printed on the pack, without the brand. | Text. Up to 120 characters. No links or markup. | `REQUIRED` `TOO_LONG` `HAS_LINK_OR_MARKUP` |
| `variant` | Optional | The variant, shade or scent, when the name alone does not tell two products apart. | Text. Up to 120 characters. No links or markup. | `TOO_LONG` `HAS_LINK_OR_MARKUP` |
| `form` | Optional | What the product is, when the name does not say. | One of: `spray`, `roll-on`, `stick`, `cream`, `lotion`, `gel`, `oil`, `serum`, `liquid`, `bar`, `powder`, `balm`. | `NOT_IN_VOCABULARY` |
| `category` | Required | What the product is for. | One of: `skin`, `hair`, `body`, `makeup`, `other`. | `REQUIRED` `NOT_IN_VOCABULARY` |
| `ingredients` | Required, unless the row is retired | The full ingredient list in label order (INCI names), separated by ;. A retired product may leave it empty. | List, items separated by semicolons. 1 to 150 items. Each item up to 120 characters. No links or markup. | `REQUIRED` `TOO_MANY_ITEMS` `ITEM_TOO_LONG` `HAS_LINK_OR_MARKUP` |
| `ingredients_source_url` | Required when approved | The page the ingredient list was read from. Needed when the status is approved. | An https link. | `REQUIRED_WHEN_APPROVED` `NOT_HTTPS_URL` |
| `key_ingredient` | Optional | The ingredient that does the main job, in plain words: for example "Azelaic acid". Shown to users in 'what to look for'; never used by a rule. | Text. Up to 80 characters. No links or markup. | `TOO_LONG` `HAS_LINK_OR_MARKUP` |
| `strength` | Optional | Its strength as the label states it: for example "10%". Leave empty when the label does not say. | Text. Up to 40 characters. No links or markup. | `TOO_LONG` `HAS_LINK_OR_MARKUP` |
| `skin_concerns` | Required | The skin concerns the product is for: one or more, separated by ;. These are the concerns a face scan can show. | One or more of, separated by semicolons: `hd_acne`, `hd_pore`, `hd_oiliness`, `hd_age_spot`, `hd_redness`, `hd_radiance`, `hd_texture`, `hd_dark_circle`, `hd_moisture`. | `REQUIRED` `NOT_IN_VOCABULARY` |
| `skin_types` | Required | The skin types it suits: one or more, separated by ;, or "all" on its own. | One or more of, separated by semicolons: `oily`, `dry`, `combination`, `normal`, `all`. `all` only on its own, never next to another value. | `REQUIRED` `NOT_IN_VOCABULARY` `ALL_MIXED_WITH_OTHERS` |
| `steps` | Required | The routine steps it is used for: one or more, separated by ;. | One or more of, separated by semicolons: `cleanse`, `treat`, `moisturise`, `protect`. | `REQUIRED` `NOT_IN_VOCABULARY` |
| `frequency` | Required | How often it is used. One value. | One of: `am`, `pm`, `am-pm`, `alternate-days`, `weekly`, `as-needed`. | `REQUIRED` `NOT_IN_VOCABULARY` |
| `own_cautions` | Optional | Cautions that come with the product itself, separated by ;, over and above what its ingredients flag. | One or more of, separated by semicolons: `irritation`, `allergen`, `pore-clogging`, `sun-sensitivity`, `hyperpigmentation-risk`, `pregnancy-caution`, `interaction`, `restricted-substance`, `banned-substance`, `drying`. | `NOT_IN_VOCABULARY` |
| `evidence_urls` | Optional | Links to the evidence for the recommendation, separated by ;. | List of https links, separated by semicolons. | `NOT_HTTPS_URL` |
| `origin` | Required | Where the recommendation came from. A brand-submitted product has paid for a review only, never for a place. | One of: `sourced`, `brand-submitted`. | `REQUIRED` `NOT_IN_VOCABULARY` |
| `status` | Required | draft: still being worked on, and never recommended. approved: reviewed and recommendable. retired: no longer recommended; the row stays so its code is never reused. | One of: `draft`, `approved`, `retired`. Cannot be a draft cell. | `REQUIRED` `NOT_IN_VOCABULARY` |
| `approved_by` | Required when approved | Who approved this product. Needed when the status is approved. | Text. Up to 80 characters. Cannot be a draft cell. | `REQUIRED_WHEN_APPROVED` `TOO_LONG` |
| `approved_on` | Required when approved | The day it was approved. Needed when the status is approved. | A day written `YYYY-MM-DD`. Cannot be a draft cell. | `REQUIRED_WHEN_APPROVED` `BAD_DATE` |
| `audited_by` | Optional | Who checked the approval afterwards. Optional, but given together with audited_on. | Text. Up to 80 characters. Cannot be a draft cell. | `TOO_LONG` `AUDIT_INCOMPLETE` |
| `audited_on` | Optional | The day of that check. Optional, but given together with audited_by. | A day written `YYYY-MM-DD`. Cannot be a draft cell. | `BAD_DATE` `AUDIT_INCOMPLETE` |
| `draft_cells` | Optional | Cells filled in by the drafting tool and not yet reviewed, written as column=https-link and separated by ;, where the link is the page the value came from. A reviewer clears each entry once the cell is checked. Any Products column can be listed except the code, the status, the approval and audit columns and this one. Not allowed on an approved row. | List of column=https-link pairs, separated by semicolons. Cannot be a draft cell. | `INVALID_DRAFT_CELL` `DRAFT_CELL_COLUMN` `NOT_HTTPS_URL` |

Checks across cells and rows:

- `DUPLICATE_IDENTITY`: No two rows are the same product: brand, name, variant and form, compared without case, accents, punctuation or pack sizes. A retired row counts.
- `APPROVED_WITH_DRAFT_CELLS`: An approved row has no draft cells.
- `AUDIT_INCOMPLETE`: audited_by and audited_on are given together, or not at all.
- `ALL_MIXED_WITH_OTHERS`: skin_types is "all" alone, or a list of types without "all".
- `STRENGTH_WITHOUT_INGREDIENT`: A product with a strength has a key_ingredient.

### Availability

Where each product is sold and what it costs there, one row for each product and country. A product with no row for a country is never recommended in it.

| Column | Needed | What it holds | Format and accepted values | Problems it can raise |
| --- | --- | --- | --- | --- |
| `product_code` | Required | The code of a product in the Products tab. | A `code` from the Products tab, written exactly. | `REQUIRED` `UNKNOWN_PRODUCT` |
| `country` | Required | The code of a country in the Countries tab. | A `code` from the Countries tab, written exactly. | `REQUIRED` `UNKNOWN_COUNTRY` |
| `price_min` | Required | The lowest price in the country, in whole units of its currency. | A whole number, zero or more. | `REQUIRED` `NOT_A_WHOLE_NUMBER` |
| `price_max` | Required | The highest price in the country, in whole units of its currency. | A whole number, zero or more. | `REQUIRED` `NOT_A_WHOLE_NUMBER` |
| `where_sold` | Optional | Where to find it, in plain words: for example "Pharmacies and online". | Text. Up to 200 characters. No links or markup. | `TOO_LONG` `HAS_LINK_OR_MARKUP` |
| `source_url` | Optional | Where the price and shop were found. | An https link. | `NOT_HTTPS_URL` |

Checks across cells and rows:

- `PRICE_RANGE`: price_min is not above price_max.
- `DUPLICATE_AVAILABILITY`: Each product and country pair appears once.

### Ingredients

The ingredient rules: a fact about an ingredient that every analysis of a product containing it must explain. Only approved rules are used; a draft applies to nothing.

| Column | Needed | What it holds | Format and accepted values | Problems it can raise |
| --- | --- | --- | --- | --- |
| `code` | Required | Our own short code for the rule, such as ING-RETINOL-SUN-SENSITIVITY. It never changes once the rule is in the workbook. | Capital letters, digits and hyphens, 2 to 40 characters, starting with a letter or digit. Unique in the tab. | `REQUIRED` `BAD_CODE` `DUPLICATE_CODE` |
| `name` | Required | The ingredient, by its INCI name, in lower case with single spaces and no trailing full stop or asterisk. | An ingredient name, normalised. Up to 120 characters. | `REQUIRED` `TOO_LONG` `NOT_NORMALISED` |
| `aliases` | Optional | Other names the ingredient goes by on labels, separated by ;, written the same way as the name. | List of ingredient names, separated by semicolons, each normalised. Each item up to 120 characters. | `ITEM_TOO_LONG` `NOT_NORMALISED` |
| `kind` | Required | What kind of caution this is. An ingredient with two cautions has two rules. | One of: `irritation`, `allergen`, `pore-clogging`, `sun-sensitivity`, `hyperpigmentation-risk`, `pregnancy-caution`, `interaction`, `restricted-substance`, `banned-substance`, `drying`. | `REQUIRED` `NOT_IN_VOCABULARY` |
| `strength_limit` | Optional | The strength above which the caution applies, in plain words: for example "2% in leave-on products". | Text. Up to 80 characters. No links or markup. | `TOO_LONG` `HAS_LINK_OR_MARKUP` |
| `statement` | Required | What is said about the ingredient, in plain words a person can read. No links and no markup. | Text. Up to 600 characters. No links or markup. | `REQUIRED` `TOO_LONG` `HAS_LINK_OR_MARKUP` |
| `source_url` | Optional | A link to the regulation or listing behind the statement. Leave it empty for a commonly cited caution that no regulation lists. | An https link. | `NOT_HTTPS_URL` |
| `helps` | Optional | The skin concerns the ingredient helps with, separated by ;. Optional. | One or more of, separated by semicolons: `hd_acne`, `hd_pore`, `hd_oiliness`, `hd_age_spot`, `hd_redness`, `hd_radiance`, `hd_texture`, `hd_dark_circle`, `hd_moisture`. | `NOT_IN_VOCABULARY` |
| `group` | Optional | What kind of ingredient this is, where it matters for a shelf: for example retinoid or steroid. Empty for most rules. It does not change how the rule is matched. | One of: `mercury`, `steroid`, `lightening-agent`, `retinoid`, `exfoliating-acid`, `benzoyl-peroxide`. | `NOT_IN_VOCABULARY` |
| `clashes_with` | Optional | The groups that should not be used together with this rule's group, separated by ;. The relation goes both ways: if retinoid lists exfoliating-acid, a rule of the exfoliating-acid group lists retinoid. Needs a group on the rule. | One or more of, separated by semicolons: `mercury`, `steroid`, `lightening-agent`, `retinoid`, `exfoliating-acid`, `benzoyl-peroxide`. | `NOT_IN_VOCABULARY` |
| `status` | Required | draft: still being worked on, and applies to nothing. approved: in force. retired: no longer in force; the row stays so its code is never reused. | One of: `draft`, `approved`, `retired`. | `REQUIRED` `NOT_IN_VOCABULARY` |
| `approved_by` | Required when approved | Who approved this rule. Needed when the status is approved. | Text. Up to 80 characters. | `REQUIRED_WHEN_APPROVED` `TOO_LONG` |
| `approved_on` | Required when approved | The day it was approved. Needed when the status is approved. | A day written `YYYY-MM-DD`. | `REQUIRED_WHEN_APPROVED` `BAD_DATE` |
| `audited_by` | Optional | Who checked the approval afterwards. Optional, but given together with audited_on. | Text. Up to 80 characters. | `TOO_LONG` `AUDIT_INCOMPLETE` |
| `audited_on` | Optional | The day of that check. Optional, but given together with audited_by. | A day written `YYYY-MM-DD`. | `BAD_DATE` `AUDIT_INCOMPLETE` |

Checks across cells and rows:

- `DUPLICATE_RULE`: One rule for each ingredient name or alias and kind among the rules that are not retired; a draft counts.
- `AUDIT_INCOMPLETE`: audited_by and audited_on are given together, or not at all.
- `CLASH_WITHOUT_GROUP`: A rule that lists clashes_with has a group.
- `SELF_CLASH`: A rule does not list its own group in clashes_with.
- `CLASH_NOT_SYMMETRIC`: If a rule's group lists another group, a rule of that group lists the first back. Retired rules are not counted; a draft is.

### Countries

The countries the catalog serves, and where each one's price bands end. A price in the low band is at most low_max; in the mid band, at most mid_max; the high band has no upper limit. A country is retired, never deleted.

| Column | Needed | What it holds | Format and accepted values | Problems it can raise |
| --- | --- | --- | --- | --- |
| `code` | Required | The ISO 3166 two-letter country code, in capitals, such as NG. | Two capital letters. Unique in the tab. | `REQUIRED` `BAD_CODE` `DUPLICATE_CODE` |
| `currency` | Required | The ISO 4217 three-letter currency code, in capitals, such as NGN. | Three capital letters. | `REQUIRED` `BAD_CURRENCY` |
| `low_max` | Required | The top of the low band, in whole units of the currency. | A whole number, zero or more. | `REQUIRED` `NOT_A_WHOLE_NUMBER` |
| `mid_max` | Required | The top of the mid band, in whole units of the currency. Above low_max. | A whole number, zero or more. | `REQUIRED` `NOT_A_WHOLE_NUMBER` |
| `status` | Required | active: recommendations are made here. retired: no longer served; the row stays. | One of: `active`, `retired`. | `REQUIRED` `NOT_IN_VOCABULARY` |

Checks across cells and rows:

- `LOW_NOT_BELOW_MID`: low_max is below mid_max.

### Claim words

Phrases that say a product is sold for lightening or bleaching. A product whose brand, name or variant holds an approved phrase is flagged by the shelf verdict. "Brightening" and "glow" are never claim words. A claim word is retired, never deleted.

| Column | Needed | What it holds | Format and accepted values | Problems it can raise |
| --- | --- | --- | --- | --- |
| `code` | Required | Our own short code for the claim word, such as CLM-WHITENING. It never changes once the word is in the workbook. | Capital letters, digits and hyphens, 2 to 40 characters, starting with a letter or digit. Unique in the tab. | `REQUIRED` `BAD_CODE` `DUPLICATE_CODE` |
| `phrase` | Required | The words, in lower case, as they appear in a product name: for example "whitening". | Text. Up to 60 characters. No links or markup. Lower case only. | `REQUIRED` `TOO_LONG` `HAS_LINK_OR_MARKUP` `NOT_LOWER_CASE` |
| `claim` | Required | What the phrase claims. Only lightening, for now. | One of: `lightening`. | `REQUIRED` `NOT_IN_VOCABULARY` |
| `status` | Required | approved: in force. retired: no longer in force; the row stays so its code is never reused. A claim word has no draft: leave a word you are unsure of out of the workbook. | One of: `approved`, `retired`. | `REQUIRED` `NOT_IN_VOCABULARY` |
| `approved_by` | Required when approved | Who approved this claim word. Needed when the status is approved. | Text. Up to 80 characters. | `REQUIRED_WHEN_APPROVED` `TOO_LONG` |
| `approved_on` | Required when approved | The day it was approved. Needed when the status is approved. | A day written `YYYY-MM-DD`. | `REQUIRED_WHEN_APPROVED` `BAD_DATE` |
| `audited_by` | Optional | Who checked the approval afterwards. Optional, but given together with audited_on. | Text. Up to 80 characters. | `TOO_LONG` `AUDIT_INCOMPLETE` |
| `audited_on` | Optional | The day of that check. Optional, but given together with audited_by. | A day written `YYYY-MM-DD`. | `BAD_DATE` `AUDIT_INCOMPLETE` |

Checks across cells and rows:

- `DUPLICATE_PHRASE`: One claim word for each phrase among the words that are not retired.
- `NOT_A_LIGHTENING_CLAIM`: No phrase, retired or not, holds "brightening" or "glow" as a whole word (any case).
- `AUDIT_INCOMPLETE`: audited_by and audited_on are given together, or not at all.

### Tapers

Step-down templates: how a person stops a steroid or a lightening product without the flare of stopping at once. A template is shown to people, so a qualified person approves it; in production the server refuses an approved template whose approver is not on its list. A template is retired, never deleted, so a past routine can still say which plan it used.

| Column | Needed | What it holds | Format and accepted values | Problems it can raise |
| --- | --- | --- | --- | --- |
| `code` | Required | Our own short code for the template, such as TPR-STEROID-1. It never changes once the template is in the workbook. | Capital letters, digits and hyphens, 2 to 40 characters, starting with a letter or digit. Unique in the tab. | `REQUIRED` `BAD_CODE` `DUPLICATE_CODE` |
| `kind` | Required | The kind of product the template is for. | One of: `steroid`, `lightening-agent`. | `REQUIRED` `NOT_IN_VOCABULARY` |
| `schedule` | Required | The steps, separated by ;. Each step is its weeks, a colon and a frequency: a single week (3) or a run of weeks (1-2), then the frequency. Weeks run on from week 1 with no gap, up to week 52. The frequency never goes up, and the last step is stop. For example: 1-2: alternate-days; 3-4: weekly; 5: stop | Steps separated by semicolons, each `<weeks>: <frequency>`, the frequency one of: `am`, `pm`, `am-pm`, `alternate-days`, `weekly`, `as-needed`, `stop`. Up to 300 characters. | `REQUIRED` `TOO_LONG` `BAD_SCHEDULE` `SCHEDULE_NOT_CONTIGUOUS` `SCHEDULE_MISSING_STOP` `SCHEDULE_STOP_NOT_LAST` `SCHEDULE_FREQUENCY_INCREASES` |
| `what_to_expect` | Required | What a person should expect while stepping down, in plain words: for example that a flare after a step is expected and passes. | Text. Up to 400 characters. No links or markup. | `REQUIRED` `TOO_LONG` `HAS_LINK_OR_MARKUP` |
| `see_a_professional_if` | Required | When to stop and see a professional, in plain words. | Text. Up to 400 characters. No links or markup. | `REQUIRED` `TOO_LONG` `HAS_LINK_OR_MARKUP` |
| `status` | Required | draft: still being worked on, and never shown. approved: reviewed by a qualified person and shown. retired: no longer used; the row stays so its code is never reused. | One of: `draft`, `approved`, `retired`. | `REQUIRED` `NOT_IN_VOCABULARY` |
| `approved_by` | Required when approved | Who approved this template. Needed when the status is approved. | Text. Up to 80 characters. | `REQUIRED_WHEN_APPROVED` `TOO_LONG` |
| `approved_on` | Required when approved | The day it was approved. Needed when the status is approved. | A day written `YYYY-MM-DD`. | `REQUIRED_WHEN_APPROVED` `BAD_DATE` |
| `audited_by` | Optional | Who checked the approval afterwards. Optional, but given together with audited_on. | Text. Up to 80 characters. | `TOO_LONG` `AUDIT_INCOMPLETE` |
| `audited_on` | Optional | The day of that check. Optional, but given together with audited_by. | A day written `YYYY-MM-DD`. | `BAD_DATE` `AUDIT_INCOMPLETE` |

Checks across cells and rows:

- `AUDIT_INCOMPLETE`: audited_by and audited_on are given together, or not at all.

### Guides

What each routine step is for, what to look for on the label and what suits deeper skin: the guide a person reads before buying a product they do not own. A guide is written here and never by a model, and a qualified person approves it; in production the server refuses an approved guide whose approver is not on its list. A row is one step, and a goal when it is for one: a row with a goal is shown, whole, to people with that goal in place of the step's row with no goal, so each of the four steps needs one approved row with no goal. A row is identified by its step and goal, and is retired, never deleted. The pregnancy rule for reviewers: a row with no look_for_when_pregnant is shown to people who are pregnant or breastfeeding as it is, so its look_for must name only things that are safe in pregnancy; write look_for_when_pregnant when it cannot be.

| Column | Needed | What it holds | Format and accepted values | Problems it can raise |
| --- | --- | --- | --- | --- |
| `step` | Required | The routine step the guide is for. | One of: `cleanse`, `treat`, `moisturise`, `protect`. | `REQUIRED` `NOT_IN_VOCABULARY` |
| `goal` | Optional | The goal the guide is for. Leave it empty for the step's base guide, which people with any other goal are shown. | One of: `clear-skin`, `even-tone`, `fade-dark-marks`, `brighter`, `glow`, `calm-repair`. | `NOT_IN_VOCABULARY` |
| `what_it_does` | Required | What this kind of product does for the person, in plain words. | Text. Up to 300 characters. No links or markup. No condition names, diagnoses, or promises of lighter, fairer or whiter skin. | `REQUIRED` `TOO_LONG` `HAS_LINK_OR_MARKUP` `GUIDE_WORDING` |
| `look_for` | Required | What to check on the label, in plain words. Without look_for_when_pregnant, this is shown to people who are pregnant or breastfeeding too, so name only what is safe for them. | Text. Up to 300 characters. No links or markup. No condition names, diagnoses, or promises of lighter, fairer or whiter skin. | `REQUIRED` `TOO_LONG` `HAS_LINK_OR_MARKUP` `GUIDE_WORDING` |
| `for_deeper_skin` | Required | What works on deeper skin: for example a finish that leaves no grey or white film. | Text. Up to 300 characters. No links or markup. No condition names, diagnoses, or promises of lighter, fairer or whiter skin. | `REQUIRED` `TOO_LONG` `HAS_LINK_OR_MARKUP` `GUIDE_WORDING` |
| `look_for_when_pregnant` | Optional | What to check on the label for a person who is pregnant or breastfeeding, shown instead of look_for. Leave it empty only when look_for is already safe in pregnancy. | Text. Up to 300 characters. No links or markup. No condition names, diagnoses, or promises of lighter, fairer or whiter skin. | `TOO_LONG` `HAS_LINK_OR_MARKUP` `GUIDE_WORDING` |
| `status` | Required | draft: still being worked on, and never shown. approved: reviewed by a qualified person and shown. retired: no longer used; the row stays so its step and goal are never reused. | One of: `draft`, `approved`, `retired`. | `REQUIRED` `NOT_IN_VOCABULARY` |
| `approved_by` | Required when approved | Who approved this guide. Needed when the status is approved. | Text. Up to 80 characters. | `REQUIRED_WHEN_APPROVED` `TOO_LONG` |
| `approved_on` | Required when approved | The day it was approved. Needed when the status is approved. | A day written `YYYY-MM-DD`. | `REQUIRED_WHEN_APPROVED` `BAD_DATE` |
| `audited_by` | Optional | Who checked the approval afterwards. Optional, but given together with audited_on. | Text. Up to 80 characters. | `TOO_LONG` `AUDIT_INCOMPLETE` |
| `audited_on` | Optional | The day of that check. Optional, but given together with audited_by. | A day written `YYYY-MM-DD`. | `BAD_DATE` `AUDIT_INCOMPLETE` |

Checks across cells and rows:

- `GUIDE_BASE_MISSING`: Each routine step has one approved row with no goal. A draft or retired row does not count.
- `GUIDE_DUPLICATE`: Each step and goal pair appears once, a step with no goal counting as a pair. A draft or retired row counts.
- `GUIDE_WORDING`: No text holds a word the routine never uses (a condition, a diagnosis, lighter, fairer or whiter skin, a score). Every row is checked, drafts too.
- `AUDIT_INCOMPLETE`: audited_by and audited_on are given together, or not at all.

### Reintroductions

How a person brings a paused product back slowly: a ladder that climbs from rare use to the routine's own frequency and ends with back. The ladder of a group is used for that group, and the ladder with no group for every group without one of its own. Mercury, steroid and lightening-agent have no ladder: they are only ever stopped, never brought back. A ladder is shown to people, so a qualified person approves it; in production the server refuses an approved ladder whose approver is not on its list. A row is identified by its group, and is retired, never deleted.

| Column | Needed | What it holds | Format and accepted values | Problems it can raise |
| --- | --- | --- | --- | --- |
| `group` | Optional | The ingredient group the ladder is for. Leave it empty for the default ladder, which every group without a ladder of its own is brought back on. | One of: `mercury`, `steroid`, `lightening-agent`, `retinoid`, `exfoliating-acid`, `benzoyl-peroxide`. | `NOT_IN_VOCABULARY` |
| `schedule` | Required | The steps, separated by ;. Each step is its weeks, a colon and a frequency: a single week (3) or a run of weeks (1-2), then the frequency. Weeks run on from week 1 with no gap, up to week 12. The frequency never goes down, and the last step is back, the routine's own frequency from there on. For example: 1: weekly; 2: alternate-days; 3: back | Steps separated by semicolons, each `<weeks>: <frequency>`, the frequency one of: `am`, `pm`, `am-pm`, `alternate-days`, `weekly`, `as-needed`, `back`. Up to 300 characters. | `REQUIRED` `TOO_LONG` `BAD_SCHEDULE` `SCHEDULE_NOT_CONTIGUOUS` `REINTRO_MISSING_BACK` `REINTRO_BACK_NOT_LAST` `REINTRO_FREQUENCY_DECREASES` |
| `status` | Required | draft: still being worked on, and never shown. approved: reviewed by a qualified person and shown. retired: no longer used; the row stays so its group is never reused. | One of: `draft`, `approved`, `retired`. | `REQUIRED` `NOT_IN_VOCABULARY` |
| `approved_by` | Required when approved | Who approved this ladder. Needed when the status is approved. | Text. Up to 80 characters. | `REQUIRED_WHEN_APPROVED` `TOO_LONG` |
| `approved_on` | Required when approved | The day it was approved. Needed when the status is approved. | A day written `YYYY-MM-DD`. | `REQUIRED_WHEN_APPROVED` `BAD_DATE` |
| `audited_by` | Optional | Who checked the approval afterwards. Optional, but given together with audited_on. | Text. Up to 80 characters. | `TOO_LONG` `AUDIT_INCOMPLETE` |
| `audited_on` | Optional | The day of that check. Optional, but given together with audited_by. | A day written `YYYY-MM-DD`. | `BAD_DATE` `AUDIT_INCOMPLETE` |

Checks across cells and rows:

- `REINTRO_DEFAULT_MISSING`: One approved row has no group. A draft or retired row does not count.
- `REINTRO_DUPLICATE`: Each group appears once, no group counting as a group. A draft or retired row counts.
- `REINTRO_GROUP_NEVER_BACK`: No row is for mercury, steroid or lightening-agent, whatever its status.
- `AUDIT_INCOMPLETE`: audited_by and audited_on are given together, or not at all.

### Escalations

What the app tells a person when it sends them to a professional: who to see, how soon, and what to tell them. Each reason needs exactly one approved row. The texts are plain words and are never a diagnosis. A qualified person approves them; in production the server refuses an approved row whose approver is not on its list. A row is identified by its reason, and is retired, never deleted.

| Column | Needed | What it holds | Format and accepted values | Problems it can raise |
| --- | --- | --- | --- | --- |
| `reason` | Required | Why the app sends the person to a professional. | One of: `pus-or-hot-patch`, `swelling`, `near-eyes`, `worse-after-pause`, `unchanged-after-checks`, `harm-while-two-paused`, `hard-to-ignore-during-step-down`. | `REQUIRED` `NOT_IN_VOCABULARY` |
| `who_to_see` | Required | The kind of professional to see, in plain words: for example "A doctor or a pharmacist." | Text. Up to 300 characters. No links or markup. No condition names, diagnoses, or promises of lighter, fairer or whiter skin. | `REQUIRED` `TOO_LONG` `HAS_LINK_OR_MARKUP` `ESCALATION_WORDING` |
| `how_soon` | Required | How soon to be seen, in plain words: for example "Today, or within a day." | Text. Up to 300 characters. No links or markup. No condition names, diagnoses, or promises of lighter, fairer or whiter skin. | `REQUIRED` `TOO_LONG` `HAS_LINK_OR_MARKUP` `ESCALATION_WORDING` |
| `what_to_tell_them` | Required | What the person should tell the professional, in plain words. | Text. Up to 300 characters. No links or markup. No condition names, diagnoses, or promises of lighter, fairer or whiter skin. | `REQUIRED` `TOO_LONG` `HAS_LINK_OR_MARKUP` `ESCALATION_WORDING` |
| `status` | Required | draft: still being worked on, and never shown. approved: reviewed by a qualified person and shown. retired: no longer used; the row stays so its reason is never reused. | One of: `draft`, `approved`, `retired`. | `REQUIRED` `NOT_IN_VOCABULARY` |
| `approved_by` | Required when approved | Who approved this escalation. Needed when the status is approved. | Text. Up to 80 characters. | `REQUIRED_WHEN_APPROVED` `TOO_LONG` |
| `approved_on` | Required when approved | The day it was approved. Needed when the status is approved. | A day written `YYYY-MM-DD`. | `REQUIRED_WHEN_APPROVED` `BAD_DATE` |
| `audited_by` | Optional | Who checked the approval afterwards. Optional, but given together with audited_on. | Text. Up to 80 characters. | `TOO_LONG` `AUDIT_INCOMPLETE` |
| `audited_on` | Optional | The day of that check. Optional, but given together with audited_by. | A day written `YYYY-MM-DD`. | `BAD_DATE` `AUDIT_INCOMPLETE` |

Checks across cells and rows:

- `ESCALATION_MISSING`: Each reason has one approved row. A draft or retired row does not count.
- `ESCALATION_DUPLICATE`: Each reason appears once. A draft or retired row counts.
- `ESCALATION_WORDING`: No text holds a word the routine never uses (a condition, a diagnosis, lighter, fairer or whiter skin, a score). Every row is checked, drafts too.
- `AUDIT_INCOMPLETE`: audited_by and audited_on are given together, or not at all.

### Responses

The text that answers a skin log or a check-in after a pause. Each outcome needs exactly one approved row. {step} is the one placeholder a text may hold: it is replaced with the plain name of the routine step the answer is about, and any other word in braces is refused. A qualified person approves a response; in production the server refuses an approved row whose approver is not on its list. A row is identified by its outcome, and is retired, never deleted.

| Column | Needed | What it holds | Format and accepted values | Problems it can raise |
| --- | --- | --- | --- | --- |
| `outcome` | Required | What the log or check-in came to. | One of: `paused`, `advice-tightness`, `advice-itching`, `advice-breakouts`, `expected-flare`, `check-calmer`, `check-same`, `check-worse`, `nothing-to-pause`. | `REQUIRED` `NOT_IN_VOCABULARY` |
| `title` | Required | The heading of the answer, in plain words. May hold {step}. | Text. Up to 120 characters. No links or markup. `{step}` is the only placeholder allowed. No condition names, diagnoses, or promises of lighter, fairer or whiter skin. | `REQUIRED` `TOO_LONG` `HAS_LINK_OR_MARKUP` `RESPONSE_PLACEHOLDER` `RESPONSE_WORDING` |
| `body` | Required | The answer, in plain words. May hold {step}. | Text. Up to 300 characters. No links or markup. `{step}` is the only placeholder allowed. No condition names, diagnoses, or promises of lighter, fairer or whiter skin. | `REQUIRED` `TOO_LONG` `HAS_LINK_OR_MARKUP` `RESPONSE_PLACEHOLDER` `RESPONSE_WORDING` |
| `what_to_do_now` | Optional | What to do now, in plain words. May hold {step}. Leave it empty when the answer needs no action. | Text. Up to 300 characters. No links or markup. `{step}` is the only placeholder allowed. No condition names, diagnoses, or promises of lighter, fairer or whiter skin. | `TOO_LONG` `HAS_LINK_OR_MARKUP` `RESPONSE_PLACEHOLDER` `RESPONSE_WORDING` |
| `status` | Required | draft: still being worked on, and never shown. approved: reviewed by a qualified person and shown. retired: no longer used; the row stays so its outcome is never reused. | One of: `draft`, `approved`, `retired`. | `REQUIRED` `NOT_IN_VOCABULARY` |
| `approved_by` | Required when approved | Who approved this response. Needed when the status is approved. | Text. Up to 80 characters. | `REQUIRED_WHEN_APPROVED` `TOO_LONG` |
| `approved_on` | Required when approved | The day it was approved. Needed when the status is approved. | A day written `YYYY-MM-DD`. | `REQUIRED_WHEN_APPROVED` `BAD_DATE` |
| `audited_by` | Optional | Who checked the approval afterwards. Optional, but given together with audited_on. | Text. Up to 80 characters. | `TOO_LONG` `AUDIT_INCOMPLETE` |
| `audited_on` | Optional | The day of that check. Optional, but given together with audited_by. | A day written `YYYY-MM-DD`. | `BAD_DATE` `AUDIT_INCOMPLETE` |

Checks across cells and rows:

- `RESPONSE_MISSING`: Each outcome has one approved row. A draft or retired row does not count.
- `RESPONSE_DUPLICATE`: Each outcome appears once. A draft or retired row counts.
- `RESPONSE_PLACEHOLDER`: No text holds a placeholder in braces other than {step}.
- `RESPONSE_WORDING`: No text, with {step} replaced by a plain noun, holds a word the routine never uses (a condition, a diagnosis, lighter, fairer or whiter skin, a score). Every row is checked, drafts too.
- `AUDIT_INCOMPLETE`: audited_by and audited_on are given together, or not at all.

### Weeks

The week card on the Today screen: a short heading and a few plain words for the stretch of weeks a person is in. A row is one band, and optionally a goal and a step-down: the card shown is the first that exists of the band's card for the goal on a step-down, the band's step-down card, the band's card for the goal, and the band's base card, so each band needs one approved base card (no goal, step_down no). The server prints "Week 1" and the like itself, so the title is a short heading. A qualified person approves a card; in production the server refuses an approved row whose approver is not on its list. A row is identified by its band, goal and step_down, and is retired, never deleted.

| Column | Needed | What it holds | Format and accepted values | Problems it can raise |
| --- | --- | --- | --- | --- |
| `band` | Required | The weeks the card is for. A person in week 13 or later is shown the 9-12 card. | One of: `1`, `2`, `3-4`, `5-8`, `9-12`. | `REQUIRED` `NOT_IN_VOCABULARY` |
| `goal` | Optional | The goal the card is for. Leave it empty for the band's base card, which people with any other goal are shown. | One of: `clear-skin`, `even-tone`, `fade-dark-marks`, `brighter`, `glow`, `calm-repair`. | `NOT_IN_VOCABULARY` |
| `step_down` | Optional | yes for a card shown to a person who is stepping down a product, no for any other. Empty means no. | One of: `yes`, `no`. | `NOT_IN_VOCABULARY` |
| `title` | Required | A short heading, in plain words. Do not write "Week 1": the server adds that. | Text. Up to 60 characters. No links or markup. No condition names, diagnoses, or promises of lighter, fairer or whiter skin. | `REQUIRED` `TOO_LONG` `HAS_LINK_OR_MARKUP` `WEEK_WORDING` |
| `text` | Required | What the week is about, in plain words. | Text. Up to 300 characters. No links or markup. No condition names, diagnoses, or promises of lighter, fairer or whiter skin. | `REQUIRED` `TOO_LONG` `HAS_LINK_OR_MARKUP` `WEEK_WORDING` |
| `status` | Required | draft: still being worked on, and never shown. approved: reviewed by a qualified person and shown. retired: no longer used; the row stays so its band, goal and step-down are never reused. | One of: `draft`, `approved`, `retired`. | `REQUIRED` `NOT_IN_VOCABULARY` |
| `approved_by` | Required when approved | Who approved this week card. Needed when the status is approved. | Text. Up to 80 characters. | `REQUIRED_WHEN_APPROVED` `TOO_LONG` |
| `approved_on` | Required when approved | The day it was approved. Needed when the status is approved. | A day written `YYYY-MM-DD`. | `REQUIRED_WHEN_APPROVED` `BAD_DATE` |
| `audited_by` | Optional | Who checked the approval afterwards. Optional, but given together with audited_on. | Text. Up to 80 characters. | `TOO_LONG` `AUDIT_INCOMPLETE` |
| `audited_on` | Optional | The day of that check. Optional, but given together with audited_by. | A day written `YYYY-MM-DD`. | `BAD_DATE` `AUDIT_INCOMPLETE` |

Checks across cells and rows:

- `WEEK_BASE_MISSING`: Each band has one approved row with no goal and step_down no (or empty). A draft or retired row does not count.
- `WEEK_DUPLICATE`: Each band, goal and step_down appears once, no goal counting as a goal and an empty step_down as no. A draft or retired row counts.
- `WEEK_WORDING`: No text holds a word the routine never uses (a condition, a diagnosis, lighter, fairer or whiter skin, a score). Every row is checked, drafts too.
- `AUDIT_INCOMPLETE`: audited_by and audited_on are given together, or not at all.

## Accepted values

A value is accepted only when written exactly as here, in lower case.

### Skin concerns

- `hd_acne`: spots and breakouts
- `hd_pore`: visible pores
- `hd_oiliness`: oily shine
- `hd_age_spot`: dark spots and marks
- `hd_redness`: redness
- `hd_radiance`: dullness / lack of glow
- `hd_texture`: uneven texture
- `hd_dark_circle`: dark circles under the eyes
- `hd_moisture`: dryness / low moisture

Used by: `Products.skin_concerns`, `Ingredients.helps`

### Skin types

`oily`, `dry`, `combination`, `normal`, `all`

Used by: `Products.skin_types`

### Steps

`cleanse`, `treat`, `moisturise`, `protect`

Used by: `Products.steps`, `Guides.step`

### Frequencies

`am`, `pm`, `am-pm`, `alternate-days`, `weekly`, `as-needed`

Used by: `Products.frequency`

### Budget bands

`low`, `mid`, `high`

Not a column of any tab. A budget band is a rough answer about how much a person can spend on one new product, and where each band ends is set per country by low_max and mid_max in the Countries tab. It is used when shopping facts are matched to products.

### Origins

`sourced`, `brand-submitted`

Used by: `Products.origin`

### Categories

`skin`, `hair`, `body`, `makeup`, `other`

Used by: `Products.category`

### Forms

`spray`, `roll-on`, `stick`, `cream`, `lotion`, `gel`, `oil`, `serum`, `liquid`, `bar`, `powder`, `balm`

Used by: `Products.form`

### Caution kinds

- `irritation`: can sting or redden skin
- `allergen`: a known trigger of allergic reactions
- `pore-clogging`: tends to block pores and cause breakouts
- `sun-sensitivity`: makes skin burn more easily in the sun
- `hyperpigmentation-risk`: can leave dark marks on skin
- `pregnancy-caution`: advised against while pregnant or breastfeeding
- `interaction`: does not mix well with another ingredient
- `restricted-substance`: allowed only up to a limit, or for some uses only
- `banned-substance`: banned in cosmetics
- `drying`: can dry the skin out

Used by: `Products.own_cautions`, `Ingredients.kind`

### Product statuses

`draft`, `approved`, `retired`

Used by: `Products.status`, `Ingredients.status`, `Tapers.status`, `Guides.status`, `Reintroductions.status`, `Escalations.status`, `Responses.status`, `Weeks.status`

### Country statuses

`active`, `retired`

Used by: `Countries.status`

### Claim word statuses

`approved`, `retired`

Used by: `Claim words.status`

### Claims

`lightening`

What a claim word says about a product. For now there is one: a product whose brand, name or variant holds the phrase is sold for lightening.

Used by: `Claim words.claim`

### Ingredient groups

`mercury`, `steroid`, `lightening-agent`, `retinoid`, `exfoliating-acid`, `benzoyl-peroxide`

What an ingredient is, for the rules that look across a shelf, as opposed to what it does. Most ingredient rules have no group. Mercury is stopped at once; steroid and lightening-agent are stopped with a step-down plan.

Used by: `Ingredients.group`, `Ingredients.clashes_with`, `Reintroductions.group`

### Taper kinds

`steroid`, `lightening-agent`

The groups that are stopped with a step-down plan and not at once. Mercury is not on the list: it is stopped at once.

Used by: `Tapers.kind`

### Goals

`clear-skin`, `even-tone`, `fade-dark-marks`, `brighter`, `glow`, `calm-repair`

The goals a person can pick. A guide row with a goal is shown to people with that goal instead of the step's guide with no goal; the list is the goals the app offers, so it moves when they do.

Used by: `Guides.goal`, `Weeks.goal`

### Schedule frequencies

`am`, `pm`, `am-pm`, `alternate-days`, `weekly`, `as-needed`, `stop`

The frequencies of a step-down schedule: the usual frequencies, and stop. A schedule goes only down the ladder, strongest first: am-pm, then am or pm (the same strength), then alternate-days, then weekly, then as-needed, then stop. It never goes back up, and it ends with stop.

Used by: `Tapers.schedule`

### Ladder frequencies

`am`, `pm`, `am-pm`, `alternate-days`, `weekly`, `as-needed`, `back`

The frequencies of a reintroduction ladder: the usual frequencies, and back. A ladder only climbs, weakest first: as-needed, then weekly, then alternate-days, then am or pm (the same strength), then am-pm. Its last step is back, which means the routine's own frequency from there on. It never says stop.

Used by: `Reintroductions.schedule`

### Escalation reasons

`pus-or-hot-patch`, `swelling`, `near-eyes`, `worse-after-pause`, `unchanged-after-checks`, `harm-while-two-paused`, `hard-to-ignore-during-step-down`

The reasons the app sends a person to a professional. Each has exactly one approved row in the Escalations tab.

Used by: `Escalations.reason`

### Response outcomes

`paused`, `advice-tightness`, `advice-itching`, `advice-breakouts`, `expected-flare`, `check-calmer`, `check-same`, `check-worse`, `nothing-to-pause`

What a skin log or a check-in after a pause comes to. Each has exactly one approved row in the Responses tab.

Used by: `Responses.outcome`

### Week bands

`1`, `2`, `3-4`, `5-8`, `9-12`

The stretches of weeks a week card is written for. A person in week 13 or later is shown the 9-12 card. Each band needs one approved base card.

Used by: `Weeks.band`

### Yes no

`yes`, `no`

Whether a week card is for a person who is stepping down a product. Empty means no.

Used by: `Weeks.step_down`

## Problem codes

| Code | What it means |
| --- | --- |
| `UNKNOWN_COLUMN` | The tab has a column the contract does not know. Remove it, or correct its spelling. |
| `MISSING_COLUMN` | A column the contract needs is not in the tab's header row. Add it; its cells may stay empty where the column is optional. |
| `REQUIRED` | The cell must be filled in. |
| `REQUIRED_WHEN_APPROVED` | The cell must be filled in once the status is approved. Fill it in, or leave the row as a draft. |
| `NOT_IN_VOCABULARY` | A value is not one of the accepted values listed for this column. Spelling and case must match exactly. |
| `BAD_CODE` | The code is not in the required format. Product and rule codes are capital letters, digits and hyphens, 2 to 40 characters, starting with a letter or digit. A country code is two capital letters. |
| `BAD_CURRENCY` | The currency is not a three-letter ISO 4217 code in capitals, such as NGN. |
| `BAD_DATE` | The date is not a real calendar day written as YYYY-MM-DD, such as 2026-10-21. |
| `NOT_HTTPS_URL` | A link is not an https web address. A link must start with https:// and name a public website (no port, no IP address). |
| `NOT_A_WHOLE_NUMBER` | The value is not a whole number of zero or more. No decimals, no thousands separators, no minus sign. |
| `TOO_LONG` | The text is longer than this column allows. A cell that is too long is reported for its length only, and nothing else is checked about it until it is cut down. |
| `ITEM_TOO_LONG` | One item of the list is longer than this column allows. An item that is too long is reported for its length only. |
| `TOO_MANY_ITEMS` | The list has more items than this column allows. |
| `HAS_LINK_OR_MARKUP` | The text holds a link (https://, www.) or markup (a tag such as `<b>`). Free text is plain words; put links in the columns made for them. |
| `NOT_NORMALISED` | The name is not written the way ingredients are compared: single spaces, and no trailing full stop, asterisk or dagger. Capitals are fine, since names are lower-cased for you. Write "alcohol denat", not "alcohol denat.". |
| `ALL_MIXED_WITH_OTHERS` | "all" means every skin type, so it cannot be listed next to another one. Use "all" alone, or list the types. |
| `AUDIT_INCOMPLETE` | An audit needs both who did it and when. Fill in both audited columns, or leave both empty. |
| `APPROVED_WITH_DRAFT_CELLS` | An approved row cannot have draft cells: a cell that is still a draft has not been reviewed. Review the cells and clear draft_cells, or set the status back to draft. |
| `INVALID_DRAFT_CELL` | A draft cell is not written as column=https-link. Both a column and a link are needed. |
| `DRAFT_CELL_COLUMN` | A draft cell names a column that cannot be marked as a draft: it is not a Products column, or it is one that identifies or signs off the row, or it is draft_cells itself. |
| `PRICE_RANGE` | The lowest price is above the highest price. |
| `LOW_NOT_BELOW_MID` | The top of the low band must be lower than the top of the mid band. |
| `UNKNOWN_PRODUCT` | The product code is not in the Products tab. It must match a code there exactly. |
| `UNKNOWN_COUNTRY` | The country is not in the Countries tab. It must match a code there exactly. |
| `DUPLICATE_CODE` | Two rows of the tab have the same code. Every row is reported, so both sides of the clash can be seen. |
| `DUPLICATE_IDENTITY` | Two products are the same product: their brand, name, variant and form read the same once case, accents, punctuation and pack sizes are ignored. Keep one row, or tell them apart with the variant or form. |
| `DUPLICATE_AVAILABILITY` | A product has two rows for the same country. Keep one row with the price range for that country. |
| `DUPLICATE_RULE` | Two ingredient rules of the same kind name the same ingredient, by name or by alias, in lower case. Draft rules count; retired rules do not. Keep one rule for each ingredient and kind. |
| `CLASH_NOT_SYMMETRIC` | A rule says its group clashes with another group, but no rule of that group says the same back (or the other group has no rule at all). Both sides are reported. Retired rules neither ask for an answer nor give one; draft rules count. |
| `CLASH_WITHOUT_GROUP` | A rule lists groups in clashes_with but has no group of its own. The clash is between groups, so give the rule its group, or clear clashes_with. |
| `SELF_CLASH` | A rule lists its own group in clashes_with. A group does not clash with itself. |
| `STRENGTH_WITHOUT_INGREDIENT` | A product has a strength but no key ingredient. A strength on its own means nothing, so name the key ingredient it belongs to, or clear the strength. |
| `DUPLICATE_PHRASE` | Two claim words that are not retired have the same phrase. Every such row is reported. A retired word may share the phrase of a live one. |
| `NOT_A_LIGHTENING_CLAIM` | The phrase holds "brightening" or "glow" as a whole word. Brightening and glow are goals people have, not claims to lighten skin, so a product named with them is never flagged for lightening. Leave the phrase out. |
| `NOT_LOWER_CASE` | The phrase has a capital letter. Claim phrases are written in lower case, since a product name is compared with them in lower case. |
| `BAD_SCHEDULE` | The schedule is not written as steps like `1-2: alternate-days; 3-4: weekly; 5: stop`. Each step is its weeks (a week number from 1, or two with a hyphen, such as 1-2), a colon, and one frequency; steps are separated by semicolons. The frequency is one of the accepted frequencies, or stop in a Tapers schedule and back in a Reintroductions ladder (never stop in a ladder). A Tapers schedule is at most 52 weeks long, and a ladder at most 12. |
| `SCHEDULE_NOT_CONTIGUOUS` | The weeks of the schedule do not run on from week 1 one step after another: it starts after week 1, or leaves a gap, or two steps share a week, or the steps are out of order. |
| `SCHEDULE_MISSING_STOP` | The schedule never says stop. A step-down ends with a step whose frequency is stop. |
| `SCHEDULE_STOP_NOT_LAST` | A step whose frequency is stop is followed by another step. Stop ends the schedule, so it is the last step. |
| `SCHEDULE_FREQUENCY_INCREASES` | A step uses the product more often than the step before it. A step-down only ever goes down: am-pm, then am or pm, then alternate-days, then weekly, then as-needed, then stop. |
| `UNQUALIFIED_APPROVER` | In production only: a Tapers, Guides, Reintroductions, Escalations, Responses or Weeks row is approved by someone who is not on the list of qualified approvers the server holds. The name is never repeated. What these tabs hold is shown to people, so a qualified person has to approve it. It is raised by the server, not by the contract check on the file. |
| `GUIDE_BASE_MISSING` | A routine step has no approved guide without a goal. Each of the four steps (cleanse, treat, moisturise, protect) needs one approved row with the goal column empty: it is what a person sees when no row is written for their goal. A draft or retired row does not count. It is reported once, on the header row of the Guides tab. |
| `GUIDE_DUPLICATE` | Two rows of the Guides tab are for the same step and goal (or the same step with no goal). Every such row is reported, whatever its status, since a retired row keeps its place. Keep one row for each. |
| `GUIDE_WORDING` | A guide text holds words a routine never uses: the name of a condition, a diagnosis ("you have ..."), a promise of lighter, fairer or whiter skin, or a score. The same words are refused in every part of the routine. Say what the product does for the skin in plain words, without them. |
| `REINTRO_DEFAULT_MISSING` | The Reintroductions tab has no approved ladder without a group. It needs one approved row with the group column empty: it is the ladder every group without a ladder of its own is brought back on. A draft or retired row does not count. It is reported once, on the header row. |
| `REINTRO_DUPLICATE` | Two rows of the Reintroductions tab are for the same group (or both have no group). Every such row is reported, whatever its status, since a retired row keeps its place. Keep one row for each. |
| `REINTRO_GROUP_NEVER_BACK` | A ladder is written for mercury, steroid or lightening-agent. Those are only ever stopped and never brought back, so they have no ladder. It is reported whatever the status of the row. |
| `REINTRO_MISSING_BACK` | The ladder never ends with back. A ladder climbs to back, which means the routine's own frequency from there on, and back is its last step. |
| `REINTRO_BACK_NOT_LAST` | A step whose frequency is back is followed by another step. Back ends the ladder, so it is the last step. |
| `REINTRO_FREQUENCY_DECREASES` | A step uses the product less often than the step before it. A ladder only ever goes up: as-needed, then weekly, then alternate-days, then am or pm (the same strength), then am-pm, then back. The same frequency twice is fine. |
| `ESCALATION_MISSING` | A reason has no approved escalation. Each of the reasons (pus-or-hot-patch, swelling, near-eyes, worse-after-pause, unchanged-after-checks, harm-while-two-paused, hard-to-ignore-during-step-down) needs exactly one approved row. A draft or retired row does not count. It is reported once, on the header row. |
| `ESCALATION_DUPLICATE` | Two rows of the Escalations tab are for the same reason. Every such row is reported, whatever its status, since a retired row keeps its place. Keep one row for each. |
| `ESCALATION_WORDING` | An escalation text holds words a routine never uses: the name of a condition, a diagnosis ("you have ..."), a promise of lighter, fairer or whiter skin, or a score. Say what to do in plain words, without them. |
| `RESPONSE_MISSING` | An outcome has no approved response. Each of the outcomes (paused, advice-tightness, advice-itching, advice-breakouts, expected-flare, check-calmer, check-same, check-worse, nothing-to-pause) needs exactly one approved row. A draft or retired row does not count. It is reported once, on the header row. |
| `RESPONSE_DUPLICATE` | Two rows of the Responses tab are for the same outcome. Every such row is reported, whatever its status, since a retired row keeps its place. Keep one row for each. |
| `RESPONSE_PLACEHOLDER` | A response text holds a placeholder in braces other than {step}. {step} is the only one there is: it is replaced with the plain name of the routine step. Write anything else as plain words. |
| `RESPONSE_WORDING` | A response text holds words a routine never uses: the name of a condition, a diagnosis ("you have ..."), a promise of lighter, fairer or whiter skin, or a score. It is checked with {step} replaced by a plain noun. Say it in plain words, without them. |
| `WEEK_BASE_MISSING` | A band has no approved base week card. Each of the bands (1, 2, 3-4, 5-8, 9-12) needs one approved row with the goal column empty and step_down no (or empty): it is the card a person sees when no row is written for their goal. A draft or retired row does not count. It is reported once, on the header row. |
| `WEEK_DUPLICATE` | Two rows of the Weeks tab are for the same band, goal and step_down (an empty goal, and an empty step_down meaning no, count as values). Every such row is reported, whatever its status. Keep one row for each. |
| `WEEK_WORDING` | A week card text holds words a routine never uses: the name of a condition, a diagnosis ("you have ..."), a promise of lighter, fairer or whiter skin, or a score. Say it in plain words, without them. |
