# Deeper Tones: product context

What the product is and the decisions that bind it, so that anyone working on this backend (human or agent) builds the same
product. Source: _Deeper Tones — Response to the SkinSense PRD and Design Brief_ (v1 alignment note, 18 September 2026). The
technical decisions live in [docs/architecture.md](docs/architecture.md); this file says **what** and **why**, not how.

## In one paragraph

Deeper Tones (deepertones.com) is a calm, plain-spoken **skin coach for people with darker skin**, women and men, launching in
Nigeria. People come wanting clear, even, glowing skin. The app works out which of the products they **already use** are
helping, which are redundant, which are blocking the goal and which are harming them. It then builds a routine mostly from
what they own, with a dated **taper (step-down) schedule** so stopping a harmful product doesn't cause the crash that sent them
back last time. "SkinSense" and "Bare" are retired names.

## Five things that make it different

1. **The user's goal is the point, and the shelf is how we get there.** The user photographs their shelf and their face.
   **The face photo informs; the shelf decides.** The verdict on products comes from their ingredients. The face photo is
   what we can see today and the baseline later photos are compared against.
2. **Skin of colour is the default, not an option.** Nigeria is where we launch, and the diaspora is where the revenue is.
   The product is gender-neutral by design, and men are in scope from day one. There is no "men's version".
3. **We sell nothing, and nobody pays to be recommended, permanently.** No affiliate links, sponsorship, paid placement or
   paid ranking. A brand may pay a disclosed **review fee** to have a product assessed for the catalog against the same
   evidence bar as everything else. The fee buys the review only and never touches ranking or the verdict.
4. **We recommend from a curated catalog, not the whole world.** It is a bounded, per-country set of products we have
   evidence for. It grows through AI sourcing, manual lookup and brand submission. A product available in one country is
   not assumed available in another.
5. **The taper is the habit loop, and progress is the feedback loop.** The taper schedule carries the user through the 8 to
   12 weeks before results show, when apps in this category lose almost everyone. The daily loop lives in the phone itself
   (native reminders, alarms, widgets, lock screen), which is why this is a mobile app (iOS and Android), not a website.

## Decisions

| Topic             | Decision                                                                                                                                                                                                                                                              |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Positioning       | A skin coach that starts with what you already own.                                                                                                                                                                                                                   |
| Primary user      | Someone coming off a lightening or "glow" cream that has damaged their skin, who cannot reach a dermatologist.                                                                                                                                                        |
| The "fairer" goal | A real goal that gets a real answer: a safe routine for brighter, more even, less sun-darkened skin, plus one warm, plain statement of what it can't do (change baseline colour). It is never a refusal or a lecture. Any lightening product on the shelf is flagged. |
| Hero flow         | Goal → shelf photo → face photo → verdict → signup → plan (routine and taper schedule).                                                                                                                                                                               |
| Signup            | Happens at the verdict, never before it. The headline verdict is free; saving it, the detail, the plan and reminders need an account. One screen.                                                                                                                     |
| Identity          | A phone number (WhatsApp is the channel back to the user in Nigeria); email is optional. _Backend today:_ OTP goes by email (ZeptoMail) until Meta business verification clears; WhatsApp is the planned channel ("OTP over channels" in architecture.md).            |
| Face photo        | Taken in the first run, after the shelf and before the verdict. It is the day-0 baseline. Described only by what can be seen ("redness around the nose"), never as a condition. Skippable for privacy; skipping loses the timeline, not the verdict.                  |
| Monetisation      | A premium subscription will exist at app-store launch. Its shape is undecided and deliberately designed separately. No affiliate income, ads or brand placement, ever.                                                                                                |
| Product sourcing  | Users buy products themselves. The app informs; it does not sell. Never a "buy" button.                                                                                                                                                                               |
| Progress tracking | Tells the user whether the routine is working, adjusts it when it isn't, and tells us what worked.                                                                                                                                                                    |
| Launch            | Nigeria first, via paid TikTok and Instagram.                                                                                                                                                                                                                         |
| v1 success metric | Still active at week 8, not revenue.                                                                                                                                                                                                                                  |

## Safety: where the app stops

**If a safe routine can fix it, the app handles it. If not, or if handling it would make the app a medical device, the app
says so and tells the user what kind of professional to see and what to tell them.** Escalation is a screen the app shows,
not a service it provides.

About 21 fixed rules bind the product. The ones that shape behaviour:

- **Patterns, not diagnoses.** The app may name a pattern with honest uncertainty ("this is the rebound that happens when
  you stop a steroid cream", "the pattern usually called PIH") but never says "you have X".
- **The AI decides nothing safety-relevant.** Whether a product is _stop with a plan_, _reduce and monitor_ or _fine to
  continue_ comes from fixed rules over a reviewed knowledge base. The AI only phrases the result.
- Every claim about an ingredient or product traces to a **cited source** the user can open. Every verdict has a reason, and
  there are no unexplained scores.
- **Pregnancy and breastfeeding** are asked about early. They hard-exclude certain actives everywhere, including free
  conversation.
- **Red-flag symptoms** (signs of infection, a severe reaction, anything near the eyes, a mole that has changed) route to a
  professional. That is a normal state, not an error.
- **Step-down schedules are approved by a qualified person** before any user sees them.
- **Two speeds of change.** A harm signal (stinging, burning, new redness, a flare) pauses the offending step immediately. A
  lack of results changes nothing before the goal's review point, which for most goals is not before week 6.

## Cost

Research runs **offline**. AI agents build a shared library of goal, ingredient, product and safety knowledge in batch. At
runtime the app reads that library and makes one small AI call to phrase the answer. There is no expensive vision call per
user per scan. The target is **$0.05 per user per month**. At year-3 Nigerian scale that is about $57k to $82k a year of AI
cost, which is the floor the subscription has to clear. Every AI call's cost is tracked (see "AI cost tracking" in
architecture.md).

