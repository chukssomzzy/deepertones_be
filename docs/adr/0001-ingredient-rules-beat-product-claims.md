# Ingredient rules decide whether a product is safe for a user, not the product's own claims

A product row in the recommendation catalog is approved by the team and audited by a dermatologist only later, so a wrong
claim on it (for example "fine in pregnancy" on a serum that contains a retinoid) could be live for weeks. We therefore
check every candidate through its full ingredient list against the reviewed ingredient rules, using the user's safety
answers. A row's own cautions can only make it stricter, never overrule a rule. The cost is that every recommended product
needs a complete ingredient list, which the catalog workbook carries.

**Considered options:** letting the row's claims decide (simplest, but a wrong cell reaches users until the audit), and
requiring both to agree, with disagreements flagged to the team (safe, but it adds a review queue nobody asked for).
