# Catalog workbook contract

Version 2.1.0. Fingerprint `486bec22781b4822eb8fb379ac5e40ce7814ce3bf712fcc17f84957e94c27630`.

This document is written by `npm run catalog:contract-doc` from `src/modules/catalog/catalog.workbook.schema.ts`. Do not edit it by hand: change the
contract, and run the command again.

## How the workbook is read

The workbook has six tabs: Products, Availability, Ingredients, Countries, Claim words and Tapers. The first row of a tab is its header: one column name for each
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

Used by: `Products.steps`

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

Used by: `Products.status`, `Ingredients.status`, `Tapers.status`

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

Used by: `Ingredients.group`, `Ingredients.clashes_with`

### Taper kinds

`steroid`, `lightening-agent`

The groups that are stopped with a step-down plan and not at once. Mercury is not on the list: it is stopped at once.

Used by: `Tapers.kind`

### Schedule frequencies

`am`, `pm`, `am-pm`, `alternate-days`, `weekly`, `as-needed`, `stop`

The frequencies of a step-down schedule: the usual frequencies, and stop. A schedule goes only down the ladder, strongest first: am-pm, then am or pm (the same strength), then alternate-days, then weekly, then as-needed, then stop. It never goes back up, and it ends with stop.

Used by: `Tapers.schedule`

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
| `BAD_SCHEDULE` | The schedule is not written as steps like `1-2: alternate-days; 3-4: weekly; 5: stop`. Each step is its weeks (a week number from 1, or two with a hyphen, such as 1-2), a colon, and one frequency; steps are separated by semicolons. The frequency is one of the accepted frequencies, or stop. A schedule is at most 52 weeks long. |
| `SCHEDULE_NOT_CONTIGUOUS` | The weeks of the schedule do not run on from week 1 one step after another: it starts after week 1, or leaves a gap, or two steps share a week, or the steps are out of order. |
| `SCHEDULE_MISSING_STOP` | The schedule never says stop. A step-down ends with a step whose frequency is stop. |
| `SCHEDULE_STOP_NOT_LAST` | A step whose frequency is stop is followed by another step. Stop ends the schedule, so it is the last step. |
| `SCHEDULE_FREQUENCY_INCREASES` | A step uses the product more often than the step before it. A step-down only ever goes down: am-pm, then am or pm, then alternate-days, then weekly, then as-needed, then stop. |
| `UNQUALIFIED_APPROVER` | In production only: a Tapers row is approved by someone who is not on the list of qualified approvers the server holds. The name is never repeated. A step-down template is shown to people, so a qualified person has to approve it. It is raised by the server, not by the contract check on the file. |
