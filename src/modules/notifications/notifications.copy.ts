/**
 * The words of the pushes that are also inbox rows, and of a row written from two places (spec #233, PR 8b). One definition, used by the push (NotificationsService) and by the row the 15-minute job writes
 * for the same thing, so the two cannot drift apart. A leaf file: it imports nothing, so the reminders module may read it without a cycle. All of it is generic by decision (a lock screen shows it).
 */

/** The daily reminder: the entry titles, then a fixed line per time of day. */
export const routineReminderText = (time: 'morning' | 'evening', title: string): { title: string; body: string } => ({
  title,
  body: time === 'morning' ? 'Time for your morning routine' : 'Time for your evening routine',
})

/** The step-down alert: fixed title around the routine's own words, each change as its product's title and the step's fixed line. */
export const stepDownAlertText = (changes: { title: string; line: string }[]): { title: string; body: string } => ({
  title: 'A change in your routine today',
  body: changes.map(({ title, line }) => `${title}. ${line}`).join('\n'),
})

/** The check-in after a pause: the same words whatever the pause, never the step's or the product's name. */
export const pauseCheckInText = (): { title: string; body: string } => ({
  title: 'Time for your check-in',
  body: 'Tell us how your skin has been since your pause.',
})

/** The row of a day on which every half with something to do is done. Awaiting the owner's sign-off. */
export const allDoneText = (): { title: string; body: string } => ({
  title: 'Routine done',
  body: 'You did your morning and your evening routine. Well done.',
})
