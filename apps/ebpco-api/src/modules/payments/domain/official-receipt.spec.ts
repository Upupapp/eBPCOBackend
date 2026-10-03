import { officialReceiptProblem } from './official-receipt';

/** QA findings TC-03 and TC-08 (2026-10-03): "abc" was accepted as an Official Receipt number. */
describe('officialReceiptProblem', () => {
  it.each(['OR-2026-000123', '1234567', 'AF51 0012345', '2026/00451', 'or-2026-900777'])('accepts %s', (number) => {
    expect(officialReceiptProblem(number)).toBeNull();
  });

  it('asks for the number itself when it is empty, never for a reason', () => {
    expect(officialReceiptProblem('  ')).toMatch(/^Enter the Official Receipt number/);
  });

  it.each([
    ['abc', /at least 4 digits/],
    ['12', /at least 4 digits/],
    ['OR-' + '1'.repeat(40), /at most 40 characters/],
    ['OR#2026', /only letters, numbers/],
    ['OR-12', /at least 4 digits/],
  ])('refuses %s', (number, why) => {
    expect(officialReceiptProblem(number)).toMatch(why);
  });
});
