/**
 * How a module that routines read from (auth, verdicts, face scans) asks for a routine build, without importing the routines service: routines imports those
 * modules, so the reverse would be a cycle. The container hands each host `(id, reason, key) => routines().request(id, reason, key)`. A leaf file on purpose: it
 * imports nothing. A host calls it in a try of its own, so a trigger that fails never changes what the host does.
 */
export type RoutineTrigger = (profileId: string, reason: 'first' | 'verdict' | 'review-point', requestKey: string) => Promise<void>
