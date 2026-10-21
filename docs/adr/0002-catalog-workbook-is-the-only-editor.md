# The catalog workbook is the only place recommendation rows and ingredient rules are edited

Recommendation rows and ingredient rules are edited only in the catalog workbook. There is no admin form and no direct
database edit. Every edit starts from an export of what is live, which carries the catalog version, and an upload made from
an older export is refused. This lets a dermatologist review the same spreadsheet the team edits, keeps a reviewable file
for every version, and stops a reviewer's stale copy from silently undoing the team's newer change. The cost is that even a
one-cell fix means export, edit and upload. Uploads are all-or-nothing, rows are keyed by stable codes, and a code missing
from an upload is retired, not deleted. This follows the dataset upload in obligo-be.

**Considered options:** last upload wins (simpler, but needs people to coordinate who holds the sheet), and the backend as
the source of truth with the workbook only an export for review (needs an admin UI, and reviewers' changes are copied by hand).
