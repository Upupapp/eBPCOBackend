/**
 * Which fields one person may not both propose and confirm.
 *
 * TAB 02 draws the line at "a named individual or a contact detail", and the
 * reason is specific rather than procedural: those are the facts about real
 * people that this portal publishes. Getting the Mayor's name wrong, or
 * publishing a number that reaches someone's personal phone, is a harm to a
 * named person -- and a single account able to do both halves is the whole of
 * the control.
 *
 * Everything else -- an office's about text, a permit's validity, a profile
 * figure -- is a fact about the municipality. Requiring two people for every
 * comma would make the workflow something staff route around, and a control
 * that gets routed around protects nothing.
 */

/** A field naming a real person, or a way to reach one. */
export function requiresTwoPeople(entityType: string, fieldName: string): boolean {
  // Any office contact detail: telephone, email, location, hours.
  if (fieldName.startsWith('contact.')) return true;

  // The head of an office is a named individual.
  if (entityType === 'office' && fieldName === 'head') return true;

  // An official's name is the clearest case of all.
  if (entityType === 'official' && fieldName === 'name') return true;

  return false;
}