## Who we design for

- **Amara, 29, Lagos.** She has used a lightening cream from a market vendor for two years. Her skin is thin and red around
  the nose, and both times she tried to stop it flared, so she went back. She doesn't know the flare _is_ the withdrawal. She
  will never see a dermatologist and arrives from a TikTok ad on a slow connection. **Design for her first.**
- **Tolu, 23, Abuja.** She uses nine TikTok products at once and something stings. She can afford one new product a month,
  wants dark spots gone before graduation, and needs to be told honestly that it takes three months.
- **Ngozi, 34, London.** She reads ingredient lists and hyperpigments from every spot. She is the highest-value user and the
  loudest recommender, and the first to notice if the product doesn't understand her skin.
- **Chidi, 27, Lagos.** He gets razor bumps and dark marks along the jaw, and his aftershave stings. He would never call
  this "skincare". He proves the product needs plain language and neutral defaults, not a men's version.

There are two tests for every screen and every piece of copy: **would Amara feel judged, or sold to?** and **would Chidi
think this is for him?**

## Tone

Calm, plain and direct. Closer to a good banking app than a beauty counter. Every verdict is about the product, never the
person: no scolds, no scores or grades of the user. Darker skin is the default in every example. Ingredient terms are
explained where they appear. The tone is optimistic about the goal. Progress visuals show evenness, calm and texture, never
lightness: "lighter after" is the thing we exist to undo.

## The screens, in order of importance

1. **Goal entry**: a free-text goal and an honest answer about what it takes. No signup, no photo, no good network needed.
2. **Shelf entry**: photograph the shelf or each product. The app identifies them and the user confirms with a tap. Anything
   unreadable gets one follow-up, a photo of the back. Typing is the last resort.
   - 2a. **Face photo**: a guided front, left and right capture, skippable.
   - 2b. **Shelf verdict**: helping, redundant, blocking the goal, likely the problem, or conflicting, each with a one-line
     reason. Then a one-screen signup. This is the moment we film for TikTok.
3. **Routine and taper schedule**: steps in order, with frequency and a reason each, and a dated step-down with what to
   expect.
4. **Daily loop** (weeks 1 to 4): native reminders with tick-off actions, taper-day alarms, flare-up logging, a widget and
   the lock screen. Push permission is asked when the user sets their first reminder, not at install.
5. **Progress timeline and review point** (weeks 4 to 12): a weekly check-in, and an honest answer on whether it's working.
   - 5a. **What to look for**: the key ingredient, strength, local price range and where it's sold, from the country's
     catalog. No buy button.
6. **Share cards**: the verdict card and the progress timeline in vertical format. Product names are hidden by default.
   Progress photos are never shared without explicit, per-share consent.
7. **Escalation**: a calm, normal screen that says when to see a professional.

**Not in v1 design yet:** the paywall, premium page and subscription management. **Never:** a marketplace, purchase flow,
brand or sponsored placement, or a face scan that outputs a "skin profile" or "skin analysis".

## How this backend maps to it

| Product idea                                          | Backend today                                                                           |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Shelf entry and the follow-up back photo              | `scans`: photos in, products recognised, items that need a confirmation or a back photo |
| Curated per-country catalog                           | `catalog`: catalog data, matching, images and the catalog eval                          |
| Accounts that start as guests, sign-in at the verdict | `users` and `auth` (guest first, then OTP), `otp` (email now, WhatsApp later)           |
| Face profiles (one default per account for now)       | `profiles`                                                                              |
| Reminders and "your scan is ready"                    | push notifications through Expo (issue #54, in review)                                  |
| Every AI call costed                                  | `ai-usage`                                                                              |

If a change would cross one of the lines above (sell something, rank for money, diagnose, or let the AI make a safety
decision), stop and raise it. Those are product decisions, not implementation details.

## Language

Words with one meaning across the product, the code and the docs. When two words exist for one thing, use the first; the
others are listed under _Avoid_.

### Shelf to routine

**Shelf**:
The products a user already uses, as they photographed or named them.
_Avoid_: Stash, collection, products (alone)

**Goal**:
What the user wants for their skin, in one of the fixed goals (clear skin, even tone, fade dark marks, brighter, a glow, calm
and healthy again).
_Avoid_: Target, objective

**Verdict**:
What the app says about each shelf product against the user's goal: helping, redundant, blocking the goal, likely the
problem, or conflicting.
_Avoid_: Score, rating, analysis

**Routine**:
The ordered daily and weekly steps the user follows to reach their goal, built mostly from their shelf, with recommended
products added where the shelf has a gap.
_Avoid_: Regimen, plan (alone)

### Products

**Catalog**:
Every product the app knows, with its ingredient list and sources, however it arrived (a scan, research, a label, or the
reviewed sheet). Used to judge a shelf; never by itself a reason to suggest a product.
_Avoid_: Product database

**Recommendation catalog**:
The reviewed set of products the app may suggest adding to a routine, each described by the concerns it works on, the skin
types it suits, its safety notes and the countries it is sold in. A product reaches it only through review.
_Avoid_: Formulary, catalog (alone), shop
